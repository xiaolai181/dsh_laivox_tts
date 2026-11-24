// Settings take effect as soon as a control changes. Saves are optimistic and
// serialized: the stored revision guards against lost updates, so changes made
// while a save is in flight are merged into one pending save instead of racing
// it. A conflict adopts the stored revision and retries once; any other
// failure puts the shown values back to what is stored and reports it.
//
// read()/write() access the settings the UI shows; send(expectedRevision,
// changes) stores changes and resolves with { revision, values }.
export function createSettingsQueue({ read, write, send, fail }) {
  let confirmed = null
  let pending = null
  let running = null

  async function drain() {
    let ok = true
    while (pending) {
      const changes = pending
      pending = null
      for (let attempt = 0; ; attempt++) {
        try {
          confirmed = await send(confirmed.revision, changes)
          break
        } catch (error) {
          if (error?.message === 'VERSION_CONFLICT' && error.details?.values && attempt === 0) { confirmed = error.details; continue }
          ok = false
          fail(error)
          break
        }
      }
    }
    // Nothing is pending and no await follows, so a change made from here on
    // starts a fresh drain instead of being dropped.
    running = null
    write(confirmed)
    return ok
  }

  return {
    save(changes) {
      confirmed ??= read()
      const shown = read()
      write({ ...shown, values: { ...shown.values, ...changes } })
      pending = { ...pending, ...changes }
      running ??= drain()
      return running
    },
    // A fresh read from storage. Ignored while a save runs: that save already
    // knows a newer revision.
    adopt(value) {
      if (running) return false
      confirmed = value
      write(value)
      return true
    },
    get running() { return Boolean(running) },
  }
}
