export const SEGMENT_VERSION = 2
export const segmentVersion = editorial => editorial ? (editorial.version ?? 1) : SEGMENT_VERSION
const sentences = new Intl.Segmenter('zh', { granularity: 'sentence' })
const softStop = /[；;：:，、,—\s]/u
const dialogue = /^[「『“‘"']/u
const closers = { '「': '」', '『': '』', '“': '”' }
const separator = /^(?:[-‐‑‒–—―−－─━_=＝*＊~～·•⋯…]\s*){3,}$/u

export function isSeparator(text) {
  return separator.test(text.trim())
}

// Edge keeps the connection open, answers with an empty turn and returns no
// audio at all for text that has nothing to pronounce. That is not an outage,
// so such a part must never reach the online service. A separator is only one
// example: decorative glyphs (※☆◆〓), lone punctuation (……「」) and bare dashes
// behave the same way. Letters and numbers cover every script Edge can read.
export function hasSpeakable(text) {
  return /[\p{L}\p{N}]/u.test(String(text ?? ''))
}

// Complete quotations, matched exactly like /「[^」]*」|『[^』]*』|“[^”]*”/gu: an
// opener runs to the first matching closer after it. The regex rescans the rest
// of the line for every unclosed opener, which is quadratic on noisy text; once a
// closer is known to be absent, no later opener of that kind can match either.
export function* dialogueMatches(text) {
  const missing = new Set()
  for (let index = 0; index < text.length; index++) {
    const close = closers[text[index]]
    if (!close || missing.has(close)) continue
    const end = text.indexOf(close, index + 1)
    if (end < 0) { missing.add(close); continue }
    yield { index, 0: text.slice(index, end + 1) }
    index = end
  }
}

function splitDialogue(text) {
  const parts = []
  let end = 0
  for (const match of dialogueMatches(text)) {
    if (match.index > end) parts.push(text.slice(end, match.index))
    parts.push(match[0])
    end = match.index + match[0].length
  }
  if (end < text.length) parts.push(text.slice(end))
  return parts
}

export function sourceLines(text) {
  let start = 0
  return text.split('\n').map((text, id) => {
    const line = { id, start, text }
    start += text.length + 1
    return line
  })
}

export function* iterateSourceLines(text) {
  let start = 0
  let id = 0
  while (start <= text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    yield { id: id++, start, text: text.slice(start, end) }
    start = end + 1
  }
}

function splitLong(text) {
  if (text.length <= 180) return [text]
  const chars = [...text]
  const parts = []
  let start = 0
  while (chars.length - start > 180) {
    let end = start + 120
    while (end > start + 60 && !softStop.test(chars[end - 1])) end--
    if (end === start + 60) end = start + 120
    parts.push(chars.slice(start, end).join(''))
    start = end
  }
  parts.push(chars.slice(start).join(''))
  return parts
}

function legacySegments(text, removed = []) {
  const hidden = new Set(removed)
  const output = []
  for (const line of sourceLines(text)) {
    if (!line.text.trim() || hidden.has(line.id)) continue
    let last
    for (const sentence of sentences.segment(line.text)) {
      let start = line.start + sentence.index
      for (const text of splitDialogue(sentence.segment).flatMap(splitLong)) {
        const end = start + text.length
        const canJoin = last && !dialogue.test(text.trimStart()) && !dialogue.test(last.text.trimStart())
          && last.end === start && [...(last.text + text)].length <= 120
        if (canJoin) { last.end = end; last.text += text }
        else if (text.trim()) {
          last = { id: output.length, start, end, line: line.id, text }
          output.push(last)
        }
        start = end
      }
    }
  }
  return output
}

// Keep quoted names and terms inside narration. Only a complete utterance or an
// explicit speech cue creates a dialogue boundary; old annotations keep v1 IDs.
function speechSpans(text) {
  const parts = []
  const firstContent = text.search(/\S/u)
  let end = 0
  for (const match of dialogueMatches(text)) {
    const before = text.slice(Math.max(0, match.index - 32), match.index)
    const afterStart = match.index + match[0].length
    const after = text.slice(afterStart, afterStart + 32)
    const spoken = /[。！？!?…][」』”]$/u.test(match[0]) || /[:：]\s*$/u.test(before)
      || /(?:说|问|答|喊|叫|道)\s*$/u.test(before)
      || (firstContent === match.index && (!text.slice(afterStart).trim() || /^[，,]?\s*[^，。！？!?：:]{0,8}(?:说|问|答|喊|叫|道)/u.test(after)))
    if (!spoken) continue
    if (match.index > end) parts.push({ text: text.slice(end, match.index), speech: false })
    parts.push({ text: match[0], speech: true })
    end = match.index + match[0].length
  }
  if (end < text.length) parts.push({ text: text.slice(end), speech: false })
  return parts
}

// Most narration is BMP text. Count only when a surrogate pair can change the result.
function fitsCodePoints(text, limit) {
  if (text.length <= limit) return true
  if (text.length > limit * 2 || !/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text)) return false
  let count = 0
  for (const _ of text) if (++count > limit) return false
  return true
}

function* sentenceTexts(text) {
  for (const sentence of sentences.segment(text)) yield sentence.segment
}

export function* iterateChapterSegments(text, removed = [], version = SEGMENT_VERSION) {
  if (version === 1) {
    yield* legacySegments(text, removed)
    return
  }
  const hidden = new Set(removed)
  let id = 0
  for (const line of iterateSourceLines(text)) {
    if (!line.text.trim() || hidden.has(line.id)) continue
    let start = line.start
    let last
    let lastSpeech = false
    for (const span of speechSpans(line.text)) {
      // A short narration span starting with content would merge all its
      // sentences into one part. It starts a line or follows dialogue.
      const fitsNarration = span.text.length <= 120 && /^\S/u.test(span.text)
      const units = span.speech || fitsNarration ? [span.text] : sentenceTexts(span.text)
      for (const unit of units) {
        for (const text of splitLong(unit)) {
          const end = start + text.length
          if (last && !span.speech && !lastSpeech && last.end === start && fitsCodePoints(last.text + text, 120)) {
            last.end = end
            last.text += text
          } else if (text.trim()) {
            if (last) yield last
            last = { id: id++, start, end, line: line.id, text }
          }
          lastSpeech = span.speech
          start = end
        }
      }
    }
    if (last) yield last
  }
}

export function segmentChapter(text, removed, version) {
  return [...iterateChapterSegments(text, removed, version)]
}

// Shared by the editor and new synthesis jobs. Never join across paragraphs,
// deleted source ranges, speakers, emotion settings or voice directions.
// Inputs stay untouched. A missing direction equals another missing one.
export function groupSpeech(parts) {
  const groups = []
  for (const part of parts) {
    const next = { ...part, roleId: part.roleId ?? 'narrator', emotion: part.emotion ?? 'neutral', intensity: part.intensity ?? 0 }
    const last = groups.at(-1)
    if (last && last.line === next.line && last.end === next.start && !isSeparator(last.text) && !isSeparator(next.text)
      && last.roleId === next.roleId && last.emotion === next.emotion && last.intensity === next.intensity
      && (last.instruct || '') === (next.instruct || '')
      && [...(last.text + next.text)].length <= 180) {
      last.text += next.text
      last.end = next.end
      last.sourceIds.push(next.id)
    } else groups.push({ ...next, sourceIds: [next.id] })
  }
  return groups
}
