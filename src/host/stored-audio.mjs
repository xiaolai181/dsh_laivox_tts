import { Worker } from 'node:worker_threads'
import { MPEGDecoder } from 'mpg123-decoder'
import { readWav } from './wav.mjs'
import { ARCHIVE_DELAY_FRAMES } from './stored-audio-align.mjs'

// Mono rates whose round trip has been checked with this encoder and decoder.
// Anything else is stored as the original WAV.
export const ARCHIVE_ENCODER = 'lamejs'
export const ARCHIVE_DECODER = 'mpg123-decoder'
export const COMPRESSIBLE_RATES = new Set([22050, 24000])
const MAX_WAITING = 2
const MAX_HELD_BYTES = 48 * 1024 * 1024
const ENCODE_TIMEOUT_MS = 15_000

export const compressLaivoxAudio = () => process.env.LAIVOX_STORE_WAV_ONLY !== '1'

export function logicalFrames(row) {
  if (Number.isInteger(row?.frames) && row.frames >= 0) return row.frames
  const channels = row?.channels || 1
  return Math.floor((Number(row?.bytes) || 0) / (channels * 2))
}

export function logicalPcmBytes(row) {
  return logicalFrames(row) * (row?.channels || 1) * 2
}

function pcmFrames(pcm) {
  const width = pcm.channels * 2
  if (!width || pcm.data.length % width) throw new Error('WAV_INVALID')
  return pcm.data.length / width
}

function asBuffer(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

let worker = null
let terminating = null
let sequence = 0
let disposed = false
let active = null
const waiting = []
let held = 0

function terminateWorker() {
  const current = worker
  worker = null
  if (!current) return terminating
  terminating = current.terminate().catch(() => {}).finally(() => {
    terminating = null
    schedule()
  })
  return terminating
}

function spawn() {
  const instance = new Worker(new URL('./stored-audio-worker.mjs', import.meta.url))
  instance.on('message', message => {
    if (worker !== instance || !active || active.id !== message?.id) return
    const job = active
    active = null
    clearTimeout(job.timer)
    if (message.error) job.reject(new Error(message.error))
    else job.resolve(message)
    schedule()
  })
  instance.on('error', () => {
    if (worker === instance) failActive(new Error('MP3_ENCODER_UNAVAILABLE'))
  })
  instance.on('exit', () => {
    if (worker === instance) failActive(new Error('MP3_ENCODER_UNAVAILABLE'))
  })
  worker = instance
  return instance
}

function failActive(error) {
  terminateWorker()
  const job = active
  active = null
  if (!job) return
  clearTimeout(job.timer)
  job.reject(error)
  schedule()
}

function schedule() {
  if (disposed || terminating || active || !waiting.length) return
  const job = waiting.shift()
  if (job.signal?.aborted) {
    job.reject(job.signal.reason ?? new Error('AbortError'))
    schedule()
    return
  }
  active = job
  job.timer = setTimeout(() => failActive(new Error('MP3_ENCODER_TIMEOUT')), ENCODE_TIMEOUT_MS)
  try {
    const current = worker ?? spawn()
    current.postMessage({ id: job.id, type: 'roundtrip', pcm: job.pcm, rate: job.rate }, [job.pcm.buffer])
  } catch (error) {
    active = null
    clearTimeout(job.timer)
    terminateWorker()
    job.reject(error)
    schedule()
  }
}

function enqueueRoundtrip(pcm, signal) {
  if (disposed) return Promise.reject(new Error('MP3_ENCODER_DISPOSED'))
  const bytes = pcm.data.byteLength
  if (waiting.length >= MAX_WAITING || held + bytes > MAX_HELD_BYTES) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const samples = new Int16Array(bytes / 2)
    new Uint8Array(samples.buffer).set(pcm.data)
    held += bytes
    let settled = false
    const job = { id: ++sequence, pcm: samples, rate: pcm.rate, signal, resolve, reject, timer: null }
    const finish = (error, value) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      held -= bytes
      job.pcm = null
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => {
      const reason = signal.reason ?? new Error('AbortError')
      const index = waiting.indexOf(job)
      if (index >= 0) {
        waiting.splice(index, 1)
        finish(reason)
      } else if (active === job) failActive(reason)
    }
    job.resolve = value => finish(null, value)
    job.reject = error => finish(error)
    if (signal?.aborted) {
      finish(signal.reason ?? new Error('AbortError'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    waiting.push(job)
    schedule()
  })
}

export function archiveQueueForTest() {
  return { waiting: waiting.length, active: active ? 1 : 0, held }
}

export async function disposeArchiveEncoder() {
  const error = new Error('MP3_ENCODER_DISPOSED')
  disposed = true
  const pending = waiting.splice(0)
  for (const job of pending) job.reject(error)
  failActive(error)
  await terminateWorker()
  disposed = false
}

function wavStored(pcm, originalWav, frames) {
  return { codec: 'wav', payload: asBuffer(originalWav), frames, rate: pcm.rate, channels: pcm.channels, trimStart: 0, marks: pcm.marks }
}

function pcmStored(pcm, frames) {
  return { codec: 'pcm', payload: asBuffer(pcm.data), frames, rate: pcm.rate, channels: pcm.channels, trimStart: 0, marks: pcm.marks }
}

// Encode outside the database. A full queue, a timeout, or a bad round trip
// keeps the validated WAV. Cancellation and shutdown reject instead.
export async function prepareStoredAudio(pcm, { originalWav, engine, signal, encoder, compress = compressLaivoxAudio() } = {}) {
  const frames = pcmFrames(pcm)
  if (engine !== 'laivox') return pcmStored(pcm, frames)
  if (!originalWav?.byteLength) throw new Error('WAV_INVALID')
  signal?.throwIfAborted()
  if (!compress || pcm.channels !== 1 || !COMPRESSIBLE_RATES.has(pcm.rate)) return wavStored(pcm, originalWav, frames)
  let encoded
  try {
    encoded = await (encoder ?? enqueueRoundtrip)(pcm, signal)
  } catch (error) {
    if (signal?.aborted || error?.message === 'MP3_ENCODER_DISPOSED' || error?.message === 'PLUGIN_STOPPED') throw error
    return wavStored(pcm, originalWav, frames)
  }
  if (signal?.aborted) throw signal.reason ?? new Error('AbortError')
  const mp3 = encoded?.mp3
  if (!mp3?.length || mp3.length >= originalWav.byteLength || !Number.isInteger(encoded.trimStart) || encoded.trimStart < 0) {
    return wavStored(pcm, originalWav, frames)
  }
  return { codec: 'mp3', payload: asBuffer(mp3), frames, rate: pcm.rate, channels: 1, trimStart: encoded.trimStart, marks: pcm.marks }
}

function floatToInt16(channel, start, frames) {
  const data = Buffer.alloc(frames * 2)
  for (let index = 0; index < frames; index++) {
    const sample = Math.max(-1, Math.min(1, channel[start + index] ?? 0))
    data.writeInt16LE(sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767), index * 2)
  }
  return data
}

export async function decodeStoredAudio(row, signal) {
  signal?.throwIfAborted()
  const codec = row?.codec || 'pcm'
  const payload = row?.pcm ?? row?.payload
  if (!payload) throw new Error('AUDIO_MISSING')
  if (codec === 'pcm') return asBuffer(payload)
  if (codec === 'wav') return readWav(payload).data
  if (codec !== 'mp3') throw new Error('AUDIO_CODEC_UNSUPPORTED')
  const frames = logicalFrames(row)
  const recordedTrim = row.trimStart ?? row.trim_start
  // The old heuristic stored a wrong offset for some v12 rows, but left the
  // MP3 bitstream intact. Re-read those rows at the actual archive delay.
  const trimStart = row.channels === 1 && COMPRESSIBLE_RATES.has(row.rate)
    ? ARCHIVE_DELAY_FRAMES
    : (Number.isInteger(recordedTrim) && recordedTrim >= 0 ? recordedTrim : 0)
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    signal?.throwIfAborted()
    const result = decoder.decode(asBuffer(payload))
    if (result.errors.length || result.sampleRate !== row.rate || ![1, 2].includes(result.channelData.length)) throw new Error('STORED_AUDIO_DECODE_FAILED')
    if (result.channelData[0].length < trimStart + frames) throw new Error('STORED_AUDIO_DECODE_FAILED')
    return floatToInt16(result.channelData[0], trimStart, frames)
  } finally {
    decoder.free()
  }
}
