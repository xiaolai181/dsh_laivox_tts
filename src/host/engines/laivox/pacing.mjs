// How many LaiVox parts run at once and how long to wait between status checks.
// The gateway decides both (docs/laivox/02 §4.3): it hands out a concurrency
// credit and, to 0.5.0+ plugins, a poll_after_ms per task, and it enforces its
// own limits whatever the plugin does. The plugin only follows those hints; the
// bounds below only guard against malformed values, they set no policy.
const LANES_MAX = 8
const POLL_MIN_MS = 500
const POLL_MAX_MS = 60_000

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

// Lanes the gateway currently allows. Without any hint yet: one, until the first
// accepted submission brings one. After a 429 without a hint the plugin backs
// off by one lane until the gateway speaks again.
export function laneTarget(hints) {
  const credit = Number(hints?.concurrency?.credit)
  const allowed = Number.isFinite(credit) && credit >= 1 ? clamp(Math.floor(credit), 1, LANES_MAX) : 1
  return Number.isInteger(hints?.narrowed) ? clamp(Math.min(allowed, hints.narrowed), 1, LANES_MAX) : allowed
}

// The gateway's suggestion for one task, or null when it gave none.
export function pollHint(value) {
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? clamp(Math.round(ms), POLL_MIN_MS, POLL_MAX_MS) : null
}

// Shared by every client of one session: a change of the allowed lanes wakes
// whoever runs the lanes, so a wider credit is used within the same chapter.
function atCap(concurrency) {
  const inflight = Number(concurrency?.inflight)
  const credit = Number(concurrency?.credit)
  return Number.isFinite(inflight) && Number.isFinite(credit) && inflight >= credit
}

export function noteConcurrency(hints, concurrency) {
  if (!concurrency || typeof concurrency !== 'object') return
  const before = laneTarget(hints)
  hints.concurrency = concurrency
  // An old gateway omits inflight. A new one that still has room clears the narrowing.
  if (!Number.isFinite(Number(concurrency.inflight)) || !atCap(concurrency)) delete hints.narrowed
  if (laneTarget(hints) !== before) for (const listener of hints.listeners ?? []) listener()
}

export function noteBusy(hints, concurrency) {
  if (concurrency && typeof concurrency === 'object') {
    noteConcurrency(hints, concurrency)
    if (atCap(concurrency)) {
      const before = laneTarget(hints)
      hints.narrowed = Math.max(1, before - 1)
      if (laneTarget(hints) !== before) for (const listener of hints.listeners ?? []) listener()
    }
    return
  }
  const before = laneTarget(hints)
  hints.narrowed = Math.max(1, before - 1)
  if (laneTarget(hints) !== before) for (const listener of hints.listeners ?? []) listener()
}

export function onLanesChange(hints, listener) {
  hints.listeners ??= new Set()
  hints.listeners.add(listener)
  return () => hints.listeners.delete(listener)
}
