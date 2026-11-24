import { segmentChapter, sourceLines } from '../../domain/segment.mjs'

// Turns a running job's live checkpoint (api.mjs liveProjection) into the
// blocks of the production mosaic: one block per segment of the chapter, in
// reading order, sized by its length. A block moves through
//   pending → cast (speaker known) → ready (audio exists)
// and lines removed by cleaning appear as struck-out blocks. `sweep` marks
// the batch being worked on now; `playing` the part being heard.

export const AGGREGATE_ABOVE = 1500
const ORDER = { removed: -1, pending: 0, cast: 1, ready: 2 }

function partAt(parts, start) {
  let left = 0
  let right = parts.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (parts[middle][0] <= start) left = middle + 1
    else right = middle
  }
  const index = left - 1
  return index >= 0 && start < parts[index][1] ? index : -1
}

export function buildMosaic(text, live, { playing = null, engineLanes = 2 } = {}) {
  if (typeof text !== 'string' || !live) return { blocks: [], roles: [], aggregated: false }
  const removed = Array.isArray(live.removed) ? live.removed : []
  const segments = live.version == null ? segmentChapter(text, removed) : segmentChapter(text, removed, live.version)
  const cast = new Map()
  const roles = []
  for (const [id, roleId, emotion] of live.cast?.items ?? []) {
    cast.set(id, { roleId, emotion })
    if (roleId && !roles.includes(roleId)) roles.push(roleId)
  }
  const parts = Array.isArray(live.parts) ? live.parts : []
  const reading = !live.cast
  let blocks = segments.map(segment => {
    const part = partAt(parts, segment.start)
    const known = cast.get(segment.id)
    const ready = part >= 0 && parts[part][2] === 1
    const state = ready ? 'ready' : known ? 'cast' : 'pending'
    return { key: 's' + segment.id, start: segment.start, chars: segment.end - segment.start, part, state,
      roleId: known?.roleId ?? (reading && part >= 0 ? 'narrator' : null), emotion: known?.emotion ?? null, sweep: false, playing: false }
  })
  if (removed.length) {
    const hidden = new Set(removed)
    const struck = sourceLines(text).filter(line => hidden.has(line.id) && line.text.trim())
      .map(line => ({ key: 'r' + line.id, start: line.start, chars: line.text.length, part: -1, state: 'removed', roleId: null, emotion: null, sweep: false, playing: false }))
    blocks = [...blocks, ...struck].sort((a, b) => a.start - b.start)
  }
  // The batch in progress: proportional for cleaning, the next unscripted
  // segments for scripting, the first missing parts for synthesis.
  if (live.stage === 'cleaning' && live.clean?.total > 0) {
    const from = text.length * live.clean.done / live.clean.total
    const to = text.length * (live.clean.done + 1) / live.clean.total
    for (const block of blocks) if (block.start >= from && block.start < to && block.state !== 'removed') block.sweep = true
  } else if (live.stage === 'scripting' && live.cast?.total > live.cast?.done) {
    const pending = blocks.filter(block => block.state === 'pending')
    const size = Math.ceil(pending.length / Math.max(1, live.cast.total - live.cast.done))
    for (const block of pending.slice(0, size)) block.sweep = true
  } else if (live.stage === 'synthesizing' && parts.length) {
    const missing = []
    for (let index = 0; index < parts.length && missing.length < engineLanes; index++) if (parts[index][2] !== 1) missing.push(index)
    for (const block of blocks) if (missing.includes(block.part)) block.sweep = true
  }
  if (playing && Number.isFinite(playing.start) && Number.isFinite(playing.end)) {
    for (const block of blocks) if (block.start >= playing.start && block.start < playing.end && block.state !== 'removed') block.playing = true
  }
  const aggregated = blocks.length > AGGREGATE_ABOVE
  if (aggregated) {
    const groups = []
    for (let index = 0; index < blocks.length; index += 10) {
      const group = blocks.slice(index, index + 10)
      const live = group.filter(block => block.state !== 'removed')
      const pool = live.length ? live : group
      const state = pool.reduce((least, block) => ORDER[block.state] < ORDER[least] ? block.state : least, pool[0].state)
      const counts = new Map()
      for (const block of pool) if (block.roleId) counts.set(block.roleId, (counts.get(block.roleId) ?? 0) + 1)
      const roleId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
      groups.push({ key: 'g' + index, start: group[0].start, chars: group.reduce((sum, block) => sum + block.chars, 0), part: pool[0].part,
        state, roleId, emotion: null, sweep: group.some(block => block.sweep), playing: group.some(block => block.playing) })
    }
    blocks = groups
  }
  return { blocks, roles, aggregated }
}
