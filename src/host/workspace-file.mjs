// Reading one TXT/EPUB from a conversation's working directory through DSH's
// filesystem service (laivox_import_file and delivered files). Only files
// inside that directory are read: the sandbox confines writes, not reads.
import { basename, extname } from 'node:path'
import { IMPORT_LIMIT } from './import/index.mjs'

export const IMPORTABLE = ['.txt', '.epub', '.pdf']

const fsCodes = {
  FS_NOT_FOUND: 'FILE_NOT_FOUND', FS_NOT_DIRECTORY: 'FILE_NOT_FOUND', FS_NOT_REGULAR_FILE: 'FILE_NOT_FOUND',
  FS_PERMISSION_DENIED: 'FILE_ACCESS_DENIED', FS_SANDBOX_DENIED: 'FILE_ACCESS_DENIED', FS_TOO_LARGE: 'IMPORT_TOO_LARGE',
  WORKING_DIRECTORY_UNAVAILABLE: 'FILE_ACCESS_UNAVAILABLE', SESSION_QUERY_EVENT_NOT_FOUND: 'FILE_NOT_FOUND',
}
const known = new Set(['FILE_NOT_FOUND', 'FILE_ACCESS_DENIED', 'FILE_ACCESS_UNAVAILABLE', 'IMPORT_TOO_LARGE', 'IMPORT_TYPE_INVALID'])

// Filesystem and session-query failures in this plugin's vocabulary.
export function fileError(error) {
  if (error?.name === 'AbortError') return error
  if (known.has(error?.message)) return error
  return new Error(fsCodes[error?.code] ?? 'FILE_READ_FAILED')
}

// The file's name and whether it can be imported, from its path alone.
export function fileKind(path) {
  const clean = String(path ?? '').replaceAll('\\', '/')
  const format = extname(clean).toLowerCase()
  return { name: basename(clean), format, importable: IMPORTABLE.includes(format) }
}

// The bytes of `path` (absolute, or relative to `cwd`), at most IMPORT_LIMIT.
export async function readWorkspaceFile({ fs, cwd, path, signal }) {
  if (!fs || !cwd) throw new Error('FILE_ACCESS_UNAVAILABLE')
  if (!fileKind(path).importable) throw new Error('IMPORT_TYPE_INVALID')
  try {
    const [root, target] = await Promise.all([fs.resolve(cwd, { signal }), fs.resolve(path, { cwd, signal })])
    if (!fs.contains(root, target)) throw new Error('FILE_ACCESS_DENIED')
    const info = await fs.stat(target, signal)
    if (!info || info.type !== 'file') throw new Error('FILE_NOT_FOUND')
    if (Number.isFinite(info.size) && info.size > IMPORT_LIMIT) throw new Error('IMPORT_TOO_LARGE')
    return await fs.readBytes(target, signal, IMPORT_LIMIT)
  } catch (error) { throw fileError(error) }
}

// A file the agent delivered. The host already resolved the path, so it is not
// required to sit inside the session's working directory. realpath, the size
// cap and a read-only stat stay.
export async function readDeliveredFile({ fs, cwd, path, signal }) {
  if (!fs) throw new Error('FILE_ACCESS_UNAVAILABLE')
  if (!fileKind(path).importable) throw new Error('IMPORT_TYPE_INVALID')
  try {
    const target = await fs.resolve(path, { cwd, signal })
    const info = await fs.stat(target, signal)
    if (!info || info.type !== 'file') throw new Error('FILE_NOT_FOUND')
    if (Number.isFinite(info.size) && info.size > IMPORT_LIMIT) throw new Error('IMPORT_TOO_LARGE')
    return await fs.readBytes(target, signal, IMPORT_LIMIT)
  } catch (error) { throw fileError(error) }
}
