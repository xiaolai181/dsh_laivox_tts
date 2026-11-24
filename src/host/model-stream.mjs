import { normalizeModelUsage } from './model-usage.mjs'

// Shared reader for cleaning, scripting and import review. It owns one
// request's timers and the iterator, and it never writes the database.
// A legal finish ends the local read. Abandoning a read (cancel, pause,
// supersede, plugin stop, idle or total deadline) stops waiting immediately.
// The adapter's own cleanup is not awaited; if it is still running, that
// provider refuses a new attempt until the cleanup settles.

export const MODEL_IDLE_MS = 60_000
export const MODEL_TOTAL_MS = 300_000
export const IMPORT_MODEL_TOTAL_MS = 45_000
export const IMPORT_ROUND_MS = 100_000

const FAILURES = {
  NO_ADAPTER: 'MODEL_NO_ADAPTER',
  MISSING_CREDENTIAL: 'MODEL_MISSING_CREDENTIAL',
  AUTH: 'MODEL_AUTH',
  QUOTA: 'MODEL_QUOTA',
  ACCOUNT_QUOTA: 'MODEL_QUOTA',
  RATE_LIMIT: 'MODEL_RATE_LIMIT',
  CONTEXT_WINDOW_EXCEEDED: 'MODEL_CONTEXT_WINDOW',
  TIMEOUT: 'MODEL_TIMEOUT',
  TRANSPORT: 'MODEL_TRANSPORT',
}

const MODEL_CODE = /^MODEL_[A-Z0-9_]+$/u

export function createStreamGate() {
  const unsettled = new Map()
  return {
    assert(provider) {
      if (typeof provider !== 'string' || !provider) return
      if (unsettled.get(provider)?.size) throw new Error('MODEL_STREAM_SETTLING')
    },
    hold(provider) {
      if (typeof provider !== 'string' || !provider) return () => {}
      const owner = {}
      let bucket = unsettled.get(provider)
      if (!bucket) unsettled.set(provider, bucket = new Set())
      bucket.add(owner)
      return () => {
        if (!bucket.delete(owner)) return
        if (!bucket.size) unsettled.delete(provider)
      }
    },
  }
}

const sharedGate = createStreamGate()

function retryAfterSeconds(failure) {
  if (!failure || typeof failure !== 'object') return undefined
  // DSH's LlmFailure field is providerRetryAfterMs. retryAfterMs is the older test shape.
  const milliseconds = failure.providerRetryAfterMs ?? failure.retryAfterMs
  const seconds = failure.retryAfter ?? failure.retryAfterSeconds
  const value = Number.isFinite(milliseconds) ? milliseconds / 1000 : Number.isFinite(seconds) ? seconds : NaN
  if (!Number.isFinite(value) || value <= 0 || value > 86_400) return undefined
  return Math.ceil(value)
}

function fromFailure(failure) {
  const code = typeof failure?.code === 'string' ? FAILURES[failure.code] : undefined
  if (!code) return null
  const error = new Error(code)
  if (code === 'MODEL_RATE_LIMIT') {
    const retry = retryAfterSeconds(failure)
    if (retry != null) error.retryAfter = retry
  }
  return error
}

function fromThrow(error) {
  if (typeof error?.message === 'string' && MODEL_CODE.test(error.message)) {
    const clone = new Error(error.message)
    if (Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86_400) clone.retryAfter = error.retryAfter
    return clone
  }
  const mapped = fromFailure(error?.failure)
    ?? (typeof error?.code === 'string' ? fromFailure({
      code: error.code, retryAfter: error.retryAfter, retryAfterMs: error.retryAfterMs, providerRetryAfterMs: error.providerRetryAfterMs,
    }) : null)
  if (mapped) return mapped
  if (error?.name === 'TimeoutError' || error?.code === 'TIMEOUT') return new Error('MODEL_TIMEOUT')
  return new Error('MODEL_REQUEST_FAILED')
}

function parentError(signal) {
  if (!signal?.aborted) return null
  const reason = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' && reason ? reason : 'ABORT')
  if (reason == null) error.name = 'AbortError'
  return error
}

function swallow(promise) {
  if (promise && typeof promise.then === 'function') promise.then(() => {}, () => {})
}

export function assertModelProviderReady(provider, gate = sharedGate) {
  (gate ?? sharedGate).assert(provider)
}

export async function readModelStream({
  open, provider, signal, idleMs = 0, totalMs = MODEL_TOTAL_MS, maxChars = 120_000,
  overflowCode = 'MODEL_RESPONSE_TRUNCATED', onUsage, onLateUsage, gate = sharedGate,
} = {}) {
  const already = parentError(signal)
  if (already) throw already
  const activeGate = gate ?? sharedGate
  assertModelProviderReady(provider, activeGate)
  const local = new AbortController()
  const streamed = signal ? AbortSignal.any([signal, local.signal]) : local.signal
  let iterator
  try { iterator = open(streamed)[Symbol.asyncIterator]() }
  catch (error) { throw fromThrow(error) }
  let idleTimer
  let totalTimer
  let usage
  const acceptUsage = value => {
    if (normalizeModelUsage(value)) usage = value
  }
  let text = ''
  let finish = null
  let failure = null
  let emitted = false
  let cleaned = false
  const clearTimers = () => {
    clearTimeout(idleTimer)
    clearTimeout(totalTimer)
    idleTimer = undefined
    totalTimer = undefined
  }
  const armIdle = () => {
    if (!idleMs) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { if (!local.signal.aborted) local.abort(new Error('MODEL_TIMEOUT')) }, idleMs)
    idleTimer.unref?.()
  }
  if (totalMs) {
    totalTimer = setTimeout(() => { if (!local.signal.aborted) local.abort(new Error('MODEL_TIMEOUT')) }, totalMs)
    totalTimer.unref?.()
  }
  const onParent = () => { if (!local.signal.aborted) local.abort(signal.reason) }
  if (signal) signal.addEventListener('abort', onParent, { once: true })
  const stopListening = () => signal?.removeEventListener('abort', onParent)
  // Usage already received is reported even when the parent then pauses.
  // A usage chunk that arrives after this read has stopped is late and is not kept.
  const emit = () => {
    if (emitted) return
    emitted = true
    if (usage) onUsage?.(usage)
  }
  // track: an abandoned read keeps the provider busy until return() fulfills.
  // A legal finish does not, so the next batch of a completed response can start.
  const closeIterator = async track => {
    if (cleaned) return
    cleaned = true
    clearTimers()
    stopListening()
    let returned
    try { returned = typeof iterator.return === 'function' ? iterator.return() : undefined }
    catch (error) { returned = Promise.reject(error) }
    if (!returned || typeof returned.then !== 'function') return
    if (!track) { swallow(returned); return }
    const release = activeGate.hold(provider)
    // A rejected return() has already settled. Only a return() that never settles keeps the provider.
    const done = returned.then(release, release)
    await Promise.race([done, new Promise(resolve => { const timer = setTimeout(resolve, 0); timer.unref?.() })])
  }
  const abandon = async error => {
    const winner = parentError(signal) ?? error
    emit()
    await closeIterator(true)
    throw winner
  }
  const noteLate = guarded => {
    guarded.then(result => {
      const chunk = result?.ok ? result.value?.value : null
      if (chunk?.type === 'usage') onLateUsage?.()
    }, () => {})
  }
  try {
    armIdle()
    for (;;) {
      let pending
      try { pending = iterator.next() }
      catch (error) { pending = Promise.reject(error) }
      const guarded = pending.then(value => ({ ok: true, value }), error => ({ ok: false, error }))
      let onAbort
      const stopped = new Promise(resolve => {
        if (local.signal.aborted || signal?.aborted) resolve()
        else {
          onAbort = () => resolve()
          local.signal.addEventListener('abort', onAbort, { once: true })
          signal?.addEventListener('abort', onAbort, { once: true })
        }
      })
      const outcome = await Promise.race([
        guarded.then(result => ({ kind: 'chunk', result })),
        stopped.then(() => ({ kind: 'stop' })),
      ])
      if (onAbort) {
        local.signal.removeEventListener('abort', onAbort)
        signal?.removeEventListener('abort', onAbort)
      }
      if (outcome.kind === 'stop' || signal?.aborted) {
        noteLate(guarded)
        swallow(guarded)
        await abandon(new Error('MODEL_TIMEOUT'))
      }
      if (!outcome.result.ok) await abandon(fromThrow(outcome.result.error))
      if (signal?.aborted || local.signal.aborted) {
        const early = outcome.result?.value
        if (!early?.done && early?.value?.type === 'usage') acceptUsage(early.value.usage)
        swallow(guarded)
        await abandon(new Error('MODEL_TIMEOUT'))
      }
      const step = outcome.result.value
      if (step.done) break
      const chunk = step.value
      armIdle()
      if (chunk?.type === 'usage') acceptUsage(chunk.usage)
      else if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (text.length > maxChars) {
          emit()
          await closeIterator(true)
          throw new Error(overflowCode)
        }
      } else if (chunk?.type === 'finish') {
        finish = typeof chunk.reason?.kind === 'string' ? chunk.reason.kind : null
        failure = chunk.reason?.failure ?? null
        acceptUsage(chunk.usage)
        break
      }
    }
    emit()
    await closeIterator(false)
    if (finish === 'max-tokens' || finish === 'length') throw new Error('MODEL_RESPONSE_TRUNCATED')
    const mapped = fromFailure(failure)
    if (mapped) throw mapped
    if (finish !== 'stop') throw new Error('MODEL_REQUEST_FAILED')
    return text
  } finally {
    clearTimers()
    stopListening()
  }
}
