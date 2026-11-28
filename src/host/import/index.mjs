import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolvePluginModel } from '../editorial.mjs'
import { contextAt } from './chapters.mjs'
import { createLayout, normalizeDraft, resolveLayout, summary } from './layout.mjs'
import { runReview, REVIEW_VERSION } from './review.mjs'

export const IMPORT_LIMIT = 50 * 1024 ** 2
const idPattern = /^[0-9a-f-]{36}$/u

async function waitForImport(start, signal) {
  if (!signal) return start()
  signal.throwIfAborted()
  let abort
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      Promise.resolve(start()).then(resolve, reject)
    })
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export async function collectBytes(body, limit, signal) {
  signal?.throwIfAborted()
  const asyncIterator = body?.[Symbol.asyncIterator]?.()
  const iterator = asyncIterator ?? body?.[Symbol.iterator]?.()
  if (!iterator) throw new Error('INVALID_INPUT')
  const chunks = []
  let size = 0
  let done = false
  try {
    for (;;) {
      const step = await waitForImport(() => iterator.next(), signal)
      signal?.throwIfAborted()
      if (step.done) { done = true; break }
      const bytes = asyncIterator ? step.value : await waitForImport(() => step.value, signal)
      signal?.throwIfAborted()
      size += bytes.byteLength
      if (size > limit) throw new Error('IMPORT_TOO_LARGE')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally {
    // Closing an async iterator can wait for the same stalled read. The
    // abandoned iterator has no access to the library or the collected bytes.
    if (!done) void Promise.resolve().then(() => iterator.return?.()).catch(() => {})
  }
}

function parseInWorker(input, signal, workers) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const worker = new Worker(new URL('./import-worker.mjs', import.meta.url), { env: {} })
    workers?.add(worker)
    const abort = () => { void worker.terminate(); reject(signal.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    worker.once('error', () => reject(new Error('IMPORT_FAILED')))
    worker.once('exit', code => {
      workers?.delete(worker)
      signal?.removeEventListener('abort', abort)
      if (code) reject(new Error('IMPORT_FAILED'))
    })
    worker.once('message', ({ value, error }) => {
      if (error) reject(new Error(error))
      else resolve(value)
    })
    worker.postMessage(input)
  })
}

export function createImportService(library, root, llm, options = {}) {
  const rawRoot = join(root, 'import-source')
  const roundMs = Number.isFinite(options.roundMs) ? options.roundMs : undefined
  const shutdown = new AbortController()
  let running = false
  let closed = false
  let finished = Promise.resolve()
  let activeReview = null
  const settleMs = options.settleMs ?? 5_000
  const reviewFor = (id, session) => activeReview?.id === id && activeReview.session === session ? activeReview : null
  // Parser workers in flight, terminated when the plugin shuts down so none keeps
  // running against a closed library.
  const workers = new Set()
  const importSignal = caller => caller ? AbortSignal.any([caller, shutdown.signal]) : shutdown.signal
  const rawPath = id => join(rawRoot, id + '.txt')
  async function exclusive(fn) {
    if (closed) throw new Error('PLUGIN_STOPPED')
    if (running) throw new Error('IMPORT_RUNNING')
    running = true
    const task = (async () => {
      try { return await fn() }
      finally { running = false }
    })()
    finished = task.then(() => {}, () => {})
    return task
  }
  async function find(id, session) {
    if (!idPattern.test(id)) throw new Error('IMPORT_NOT_FOUND')
    const row = await library.import(id)
    if (!row || row.session !== session) throw new Error('IMPORT_NOT_FOUND')
    return normalizeDraft(row.payload, session)
  }
  function validate(data) {
    if (!data.chapters.length) throw new Error('CHAPTER_EMPTY')
    if (data.chapters.length > 5000) throw new Error('IMPORT_TOO_MANY_CHAPTERS')
    return data
  }
  async function analyze(id, session, selection, signal) {
    const linked = importSignal(signal)
    const data = await find(id, session)
    const selected = await waitForImport(() => resolvePluginModel(llm, selection, linked), linked)
    linked.throwIfAborted()
    const layout = data.layout
    const current = await library.importReview(layout.source)
    let version = current?.rev ?? 0
    if (!layout.candidates) {
      layout.candidates = await parseInWorker({ format: 'review', text: layout.text, cuts: layout.cuts, structure: layout.structure }, linked, workers)
      linked.throwIfAborted()
      await library.saveImport(id, session, data)
    }
    const previous = await library.relatedImportReview(data.lineage, layout.source)
    const state = current?.state?.version === REVIEW_VERSION ? current.state : { spent: current?.state?.spent, requests: current?.state?.requests }
    const result = await runReview({
      text: layout.text, candidates: layout.candidates, state,
      previous: previous?.version === REVIEW_VERSION ? previous : undefined,
      llm, selection: selected, signal: linked, ...(roundMs === undefined ? {} : { roundMs }), gate: options.gate,
      async checkpoint(updated) {
        version = await library.saveImportReview(layout.source, data.lineage, version, updated)
      },
    })
    const view = summary(id, data, { state: result.state })
    if (result.partial) view.ai = { ...view.ai, partial: true }
    return view
  }
  return {
    // Drafts left neither imported nor discarded for 30 days.
    expire: before => exclusive(async () => {
      let removed = 0
      for (const { id } of await library.staleImports(before)) {
        await library.discardImport(id)
        await rm(rawPath(id), { force: true }).catch(() => {})
        removed++
      }
      return removed
    }),
    async dispose() {
      closed = true
      shutdown.abort(new Error('PLUGIN_STOPPED'))
      await finished
      await Promise.all([...workers].map(worker => worker.terminate()))
    },
    stage: (name, stream, session = null, signal) => exclusive(async () => {
      const linked = importSignal(signal)
      const ext = extname(name).slice(1).toLowerCase()
      const format = ext === 'markdown' ? 'md' : ext === 'htm' ? 'html' : ext
      if (!['epub', 'txt', 'pdf', 'md', 'html', 'docx'].includes(format)) throw new Error('IMPORT_TYPE_INVALID')
      const filename = basename(name.replaceAll('\\','/'))
      const title = basename(filename, extname(filename)).trim().slice(0, 180) || '未命名小说'
      if ((await library.imports(session)).length >= 20) throw new Error('IMPORT_PREVIEW_LIMIT')
      const bytes = await collectBytes(stream, IMPORT_LIMIT, linked)
      if (!bytes.length) throw new Error('CHAPTER_EMPTY')
      const id = randomUUID()
      const fingerprint = createHash('sha256').update(bytes).digest('hex')
      const data = validate(await parseInWorker({ bytes, title, format }, linked, workers))
      linked.throwIfAborted()
      if (format === 'txt') {
        await mkdir(rawRoot, { recursive: true, mode: 0o700 })
        linked.throwIfAborted()
        await writeFile(rawPath(id), bytes, { flag: 'wx', mode: 0o600 })
      }
      const draft = createLayout(data, fingerprint, filename, session)
      try {
        const review = await library.importReview(draft.layout.source)
        if (review?.state?.version === REVIEW_VERSION) {
          const { text, cuts, structure } = draft.layout
          draft.layout.candidates = await parseInWorker({ format: 'review', text, cuts, structure }, linked, workers)
        }
        linked.throwIfAborted()
        await library.saveImport(id, session, draft)
        const view = summary(id, draft, review)
        const resolved = resolveLayout(draft, review)
        const matchedBook = await library.findRelatedBook({
          fingerprint: draft.fingerprint,
          title: draft.title,
          chapters: resolved.chapters.map(({ title: chTitle, text: chText }) => ({ title: chTitle, text: chText })),
        })
        return { ...view, matchedBook }
      } catch (error) {
        if (format === 'txt') await rm(rawPath(id), { force: true }).catch(() => {})
        throw error
      }
    }),
    // Where an import stands, for the cards that offered it: still a
    // draft, published (the book keeps the import's id or append target), or gone.
    async state(id, session = null) {
      if (!idPattern.test(id)) throw new Error('IMPORT_NOT_FOUND')
      const row = await library.import(id)
      if (row && row.session === session) return { state: 'pending' }
      const published = await library.publishedImport(id, session)
      if (published) {
        const book = await library.shelfBook(published.book)
        return book ? { state: 'published', book: book.id, title: book.title } : { state: 'gone' }
      }
      return { state: 'gone' }
    },
    async preview(id, session = null, { settled = false, signal } = {}) {
      let data = await find(id, session)
      const active = settled && reviewFor(id, session)
      if (active) {
        const timeout = AbortSignal.timeout(settleMs)
        const caller = importSignal(signal)
        try { await waitForImport(() => active.done, AbortSignal.any([caller, timeout])) }
        catch (error) {
          caller.throwIfAborted()
          if (timeout.aborted) throw new Error('IMPORT_RUNNING')
          throw error
        }
        data = await find(id, session)
      }
      const review = await library.importReview(data.layout.source)
      if (settled) {
        signal?.throwIfAborted()
        if (reviewFor(id, session)) throw new Error('IMPORT_RUNNING')
      }
      const view = summary(id, data, review)
      const resolved = resolveLayout(data, review)
      const matchedBook = await library.findRelatedBook({
        fingerprint: data.fingerprint,
        title: data.title,
        chapters: resolved.chapters.map(({ title: chTitle, text: chText }) => ({ title: chTitle, text: chText })),
      })
      return { ...view, matchedBook }
    },
    async context(id, session, offset) {
      const data = await find(id, session)
      return contextAt(data.layout.text, offset)
    },
    analyze(id, session, selection, signal) {
      const owner = { id, session, done: null }
      const task = exclusive(() => {
        activeReview = owner
        return analyze(id, session, selection, signal)
      })
      const clear = () => { if (activeReview === owner) activeReview = null }
      owner.done = task.then(clear, clear)
      return task
    },
    changeCut: (id, session, { from, to, revision }) => exclusive(async () => {
      const data = await find(id, session)
      const { layout } = data
      const review = await library.importReview(layout.source)
      const current = resolveLayout(data, review)
      if (revision !== current.revision) throw new Error('VERSION_CONFLICT')
      if (from == null && to == null) throw new Error('INVALID_CHAPTER_BOUNDARY')
      if (from != null) {
        if (!Number.isInteger(from) || from <= 0 || (!current.active.has(from) && !current.suggestions.some(item => item.offset === from))) {
          throw new Error('INVALID_CHAPTER_BOUNDARY')
        }
        layout.manual[from] = false
      }
      if (to != null) {
        if (to === 0 || (to !== from && current.active.has(to))) throw new Error('INVALID_CHAPTER_BOUNDARY')
        contextAt(layout.text, to)
        const existing = current.suggestions.find(item => item.offset === to) ?? current.active.get(from)
        layout.manual[to] = { offset: to, title: existing?.title ?? '', kind: 'manual' }
      }
      validate(resolveLayout(data, review))
      await library.saveImport(id, session, data)
      return summary(id, data, review)
    }),
    reparse: (id, session, { encoding, split }, signal) => exclusive(async () => {
      const linked = importSignal(signal)
      const old = await find(id, session)
      if (old.format !== 'txt') throw new Error('IMPORT_TYPE_INVALID')
      const bytes = await readFile(rawPath(id), { signal: linked })
      const data = validate(await parseInWorker({ bytes, title: old.title, format: 'txt', encoding, split }, linked, workers))
      linked.throwIfAborted()
      const draft = createLayout(data, old.fingerprint, old.filename, session)
      if (draft.layout.source === old.layout.source) {
        draft.layout.manual = old.layout.manual
        if (draft.split === old.split) draft.layout.candidates = old.layout.candidates
      }
      await library.saveImport(id, session, draft)
      return summary(id, draft, await library.importReview(draft.layout.source))
    }),
    publish: (id, session, selection, duplicate, revision, appendToBook) => exclusive(async () => {
      const published = await library.publishedImport(id, session)
      if (published) return { id: published.book }
      const data = await find(id, session)
      const resolved = validate(resolveLayout(data, await library.importReview(data.layout.source)))
      if (revision !== undefined && revision !== resolved.revision) throw new Error('VERSION_CONFLICT')
      const ordinals = selection ?? resolved.chapters.map((_, index) => index)
      if (!Array.isArray(ordinals) || !ordinals.length || ordinals.some(index => !Number.isInteger(index) || !resolved.chapters[index])) throw new Error('INVALID_INPUT')
      const uniqueOrdinals = [...new Set(ordinals)].sort((a, b) => a - b)
      const result = appendToBook
        ? await library.mergeBookChapters({ id, session, targetBook: appendToBook, chapters: uniqueOrdinals.map(i => resolved.chapters[i]) })
        : await library.publishImport(id, session, { ...data, chapters: resolved.chapters }, uniqueOrdinals, duplicate === true)
      if (result.id && data.format === 'txt') await rm(rawPath(id), { force: true }).catch(() => {})
      return result
    }),
    discard: (id, session) => exclusive(async () => {
      const data = await find(id, session)
      await library.discardImport(id)
      if (data.format === 'txt') await rm(rawPath(id), { force: true }).catch(() => {})
    }),
  }
}
