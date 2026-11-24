import { chooseVoices } from './editorial.mjs'
import { speechParts } from './plan.mjs'

// Scripting and synthesis overlap (docs/laivox/02): once a cast batch is written,
// the parts it settles are planned and can be synthesized while the next batch is
// being written. These helpers keep the incremental plan identical to the plan
// made from the whole chapter.

// Grouping joins neighbouring segments greedily from left to right, so only the
// last group of a prefix can still grow with the next batch: it is held back
// until the chapter is complete. Every other group is final.
export function planPrefix(prefix, final, { spec, roles, catalog, variant, version, rule }) {
  const shaped = speechParts(prefix, spec)
  const groups = final ? shaped.parts : shaped.parts.slice(0, -1)
  return { parts: groups.length ? chooseVoices(groups, roles, catalog, spec.engine, variant, { version, rule, narratorDefault: spec.laivoxNarratorDefault ?? null }) : [], skipped: shaped.skipped }
}

// Every speakable segment of the finished chapter appears once, in order, across
// the planned parts. Keys may differ only if a role's voice changed in between;
// coverage must not.
export function coversChapter(parts, prepared, spec) {
  const expected = speechParts(prepared, spec).parts.flatMap(part => part.sourceIds)
  const actual = parts.flatMap(part => part.sourceIds ?? [])
  return expected.length === actual.length && expected.every((id, index) => id === actual[index])
}

// A plan written in pieces carries the request and task ids of parts already
// sent to LaiVox; a plan that replaces it must keep them (same key, same part),
// or the gateway would be asked, and paid, twice.
export function keepAccepted(next, previous) {
  const byKey = new Map((previous ?? []).filter(part => part.requestId || part.taskId).map(part => [part.key, part]))
  for (const part of next) {
    const old = byKey.get(part.key)
    if (!old) continue
    for (const field of ['requestId', 'taskId', 'resubmits', 'capacityRetries', 'downloaded', 'localWriteId']) if (old[field] !== undefined) part[field] = old[field]
  }
  return next
}
