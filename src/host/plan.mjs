import { groupSpeech } from '../domain/segment.mjs'
import { speakableParts } from '../domain/voice-assignment.mjs'
import { chooseVoices } from './editorial.mjs'

// The same post-process execute applies once prepare has returned segments.
export function speechParts(prepared, spec) {
  let parts = speakableParts(prepared)
  const skipped = prepared.length - parts.length
  if (spec.mode === 'reading') parts = parts.map(({ instruct: _instruct, ...part }) => ({ ...part, roleId: 'narrator', emotion: 'neutral', intensity: 0 }))
  parts = groupSpeech(parts)
  return { parts, skipped }
}

// A job's plan is complete once it has parts and is not still growing while the
// chapter is being scripted (progress.partsOpen). Anything that treats the parts
// as the whole chapter (resuming, playback, exports) must ask this.
export function planComplete(progress) {
  return Boolean(progress?.parts?.length) && !progress.partsOpen
}

export function toSynthesisParts(prepared, spec, version, roles, catalog, variant, rule) {
  const shaped = speechParts(prepared, spec)
  if (!shaped.parts.length) throw new Error('CHAPTER_EMPTY')
  return { skipped: shaped.skipped, parts: chooseVoices(shaped.parts, roles, catalog, spec.engine, variant, { version, rule, narratorDefault: spec.laivoxNarratorDefault ?? null }) }
}

export function mergeRanges(ranges) {
  const sorted = []
  for (const range of ranges ?? []) {
    if (!Number.isSafeInteger(range?.start) || !Number.isSafeInteger(range?.end) || range.end <= range.start) continue
    sorted.push({ start: range.start, end: range.end })
  }
  sorted.sort((a, b) => a.start - b.start || a.end - b.end)
  const merged = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end)
    else merged.push(range)
  }
  return merged
}

export function allowedRanges(spec, progress) {
  return mergeRanges([...(spec?.only ? [spec.only] : []), ...(Array.isArray(progress?.ranges) ? progress.ranges : [])])
}

export function covers(part, ranges) {
  return ranges.some(range => part.start < range.end && part.end > range.start)
}
