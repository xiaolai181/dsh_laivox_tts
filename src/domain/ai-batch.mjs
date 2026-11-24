import { isSeparator, iterateChapterSegments, iterateSourceLines, SEGMENT_VERSION } from './segment.mjs'
import { CAST_SEGMENTS, CAST_WINDOW, CLEAN_WINDOW } from './ai.mjs'

const CAST_OUTPUT_CEILING = 16384

// Output budget for one cast request: the model's own limit, capped so a single
// request stays well inside the stream timeouts.
export function castOutputLimit(selection) {
  return Math.min(CAST_OUTPUT_CEILING, selection?.maxTokens || 8192)
}

// About 25-35 output tokens per compact item; smaller budgets get fewer segments.
export function castSegmentsFor(selection, segments = CAST_SEGMENTS) {
  const limit = castOutputLimit(selection)
  return limit >= 8192 ? segments : Math.max(24, Math.floor(limit / 60))
}

function* windowGroups(items, cap, maxItems = Infinity) {
  let group = []
  let count = 0
  for (const item of items) {
    if (group.length && (count + item.text.length > cap || group.length >= maxItems)) {
      yield group
      group = []
      count = 0
    }
    group.push(item)
    count += item.text.length
  }
  if (group.length) yield group
}

export function batchWindows(items, cap, maxItems) {
  return [...windowGroups(items, cap, maxItems)]
}

function* cleanCandidates(text) {
  for (const line of iterateSourceLines(text)) {
    if (line.text.length <= 1400 && line.text.trim()) yield line
  }
}

// Regular calls only. Repair requests are possible and are not part of this count.
export function countAiBatches({ text = '', removed = [], clean = false, cast = false, cleanWindow = CLEAN_WINDOW, castWindow = { chars: CAST_WINDOW, segments: CAST_SEGMENTS }, version = SEGMENT_VERSION } = {}) {
  let cleanCount = 0
  let castCount = 0
  if (clean) {
    for (const _ of windowGroups(cleanCandidates(text), cleanWindow)) cleanCount++
  }
  if (cast) {
    for (const group of windowGroups(iterateChapterSegments(text, removed, version), castWindow.chars, castWindow.segments)) {
      if (group.some(part => !isSeparator(part.text))) castCount++
    }
  }
  return { clean: cleanCount, cast: castCount, requests: cleanCount + castCount }
}

export const ESTIMATE_GROUP_CHAPTERS = 16
// A chapter of about 100,000 characters stays in its own group. The 256 Ki
// starting size held two such chapters, and the 500-chapter run kept too much text.
export const ESTIMATE_GROUP_UNITS = 32 * 1024

export function packEstimateGroups(rows) {
  const groups = []
  let current = []
  let units = 0
  for (const row of rows) {
    const size = Math.max(0, Number(row?.characters) || 0)
    const alone = size > ESTIMATE_GROUP_UNITS
    if (current.length && (alone || current.length >= ESTIMATE_GROUP_CHAPTERS || units + size > ESTIMATE_GROUP_UNITS)) {
      groups.push(current)
      current = []
      units = 0
    }
    current.push(row)
    units += size
    if (alone) {
      groups.push(current)
      current = []
      units = 0
    }
  }
  if (current.length) groups.push(current)
  return groups
}
