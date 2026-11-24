import { crc32 } from 'node:zlib'

const LOCAL = 0x04034b50
const CENTRAL = 0x02014b50
const END = 0x06054b50
const DESCRIPTOR = 0x08074b50
// bit 3: sizes and CRC follow the data; bit 11: UTF-8 names.
const FLAGS = 0x0008 | 0x0800
const VERSION = 20
const LIMIT = 0xffffffff
export const ZIP_LIMIT = LIMIT
const ENTRIES = 0xffff

function stamp(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function localHeader(name, { time, day }) {
  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL, 0)
  header.writeUInt16LE(VERSION, 4)
  header.writeUInt16LE(FLAGS, 6)
  header.writeUInt16LE(0, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(day, 12)
  header.writeUInt32LE(0, 14)
  header.writeUInt32LE(0, 18)
  header.writeUInt32LE(0, 22)
  header.writeUInt16LE(name.length, 26)
  header.writeUInt16LE(0, 28)
  return Buffer.concat([header, name])
}

function dataDescriptor(checksum, size) {
  const descriptor = Buffer.alloc(16)
  descriptor.writeUInt32LE(DESCRIPTOR, 0)
  descriptor.writeUInt32LE(checksum, 4)
  descriptor.writeUInt32LE(size, 8)
  descriptor.writeUInt32LE(size, 12)
  return descriptor
}

function centralHeader({ name, checksum, size, offset }, { time, day }) {
  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL, 0)
  header.writeUInt16LE(VERSION, 4)
  header.writeUInt16LE(VERSION, 6)
  header.writeUInt16LE(FLAGS, 8)
  header.writeUInt16LE(0, 10)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(day, 14)
  header.writeUInt32LE(checksum, 16)
  header.writeUInt32LE(size, 20)
  header.writeUInt32LE(size, 24)
  header.writeUInt16LE(name.length, 28)
  header.writeUInt16LE(0, 30)
  header.writeUInt16LE(0, 32)
  header.writeUInt16LE(0, 34)
  header.writeUInt16LE(0, 36)
  header.writeUInt32LE(0, 38)
  header.writeUInt32LE(offset, 42)
  return Buffer.concat([header, name])
}

function endRecord(count, size, offset) {
  const record = Buffer.alloc(22)
  record.writeUInt32LE(END, 0)
  record.writeUInt16LE(0, 4)
  record.writeUInt16LE(0, 6)
  record.writeUInt16LE(count, 8)
  record.writeUInt16LE(count, 10)
  record.writeUInt32LE(size, 12)
  record.writeUInt32LE(offset, 16)
  record.writeUInt16LE(0, 20)
  return record
}

async function* chunksOf(content) {
  if (Buffer.isBuffer(content)) { yield content; return }
  if (typeof content === 'string') { yield Buffer.from(content); return }
  if (content instanceof Uint8Array) { yield Buffer.from(content.buffer, content.byteOffset, content.byteLength); return }
  if (!content || typeof content[Symbol.asyncIterator] !== 'function') throw new Error('INVALID_INPUT')
  for await (const chunk of content) {
    if (Buffer.isBuffer(chunk)) yield chunk
    else if (typeof chunk === 'string') yield Buffer.from(chunk)
    else if (chunk instanceof Uint8Array) yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    else throw new Error('INVALID_INPUT')
  }
}

async function* archive(entries) {
  if (entries.length > ENTRIES) throw new Error('ZIP_TOO_LARGE')
  const date = stamp()
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(String(entry?.name ?? ''), 'utf8')
    if (!name.length || name.length > 0xffff) throw new Error('INVALID_INPUT')
    const localOffset = offset
    const header = localHeader(name, date)
    yield header
    offset += header.length
    let checksum = 0
    let size = 0
    for await (const chunk of chunksOf(entry.content)) {
      if (!chunk.length) continue
      if (offset + chunk.length > LIMIT) throw new Error('ZIP_TOO_LARGE')
      checksum = crc32(chunk, checksum)
      size += chunk.length
      yield chunk
      offset += chunk.length
    }
    const descriptor = dataDescriptor(checksum, size)
    yield descriptor
    offset += descriptor.length
    central.push({ name, checksum, size, offset: localOffset })
  }
  const centralOffset = offset
  let centralSize = 0
  for (const item of central) {
    const header = centralHeader(item, date)
    yield header
    offset += header.length
    centralSize += header.length
  }
  yield endRecord(central.length, centralSize, centralOffset)
}

export function createZipStream(entries) {
  if (!Array.isArray(entries)) throw new Error('INVALID_INPUT')
  const iterator = archive(entries)[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (error) { controller.error(error) }
    },
    async cancel() { await iterator.return?.() },
  })
}
