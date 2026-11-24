import { Worker } from 'node:worker_threads'

const RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])
const DEFAULT_TIMEOUT = 30_000

export const mp3RateSupported = rate => RATES.has(rate)

function toPcm(chunk) {
  const view = chunk instanceof Int16Array
    ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    : chunk instanceof Uint8Array ? chunk : null
  if (!view) throw new Error('INVALID_INPUT')
  if (view.byteLength % 2) throw new Error('INVALID_INPUT')
  // Buffers and subarrays may share a backing store: copy so the transfer is safe.
  const copy = new Uint8Array(view.byteLength)
  copy.set(view)
  return new Int16Array(copy.buffer)
}

export function createMp3Encoder({ timeout = DEFAULT_TIMEOUT } = {}) {
  let worker = null
  let sequence = 0
  let pending = new Map()
  let disposed = false
  let tail = Promise.resolve()

  function stop(error) {
    const instance = worker
    worker = null
    if (instance) {
      instance.removeAllListeners()
      void instance.terminate().catch(() => {})
    }
    for (const item of pending.values()) {
      clearTimeout(item.timer)
      item.reject(error)
    }
    pending.clear()
  }

  function spawn() {
    const instance = new Worker(new URL('./mp3-worker.mjs', import.meta.url))
    instance.on('message', message => {
      if (worker !== instance) return
      const item = pending.get(message?.id)
      if (!item) return
      pending.delete(message.id)
      clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error))
      else item.resolve(message.data)
    })
    instance.on('error', () => stop(new Error('MP3_ENCODER_UNAVAILABLE')))
    instance.on('exit', () => stop(new Error('MP3_ENCODER_UNAVAILABLE')))
    worker = instance
    return instance
  }

  function request(type, payload = {}, transfer = []) {
    if (disposed) return Promise.reject(new Error('MP3_ENCODER_DISPOSED'))
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        stop(new Error('MP3_ENCODER_TIMEOUT'))
        reject(new Error('MP3_ENCODER_TIMEOUT'))
      }, timeout)
      pending.set(id, { resolve, reject, timer })
      try { (worker ?? spawn()).postMessage({ id, type, ...payload }, transfer) }
      catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  function acquire() {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const wait = tail
    tail = wait.then(() => gate)
    return wait.then(() => release)
  }

  async function* encodePcm(rate, channels, chunks) {
    if (disposed) throw new Error('MP3_ENCODER_DISPOSED')
    if (!mp3RateSupported(rate) || ![1, 2].includes(channels)) throw new Error('MP3_UNSUPPORTED_FORMAT')
    const release = await acquire()
    try {
      await request('start', { rate, channels, kbps: channels === 2 ? 96 : 64 })
      for await (const chunk of chunks) {
        const pcm = toPcm(chunk)
        if (!pcm.length) continue
        const data = await request('chunk', { pcm }, [pcm.buffer])
        if (data?.length) yield Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      }
      const tailBytes = await request('flush')
      if (tailBytes?.length) yield Buffer.from(tailBytes.buffer, tailBytes.byteOffset, tailBytes.byteLength)
    } finally {
      release()
    }
  }

  async function dispose() {
    if (disposed) return
    disposed = true
    stop(new Error('MP3_ENCODER_DISPOSED'))
    await tail.catch(() => {})
  }

  return { encodePcm, dispose }
}

const shared = createMp3Encoder()

export function encodePcm(rate, channels, chunks) {
  return shared.encodePcm(rate, channels, chunks)
}

export function disposeMp3() {
  return shared.dispose()
}
