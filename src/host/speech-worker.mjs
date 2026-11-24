// Resident Edge worker for instant speech. Unlike edge-worker.mjs (one
// process per part, used by book production), this one stays up and keeps one
// Edge connection per voice open: connecting costs 1.1–1.7 s, a request on an
// open connection gets its first audio in about 0.3 s (measured).
// It talks to the parent over IPC: { type: 'synthesize', id, text, voiceId,
// prosody } / { type: 'cancel', id } / { type: 'warm', voiceId } in,
// { type: 'audio', id, data } / { type: 'error', id, code, detail } out.
import { MsEdgeTTS, OUTPUT_FORMAT } from './msedge.mjs'
import { escapeSSML } from './text.mjs'

const MAX_ENGINES = 3
const IDLE_EXIT = Number(process.env.LAIVOX_SPEECH_IDLE_MS) || 60_000
const FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
const engines = new Map()
const running = new Map()
let idleTimer

function touchIdle() {
  clearTimeout(idleTimer)
  // Leaves on its own when unused; the parent starts it again on demand.
  idleTimer = setTimeout(() => { if (!running.size) shutdown() }, IDLE_EXIT)
  idleTimer.unref?.()
}

function shutdown() {
  for (const { engine } of engines.values()) { try { engine.close() } catch { /* already closed */ } }
  engines.clear()
  process.exit(0)
}

// One engine per voice: changing an engine's voice reconnects anyway.
async function engineFor(voiceId) {
  let entry = engines.get(voiceId)
  if (entry) { engines.delete(voiceId); engines.set(voiceId, entry); return entry.ready }
  while (engines.size >= MAX_ENGINES) {
    const [oldest, old] = engines.entries().next().value
    engines.delete(oldest)
    try { old.engine.close() } catch { /* already closed */ }
  }
  const engine = new MsEdgeTTS({ connectionTimeoutMs: 10_000, synthesisTimeoutMs: 15_000 })
  entry = { engine, ready: engine.setMetadata(voiceId, FORMAT, { voiceLocale: voiceId.slice(0, 5) }).then(() => engine) }
  engines.set(voiceId, entry)
  entry.ready.catch(() => { if (engines.get(voiceId) === entry) engines.delete(voiceId) })
  return entry.ready
}

// A failed engine is dropped, so the next request connects afresh.
function retire(voiceId) {
  const entry = engines.get(voiceId)
  if (!entry) return
  engines.delete(voiceId)
  try { entry.engine.close() } catch { /* already closed */ }
}

async function synthesize({ id, text, voiceId, prosody }) {
  const state = { cancelled: false, stream: null }
  running.set(id, state)
  try {
    const engine = await engineFor(voiceId)
    if (state.cancelled) return
    const { audioStream } = engine.toStream(escapeSSML(text), prosody)
    state.stream = audioStream
    const chunks = []
    let size = 0
    for await (const chunk of audioStream) {
      size += chunk.length
      if (size > 8 * 1024 * 1024) throw Object.assign(new Error('audio too large'), { code: 'EDGE_AUDIO_TOO_LARGE' })
      chunks.push(chunk)
    }
    if (state.cancelled) return
    if (!size) throw Object.assign(new Error('Edge returned no audio chunks'), { code: 'EDGE_EMPTY_AUDIO' })
    process.send({ type: 'audio', id, data: Buffer.concat(chunks) })
  } catch (error) {
    if (state.cancelled) return
    if (error?.code !== 'EDGE_EMPTY_AUDIO') retire(voiceId)
    const timeout = /timed out/u.test(String(error?.message))
    process.send({ type: 'error', id, code: error?.code ?? (timeout ? 'EDGE_TIMEOUT' : 'EDGE_UNAVAILABLE'),
      detail: String(error?.message ?? error).slice(0, 600) })
  } finally {
    running.delete(id)
    touchIdle()
  }
}

process.on('message', message => {
  if (!message || typeof message !== 'object') return
  touchIdle()
  if (message.type === 'synthesize') void synthesize(message)
  else if (message.type === 'warm') void engineFor(message.voiceId).catch(() => {})
  else if (message.type === 'cancel') {
    const state = running.get(message.id)
    if (!state) return
    state.cancelled = true
    state.stream?.destroy()
  }
})
// The parent went away: nothing can use the audio any more.
process.on('disconnect', shutdown)
touchIdle()
