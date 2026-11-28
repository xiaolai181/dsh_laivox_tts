import { KEEP_PREVIOUS_AUDIO } from '../domain/production.mjs'
import { narratorDefaultFor } from '../domain/voice-assignment.mjs'
import { engineErrorCode, KEY_PAGE, laivoxAuthorize, laivoxCatalog, laivoxHandoff, laivoxPackCatalog, laivoxStatusView, laivoxUsage, PACK_PAGE, START_PAGE } from './engines/index.mjs'
import { choosePlayable, isComplete, staleReason } from './playable.mjs'
import { edgeVoices } from './edge.mjs'
import { modelDirectory, modelReasoning } from './editorial.mjs'
import { modelUsageTotals } from './model-usage.mjs'
import { collectBytes, IMPORT_LIMIT } from './import/index.mjs'
import { checkedText, firstTitle, titleOf } from './input.mjs'
import { mediaProjection, registerMediaRoutes } from './media.mjs'
import { createMp3Encoder } from './mp3.mjs'
import { segmentChapter, segmentVersion } from '../domain/segment.mjs'
import { resolveGenerationOptions } from '../domain/workflow.mjs'
import { plainSegments } from './editorial.mjs'
import { allowedRanges, planComplete, toSynthesisParts } from './plan.mjs'
import { createProductionService } from './production.mjs'
import { scriptVariant } from './text.mjs'
import { PLUGIN_ID } from '../domain/plugin.mjs'
import { formatNotesMarkdown } from '../domain/notes.mjs'
import { proposalView } from './chat.mjs'

export function errorCode(error) {
  const engineCode = engineErrorCode(error)
  if (engineCode) return engineCode
  return /^[A-Z][A-Z0-9_]+$/u.test(error?.message ?? '') ? error.message : 'SERVICE_UNAVAILABLE'
}

// Ids stored by the plugin are short strings (UUIDs). Anything else must be a
// 400, not a sqlite binding error reported as an outage.
export function idOf(value) {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('INVALID_INPUT')
  return value
}

const offset = params => Math.min(100_000, Math.max(0, Number.parseInt(params.get('offset'), 10) || 0))
const search = params => (params.get('q') ?? '').trim().slice(0, 180)
const session = value => typeof value === 'string' && value.length > 0 && value.length <= 180 ? value : null

async function requestJSON(request) {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error('INVALID_INPUT')
  let bytes
  try { bytes = await collectBytes(request.body, 12 * 1024 ** 2, request.signal) }
  catch (error) {
    // Only chapter text makes a JSON body this large; the import limit's message
    // would talk about files.
    if (error?.message === 'IMPORT_TOO_LARGE') throw new Error('TEXT_TOO_LONG')
    throw error
  }
  const value = JSON.parse(bytes.toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT')
  return value
}

export function jobSummary(job) {
  const { progress } = job
  const counts = {}
  for (const phase of ['clean', 'cast']) {
    const total = progress[phase + 'Total']
    if (Number.isInteger(total)) counts[phase] = {
      done: Math.min(total, progress[phase + 'Done'] ?? progress[phase]?.length ?? 0), total,
    }
  }
  const total = progress.total ?? progress.parts?.length ?? 0
  const tokens = modelUsageTotals(progress.aiTokens, progress.aiRequests)
  return { id: job.id, chapter: job.chapter, state: job.state, title: job.title, bookTitle: job.bookTitle, purpose: job.spec.purpose, rev: job.rev,
    engine: job.spec.engine, mode: job.spec.mode ?? null, isSnippet: Boolean(job.isSnippet), stage: progress.stage, error: progress.error, errorDetail: progress.errorDetail ?? null,
    errorPart: progress.errorPart ?? null, pauseReason: progress.pauseReason,
    skipped: Number.isInteger(progress.skipped) && progress.skipped > 0 ? progress.skipped : 0,
    ...(progress.yieldWait ? { yieldWait: true } : {}),
    ...(Number.isSafeInteger(progress.retryAfter) ? { retryAfter: progress.retryAfter } : {}),
    laivoxPause: progress.laivoxPause ?? null,
    ...(job.state === 'paused' && progress.autoResume && typeof progress.autoResume === 'object' ? { autoResume: progress.autoResume } : {}),
    fill: Boolean(progress.fill), filled: (progress.parts ?? []).filter(part => part.primary).length,
    total, counts, scope: job.spec?.only ? 'range' : 'chapter',
    // Still scripting while it synthesizes: more parts will follow (see cast-pipeline.mjs).
    ...(progress.partsOpen ? { open: true } : {}),
    // A retake of a range that already had audio (see listenFields in jobs.mjs).
    ...(job.spec?.retake ? { retake: true } : {}),
    ...(job.spec?.only ? { ranges: allowedRanges(job.spec, progress).map(range => [range.start, range.end]) } : {}),
    ...(Number.isInteger(progress.synthesisDone) ? { synthesis: { done: progress.synthesisDone, total } } : {}),
    ...(Number.isInteger(progress.aiRequests) ? { ai: { requests: progress.aiRequests, chars: progress.aiChars ?? 0,
      ...(tokens ? { tokens } : {}) } } : {}) }
}

function sessionJob(job) {
  return { ...jobSummary(job), ...(typeof job.nextId === 'string' && job.nextId ? { nextId: job.nextId } : {}) }
}

export async function chapterAudioPlan(library, id, engine, mode, gatewayFor) {
  if (!['edge', 'laivox'].includes(engine) || !['reading', 'multi'].includes(mode)) throw new Error('INVALID_INPUT')
  const chapter = await library.chapter(id)
  if (!chapter) throw new Error('CHAPTER_NOT_FOUND')
  const jobs = await library.chapterJobs(id, chapter.rev)
  const matching = jobs.filter(job => job.spec?.purpose === 'generate' && job.spec.engine === engine && job.spec.mode === mode)
  const active = matching.find(job => ['queued', 'running', 'paused'].includes(job.state))
  const keys = () => library.audioKeys(chapter.id).then(rows => new Set(rows.map(item => item.key)))
  const mark = async parts => {
    const ready = await keys()
    // A fifth element marks a LaiVox line finished with Edge.
    return parts.map(part => part.primary ? [part.start, part.end, ready.has(part.key) ? 1 : 0, part.key, 'edge']
      : [part.start, part.end, ready.has(part.key) ? 1 : 0, part.key])
  }
  if (active?.progress.parts?.length) return { status: 'ok', rev: chapter.rev, parts: await mark(active.progress.parts) }
  const saved = matching.find(job => planComplete(job.progress))
  if (saved && (!active || active.spec?.retake || active.state === 'paused')) {
    return { status: 'ok', rev: chapter.rev, parts: await mark(saved.progress.parts) }
  }
  if (active && active.state !== 'paused') return { status: 'pending' }
  const roles = await library.roles(chapter.book)
  const spec = resolveGenerationOptions({ engine, mode, purpose: 'generate', clean: false }, chapter, roles)
  if (spec.cast) return { status: 'needs-script' }
  const plain = plainSegments(chapter, spec)
  if (!plain) return { status: 'needs-script' }
  let catalog = edgeVoices
  let sessionAccount
  if (engine === 'laivox') {
    try {
      if (typeof gatewayFor !== 'function') return { status: 'needs-engine', reason: 'LAIVOX_KEY_REQUIRED' }
      const session = await gatewayFor(undefined)
      sessionAccount = session.account
      catalog = await laivoxCatalog(session)
    } catch (error) {
      return { status: 'needs-engine', reason: errorCode(error) }
    }
  }
  try {
    const settings = engine === 'laivox' ? await library.settings() : null
    const narratorDefault = narratorDefaultFor(engine, sessionAccount, catalog, settings?.values?.laivoxNarratorDefault)
    const planned = toSynthesisParts(plain.segments, narratorDefault ? { ...spec, laivoxNarratorDefault: narratorDefault } : spec, plain.version, roles, catalog, scriptVariant(chapter.text), chapter.voiceRule)
    return { status: 'ok', rev: chapter.rev, parts: await mark(planned.parts) }
  } catch (error) {
    if (error.message === 'VOICE_UNAVAILABLE' || error.message === 'VOICE_CATALOG_EMPTY') return { status: 'voice-unavailable' }
    if (error.message === 'CHAPTER_EMPTY') return { status: 'ok', rev: chapter.rev, parts: [] }
    throw error
  }
}

// Live view of an unfinished job for the production mosaic: which source lines
// cleaning removed, the speaker and emotion of every segment scripted so far,
// recent voice directions and which synthesis parts are ready. Everything comes
// from checkpoints the job already persists; very large chapters only get counts.
const LIVE_LIMIT = 2000

export function liveProjection(job, parts) {
  const progress = job.progress ?? {}
  const items = (progress.cast ?? []).flat().filter(Boolean)
  const big = items.length > LIVE_LIMIT || (parts?.length ?? 0) > LIVE_LIMIT
  const notes = []
  for (let index = items.length - 1; index >= 0 && notes.length < 3; index--) {
    const instruct = items[index].instruct
    if (instruct && !notes.includes(instruct)) notes.push(instruct)
  }
  return {
    stage: progress.stage ?? null,
    version: progress.segmentVersion ?? null,
    removed: Array.isArray(progress.clean) ? progress.clean.flat() : null,
    clean: Number.isInteger(progress.cleanTotal) ? { done: progress.clean?.length ?? 0, total: progress.cleanTotal } : null,
    cast: Number.isInteger(progress.castTotal) ? { done: progress.cast?.length ?? 0, total: progress.castTotal,
      items: big ? null : items.map(item => [item.id, item.roleId, item.emotion]) } : null,
    notes: notes.reverse(),
    parts: parts?.length && !big ? parts.map(part => [part.start, part.end, part.ready ? 1 : 0]) : null,
  }
}

export async function chapterProjection(library, id, requestedJob, detail = true) {
  const chapter = detail ? await library.chapterDetail(id) : await library.chapterHeader(id)
  if (!chapter) throw new Error('CHAPTER_NOT_FOUND')
  if (!detail && chapter.playback) chapter.playback = JSON.parse(chapter.playback)
  const jobs = await library.chapterJobs(id, chapter.rev)
  const readyRows = await library.audioKeys(id)
  const ready = new Set(readyRows.map(item => item.key))
  const keyMap = new Map(readyRows.map(item => [item.key, item]))
  const current = jobs.find(job => job.spec.purpose === 'generate' && job.state !== 'cancelled')
  const completeHere = jobs.some(job => isComplete(job, ready))
  const latestComplete = KEEP_PREVIOUS_AUDIO && current && !completeHere ? await library.latestCompleteAudioJob(id) : null
  const previous = requestedJob && await library.job(requestedJob)
  const requested = previous?.chapter === id && previous.spec?.purpose === 'generate' ? previous : null
  let pinned = !current && chapter.playback?.job ? await library.job(chapter.playback.job) : undefined
  if (pinned?.chapter !== id || !(await mediaProjection(library, pinned, false, keyMap)).some(part => part.ready)) pinned = undefined
  let playable = choosePlayable({ requested, jobs, latestComplete, pinned, ready, keepPrevious: KEEP_PREVIOUS_AUDIO })
  if (!playable) playable = await library.historicalAudioJob(id)
  const completeJob = jobs.find(job => isComplete(job, ready)) ?? (isComplete(latestComplete, ready) ? latestComplete : null)
  const previousComplete = playable && completeJob && playable.id !== completeJob.id && !isComplete(playable, ready) ? { id: completeJob.id } : null
  const media = playable ? await mediaProjection(library, playable, detail, keyMap) : []
  const working = await library.chapterOperation(id, chapter.rev)
  const operation = working && jobSummary(working)
  let workingParts
  if (operation?.total) {
    workingParts = working.id === playable?.id ? media : await mediaProjection(library, working, false, keyMap)
    operation.synthesis = { done: workingParts.filter(part => part.ready).length, total: operation.total }
  }
  if (operation && ['queued', 'running', 'paused'].includes(operation.state)) operation.live = liveProjection(working, workingParts)
  const editorialResultJob = (detail ? chapter.editorial?.resultJob : chapter.editorialResultJob) ?? null
  const canPreview = working?.progress.cleanPreviewReady && !operation.error &&
    ['queued', 'running', 'paused'].includes(operation.state) && editorialResultJob !== operation.id
  const cleanPreviewJob = canPreview ? operation.id : null
  const playbackStale = !!playable && playable.rev !== chapter.rev
  const state = {
    ...chapter, job: current && jobSummary(current), playbackJob: playable && jobSummary(playable), media,
    operation, editorialResultJob, cleanPreviewJob, playbackStale,
    // Always present, including null. A poll that omits it would leave the
    // previous "back to the old version" button up after the new one is done.
    previousComplete,
    ...(detail ? { staleReason: playbackStale ? staleReason(chapter.text, playable) : null } : {}),
  }
  if (!detail) return state
  if (operation && Array.isArray(working.progress?.attempts)) operation.attempts = working.progress.attempts
  const cleanPreview = canPreview ? { job: cleanPreviewJob, removed: [...new Set(working.progress.clean.flat())] } : null
  const script = segmentChapter(chapter.text, chapter.editorial?.removed, segmentVersion(chapter.editorial))
  // The voice every role gets is computed on the role board from the same domain
  // function, for both engines (src/client/studio/voiceLabels.mjs).
  return { ...state, cleanPreview, script }
}

export function registerAPI(ctx, { library, jobs, imports, chat, gatewayFor, keyStatus, setKey, clearKey, migrationWarning, voicePreview, mp3, snippets, speech, deliverables, updateChecker }) {
  const production = createProductionService(library, gatewayFor)
  function route(path, method, action, raw = false) {
    ctx.connection.fetch.register({
      path: '/api/' + PLUGIN_ID + '/' + path, methods: [method], requestBody: method === 'POST' ? 'streaming' : 'buffered',
      async fetch(request) {
        try {
          const params = new URL(request.url).searchParams
          const data = method === 'POST' && !raw ? await requestJSON(request) : undefined
          const value = await action(request, params, data)
          const response = value instanceof Response ? value : Response.json(value ?? null)
          response.headers.set('Cache-Control', 'no-store')
          return response
        } catch (error) {
          // A malformed JSON body is the caller's input, not an outage.
          const code = error instanceof SyntaxError ? 'INVALID_INPUT' : errorCode(error)
          // Unknown failures are bugs or environment problems: keep the cause in the
          // host log, never in the response.
          if (code === 'SERVICE_UNAVAILABLE') ctx.logger?.warn?.('LaiVox route ' + path + ': ' + (error?.stack ?? error?.message ?? error))
          const status = code === 'INVALID_INPUT' || code === 'EXCERPT_TOO_LONG' ? 400 : code.endsWith('_NOT_FOUND') ? 404 : 409
          return Response.json({ error: code, current: error.current, details: error.details,
            detail: typeof error?.detail === 'string' && error.detail ? error.detail : undefined,
            ...(Number.isSafeInteger(error?.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86_400 ? { retryAfter: error.retryAfter } : {}) },
          { status, headers: { 'Cache-Control': 'no-store' } })
        }
      },
    })
  }
  const media = registerMediaRoutes(route, library, mp3?.encodePcm, createMp3Encoder)
  route('models', 'GET', request => modelDirectory(ctx.llm, { signal: request.signal }))
  route('models/reasoning', 'GET', async (request, params) => {
    const provider = params.get('provider')
    const model = params.get('model')
    if (!(await modelDirectory(ctx.llm, { provider, signal: request.signal })).some(item => item.provider === provider && item.model === model)) {
      throw new Error('MODEL_NOT_CONFIGURED')
    }
    return modelReasoning(ctx.llm, provider, model, request.signal)
  })
  route('key', 'GET', async () => ({ ...await keyStatus(), keyPage: KEY_PAGE, packPage: PACK_PAGE, startPage: START_PAGE }))
  route('laivox/handoff', 'POST', request => laivoxHandoff(gatewayFor, request.signal))
  // LaiVox account, membership and usage: only asked when the LaiVox card is open
  // or a paused job offers to open a usage day.
  route('laivox/status', 'GET', async (request, params) => laivoxStatusView(await gatewayFor(undefined, request.signal, params.get('fresh') === '1')))
  route('laivox/usage', 'GET', (request, params) => laivoxUsage(gatewayFor, request.signal, params.get('account') ?? undefined))
  route('laivox/usage/authorize', 'POST', (request, _params, body) => laivoxAuthorize(gatewayFor, body, request.signal))
  // The read-aloud pack's price (requires a valid key).
  route('laivox/pack-catalog', 'GET', request => laivoxPackCatalog(gatewayFor, request.signal))
  route('key/save', 'POST', (request, _params, body) => setKey(body.apiKey, request.signal))
  route('key/clear', 'POST', () => {
    if (typeof clearKey !== 'function') throw new Error('KEY_CLEAR_UNSUPPORTED')
    return clearKey()
  })
  // refresh=1 re-reads LaiVox voices right away (after changing them in the extension).
  route('voices', 'GET', async (request, params) => params.get('engine') === 'laivox'
    ? laivoxCatalog(await gatewayFor(undefined, request.signal), request.signal, { refresh: params.get('refresh') === '1' }) : edgeVoices)
  route('voices/preview', 'GET', async (request, params) =>
    new Response(await voicePreview.load(params.get('engine'), params.get('voice'), request.signal), { headers: { 'Content-Type': 'audio/wav' } }))
  route('settings', 'GET', () => library.settings())
  route('plugin/update-info', 'GET', (_request, params) => updateChecker?.info({ check: params.get('check') === '1', force: params.get('force') === '1' }) ?? { running: '', available: false, command: 'dsh plugin add dsh-laivox-tts' })
  route('plugin/update', 'POST', () => updateChecker?.applyUpdate() ?? { ok: false, error: 'UPDATE_MANUAL_REQUIRED', command: 'dsh plugin add dsh-laivox-tts' })
  route('settings/save', 'POST', async (request, _params, body) => {
    if (body?.changes?.laivoxNarratorDefault) await production.confirmNarratorDefault(body.changes.laivoxNarratorDefault, request.signal)
    const saved = await production.saveSettings(body)
    // A shorter retention takes effect now (the user confirmed the deletions),
    // not at the next hourly cleanup.
    if (Object.hasOwn(body?.changes ?? {}, 'snippetRetention')) void snippets?.sweep()
    return saved
  })
  route('operations/result', 'GET', (_request, params) => library.operation(params.get('id')))
  route('notes/list', 'GET', (_request, params) => {
    const limitRaw = params.get('limit')
    const limit = limitRaw && /^\d+$/u.test(limitRaw) ? Math.min(500, Math.max(1, Number(limitRaw))) : 100
    return library.listNotes({
      book: params.get('book') || undefined,
      chapter: params.get('chapter') || undefined,
      q: search(params),
      offset: offset(params),
      limit,
    })
  })
  route('notes/save', 'POST', (_request, _params, body) => {
    if (!body || typeof body !== 'object') throw new Error('INVALID_INPUT')
    return library.saveNote({
      id: body.id,
      book: body.book,
      chapter: body.chapter,
      partIndex: body.partIndex,
      charOffset: body.charOffset,
      quote: body.quote,
      speaker: body.speaker,
      body: body.body,
    })
  })
  route('notes/delete', 'POST', (_request, _params, body) => library.deleteNote({ id: body?.id }))
  route('notes/export', 'GET', async (_request, params) => {
    const bookId = params.get('book')
    if (typeof bookId !== 'string' || !bookId) throw new Error('INVALID_INPUT')
    const book = await library.shelfBook(bookId)
    if (!book) throw new Error('BOOK_NOT_FOUND')
    const allNotes = []
    for (let off = 0; ; off += 500) {
      const page = await library.listNotes({ book: bookId, offset: off, limit: 500 })
      allNotes.push(...(page?.notes ?? []))
      if (!page?.notes?.length || allNotes.length >= (page?.total ?? 0)) break
    }
    const md = formatNotesMarkdown(book.title, allNotes)
    const ascii = book.title.replace(/[^\x20-\x7e]/gu, '_') || 'notes'
    return new Response(md, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ascii}-notes.md"; filename*=UTF-8''${encodeURIComponent(book.title + '-笔记.md')}`,
      },
    })
  })
  route('production/save', 'POST', (request, _params, body) => production.save(body, request.signal))

  route('library/books', 'GET', async (_request, params) => ({
    books: await library.books(offset(params), search(params)), space: await library.space(), imports: await library.imports(), migrationWarning,
  }))
  route('library/chapters', 'GET', (_request, params) => library.chapters(params.get('book'), offset(params), search(params)))
  route('library/chapter-ids', 'GET', (_request, params) => library.chapterIds(params.get('book')))
  route('library/action', 'POST', async (_request, _params, body) => {
    if (!body || typeof body.book !== 'string' || !body.book) throw new Error('INVALID_INPUT')
    if (Object.keys(body).some(key => !['action', 'book', 'title'].includes(key))) throw new Error('INVALID_INPUT')
    if (body.action === 'rename') {
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      if (!title || title.length > 180) throw new Error('INVALID_INPUT')
      return library.renameBook(body.book, title)
    }
    if (body.action === 'delete') {
      return media.guardBook(body.book, async () => {
        const cancelled = await jobs.cancelForBook(body.book)
        const result = await library.deleteBook(body.book)
        return { ...result, cancelled }
      })
    }
    throw new Error('INVALID_INPUT')
  })
  route('library/compact', 'POST', () => library.compact())
  route('chapter', 'GET', (_request, params) => chapterProjection(library, params.get('id'), params.get('job')))
  route('chapter/progress', 'GET', (_request, params) => chapterProjection(library, params.get('id'), params.get('job'), false))
  route('chapter/audio-plan', 'GET', (_request, params) => chapterAudioPlan(library, params.get('id'), params.get('engine'), params.get('mode'), gatewayFor))
  route('chapter/resume', 'GET', async (_request, params) => {
    const row = await library.chapterResume(params.get('id'))
    if (!row) throw new Error('CHAPTER_NOT_FOUND')
    return row
  })
  route('chapter/save', 'POST', async (request, _params, body) => {
    const text = checkedText(body.text)
    if (!body.id) return library.manual(titleOf(body.title, firstTitle(text)), text, body.book ?? undefined)
    idOf(body.id)
    const current = await library.chapterHeader(body.id)
    if (!current) throw new Error('CHAPTER_NOT_FOUND')
    try {
      await production.save({ id: body.id, base: { rev: body.rev, rolesRev: current.rolesRev,
        editorialResultJob: body.baseEditorialResultJob === undefined ? current.editorialResultJob : body.baseEditorialResultJob },
        patch: { text, title: body.title, editorial: body.editorial } }, request.signal, true)
      return library.chapter(body.id)
    }
    catch (error) {
      if (error.message === 'VERSION_CONFLICT') error.current = await library.chapter(body.id)
      throw error
    }
  })

  // Moves a book to the latest automatic voice rule (only on the user's confirmation).
  route('book/voice-rule', 'POST', (_request, _params, body) => library.setVoiceRule(body?.book, body?.rule, body?.baseRolesRev))
  route('role/save', 'POST', async (request, _params, body) => {
    if (!['edge','laivox'].includes(body.engine)) throw new Error('INVALID_INPUT')
    idOf(body.chapter)
    const row = await library.chapterHeader(body.chapter)
    if (!row) throw new Error('CHAPTER_NOT_FOUND')
    return production.save({ id: body.chapter, base: row,
      patch: { roles: [{ id: body.role, voices: { [body.engine]: body.voice } }] } }, request.signal, true)
  })
  route('import/upload', 'POST', (request, params) => {
    if (Number(request.headers.get('content-length')) > IMPORT_LIMIT) throw new Error('IMPORT_TOO_LARGE')
    return imports.stage(params.get('name') ?? '', request.body, null, request.signal)
  }, true)
  route('import/preview', 'GET', (request, params) => imports.preview(params.get('id'), session(params.get('session')),
    { settled: params.get('settled') === '1', signal: request.signal }))
  // Delivered files: what a file card's action route points at, then the import.
  route('deliverable/describe', 'GET', (request, params) => deliverables.describe(params.get('url') ?? '', request.signal))
  route('deliverable/import', 'POST', (request, _params, body) => deliverables.stage(body.url, request.signal))
  // Draft, published or gone: the import cards under a reply follow this.
  route('import/state', 'GET', (_request, params) => imports.state(params.get('id') ?? '', session(params.get('session'))))
  route('import/context', 'GET', (_request, params) => {
    const offset = params.get('offset')
    if (!offset || !/^\d+$/u.test(offset)) throw new Error('INVALID_CHAPTER_BOUNDARY')
    return imports.context(params.get('id'), session(params.get('session')), Number(offset))
  })
  route('import/action', 'POST', async (request, _params, body) => {
    idOf(body?.id)
    const owner = session(body.session)
    if (body.action === 'discard') return imports.discard(body.id, owner)
    if (body.action === 'publish') {
      if (body.appendToBook !== undefined && body.appendToBook !== null && (typeof body.appendToBook !== 'string' || !body.appendToBook.trim())) throw new Error('INVALID_INPUT')
      return imports.publish(body.id, owner, body.chapters, body.duplicate, body.revision, typeof body.appendToBook === 'string' ? body.appendToBook.trim() : undefined)
    }
    if (body.action === 'reparse') return imports.reparse(body.id, owner, body, request.signal)
    if (body.action === 'analyze') return imports.analyze(body.id, owner, body.selection, request.signal)
    if (body.action === 'cut') return imports.changeCut(body.id, owner, body)
    throw new Error('INVALID_INPUT')
  })

  route('jobs', 'GET', async () => (await library.jobs()).map(jobSummary))
  route('jobs/page', 'GET', async (_request, params) => {
    const state = params.get('state')
    if (state && !['running','queued','paused','completed','cancelled'].includes(state)) throw new Error('INVALID_INPUT')
    const page = await library.jobsPage({ book: params.get('book'), chapter: params.get('chapter'), state, offset: offset(params),
      limit: params.get('countsOnly') === '1' ? 0 : undefined })
    return { ...page, jobs: page.jobs.map(jobSummary) }
  })
  route('jobs/item', 'GET', async (_request, params) => {
    const job = await library.job(params.get('id'))
    if (!job) throw new Error('JOB_NOT_FOUND')
    const summary = jobSummary(job)
    if (Array.isArray(job.progress?.attempts)) summary.attempts = job.progress.attempts
    return summary
  })
  route('jobs/prepare', 'POST', (request, _params, body) => jobs.prepare(body.chapters, body, request.signal))
  route('jobs/action', 'POST', async (request, _params, body) => {
    if (body.action === 'start') {
      return (await jobs.enqueue(body.chapters, body, request.signal)).map(jobSummary)
    }
    if (body.action === 'focus') {
      // Synthesize from this part next; a no-op unless the job is running now.
      idOf(body.id)
      if (!Number.isSafeInteger(body.n) || body.n < 0) throw new Error('INVALID_INPUT')
      return { focused: jobs.focus(body.id, body.n) }
    }
    if (body.action === 'include') {
      idOf(body.id)
      if (!Number.isSafeInteger(body.start) || !Number.isSafeInteger(body.end) || body.end <= body.start) throw new Error('INVALID_INPUT')
      return { included: await jobs.include(body.id, body.start, body.end) }
    }
    if (body.action === 'bulk-preview') {
      const ids = await jobs.bulkTargets(body.mode, body.scope)
      return { ids, jobs: await library.bulkJobFacts(ids) }
    }
    if (body.action === 'bulk') return jobs.bulk(body.mode, body.scope, body.ids)
    if (body.action === 'clear-audio') {
      if (body.chapter != null) idOf(body.chapter)
      if ((typeof body.chapter === 'string') === (typeof body.book === 'string')) throw new Error('INVALID_INPUT')
      return media.clear(body)
    }
    return jobSummary(await jobs.action(idOf(body?.id), body.action, body.action === 'resume' ? body.start : undefined))
  })
  route('playback/save', 'POST', async (_request, _params, { chapter, n, offset, rate, volume, job, bookmark, expectedRevision, start }) => {
    if (typeof chapter !== 'string' || !Number.isInteger(n) || n < 0 || !Number.isFinite(offset) || offset < 0 || !Number.isFinite(rate) || rate < 0.5 || rate > 2.5
      || !Number.isFinite(volume) || volume < 0 || volume > 1 || typeof job !== 'string' ||
      (start !== undefined && (!Number.isSafeInteger(start) || start < 0)) ||
      (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) throw new Error('INVALID_INPUT')
    if ((await library.job(job))?.chapter !== chapter) throw new Error('JOB_NOT_FOUND')
    const saved = await library.playback(chapter, { n, offset, rate, volume, job, at: Date.now(), ...(Number.isSafeInteger(start) ? { start } : {}), ...(bookmark === true ? { bookmark: { n, offset, job } } : {}) }, expectedRevision)
    // Listening to a conversation reading restarts its retention period. Best
    // effort: a failure here must not fail the position save.
    try { await library.touchSnippet(chapter) } catch (error) { ctx.logger?.warn?.('LaiVox could not mark a reading as listened: ' + (error?.message ?? error)) }
    return saved
  })

  // 对话音频: list, rename, save to shelf, delete; retention preview.
  route('snippets', 'GET', (_request, params) => snippets.list(offset(params)))
  route('snippets/expiring', 'GET', (_request, params) => snippets.expiring(params.get('retention')))
  route('snippets/action', 'POST', (_request, _params, body) => {
    if (body.action === 'rename') return snippets.rename(body.book, body.title)
    if (body.action === 'adopt') return snippets.adopt(body.book, body.title)
    if (body.action === 'delete') return snippets.remove(body.book)
    if (body.action === 'delete-all') return snippets.removeAll()
    throw new Error('INVALID_INPUT')
  })
  // Audio from earlier versions of a chapter: measure, then remove on request.
  route('storage/stale-audio', 'GET', () => library.staleAudio(false, media.busyBooks()))
  route('storage/stale-audio/clear', 'POST', () => library.staleAudio(true, media.busyBooks()))
  // Instant speech: accept a text, then serve its parts as MP3.
  route('speech/start', 'POST', (_request, _params, body) => speech.start({ text: body.text, voice: body.voice ?? undefined, session: session(body.session) || null, owner: typeof body.owner === 'string' ? body.owner : undefined }))
  route('speech/claim', 'POST', (_request, _params, body) => speech.claim(body.speechId, body.page))
  route('speech/part', 'GET', async (request, params) => {
    const audio = await speech.part(params.get('id') ?? '', Number(params.get('n')), request.signal)
    return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg' } })
  })
  route('speech/cancel', 'POST', (_request, _params, body) => speech.cancel(String(body.speechId ?? '')))
  route('speech/warm', 'POST', async (_request, _params, body) => { await speech.warmFor(body.text); return { ok: true } })
  route('session', 'GET', async (_request, params) => {
    const id = session(params.get('id'))
    if (!id) throw new Error('SESSION_REQUIRED')
    const board = await library.sessionBoard(id)
    return {
      jobs: board.jobs.map(sessionJob), latest: board.latest ? sessionJob(board.latest) : null, overflow: board.overflow,
      // Summaries only: a command proposal can carry a long text, and this is
      // polled every couple of seconds. The text comes from proposal/state.
      proposals: (await library.proposals(id)).map(({ id: key, ...payload }) => proposalView({ id: key, payload })),
      imports: await library.imports(id),
      // The newest instant speech started in this session (tool cards the page did not see arrive).
      speech: speech?.latest(id) ?? null,
    }
  })
  route('proposal/state', 'GET', async (_request, params) => {
    const owner = session(params.get('session'))
    if (!owner) throw new Error('SESSION_REQUIRED')
    const row = await library.proposalState(params.get('id') ?? '', owner)
    if (!row) throw new Error('PROPOSAL_NOT_FOUND')
    return proposalView(row, true)
  })
  route('proposal/action', 'POST', async (_request, _params, body) => {
    const id = session(body.session)
    if (!id) throw new Error('SESSION_REQUIRED')
    if (body.action === 'dismiss') return library.dismissProposal(idOf(body?.id), id)
    if (body.action === 'preview') return chat.preview(idOf(body?.id), id, body.options ?? {}, _request.signal)
    if (body.action === 'confirm') return jobSummary(await chat.confirm(idOf(body?.id), id, body.options))
    throw new Error('INVALID_INPUT')
  })
}
