import { posix } from 'node:path'
import yauzl from 'yauzl'
import { SaxesParser } from 'saxes'
import { findLocalCuts, materializeChapters } from './chapters.mjs'

const ZIP_LIMIT = 150 * 1024 ** 2
const MAX_ENTRY = 32 * 1024 ** 2
const NEEDED_ENTRIES = new Set(['word/document.xml', 'word/styles.xml'])
const utf8 = new TextDecoder('utf-8', { fatal: true })
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

function safeZipEntryName(name) {
  const clean = String(name ?? '').replaceAll('\\', '/')
  if (!clean || clean.includes('\u0000') || clean.startsWith('/')) throw new Error('DOCX_INVALID')
  const normalized = posix.normalize(clean)
  if (normalized === '..' || normalized.startsWith('../')) throw new Error('DOCX_INVALID')
  return normalized
}

function unpackDocx(bytes, signal) {
  if (bytes.byteLength >= 8 && Buffer.compare(bytes.subarray(0, 8), OLE_MAGIC) === 0) {
    return Promise.reject(new Error('DOCX_ENCRYPTED'))
  }
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(new Error('DOCX_INVALID'))
      let active
      let settled = false
      let total = 0
      const files = new Map()
      function fail(err) {
        if (settled) return
        settled = true
        active?.destroy()
        zip.close()
        signal?.removeEventListener('abort', abort)
        reject(err)
      }
      const abort = () => fail(signal.reason)
      zip.on('error', err => fail(new Error(/encrypt/iu.test(err?.message ?? '') ? 'DOCX_ENCRYPTED' : 'DOCX_INVALID')))
      zip.on('end', () => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        resolve(files)
      })
      zip.on('entry', entry => {
        if (settled) return
        if (entry.generalPurposeBitFlag & 1) return fail(new Error('DOCX_ENCRYPTED'))
        let name
        try { name = safeZipEntryName(entry.fileName) } catch (err) { return fail(err) }
        if (name === 'EncryptionInfo' || name === 'EncryptedPackage') return fail(new Error('DOCX_ENCRYPTED'))
        if (entry.fileName.endsWith('/') || !NEEDED_ENTRIES.has(name)) { zip.readEntry(); return }
        if (entry.uncompressedSize > MAX_ENTRY || entry.uncompressedSize + total > ZIP_LIMIT || files.has(name)) {
          return fail(new Error('IMPORT_TOO_LARGE'))
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (settled) return
          if (streamErr) return fail(new Error('DOCX_INVALID'))
          active = stream
          const chunks = []
          let entryBytes = 0
          stream.on('data', chunk => {
            if (settled) return
            entryBytes += chunk.byteLength
            total += chunk.byteLength
            if (entryBytes > MAX_ENTRY || total > ZIP_LIMIT) {
              return fail(new Error('IMPORT_TOO_LARGE'))
            }
            chunks.push(chunk)
          })
          stream.on('error', err => fail(new Error(/too many bytes/iu.test(err?.message ?? '') ? 'IMPORT_TOO_LARGE' : 'DOCX_INVALID')))
          stream.on('end', () => {
            if (settled) return
            files.set(name, Buffer.concat(chunks))
            active = undefined
            if (!signal?.aborted) zip.readEntry()
          })
        })
      })
      if (signal?.aborted) return abort()
      if (zip.entryCount > 15_000) return fail(new Error('IMPORT_TOO_LARGE'))
      signal?.addEventListener('abort', abort, { once: true })
      zip.readEntry()
    })
  })
}

function parseStyleNames(bytes) {
  const map = new Map()
  if (!bytes) return map
  let currentId = null
  let depth = 0
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw new Error('DOCX_INVALID') })
  parser.on('error', () => { throw new Error('DOCX_INVALID') })
  parser.on('opentag', tag => {
    depth++
    if (depth > 160) throw new Error('DOCX_INVALID')
    const val = tag.attributes.val?.value ?? tag.attributes['w:val']?.value
    const styleId = tag.attributes.styleId?.value ?? tag.attributes['w:styleId']?.value
    if (tag.local === 'style' && styleId) currentId = styleId
    else if (tag.local === 'name' && currentId && val) map.set(currentId, val)
  })
  parser.on('closetag', tag => {
    depth--
    if (tag.local === 'style') currentId = null
  })
  try {
    parser.write(utf8.decode(bytes)).close()
  } catch (err) {
    if (err.message === 'DOCX_INVALID') throw err
    throw new Error('DOCX_INVALID')
  }
  return map
}

function headingTagFor(styleId, styleNames) {
  if (!styleId) return null
  const label = (styleNames.get(styleId) ?? styleId).normalize('NFKC').trim().toLowerCase()
  if (/^(?:heading\s*1|标题\s*1|title|1)$/u.test(label)) return 'h1'
  if (/^(?:heading\s*2|标题\s*2|subtitle|2)$/u.test(label)) return 'h2'
  return null
}

function extractParagraphs(bytes, styleNames) {
  if (!bytes) throw new Error('DOCX_INVALID')
  let xml
  try { xml = utf8.decode(bytes) } catch { throw new Error('IMPORT_ENCODING_INVALID') }
  const paragraphs = []
  let depth = 0
  let inParagraph = false
  let inText = false
  let currentText = ''
  let currentStyle = null

  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw new Error('DOCX_INVALID') })
  parser.on('error', () => { throw new Error('DOCX_INVALID') })
  parser.on('opentag', tag => {
    depth++
    if (depth > 160) throw new Error('DOCX_INVALID')
    if (tag.local === 'p' && !inParagraph) {
      inParagraph = true
      currentText = ''
      currentStyle = null
    } else if (inParagraph && tag.local === 'pStyle') {
      currentStyle = tag.attributes.val?.value ?? tag.attributes['w:val']?.value ?? null
    } else if (inParagraph && (tag.local === 't' || tag.local === 'delText')) {
      if (tag.local === 't') inText = true
    } else if (inParagraph && tag.local === 'tab') {
      currentText += ' '
    } else if (inParagraph && (tag.local === 'br' || tag.local === 'cr')) {
      currentText += '\n'
    }
  })
  parser.on('text', value => {
    if (inParagraph && inText) currentText += value
  })
  parser.on('closetag', tag => {
    depth--
    if (tag.local === 't') inText = false
    else if (tag.local === 'p' && inParagraph) {
      const clean = currentText.replace(/\r\n?/g, '\n').trim()
      if (clean) paragraphs.push({ text: clean, heading: headingTagFor(currentStyle, styleNames) })
      inParagraph = false
      inText = false
    }
  })
  parser.write(xml).close()
  return paragraphs
}

export async function parseDocx(bytes, title, signal) {
  const files = await unpackDocx(bytes, signal)
  const docBytes = files.get('word/document.xml')
  if (!docBytes) throw new Error('DOCX_INVALID')
  const styleNames = parseStyleNames(files.get('word/styles.xml'))
  const paragraphs = extractParagraphs(docBytes, styleNames)
  if (!paragraphs.length) throw new Error('CHAPTER_EMPTY')

  const lines = []
  const headings = []
  let offset = 0
  for (const para of paragraphs) {
    if (para.heading) headings.push({ offset, tag: para.heading })
    lines.push(para.text)
    offset += para.text.length + 1
  }
  const text = lines.join('\n').trim()
  if (!text) throw new Error('CHAPTER_EMPTY')

  const structure = { headings }
  let cuts = findLocalCuts(text, structure)
  if (!cuts.length && headings.length >= 2) {
    const h1 = headings.filter(h => h.tag === 'h1')
    const chosen = h1.length >= 2 ? h1 : headings
    cuts = chosen.map(h => {
      const end = text.indexOf('\n', h.offset)
      return { offset: h.offset, title: text.slice(h.offset, end < 0 ? text.length : end).trim().slice(0, 100), kind: 'structure' }
    })
  }
  const chapters = materializeChapters(text, cuts, title)
  return { title, chapters, format: 'docx', encoding: 'utf-8', split: true, cuts, structure }
}
