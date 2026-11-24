import { KEEP_PREVIOUS_AUDIO } from '../domain/production.mjs'
import { planComplete } from './plan.mjs'

const generate = job => job?.spec?.purpose === 'generate'
const alive = job => generate(job) && job.state !== 'cancelled'

// Every planned part has audio, and the plan is no longer growing.
export function isComplete(job, ready) {
  const progress = job?.progress
  if (!alive(job) || !planComplete(progress) || !ready) return false
  return progress.parts.every(part => ready.has(part.key))
}

// Which job the player follows. `jobs` is the current revision, newest first.
// `requested` is a job the user asked to hear. `latestComplete` is the newest
// complete job of any revision, already loaded by the caller when needed.
export function choosePlayable({ requested, jobs = [], latestComplete = null, pinned = null, historical = null, ready, keepPrevious = KEEP_PREVIOUS_AUDIO } = {}) {
  if (requested && generate(requested)) return requested
  const list = Array.isArray(jobs) ? jobs : []
  if (!keepPrevious) return list.find(alive) ?? pinned ?? historical ?? null
  const completeHere = list.find(job => isComplete(job, ready))
  if (completeHere) return completeHere
  const current = list.find(alive)
  if (current) return isComplete(latestComplete, ready) ? latestComplete : current
  return pinned ?? historical ?? null
}

// 'text' when a saved part's words differ from the chapter; 'edit' when the
// words match (the script or the voices changed). Null when it cannot be told
// apart, including chapters segmented before version 2.
export function staleReason(text, job) {
  const version = job?.progress?.segmentVersion
  const parts = job?.progress?.parts
  if (!(version >= 2) || !Array.isArray(parts) || !parts.length) return null
  if (parts.some(part => typeof part.text !== 'string')) return null
  const body = typeof text === 'string' ? text : ''
  return parts.some(part => body.slice(part.start, part.end) !== part.text) ? 'text' : 'edit'
}
