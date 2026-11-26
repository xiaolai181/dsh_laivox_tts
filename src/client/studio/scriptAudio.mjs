import { groupSpeech, segmentChapter, segmentVersion } from '../../domain/segment.mjs'

const FIELDS = ['roleId', 'emotion', 'intensity', 'instruct']

export function scriptGroups(chapter, draft) {
  if (!chapter) return []
  const source = draft ?? chapter.editorial
  const version = segmentVersion(chapter.editorial)
  const segments = draft ? segmentChapter(chapter.text, source?.removed ?? [], version) : (chapter.script ?? segmentChapter(chapter.text ?? '', source?.removed ?? [], version))
  const annotations = source?.annotations ?? {}
  return groupSpeech(segments.map(part => ({ ...part, ...annotations[part.id] })))
}

export function rowChanged(part, annotations, saved) {
  return (part.sourceIds ?? [part.id]).some(id => {
    const next = annotations?.[id] ?? {}
    const previous = saved?.[id] ?? {}
    return FIELDS.some(key => (next[key] ?? undefined) !== (previous[key] ?? undefined))
  })
}

export function rowAudio(part, plan) {
  const hits = (plan?.status === 'ok' ? plan.parts : []).filter(row => row[0] < part.end && row[1] > part.start)
  const ready = hits.filter(row => row[2] === 1).length
  const audio = !hits.length ? 'missing' : ready === hits.length ? 'ready' : ready ? 'partial' : 'missing'
  return { hits, audio }
}

export function rowQueued(part, operation, mode, engine) {
  if (!operation || operation.state !== 'running' || (operation.mode && mode && operation.mode !== mode)) return false
  if (operation.engine && engine && operation.engine !== engine) return false
  if (operation.scope !== 'range') return true
  return (operation.ranges ?? []).some(range => part.start < range[1] && part.end > range[0])
}

export function rowRetakeState(part, operation, mode, engine) {
  if (!operation?.retake) return null
  if (!['queued', 'running', 'paused'].includes(operation.state)) return null
  if ((operation.mode && mode && operation.mode !== mode) || (operation.engine && engine && operation.engine !== engine)) return null
  const hits = operation.scope !== 'range' || (operation.ranges ?? []).some(range => part.start < range[1] && part.end > range[0])
  if (!hits) return null
  return operation.state === 'paused' ? 'paused' : 'active'
}
