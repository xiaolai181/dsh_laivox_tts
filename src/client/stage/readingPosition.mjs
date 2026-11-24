// Where the voice is inside the current part. With Edge word timing (marks:
// [[startMs, endMs, charStart, charEnd]] relative to the part text) the answer
// is exact and includes the word being spoken. Without it (LaiVox, audio made
// before timing was stored) the position is estimated from the clock, with
// punctuation weighted by the pause it causes so long sentences do not drift
// the way a plain characters-per-second guess does.

const LEAD_SECONDS = 0.12
const TAIL_SECONDS = 0.15
const weights = new Map()

function weightOf(char) {
  if (/\s/u.test(char)) return 0
  if ('，、；：,;:'.includes(char)) return 0.6
  if ('。！？!?'.includes(char)) return 1.2
  if ('…—'.includes(char)) return 0.75
  if ('「」『』“”‘’"\'（）()《》〈〉【】[]'.includes(char)) return 0
  if (/[A-Za-z]/u.test(char)) return 0.35
  if (/[0-9]/u.test(char)) return 0.5
  return 1
}

// Cumulative weights per UTF-16 index, cached for the few texts on screen.
function cumulative(text) {
  let table = weights.get(text)
  if (table) return table
  table = new Float64Array(text.length + 1)
  for (let index = 0; index < text.length; index++) table[index + 1] = table[index] + weightOf(text[index])
  if (weights.size >= 64) weights.delete(weights.keys().next().value)
  weights.set(text, table)
  return table
}

function markAt(marks, ms) {
  let left = 0
  let right = marks.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (marks[middle][0] <= ms) left = middle + 1
    else right = middle
  }
  return left - 1
}

// Returns { read, word }: read is how many UTF-16 units of `text` have been
// spoken; word is [start, end) of the word being spoken, or null.
export function positionAt(text, offsetSec, seconds, marks) {
  const length = typeof text === 'string' ? text.length : 0
  if (!length || !Number.isFinite(offsetSec) || offsetSec <= 0) return { read: 0, word: null }
  if (Array.isArray(marks) && marks.length) {
    const ms = offsetSec * 1000
    const index = markAt(marks, ms)
    if (index < 0) return { read: 0, word: null }
    const [, end, start, stop] = marks[index]
    const last = index === marks.length - 1
    if (last && ms >= end) return { read: Math.min(length, stop), word: null }
    return { read: Math.min(length, stop), word: [Math.min(length, start), Math.min(length, stop)] }
  }
  if (!Number.isFinite(seconds) || seconds <= 0) return { read: 0, word: null }
  const usable = Math.max(0.01, seconds - LEAD_SECONDS - TAIL_SECONDS)
  const ratio = Math.max(0, Math.min(1, (offsetSec - LEAD_SECONDS) / usable))
  if (ratio >= 1) return { read: length, word: null }
  const table = cumulative(text)
  const target = ratio * table[length]
  let left = 0
  let right = length
  while (left < right) {
    const middle = (left + right + 1) >>> 1
    if (table[middle] <= target) left = middle
    else right = middle - 1
  }
  return { read: left, word: null }
}
