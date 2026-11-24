import { findLocalCuts, headingStyle, linesOf, normalizeCuts } from './chapters.mjs'
import { contentsRanges, excludedOffset, mergeRanges } from './epub-chapters.mjs'

const titleKey = title => String(title ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()

function nextNonEmptySlice(pageSlices, startPage) {
  for (let index = startPage; index < pageSlices.length; index++) {
    if (pageSlices[index]?.lines?.length) return pageSlices[index]
  }
  return null
}

function matchOutlineLine(slice, entry) {
  const target = titleKey(entry.title)
  if (target) {
    const exact = slice.lines.filter(line => {
      const key = titleKey(line.title)
      return key === target || (target.length >= 2 && (key.startsWith(target) || target.startsWith(key)))
    })
    if (exact.length === 1) return exact[0]
    if (exact.length > 1 && Number.isFinite(entry.destY)) {
      return exact.reduce((best, line) => Math.abs(line.y - entry.destY) < Math.abs(best.y - entry.destY) ? line : best)
    }
    if (exact.length) return exact[0]
  }
  if (Number.isFinite(entry.destY)) {
    const below = slice.lines.find(line => line.y <= entry.destY + 18)
    if (below) return below
  }
  return slice.lines[0]
}

function hasLargeOutlineGap(text, outlineCuts, localCuts) {
  if (!outlineCuts.length) return false
  const positions = [0, ...outlineCuts.map(cut => cut.offset), text.length]
  for (let i = 1; i < positions.length; i++) {
    const start = positions[i - 1]
    const end = positions[i]
    if (end - start <= text.length * 0.5) continue
    const strongInside = localCuts.filter(cut => cut.offset > start && cut.offset < end && headingStyle(cut.title)?.strong)
    if (strongInside.length >= 3) return true
  }
  return false
}

function pdfContentsRanges(text, lines, pageSlices) {
  if (!pageSlices.length) return mergeRanges(contentsRanges(lines, text.length))
  const ranges = []
  for (const slice of pageSlices) {
    if (slice.end <= slice.start) continue
    const pageLines = lines.filter(line => line.offset >= slice.start && line.offset < slice.end)
    if (!pageLines.length) continue
    ranges.push(...contentsRanges(pageLines, slice.end))
  }
  return mergeRanges(ranges)
}

export function planPdfChapters(text, { pageSlices = [], headings = [], outline = [], outlineFailed = false } = {}) {
  const lines = [...linesOf(text)]
  const ignoredRanges = pdfContentsRanges(text, lines, pageSlices)

  const mapped = []
  const seenOffsets = new Set()
  for (const entry of outline) {
    if (!Number.isInteger(entry.pageIndex) || entry.pageIndex < 0 || entry.pageIndex >= pageSlices.length) continue
    const slice = nextNonEmptySlice(pageSlices, entry.pageIndex)
    if (!slice) continue
    const line = matchOutlineLine(slice, entry)
    if (!line || seenOffsets.has(line.offset) || excludedOffset(ignoredRanges, line.offset)) continue
    seenOffsets.add(line.offset)
    const title = String(entry.title ?? '').trim().slice(0, 180) || line.title
    mapped.push({ offset: line.offset, title, kind: 'structure' })
  }

  const outlineCuts = normalizeCuts(text, mapped)
  const localCuts = findLocalCuts(text, { headings }).filter(cut => !excludedOffset(ignoredRanges, cut.offset))
  const hasOutline = outline.length > 0 || outlineFailed
  const weakOutline = hasLargeOutlineGap(text, outlineCuts, localCuts) ||
    (outlineCuts.length < 2 && localCuts.length >= 2) ||
    (outlineFailed && !outlineCuts.length)

  let chosen = outlineCuts
  const warnings = []
  if (!outlineCuts.length) {
    chosen = localCuts
    if (hasOutline) warnings.push('PDF_TOC_FALLBACK')
  } else if (weakOutline) {
    const merged = new Map(outlineCuts.map(cut => [cut.offset, cut]))
    for (const cut of localCuts) {
      if (!merged.has(cut.offset)) merged.set(cut.offset, cut)
    }
    chosen = [...merged.values()]
    warnings.push('PDF_TOC_FALLBACK')
  }

  const cuts = normalizeCuts(text, chosen)
  const firstProse = lines.find(line => line.title && !excludedOffset(ignoredRanges, line.offset))
  const sampleOffset = firstProse && firstProse.offset > 0 ? firstProse.offset : undefined
  return { cuts, ignoredRanges, sampleOffset, warnings }
}
