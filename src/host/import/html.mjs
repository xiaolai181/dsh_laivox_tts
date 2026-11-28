import { parse } from 'parse5'
import { findLocalCuts, materializeChapters } from './chapters.mjs'

const hiddenTags = new Set(['head', 'script', 'style', 'iframe', 'object', 'noscript', 'template', 'svg', 'math', 'nav', 'rt', 'rp'])
const blockTags = new Set(['p', 'div', 'section', 'article', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr', 'tr', 'pre'])

function decodeHtml(bytes) {
  try {
    let decoder = new TextDecoder('utf-8', { fatal: true })
    if (bytes[0] === 0xff && bytes[1] === 0xfe) decoder = new TextDecoder('utf-16le', { fatal: true })
    if (bytes[0] === 0xfe && bytes[1] === 0xff) decoder = new TextDecoder('utf-16be', { fatal: true })
    return decoder.decode(bytes)
  } catch {
    const head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
    if (/\bcharset\s*=\s*["']?(gbk|gb2312|gb18030)\b/iu.test(head)) {
      try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes) } catch {}
    }
    try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes) } catch {}
    throw new Error('IMPORT_ENCODING_INVALID')
  }
}

function findTitle(node, depth = 0) {
  if (!node || depth > 40) return ''
  if (node.tagName === 'title') {
    return (node.childNodes ?? []).map(c => c.value ?? '').join('').trim()
  }
  for (const child of node.childNodes ?? []) {
    const found = findTitle(child, depth + 1)
    if (found) return found
  }
  return ''
}

export function parseHtml(bytes, fallbackTitle) {
  const html = decodeHtml(bytes).replace(/^\uFEFF/u, '')
  if (html.includes('\u0000')) throw new Error('IMPORT_ENCODING_INVALID')
  const root = parse(html)
  const docTitle = findTitle(root).slice(0, 180)
  const title = docTitle || fallbackTitle

  const lines = ['']
  const markers = []
  const newline = () => lines.push('')

  function visit(node, depth) {
    if (depth > 160) return
    const tag = node.tagName
    if (hiddenTags.has(tag) || node.attrs?.some(({ name, value }) => name === 'hidden' || (name === 'aria-hidden' && value === 'true') || (name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(value)))) return
    if (node.nodeName === '#text') {
      lines[lines.length - 1] += node.value.replace(/\s+/gu, ' ')
      return
    }
    const block = blockTags.has(tag)
    if (block) newline()
    const at = lines.length - 1
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') markers.push([at, tag])
    for (const child of node.childNodes ?? []) visit(child, depth + 1)
    if (block) newline()
  }
  visit(root, 0)

  const normalized = []
  const offsets = []
  let offset = 0
  for (const line of lines) {
    const clean = line.trim()
    offsets.push(offset)
    if (clean) {
      normalized.push(clean)
      offset += clean.length + 1
    }
  }
  const text = normalized.join('\n')
  if (!text) throw new Error('CHAPTER_EMPTY')

  const headings = markers
    .map(([lineIdx, tag]) => ({ offset: offsets[lineIdx], tag }))
    .filter(item => Number.isInteger(item.offset) && item.offset < text.length)
  const structure = { headings }
  let cuts = findLocalCuts(text, structure)
  if (!cuts.length && headings.length >= 2) {
    const h1 = headings.filter(h => h.tag === 'h1')
    const chosen = h1.length >= 2 ? h1 : headings.filter(h => h.tag === 'h1' || h.tag === 'h2')
    cuts = chosen.map(h => {
      const end = text.indexOf('\n', h.offset)
      return { offset: h.offset, title: text.slice(h.offset, end < 0 ? text.length : end).trim().slice(0, 100), kind: 'structure' }
    })
  }
  const chapters = materializeChapters(text, cuts, title)
  return { title, chapters, format: 'html', encoding: 'utf-8', split: true, cuts, structure }
}
