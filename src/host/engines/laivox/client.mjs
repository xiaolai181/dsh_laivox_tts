// LaiVox HTTP client. This module (src/host/engines/laivox/) is the only place in
// the plugin that knows LaiVox addresses; a boundary test keeps it that way.
// Security never depends on anything here: the gateway authenticates the user's key
// and enforces membership, ownership, quota and rate limits on every request.
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { laneTarget, noteBusy, noteConcurrency, onLanesChange, pollHint } from './pacing.mjs'

const base = 'https://dsh.xiao-lai.cn/xs/dsh-tts/v1'
// Where users get or replace their API key (shown in settings).
export const KEY_PAGE = 'https://www.xiao-lai.cn/xs/login/keys/'
// New accounts register and buy on one path. Existing accounts still open the key page.
export const START_PAGE = 'https://www.xiao-lai.cn/xs/login/?purpose=start'
// Where users buy or renew the read-aloud pack (the web page decides whether an order is allowed).
export const PACK_PAGE = 'https://www.xiao-lai.cn/xs/login/pack/'
const MAX_AUDIO_BYTES = 24 * 1024 * 1024
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

// The host code is not bundled, so the version is read once from package.json
// (always part of the published package). The gateway uses it only for an
// operator-set minimum version; it is never a credential.
export const CLIENT_VERSION = (() => {
  try { return String(createRequire(import.meta.url)('../../../../package.json').version || '0.0.0') }
  catch { return '0.0.0' }
})()
const CLIENT_HEADER = 'dsh-laivox-tts/' + CLIENT_VERSION

// Polling when the gateway gives no poll_after_ms (older gateway, switched off):
// an early first look, then every 3 s, slower after a while. With the hint the
// gateway sets the pace. The wait limit follows the task's deadline when given.
const FIRST_POLL_MAX_MS = 3000
const POLL_MS = 3000
const SLOW_POLL_MS = 6000
const FAST_POLLS = 5
const POLL_BACKOFF_BASE_MS = 3000
const POLL_BACKOFF_MAX_MS = 60_000
const DEFAULT_WAIT_MS = 12 * 60_000
const MAX_WAIT_MS = 20 * 60_000
const DEADLINE_SLACK_MS = 90_000

export class GatewayError extends Error {
  // details keeps only what the plugin shows or decides on (usage_day, min_version,
  // next_extra_at, reason, the key's ledger and whether the other ledger is usable); never the raw body.
  constructor(code, status, wait, details = {}) {
    super(code)
    this.status = status
    this.wait = wait
    this.details = details
  }
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

function retryAfterSeconds(response, data) {
  const header = Number(response.headers.get('retry-after'))
  if (header > 0) return header
  const ms = Number(data?.concurrency?.retry_after_ms)
  return ms > 0 ? Math.ceil(ms / 1000) : 0
}

function pickDetails(data) {
  const details = {}
  for (const name of ['usage_day', 'min_version', 'next_extra_at', 'reason', 'concurrency', 'ledger', 'membership_available', 'pack_available']) {
    if (data?.[name] !== undefined) details[name] = data[name]
  }
  return details
}

function isTransientPollError(error) {
  if (error instanceof GatewayError) return error.status === 408 || error.status === 429 || error.status >= 500
  return error?.name === 'TypeError' || error?.name === 'TimeoutError'
}

function pollBackoffMs(error, streak) {
  if (error instanceof GatewayError && error.wait > 0) {
    return clamp(error.wait * 1000, POLL_BACKOFF_BASE_MS, POLL_BACKOFF_MAX_MS)
  }
  return Math.min(POLL_BACKOFF_MAX_MS, POLL_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(0, streak - 1), 5))
}

// hints is shared by every client built from the same session, so a later job
// starts with the pacing the gateway asked for on an earlier one.
export function createGateway(key, { onAuthFailure, hints = {} } = {}) {
  const deadlines = new Map()
  // The gateway's next-poll suggestion per task (0.5.0+ plugins only).
  const pollAfter = new Map()
  // One loop for every part this process is waiting on. Downloads stay with the caller.
  const waiters = new Map()
  let pollTimer = null
  let polling = false
  let batchUnsupported = false
  let pollErrorStreak = 0

  async function request(path, signal, body) {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'X-LaiVox-Client': CLIENT_HEADER },
      signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      const code = typeof data.error === 'string' && /^[A-Z_]+$/.test(data.error) ? data.error : 'LAIVOX_REQUEST_FAILED'
      if (response.status === 401 || code === 'ACCOUNT_DISABLED') onAuthFailure?.()
      throw new GatewayError(code, response.status, retryAfterSeconds(response, data), pickDetails(data))
    }
    return data
  }

  function remember(data) {
    if (Number(data?.timeout_sec) > 0) hints.timeoutSec = Number(data.timeout_sec)
    noteConcurrency(hints, data?.concurrency)
    const at = Date.parse(data?.deadline_at)
    if (typeof data?.task_id === 'string' && Number.isFinite(at)) deadlines.set(data.task_id, at)
    const poll = pollHint(data?.poll_after_ms)
    if (typeof data?.task_id === 'string' && poll) pollAfter.set(data.task_id, poll)
  }

  function deferWaiters(entries, waitMs) {
    const targetAt = Date.now() + waitMs
    for (const [id] of entries) {
      const waiter = waiters.get(id)
      if (waiter) waiter.nextAt = Math.max(waiter.nextAt, targetAt)
    }
  }

  function armPoll() {
    if (pollTimer) clearTimeout(pollTimer)
    if (!waiters.size || polling) return
    let wait = 60_000
    const now = Date.now()
    for (const waiter of waiters.values()) {
      wait = Math.min(wait, Math.max(0, waiter.nextAt - now), Math.max(0, waiter.deadline - now))
    }
    pollTimer = setTimeout(() => { void pollWaiters() }, wait)
    pollTimer.unref?.()
  }

  function settle(taskId, task) {
    const waiter = waiters.get(taskId)
    if (!waiter) return
    waiters.delete(taskId)
    waiter.resolve(task)
  }

  async function pollWaiters() {
    if (polling) return
    polling = true
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
    const due = [...waiters.entries()].filter(([, waiter]) => waiter.nextAt <= Date.now() && !waiter.signal.aborted)
    try {
      for (let index = 0; index < due.length; index += 32) {
        const slice = due.slice(index, index + 32)
        let tasks = null
        let backedOff = false
        if (!batchUnsupported) {
          try {
            const body = await request('/tasks/query', AbortSignal.timeout(20_000), { task_ids: slice.map(([id]) => id) })
            if (!Array.isArray(body?.tasks)) batchUnsupported = true
            else { pollErrorStreak = 0; tasks = body.tasks }
          } catch (error) {
            if (error instanceof GatewayError && error.status === 404) batchUnsupported = true
            else if (isTransientPollError(error)) {
              pollErrorStreak++
              deferWaiters(due.slice(index), pollBackoffMs(error, pollErrorStreak))
              break
            } else {
              for (const [id] of slice) {
                const waiter = waiters.get(id)
                if (waiter) {
                  waiters.delete(id)
                  waiter.reject(error)
                }
              }
              continue
            }
          }
        }
        if (!tasks) {
          tasks = []
          for (let i = 0; i < slice.length; i++) {
            const [id, waiter] = slice[i]
            if (waiter.signal.aborted || !waiters.has(id)) continue
            try {
              const result = await request('/tasks/' + encodeURIComponent(id), waiter.signal)
              pollErrorStreak = 0
              tasks.push(result)
            } catch (error) {
              if (waiter.signal.aborted || !waiters.has(id)) continue
              if (isTransientPollError(error)) {
                pollErrorStreak++
                const waitMs = pollBackoffMs(error, pollErrorStreak)
                deferWaiters(slice.slice(i), waitMs)
                deferWaiters(due.slice(index + 32), waitMs)
                backedOff = true
                break
              }
              waiters.delete(id)
              waiter.reject(error)
            }
          }
        }
        const seen = new Set(tasks.map(task => task?.task_id).filter(Boolean))
        for (const task of tasks) {
          const waiter = task?.task_id ? waiters.get(task.task_id) : null
          if (!waiter) continue
          remember(task)
          const latest = deadlines.get(task.task_id)
          if (latest) waiter.deadline = Math.max(waiter.deadline, Math.min(Date.now() + MAX_WAIT_MS, latest + DEADLINE_SLACK_MS))
          if (typeof task.error === 'string') {
            const retry = task.error === 'SERVICE_UNAVAILABLE' || task.error === 'AUDIO_SIGN_FAILED' || task.error === 'TASK_RESULT_UNAVAILABLE'
            if (retry) { waiter.nextAt = Date.now() + POLL_MS; continue }
            waiters.delete(task.task_id)
            waiter.reject(new GatewayError(task.error, task.error === 'AUDIO_UNAVAILABLE' || task.error === 'TASK_EXPIRED' ? 410 : 409, 0))
            continue
          }
          if (task.status === 'completed' || (task.status === 'failed' && task.error?.will_retry === false)) {
            settle(task.task_id, task)
            continue
          }
          waiter.polls++
          waiter.nextAt = Date.now() + (pollHint(task.poll_after_ms) ?? (waiter.polls < FAST_POLLS ? POLL_MS : SLOW_POLL_MS))
        }
        for (const [id, waiter] of slice) {
          if (seen.has(id) || !waiters.has(id)) continue
          if (Date.now() >= waiter.deadline) { waiters.delete(id); waiter.reject(new Error('LAIVOX_POLL_TIMEOUT')) }
          else if (waiter.nextAt <= Date.now()) waiter.nextAt = Date.now() + SLOW_POLL_MS
        }
        if (backedOff) break
      }
      for (const [id, waiter] of [...waiters]) {
        if (Date.now() >= waiter.deadline) { waiters.delete(id); waiter.reject(new Error('LAIVOX_POLL_TIMEOUT')) }
      }
    } finally {
      polling = false
      armPoll()
    }
  }

  return {
    status: signal => request('/status', signal),
    catalog: signal => request('/catalog', signal),
    // A short code the pack page exchanges for a buy-only session. The code is not a key.
    async handoff(signal) {
      const data = await request('/web-handoff', signal, {})
      if (typeof data?.code !== 'string' || !/^[0-9a-f]{64}$/u.test(data.code)) throw new Error('LAIVOX_REQUEST_FAILED')
      return { code: data.code, expiresIn: Number(data.expires_in) > 0 ? Number(data.expires_in) : 600 }
    },
    async voices(signal, { includeMine = false } = {}) { return (await request(includeMine ? '/voices?include=mine' : '/voices', signal)).voices },
    // A voice's reference sample (WAV bytes), served by the gateway.
    async preview(voiceId, signal) {
      const response = await fetch(base + '/voices/' + encodeURIComponent(voiceId) + '/preview', {
        redirect: 'error', headers: { Authorization: 'Bearer ' + key, 'X-LaiVox-Client': CLIENT_HEADER },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        const code = typeof data.error === 'string' && /^[A-Z_]+$/.test(data.error) ? data.error : 'VOICE_PREVIEW_NOT_FOUND'
        if (response.status === 401) onAuthFailure?.()
        throw new GatewayError(code, response.status, retryAfterSeconds(response, data), pickDetails(data))
      }
      const declared = Number(response.headers.get('content-length'))
      if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) throw new Error('VOICE_PREVIEW_NOT_FOUND')
      return readLimited(response, MAX_PREVIEW_BYTES, 'VOICE_PREVIEW_NOT_FOUND')
    },
    async submit(part, requestId, variant, signal) {
      const data = await request('/tasks', signal, {
        request_id: requestId, text: part.text, voice_id: part.voiceId, language: 'zh',
        script_variant: variant, instruct: part.instruct,
        // A retake asks the gateway for a new take instead of reusing the cached voice reference.
        ...(part.retake ? { is_retry: true } : {}),
      })
      remember(data)
      return data
    },
    // Lanes the gateway currently allows (its credit; it enforces the limit itself).
    lanes() { return laneTarget(hints) },
    // A 429 while submitting: follow the hint it carries, or drop one lane.
    busy(concurrency) { noteBusy(hints, concurrency) },
    // Called when the allowed lanes change, so a running chapter can widen.
    onLanesChange(listener) { return onLanesChange(hints, listener) },
    // Smallest gap between two submissions the gateway asked for (0 when none).
    minInterval() { return Math.max(0, Number(hints.concurrency?.rate_floor_ms) || 0, Number(hints.concurrency?.min_interval_ms) || 0) },
    // Waits for this submission's turn. The slot is reserved before waiting, so
    // lanes sharing the session line up instead of all firing at once.
    async pace(signal) {
      const gap = this.minInterval()
      const at = Math.max(Date.now(), (hints.nextSubmitAt ?? 0))
      hints.nextSubmitAt = at + gap
      if (at > Date.now()) await delay(at - Date.now(), undefined, { signal })
    },
    async audio(taskId, signal) {
      const known = deadlines.get(taskId)
      const limit = known ? Math.min(MAX_WAIT_MS, Math.max(DEFAULT_WAIT_MS / 4, known + DEADLINE_SLACK_MS - Date.now())) : DEFAULT_WAIT_MS
      const first = pollAfter.get(taskId) ?? (hints.timeoutSec ? Math.min(FIRST_POLL_MAX_MS, hints.timeoutSec * 200) : FIRST_POLL_MAX_MS)
      pollAfter.delete(taskId)
      let onAbort = () => {}
      const task = await new Promise((resolve, reject) => {
        const waiter = { resolve, reject, signal, deadline: Date.now() + limit, nextAt: Date.now() + first, polls: 0 }
        onAbort = () => {
          if (waiters.get(taskId) !== waiter) return
          waiters.delete(taskId)
          reject(signal.reason ?? Object.assign(new Error('AbortError'), { name: 'AbortError' }))
          armPoll()
        }
        signal.addEventListener('abort', onAbort, { once: true })
        waiters.set(taskId, waiter)
        armPoll()
      })
      signal.removeEventListener('abort', onAbort)
      if (task.status === 'completed') {
        deadlines.delete(taskId)
        return download(task.result?.audio_url, signal)
      }
      deadlines.delete(taskId)
      const failed = new Error('LAIVOX_TASK_FAILED')
      if (typeof task.error?.code === 'string') failed.taskCode = task.error.code
      throw failed
    },
    async usage(signal) { return (await request('/usage', signal)).data },
    async authorize({ target, windowId, operationId }, signal) {
      try {
        return (await request('/usage/authorize', signal, {
          target_days_authorized: target, expected_window_id: windowId, idempotency_key: operationId,
        })).data
      } catch (error) {
        if (error instanceof GatewayError) error.usageAuthorize = true
        throw error
      }
    },
  }
}

async function download(value, signal) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['.xiao-lai.cn', '.alaitts.work', '.r2.cloudflarestorage.com'].some(suffix => url.hostname.endsWith(suffix) || url.hostname === suffix.slice(1))) {
    throw new Error('LAIVOX_AUDIO_URL_INVALID')
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
  if (response.status === 403 || response.status === 404) throw new Error('LAIVOX_AUDIO_GONE')
  if (!response.ok || !response.body) throw new Error('LAIVOX_AUDIO_UNAVAILABLE')
  return readLimited(response, MAX_AUDIO_BYTES, 'LAIVOX_AUDIO_TOO_LARGE')
}

async function readLimited(response, limit, tooLarge) {
  const chunks = []
  let length = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.length
      if (length > limit) throw new Error(tooLarge)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}
