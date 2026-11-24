import { GatewayError } from './client.mjs'

const QUOTA = new Set(['DAILY_SYNTHESIS_LIMIT', 'TRIAL_DAILY_CAPACITY_REACHED'])
// Answers of the open-a-usage-day request (never of synthesis), each with its own wording.
const USAGE_CODES = { USAGE_DAY_24H_LIMIT: 'LAIVOX_USAGE_24H_LIMIT', USAGE_DAY_WINDOW_LIMIT: 'LAIVOX_USAGE_WINDOW_LIMIT',
  USAGE_DAY_NO_DAYS: 'LAIVOX_USAGE_NO_DAYS', USAGE_DAY_WINDOW_CHANGED: 'LAIVOX_USAGE_WINDOW_CHANGED',
  USAGE_DAY_CALENDAR_MODE: 'LAIVOX_USAGE_CALENDAR_MODE', USAGE_LEDGER_UNAVAILABLE: 'LAIVOX_USAGE_UNAVAILABLE',
  USAGE_DAY_RETIRED: 'LAIVOX_USAGE_RETIRED' }
const MEMBERSHIP = new Set(['MEMBERSHIP_EXPIRED', 'REFUND_PENDING', 'FREE_TRIAL_EXPIRED'])
// Answers that mean "this task will never produce audio": safe to submit again
// under a new request id. Anything uncertain keeps the old id.
const GONE = new Set(['AUDIO_UNAVAILABLE', 'TASK_EXPIRED'])
const RETRYABLE_RESULT = new Set(['TASK_RESULT_UNAVAILABLE', 'AUDIO_SIGN_FAILED', 'SERVICE_UNAVAILABLE'])

// What kind of failure this is, which decides how the plugin reacts:
//   transient – busy or briefly unreachable; retry with the same request id
//   quota     – today's capacity or the usage days ran out; the user may open a day
//   account   – key invalid or account disabled; the user replaces the key
//   membership– membership expired or refund pending
//   outdated  – the gateway requires a newer plugin
//   voice     – the voice can no longer be used (slot locked, deleted)
//   gone      – the gateway confirmed no audio will come; resubmit with a new id
//   other     – anything else (content errors, unknown); pause for the user
export function classifyLaivox(error) {
  if (error?.message === 'LAIVOX_SUBMIT_PENDING') return 'transient'
  if (error?.message === 'LAIVOX_TASK_FAILED') return 'gone'
  if (error?.message === 'LAIVOX_KEY_REQUIRED' || error?.message === 'LAIVOX_ACCOUNT_CHANGED') return 'account'
  if (error?.message === 'LAIVOX_AUDIO_GONE') return 'gone'
  if (error?.message === 'LAIVOX_AUDIO_UNAVAILABLE' || error?.message === 'LAIVOX_POLL_TIMEOUT' || error?.message === 'WAV_TRUNCATED') return 'transient'
  if (error?.message === 'LAIVOX_VOICE_UNAVAILABLE' || error?.message === 'LAIVOX_VOICE_CHANGED') return 'voice'
  if (error?.name === 'TypeError' || error?.name === 'TimeoutError') return 'transient'
  if (!(error instanceof GatewayError)) return 'other'
  const code = error.message
  if (code === 'USAGE_LEDGER_UNAVAILABLE' && !error.usageAuthorize) return 'transient'
  if (Object.hasOwn(USAGE_CODES, code)) return 'other'
  if (error.status === 401 && error.details?.reason === 'suspended_shared') return 'account'
  if (error.status === 401 || code === 'ACCOUNT_DISABLED') return 'account'
  if (code === 'KEY_TEMPORARILY_SUSPENDED') return 'held'
  if (code === 'REQUEST_ID_CONFLICT' || code === 'TASK_NOT_FOUND') return 'gone'
  if (code === 'TTS_ABUSE_BLOCKED' || error.status === 408) return 'transient'
  if (error.status === 429 && code === 'DAILY_SYNTHESIS_LIMIT' && error.details?.usage_day?.blocked_by_inflight === true) return 'transient'
  if (QUOTA.has(code)) return 'quota'
  if (MEMBERSHIP.has(code)) return 'membership'
  if (error.status === 426 || code === 'CLIENT_OUTDATED') return 'outdated'
  if (code === 'VOICE_SLOT_LOCKED') return 'voice'
  if (error.status === 410 && GONE.has(code)) return 'gone'
  if (RETRYABLE_RESULT.has(code) || error.status === 429 || error.status >= 500) return 'transient'
  return 'other'
}

// Gateway failures the plugin explains in its own words. Anything else falls
// through to the generic error-code rule in api.mjs.
export function laivoxErrorCode(error) {
  if (!(error instanceof GatewayError)) return undefined
  if (error.message === 'USAGE_LEDGER_UNAVAILABLE' && !error.usageAuthorize) return 'SERVICE_UNAVAILABLE'
  if (Object.hasOwn(USAGE_CODES, error.message)) return USAGE_CODES[error.message]
  switch (classifyLaivox(error)) {
    case 'account': return error.details?.reason === 'suspended_shared' ? 'LAIVOX_KEY_SUSPENDED' : 'LAIVOX_KEY_INVALID'
    case 'held': return 'LAIVOX_KEY_HELD'
    case 'quota': return 'LAIVOX_QUOTA'
    case 'membership': return 'LAIVOX_MEMBERSHIP'
    case 'outdated': return 'LAIVOX_CLIENT_OUTDATED'
    case 'voice': return 'LAIVOX_VOICE_UNAVAILABLE'
    case 'transient':
      if (error.status === 429) return 'LAIVOX_RATE_LIMIT'
      if (error.message === 'TTS_ABUSE_BLOCKED') return 'LAIVOX_ABUSE_BLOCKED'
      if (RETRYABLE_RESULT.has(error.message)) return 'LAIVOX_AUDIO_UNAVAILABLE'
      return undefined
    default: return undefined
  }
}

// Paused-job codes that heal by waiting; the queue retries these on its own
// (15 s, 60 s, 300 s), like Edge outages.
export const LAIVOX_TRANSIENT_CODES = new Set(['LAIVOX_RATE_LIMIT', 'LAIVOX_AUDIO_UNAVAILABLE', 'LAIVOX_POLL_TIMEOUT',
  'LAIVOX_REQUEST_FAILED', 'SERVICE_UNAVAILABLE', 'WAV_TRUNCATED', 'LAIVOX_ABUSE_BLOCKED', 'LAIVOX_SUBMIT_PENDING'])

// What a paused LaiVox job tells the interface so it can offer the right action.
export function laivoxPauseInfo(error) {
  const kind = classifyLaivox(error)
  if (kind === 'held') {
    const wait = Number(error?.wait) > 0 ? Number(error.wait) : 60 * 60
    return { kind, until: Date.now() + wait * 1000 }
  }
  if (!['quota', 'account', 'membership', 'outdated', 'voice'].includes(kind)) return null
  const info = { kind }
  const day = error?.details?.usage_day
  // The gateway's usage_day object: { can_authorize, next_extra_at, block_reason, pool_reason, … } at top level.
  // Pool accounts and pack keys never open a day; pool_reason says whether the allowance ran out.
  if (kind === 'quota' && day && typeof day === 'object') {
    info.canAuthorize = day.mode !== 'pool' && day.can_authorize === true
    if (day.pool_reason === 'exhausted' || day.pool_reason === 'insufficient') info.poolReason = day.pool_reason
  }
  // Which ledger the key draws on, and whether the other one could be used instead (newer gateways).
  const details = error?.details ?? {}
  if (details.ledger === 'pack' || details.ledger === 'membership') info.ledger = details.ledger
  // Older gateways put the ledger only inside usage_day (pack / account).
  else if (day && typeof day === 'object' && (day.ledger === 'pack' || day.ledger === 'account')) info.ledger = day.ledger === 'pack' ? 'pack' : 'membership'
  if (typeof details.membership_available === 'boolean') info.membershipAvailable = details.membership_available
  if (typeof details.pack_available === 'boolean') info.packAvailable = details.pack_available
  const next = error?.details?.next_extra_at ?? day?.next_extra_at
  if (typeof next === 'string') info.nextExtraAt = next
  if (typeof error?.roleId === 'string') info.roleId = error.roleId
  return info
}
