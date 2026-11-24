import { parentPort } from 'node:worker_threads'

const RATES = new Set([8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])
let Encoder
let active

function copy(bytes) {
  const output = new Uint8Array(bytes.length)
  output.set(bytes)
  return output
}

function send(message, transfer) {
  parentPort.postMessage(message, transfer)
}

async function loadEncoder() {
  if (Encoder) return Encoder
  let module
  try { module = await import('@breezystack/lamejs') }
  catch { throw new Error('MP3_ENCODER_UNAVAILABLE') }
  Encoder = module.Mp3Encoder ?? module.default?.Mp3Encoder
  if (typeof Encoder !== 'function') throw new Error('MP3_ENCODER_UNAVAILABLE')
  return Encoder
}

parentPort.on('message', async message => {
  const { id, type } = message
  try {
    if (type === 'start') {
      const EncoderClass = await loadEncoder()
      if (!RATES.has(message.rate) || ![1, 2].includes(message.channels)) throw new Error('MP3_UNSUPPORTED_FORMAT')
      active = new EncoderClass(message.channels, message.rate, message.kbps)
      send({ id, ok: true })
    } else if (type === 'chunk') {
      if (!active) throw new Error('MP3_ENCODER_STATE')
      const bytes = copy(active.encodeBuffer(message.pcm))
      send({ id, data: bytes }, [bytes.buffer])
    } else if (type === 'flush') {
      if (!active) throw new Error('MP3_ENCODER_STATE')
      const bytes = copy(active.flush())
      active = undefined
      send({ id, data: bytes }, [bytes.buffer])
    } else if (type === 'close') {
      active = undefined
      parentPort.close()
    } else {
      throw new Error('INVALID_INPUT')
    }
  } catch (error) {
    send({ id, error: error?.message ?? 'MP3_ENCODER_FAILED' })
  }
})
