import { findLocalCuts, materializeChapters } from './chapters.mjs'

export const TXT_ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5']

function decode(bytes, encoding) {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new Error('IMPORT_ENCODING_INVALID') }
}

function recommend(bytes) {
  const bom = bytes.subarray(0, 3)
  if (bom[0] === 0xff && bom[1] === 0xfe) return 'utf-16le'
  if (bom[0] === 0xfe && bom[1] === 0xff) return 'utf-16be'
  const sample = bytes.subarray(0, Math.min(512, bytes.length))
  const zeros = [0, 0]
  sample.forEach((byte, index) => { if (!byte) zeros[index % 2]++ })
  if (zeros[0] > sample.length / 8 && !zeros[1]) return 'utf-16be'
  if (zeros[1] > sample.length / 8 && !zeros[0]) return 'utf-16le'
  for (const encoding of ['utf-8', 'gb18030', 'big5']) {
    try { decode(bytes, encoding); return encoding } catch {}
  }
  throw new Error('IMPORT_ENCODING_INVALID')
}

export function parseTxt(bytes, title, encoding, split = true) {
  encoding ??= recommend(bytes)
  if (!TXT_ENCODINGS.includes(encoding)) throw new Error('IMPORT_ENCODING_INVALID')
  const text = decode(bytes, encoding).replace(/\r\n?/g, '\n').replace(/^\uFEFF/u, '')
  if (text.includes('\u0000')) throw new Error('IMPORT_ENCODING_INVALID')
  const structure = {}
  const cuts = split ? findLocalCuts(text, structure) : []
  const chapters = materializeChapters(text, cuts, title)
  return { title, chapters, format: 'txt', encoding, split, cuts, structure }
}
