const ordinal = '[0-9〇零一二三四五六七八九十百千万萬两兩廿卅]+'
const explicit = new RegExp('^第\\s*(' + ordinal + ')\\s*([章回节節卷部集])(?:[\\s:：.、·—-]*)(.*)$', 'iu')
const boxed = new RegExp('^([【〔［\\[])\\s*(' + ordinal + ')\\s*[】〕］\\]]\\s*(.*)$', 'u')
const enumerated = new RegExp('^(' + ordinal + ')([.、:：])\\s*(.+)$', 'u')
const chapterWord = /^chapter\s+([0-9]+|[ivxlcdm]+)(?:\b|$)[\s.:—-]*(.*)$/iu
const special = /^(?:序章|楔子|前言|序言|尾声|尾聲|后记|後記|终章|終章|番外)(?:$|[ ：:]+\S.{0,48}$)/u
const sentenceEnd = /[。！？!?；;”’」』]$/u

function numberOf(value) {
  if (/^\d+$/u.test(value)) return Number(value)
  const digits = '零一二三四五六七八九'
  const text = value.replaceAll('〇','零').replaceAll(/[两兩]/gu,'二').replaceAll('廿','二十').replaceAll('卅','三十')
  if ([...text].every(char => digits.includes(char))) return Number([...text].map(char => digits.indexOf(char)).join(''))
  let result = 0, n = 0, section = 0
  const units = { 十: 10, 百: 100, 千: 1000 }
  for (const char of text) {
    if (char === '万' || char === '萬') {
      result += (section + (n || (section ? 0 : 1))) * 10000
      section = 0
      n = 0
    } else if (units[char]) { section += (n || 1) * units[char]; n = 0 }
    else if (digits.includes(char)) n = digits.indexOf(char)
    else return null
  }
  return result + section + n
}

export function headingStyle(line, tag) {
  if (!line || line.length > 100 || sentenceEnd.test(line) || /^[“「『"'〈]/u.test(line)) return null
  const comparable = line.normalize('NFKC')
  let match
  if ((match = explicit.exec(comparable))) return { family: '第…' + match[2], number: numberOf(match[1]), strong: true }
  if ((match = chapterWord.exec(comparable))) return { family: 'Chapter …', number: numberOf(match[1]), strong: true }
  if (special.test(comparable)) return { family: '序章与番外', strong: true }
  if ((match = boxed.exec(comparable))) return { family: match[1] + '…', number: numberOf(match[2]) }
  if (/^(?:【[^】]{2,48}】|\[[^\]]{2,48}\])$/u.test(comparable)) return { family: comparable[0] + '章名' }
  if ((match = enumerated.exec(comparable))) return { family: '编号' + match[2], number: numberOf(match[1]) }
  if (tag) return { family: tag, titleTag: true }
  return null
}

export function* linesOf(text) {
  let start = 0
  while (start < text.length) {
    const next = text.indexOf('\n', start)
    const end = next < 0 ? text.length : next
    const value = text.slice(start, end)
    yield { offset: start, end, value, title: value.trim().slice(0, 101) }
    start = end + 1
  }
}

function followingBody(text, start, end) {
  for (let cursor = start; cursor < end;) {
    const limit = text.indexOf('\n', cursor)
    const endLine = limit === -1 ? end : Math.min(limit, end)
    const line = text.slice(cursor, endLine).trim()
    if (line.length > 15 || /[。！？]/u.test(line)) return true
    cursor = endLine + 1
  }
  return false
}

export function chapterCandidates(text, headings = [], resources = []) {
  const tags = new Map()
  for (const { offset, tag } of headings) if (!tags.has(offset) || tag === 'epub:chapter') tags.set(offset, tag)
  const boundaries = new Set(resources)
  const candidates = []
  let previousLooseRegion = -1
  let blankBefore = true
  for (const line of linesOf(text)) {
    const tag = tags.get(line.offset)
    const style = headingStyle(line.title, tag) ?? (tag === 'epub:chapter' ? { family: tag } : null)
    if (tag === 'epub:chapter') style.strong = true
    const atResource = boundaries.has(line.offset)
    const region = Math.floor(line.offset / 4000)
    const loose = region !== previousLooseRegion && blankBefore && line.title.length >= 2 &&
      line.title.length <= 34 && !/[。！？!?，、；]$/u.test(line.title)
    if (loose && !style && !atResource) previousLooseRegion = region
    if (style || atResource || loose) {
      if (candidates.length >= 100_000) throw new Error('IMPORT_TOO_MANY_CHAPTERS')
      candidates.push({ offset: line.offset, end: line.end, title: line.title, family: style?.family,
        number: style?.number, strong: style?.strong, tag, atResource, blankBefore })
    }
    blankBefore = !line.title
  }
  // A copied contents list usually has no prose between repeated headings.
  const bodyOccurrences = new Map()
  const shaped = candidates.filter(item => item.family)
  const key = item => item.family + '\0' + (item.number ?? item.title)
  for (const [index, current] of shaped.entries()) {
    const end = shaped[index + 1]?.offset ?? text.length
    const distance = end - current.end
    const hasBody = distance >= 170 || followingBody(text, current.end + 1, end)
    current.body = hasBody
    if (hasBody) bodyOccurrences.set(key(current), current.offset)
  }
  for (const item of shaped) {
    item.contents = !item.body && bodyOccurrences.get(key(item)) > item.offset
  }
  return candidates
}

function strongSequence(group) {
  const numbers = group.filter(row => Number.isSafeInteger(row.number))
  if (numbers.length < 3) return false
  let steps = 0
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i].number === numbers[i - 1].number + 1) steps++
  }
  return steps >= numbers.length * .6
}

export function findLocalCuts(text, { anchors = [], headings = [], resources = [] } = {}) {
  if (anchors.length) return anchors.map(item => ({ ...item, kind: 'structure' }))
  const candidates = chapterCandidates(text, headings, resources)
  const groups = Map.groupBy(candidates.filter(item => item.family && item.body && !item.contents), item => item.family)
  const confirmed = new Set()
  for (const [family, group] of groups) {
    const sameResources = group.filter(item => item.atResource).length >= 2
    if ((group.length >= 4 && strongSequence(group)) || (group[0].tag === 'h1' && group.length >= 2) ||
      (group[0].tag && sameResources)) confirmed.add(family)
  }
  return candidates.filter(item => !item.contents && (item.strong || confirmed.has(item.family)))
    .map(item => ({ offset: item.offset, title: item.title, kind: item.tag ? 'structure' : 'local' }))
}

export function normalizeCuts(text, cuts) {
  const unique = new Map()
  for (const cut of cuts) {
    const offset = cut.offset
    if (!Number.isInteger(offset) || offset < 0 || offset >= text.length ||
        (offset > 0 && text[offset - 1] !== '\n') || unique.has(offset)) continue
    unique.set(offset, cut)
  }
  return [...unique.values()].sort((a, b) => a.offset - b.offset)
}

export function materializeChapters(text, cuts, bookTitle) {
  const starts = normalizeCuts(text, cuts)
  if (starts[0]?.offset !== 0) starts.unshift({ offset: 0, title: bookTitle, kind: 'local' })
  const chapters = []
  let fallbackNumber = 0
  for (const [i, start] of starts.entries()) {
    const end = starts[i + 1]?.offset ?? text.length
    const body = text.slice(start.offset, end)
    if (!body.trim()) {
      if (chapters.length) chapters.at(-1).text += body
      else if (starts[i + 1]) starts[i + 1] = { ...starts[i + 1], offset: start.offset }
      continue
    }
    const title = start.title || '建议分节 ' + ++fallbackNumber
    chapters.push({ offset: start.offset, title, kind: start.kind, text: body })
  }
  return splitOversized(chapters)
}

// A chapter past this length cannot be edited (the text limit) and makes
// production checkpoints enormous. Split on a paragraph, then a sentence,
// then a hard cut, and keep every piece at or under the limit.
export function splitOversized(chapters, limit = 100_000) {
  const out = []
  for (const chapter of chapters) {
    if (chapter.text.length <= limit) { out.push(chapter); continue }
    const pieces = []
    let rest = chapter.text
    while (rest.length > limit) {
      // The newline has to sit inside the piece, so the piece stays within the limit.
      let cut = rest.lastIndexOf('\n', limit - 1)
      if (cut > 0) cut += 1
      else {
        const window = rest.slice(0, limit)
        const sentence = Math.max(...['。', '！', '？', '.', '!', '?'].map(mark => window.lastIndexOf(mark)))
        cut = sentence > 0 ? sentence + 1 : limit
      }
      if (cut <= 0 || cut > limit) cut = limit
      pieces.push(rest.slice(0, cut))
      rest = rest.slice(cut)
    }
    if (rest) pieces.push(rest)
    let offset = chapter.offset
    pieces.forEach((text, index) => {
      out.push({
        offset, title: chapter.title + ' · 第 ' + (index + 1) + ' 部分',
        kind: index === 0 ? chapter.kind : 'split', splitHead: index === 0, text,
      })
      offset += text.length
    })
  }
  return out
}

export function contextAt(text, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= text.length || (offset > 0 && text[offset - 1] !== '\n')) throw new Error('INVALID_CHAPTER_BOUNDARY')
  const previous = offset > 1 ? text.lastIndexOf('\n', offset - 2) + 1 : 0
  const following = text.indexOf('\n', offset)
  return {
    offset, before: text.slice(Math.max(0, offset - 320), offset), after: text.slice(offset, offset + 320),
    previous: offset > 0 ? previous : null,
    next: following >= 0 && following + 1 < text.length ? following + 1 : null,
  }
}
