// What instant speech reads aloud: prose without closed code fences or
// link addresses. Table cells, image descriptions and placeholder names are
// kept. Also the language, and the parts it is synthesized in. The first part
// is short so the first audio comes soon.
import { hasSpeakable, segmentChapter } from '../domain/segment.mjs'
import { scriptVariant } from './text.mjs'

export const SPEECH_TEXT_LIMIT = 20_000
export const FIRST_PART_LIMIT = 60
export const PART_LIMIT = 300

const tableRow = /^\s*\|.*\|\s*$/u
const tableRule = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u
const alnum = /[\p{L}\p{N}]/u
const presentational = new Set(['a', 'b', 'i', 'em', 'strong', 'br', 'p', 'div', 'span', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'script', 'style'])

// Closed fences are dropped. A fence closes only on the same character, with at
// least as many of them, and nothing else on the line. An unclosed fence is
// ordinary text, so the words after a missing closer are not lost.
function stripFences(text) {
  const lines = text.split('\n')
  const out = []
  let fence = null
  let hidden = []
  for (const line of lines) {
    const marks = line.match(/^[ \t]*([`~]+)/u)
    if (!fence) {
      if (marks && marks[1].length >= 3) {
        fence = { char: marks[1][0], length: marks[1].length }
        hidden = [line]
      } else out.push(line)
      continue
    }
    if (marks && marks[1][0] === fence.char && marks[1].length >= fence.length && line.trim() === marks[1]) {
      fence = null
      hidden = []
      continue
    }
    hidden.push(line)
  }
  if (fence) out.push(...hidden)
  return out.join('\n')
}

// Separator rows go away. A row's cells are read; a line that is not a row stays.
function speakTableLine(line) {
  if (tableRule.test(line)) return null
  if (!tableRow.test(line)) return line
  const cells = line.split('|').map(cell => cell.trim()).filter(Boolean)
  return cells.length ? cells.join(', ') : null
}

function padSpoken(spoken, before, after) {
  const trimmed = spoken.trim()
  if (!trimmed) return ''
  const prefix = before && alnum.test(before) && alnum.test(trimmed[0]) ? ' ' : ''
  const suffix = after && alnum.test(after) && alnum.test(trimmed[trimmed.length - 1]) ? ' ' : ''
  return prefix + trimmed + suffix
}

// One tag starting at `<`, or null. A failed look-ahead stops at the first
// character that cannot belong to a tag; the caller emits that `<` and resumes.
function readTag(text, start) {
  let j = start + 1
  if (j >= text.length) return null
  const closing = text[j] === '/'
  if (closing) j++
  if (j >= text.length || !/[A-Za-z]/u.test(text[j])) return null
  const nameStart = j
  j++
  while (j < text.length && /[A-Za-z0-9:-]/u.test(text[j])) j++
  const rawName = text.slice(nameStart, j)
  const name = rawName.toLowerCase()
  let alt = null
  let closed = false
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\n' || ch === '\r') return null
    if (ch === '>') { j++; closed = true; break }
    if (ch === '/' && text[j + 1] === '>') { j += 2; closed = true; break }
    if (ch === ' ' || ch === '\t' || ch === '\f') { j++; continue }
    if (ch === '<' || ch.charCodeAt(0) > 0x7f || !/[A-Za-z_:]/u.test(ch)) return null
    const attrStart = j
    j++
    while (j < text.length && /[A-Za-z0-9_:.-]/u.test(text[j])) j++
    const attr = text.slice(attrStart, j).toLowerCase()
    while (text[j] === ' ' || text[j] === '\t') j++
    if (text[j] !== '=') continue
    j++
    while (text[j] === ' ' || text[j] === '\t') j++
    let value = ''
    if (text[j] === '"' || text[j] === "'") {
      const quote = text[j++]
      const valueStart = j
      while (j < text.length && text[j] !== quote && text[j] !== '\n' && text[j] !== '\r') j++
      if (text[j] !== quote) return null
      value = text.slice(valueStart, j)
      j++
    } else {
      const valueStart = j
      while (j < text.length) {
        const valueChar = text[j]
        if (valueChar === '>' || valueChar === ' ' || valueChar === '\t' || valueChar === '\n' || valueChar === '\r' || valueChar === '<') break
        if (valueChar.charCodeAt(0) > 0x7f) return null
        j++
      }
      if (j === valueStart) return null
      value = text.slice(valueStart, j)
    }
    if (attr === 'alt' && alt == null) alt = value
  }
  if (!closed) return null
  const spoken = closing ? '' : name === 'img' ? (alt ?? '') : presentational.has(name) ? '' : rawName
  return { end: j, replacement: spoken }
}

function stripTags(text) {
  const out = []
  let last = ''
  const push = value => {
    if (!value) return
    out.push(value)
    last = value[value.length - 1]
  }
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '<') { push(text[i]); continue }
    const tag = readTag(text, i)
    if (!tag) { push('<'); continue }
    push(padSpoken(tag.replacement, last, text[tag.end] ?? ''))
    i = tag.end - 1
  }
  return out.join('')
}

export function speakableText(markdown) {
  let text = stripFences(String(markdown ?? '').replace(/\r\n?/gu, '\n'))
  text = text.split('\n').flatMap(line => {
    const spoken = speakTableLine(line)
    return spoken == null ? [] : [spoken]
  }).join('\n')
  text = text
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/gu, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/gu, '$1')
    .replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gmu, '')
  text = stripTags(text)
  text = text
    .replace(/\bhttps?:\/\/\S+/giu, '')
    .replace(/`([^`\n]*)`/gu, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gmu, '')
    .replace(/^\s{0,3}>\s?/gmu, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gmu, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gmu, '')
    .replace(/(\*\*|__|~~)(.+?)\1/gu, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/gu, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/gu, '$1$2')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  const chars = [...text]
  const truncated = chars.length > SPEECH_TEXT_LIMIT
  return { text: truncated ? chars.slice(0, SPEECH_TEXT_LIMIT).join('') : text, truncated }
}

// English when there is no CJK, or Latin words outnumber CJK characters two to
// one. A Chinese voice can read the English words; an English voice cannot read
// the Chinese. An empty string stays Chinese, matching the previous default.
export function speechLanguage(text) {
  const value = String(text ?? '').replace(/&(?:#\d+|\w+);/gu, '')
  if (!value.trim()) return 'zh-CN'
  const latin = value.match(/[A-Za-z]+/gu)?.length ?? 0
  const cjk = value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0
  if (cjk === 0 || latin > 2 * cjk) return 'en'
  return scriptVariant(value) === 'Hant' ? 'zh-TW' : 'zh-CN'
}

// The first `limit` characters, ended at a pause (comma, colon, space) when one
// falls in the second half; otherwise a hard cut.
function cut(chars, limit) {
  let end = limit
  while (end > limit / 2 && !/[，、；：,;:\s]/u.test(chars[end - 1])) end--
  return end <= limit / 2 ? limit : end
}

// Sentences (the chapter segmentation) joined into parts: the first at most 60
// characters, the rest at most 300 (Edge accepts 500). Sentences from different
// lines are joined with a line break. Parts with nothing to pronounce are
// dropped; they would come back from Edge as empty audio.
export function speechParts(text) {
  const parts = []
  let current = []
  let lastLine = null
  const limit = () => parts.length ? PART_LIMIT : FIRST_PART_LIMIT
  for (const sentence of segmentChapter(String(text ?? ''))) {
    const words = sentence.text.trim()
    if (!words) continue
    let chars = [...(current.length && sentence.line !== lastLine ? '\n' : '') + words]
    lastLine = sentence.line
    while (chars.length) {
      const room = limit() - current.length
      if (chars.length <= room) { current.push(...chars); break }
      if (current.length) { parts.push(current.join('').trim()); current = []; chars = [...chars.join('').trimStart()]; continue }
      const end = cut(chars, limit())
      parts.push(chars.slice(0, end).join('').trim())
      chars = chars.slice(end)
    }
  }
  if (current.length) parts.push(current.join('').trim())
  return parts.filter(hasSpeakable)
}
