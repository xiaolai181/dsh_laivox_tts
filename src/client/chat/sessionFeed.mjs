import { nextPollDelay } from '../workbench/polling.mjs'

const hiddenNow = () => typeof document !== 'undefined' && document.hidden

// One poll per session, shared by the input dock and every turn tail.
// Confirming a proposal pauses the poll and bumps the generation so a response
// already in flight cannot paint the proposal back.
export function createSessionFeed(get) {
  const rooms = new Map()
  function ensure(session) {
    let item = rooms.get(session)
    if (!item) {
      item = {
        session, listeners: new Set(), state: null, paused: 0, version: 0,
        controller: new AbortController(), inFlight: false, again: false, timer: null,
      }
      rooms.set(session, item)
    }
    return item
  }
  function publish(item) {
    for (const listener of item.listeners) listener()
  }
  function stop(item) {
    clearTimeout(item.timer)
    item.controller.abort()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', item.wake)
    rooms.delete(item.session)
  }
  async function poll(item) {
    if (!item.listeners.size || item.controller.signal.aborted) return
    if (item.inFlight) { item.again = true; return }
    item.inFlight = true
    let delay = 5000
    const current = ++item.version
    const hidden = hiddenNow()
    try {
      if (!hidden && item.paused === 0) {
        const value = await get('session', { id: item.session }, item.controller.signal)
        if (!item.controller.signal.aborted && current === item.version) {
          item.state = value
          publish(item)
        }
        const hasContent = Boolean(value?.proposals?.length || value?.jobs?.length || value?.imports?.length)
        delay = nextPollDelay({ fast: hasContent, fastMs: 1700, idleMs: 5000 })
      } else delay = nextPollDelay({ hidden: true })
    } catch {
      // Keep the previous snapshot. Without one, publish an empty board that says
      // the plugin could not be reached, so the dock can offer a retry.
      if (!item.controller.signal.aborted && current === item.version && (!item.state || item.state.unreachable)) {
        item.state = { proposals: [], jobs: [], imports: [], latest: null, unreachable: true }
        publish(item)
      }
    }
    finally {
      item.inFlight = false
      if (!item.controller.signal.aborted && item.listeners.size) {
        if (item.again) { item.again = false; void poll(item) }
        else item.timer = setTimeout(() => poll(item), delay)
      }
    }
  }
  function wake(item) {
    if (hiddenNow() || !item.listeners.size || item.controller.signal.aborted) return
    clearTimeout(item.timer)
    if (item.inFlight) { item.again = true; return }
    void poll(item)
  }
  return {
    subscribe(session, listener) {
      if (!session) return () => {}
      const item = ensure(session)
      item.listeners.add(listener)
      if (item.listeners.size === 1) {
        item.wake = () => wake(item)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', item.wake)
        void poll(item)
      }
      return () => {
        item.listeners.delete(listener)
        if (!item.listeners.size) stop(item)
      }
    },
    getSnapshot(session) {
      if (!session) return null
      return ensure(session).state
    },
    beginAction(session) {
      const item = ensure(session)
      item.paused += 1
      item.version += 1
    },
    endAction(session) {
      const item = rooms.get(session)
      if (!item) return
      item.paused = Math.max(0, item.paused - 1)
      if (item.paused === 0) wake(item)
    },
    retry(session) {
      const item = rooms.get(session)
      if (item) wake(item)
    },
    replace(session, state) {
      const item = rooms.get(session)
      if (!item) return
      item.version += 1
      item.state = state
      publish(item)
    },
  }
}
