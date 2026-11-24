// Shared estimate for the AI confirmation sheet. The numbers mirror the real
// batching in src/host/editorial.mjs: clean sends at most 12000 characters per
// request (lines longer than 1400 characters are dropped) and only gets line
// numbers back; casting sends at most 9000 characters or 120 segments per
// request with compact per-segment replies, and may spend up to 7 requests on
// one batch while recovering missing IDs. Jobs started before these sizes keep
// their original 3000 / 2400-and-32 windows when resumed.
export const CLEAN_WINDOW = 12000
export const CAST_WINDOW = 9000
export const CAST_SEGMENTS = 120
export const CAST_REPAIRS = 7
// Typical characters per segment after local segmentation, used only to turn
// a character count into an expected segment count for the estimate.
const CHARS_PER_SEGMENT = 35

const positive = value => (Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0)
const batches = (characters, window) => (characters > 0 ? Math.ceil(characters / window) : 0)

export function estimateAiCalls({ cleanCharacters = 0, castCharacters = 0 } = {}) {
  const clean = batches(positive(cleanCharacters), CLEAN_WINDOW)
  const castChars = positive(castCharacters)
  const cast = Math.max(batches(castChars, CAST_WINDOW), batches(castChars, CAST_SEGMENTS * CHARS_PER_SEGMENT))
  return { clean, cast, requests: clean + cast, maximum: clean + cast * CAST_REPAIRS }
}
