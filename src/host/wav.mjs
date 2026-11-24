import { MPEGDecoder } from 'mpg123-decoder'

// RIFF chunks: "fmt " and "data" are read; any other chunk is skipped.
export function readWav(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('WAV_INVALID')
  let fmt
  let data
  for (let offset = 12; offset + 8 <= buf.length;) {
    const tag = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (start + size > buf.length) throw new Error('WAV_TRUNCATED')
    if (tag === 'fmt ') {
      if (size < 16 || buf.readUInt16LE(start) !== 1 || buf.readUInt16LE(start + 14) !== 16) throw new Error('WAV_UNSUPPORTED')
      fmt = { channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4) }
    }
    if (tag === 'data') data = buf.subarray(start, start + size)
    offset = start + size + size % 2
  }
  if (!fmt || ![1, 2].includes(fmt.channels) || !fmt.rate || !data?.length || data.length % (fmt.channels * 2)) throw new Error('WAV_INVALID')
  return { ...fmt, data }
}

export function wavHeader(bytes, rate, channels) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + bytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * channels * 2, 28)
  header.writeUInt16LE(channels * 2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(bytes, 40)
  return header
}

export function encodeWav(data, rate, channels) {
  return Buffer.concat([wavHeader(data.length, rate, channels), data])
}

export async function decodeEdgeWav(mp3) {
  const decoder = new MPEGDecoder()
  await decoder.ready
  try {
    const result = decoder.decode(mp3)
    if (result.errors.length || !result.samplesDecoded || result.sampleRate !== 24000 || ![1, 2].includes(result.channelData.length) || result.channelData.some(channel => channel.length !== result.samplesDecoded)) throw new Error('EDGE_AUDIO_DECODE_FAILED')
    const data = Buffer.alloc(result.samplesDecoded * 2)
    for (let i = 0; i < result.samplesDecoded; i++) {
      const left = result.channelData[0][i]
      const right = result.channelData[1]?.[i] ?? left
      const sample = Math.min(1, Math.max(-1, (left + right) * 0.5))
      data.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), i * 2)
    }
    return encodeWav(data, result.sampleRate, 1)
  } finally {
    decoder.free()
  }
}

export function concatWav(parts) {
  if (!parts.length) throw new Error('WAV_EMPTY')
  const decoded = parts.map(readWav)
  const first = decoded[0]
  if (decoded.some(part => part.rate !== first.rate || part.channels !== first.channels)) throw new Error('WAV_FORMAT_MISMATCH')
  return encodeWav(Buffer.concat(decoded.map(part => part.data)), first.rate, first.channels)
}
