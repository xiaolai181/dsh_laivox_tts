export function shouldShowNovelCapsule({ phase, job, segments, resume, notice, dismissed, mode = 'auto' }) {
  if (mode === 'never' || !job || !segments?.length || dismissed) return false
  if (mode === 'playing') return phase === 'playing' || phase === 'buffering' || Boolean(notice)
  if (notice || resume) return true
  return phase !== 'idle'
}

export function createCapsuleState({ noticeMs = 6000 } = {}) {
  let state = { notice: null, dismissed: false }
  let timer = null
  const listeners = new Set()

  function emit(next) {
    if (next.notice === state.notice && next.dismissed === state.dismissed) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
    show(message) {
      clearTimeout(timer)
      emit({ notice: message, dismissed: false })
      timer = setTimeout(() => {
        timer = null
        emit({ ...state, notice: null })
      }, noticeMs)
      timer.unref?.()
    },
    dismiss() {
      clearTimeout(timer)
      timer = null
      emit({ notice: null, dismissed: true })
    },
    wake() {
      if (state.dismissed) emit({ ...state, dismissed: false })
    },
    dispose() {
      clearTimeout(timer)
      timer = null
      listeners.clear()
    },
  }
}
