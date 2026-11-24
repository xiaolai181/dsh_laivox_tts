import { edgeVoices, synthesizeEdge } from './edge.mjs'
import { decodeEdgeWav, readWav } from './wav.mjs'
import { laivoxPreview } from './engines/index.mjs'

const byteLimit = 16 * 1024 ** 2

// gatewayFor (optional) lets LaiVox previews come from the gateway when a key is saved;
// without it, or without a key, the samples shipped with the plugin are used.
export function createVoicePreviewService({ synthesize = synthesizeEdge, decode = decodeEdgeWav, gatewayFor } = {}) {
  let active
  let disposed = false
  let bytes = 0
  const cache = new Map()

  function remember(id, wav) {
    if (disposed || wav.length > byteLimit) return
    while (bytes + wav.length > byteLimit) {
      const key = cache.keys().next().value
      bytes -= cache.get(key).length
      cache.delete(key)
    }
    cache.set(id, wav)
    bytes += wav.length
  }

  function subscribe(flight, signal) {
    return new Promise((resolve, reject) => {
      flight.waiters++
      function release() {
        signal.removeEventListener('abort', abort)
        flight.waiters--
        if (!flight.waiters && !flight.settled) flight.controller.abort()
      }
      function abort() { release(); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      flight.promise.then(wav => {
        if (!signal.aborted) { release(); resolve(wav) }
      }, error => {
        if (!signal.aborted) { release(); reject(error) }
      })
    })
  }

  return {
    async load(engine, voice, signal = new AbortController().signal) {
      signal.throwIfAborted()
      if (disposed) throw new Error('PLUGIN_STOPPED')
      if (engine === 'laivox') return laivoxPreview(voice, signal, { gatewayFor })
      if (engine !== 'edge' || !edgeVoices.some(item => item.id === voice)) throw new Error('VOICE_PREVIEW_NOT_FOUND')
      if (cache.has(voice)) {
        const wav = cache.get(voice)
        cache.delete(voice)
        cache.set(voice, wav)
        return wav
      }
      if (active && (active.voice !== voice || active.controller.signal.aborted)) throw new Error('VOICE_PREVIEW_BUSY')
      if (!active) {
        const controller = new AbortController()
        const flight = { voice, controller, waiters: 0, settled: false }
        active = flight
        const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(24_000)])
        const text = voice.startsWith('en-') ? 'The rain is still falling softly outside the window.'
          : voice.startsWith('zh-TW-') ? '夜深了，窗外的雨還在輕輕地下。' : '夜深了，窗外的雨还在轻轻地下。'
        flight.promise = (async () => {
          const wav = await decode(await synthesize({ text, voiceId: voice }, deadline))
          deadline.throwIfAborted()
          readWav(wav)
          remember(voice, wav)
          return wav
        })().finally(() => {
          flight.settled = true
          active = undefined
        })
      }
      return subscribe(active, signal)
    },
    async dispose() {
      disposed = true
      active?.controller.abort()
      await active?.promise.catch(() => {})
      cache.clear()
      bytes = 0
    },
  }
}
