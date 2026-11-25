import { SEGMENT_VERSION, segmentVersion, segmentChapter, sourceLines } from './segment.mjs'
import { normalizeInstruct } from './voice-direction.mjs'
import { LAIVOX_DEFAULT_NARRATOR } from './voice-assignment.mjs'

// While a new production is unfinished, playback stays on the previous complete
// version. Set to false only to restore the old behaviour (a new job takes over
// the player as soon as it is created). Host and client both read this.
export const KEEP_PREVIOUS_AUDIO = true
// A part may be submitted again under a new request id at most this many times.
export const MAX_RESUBMITS = 2

export const emotions = ['neutral', 'happy', 'sad', 'angry', 'afraid', 'tense', 'gentle']
export const narrator = { id: 'narrator', name: '旁白', gender: '', voices: {} }
export const roleNameKey = name => name.normalize('NFKC').trim().toLowerCase()
export const defaultSettings = { theme: 'system', skin: 'paper', paragraphPause: true, engine: 'edge', mode: 'reading', clean: false, selection: null, autoContinue: true, audioLimit: 2 * 1024 ** 3, chatDock: 'auto', miniCapsule: 'auto', snippetRetention: '7d', laivoxNarratorDefault: LAIVOX_DEFAULT_NARRATOR,
  // Voices for instant speech, by the language of the text.
  speechVoices: { 'zh-CN': 'zh-CN-XiaoxiaoNeural', 'zh-TW': 'zh-TW-HsiaoChenNeural', en: 'en-US-AriaNeural' } }

export function validateProductionPatch(current, value, roles, complete = true) {
  if (value == null) return null
  const { removed, annotations } = value
  const count = sourceLines(current.text).length
  if (!Array.isArray(removed) || removed.some(id => !Number.isInteger(id) || id < 0 || id >= count) ||
      !annotations || typeof annotations !== 'object' || Array.isArray(annotations)) throw new Error('INVALID_INPUT')
  const version = value.version ?? segmentVersion(current.editorial)
  if (![1, SEGMENT_VERSION].includes(version) || version !== segmentVersion(current.editorial)) throw new Error('INVALID_INPUT')
  const segments = segmentChapter(current.text, removed, version)
  const known = new Set([narrator.id, ...roles.map(role => role.id)])
  const checked = {}
  for (const [key, item] of Object.entries(annotations)) {
    const id = Number(key)
    if (String(id) !== key || !Number.isSafeInteger(id) || !segments[id] || !known.has(item?.roleId) ||
        !emotions.includes(item.emotion) || ![0, 1, 2].includes(item.intensity) ||
        (item.instruct != null && typeof item.instruct !== 'string')) throw new Error('INVALID_INPUT')
    // A blank or non-compliant direction is dropped rather than rejected, so
    // the segment falls back to the legacy behavior for its emotion.
    const instruct = normalizeInstruct(item.instruct)
    checked[id] = { id, roleId: item.roleId, emotion: item.emotion, intensity: item.emotion === 'neutral' ? 0 : item.intensity,
      ...(instruct ? { instruct } : {}) }
  }
  if (complete) for (const { id } of segments) checked[id] ??= { id, roleId: narrator.id, emotion: 'neutral', intensity: 0 }
  return { removed: [...new Set(removed)], annotations: checked, version,
    cast: complete ? segments.length > 0 : value.cast === true,
    cleaned: Boolean(current.editorial?.cleaned || current.editorial?.removed?.length),
    resultJob: current.editorial?.resultJob ?? null }
}
