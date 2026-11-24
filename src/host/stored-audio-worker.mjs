import { parentPort } from 'node:worker_threads'
import { MPEGDecoder } from 'mpg123-decoder'
import { measureTrim } from './stored-audio-align.mjs'

const RATES = new Set([22050, 24000])
let Encoder

function copyBytes(bytes) {
  const output = new Uint8Array(bytes.length)
  output.set(bytes)
  return output
}

async function encoderClass() {
  if (Encoder) return Encoder
  const module = await import('@breezystack/lamejs')
  Encoder = module.Mp3Encoder ?? module.default?.Mp3Encoder
  if (typeof Encoder !== 'function') throw new Error('MP3_ENCODER_UNAVAILABLE')
  return Encoder
}

async function roundtrip(pcm, rate) {
  if (!RATES.has(rate) || !(pcm instanceof Int16Array) || !pcm.length) throw new Error('MP3_UNSUPPORTED_FORMAT')
  const EncoderClass = await encoderClass()
  const encoder = new EncoderClass(1, rate, 64)
  const mp3 = copyBytes(Buffer.concat([Buffer.from(encoder.encodeBuffer(pcm)), Buffer.from(encoder.flush())]))
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    const result = decoder.decode(mp3)
    if (result.errors.length || result.sampleRate !== rate || ![1, 2].includes(result.channelData.length)) throw new Error('STORED_AUDIO_DECODE_FAILED')
    const trimStart = measureTrim(pcm, result.channelData[0])
    if (trimStart == null) throw new Error('STORED_AUDIO_ALIGN_FAILED')
    return { mp3, trimStart }
  } finally {
    decoder.free()
  }
}

parentPort.on('message', async message => {
  const { id } = message
  try {
    if (message.type !== 'roundtrip') throw new Error('INVALID_INPUT')
    const result = await roundtrip(message.pcm, message.rate)
    parentPort.postMessage({ id, ...result }, [result.mp3.buffer])
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message ?? 'MP3_ENCODER_FAILED' })
  }
})
