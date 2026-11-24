import { speakableParts, voiceAssignments } from '../../domain/voice-assignment.mjs'
import { scriptVariant } from '../../domain/text.mjs'

export { narratorDefaultFor } from '../../domain/voice-assignment.mjs'

// The voice each role gets, computed exactly as planning does (same rule, same
// parts filter, same catalogue). null while the catalogue is unknown.
export function effectiveVoices(chapter, roles, catalog, engine, rule = chapter?.voiceRule, narratorDefault = null) {
  if (!chapter || !Array.isArray(catalog) || !catalog.length) return null
  try {
    return voiceAssignments(speakableParts(chapter.script ?? []), roles ?? [], catalog, engine, scriptVariant(chapter.text ?? ''), rule,
      engine === 'laivox' ? narratorDefault : null)
  } catch { return null }
}

// Roles whose automatic voice differs between two assignments. A role whose
// voice for this engine is chosen by hand is left out: its voice is what the
// user asked for.
export function changedAutomaticVoices(before, after, roles, engine) {
  if (!before || !after) return []
  return (roles ?? []).filter(role => role.id !== 'narrator' && !role.voices?.[engine]
    && before.has(role.id) && after.has(role.id) && before.get(role.id) !== after.get(role.id))
    .map(role => ({ role, from: before.get(role.id), to: after.get(role.id) }))
}

// Another role in `candidates` that ends up with the same voice, if any.
export function sharedVoice(role, voices, candidates) {
  if (!voices || !voices.has(role.id)) return null
  const voice = voices.get(role.id)
  return candidates.find(other => other.id !== role.id && voices.get(other.id) === voice) ?? null
}
