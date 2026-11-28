import { randomUUID } from 'node:crypto'
import { createMp3Encoder, encodePcm as sharedEncodePcm, mp3RateSupported } from './mp3.mjs'
import { createZipStream, ZIP_LIMIT } from './zip.mjs'
import { encodeWav, wavHeader } from './wav.mjs'
import { planComplete } from './plan.mjs'
import { decodeStoredAudio, logicalFrames, logicalPcmBytes } from './stored-audio.mjs'
import { buildId3v2TitleTag, buildSubtitleCues, formatLrc, formatScriptMarkdown, formatSrt } from '../domain/subtitles.mjs'

const EXPORT_TTL = 60_000
const EXPORT_LIMIT = 0xffffffff
const CHAPTER_GAP_SECONDS = 1.5
const PCM_SLICE_SECONDS = 5
const unsafeName = /[\\/:*?"<>|\u0000-\u001f]/gu
const exportIdPattern = /^[A-Za-z0-9_-]{8,64}$/u

function sanitizeName(value, fallback) {
  const text = String(value ?? '').replace(unsafeName, ' ').replace(/\s+/gu, ' ').trim().toWellFormed()
  return text.slice(0, 120).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() || fallback
}

function attachment(name) {
  const ascii = name.replace(/[^\x20-\x7e]/gu, '_').replace(/["\\]/gu, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function exportIdOf(value) {
  return exportIdPattern.test(value ?? '') ? value : randomUUID()
}

function downloadStream(iterator, signal, settle, countBytes) {
  let finished = false
  let output
  function finish(state, error) {
    if (finished) return false
    finished = true
    signal.removeEventListener('abort', abort)
    settle(state, error)
    return true
  }
  async function stopInput() {
    try { await iterator.return?.() } catch { /* the response has already stopped */ }
  }
  function abort() {
    if (!finish('cancelled')) return
    output.error(signal.reason)
    void stopInput()
  }
  return new ReadableStream({
    start(controller) {
      output = controller
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    },
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (finished) return
        if (done) { finish('done'); controller.close(); return }
        countBytes?.(value.byteLength)
        controller.enqueue(value)
      } catch (error) {
        if (finish('error', error)) {
          controller.error(error)
          await stopInput()
        }
      }
    },
    cancel() {
      if (finish('cancelled')) void stopInput()
    },
  })
}

export async function mediaProjection(library, job, detail = true, keys = null) {
  const parts = job.progress.parts ?? []
  const audio = keys instanceof Map ? keys : new Map((await library.audioKeys(job.chapter)).map(part => [part.key, part]))
  return parts.map(({ id, text, start, end, roleId, emotion, intensity, instruct, line, key, primary }, n) => {
    const item = audio.get(key)
    // para marks the first part of a new paragraph so the player can pause a
    // little longer there. Jobs written before parts carried a line say false.
    const para = n > 0 && line !== undefined && parts[n - 1].line !== undefined && parts[n - 1].line !== line
    // filled: this LaiVox part was finished with an Edge voice at the user's request.
    return { id, n, ...(detail ? { text } : {}), start, end, roleId, emotion, intensity: intensity ?? 0, instruct: instruct ?? null, para, ready: !!item,
      seconds: item ? logicalFrames(item) / item.rate : 0, ...(primary ? { filled: true } : {}) }
  })
}

// The plugin passes its own encoder so a disabled-then-enabled plugin never reuses
// one it already disposed; tests fall back to the module's shared encoder.
function usable(job, keys) {
  return job?.spec?.purpose === 'generate' && planComplete(job.progress) &&
    job.progress.parts.every(part => keys.has(part.key))
}

async function playableJob(library, row, keys) {
  const operation = await library.chapterOperation(row.id, row.rev)
  if (usable(operation, keys)) return operation
  const jobs = await library.chapterJobs(row.id, row.rev)
  const found = jobs.find(job => usable(job, keys))
  if (found) return found
  const historical = await library.historicalAudioJob(row.id)
  return historical && historical.rev === row.rev && usable(historical, keys) ? historical : null
}

export async function planBookExport(library, book, format, signal, { chapterSet = null, from = null, to = null, requireSameFormat = false } = {}) {
  const allChapters = []
  for (let offset = 0; ; offset += 80) {
    signal?.throwIfAborted?.()
    const rows = await library.chapters(book, offset)
    allChapters.push(...rows)
    if (rows.length < 80) break
    if (allChapters.length >= 20_000) throw new Error('IMPORT_TOO_MANY_CHAPTERS')
  }
  const chapters = allChapters.filter(row => {
    if (chapterSet && !chapterSet.has(row.id)) return false
    if (from !== null && row.ordinal < from) return false
    if (to !== null && row.ordinal > to) return false
    return true
  })
  const ready = []
  const skipped = []
  if (!chapters.length) return { chapters, ready, skipped, title: '小说配音（LaiVox）', totalSeconds: 0 }
  const title = (await library.chapter(chapters[0].id)).bookTitle
  let baseFormat = null
  for (const row of chapters) {
    signal?.throwIfAborted?.()
    if (!row.hasAudio) { skipped.push({ row, reason: '尚未生成音频' }); continue }
    const keys = new Map((await library.audioKeys(row.id)).map(item => [item.key, item]))
    const job = await playableJob(library, row, keys)
    if (!job) { skipped.push({ row, reason: '台词或音色已修改，请先更新音频' }); continue }
    const parts = job.progress.parts
    const first = keys.get(parts[0].key)
    if (parts.some(part => { const item = keys.get(part.key); return item.rate !== first.rate || item.channels !== first.channels })) {
      skipped.push({ row, reason: '音频格式不一致' })
      continue
    }
    if (format === 'mp3' && !mp3RateSupported(first.rate)) {
      skipped.push({ row, reason: `采样率 ${first.rate} 不支持 MP3` })
      continue
    }
    if (requireSameFormat) {
      if (!baseFormat) baseFormat = { rate: first.rate, channels: first.channels }
      else if (first.rate !== baseFormat.rate || first.channels !== baseFormat.channels) {
        skipped.push({ row, reason: '音频格式与首章不一致' })
        continue
      }
    }
    // Keep only what the archive needs up front; parts and keys are read again
    // chapter by chapter while streaming, so a long book is not held in memory.
    const frames = parts.reduce((total, part) => total + logicalFrames(keys.get(part.key)), 0)
    const bytes = parts.reduce((total, part) => total + logicalPcmBytes(keys.get(part.key)), 0)
    ready.push({ row, job: job.id, rate: first.rate, channels: first.channels, bytes, frames, seconds: frames / first.rate })
  }
  const audioSeconds = ready.reduce((sum, entry) => sum + entry.seconds, 0)
  const gapSeconds = requireSameFormat && ready.length > 1 ? (ready.length - 1) * CHAPTER_GAP_SECONDS : 0
  return { chapters, ready, skipped, title, totalSeconds: audioSeconds + gapSeconds }
}

export function registerMediaRoutes(route, library, encodePcm = sharedEncodePcm, makeEncoder = encodePcm === sharedEncodePcm ? createMp3Encoder : null) {
  const active = new Set()
  const exports = new Map()
  function occupy(scope, errorCode = 'AUDIO_IN_USE') {
    for (const other of active) {
      if (other.book !== scope.book || (!other.clear && !scope.clear)) continue
      if (!other.chapter || !scope.chapter || other.chapter === scope.chapter) throw new Error(errorCode)
    }
    active.add(scope)
    return () => active.delete(scope)
  }
  const notFound = () => new Response(null, { status: 404 })
  const headers = { 'Content-Type': 'audio/wav' }

  async function* pcmRows(chapter, rows, signal, onRowDone) {
    for (const row of rows) {
      signal?.throwIfAborted()
      const audio = await library.audio(chapter, row.key)
      if (!audio) throw new Error('AUDIO_MISSING')
      const pcm = await decodeStoredAudio(audio, signal)
      const sliceBytes = Math.max(2, (audio.rate || 24000) * (audio.channels || 1) * 2 * PCM_SLICE_SECONDS)
      if (pcm.byteLength <= sliceBytes) {
        yield pcm
      } else {
        for (let offset = 0; offset < pcm.byteLength; offset += sliceBytes) {
          signal?.throwIfAborted()
          yield pcm.subarray(offset, Math.min(pcm.byteLength, offset + sliceBytes))
        }
      }
      onRowDone?.()
    }
  }

  function parseSelectionFilter(params) {
    const rawChapters = (params.get('chapters') ?? '').split(',').map(id => id.trim()).filter(Boolean)
    const chapterSet = rawChapters.length ? new Set(rawChapters) : null
    const fromRaw = params.get('from')
    const toRaw = params.get('to')
    const from = fromRaw && /^\d+$/u.test(fromRaw) ? Math.max(1, Number(fromRaw)) : null
    const to = toRaw && /^\d+$/u.test(toRaw) ? Math.max(1, Number(toRaw)) : null
    if (from !== null && to !== null && from > to) throw new Error('INVALID_INPUT')
    return { chapterSet, from, to }
  }

  function planBook(book, format, signal, options) {
    return planBookExport(library, book, format, signal, options)
  }

  // Upper bound of the archive size, checked before any byte is sent so an
  // oversized book fails with a message instead of a broken download.
  function estimateZip(plan, format, { mode = 'zip', subtitles = 'none' } = {}) {
    let total = 22 + 4096
    for (const entry of plan.ready) {
      const name = Buffer.byteLength(entry.row.title, 'utf8') + 16
      const seconds = entry.seconds
      const body = format === 'wav' ? entry.bytes + 44 : Math.ceil(seconds * (entry.channels === 2 ? 96 : 64) * 1000 / 8 * 1.1) + 4096
      const subMargin = subtitles && subtitles !== 'none' ? 4096 : 0
      total += 30 + name + body + subMargin + 16 + 46 + name
    }
    if (mode === 'single' && plan.ready.length > 1) {
      const gapSeconds = (plan.ready.length - 1) * CHAPTER_GAP_SECONDS
      const first = plan.ready[0]
      total += format === 'wav'
        ? Math.round(gapSeconds * first.rate) * first.channels * 2
        : Math.ceil(gapSeconds * (first.channels === 2 ? 96 : 64) * 1000 / 8 * 1.1)
    }
    return total
  }

  async function rolesMapFor(book) {
    const map = new Map()
    const list = await library.roles?.(book)
    for (const role of Array.isArray(list) ? list : []) map.set(role.id, role)
    return map
  }

  async function subtitleChapterData(entry) {
    const job = await library.job(entry.job)
    const keys = new Map((await library.audioKeys(entry.row.id)).map(item => [item.key, item]))
    const parts = (job?.progress?.parts ?? []).map(part => {
      const item = keys.get(part.key)
      return { text: part.text, roleId: part.roleId, seconds: item ? logicalFrames(item) / item.rate : 0 }
    })
    return { title: entry.row.title, parts }
  }

  async function buildSubtitlesPayload(plan, { book, subtitles, includeSpeaker, chapterGapSeconds, signal }) {
    if (!subtitles || subtitles === 'none') return null
    const roles = await rolesMapFor(book)
    const chapters = []
    for (const entry of plan.ready) {
      signal?.throwIfAborted?.()
      chapters.push(await subtitleChapterData(entry))
    }
    const formats = subtitles === 'both' ? ['srt', 'lrc'] : [subtitles]
    const buildFiles = (subset, prefix) => formats.map(kind => {
      const { cues } = buildSubtitleCues(subset, { roles, includeSpeaker, chapterGapSeconds })
      const text = kind === 'lrc' ? formatLrc(cues, { title: subset.length === 1 ? subset[0].title : plan.title, author: 'LaiVox' }) : formatSrt(cues)
      return { name: `${prefix}.${kind}`, content: Buffer.from(text, 'utf8') }
    })
    return { roles, chapters, formats, buildFiles }
  }

  async function chapterRows(entry) {
    const job = await library.job(entry.job)
    const keys = new Map((await library.audioKeys(entry.row.id)).map(item => [item.key, item]))
    const rows = (job?.progress?.parts ?? []).map(part => keys.get(part.key))
    if (!rows.length || rows.some(row => !row)) throw new Error('AUDIO_MISSING')
    return rows
  }

  function readmeFor(plan, format) {
    const lines = [
      `书名：${plan.title}`,
      `导出时间：${new Date().toISOString()}`,
      `格式：${format === 'mp3' ? 'MP3' : 'WAV'}`,
      `章节：共 ${plan.chapters.length} 章，已导出 ${plan.ready.length} 章`,
      '',
    ]
    if (plan.skipped.length) {
      lines.push('未完成章节：')
      for (const item of plan.skipped) lines.push(`  第 ${item.row.ordinal} 章 ${item.row.title} —— ${item.reason}`)
    } else lines.push('全部章节已导出。')
    return lines.join('\n') + '\n'
  }

  async function* wavContent(entry) {
    if (entry.bytes > EXPORT_LIMIT - 36) throw new Error('WAV_FORMAT_MISMATCH')
    const rows = await chapterRows(entry)
    yield wavHeader(entry.bytes, entry.rate, entry.channels)
    yield* pcmRows(entry.row.id, rows)
  }

  async function* mp3Content(entry, encode = encodePcm) {
    const rows = await chapterRows(entry)
    yield* encode(entry.rate, entry.channels, pcmRows(entry.row.id, rows))
  }

  async function* progressContent(inner, state) {
    for await (const chunk of inner) yield chunk
    state.done += 1
  }

  function entriesFor(plan, format, state, subtitlePack = null, encode = encodePcm) {
    const entries = []
    for (let index = 0; index < plan.ready.length; index++) {
      const entry = plan.ready[index]
      const stem = `${String(entry.row.ordinal).padStart(3, '0')}-${sanitizeName(entry.row.title, '章节')}`
      const content = format === 'wav' ? wavContent(entry) : mp3Content(entry, encode)
      entries.push({ name: `${stem}.${format}`, content: progressContent(content, state) })
      if (subtitlePack) entries.push(...subtitlePack.buildFiles([subtitlePack.chapters[index]], stem))
    }
    entries.push({ name: 'README.txt', content: Buffer.from(readmeFor(plan, format)) })
    return entries
  }

  async function* mergedPcmStream(plan, signal, state) {
    const first = plan.ready[0]
    const gapBytes = Math.round(first.rate * CHAPTER_GAP_SECONDS) * first.channels * 2
    const sliceBytes = Math.max(2, first.rate * first.channels * 2 * PCM_SLICE_SECONDS)
    for (let index = 0; index < plan.ready.length; index++) {
      signal.throwIfAborted()
      if (index > 0 && gapBytes > 0) {
        for (let offset = 0; offset < gapBytes; offset += sliceBytes) {
          signal.throwIfAborted()
          yield Buffer.alloc(Math.min(sliceBytes, gapBytes - offset))
        }
      }
      const entry = plan.ready[index]
      const rows = await chapterRows(entry)
      yield* pcmRows(entry.row.id, rows, signal)
      if (state) state.done += 1
    }
  }

  async function* singleBookAudio(plan, format, signal, state, encode = null) {
    const first = plan.ready[0]
    if (format === 'wav') {
      const gapBytes = plan.ready.length > 1 ? Math.round(first.rate * CHAPTER_GAP_SECONDS) * first.channels * 2 * (plan.ready.length - 1) : 0
      const totalBytes = plan.ready.reduce((sum, entry) => sum + entry.bytes, 0) + gapBytes
      if (totalBytes > EXPORT_LIMIT - 36) throw new Error('WAV_FORMAT_MISMATCH')
      yield wavHeader(totalBytes, first.rate, first.channels)
      yield* mergedPcmStream(plan, signal, state)
      return
    }
    const id3 = buildId3v2TitleTag(plan.title, 'LaiVox')
    if (id3.length) yield id3
    if (typeof encode === 'function') {
      yield* encode(first.rate, first.channels, mergedPcmStream(plan, signal, state))
      return
    }
    const isolated = typeof makeEncoder === 'function' ? makeEncoder() : null
    const encoder = isolated?.encodePcm ?? encodePcm
    try {
      yield* encoder(first.rate, first.channels, mergedPcmStream(plan, signal, state))
    } finally {
      await isolated?.dispose?.().catch(() => {})
    }
  }

  route('media/clip', 'GET', async (_request, params) => {
    const chapter = params.get('chapter')
    const key = params.get('key')
    if (!chapter || !key) return notFound()
    const row = await library.audio(chapter, key)
    if (!row) return notFound()
    if (row.codec === 'wav') return new Response(row.pcm, { headers })
    return new Response(encodeWav(await decodeStoredAudio(row, _request.signal), row.rate, row.channels), { headers })
  })

  route('media/segment', 'GET', async (_request, params) => {
    const job = await library.job(params.get('job'))
    const part = job?.progress.parts?.[Number(params.get('n'))]
    if (!part) return notFound()
    const row = await library.audio(job.chapter, part.key)
    if (!row) return notFound()
    if (row.codec === 'wav') return new Response(row.pcm, { headers })
    return new Response(encodeWav(await decodeStoredAudio(row, _request.signal), row.rate, row.channels), { headers })
  })

  // Word timing of one part for read-along highlighting. marks are relative to
  // the part text; start is the part's offset in the chapter text.
  route('media/marks', 'GET', async (_request, params) => {
    const job = await library.job(params.get('job'))
    const part = job?.progress.parts?.[Number(params.get('n'))]
    if (!part) return notFound()
    const marks = await library.marks(job.chapter, part.key)
    return new Response(JSON.stringify({ start: part.start, marks: marks ?? [] }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  })

  route('media/chapter', 'GET', async (request, params) => {
    const format = params.get('format') === 'mp3' ? 'mp3' : 'wav'
    const job = await library.job(params.get('job'))
    const parts = job?.progress.parts
    if (!parts?.length) return notFound()
    // A plan that is still growing would export a chapter cut off at the last
    // sentence written so far.
    if (job.spec?.purpose !== 'generate' || !planComplete(job.progress)) throw new Error('AUDIO_INCOMPLETE')
    const { book } = await library.chapterHeader(job.chapter)
    const release = occupy({ book, chapter: job.chapter })
    // With an export id the page can follow the preparation (parts read so far)
    // through media/book/progress, as for a whole book. The response may only
    // reach the page once it is complete, so its bytes are no progress signal.
    const id = params.has('export') ? exportIdOf(params.get('export')) : null
    const state = id ? { state: 'running', done: 0, total: parts.length, bytes: 0, error: null } : null
    if (id) exports.set(id, state)
    function settle(next, error) {
      release()
      if (!state) return
      state.state = next
      if (error) state.error = error.message ?? String(error)
      const timer = setTimeout(() => exports.delete(id), EXPORT_TTL)
      timer.unref?.()
    }
    const onRowDone = state ? () => { state.done += 1 } : undefined
    const countBytes = state ? bytes => { state.bytes += bytes } : undefined
    try {
      const refs = new Map((await library.audioKeys(job.chapter)).map(row => [row.key, row]))
      request.signal.throwIfAborted()
      const ordered = parts.map(part => refs.get(part.key))
      if (ordered.some(part => !part)) { settle('error', new Error('AUDIO_MISSING')); return notFound() }
      const { rate, channels } = ordered[0]
      if (ordered.some(row => row.rate !== rate || row.channels !== channels)) throw new Error('WAV_FORMAT_MISMATCH')
      if (format === 'mp3') {
        if (!mp3RateSupported(rate)) throw new Error('MP3_UNSUPPORTED_FORMAT')
        const chapter = await library.chapter(job.chapter)
        const name = `${String(chapter.ordinal).padStart(3, '0')}-${sanitizeName(chapter.title, '章节')}.mp3`
        const disposition = attachment(name)
        const iterator = encodePcm(rate, channels, pcmRows(job.chapter, ordered, request.signal, onRowDone))[Symbol.asyncIterator]()
        const stream = downloadStream(iterator, request.signal, settle, countBytes)
        return new Response(stream, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Disposition': disposition } })
      }
      const bytes = ordered.reduce((total, row) => total + logicalPcmBytes(row), 0)
      if (bytes > EXPORT_LIMIT - 36) throw new Error('WAV_FORMAT_MISMATCH')
      async function* chapterWav() {
        yield wavHeader(bytes, rate, channels)
        yield* pcmRows(job.chapter, ordered, request.signal, onRowDone)
      }
      const stream = downloadStream(chapterWav(), request.signal, settle, countBytes)
      return new Response(stream, { headers: { ...headers, 'Content-Length': String(bytes + 44), 'Content-Disposition': 'attachment; filename="novel.wav"' } })
    } catch (error) {
      settle(request.signal.aborted ? 'cancelled' : 'error', request.signal.aborted ? undefined : error)
      throw error
    }
  })

  route('media/chapter/subtitles', 'GET', async (request, params) => {
    const format = params.get('format') === 'lrc' ? 'lrc' : params.get('format') === 'md' ? 'md' : 'srt'
    const includeSpeaker = params.get('speakers') !== '0'
    const job = await library.job(params.get('job'))
    const parts = job?.progress?.parts
    if (!parts?.length) return notFound()
    if (job.spec?.purpose !== 'generate' || !planComplete(job.progress)) throw new Error('AUDIO_INCOMPLETE')
    const chapter = await library.chapter(job.chapter)
    if (!chapter) return notFound()
    const keys = new Map((await library.audioKeys(job.chapter)).map(item => [item.key, item]))
    if (parts.some(part => !keys.has(part.key))) throw new Error('AUDIO_MISSING')
    const roles = await rolesMapFor(chapter.book)
    const entryParts = parts.map(part => {
      const item = keys.get(part.key)
      return { text: part.text, roleId: part.roleId, seconds: item ? logicalFrames(item) / item.rate : 0 }
    })
    const subset = [{ title: chapter.title, parts: entryParts }]
    const { cues } = buildSubtitleCues(subset, { roles, includeSpeaker, chapterGapSeconds: 0 })
    const content = format === 'lrc' ? formatLrc(cues, { title: chapter.title, author: chapter.bookTitle })
      : format === 'md' ? formatScriptMarkdown(subset, { bookTitle: chapter.bookTitle, roles })
      : formatSrt(cues)
    const name = `${String(chapter.ordinal).padStart(3, '0')}-${sanitizeName(chapter.title, '章节')}.${format}`
    const mime = format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8'
    return new Response(content, { headers: { 'Content-Type': mime, 'Content-Disposition': attachment(name) } })
  })

  route('media/export-plan', 'GET', async (request, params) => {
    const book = params.get('book')
    if (typeof book !== 'string' || !book) throw new Error('INVALID_INPUT')
    const format = params.get('format') === 'wav' ? 'wav' : 'mp3'
    const mode = params.get('mode') === 'single' ? 'single' : 'zip'
    const filter = parseSelectionFilter(params)
    const plan = await planBook(book, format, request.signal, { ...filter, requireSameFormat: mode === 'single' })
    const estimatedBytes = estimateZip(plan, format)
    const estimatedBuildSeconds = plan.ready.length
      ? Math.max(1, Math.round(plan.totalSeconds * (format === 'mp3' ? 0.04 : 0.01)))
      : 0
    return {
      title: plan.title,
      mode,
      format,
      totalChapters: plan.chapters.length,
      readyCount: plan.ready.length,
      skippedCount: plan.skipped.length,
      skipped: plan.skipped.slice(0, 50).map(item => ({ ordinal: item.row.ordinal, title: item.row.title, reason: item.reason })),
      totalSeconds: Math.round(plan.totalSeconds),
      estimatedBytes,
      estimatedBuildSeconds,
    }
  })

  // Progress of a book export or a chapter download, by its export id.
  const exportCancels = new Map()
  route('media/book/cancel', 'POST', (_request, _params, body) => {
    const id = typeof body?.export === 'string' ? body.export : ''
    exportCancels.get(id)?.abort()
    return { cancelled: true }
  })

  route('media/book/progress', 'GET', (_request, params) => {
    const state = exports.get(params.get('id'))
    if (!state) return Response.json({ error: 'EXPORT_NOT_FOUND' }, { status: 404 })
    return { ...state }
  })

  route('media/book', 'GET', async (request, params) => {
    const book = params.get('book')
    if (typeof book !== 'string' || !book) throw new Error('INVALID_INPUT')
    const format = params.get('format') === 'wav' ? 'wav' : 'mp3'
    const mode = params.get('mode') === 'single' ? 'single' : 'zip'
    const subtitlesRaw = params.get('subtitles')
    const subtitles = ['lrc', 'srt', 'both'].includes(subtitlesRaw) ? subtitlesRaw : 'none'
    const includeSpeaker = params.get('speakers') !== '0'
    const filter = parseSelectionFilter(params)
    const id = exportIdOf(params.get('export'))
    const state = { state: 'running', done: 0, total: 0, bytes: 0, error: null }
    // Occupy first: a refused export must not leave a progress entry that stays
    // `running` forever.
    const isolated = format === 'mp3' && typeof makeEncoder === 'function' ? makeEncoder() : null
    const bookEncode = isolated?.encodePcm ?? encodePcm
    let disposed = false
    function disposeIsolated() {
      if (disposed || !isolated) return
      disposed = true
      void isolated.dispose?.().catch(() => {})
    }
    const release = occupy({ book })
    const cancel = new AbortController()
    exportCancels.set(id, cancel)
    const signal = AbortSignal.any([request.signal, cancel.signal])
    exports.set(id, state)
    function finish(next, error) {
      disposeIsolated()
      release()
      exportCancels.delete(id)
      state.state = next
      if (error) state.error = error.message ?? String(error)
      const timer = setTimeout(() => exports.delete(id), EXPORT_TTL)
      timer.unref?.()
    }
    try {
      const plan = await planBook(book, format, signal, { ...filter, requireSameFormat: mode === 'single' })
      signal.throwIfAborted()
      state.total = plan.ready.length
      if (!plan.ready.length) {
        throw Object.assign(new Error('AUDIO_INCOMPLETE'), { details: { ready: 0, total: plan.chapters.length } })
      }
      if (estimateZip(plan, format, { mode, subtitles }) > ZIP_LIMIT) throw new Error('ZIP_TOO_LARGE')
      const baseName = sanitizeName(plan.title, '小说配音（LaiVox）')
      const subtitlePack = await buildSubtitlesPayload(plan, {
        book,
        subtitles,
        includeSpeaker,
        chapterGapSeconds: mode === 'single' ? CHAPTER_GAP_SECONDS : 0,
        signal,
      })
      if (mode === 'single' && !subtitlePack) {
        const iterator = singleBookAudio(plan, format, signal, state, bookEncode)[Symbol.asyncIterator]()
        const stream = downloadStream(iterator, signal, finish, bytes => { state.bytes += bytes })
        const contentType = format === 'wav' ? 'audio/wav' : 'audio/mpeg'
        return new Response(stream, { headers: { 'Content-Type': contentType, 'Content-Disposition': attachment(`${baseName}.${format}`) } })
      }
      const entries = mode === 'single'
        ? [
            { name: `${baseName}.${format}`, content: singleBookAudio(plan, format, signal, state, bookEncode) },
            ...subtitlePack.buildFiles(subtitlePack.chapters, baseName),
            { name: 'README.txt', content: Buffer.from(readmeFor(plan, format)) },
          ]
        : entriesFor(plan, format, state, subtitlePack, bookEncode)
      const name = baseName + '.zip'
      const disposition = attachment(name)
      const zip = createZipStream(entries)
      const reader = zip.getReader()
      const stream = downloadStream({
        next: () => reader.read(),
        return() {
          try { return reader.cancel() }
          finally { reader.releaseLock() }
        },
      }, signal, (state, error) => {
        if (state === 'done') reader.releaseLock()
        finish(state, error)
      }, bytes => { state.bytes += bytes })
      return new Response(stream, { headers: { 'Content-Type': 'application/zip', 'Content-Disposition': disposition } })
    } catch (error) {
      finish(signal.aborted ? 'cancelled' : 'error', signal.aborted ? undefined : error)
      throw error
    }
  })

  route('media/excerpt', 'GET', async (request, params) => {
    const jobId = params.get('job')
    const fromRaw = params.get('from')
    const toRaw = params.get('to')
    if (typeof jobId !== 'string' || !jobId || !/^\d+$/u.test(fromRaw ?? '') || !/^\d+$/u.test(toRaw ?? '')) {
      throw new Error('INVALID_INPUT')
    }
    const from = Number(fromRaw)
    const to = Number(toRaw)
    const job = await library.job(jobId)
    if (!job || job.spec?.purpose !== 'generate') throw new Error('JOB_NOT_FOUND')
    const parts = job.progress?.parts ?? []
    if (from < 0 || to < from || to >= parts.length) throw new Error('INVALID_INPUT')
    const slice = parts.slice(from, to + 1)
    if (slice.length > 60) throw new Error('EXCERPT_TOO_LONG')
    const header = await library.chapterHeader(job.chapter)
    if (!header) throw new Error('CHAPTER_NOT_FOUND')

    const formatParam = params.get('format')
    const format = ['mp3', 'wav', 'zip'].includes(formatParam) ? formatParam : 'mp3'
    const subtitlesRaw = params.get('subtitles')
    const subtitles = ['none', 'srt', 'lrc', 'both'].includes(subtitlesRaw) ? subtitlesRaw
      : (format === 'zip' ? 'srt' : 'none')
    const includeSpeaker = params.get('speakers') !== '0'

    const keys = new Map((await library.audioKeys(header.id)).map(item => [item.key, item]))
    const rows = slice.map(part => keys.get(part.key))
    if (!rows.length || rows.some(row => !row)) throw new Error('AUDIO_MISSING')
    const first = rows[0]
    if (rows.some(row => row.rate !== first.rate || row.channels !== first.channels)) {
      throw new Error('WAV_FORMAT_MISMATCH')
    }
    const totalFrames = rows.reduce((sum, row) => sum + logicalFrames(row), 0)
    const totalSeconds = totalFrames / first.rate
    if (totalSeconds > 90) throw new Error('EXCERPT_TOO_LONG')
    const audioFormat = format === 'wav' ? 'wav' : 'mp3'
    if (audioFormat === 'mp3' && !mp3RateSupported(first.rate)) throw new Error('MP3_UNSUPPORTED_FORMAT')

    const release = occupy({ book: header.book, chapter: header.id })
    const signal = request.signal
    const baseName = sanitizeName(`${header.title}-高光片段`, '高光片段')
    try {
      const makeAudioIter = async function* () {
        if (audioFormat === 'wav') {
          const totalBytes = rows.reduce((sum, row) => sum + logicalPcmBytes(row), 0)
          yield wavHeader(totalBytes, first.rate, first.channels)
          yield* pcmRows(header.id, rows, signal)
          return
        }
        yield buildId3v2TitleTag(`${header.bookTitle} - ${header.title}`)
        yield* encodePcm(first.rate, first.channels, pcmRows(header.id, rows, signal))
      }

      if (format !== 'zip' && subtitles === 'none') {
        const iterator = makeAudioIter()[Symbol.asyncIterator]()
        const stream = downloadStream(iterator, signal, () => release())
        const contentType = audioFormat === 'wav' ? 'audio/wav' : 'audio/mpeg'
        return new Response(stream, {
          headers: { 'Content-Type': contentType, 'Content-Disposition': attachment(`${baseName}.${audioFormat}`) },
        })
      }

      const roles = await rolesMapFor(header.book)
      const subParts = slice.map((part, idx) => ({
        text: part.text,
        roleId: part.roleId,
        seconds: logicalFrames(rows[idx]) / first.rate,
      }))
      const subData = [{ title: header.title, parts: subParts }]
      const subFormats = subtitles === 'both' ? ['srt', 'lrc'] : [subtitles === 'none' ? 'srt' : subtitles]
      const { cues } = buildSubtitleCues(subData, { roles, includeSpeaker, chapterGapSeconds: 0 })
      const entries = [
        { name: `${baseName}.${audioFormat}`, content: makeAudioIter() },
        ...subFormats.map(kind => {
          const text = kind === 'lrc' ? formatLrc(cues, { title: header.title, author: header.bookTitle }) : formatSrt(cues)
          return { name: `${baseName}.${kind}`, content: Buffer.from(text, 'utf8') }
        }),
        { name: `${baseName}.txt`, content: Buffer.from(formatScriptMarkdown(subData, { bookTitle: header.bookTitle, roles }), 'utf8') },
      ]
      const zip = createZipStream(entries)
      const reader = zip.getReader()
      const stream = downloadStream({
        next: () => reader.read(),
        return() {
          try { return reader.cancel() }
          finally { reader.releaseLock() }
        },
      }, signal, state => {
        if (state === 'done') reader.releaseLock()
        release()
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'application/zip', 'Content-Disposition': attachment(`${baseName}.zip`) },
      })
    } catch (error) {
      release()
      throw error
    }
  })

  return { async clear(target) {
    const row = target.chapter ? await library.chapterHeader(target.chapter) : null
    if (target.chapter && !row) throw new Error('CHAPTER_NOT_FOUND')
    const release = occupy({ book: row?.book ?? target.book, chapter: target.chapter, clear: true })
    try { return await library.clearAudio(target) }
    finally { release() }
  },
  // Books being exported or cleared right now; stale-audio cleanup leaves them alone.
  busyBooks: () => [...new Set([...active].map(scope => scope.book).filter(Boolean))],
  async guardBook(book, fn) {
    const release = occupy({ book, clear: true }, 'BOOK_EXPORTING')
    try { return await fn() }
    finally { release() }
  } }
}
