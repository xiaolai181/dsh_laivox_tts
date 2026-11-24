// Aligns Edge word boundaries to character ranges of the synthesized text.
// words: [{ o: start ms, d: duration ms, t: word }] in speaking order.
// Returns [[startMs, endMs, charStart, charEnd], ...] relative to `text`,
// covering the text without gaps: punctuation and spaces between two words
// belong to the earlier word, the first mark starts at 0 and the last ends at
// text.length. Words that cannot be found near the cursor are skipped, so a
// normalization difference only costs that word, never the rest of the part.
const MAX_GAP = 40

export function alignMarks(text, words) {
  if (typeof text !== 'string' || !text || !Array.isArray(words)) return []
  const found = []
  let cursor = 0
  for (const word of words) {
    if (!word || typeof word.t !== 'string' || !word.t || !Number.isFinite(word.o) || !Number.isFinite(word.d)) continue
    const at = text.indexOf(word.t, cursor)
    if (at < 0 || at - cursor > MAX_GAP) continue
    found.push([Math.max(0, Math.round(word.o)), Math.max(0, Math.round(word.o + word.d)), at, at + word.t.length])
    cursor = at + word.t.length
  }
  for (let index = 0; index < found.length; index++) {
    found[index][3] = index + 1 < found.length ? found[index + 1][2] : text.length
  }
  if (found.length) found[0][2] = 0
  return found
}

// Character offset (relative to the part text) that has been spoken at `ms`.
// Returns -1 before the first word starts.
export function spokenOffset(marks, ms) {
  if (!Array.isArray(marks) || !marks.length || !Number.isFinite(ms)) return -1
  let left = 0
  let right = marks.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (marks[middle][0] <= ms) left = middle + 1
    else right = middle
  }
  if (left === 0) return -1
  return marks[left - 1][3]
}
