// "导入到 LaiVox" on a file the agent delivered in the conversation. The
// host's file-action seat only passes an action route (for opening the file on
// the desktop); it carries the delivery's session event coordinates. With them
// the file's path is read from that event (sessionQuery) and the file itself
// through the session's filesystem, inside its working directory — the same
// checks as laivox_import_file. Missing services or an unknown route format
// just mean no button.
import { fileKind, fileError, readDeliveredFile } from './workspace-file.mjs'

const DIGITS = /^\d{1,12}$/u

// sessionId/seq/index from the host's `api/present.open?...` route, or null.
export function deliveryCoordinates(actionUrl) {
  if (typeof actionUrl !== 'string' || actionUrl.length > 2048) return null
  let url
  try { url = new URL(actionUrl, 'http://host.invalid/') } catch { return null }
  if (!url.pathname.endsWith('/api/present.open')) return null
  const sessionId = url.searchParams.get('sessionId')
  const seq = url.searchParams.get('seq')
  const index = url.searchParams.get('index')
  if (!sessionId || sessionId.length > 180 || !DIGITS.test(seq ?? '') || !DIGITS.test(index ?? '')) return null
  return { sessionId, seq: Number(seq), index: Number(index) }
}

export function createDeliverableImports({ services, imports }) {
  // The delivered file's path and the session's working directory.
  async function locate(actionUrl, signal) {
    const where = deliveryCoordinates(actionUrl)
    if (!where) throw new Error('INVALID_INPUT')
    const sessionQuery = services.sessionQuery?.()
    if (!sessionQuery) throw new Error('FILE_ACCESS_UNAVAILABLE')
    let read
    try { read = await sessionQuery.readEvent({ sessionId: where.sessionId, seq: where.seq, before: 0, after: 0 }, signal) }
    catch (error) { throw fileError(error) }
    const target = read?.target
    const file = target?.type === 'deliverables/presented' && Array.isArray(target.data?.files) ? target.data.files[where.index] : undefined
    if (typeof file?.path !== 'string' || !file.path.trim()) throw new Error('FILE_NOT_FOUND')
    const cwd = read.session?.cwd ?? services.workspaceRoot?.()
    return { ...where, path: file.path, cwd }
  }
  return {
    // Whether to show the button: the file's name and type, nothing read yet.
    async describe(actionUrl, signal) {
      const { path, cwd } = await locate(actionUrl, signal)
      const { name } = fileKind(path)
      try {
        await readDeliveredFile({ fs: services.fs?.(), cwd, path, signal })
        return { name, importable: true }
      } catch { return { name, importable: false } }
    },
    // Stage the file as an import preview of its conversation.
    async stage(actionUrl, signal) {
      const { path, cwd, sessionId } = await locate(actionUrl, signal)
      const bytes = await readDeliveredFile({ fs: services.fs?.(), cwd, path, signal })
      const preview = await imports.stage(fileKind(path).name, [bytes], sessionId, signal)
      return { id: preview.id, session: sessionId, title: preview.title }
    },
  }
}
