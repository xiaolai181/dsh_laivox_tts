import { posix } from 'node:path'
import yauzl from 'yauzl'
import { SaxesParser } from 'saxes'
import { parse } from 'parse5'
import { materializeChapters } from './chapters.mjs'
import { isAuxiliaryAnchor, planEpubChapters } from './epub-chapters.mjs'

export const ZIP_LIMIT = 150 * 1024 ** 2
const MAX_ENTRY = 32 * 1024 ** 2
const utf8 = new TextDecoder('utf-8', { fatal: true })
const hiddenTags = new Set(['head', 'script', 'style', 'iframe', 'object', 'noscript', 'template', 'svg', 'math', 'rt', 'rp', 'nav'])
const blockTags = new Set(['p', 'div', 'section', 'article', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'hr'])

const ncxDoctype = /^\s*ncx(?:\s+(?:PUBLIC\s+(?:"[^"]*"|'[^']*')\s+|SYSTEM\s+)(?:"[^"]*"|'[^']*'))?\s*$/u

function decodeDocument(bytes, legacyHtml = false) {
  try {
    let decoder = utf8
    if (bytes[0] === 0xff && bytes[1] === 0xfe) decoder = new TextDecoder('utf-16le', { fatal: true })
    if (bytes[0] === 0xfe && bytes[1] === 0xff) decoder = new TextDecoder('utf-16be', { fatal: true })
    return decoder.decode(bytes)
  } catch {
    const header = Buffer.from(bytes.subarray(0, 4096)).toString('latin1')
    const encoding = /<\?xml\b[^>]*\bencoding\s*=\s*["'](gbk|gb2312|gb18030)["']/iu.test(header)
      || /<meta\b[^>]*\bcharset\s*=\s*["']?(gbk|gb2312|gb18030)(?=[\s"';/>])/iu.test(header)
    if (legacyHtml && encoding) {
      try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes) }
      catch { /* Normalize decoding errors at the worker boundary. */ }
    }
    throw new Error('EPUB_ENCODING_INVALID')
  }
}

function xmlTree(bytes, purpose) {
  if (!bytes) throw new Error('EPUB_STRUCTURE_INVALID')
  const root = { children: [], text: '' }
  const stack = [root]
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', value => {
    if (purpose !== 'ncx' || !ncxDoctype.test(value)) throw new Error('EPUB_XML_DOCTYPE')
  })
  parser.on('error', () => { throw new Error('EPUB_STRUCTURE_INVALID') })
  parser.on('opentag', tag => {
    if (stack.length > 100) throw new Error('EPUB_STRUCTURE_INVALID')
    const attr = Object.fromEntries(Object.values(tag.attributes).map(item => [item.local, item.value]))
    const node = { tag: tag.local, attr, children: [], text: '' }
    stack.at(-1).children.push(node)
    stack.push(node)
  })
  parser.on('text', text => { stack.at(-1).text += text })
  parser.on('closetag', () => stack.pop())
  parser.write(decodeDocument(bytes)).close()
  if (purpose && (root.children.length !== 1 || root.children[0].tag !== purpose)) throw new Error('EPUB_STRUCTURE_INVALID')
  return root
}

function find(node, tag) {
  return node ? [ ...(node.tag === tag ? [node] : []), ...node.children.flatMap(child => find(child, tag)) ] : []
}

function localPath(base, href) {
  let value
  try { value = decodeURIComponent((href ?? '').split(/[?#]/u)[0]) } catch { throw new Error('EPUB_PATH_INVALID') }
  if (!value || /[:\\\u0000]/u.test(value) || value.startsWith('/')) throw new Error('EPUB_PATH_INVALID')
  const path = posix.normalize(posix.join(base, value))
  if (path === '..' || path.startsWith('../')) throw new Error('EPUB_PATH_INVALID')
  return path
}

function unpack(bytes, signal) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error) return reject(new Error('EPUB_INVALID'))
      let active
      let total = 0
      const files = new Map()
      function fail(error) {
        active?.destroy()
        zip.close()
        signal?.removeEventListener('abort', abort)
        reject(error)
      }
      const abort = () => fail(signal.reason)
      zip.on('error', () => fail(new Error('EPUB_INVALID')))
      zip.on('end', () => { signal?.removeEventListener('abort', abort); resolve(files) })
      zip.on('entry', entry => {
        if (entry.generalPurposeBitFlag & 1) return fail(new Error('EPUB_ENCRYPTED'))
        if (entry.fileName.endsWith('/')) { zip.readEntry(); return }
        if (entry.uncompressedSize > MAX_ENTRY || entry.uncompressedSize + total > ZIP_LIMIT || files.has(entry.fileName)) {
          fail(new Error('IMPORT_TOO_LARGE')); return
        }
        total += entry.uncompressedSize
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(new Error('EPUB_INVALID'))
          active = stream
          const chunks = []
          stream.on('data', data => chunks.push(data))
          stream.on('error', () => fail(new Error('EPUB_INVALID')))
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks))
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

function attr(node, name) {
  return node.attrs?.find(item => item.name === name || (item.prefix && item.prefix + ':' + item.name === name))?.value
}

function readHtml(bytes) {
  const decoded = decodeDocument(bytes, true)
  if (decoded.includes('\0')) throw new Error('EPUB_ENCODING_INVALID')
  const root = parse(decoded)
  const lines = ['']
  const names = []
  const markers = []
  const roles = []
  const newline = () => lines.push('')
  function visit(node, depth) {
    if (depth > 160) throw new Error('EPUB_STRUCTURE_INVALID')
    const tag = node.tagName
    if (hiddenTags.has(tag) || node.attrs?.some(({ name, value }) => name === 'hidden' || (name === 'aria-hidden' && value === 'true') || (name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(value)))) return
    if (node.nodeName === '#text') {
      lines[lines.length - 1] += node.value.replace(/\s+/gu, ' ')
      return
    }
    const tokens = [...(attr(node, 'epub:type') ?? '').split(/\s+/u), ...(attr(node, 'role') ?? '').split(/\s+/u)]
    const auxiliary = tokens.some(token => /^(?:doc-)?(?:toc|footnotes?|endnotes?|noteref|pagebreak|index)$/u.test(token))
    const chapter = tokens.includes('chapter')
    const block = chapter || blockTags.has(tag)
    if (block) newline()
    const at = lines.length - 1
    const anchor = attr(node, 'id') ?? (tag === 'a' ? attr(node, 'name') : undefined)
    if (anchor) names.push([anchor, at, auxiliary])
    if (chapter || /^h[1-6]$/u.test(tag ?? '')) markers.push([at, chapter ? 'epub:chapter' : tag])
    for (const child of node.childNodes ?? []) visit(child, depth + 1)
    if (auxiliary) roles.push([at, lines.length])
    else if (anchor && isAuxiliaryAnchor(anchor)) roles.push([at, at + 1])
    if (block) newline()
  }
  visit(root, 0)
  const normalized = []
  const offsets = []
  let offset = 0
  for (const line of lines) {
    const text = line.trim()
    offsets.push(offset)
    if (text) { normalized.push(text); offset += text.length + 1 }
  }
  const text = normalized.join('\n')
  offsets.push(text.length)
  const ids = new Map()
  for (const [name, index, auxiliary] of names) {
    if (ids.has(name)) ids.set(name, null)
    else ids.set(name, { offset: offsets[index], auxiliary })
  }
  return { text, ids,
    ignored: roles.map(([start, end]) => [offsets[start], Math.min(text.length, offsets[end])]),
    headings: markers.map(([i, tag]) => ({ offset: offsets[i], tag })).filter(item => item.offset < text.length) }
}

const optionalErrors = new Set(['EPUB_PATH_INVALID', 'EPUB_STRUCTURE_INVALID', 'EPUB_ENCODING_INVALID', 'EPUB_XML_DOCTYPE'])

function chapterLinks(files, items, opf, toc, encrypted) {
  const nav = items.find(item => (item.attr.properties ?? '').split(/\s+/u).includes('nav'))
  const ncx = items.find(item => toc && item.attr.id === toc)
    ?? items.find(item => item.attr['media-type'] === 'application/x-dtbncx+xml')
  let failed = false
  function read(item, source, navigate) {
    if (!item) return []
    const links = []
    try {
      const path = localPath(posix.dirname(opf), item.attr.href)
      const data = files.get(path)
      if (!data || encrypted.has(path)) throw new Error('EPUB_STRUCTURE_INVALID')
      navigate(data, (href, title) => {
        if (!href || !title?.trim()) return
        const [target, fragment] = href.trim().split('#', 2)
        try {
          links.push({ path: target ? localPath(posix.dirname(path), target) : path,
            fragment: fragment ? decodeURIComponent(fragment) : undefined, title: title.trim().slice(0, 180), order: links.length })
        } catch (error) {
          if (!(error instanceof URIError) && !optionalErrors.has(error.message)) throw error
          failed = true
        }
      })
    } catch (error) {
      if (!optionalErrors.has(error.message)) throw error
      failed = true
      return []
    }
    return links.map(link => ({ ...link, source }))
  }
  const navLinks = read(nav, 'nav', (data, add) => {
    function label(node, depth) {
      if (depth > 160) throw new Error('EPUB_STRUCTURE_INVALID')
      return node.value ?? (node.childNodes ?? []).map(child => label(child, depth + 1)).join('')
    }
    function visit(node, depth, inside = false) {
      if (depth > 160) throw new Error('EPUB_STRUCTURE_INVALID')
      if (node.tagName === 'nav') {
        inside = (attr(node, 'epub:type') ?? '').split(/\s+/u).includes('toc') || attr(node, 'role') === 'doc-toc'
      }
      if (inside && node.tagName === 'a') add(attr(node, 'href'), label(node, depth))
      for (const child of node.childNodes ?? []) visit(child, depth + 1, inside)
    }
    visit(parse(decodeDocument(data)), 0)
  })
  const ncxLinks = read(ncx, 'ncx', (data, add) => {
    for (const map of find(xmlTree(data, 'ncx'), 'navMap')) {
      for (const point of find(map, 'navPoint')) {
        add(point.children.find(child => child.tag === 'content')?.attr.src,
          find(point.children.find(child => child.tag === 'navLabel'), 'text')[0]?.text)
      }
    }
  })
  return { navLinks, ncxLinks, failed }
}

function encryptedPaths(files, readingPaths) {
  const data = files.get('META-INF/encryption.xml')
  if (!data) return new Set()
  try {
    const tree = xmlTree(data, 'encryption')
    const paths = new Set(find(tree, 'CipherReference').map(node => localPath('', node.attr.URI)))
    if ([...paths].some(path => readingPaths.has(path))) throw new Error('EPUB_ENCRYPTED')
    const entries = find(tree, 'EncryptedData')
    if (!entries.length || entries.some(entry => !find(entry, 'CipherReference').length)) {
      throw new Error('EPUB_ENCRYPTION_METADATA_INVALID')
    }
    return paths
  } catch (error) {
    if (!optionalErrors.has(error.message)) throw error
    throw new Error('EPUB_ENCRYPTION_METADATA_INVALID')
  }
}

export async function parseEpub(bytes, fallbackTitle, signal) {
  const files = await unpack(bytes, signal)
  const container = xmlTree(files.get('META-INF/container.xml'), 'container')
  const opf = localPath('', find(container, 'rootfile')[0]?.attr['full-path'])
  const packageNode = xmlTree(files.get(opf), 'package').children[0]
  const title = find(packageNode, 'title')[0]?.text.trim().slice(0, 180) || fallbackTitle
  const manifestNode = packageNode.children.find(node => node.tag === 'manifest')
  const spineNode = packageNode.children.find(node => node.tag === 'spine')
  if (!manifestNode || !spineNode) throw new Error('EPUB_STRUCTURE_INVALID')
  const items = manifestNode.children.filter(node => node.tag === 'item')
  const manifest = new Map(items.map(item => [item.attr.id, item.attr]))
  const spine = spineNode.children.filter(item => item.tag === 'itemref' && item.attr.linear !== 'no')
  if (spine.length > 5000) throw new Error('IMPORT_TOO_MANY_CHAPTERS')
  const readingPaths = []
  for (const item of spine) {
    const resource = manifest.get(item.attr.idref)
    if (!resource) throw new Error('EPUB_STRUCTURE_INVALID')
    const path = localPath(posix.dirname(opf), resource.href)
    if (!files.has(path)) throw new Error('EPUB_STRUCTURE_INVALID')
    if (['application/xhtml+xml', 'text/html'].includes(resource['media-type'])) readingPaths.push(path)
  }
  const encrypted = encryptedPaths(files, new Set(readingPaths))
  const links = chapterLinks(files, items, opf, spineNode.attr.toc, encrypted)
  const ordered = []
  const resources = []
  let offset = 0
  for (const path of readingPaths) {
    signal?.throwIfAborted()
    const { text, ids, headings, ignored } = readHtml(files.get(path))
    if (!text) continue
    ordered.push(text)
    resources.push({ path, start: offset, end: offset + text.length, ids,
      headings: headings.map(item => ({ ...item, offset: offset + item.offset })),
      ignored: ignored.map(([first, last]) => [offset + first, offset + last]) })
    offset += text.length + 1
  }
  const text = ordered.join('\n')
  const { cuts, warnings, ignoredRanges, sampleOffset } = planEpubChapters(text, resources, links)
  // Keep only compact offsets and evidence needed by an eventual opt-in model review.
  const structure = { policyVersion: 1, ignoredRanges, sampleOffset,
    resources: resources.map(resource => resource.start), headings: resources.flatMap(resource => resource.headings) }
  return { title, format: 'epub', chapters: materializeChapters(text, cuts, title), cuts, structure, warnings }
}
