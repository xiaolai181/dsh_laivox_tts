import { useEffect, useRef, useState } from 'react'
import { get } from '../api.mjs'

// Word timing for one audio part, fetched once and kept for the parts around
// the listener. Missing timing (LaiVox, older audio) is an empty list and the
// stage falls back to its estimate; a failed request is not cached so the next
// visit to that part tries again.
const LIMIT = 200
const cache = new Map()
const inflight = new Map()

function remember(key, marks) {
  cache.delete(key)
  cache.set(key, marks)
  if (cache.size > LIMIT) cache.delete(cache.keys().next().value)
}

export function loadMarks(job, n) {
  const key = job + ':' + n
  if (cache.has(key)) return Promise.resolve(cache.get(key))
  if (inflight.has(key)) return inflight.get(key)
  const task = get('media/marks', { job, n })
    .then(value => Array.isArray(value?.marks) ? value.marks : [], () => null)
    .then(marks => {
      inflight.delete(key)
      if (marks) remember(key, marks)
      return marks ?? []
    })
  inflight.set(key, task)
  return task
}

export function useMarks(job, n, ready, nextReady) {
  const key = job && ready && Number.isInteger(n) ? job + ':' + n : null
  const [state, setState] = useState({ key: null, marks: null })
  useEffect(() => {
    if (!key) return undefined
    let alive = true
    if (cache.has(key)) setState({ key, marks: cache.get(key) })
    else void loadMarks(job, n).then(marks => { if (alive) setState({ key, marks }) })
    // The next part is usually seconds away; have its timing ready.
    if (nextReady) void loadMarks(job, n + 1)
    return () => { alive = false }
  }, [key, nextReady])
  if (!key) return null
  return state.key === key ? state.marks : cache.get(key) ?? null
}

// The player publishes its clock a few times per second (timeupdate). While
// playing, extrapolate between updates so the highlight moves smoothly; never
// run more than one update interval ahead in case the audio stalls.
const AHEAD_LIMIT = 0.3

export function useSmoothOffset(snapshot, enabled = true) {
  const playing = enabled && snapshot.phase === 'playing'
  const base = useRef({ n: -1, offset: -1, at: 0 })
  if (base.current.n !== snapshot.n || base.current.offset !== snapshot.offset) {
    base.current = { n: snapshot.n, offset: snapshot.offset, at: performance.now() }
  }
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return undefined
    const timer = setInterval(() => tick(value => value + 1), 80)
    return () => clearInterval(timer)
  }, [playing])
  if (!playing) return snapshot.offset
  const rate = snapshot.rate || 1
  const ahead = Math.min(AHEAD_LIMIT * rate, (performance.now() - base.current.at) / 1000 * rate)
  return snapshot.offset + Math.max(0, ahead)
}
