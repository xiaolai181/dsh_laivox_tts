import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const AI_PLAN_VERSION = 1

let activationKey
function key() {
  activationKey ??= randomBytes(32)
  return activationKey
}

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(name => [name, ordered(value[name])]))
  return value
}

export function canonicalPlan(value) {
  return JSON.stringify(ordered(value))
}

export function signAiPlan(snapshot) {
  const proof = createHmac('sha256', key()).update(canonicalPlan(snapshot)).digest('hex')
  return { snapshot, proof }
}

export function aiPlanCode(proof) {
  return typeof proof === 'string' ? proof.slice(0, 12) : ''
}

export function verifyAiPlan(confirmation) {
  const snapshot = confirmation?.snapshot
  const proof = confirmation?.proof
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || typeof proof !== 'string' || !/^[0-9a-f]{64}$/u.test(proof)) {
    throw new Error('MODEL_PLAN_STALE')
  }
  const expected = createHmac('sha256', key()).update(canonicalPlan(snapshot)).digest('hex')
  const left = Buffer.from(proof, 'hex')
  const right = Buffer.from(expected, 'hex')
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('MODEL_PLAN_STALE')
  return snapshot
}

export function samePlan(left, right) {
  return canonicalPlan(left) === canonicalPlan(right)
}

// The receipt keeps the snapshot and drops only the signature, so a new
// activation key does not change the digest of an already queued operation.
export function optionSnapshot(input) {
  return {
    engine: input.engine ?? null, mode: input.mode ?? null, purpose: input.purpose ?? 'generate',
    clean: input.clean === true, retake: input.retake === true, only: input.only ?? null,
    focusStart: Number.isSafeInteger(input.focusStart) ? input.focusStart : null,
  }
}

export function selectionSnapshot(resolved, requested) {
  const selection = {
    provider: resolved.provider, model: resolved.model,
    maxTokens: Number.isFinite(resolved.maxTokens) ? resolved.maxTokens : null,
  }
  if (requested?.reasoningEffort === null) selection.reasoningEffort = null
  else if (resolved.reasoningEffort !== undefined) selection.reasoningEffort = resolved.reasoningEffort
  return selection
}

export function chapterFingerprint(rows) {
  return rows.map(row => ({
    id: row.id, rev: row.rev, rolesRev: row.rolesRev ?? null, editorialResultJob: row.editorialResultJob ?? null,
  }))
}

export function receiptBody(body) {
  if (!body?.confirmation || typeof body.confirmation !== 'object' || Array.isArray(body.confirmation)) return body
  const { proof: _proof, ...confirmation } = body.confirmation
  return { ...body, confirmation }
}
