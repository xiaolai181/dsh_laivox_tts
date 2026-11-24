// Polling cadence shared by the workbench, the chat dock and the mini player.
// Hidden tabs back off to a slow cadence regardless of activity; active work
// uses the caller's fast interval, everything else the idle interval.
export const HIDDEN_DELAY = 30_000

export function nextPollDelay({ hidden = false, fast = false, fastMs = 2200, idleMs = 8000 } = {}) {
  if (hidden) return HIDDEN_DELAY
  return fast ? fastMs : idleMs
}
