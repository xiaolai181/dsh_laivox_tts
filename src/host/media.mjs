import { randomUUID } from 'node:crypto'
import { encodePcm as sharedEncodePcm, mp3RateSupported } from './mp3.mjs'
import { createZipStream, ZIP_LIMIT } from './zip.mjs'
import { encodeWav, wavHeader } from './wav.mjs'
import { planComplete } from './plan.mjs'
import { decodeStoredAudio, logicalFrames, logicalPcmBytes } from './stored-audio.mjs'

const EXPORT_TTL = 60_000
const EXPORT_LIMIT = 0xffffffff
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
export function registerMediaRoutes(route, library, encodePcm = sharedEncodePcm) {
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

  async function* pcmRows(chapter, rows, signal) {
    for (const row of rows) {
      signal?.throwIfAborted()
      const audio = await library.audio(chapter, row.key)
      if (!audio) throw new Error('AUDIO_MISSING')
      yield await decodeStoredAudio(audio, signal)
    }
  }

  // A job still scripting (its plan only covers part of the chapter) is never the
  // chapter's audio, even when every part it has so far is ready.
  function usable(job, keys) {
    return job?.spec?.purpose === 'generate' && planComplete(job.progress) &&
      job.progress.parts.every(part => keys.has(part.key))
  }

  async function playableJob(row, keys) {
    const operation = await library.chapterOperation(row.id, row.rev)
    if (usable(operation, keys)) return operation
    const jobs = await library.chapterJobs(row.id, row.rev)
    const found = jobs.find(job => usable(job, keys))
    if (found) return found
    const historical = await library.historicalAudioJob(row.id)
    return historical && historical.rev === row.rev && usable(historical, keys) ? historical : null
  }

  async function planBook(book, format, signal) {
    const chapters = []
    for (let offset = 0; ; offset += 80) {
      signal.throwIfAborted()
      const rows = await library.chapters(book, offset)
      chapters.push(...rows)
      if (rows.length < 80) break
      if (chapters.length >= 20_000) throw new Error('IMPORT_TOO_MANY_CHAPTERS')
    }
    const ready = []
    const skipped = []
    if (!chapters.length) return { chapters, ready, skipped, title: '小说配音（LaiVox）' }
    const title = (await library.chapter(chapters[0].id)).bookTitle
    for (const row of chapters) {
      signal.throwIfAborted()
      if (!row.hasAudio) { skipped.push({ row, reason: '尚未生成音频' }); continue }
      const keys = new Map((await library.audioKeys(row.id)).map(item => [item.key, item]))
      const job = await playableJob(row, keys)
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
      // Keep only what the archive needs up front; parts and keys are read again
      // chapter by chapter while streaming, so a long book is not held in memory.
      const bytes = parts.reduce((total, part) => total + logicalPcmBytes(keys.get(part.key)), 0)
      ready.push({ row, job: job.id, rate: first.rate, channels: first.channels, bytes })
    }
    return { chapters, ready, skipped, title }
  }

  // Upper bound of the archive size, checked before any byte is sent so an
  // oversized book fails with a message instead of a broken download.
  function estimateZip(plan, format) {
    let total = 22 + 4096
    for (const entry of plan.ready) {
      const name = Buffer.byteLength(entry.row.title, 'utf8') + 16
      const seconds = logicalFrames(entry) / entry.rate
      const body = format === 'wav' ? entry.bytes + 44 : Math.ceil(seconds * (entry.channels === 2 ? 96 : 64) * 1000 / 8 * 1.1) + 4096
      total += 30 + name + body + 16 + 46 + name
    }
    return total
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

  async function* mp3Content(entry) {
    const rows = await chapterRows(entry)
    yield* encodePcm(entry.rate, entry.channels, pcmRows(entry.row.id, rows))
  }

  async function* progressContent(inner, state) {
    for await (const chunk of inner) yield chunk
    state.done += 1
  }

  function entriesFor(plan, format, state) {
    const entries = []
    for (const entry of plan.ready) {
      const name = `${String(entry.row.ordinal).padStart(3, '0')}-${sanitizeName(entry.row.title, '章节')}.${format}`
      const content = format === 'wav' ? wavContent(entry) : mp3Content(entry)
      entries.push({ name, content: progressContent(content, state) })
    }
    entries.push({ name: 'README.txt', content: Buffer.from(readmeFor(plan, format)) })
    return entries
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
    async function* counted(rows) {
      for await (const pcm of rows) {
        yield pcm
        if (state) state.done += 1
      }
    }
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
        const iterator = encodePcm(rate, channels, counted(pcmRows(job.chapter, ordered)))[Symbol.asyncIterator]()
        const stream = downloadStream(iterator, request.signal, settle, countBytes)
        return new Response(stream, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Disposition': disposition } })
      }
      const bytes = ordered.reduce((total, row) => total + logicalPcmBytes(row), 0)
      if (bytes > EXPORT_LIMIT - 36) throw new Error('WAV_FORMAT_MISMATCH')
      async function* chapterWav() {
        yield wavHeader(bytes, rate, channels)
        yield* counted(pcmRows(job.chapter, ordered))
      }
      const stream = downloadStream(chapterWav(), request.signal, settle, countBytes)
      return new Response(stream, { headers: { ...headers, 'Content-Length': String(bytes + 44), 'Content-Disposition': 'attachment; filename="novel.wav"' } })
    } catch (error) {
      settle(request.signal.aborted ? 'cancelled' : 'error', request.signal.aborted ? undefined : error)
      throw error
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
    const id = exportIdOf(params.get('export'))
    const state = { state: 'running', done: 0, total: 0, bytes: 0, error: null }
    // Occupy first: a refused export must not leave a progress entry that stays
    // `running` forever.
    const release = occupy({ book })
    const cancel = new AbortController()
    exportCancels.set(id, cancel)
    const signal = AbortSignal.any([request.signal, cancel.signal])
    exports.set(id, state)
    function finish(next, error) {
      release()
      exportCancels.delete(id)
      state.state = next
      if (error) state.error = error.message ?? String(error)
      const timer = setTimeout(() => exports.delete(id), EXPORT_TTL)
      timer.unref?.()
    }
    try {
      const plan = await planBook(book, format, signal)
      signal.throwIfAborted()
      state.total = plan.ready.length
      if (!plan.ready.length) {
        throw Object.assign(new Error('AUDIO_INCOMPLETE'), { details: { ready: 0, total: plan.chapters.length } })
      }
      if (estimateZip(plan, format) > ZIP_LIMIT) throw new Error('ZIP_TOO_LARGE')
      const name = sanitizeName(plan.title, '小说配音（LaiVox）') + '.zip'
      const disposition = attachment(name)
      const zip = createZipStream(entriesFor(plan, format, state))
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
