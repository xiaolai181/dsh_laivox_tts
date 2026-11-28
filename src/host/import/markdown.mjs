import { findLocalCuts, materializeChapters } from './chapters.mjs'

const ENCODINGS = ['utf-8', 'utf-16le', 'utf-16be', 'gb18030', 'big5']

function decodeText(bytes, encoding) {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) }
  catch { throw new Error('IMPORT_ENCODING_INVALID') }
}

function detectEncoding(bytes) {
  const bom = bytes.subarray(0, 3)
  if (bom[0] === 0xff && bom[1] === 0xfe) return 'utf-16le'
  if (bom[0] === 0xfe && bom[1] === 0xff) return 'utf-16be'
  const sample = bytes.subarray(0, Math.min(512, bytes.length))
  const zeros = [0, 0]
  sample.forEach((byte, index) => { if (!byte) zeros[index % 2]++ })
  if (zeros[0] > sample.length / 8 && !zeros[1]) return 'utf-16be'
  if (zeros[1] > sample.length / 8 && !zeros[0]) return 'utf-16le'
  for (const encoding of ['utf-8', 'gb18030', 'big5']) {
    try { decodeText(bytes, encoding); return encoding } catch {}
  }
  throw new Error('IMPORT_ENCODING_INVALID')
}

function stripMarkdownNoise(line) {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<https?:\/\/[^>\s]+>/giu, '')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/^\s*(?:>\s*)+/u, '')
    .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/gu, '$1')
    .trimEnd()
}

export function parseMarkdown(bytes, fallbackTitle, encoding, split = true) {
  encoding ??= detectEncoding(bytes)
  if (!ENCODINGS.includes(encoding)) throw new Error('IMPORT_ENCODING_INVALID')
  let raw = decodeText(bytes, encoding).replace(/\r\n?/g, '\n').replace(/^\uFEFF/u, '')
  if (raw.includes('\u0000')) throw new Error('IMPORT_ENCODING_INVALID')

  let title = fallbackTitle
  const fm = /^---\n([\s\S]*?)\n---\n?/u.exec(raw)
  if (fm) {
    const m = /^title\s*:\s*["']?(.+?)["']?\s*$/mu.exec(fm[1])
    if (m?.[1]?.trim()) title = m[1].trim().slice(0, 180)
    raw = raw.slice(fm[0].length)
  }

  const lines = []
  const headings = []
  let offset = 0
  let inFence = false
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    if (/^(?:```|~~~)/u.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (/^(?:[-*_]\s*){3,}$/u.test(trimmed)) {
      lines.push('')
      offset += 1
      continue
    }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(trimmed)
    if (!inFence && h) {
      const level = h[1].length
      const headingText = stripMarkdownNoise(h[2]).trim()
      if (headingText) {
        if (level === 1 || level === 2) headings.push({ offset, tag: level === 1 ? 'h1' : 'h2' })
        lines.push(headingText)
        offset += headingText.length + 1
      }
      continue
    }
    const clean = stripMarkdownNoise(rawLine)
    lines.push(clean)
    offset += clean.length + 1
  }

  const text = lines.join('\n').trim()
  if (!text) throw new Error('CHAPTER_EMPTY')

  // Adjust heading offsets if leading blank lines were trimmed.
  const leadingTrim = lines.join('\n').indexOf(text[0])
  const shiftedHeadings = leadingTrim > 0
    ? headings.map(item => ({ offset: Math.max(0, item.offset - leadingTrim), tag: item.tag }))
    : headings

  const structure = { headings: shiftedHeadings }
  let cuts = split ? findLocalCuts(text, structure) : []
  if (split && !cuts.length && shiftedHeadings.length >= 2) {
    const h1 = shiftedHeadings.filter(h => h.tag === 'h1')
    const chosen = h1.length >= 2 ? h1 : shiftedHeadings
    cuts = chosen.map(h => {
      const end = text.indexOf('\n', h.offset)
      return { offset: h.offset, title: text.slice(h.offset, end < 0 ? text.length : end).trim().slice(0, 100), kind: 'structure' }
    })
  }
  const chapters = materializeChapters(text, cuts, title)
  return { title, chapters, format: 'md', encoding, split, cuts, structure }
}
