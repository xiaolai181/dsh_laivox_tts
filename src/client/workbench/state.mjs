import { defaultSettings, narrator } from '../../domain/production.mjs'

export const lastChapterKey = 'dsh-laivox-tts-last-chapter'
export const legacyLastChapterKey = 'laivox-novel-audio-last-chapter'
export function lastChapter() {
  try {
    const current = localStorage.getItem(lastChapterKey)
    if (current) return current
    const legacy = localStorage.getItem(legacyLastChapterKey)
    if (!legacy) return null
    try { localStorage.setItem(lastChapterKey, legacy) } catch { /* the legacy key still answers this read */ }
    return legacy
  } catch { return null }
}
export function clearLastChapter() {
  try { localStorage.removeItem(lastChapterKey) } catch { /* storage may be blocked */ }
  try { localStorage.removeItem(legacyLastChapterKey) } catch { /* storage may be blocked */ }
}
export function createWorkbenchMemory() {
  return { immersive: true, skin: 'paper', activeId: lastChapter(), drafts: new Map(), scripts: new Map(), roles: new Map(),
    operations: new Map(), settings: { revision: 0, values: defaultSettings }, options: null }
}

export const chapterBase = chapter => chapter && ({
  rev: chapter.rev, rolesRev: chapter.rolesRev, editorialResultJob: chapter.editorialResultJob ?? null,
})

export function roleDraftUpdate(draft, chapter, patch) {
  const baseline = draft?.baseline ?? new Map(chapter.roles.map(role => [role.id, role]))
  const patches = new Map(draft?.patches)
  const prior = patches.get(patch.id)
  patches.set(patch.id, { ...prior, ...patch, ...(patch.voices ? { voices: { ...prior?.voices, ...patch.voices } } : {}) })
  return { patches, baseline }
}

// A voice chosen in the picker is saved at once. Any draft value for the same
// role and engine would override it on the next save, and the old baseline would
// report a false conflict, so both follow the saved value. Returns null when the
// draft has nothing left.
export function dropRoleVoice(draft, roleId, engine, saved) {
  if (!draft) return null
  const patches = new Map(draft.patches)
  const baseline = new Map(draft.baseline)
  const patch = patches.get(roleId)
  if (patch?.voices && Object.hasOwn(patch.voices, engine)) {
    const voices = { ...patch.voices }
    delete voices[engine]
    const next = { ...patch, voices }
    if (!Object.keys(voices).length) delete next.voices
    if (Object.keys(next).length === 1) patches.delete(roleId)
    else patches.set(roleId, next)
  }
  const before = baseline.get(roleId)
  if (before) {
    const voices = { ...before.voices }
    if (saved) voices[engine] = saved
    else delete voices[engine]
    baseline.set(roleId, { ...before, voices })
  }
  return patches.size ? { patches, baseline } : null
}

export function chapterRoles(roles, groups, draft) {
  const counts = new Map()
  for (const part of groups ?? []) {
    if (!part?.roleId) continue
    counts.set(part.roleId, (counts.get(part.roleId) ?? 0) + 1)
  }
  const byId = new Map((roles ?? []).map(role => [role.id, role]))
  const narratorRole = byId.get('narrator') ?? { id: 'narrator', name: '旁白', gender: '', voices: {} }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
  const inChapter = []
  const seen = new Set()
  for (const [id, count] of ranked) {
    const role = byId.get(id) ?? (id === 'narrator' ? narratorRole : null)
    if (!role) continue
    inChapter.push({ ...role, count })
    seen.add(id)
  }
  if (!seen.has('narrator')) {
    inChapter.push({ ...narratorRole, count: 0 })
    seen.add('narrator')
  }
  for (const patch of draft?.patches?.values() ?? []) {
    if (!patch?.create || seen.has(patch.id) || !byId.has(patch.id)) continue
    inChapter.push({ ...byId.get(patch.id), count: 0 })
    seen.add(patch.id)
  }
  return { inChapter, others: (roles ?? []).filter(role => !seen.has(role.id)) }
}

export function mergeRoles(chapter, draft) {
  const roles = new Map([[narrator.id, narrator], ...chapter.roles.map(role => [role.id, role])])
  const conflicts = []
  for (const patch of draft?.patches.values() ?? []) {
    const saved = roles.get(patch.id)
    const base = draft.baseline.get(patch.id) ?? (patch.id === narrator.id ? narrator : null)
    if (patch.create && saved) {
      conflicts.push({ role: patch.id, field: 'create', label: '角色已存在' })
      continue
    }
    function compare(field, value, old, live, label) {
      if (value !== undefined && live !== old && live !== value) conflicts.push({ role: patch.id, field, label, value, live })
    }
    compare('name', patch.name, base?.name, saved?.name, '角色名')
    compare('gender', patch.gender, base?.gender, saved?.gender, '性别')
    compare('age', patch.age, base?.age ?? '', saved?.age ?? '', '年龄')
    const voices = { ...saved?.voices }
    for (const [engine, voice] of Object.entries(patch.voices ?? {})) {
      compare(engine, voice, base?.voices?.[engine] ?? '', saved?.voices?.[engine] ?? '', engine === 'edge' ? 'Edge 音色' : 'LaiVox 音色')
      if (voice) voices[engine] = voice
      else delete voices[engine]
    }
    roles.set(patch.id, { id: patch.id, name: patch.name ?? saved?.name, gender: patch.gender ?? saved?.gender, age: patch.age ?? saved?.age ?? '', voices })
  }
  return { roles: [...roles.values()], conflicts }
}

export function resolveRoleConflict(draft, chapter, conflict, keep) {
  const patches = new Map(draft.patches)
  const baseline = new Map(draft.baseline)
  const patch = { ...patches.get(conflict.role) }
  const saved = chapter.roles.find(role => role.id === conflict.role) ?? narrator
  const previous = { ...baseline.get(conflict.role) }
  if (conflict.field === 'create') patches.delete(conflict.role)
  else if (['edge', 'laivox'].includes(conflict.field)) {
    const field = conflict.field
    previous.voices = { ...previous.voices, [field]: saved.voices?.[field] }
    patch.voices = { ...patch.voices }
    if (!keep) delete patch.voices[field]
    if (!Object.keys(patch.voices).length) delete patch.voices
    patches.set(patch.id, patch)
  } else {
    previous[conflict.field] = saved[conflict.field]
    if (!keep) delete patch[conflict.field]
    patches.set(patch.id, patch)
  }
  baseline.set(conflict.role, previous)
  for (const [id, item] of patches) if (Object.keys(item).length === 1) patches.delete(id)
  return patches.size ? { patches, baseline } : null
}

// A progress poll carries media without text. Keep the text already shown for the
// same parts so stale audio does not turn every line into "旧版音频".
export function mergeProgress(view, progress) {
  const before = Array.isArray(view?.media) ? view.media : []
  const media = Array.isArray(progress?.media)
    ? progress.media.map((part, n) => part.text === undefined && before[n] && before[n].id === part.id && before[n].text !== undefined ? { ...part, text: before[n].text } : part)
    : progress?.media
  return { ...view, ...progress, ...(media === undefined ? {} : { media }) }
}
