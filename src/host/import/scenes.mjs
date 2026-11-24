import { chapterCandidates, linesOf } from './chapters.mjs'
import { excludedOffset } from './epub-chapters.mjs'

const sceneMark = /^(?:\s*[*＊⋆※•·—\-_=─]{3,}\s*|(?:几天后|次日|翌日|与此同时|数年后|翌晨|第二天|三年后)[，、：,:]?\s*)/u
const DISTANCE = 300
const WINDOW = 180
const fillers = /[的了和在是我他她它们有就这那不着得一个都也还又，。！？？”“、\s]/gu

function units(value) {
  const chars = [...value.replace(fillers, '')]
  const result = new Map()
  for (let i = 1; i < chars.length; i++) {
    const term = chars[i - 1] + chars[i]
    result.set(term, (result.get(term) ?? 0) + 1)
  }
  return result
}

function lexicalChange(before, after) {
  const left = units(before), right = units(after)
  if (left.size < 12 || right.size < 12) return 0
  let cross = 0, leftNorm = 0, rightNorm = 0
  for (const [name, n] of left) {
    leftNorm += n * n
    cross += n * (right.get(name) ?? 0)
  }
  for (const n of right.values()) rightNorm += n * n
  return 1 - cross / Math.sqrt(leftNorm * rightNorm)
}

export function suggestCandidates(text, cuts, structure = {}) {
  const existing = new Set(cuts.map(item => item.offset))
  const ranges = structure.ignoredRanges ?? []
  const titles = chapterCandidates(text, structure.headings, structure.resources)
    .filter(item => !item.contents && !existing.has(item.offset) && !excludedOffset(ranges, item.offset))
  const bestByRegion = new Map()
  let blank = false
  let lastOffset = 0
  let comparedAt = -WINDOW
  for (const line of linesOf(text)) {
    if (existing.has(line.offset)) { lastOffset = line.offset; continue }
    if (excludedOffset(ranges, line.offset)) { blank = false; continue }
    if (!line.title) { blank = true; continue }
    const marker = sceneMark.test(line.title)
    if (line.offset - lastOffset >= DISTANCE && text.length - line.offset >= DISTANCE && (marker || (line.offset - comparedAt >= 100 && (blank || cuts.length < 2)))) {
      comparedAt = line.offset
      const before = text.slice(Math.max(0, line.offset - WINDOW), line.offset)
      const after = text.slice(line.offset, line.offset + WINDOW)
      const lexical = lexicalChange(before, after)
      const score = (marker ? 4 : 0) + (blank ? 1 : 0) + lexical
      // Keep the strongest local point in each text window. This also bounds work on very long books.
      const region = Math.floor(line.offset / 1600)
      const current = bestByRegion.get(region)
      if ((marker || lexical >= .77) && (!current || score > current.score)) bestByRegion.set(region, { offset: line.offset, score })
    }
    blank = false
  }
  const distinct = new Map(titles.map(item => [item.offset, item]))
  for (const item of [...bestByRegion.values()].sort((a,b) => b.score - a.score).slice(0, 240)) {
    if (!distinct.has(item.offset)) distinct.set(item.offset, item)
  }
  return [...distinct.values()].sort((a,b) => a.offset - b.offset)
}
