import { headingStyle, linesOf, normalizeCuts } from './chapters.mjs'

const noteId = /^(?:footnotes?|endnotes?|noteref|pagebreak)(?:$|[-_:0-9])/iu
export const isAuxiliaryAnchor = value => noteId.test(value)
const ordinalOnly = /^(?:(?:\d+\s+)?第\s*[零〇一二三四五六七八九十百两\d]+\s*[章节節回卷部]|chapter\s+\d+)$/iu
const prose = line => line.value.length >= 55 || /[。！？][”’」』]?$/u.test(line.value.trim())
const titleKey = title => title.normalize('NFKC').replace(/^\d+\s+/u, '')
  .replace(/^第\s*[零〇一二三四五六七八九十百两\d]+\s*[章节節回卷部][\s:、.-]*(?=\S)/u, '')
  .replace(/\s+/gu, '').toLowerCase()

export function contentsRanges(lines, end) {
  const ranges = []
  let start = 0
  let count = 0
  let directory = false
  function finish(last) {
    if (directory || count >= 6) ranges.push([lines[start].offset, last])
    count = 0
    directory = false
  }
  for (const [i, line] of lines.entries()) {
    const title = line.title.normalize('NFKC')
    if (/^(?:目\s*[录錄]|contents|table of contents)$/iu.test(title)) {
      if (count || directory) finish(line.offset)
      start = i
      directory = true
    } else if (title && title.length <= 100 && (headingStyle(title)?.number != null ||
      /(?:[.·…]{3,}\s*(?:\d+)?$)/u.test(title) ||
      (directory && !prose(line) && !/\[\s*\d+\s*\]/u.test(title) && count < 80))) {
      if (!count && !directory) start = i
      count++
    } else if (count || directory) finish(line.offset)
  }
  if (count || directory) finish(end)
  return ranges
}

export function mergeRanges(ranges) {
  const result = []
  for (const [start, end] of ranges.sort(([a], [b]) => a - b)) {
    if (start >= end) continue
    const previous = result.at(-1)
    if (previous && previous[1] >= start) previous[1] = Math.max(previous[1], end)
    else result.push([start, end])
  }
  return result
}

export function excludedOffset(ranges, offset) {
  let low = 0, high = ranges.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (ranges[mid][1] <= offset) low = mid + 1
    else high = mid
  }
  return low < ranges.length && ranges[low][0] <= offset
}

function inspectResource(text, resource) {
  const lines = [...linesOf(text.slice(resource.start, resource.end))]
    .map(line => ({ ...line, offset: line.offset + resource.start }))
  const tags = new Map(resource.headings.map(heading => [heading.offset, heading.tag]))
  const chapterOffsets = new Set(resource.headings.filter(item => item.tag === 'epub:chapter').map(item => item.offset))
  const byOffset = new Map(lines.map((line, index) => [line.offset, index]))
  const ranges = mergeRanges([...resource.ignored, ...contentsRanges(lines, resource.end)])
  const opening = []
  for (const [index, line] of lines.slice(0, 8).entries()) {
    const tag = tags.get(line.offset)
    if (line.offset - resource.start > 800 || (prose(line) && !tag)) break
    if (excludedOffset(ranges, line.offset)) break
    if (tag && tag !== 'h6' && line.title && (tag !== 'epub:chapter' || !prose(line))) {
      opening.push(line)
      if (!ordinalOnly.test(line.title.normalize('NFKC')) || index === 7) break
    } else if (index === 0 && headingStyle(line.title)?.strong) opening.push(line)
    else if (opening.length && !/^\d+$/u.test(line.title)) break
  }
  const head = opening.find(line => !ordinalOnly.test(line.title.normalize('NFKC'))) ?? opening[0]
  const startTitle = lines[0]?.title ?? ''
  const appendix = /^(?:索\s*引|注\s*[释釋]|参考文献|bibliography)$/iu.test(head?.title ?? startTitle)
  const hasNotes = !head && isCitation(startTitle) && [...resource.ids.keys()].filter(id => noteId.test(id)).length >= 3
  if (appendix || hasNotes) ranges.splice(0, ranges.length, [resource.start, resource.end])
  const prefix = head && head.offset > resource.start && head.offset - resource.start < 100 &&
    lines.filter(line => line.offset < head.offset).every(line => !headingStyle(line.title) && !prose(line))
  return { ...resource, lines, tags, chapterOffsets, byOffset, ranges, head, startTitle, appendix, hasNotes, prefix }
}

function isCitation(title) {
  return /^(?:\(?\d{4}\)|\d+\.\s*(?:[A-Z]|\[))|\bpp?\.\s*\d/iu.test(title)
}

function bestHeadingNear(resource, offset) {
  const index = resource.byOffset.get(offset)
  if (index === undefined) return null
  return resource.lines.slice(index, index + 2).find(line => {
    const tag = resource.tags.get(line.offset)
    return tag && tag !== 'h6' && tag !== 'epub:chapter' && !ordinalOnly.test(line.title.normalize('NFKC'))
  }) ?? (resource.head?.offset === offset ? resource.head : null)
}

function resolveLinks(resources, links) {
  const resolved = []
  const byPath = Map.groupBy(links, link => link.path)
  for (const resource of resources) {
    if (resource.appendix || resource.hasNotes) continue
    const group = byPath.get(resource.path) ?? []
    byPath.delete(resource.path)
    const available = group.filter(link => !isAuxiliaryAnchor(link.fragment ?? ''))
    for (const link of available) {
      const anchor = link.fragment ? resource.ids.get(link.fragment) : null
      if (anchor?.auxiliary) continue
      if (link.fragment && resource.ids.has(link.fragment) && (!anchor || resource.start + anchor.offset >= resource.end)) continue
      const substitute = Boolean(link.fragment && !anchor)
      if (substitute && available.length !== 1) continue
      const offset = anchor ? resource.start + anchor.offset : resource.start
      if (excludedOffset(resource.ranges, offset)) continue
      const heading = bestHeadingNear(resource, offset) ?? (offset === resource.start ? resource.head : null)
      const matches = Boolean(heading && titleKey(link.title) === titleKey(heading.title))
      const generic = ordinalOnly.test(link.title.normalize('NFKC'))
      if (!substitute && heading && !matches && !generic) continue
      const preferHeading = heading && (substitute || generic)
      const chapter = resource.chapterOffsets.has(offset)
      const effectiveOffset = resource.prefix && heading === resource.head ? resource.start : offset
      resolved.push({ offset: effectiveOffset, title: preferHeading ? heading.title : link.title,
        kind: preferHeading ? 'heading' : substitute ? 'spine' : 'structure',
        start: resource.start, substitute, supported: matches || chapter, order: link.order })
    }
  }
  return resolved.sort((a, b) => a.order - b.order)
}

function qualifyingBody(lines, index, end) {
  let found = 0
  for (let i = index + 1; i < lines.length && lines[i].offset < end; i++) {
    if (prose(lines[i]) && ++found >= 2) return true
  }
  return false
}

// Eligible predecessors are inserted once per ordinal. Both offset and prose count increase.
function longestSequence(rows, minimum) {
  const series = new Map()
  let best
  for (const row of rows) {
    const prior = series.get(row.number - 1)
    while (prior && prior.cursor < prior.rows.length) {
      const candidate = prior.rows[prior.cursor]
      if (row.offset - candidate.offset < 300 || row.proseBefore - candidate.proseBefore < 2) break
      if (!prior.best || candidate.length > prior.best.length) prior.best = candidate
      prior.cursor++
    }
    const previous = prior?.best
    if (row.number !== 1 && !previous) continue
    const entry = { ...row, previous, length: (previous?.length ?? 0) + 1 }
    if (!series.has(row.number)) series.set(row.number, { rows: [], cursor: 0 })
    series.get(row.number).rows.push(entry)
    if (!best || entry.length > best.length) best = entry
  }
  if (!best || best.length < minimum) return []
  const result = []
  for (let item = best; item; item = item.previous) result.push(item)
  return result.reverse()
}

function findSequences(resources) {
  const rows = []
  let proseBefore = 0
  for (const resource of resources) {
    const strongOpening = resource.head && resource.tags.has(resource.head.offset)
    for (const [index, line] of resource.lines.entries()) {
      if (excludedOffset(resource.ranges, line.offset)) continue
      const style = headingStyle(line.title)
      if (!strongOpening && style && (style.family === '编号.' || style.family === '第…部')) {
        if (Number.isSafeInteger(style.number) && style.number > 0 && line.title.length <= 60) {
          rows.push({ offset: line.offset, title: line.title, kind: 'heading', number: style.number,
            family: style.family, proseBefore })
        }
      }
      if (!strongOpening && /^[上中下]\s*部\s+\S/u.test(line.title) &&
        qualifyingBody(resource.lines, index, line.offset + 3000)) {
        rows.push({ offset: line.offset, title: line.title, kind: 'heading', family: '上中下部',
          number: '上中下'.indexOf(line.title[0]) + 1, proseBefore })
      }
      if (prose(line)) proseBefore++
    }
  }
  const groups = Map.groupBy(rows, row => row.family)
  const numbered = longestSequence(groups.get('编号.') ?? [], 6)
  const volumes = longestSequence(groups.get('上中下部') ?? [], 3)
  const parts = longestSequence(groups.get('第…部') ?? [], 4)
  return { numbered, other: [...volumes, ...parts] }
}

function parallelHeadings(resource) {
  const headings = resource.headings.filter(({ tag, offset }) => /^h[1-5]$/u.test(tag) &&
    !excludedOffset(resource.ranges, offset))
  if (headings.length < 2) return []
  const level = Math.min(...new Set(headings.map(({ tag }) => Number(tag[1]))))
  const peers = [...new Set(headings.filter(({ tag }) => Number(tag[1]) === level).map(({ offset }) => offset))]
  if (peers.length < 2) return []
  return peers.flatMap((offset, i) => {
    const index = resource.byOffset.get(offset)
    if (index === undefined) return []
    const line = resource.lines[index]
    const next = resource.lines[index + 1]
    const end = peers[i + 1] ?? resource.end
    const body = next && next.offset < end && (prose(next) || qualifyingBody(resource.lines, index, end))
    return body && line.title.length > 0 && line.title.length <= 100 && !isCitation(line.title)
      ? [{ offset: line === resource.head && resource.prefix ? resource.start : offset, title: line.title, kind: 'heading' }] : []
  })
}

function fallbackTitle(resource, index) {
  if (resource.head) return { title: resource.head.title, kind: 'heading' }
  if (resource.hasNotes) return { title: '注释', kind: 'spine' }
  const first = resource.lines[0]
  const usable = first && !excludedOffset(resource.ranges, first.offset) && first.title.length <= 48 &&
    headingStyle(first.title)?.strong && !isCitation(first.title)
  return { title: usable ? first.title : '分节 ' + (index + 1), kind: 'spine' }
}

export function planEpubChapters(text, input, { navLinks, ncxLinks, failed }) {
  const resources = input.map(resource => inspectResource(text, resource))
  const candidates = resolveLinks(resources, navLinks)
  const chosen = candidates.length ? candidates : resolveLinks(resources, ncxLinks)
  const main = resources.filter(resource => !resource.appendix && !resource.hasNotes)
  const substantive = main.filter(resource => resource.end - resource.start >= 500 || resource.head)
  const eligible = substantive.length ? substantive : main
  const covered = new Set(chosen.filter(item => !item.substitute).map(item => item.start))
  const weak = resources.length > 1 &&
    eligible.filter(resource => covered.has(resource.start)).length < eligible.length / 2
  const anchors = chosen.filter(item => !weak || item.supported)
  const positions = [...new Set([0, ...anchors.map(item => item.offset), text.length])].sort((a, b) => a - b)
  const gaps = []
  let resourceCursor = 0
  for (let i = 1; i < positions.length; i++) {
    const start = positions[i - 1], end = positions[i]
    while (resourceCursor < eligible.length && eligible[resourceCursor].start <= start) resourceCursor++
    let missed = 0
    while (resourceCursor < eligible.length && eligible[resourceCursor].start < end) {
      const resource = eligible[resourceCursor++]
      if (!covered.has(resource.start) && resource.head) missed++
    }
    if (missed >= 2 && end - start > text.length * .3) gaps.push([start + 1, end])
  }
  const cuts = anchors.map(({ offset, title, kind }) => ({ offset, title, kind }))
  const { numbered, other } = findSequences(resources)
  const semantic = resources.flatMap(resource => resource.headings.flatMap(heading => {
    if (heading.tag !== 'epub:chapter' || excludedOffset(resource.ranges, heading.offset)) return []
    const line = resource.lines[resource.byOffset.get(heading.offset)]
    return line ? [{ offset: line.offset, title: line.title, kind: 'heading' }] : []
  }))
  const shadowed = new Set(anchors.map(item => item.offset))
  const anchoredResources = new Set(anchors.map(item => item.start))
  const replacementTitles = new Map(chosen.filter(item => item.substitute).map(item => [item.offset, item]))
  for (const resource of resources) {
    if (!anchoredResources.has(resource.start)) cuts.push(...parallelHeadings(resource))
  }
  cuts.push(...semantic, ...[...numbered, ...other].map(({ offset, title, kind }) => ({ offset, title, kind })))
  const firstNumbered = numbered[0]?.offset
  const lastNumbered = numbered.at(-1)?.offset
  for (const [index, resource] of resources.entries()) {
    const start = resource.start
    if (shadowed.has(start) || (firstNumbered < start && start < lastNumbered)) continue
    if (!weak && !excludedOffset(gaps, start) && resources.length > 1 && covered.size && start > 0) continue
    if (resources.length === 1 && !resource.head) continue
    const item = replacementTitles.get(start)
    cuts.push({ offset: start, ...(item && !resource.head ? { title: item.title, kind: item.kind } : fallbackTitle(resource, index)) })
  }
  const first = resources[0]
  const normalized = normalizeCuts(text, cuts)
  let sampleOffset
  if (first?.prefix && first.head && normalized[0]?.offset === 0 &&
    titleKey(normalized[0].title) === titleKey(first.head.title)) sampleOffset = first.head.offset
  const usedFallback = failed || (navLinks.length > 0 && !candidates.length) || gaps.length > 0 ||
    (weak && (navLinks.length > 0 || ncxLinks.length > 0)) || chosen.some(item => item.substitute)
  return { cuts: normalized, ignoredRanges: mergeRanges(resources.flatMap(resource => resource.ranges)),
    sampleOffset, warnings: usedFallback ? ['EPUB_TOC_FALLBACK'] : [] }
}
