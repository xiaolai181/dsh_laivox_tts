// Instant speech: read a chat message or a tool's text aloud with Edge.
// Nothing is stored: parts are synthesized on request (one at a time, the
// current reading first), kept in a small in-memory cache and served as MP3.
// It never touches the job queue, so it neither waits behind nor pauses a book.
import { randomBytes } from 'node:crypto'
import { edgeVoices } from './edge.mjs'
import { speakableText, speechLanguage, speechParts } from './speech-text.mjs'

export const SPEECH_CACHE_BYTES = 32 * 1024 * 1024
export const SPEECH_RECORDS = 50
export const SPEECH_RETRY_WAITS = [500, 1500]
export const defaultSpeechVoices = { 'zh-CN': 'zh-CN-XiaoxiaoNeural', 'zh-TW': 'zh-TW-HsiaoChenNeural', en: 'en-US-AriaNeural' }

const abortError = () => new DOMException('The speech was stopped.', 'AbortError')
const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
})

export function createSpeechService({ synthesize, voices = async () => defaultSpeechVoices, warm, retryWaits = SPEECH_RETRY_WAITS,
  cacheBytes = SPEECH_CACHE_BYTES, records = SPEECH_RECORDS } = {}) {
  const speeches = new Map()
  const cache = new Map()
  let cached = 0
  const tasks = new Map()
  let running = null
  const currents = new Map()
  const claims = new Map()
  let disposed = false
  const latestBySession = new Map()

  const keyOf = (voice, text) => voice + '|' + text

  function remember(key, audio) {
    if (cache.has(key)) { cached -= cache.get(key).length; cache.delete(key) }
    if (audio.length > cacheBytes) return
    cache.set(key, audio)
    cached += audio.length
    for (const [oldest, value] of cache) {
      if (cached <= cacheBytes) break
      cache.delete(oldest)
      cached -= value.length
    }
  }
  function recall(key) {
    const audio = cache.get(key)
    if (!audio) return null
    cache.delete(key)
    cache.set(key, audio)
    return audio
  }

  async function attempt(task) {
    for (let index = 0; ; index++) {
      task.controller.signal.throwIfAborted()
      try { return await synthesize({ text: task.text, voiceId: task.voice }, task.controller.signal) }
      catch (error) {
        task.controller.signal.throwIfAborted()
        const final = index >= retryWaits.length || ['EDGE_EMPTY_AUDIO', 'EDGE_INVALID_TEXT', 'EDGE_INVALID_VOICE', 'PLUGIN_STOPPED'].includes(error?.message)
        if (final) throw error
        await wait(retryWaits[index], task.controller.signal)
      }
    }
  }

  // One synthesis at a time: parts of the newest reading first, lowest part first.
  function pump() {
    if (running || disposed) return
    let next = null
    for (const task of tasks.values()) {
      if (task.started) continue
      const rank = task => [task.speeches.has(current?.id) ? 0 : 1, task.n]
      if (!next) { next = task; continue }
      const [a, b] = [rank(task), rank(next)]
      if (a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])) next = task
    }
    if (!next) return
    running = next
    next.started = true
    attempt(next).then(audio => {
      remember(next.key, audio)
      settle(next, waiter => waiter.resolve(audio))
    }, error => settle(next, waiter => waiter.reject(error))).finally(() => {
      if (running === next) running = null
      pump()
    })
  }
  function settle(task, apply) {
    if (tasks.get(task.key) === task) tasks.delete(task.key)
    for (const waiter of task.waiters) { waiter.cleanup(); apply(waiter) }
    task.waiters.clear()
  }
  // A task nobody waits for any more (its reading was cancelled) is dropped.
  function release(task) {
    if (task.waiters.size || task.keep.size) return
    if (tasks.get(task.key) === task) tasks.delete(task.key)
    task.controller.abort(abortError())
  }

  // Audio for one part, shared by everyone asking for the same text and voice.
  function audioFor(speech, n, signal, keep = false) {
    const text = speech.parts[n]
    const key = keyOf(speech.voice, text)
    const hit = recall(key)
    if (hit) return Promise.resolve(hit)
    let task = tasks.get(key)
    if (!task) {
      task = { key, text, voice: speech.voice, n, speeches: new Set(), waiters: new Set(), keep: new Set(), controller: new AbortController(), started: false }
      tasks.set(key, task)
    }
    task.speeches.add(speech.id)
    task.n = Math.min(task.n, n)
    if (keep) { task.keep.add(speech.id); speech.tasks.add(task) }
    const pending = new Promise((resolve, reject) => {
      if (!signal) { pump(); resolve(null); return }
      const waiter = { resolve, reject, cleanup: () => signal.removeEventListener('abort', onAbort) }
      function onAbort() {
        task.waiters.delete(waiter)
        waiter.cleanup()
        reject(signal.reason ?? abortError())
        release(task)
      }
      if (signal.aborted) { reject(signal.reason ?? abortError()); return }
      signal.addEventListener('abort', onAbort, { once: true })
      task.waiters.add(waiter)
      speech.tasks.add(task)
      pump()
    })
    return pending
  }

  function cancelSpeech(speech) {
    if (!speech || speech.cancelled) return
    speech.cancelled = true
    for (const task of speech.tasks) {
      task.keep.delete(speech.id)
      task.speeches.delete(speech.id)
      if (!task.speeches.size) {
        for (const waiter of task.waiters) { waiter.cleanup(); waiter.reject(abortError()) }
        task.waiters.clear()
        release(task)
      }
    }
    speech.tasks.clear()
    for (const [owner, active] of currents) if (active === speech) currents.delete(owner)
  }

  return {
    // Accept a text, cancel whatever was being read, and start the first parts.
    // `announce` (tool calls only) lists the reading on the session board, so the
    // chat page can play it even if it missed the tool card.
    claim(speechId, page) {
      if (typeof speechId !== 'string' || !speechId || typeof page !== 'string' || !page) throw new Error('INVALID_INPUT')
      const now = Date.now()
      for (const [id, row] of claims) if (now - row.at > 10 * 60 * 1000) claims.delete(id)
      const existing = claims.get(speechId)
      if (existing && now - existing.at <= 10 * 60 * 1000) return { ok: existing.page === page }
      claims.set(speechId, { page, at: now })
      return { ok: true }
    },
    async start({ text, voice, session, announce = false, owner } = {}) {
      if (disposed) throw new Error('PLUGIN_STOPPED')
      // Longer texts are cut to SPEECH_TEXT_LIMIT characters (reported as truncated).
      if (typeof text !== 'string' || !text.trim() || text.length > 1_000_000) throw new Error('INVALID_INPUT')
      if (voice != null && !edgeVoices.some(item => item.id === voice)) throw new Error('EDGE_INVALID_VOICE')
      const plain = speakableText(text)
      const parts = speechParts(plain.text)
      if (!parts.length) throw new Error('SPEECH_EMPTY')
      const chosen = voice ?? ((await voices())?.[speechLanguage(plain.text)] ?? defaultSpeechVoices[speechLanguage(plain.text)])
      const speech = { id: randomBytes(9).toString('base64url'), voice: chosen, parts, created: Date.now(), session: session ?? null,
        characters: [...plain.text].length, truncated: plain.truncated, cancelled: false, tasks: new Set() }
      const ownerKey = typeof owner === 'string' && owner ? owner : ''
      speech.owner = ownerKey
      cancelSpeech(currents.get(ownerKey))
      currents.set(ownerKey, speech)
      speeches.set(speech.id, speech)
      while (speeches.size > records) {
        const [oldest, old] = speeches.entries().next().value
        cancelSpeech(old)
        speeches.delete(oldest)
      }
      if (speech.session && announce) {
        latestBySession.delete(speech.session)
        latestBySession.set(speech.session, { id: speech.id, parts: parts.length, created: speech.created })
        if (latestBySession.size > records) latestBySession.delete(latestBySession.keys().next().value)
      }
      // Synthesis starts now: by the time the browser asks, part 0 is on its way.
      for (const n of [0, 1]) if (n < parts.length) void audioFor(speech, n, null, true)
      return { speechId: speech.id, parts: parts.length, characters: speech.characters, voice: chosen, truncated: speech.truncated }
    },
    // MP3 of part n; waits for the synthesis (bounded by the request's signal).
    async part(id, n, signal) {
      const speech = speeches.get(id)
      if (!speech) throw new Error('SPEECH_EXPIRED')
      if (!Number.isInteger(n) || n < 0 || n >= speech.parts.length) throw new Error('INVALID_INPUT')
      const hit = recall(keyOf(speech.voice, speech.parts[n]))
      if (hit) return hit
      if (speech.cancelled) throw new Error('SPEECH_EXPIRED')
      return audioFor(speech, n, signal ?? new AbortController().signal)
    },
    cancel(id) {
      const speech = speeches.get(id)
      if (speech) cancelSpeech(speech)
      return { cancelled: Boolean(speech) }
    },
    // The newest reading started in a session (the chat page's fallback for
    // tool cards it did not see arrive).
    latest: session => latestBySession.get(session) ?? null,
    // Connect ahead of a click for the voice this text would use.
    async warmFor(text) {
      if (!warm || disposed || typeof text !== 'string' || !text.trim()) return
      const language = speechLanguage(speakableText(text.slice(0, 2000)).text)
      const voice = (await voices())?.[language] ?? defaultSpeechVoices[language]
      if (edgeVoices.some(item => item.id === voice)) warm(voice)
    },
    dispose() {
      disposed = true
      for (const speech of speeches.values()) cancelSpeech(speech)
      for (const task of tasks.values()) task.controller.abort(abortError())
      speeches.clear(); tasks.clear(); cache.clear(); cached = 0; latestBySession.clear()
    },
    stats: () => ({ speeches: speeches.size, cachedBytes: cached, tasks: tasks.size, running: Boolean(running) }),
  }
}
