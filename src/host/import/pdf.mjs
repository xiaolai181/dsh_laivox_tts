import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { headingStyle, materializeChapters } from './chapters.mjs'
import { planPdfChapters } from './pdf-chapters.mjs'

export const PDF_MAX_PAGES = 5_000
export const PDF_MAX_CHARS = 30_000_000

const OUTLINE_MAX_DEPTH = 8
const OUTLINE_MAX_ITEMS = 5_000
const MEANINGFUL_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z0-9]/u
const CJK_OR_FULLWIDTH = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303F\uFF00-\uFFEF]/u
const SENTENCE_END = /[。！？!?；;”’」』.)）]$/u
const SCENE_MARK = /^(?:\*{3,}|-{3,}|—{3,}|─{3,})$/u
const DIALOGUE_OR_LIST = /^[“「『"•·\-]/u
const PAGE_NUMBER_ONLY = /^(?:[-—–·\s]*\d{1,5}[-—–·\s]*|第\s*\d{1,5}\s*[页頁]|(?:page|p\.)\s*\d{1,5}(?:\s*(?:of|\/)\s*\d{1,5})?|\d{1,5}\s*\/\s*\d{1,5}|[ivxlcdm]{1,7})$/iu
const JUNK_TITLE = /^(?:untitled(?:\s+\d+)?|document(?:\s+\d+)?|microsoft\s+word(?:\s*[-–—].*)?|adobe\s+(?:pdf|acrobat).*|wps.*|无标题)$/iu

let pdfjsPromise
async function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const require = createRequire(import.meta.url)
      const root = dirname(require.resolve('pdfjs-dist/package.json'))
      const pdfjs = await import(pathToFileURL(join(root, 'legacy', 'build', 'pdf.mjs')).href)
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(join(root, 'legacy', 'build', 'pdf.worker.mjs')).href
      return {
        getDocument: pdfjs.getDocument,
        cMapUrl: join(root, 'cmaps').replaceAll('\\', '/') + '/',
        standardFontDataUrl: join(root, 'standard_fonts').replaceAll('\\', '/') + '/',
      }
    })()
  }
  return pdfjsPromise
}

function assertPdfHeader(bytes) {
  if (!bytes || typeof bytes.byteLength !== 'number' || bytes.byteLength < 5) throw new Error('PDF_INVALID')
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(1024, bytes.byteLength))
  if (!head.includes('%PDF-')) throw new Error('PDF_INVALID')
}

function mapPdfError(error, signal) {
  if (signal?.aborted) return signal.reason ?? error
  if (error?.name === 'AbortError') return error
  const known = new Set(['PDF_INVALID', 'PDF_ENCRYPTED', 'PDF_NO_TEXT', 'PDF_ENCODING_INVALID', 'IMPORT_TOO_LARGE'])
  if (known.has(error?.message)) return error
  if (error?.name === 'PasswordException') return new Error('PDF_ENCRYPTED')
  if (['InvalidPDFException', 'MissingPDFException', 'FormatError', 'UnexpectedResponseException'].includes(error?.name)) {
    return new Error('PDF_INVALID')
  }
  if (/invalid pdf|no pdf header|bad xref|stream must have data/iu.test(error?.message ?? '')) {
    return new Error('PDF_INVALID')
  }
  return new Error('PDF_INVALID')
}

function cleanMetadataTitle(rawTitle, fallbackTitle) {
  if (typeof rawTitle !== 'string') return fallbackTitle
  const cleaned = rawTitle.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  if (!cleaned || JUNK_TITLE.test(cleaned)) return fallbackTitle
  if (cleaned.toLowerCase() === String(fallbackTitle + '.pdf').toLowerCase()) return fallbackTitle
  return cleaned.slice(0, 180)
}

function shouldInsertSpace(prev, curr, fontSize) {
  if (!prev.str || !curr.str) return false
  if (/\s$/u.test(prev.str) || /^\s/u.test(curr.str)) return false
  const gap = curr.x - (prev.x + prev.width)
  const leftChar = prev.str.at(-1)
  const rightChar = curr.str[0]
  if (CJK_OR_FULLWIDTH.test(leftChar) && CJK_OR_FULLWIDTH.test(rightChar)) return gap > fontSize * 0.8
  if (CJK_OR_FULLWIDTH.test(leftChar) || CJK_OR_FULLWIDTH.test(rightChar)) return gap > fontSize * 0.45
  return gap > fontSize * 0.18
}

export function buildPageLines(items, pageWidth, pageHeight) {
  const glyphs = []
  for (const item of items ?? []) {
    if (typeof item?.str !== 'string' || !item.str) continue
    if (!item.str.trim() && !(item.width > 0)) continue
    const t = Array.isArray(item.transform) ? item.transform : [12, 0, 0, 12, 0, 0]
    const fontSize = Math.max(1, Math.hypot(t[0], t[1]) || item.height || 12)
    const x = Number.isFinite(t[4]) ? t[4] : 0
    const y = Number.isFinite(t[5]) ? t[5] : 0
    const width = Number.isFinite(item.width) && item.width >= 0 ? item.width : 0
    glyphs.push({ str: item.str, x, y, width, fontSize })
  }
  if (!glyphs.length) return []

  glyphs.sort((a, b) => (b.y - a.y) || (a.x - b.x))
  const clusters = []
  for (const glyph of glyphs) {
    const last = clusters.at(-1)
    if (last && Math.abs(glyph.y - last.y) <= Math.max(2, Math.min(glyph.fontSize, last.fontSize) * 0.45)) {
      last.items.push(glyph)
      last.y = (last.y * (last.items.length - 1) + glyph.y) / last.items.length
      last.fontSize = Math.max(last.fontSize, glyph.fontSize)
    } else {
      clusters.push({ y: glyph.y, fontSize: glyph.fontSize, items: [glyph] })
    }
  }

  const lines = []
  for (const cluster of clusters) {
    cluster.items.sort((a, b) => a.x - b.x)
    let text = ''
    let prev = null
    let weightedSize = 0
    let totalLen = 0
    for (const part of cluster.items) {
      if (prev && shouldInsertSpace(prev, part, Math.max(prev.fontSize, part.fontSize))) text += ' '
      text += part.str
      const len = part.str.trim().length
      if (len > 0) {
        weightedSize += part.fontSize * len
        totalLen += len
      }
      prev = part
    }
    const normalized = text.replace(/[ \t]+/gu, ' ').trim()
    if (!normalized) continue
    const first = cluster.items[0]
    const last = cluster.items.at(-1)
    lines.push({
      text: normalized,
      x: first.x,
      right: Math.max(first.x, last.x + last.width),
      y: cluster.y,
      fontSize: totalLen ? weightedSize / totalLen : cluster.fontSize,
      pageWidth,
      pageHeight,
    })
  }
  return lines
}

export function reorderColumns(lines, pageWidth) {
  if (lines.length < 8 || !Number.isFinite(pageWidth) || pageWidth <= 0) {
    return [...lines].sort((a, b) => b.y - a.y)
  }
  let bestGutter = null
  let bestScore = Infinity
  for (const ratio of [0.45, 0.5, 0.55]) {
    const gutter = pageWidth * ratio
    const left = []
    const right = []
    const crossing = []
    for (const line of lines) {
      if (line.x < gutter - 8 && line.right > gutter + 8) crossing.push(line)
      else if (line.right <= gutter + 8) left.push(line)
      else right.push(line)
    }
    if (left.length < 4 || right.length < 4) continue
    const crossingBody = crossing.filter(line => line.text.length >= 6 && line.right - line.x < pageWidth * 0.85).length
    if (crossingBody <= Math.min(left.length, right.length) * 0.25 && crossing.length < bestScore) {
      bestScore = crossing.length
      bestGutter = { left, right, crossing }
    }
  }
  if (!bestGutter) return [...lines].sort((a, b) => b.y - a.y)

  const { left, right, crossing } = bestGutter
  left.sort((a, b) => b.y - a.y)
  right.sort((a, b) => b.y - a.y)
  const colTop = Math.max(left[0].y, right[0].y)
  const colBottom = Math.min(left.at(-1).y, right.at(-1).y)
  const headerLines = crossing.filter(line => line.y > colTop - 4).sort((a, b) => b.y - a.y)
  const footerLines = crossing.filter(line => line.y < colBottom + 4).sort((a, b) => b.y - a.y)
  const middleCrossing = crossing.filter(line => line.y <= colTop - 4 && line.y >= colBottom + 4).sort((a, b) => b.y - a.y)
  if (middleCrossing.length > 2) return [...lines].sort((a, b) => b.y - a.y)
  return [...headerLines, ...left, ...middleCrossing, ...right, ...footerLines]
}

function edgeBands(lines, pageHeight) {
  if (!lines.length || !Number.isFinite(pageHeight) || pageHeight <= 0) return new Set()
  const edge = new Set()
  const topLimit = pageHeight * 0.88
  const bottomLimit = pageHeight * 0.12
  for (const line of lines.slice(0, 2)) {
    if (line.y >= topLimit) edge.add(line)
  }
  for (const line of lines.slice(-2)) {
    if (line.y <= bottomLimit) edge.add(line)
  }
  return edge
}

const edgeTemplate = text => text.replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim()

export function stripRunningHeadersFooters(pages) {
  const total = pages.length
  const pageEdges = pages.map(page => edgeBands(page.lines, page.height))
  const recurring = new Set()
  if (total >= 3) {
    const counts = new Map()
    for (let i = 0; i < total; i++) {
      const seenHere = new Set()
      for (const line of pageEdges[i]) {
        if (line.text.length > 80) continue
        const key = edgeTemplate(line.text)
        if (!key || seenHere.has(key)) continue
        seenHere.add(key)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    const threshold = Math.max(3, Math.ceil(total * 0.4))
    for (const [key, count] of counts) {
      if (count >= threshold) recurring.add(key)
    }
  }
  return pages.map((page, index) => {
    const edge = pageEdges[index]
    const filtered = page.lines.filter(line => {
      if (!edge.has(line)) return true
      if (PAGE_NUMBER_ONLY.test(line.text)) return false
      if (recurring.has(edgeTemplate(line.text))) return false
      return true
    })
    return { ...page, lines: filtered }
  })
}

export function detectGarbledRate(text) {
  let total = 0
  let garbled = 0
  let meaningful = 0
  for (const char of text) {
    total++
    const code = char.codePointAt(0)
    if (char === '\uFFFD' || (code >= 0xE000 && code <= 0xF8FF) ||
      (code < 0x20 && code !== 0x09 && code !== 0x0A && code !== 0x0D)) {
      garbled++
    } else if (MEANINGFUL_CHAR.test(char)) {
      meaningful++
    }
  }
  return { total, garbled, meaningful, rate: total ? garbled / total : 0 }
}

function weightedMedian(entries, fallback) {
  if (!entries.length) return fallback
  const sorted = [...entries].sort((a, b) => a.value - b.value)
  const half = sorted.reduce((sum, item) => sum + item.weight, 0) / 2
  let acc = 0
  for (const item of sorted) {
    acc += item.weight
    if (acc >= half) return item.value
  }
  return sorted.at(-1).value
}

function quantile(values, ratio, fallback) {
  if (!values.length) return fallback
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * ratio)))
  return sorted[index]
}

function joinSoftLine(previous, next) {
  if (/[A-Za-z]-$/u.test(previous) && /^[a-z]/u.test(next)) return previous.slice(0, -1) + next
  if (/[A-Za-z0-9]$/u.test(previous) && /^[A-Za-z0-9]/u.test(next)) return previous + ' ' + next
  return previous + next
}

export function assembleDocumentText(pages, outlinePages = new Set()) {
  const allLines = pages.flatMap(page => page.lines)
  const bodyFontSize = weightedMedian(
    allLines.map(line => ({ value: line.fontSize, weight: line.text.length })),
    12,
  )
  const bodyCandidates = allLines.filter(line => line.text.length >= 12 && line.fontSize <= bodyFontSize * 1.15)
  const marginLeft = quantile(bodyCandidates.map(line => line.x), 0.1, 72)
  const marginRight = quantile(bodyCandidates.map(line => line.right), 0.9, 520)
  const gaps = []
  for (const page of pages) {
    for (let i = 1; i < page.lines.length; i++) {
      const gap = page.lines[i - 1].y - page.lines[i].y
      if (gap > bodyFontSize * 0.5 && gap < bodyFontSize * 4) gaps.push(gap)
    }
  }
  const normalGap = quantile(gaps, 0.5, bodyFontSize * 1.4)
  const headingSize = bodyFontSize * 1.18

  const out = []
  const headings = []
  const pageSlices = []
  let offset = 0
  let prevLine = null
  let prevPageIndex = -1
  let prevWasHeading = false

  for (const page of pages) {
    const sliceStart = offset
    const sliceLines = []
    for (let i = 0; i < page.lines.length; i++) {
      const line = page.lines[i]
      const isHeading = line.fontSize >= headingSize && line.text.length <= 100 && !/[。！？!?；;]$/u.test(line.text)
      const isStrongStyle = Boolean(headingStyle(line.text)?.strong)
      const isScene = SCENE_MARK.test(line.text)
      const hasIndent = line.x - marginLeft >= bodyFontSize * 1.2
      const prevShort = prevLine && prevLine.right < marginRight - bodyFontSize * 2.2
      const prevSentenceEnd = prevLine && SENTENCE_END.test(prevLine.text)
      const crossPage = page.pageIndex !== prevPageIndex
      const largeGap = !crossPage && prevLine && (prevLine.y - line.y > normalGap * 1.35)

      const hardBreak = !out.length ||
        (i === 0 && outlinePages.has(page.pageIndex)) ||
        isHeading || prevWasHeading || isStrongStyle ||
        (prevLine && headingStyle(prevLine.text)?.strong) ||
        isScene || (prevLine && SCENE_MARK.test(prevLine.text)) ||
        hasIndent || largeGap ||
        DIALOGUE_OR_LIST.test(line.text) ||
        (crossPage ? (prevSentenceEnd || prevShort) : (prevShort && prevSentenceEnd))

      if (hardBreak) {
        if (out.length) offset += 1
        const lineOffset = offset
        out.push(line.text)
        offset += line.text.length
        sliceLines.push({ offset: lineOffset, title: line.text.slice(0, 101), y: line.y })
        if (isHeading) headings.push({ offset: lineOffset, tag: line.fontSize >= bodyFontSize * 1.45 ? 'h1' : 'h2' })
      } else {
        const merged = joinSoftLine(out[out.length - 1], line.text)
        offset += merged.length - out[out.length - 1].length
        out[out.length - 1] = merged
      }

      prevLine = line
      prevPageIndex = page.pageIndex
      prevWasHeading = isHeading
    }
    pageSlices.push({ pageIndex: page.pageIndex, start: sliceStart, end: offset, lines: sliceLines })
  }

  return { text: out.join('\n'), pageSlices, headings, bodyFontSize }
}

async function resolveOutline(pdfDoc) {
  let rawOutline
  try {
    rawOutline = await pdfDoc.getOutline()
  } catch {
    return { outline: [], outlineFailed: true }
  }
  if (!Array.isArray(rawOutline) || !rawOutline.length) return { outline: [], outlineFailed: false }

  const flat = []
  let failed = false
  async function walk(nodes, level) {
    if (level > OUTLINE_MAX_DEPTH || flat.length >= OUTLINE_MAX_ITEMS) return
    for (const node of nodes) {
      if (flat.length >= OUTLINE_MAX_ITEMS) break
      if (node?.dest) {
        try {
          const dest = typeof node.dest === 'string' ? await pdfDoc.getDestination(node.dest) : node.dest
          if (Array.isArray(dest) && dest[0] != null) {
            const pageIndex = typeof dest[0] === 'number' && Number.isInteger(dest[0])
              ? dest[0]
              : await pdfDoc.getPageIndex(dest[0])
            const destY = dest[1]?.name === 'XYZ' && typeof dest[3] === 'number'
              ? dest[3]
              : (typeof dest[2] === 'number' ? dest[2] : null)
            flat.push({ title: String(node.title ?? '').trim(), pageIndex, destY, level })
          }
        } catch {
          failed = true
        }
      }
      if (Array.isArray(node?.items) && node.items.length) await walk(node.items, level + 1)
    }
  }
  await walk(rawOutline, 1)
  return { outline: flat, outlineFailed: failed && !flat.length }
}

export async function parsePdf(bytes, fallbackTitle, signal) {
  assertPdfHeader(bytes)
  signal?.throwIfAborted()
  const { getDocument, cMapUrl, standardFontDataUrl } = await loadPdfjs()
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))

  let loadingTask
  let pdfDoc
  try {
    loadingTask = getDocument({
      data: copy,
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0,
    })
    pdfDoc = await loadingTask.promise
    signal?.throwIfAborted()
    if (pdfDoc.numPages > PDF_MAX_PAGES) throw new Error('IMPORT_TOO_LARGE')
    if (pdfDoc.numPages === 0) throw new Error('PDF_NO_TEXT')

    let metadata
    try { metadata = await pdfDoc.getMetadata() } catch { metadata = null }
    const title = cleanMetadataTitle(metadata?.info?.Title, fallbackTitle)
    const { outline, outlineFailed } = await resolveOutline(pdfDoc)
    const outlinePages = new Set(outline.map(entry => entry.pageIndex))

    const rawPages = []
    let totalChars = 0
    for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber++) {
      signal?.throwIfAborted()
      const page = await pdfDoc.getPage(pageNumber)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent({ includeMarkedContent: false })
        const pageLines = reorderColumns(buildPageLines(content.items, viewport.width, viewport.height), viewport.width)
        for (const line of pageLines) {
          totalChars += line.text.length
          if (totalChars > PDF_MAX_CHARS) throw new Error('IMPORT_TOO_LARGE')
        }
        rawPages.push({ pageIndex: pageNumber - 1, width: viewport.width, height: viewport.height, lines: pageLines })
      } finally {
        page.cleanup()
      }
    }

    const cleanedPages = stripRunningHeadersFooters(rawPages)
    let meaningfulTotal = 0
    let nonEmptyPages = 0
    let emptyPages = 0
    let totalExtracted = 0
    let garbledTotal = 0

    for (const page of cleanedPages) {
      const joined = page.lines.map(line => line.text).join('\n')
      const stats = detectGarbledRate(joined)
      totalExtracted += stats.total
      garbledTotal += stats.garbled
      meaningfulTotal += stats.meaningful
      if (stats.meaningful >= 10) nonEmptyPages++
      if (stats.meaningful === 0) emptyPages++
    }

    if (totalExtracted >= 20 && garbledTotal / totalExtracted >= 0.3) {
      throw new Error('PDF_ENCODING_INVALID')
    }
    if (meaningfulTotal < 10) throw new Error('PDF_NO_TEXT')
    if (cleanedPages.length >= 5 && nonEmptyPages / cleanedPages.length < 0.15 && meaningfulTotal / cleanedPages.length < 30) {
      throw new Error('PDF_NO_TEXT')
    }

    const { text, pageSlices, headings } = assembleDocumentText(cleanedPages, outlinePages)
    if (!text.trim()) throw new Error('PDF_NO_TEXT')

    const { cuts, ignoredRanges, sampleOffset, warnings: chapterWarnings } = planPdfChapters(text, {
      pageSlices, headings, outline, outlineFailed,
    })
    const warnings = [...chapterWarnings]
    if (emptyPages >= 3 && emptyPages / cleanedPages.length >= 0.2) warnings.push('PDF_PARTIAL_IMAGE_PAGES')

    const structure = {
      policyVersion: 1,
      ignoredRanges,
      sampleOffset,
      headings,
      resources: pageSlices.filter(slice => slice.start < slice.end).map(slice => slice.start),
    }
    return { title, format: 'pdf', chapters: materializeChapters(text, cuts, title), cuts, structure, warnings }
  } catch (error) {
    throw mapPdfError(error, signal)
  } finally {
    try { await pdfDoc?.cleanup() } catch {}
    try { await loadingTask?.destroy() } catch {}
  }
}
