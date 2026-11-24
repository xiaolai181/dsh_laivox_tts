import { hasSpeakable, isSeparator } from './segment.mjs'

// Which voice each role ends up with, explicit or automatic. Shared by the host
// (planning, audio keys) and the client (the role board shows the same result).
//
// A book carries the rule it was created with (books.voice_rule):
//   1 – the original rule: first unused voice of the role's gender in catalog
//       order. Books made before rule 2 keep it, so their voices and audio keys
//       never change behind the user's back.
//   2 – gender and age: roles carry an age band and LaiVox presets come from the
//       frozen table below; special voices are never assigned automatically.
// Both rules are prefix-stable: a role's automatic voice depends only on the
// roles before it (in book order), so appending a role or choosing a voice by
// hand never changes another role's automatic voice.
export const VOICE_RULES = [1, 2]
export const VOICE_RULE_LATEST = 2
export const ROLE_AGES = ['child', 'teen', 'young', 'middle', 'elder']
const NARRATOR_ID = 'narrator'
const ADULT_BAND = 2

// Match the browser extension's new-book narrator presets. The first is the
// DSH default. It is a public preset, so only a saved override is account-bound.
export const LAIVOX_DEFAULT_NARRATOR = Object.freeze({ voiceId: 'narrator_female' })
export const LAIVOX_RECOMMENDED_NARRATORS = [LAIVOX_DEFAULT_NARRATOR.voiceId, 'male_mastermind']

export function narratorDefaultFor(engine, account, catalog, stored) {
  if (engine !== 'laivox' || !Array.isArray(catalog)) return null
  const usable = voiceId => catalog.some(voice => voice.id === voiceId && voice.usable !== false)
  if (account && stored?.account === account && typeof stored.voiceId === 'string' && usable(stored.voiceId)) return stored
  return usable(LAIVOX_DEFAULT_NARRATOR.voiceId) ? LAIVOX_DEFAULT_NARRATOR : null
}

export function recommendedLaivoxNarrators(catalog) {
  return LAIVOX_RECOMMENDED_NARRATORS.map(id => catalog.find(voice => voice.id === id && voice.usable !== false)).filter(Boolean)
}

// LaiVox presets by gender and age band (幼年/少年/青年/中年/老年), each cell in
// order of preference (plainest voice first). Copied from the LaiVox browser
// extension's preset table, which matches the gateway's preset seed. Rule 2 reads gender and age from this
// table, never from the catalogue, so presets the gateway adds later do not
// change existing books. Changing this table needs a new rule version.
// system_mech and special_manbo are deliberately absent: hand-picked only.
export const LAIVOX_PREFERENCE = {
  female: [['girl_child_lively'], ['girl_teen_bright', 'girl_teen_soft', 'female_sweet'],
    ['woman_young_calm', 'woman_young_vivid', 'narrator_female', 'female_villain'], ['woman_mid_poised', 'woman_mid_mellow'], ['woman_elder_warm']],
  male: [['boy_child_vivid', 'boy_child_soft'], ['male_teen'],
    ['man_young_gentle', 'male_hotblooded', 'narrator_young', 'male_cold_noble'], ['narrator_male', 'man_mid_story', 'man_mid_formal', 'male_mastermind'],
    ['elder_kind', 'man_elder_deep']],
}
const LAIVOX_META = new Map(Object.entries(LAIVOX_PREFERENCE).flatMap(([gender, bands]) =>
  bands.flatMap((ids, band) => ids.map((id, rank) => [id, { gender, band, rank }]))))

// The same filter planning applies before grouping: dividers and text with
// nothing to pronounce never reach an engine.
export function speakableParts(parts) {
  return (parts ?? []).filter(part => !isSeparator(part.text ?? '') && hasSpeakable(part.text))
}

// The audio key carries the segmentation version that produced the part text.
export function edgePrefix(variant, parts) {
  if (variant === 'Hant') return 'zh-TW-'
  const sample = parts.map(part => part.text ?? '').join('')
  const cjk = sample.match(/\p{Script=Han}/gu)?.length ?? 0
  const latin = sample.match(/[A-Za-z]/g)?.length ?? 0
  if (latin >= 8 && latin > cjk) return 'en-'
  return 'zh-CN-'
}

export function normalizeGender(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (['male', 'm', '男'].includes(text)) return 'male'
  if (['female', 'f', '女'].includes(text)) return 'female'
  return ''
}

const roleBand = role => {
  const band = ROLE_AGES.indexOf(role?.age)
  return band < 0 ? ADULT_BAND : band
}

// A saved LaiVox narrator applies only when the work did not pick one and the
// voice is still in this catalog. Other roles keep the automatic order.
function narratorChoice(narrator, engine, automaticId, narratorDefault, catalog) {
  if (narrator.voices?.[engine]) return narrator.voices[engine]
  if (engine === 'laivox' && typeof narratorDefault?.voiceId === 'string') {
    const item = catalog.find(voice => voice.id === narratorDefault.voiceId)
    if (item && item.usable !== false) return item.id
  }
  return automaticId
}

export function voiceAssignments(parts, roles, catalog, engine, variant, rule, narratorDefault = null) {
  if (!VOICE_RULES.includes(rule)) throw new Error('VOICE_RULE_INVALID')
  return rule === 2 ? assignByAge(parts, roles, catalog, engine, variant, narratorDefault) : assignOriginal(parts, roles, catalog, engine, variant, narratorDefault)
}

function enginePool(parts, catalog, engine, variant) {
  // English chapters use en-* voices. A catalog that has none of that prefix
  // falls back to the Chinese list so older fixtures still resolve.
  const prefix = engine === 'edge' ? edgePrefix(variant, parts) : ''
  let pool = engine === 'edge' ? catalog.filter(voice => voice.id.startsWith(prefix)) : catalog
  if (engine === 'edge' && !pool.some(voice => voice.auto !== false)) {
    pool = catalog.filter(voice => voice.id.startsWith(variant === 'Hant' ? 'zh-TW-' : 'zh-CN-'))
  }
  return pool
}

// Rule 1, unchanged since before rule 2 existed: changing it would change the
// voice (and the audio keys) of existing books. tests/fixtures/voice-assignment-v1.json
// locks its output.
function assignOriginal(parts, roles, catalog, engine, variant, narratorDefault = null) {
  // Automatic assignment skips voices marked auto: false (regional accents);
  // an explicit role voice is still validated against the full catalog by chooseVoices.
  const preferred = enginePool(parts, catalog, engine, variant).filter(voice => voice.auto !== false)
  if (!preferred.length) throw new Error('VOICE_CATALOG_EMPTY')
  const byRole = new Map(roles.map(role => [role.id, role]))
  const narrator = byRole.get(NARRATOR_ID) ?? { id: NARRATOR_ID, voices: {} }
  const narratorId = preferred.find(voice => voice.id === 'narrator_female')?.id ?? preferred[0].id
  const voices = new Map([[NARRATOR_ID, narratorChoice(narrator, engine, narratorId, narratorDefault, catalog)]])
  const used = new Set([narratorId])
  for (const role of roles) {
    if (role.id === NARRATOR_ID) continue
    const sameGender = voice => role.gender && [role.gender, role.gender === 'female' ? '女' : '男'].includes(voice.gender)
    const pick = preferred.find(voice => sameGender(voice) && !used.has(voice.id)) ?? preferred.find(voice => !used.has(voice.id))
      ?? preferred.find(sameGender) ?? preferred[voices.size % preferred.length]
    const voice = role.voices?.[engine] || pick.id
    voices.set(role.id, voice)
    used.add(pick.id)
  }
  return voices
}

// Same widening steps as the extension's voice matching: same age band unused →
// adjacent band unused → adjacent band reused → any unused → any.
const PHASES = [
  { unused: true, distance: 0 },
  { unused: true, distance: 1 },
  { unused: false, distance: 1 },
  { unused: true, distance: Infinity },
  { unused: false, distance: Infinity },
]

// Rule 2.
function assignByAge(parts, roles, catalog, engine, variant, narratorDefault = null) {
  const laivox = engine === 'laivox'
  const describe = voice => {
    if (laivox) return LAIVOX_META.get(voice.id)
    return { gender: normalizeGender(voice.gender), band: voice.age === 'child' ? 0 : ADULT_BAND, rank: 0 }
  }
  const order = new Map(catalog.map((voice, index) => [voice.id, index]))
  const known = new Map(catalog.map(voice => [voice.id, voice]))
  const usableVoice = voice => {
    const item = known.get(voice.id)
    return Boolean(item) && item.auto !== false && item.usable !== false
  }
  // Rule 2's LaiVox pool is the frozen table, not whatever the gateway lists
  // today. A missing or unusable preset changes only the role that would have
  // received it. While every preset is usable the pool is the catalogue order
  // of that same table, so the result stays byte for byte.
  let preferred
  if (laivox) {
    preferred = [...LAIVOX_META.keys()].map(id => ({ id }))
    preferred.sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      || [...LAIVOX_META.keys()].indexOf(a.id) - [...LAIVOX_META.keys()].indexOf(b.id))
    if (!preferred.some(usableVoice)) throw new Error('VOICE_CATALOG_EMPTY')
  } else {
    preferred = enginePool(parts, catalog, engine, variant).filter(voice => voice.auto !== false && voice.usable !== false)
    if (!preferred.length) throw new Error('VOICE_CATALOG_EMPTY')
  }
  const byRole = new Map(roles.map(role => [role.id, role]))
  const narrator = byRole.get(NARRATOR_ID) ?? { id: NARRATOR_ID, voices: {} }
  let narratorAuto = laivox ? preferred.find(voice => voice.id === 'narrator_female') : null
  if (laivox && (!narratorAuto || !usableVoice(narratorAuto))) narratorAuto = preferred.find(usableVoice) ?? narratorAuto
  const narratorId = narratorAuto?.id || preferred[0].id
  const voices = new Map([[NARRATOR_ID, narratorChoice(narrator, engine, narratorId, narratorDefault, catalog)]])
  const used = new Set([narratorId])
  for (const role of roles) {
    if (role.id === NARRATOR_ID) continue
    const gender = normalizeGender(role.gender)
    const band = roleBand(role)
    let candidates = gender ? preferred.filter(voice => describe(voice).gender === gender) : preferred
    if (!candidates.length) candidates = preferred
    let pick
    for (const phase of PHASES) {
      const fitting = candidates.filter(voice => (!phase.unused || !used.has(voice.id)) && Math.abs(describe(voice).band - band) <= phase.distance)
      if (!fitting.length) continue
      pick = fitting.reduce((best, voice) => {
        const a = describe(voice)
        const b = describe(best)
        const distance = Math.abs(a.band - band) - Math.abs(b.band - band)
        if (distance) return distance < 0 ? voice : best
        if (a.rank !== b.rank) return a.rank < b.rank ? voice : best
        return order.get(voice.id) < order.get(best.id) ? voice : best
      })
      break
    }
    const frozen = pick
    if (laivox) used.add(frozen.id)
    if (laivox && !usableVoice(frozen)) {
      pick = undefined
      for (const phase of PHASES) {
        const fitting = candidates.filter(voice => usableVoice(voice) && (!phase.unused || !used.has(voice.id)) && Math.abs(describe(voice).band - band) <= phase.distance)
        if (!fitting.length) continue
        pick = fitting.reduce((best, voice) => {
          const a = describe(voice)
          const b = describe(best)
          const distance = Math.abs(a.band - band) - Math.abs(b.band - band)
          if (distance) return distance < 0 ? voice : best
          if (a.rank !== b.rank) return a.rank < b.rank ? voice : best
          return (order.get(voice.id) ?? Number.MAX_SAFE_INTEGER) < (order.get(best.id) ?? Number.MAX_SAFE_INTEGER) ? voice : best
        })
        break
      }
      pick ??= candidates.find(usableVoice) ?? frozen
    }
    voices.set(role.id, role.voices?.[engine] || pick.id)
    if (!laivox) used.add(pick.id)
  }
  return voices
}
