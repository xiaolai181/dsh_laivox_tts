import { isSeparator, iterateChapterSegments, SEGMENT_VERSION, segmentVersion } from './segment.mjs'
import { emotions } from './production.mjs'

export function hasReusableScript(chapter, roles) {
  const saved = chapter.editorial
  if (!saved?.cast || ![1, SEGMENT_VERSION].includes(segmentVersion(saved)) || !Array.isArray(saved.removed)) return false
  const ids = new Set(['narrator', ...roles.map(role => role.id)])
  let spoken = false
  for (const { id, text } of iterateChapterSegments(chapter.text, saved.removed, segmentVersion(saved))) {
    if (isSeparator(text)) continue
    spoken = true
    const item = saved.annotations?.[id]
    if (!ids.has(item?.roleId) || !emotions.includes(item.emotion) || ![0, 1, 2].includes(item.intensity)) return false
  }
  return spoken
}

export function resolveGenerationOptions(input, chapter, roles) {
  const { engine, mode, purpose = 'generate' } = input
  if (!['edge', 'laivox'].includes(engine) || !['reading', 'multi'].includes(mode) ||
      !['generate', 'clean', 'cast'].includes(purpose)) throw new Error('INVALID_INPUT')
  const clean = purpose === 'clean' || (purpose === 'generate' && input.clean === true)
  const cast = purpose === 'cast' || (purpose === 'generate' && mode === 'multi' &&
    (clean || !hasReusableScript(chapter, roles)))
  return { engine, mode, purpose, clean, cast, reuse: !clean && Boolean(chapter.editorial) }
}
