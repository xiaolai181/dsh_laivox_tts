// One preview at a time for the whole workbench. The player only keeps a single
// stop callback, so a script line, a voice, a role card and a settings sample
// all go through here instead of registering their own.
export function bindPreviewChannel(player) {
  let token = 0
  let current = null
  let flight = null
  const listeners = new Set()
  const emit = () => { for (const listener of listeners) listener() }
  function stop() {
    token++
    flight?.controller.abort()
    flight = null
    const item = current
    current = null
    if (item) {
      const done = item.done
      item.done = null
      item.audio.onended = null
      item.audio.onerror = null
      item.audio.pause()
      URL.revokeObjectURL(item.url)
      done?.()
    }
    emit()
  }
  player?.registerPreviewStop?.(stop)
  player?.subscribe?.(() => { if (current) current.audio.volume = player.getSnapshot().volume ?? 1 })
  const api = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    currentKey: () => current?.key ?? null,
    stop,
    cancel(key) {
      if (flight?.key !== key) return
      const restore = flight.restore
      stop()
      restore?.()
    },
    // Plays blobs from `loads` in order. Each loader receives an abort signal.
    // A newer play, stop, or the player's own preview stop cancels this one.
    async play(key, loads, { restorePlayback = false } = {}) {
      stop()
      const wasPlaying = restorePlayback && ['playing', 'buffering'].includes(player?.getSnapshot?.()?.phase)
      try { speechStop?.() } catch { /* instant speech may already be idle */ }
      try { player?.pause?.() } catch { /* the novel may already be idle */ }
      const mine = token
      const controller = new AbortController()
      const paused = wasPlaying ? player?.getSnapshot?.() : null
      const restore = paused?.phase === 'paused' ? () => {
        const now = player.getSnapshot()
        if (now.phase === 'paused' && now.chapter === paused.chapter && now.job === paused.job
          && now.n === paused.n && now.offset === paused.offset && now.sleep === paused.sleep) player.play()
      } : null
      flight = { key, controller, restore }
      const list = Array.isArray(loads) ? loads : [loads]
      try {
        for (const load of list) {
          if (mine !== token) return
          const blob = await load(controller.signal)
          if (mine !== token || !blob) return
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          audio.volume = player?.getSnapshot?.().volume ?? 1
          await new Promise((resolve, reject) => {
            current = { key, audio, url, done: resolve }
            emit()
            audio.onended = resolve
            audio.onerror = () => reject(new Error('AUDIO_PLAYBACK_FAILED'))
            audio.play().catch(reject)
          })
          if (mine !== token) return
          audio.onended = audio.onerror = null
          URL.revokeObjectURL(url)
          current = null
          emit()
        }
      } catch (error) {
        if (mine === token && error?.name !== 'AbortError') throw error
      } finally {
        if (mine === token) {
          stop()
          restore?.()
        }
      }
    },
  }
  bound = api
  return api
}

let bound = null
let speechStop = null
export function bindSpeechStop(stop) { speechStop = stop }
export function previewChannel() { return bound }
