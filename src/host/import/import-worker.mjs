import { parentPort } from 'node:worker_threads'
import { parseTxt } from './txt.mjs'
import { parseEpub } from './epub.mjs'
import { suggestCandidates } from './scenes.mjs'

const importErrors = new Set([
  'CHAPTER_EMPTY', 'IMPORT_TOO_LARGE', 'IMPORT_TOO_MANY_CHAPTERS', 'IMPORT_ENCODING_INVALID',
  'EPUB_INVALID', 'EPUB_STRUCTURE_INVALID', 'EPUB_PATH_INVALID', 'EPUB_XML_DOCTYPE',
  'EPUB_ENCRYPTION_METADATA_INVALID', 'EPUB_ENCODING_INVALID', 'EPUB_ENCRYPTED',
  'PDF_INVALID', 'PDF_ENCRYPTED', 'PDF_NO_TEXT', 'PDF_ENCODING_INVALID',
])

parentPort.once('message', async ({ bytes, format, title, encoding, split, text, cuts, structure }) => {
  try {
    const value = format === 'review' ? suggestCandidates(text, cuts, structure)
      : format === 'txt' ? parseTxt(bytes, title, encoding, split)
      : format === 'pdf' ? await (await import('./pdf.mjs')).parsePdf(bytes, title)
      : await parseEpub(bytes, title)
    parentPort.postMessage({ value })
  } catch (error) {
    parentPort.postMessage({ error: importErrors.has(error?.message) ? error.message : 'IMPORT_FAILED' })
  } finally {
    parentPort.close()
  }
})
