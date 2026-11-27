import { translate as t } from '../i18n/locale.mjs'
import { post, url } from '../api.mjs'

// Extra silence before the first part of a new paragraph. Sentences inside a
// paragraph follow each other without a gap.
export const PARAGRAPH_PAUSE_MS = 280
export const SLEEP_MINUTES = [15, 30, 60]
const FADE_MS = 3000
const FADE_STEPS = 30

// audio / spare: two elements alternate so the next part is already loaded when
// the current one ends. A caller that injects only `audio` (the unit tests)
// gets the single-element behavior. Elements keep their default
// preservesPitch, which is why playback does not use Web Audio.
function storedVolume(storage) {
  try {
    const raw = storage?.getItem?.('lv-volume')
    if (raw === null || raw === undefined || String(raw).trim() === '') return 1
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0 && value <= 1) return value
  } catch { /* storage can be blocked */ }
  return 1
}

export function createPlayerController({
  audio, spare, save = value => post('playback/save', value, true),
  getPreferences = () => ({ paragraphPause: true }),
  mediaSession = globalThis.navigator?.mediaSession,
  storage = globalThis.localStorage,
} = {}) {
  let active = audio ?? new Audio()
  let standby = spare !== undefined ? spare : (audio ? null : new Audio())
  const elements = [active, standby].filter(Boolean)
  let state = { chapter: null, title: '', bookTitle: '', job: null, nextId: null, segments: [], n: 0, offset: 0, rate: 1, volume: storedVolume(storage), phase: 'idle', sleep: null, swapped: '', autoResuming: false }
  let source = ''
  let standbySource = ''
  let intent = false
  let request = 0
  let persisted = 0
  let seekOffset = 0
  let previewStop
  let endedNotified = false
  // The last part ended while the job was still adding parts (scripting and
  // synthesis overlap): the player waits past the end instead of ending.
  let overrun = false
  let pendingSwap = null
  let pauseTimer = null
  let sleepTimer = null
  let fadeTimer = null
  const saves = new Map()
  const listeners = new Set()
  const endedListeners = new Set()

  function publish(update) {
    state = { ...state, ...update }
    for (const listener of listeners) listener()
  }

  function saveState(record, update) {
    if (state.chapter === record.chapter) publish(update)
  }

  // A failed bookmark stays retryable until it is saved: a later routine position
  // save must not clear it (it only supersedes a failed routine save).
  function drain(record) {
    if (record.running || !record.queue.length || record.conflict) return
    const item = record.queue.shift()
    record.running = true
    function done(result, error) {
      record.running = false
      if (error) {
        if (!record.failed?.bookmark || item.bookmark) record.failed = item
        if (error.message === 'PLAYBACK_CONFLICT') {
          record.conflict = true
          record.queue.length = 0
        }
        saveState(record, { saveMessage: error.message === 'PLAYBACK_CONFLICT' ? '播放进度已在其他窗口更新。请重新打开本章。' :
          item.bookmark ? '书签保存失败，可重试。' : '播放位置尚未保存，可重试。', saveFailed: true })
      } else {
        record.revision = result?.revision ?? record.revision
        if (record.failed === item || (record.failed && !record.failed.bookmark) || item.bookmark) record.failed = null
        if (item.bookmark) saveState(record, { saveMessage: '书签已保存', saveFailed: false })
        else if (state.chapter === record.chapter && state.saveFailed && !record.failed) saveState(record, { saveMessage: '', saveFailed: false })
      }
      drain(record)
    }
    try {
      const result = save({ ...item, expectedRevision: record.revision })
      if (result?.then) result.then(value => done(value), error => done(null, error))
      else done(result)
    } catch (error) { done(null, error) }
  }

  function persist(bookmark = false) {
    const { chapter, job, n, offset, rate, volume } = state
    if (!chapter || !job) return
    persisted = Date.now()
    const record = saves.get(chapter)
    if (!record || record.conflict) return
    const start = state.segments[n]?.start
    const snapshot = { chapter, job, n, offset, rate, volume, bookmark, ...(Number.isSafeInteger(start) ? { start } : {}) }
    if (bookmark) {
      const first = record.queue.findIndex(item => item.bookmark)
      if (first !== -1) record.queue.splice(first, 1)
    } else if (record.queue.at(-1)?.bookmark === false) record.queue.pop()
    record.queue.push(snapshot)
    drain(record)
  }

  const segmentUrl = n => url('media/segment', { job: state.job, n })

  function clearPause() {
    if (pauseTimer !== null) clearTimeout(pauseTimer)
    pauseTimer = null
  }

  function partIndex(media, start) {
    if (!Number.isSafeInteger(start)) return 0
    const index = (media ?? []).findIndex(part => Number.isSafeInteger(part.end) && part.end > start)
    return index >= 0 ? index : 0
  }
  function playbackReady(chapter) {
    const media = chapter?.media ?? []
    const job = chapter?.playbackJob
    return media.length > 0 && media.every(part => part.ready) && job?.state !== 'running' && job?.state !== 'queued' && !job?.open
  }
  function swapTo(chapter, at, wasPlaying) {
    pendingSwap = null
    const job = chapter.playbackJob?.id ?? null
    const jobState = chapter.playbackJob?.state
    suspend()
    source = ''
    clearStandby()
    publish({
      chapter: chapter.id, title: chapter.title ?? '', bookTitle: chapter.bookTitle ?? '', job, nextId: chapter.nextId ?? null,
      segments: chapter.media, n: partIndex(chapter.media, at), offset: 0, phase: 'idle',
      settled: jobState !== 'running' && jobState !== 'queued',
      generationStopped: jobState === 'paused' || jobState === 'cancelled',
      autoResuming: jobState === 'paused' && Number.isFinite(chapter.playbackJob?.autoResume?.at),
      growing: false, stale: chapter.playbackStale,
      swapped: { engine: chapter.playbackJob?.engine ?? '' },
    })
    persist()
    if (wasPlaying) { intent = true; start() }
  }
  function takeSwap() {
    const next = pendingSwap
    if (!next) return
    swapTo(next.chapter, next.at, true)
  }
  function clearStandby() {
    standbySource = ''
    if (!standby) return
    standby.pause()
    standby.removeAttribute('src')
    standby.load?.()
  }

  // Load the next part into the idle element while the current one plays.
  function preload() {
    if (!standby || !intent || !state.job) return
    const next = state.segments[state.n + 1]
    if (!next?.ready) return
    const target = segmentUrl(state.n + 1)
    if (standbySource === target) return
    standbySource = target
    standby.preload = 'auto'
    standby.src = target
    standby.load?.()
  }

  function suspend() {
    intent = false
    request++
    clearPause()
    active.pause()
  }

  function playActive() {
    const version = ++request
    active.playbackRate = state.rate
    active.volume = state.volume
    endedNotified = false
    publish({ phase: 'playing' })
    void Promise.resolve(active.play()).catch(() => {
      if (version === request && intent) {
        intent = false
        publish({ phase: 'error' })
      }
    })
    preload()
  }

  function start() {
    if (!intent || !state.job) return
    const row = state.segments[state.n]
    // A stopped generation may leave the current segment without audio. Say so
    // instead of silently flipping back to paused.
    if (state.generationStopped && !row?.ready) {
      suspend()
      publish({ phase: 'blocked' })
      return
    }
    if (!row) {
      // Waited past the end for parts that no longer come: the chapter ends now.
      if (overrun && !state.growing && state.segments.length) {
        overrun = false
        publish({ n: state.segments.length - 1 })
        chapterEnded()
        return
      }
      publish({ phase: state.settled && state.segments.length ? 'ended' : 'buffering' })
      if (state.phase === 'ended') intent = false
      return
    }
    overrun = false
    const ready = row.ready && (state.n > 0 || state.segments.length === 1 || state.segments[1]?.ready || state.settled)
    if (!ready) { publish({ phase: 'buffering' }); return }
    const next = segmentUrl(state.n)
    if (source === next && state.phase === 'playing') return
    if (next !== source) {
      source = next
      seekOffset = state.offset
      active.src = next
    }
    playActive()
  }

  // Continue with state.n after a part ended. Swap to the preloaded element
  // when it holds exactly this part; otherwise load it the regular way.
  function advance() {
    pauseTimer = null
    if (pendingSwap) { takeSwap(); return }
    if (!intent) return
    const row = state.segments[state.n]
    const target = segmentUrl(state.n)
    if (standby && standbySource === target && row?.ready) {
      const previous = active
      active = standby
      standby = previous
      standbySource = ''
      source = target
      // A jump made during the paragraph pause already moved the offset into this
      // part. The preloaded element has its metadata, so apply it right away.
      const offset = state.offset
      seekOffset = 0
      if (offset > 0) {
        if (active.readyState >= 1 && Number.isFinite(active.duration)) active.currentTime = Math.min(offset, Math.max(0, active.duration - 0.05))
        else seekOffset = offset
      }
      playActive()
      return
    }
    publish({ phase: 'buffering' })
    start()
  }

  // Event handlers only listen to the element that is currently playing; the
  // standby element loads silently in the background.
  const fromActive = handler => event => { if (!event?.target || event.target === active) handler() }
  const onMetadata = () => {
    if (seekOffset > 0 && Number.isFinite(active.duration)) active.currentTime = Math.min(seekOffset, Math.max(0, active.duration - 0.05))
    seekOffset = 0
  }
  const onTime = () => {
    if (!source || !intent || state.phase !== 'playing') return
    publish({ offset: active.currentTime })
    if (Date.now() - persisted > 4000) persist()
  }
  const onEnded = () => {
    if (pendingSwap) { takeSwap(); return }
    if (!source || !intent || state.phase !== 'playing') return
    const last = state.n + 1 >= state.segments.length
    if (last && state.growing) {
      if (state.generationStopped) {
        publish({ phase: 'blocked' })
        return
      }
      overrun = true
      publish({ n: state.n + 1, offset: 0, phase: 'buffering' })
      return
    }
    if (!last) {
      const paragraph = state.segments[state.n + 1]?.para === true && getPreferences()?.paragraphPause !== false
      // While pausing between paragraphs the player still counts as playing.
      publish({ n: state.n + 1, offset: 0, phase: paragraph ? 'playing' : 'buffering' })
      persist()
      if (paragraph) pauseTimer = setTimeout(advance, PARAGRAPH_PAUSE_MS)
      else advance()
      return
    }
    chapterEnded()
  }
  function chapterEnded() {
    publish({ offset: active.duration || state.offset, phase: 'ended' })
    persist()
    intent = false
    if (endedNotified) return
    endedNotified = true
    // "Stop at the end of this chapter" consumes the chapter end, so the
    // workbench does not continue with the next chapter.
    if (state.sleep?.mode === 'chapter') {
      publish({ sleep: null })
      return
    }
    for (const listener of endedListeners) {
      try { listener({ chapter: state.chapter, job: state.job, nextId: state.nextId }) } catch { /* listeners must not break playback */ }
    }
  }
  const onError = () => {
    if (source && intent) { intent = false; clearPause(); publish({ phase: 'error' }) }
  }
  // A preload that fails must not be swapped in later; the part then loads the regular way.
  const onAnyError = event => {
    if (event?.target && event.target !== active) {
      if (event.target === standby) standbySource = ''
      return
    }
    onError()
  }
  const events = { loadedmetadata: fromActive(onMetadata), timeupdate: fromActive(onTime), ended: fromActive(onEnded), error: onAnyError }
  for (const element of elements) for (const [key, listener] of Object.entries(events)) element.addEventListener(key, listener)

  function setVolume(level) {
    for (const element of elements) element.volume = level
  }

  let fadeStarted = false
  function clearSleep() {
    if (sleepTimer !== null) clearInterval(sleepTimer)
    if (fadeTimer !== null) clearInterval(fadeTimer)
    if (fadeTimer !== null) setVolume(state.volume)
    sleepTimer = null
    fadeTimer = null
    fadeStarted = false
  }

  function fadeOut() {
    if (fadeStarted) return
    fadeStarted = true
    let step = 0
    const restore = state.volume
    fadeTimer = setInterval(() => {
      step++
      setVolume(restore * Math.max(0, 1 - step / FADE_STEPS))
      if (step < FADE_STEPS) return
      clearInterval(fadeTimer)
      fadeTimer = null
      api.pause()
      setVolume(restore)
      publish({ sleep: null })
    }, FADE_MS / FADE_STEPS)
  }

  function sessionCall(fn) {
    if (!mediaSession) return
    try { fn(mediaSession) } catch { /* some hosts reject individual actions */ }
  }

  const sessionActions = ['play', 'pause', 'previoustrack', 'nexttrack']

  // A chapter saved at its very end would play for a moment and immediately
  // continue with the next chapter. Reopening it starts it over instead.
  function resumePoint(saved, media) {
    const n = Math.min(saved?.n ?? 0, Math.max(0, media.length - 1))
    const offset = saved?.offset ?? 0
    const seconds = media[n]?.seconds || 0
    if (n === media.length - 1 && seconds > 0 && offset >= seconds - 0.1) return { n: 0, offset: 0 }
    return { n, offset }
  }

  const api = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    update(chapter, takeFocus = false) {
      const job = chapter.playbackJob?.id ?? null
      const jobState = chapter.playbackJob?.state
      const settled = jobState !== 'running' && jobState !== 'queued'
      const generationStopped = jobState === 'paused' || jobState === 'cancelled'
      const autoResuming = jobState === 'paused' && Number.isFinite(chapter.playbackJob?.autoResume?.at)
      // The job is still planning more parts (it scripts and synthesizes at once).
      const growing = chapter.playbackJob?.open === true
      if (state.chapter === chapter.id && state.job && job && state.job !== job && !takeFocus && playbackReady(chapter)) {
        const from = state.segments[state.n]
        if (intent) pendingSwap = { chapter, at: Number.isSafeInteger(from?.end) ? from.end : from?.start }
        else swapTo(chapter, Number.isSafeInteger(from?.start) ? from.start : 0, false)
        return
      }
      if (state.chapter === chapter.id && state.job === job) {
        const record = saves.get(chapter.id)
        let position
        if (takeFocus && record?.conflict) {
          record.revision = chapter.playbackRev
          record.conflict = false
          record.failed = null
          suspend()
          source = ''
          clearStandby()
          const saved = chapter.playback?.job === job ? chapter.playback : null
          position = { ...resumePoint(saved, chapter.media), phase: 'idle' }
        }
        publish({ title: chapter.title ?? state.title, nextId: chapter.nextId ?? null, segments: chapter.media, settled, generationStopped, autoResuming, growing,
          stale: chapter.playbackStale, ...(takeFocus || state.chapter !== chapter.id ? { swapped: '' } : {}),
          ...position, ...(takeFocus && !record?.failed ? { saveMessage: '', saveFailed: false } : {}) })
        // blocked waits for audio that a stopped job could not make. Once the job
        // runs again or the part exists, hand the play button back (still no
        // automatic start).
        if (state.phase === 'blocked' && (!generationStopped || state.segments[state.n]?.ready)) publish({ phase: 'paused' })
        if (state.phase === 'buffering') start()
        else if (state.phase === 'playing') preload()
        return
      }
      if (!takeFocus) return
      pendingSwap = null
      if (state.chapter) persist()
      previewStop?.()
      suspend()
      source = ''
      clearStandby()
      endedNotified = false
      const saved = chapter.playback?.job === job ? chapter.playback : null
      const placed = saved ? resumePoint(saved, chapter.media) : Number.isSafeInteger(chapter.playback?.start) ? { n: partIndex(chapter.media, chapter.playback.start), offset: 0 } : resumePoint(null, chapter.media)
      let record = saves.get(chapter.id)
      if (chapter.id && (!record || record.conflict)) {
        record = { chapter: chapter.id, revision: chapter.playbackRev, queue: [] }
        saves.set(chapter.id, record)
      }
      // "Stop at the end of this chapter" belongs to the chapter it was set on.
      if (state.sleep?.mode === 'chapter' && state.sleep.chapter !== chapter.id) publish({ sleep: null })
      publish({
        chapter: chapter.id, title: chapter.title, bookTitle: chapter.bookTitle ?? '', job, nextId: chapter.nextId ?? null, segments: chapter.media,
        ...placed,
        rate: saved?.rate ?? state.rate, volume: state.volume, phase: 'idle',
        settled, generationStopped, autoResuming, growing, stale: chapter.playbackStale, swapped: '', saveMessage: '', saveFailed: Boolean(record?.failed),
      })
      overrun = false
      sessionCall(session => {
        if (typeof globalThis.MediaMetadata === 'function') {
          session.metadata = new globalThis.MediaMetadata({ title: chapter.title ?? '', artist: chapter.bookTitle ?? '', album: t('小说配音（LaiVox）') })
        }
      })
    },
    toggle() {
      if (intent) {
        suspend()
        publish({ phase: 'paused' })
        persist()
      } else this.play()
    },
    play() {
      if (intent || !state.job) return
      previewStop?.()
      // An element that failed does not pick a source again by itself: reload it.
      if (state.phase === 'error') source = ''
      if (state.phase === 'ended') this.seek(0)
      intent = true
      start()
    },
    onEnded(callback) {
      endedListeners.add(callback)
      return () => { endedListeners.delete(callback) }
    },
    pause() {
      pendingSwap = null
      if (!intent) return
      suspend()
      publish({ phase: 'paused' })
      persist()
    },
    registerPreviewStop(callback) {
      previewStop = callback
      return () => { if (previewStop === callback) previewStop = null }
    },
    retrySave() {
      const record = saves.get(state.chapter)
      if (!record?.failed || record.conflict) return
      record.queue.unshift(record.failed)
      drain(record)
    },
    seek(n, offset = 0) {
      pendingSwap = null
      if (!state.segments[n]) return
      request++
      clearPause()
      active.pause()
      source = ''
      clearStandby()
      publish({ n, offset, phase: intent ? 'buffering' : 'paused' })
      start()
      persist()
    },
    seekTime(seconds) {
      const segments = state.segments
      if (!segments.length) return
      const duration = segments.reduce((total, part) => total + (part.seconds || 0), 0)
      const target = Math.max(0, Math.min(Number(seconds) || 0, duration))
      let n = 0
      let start = 0
      for (let index = 0; index < segments.length; index++) {
        const length = segments[index].seconds || 0
        if (target < start + length || index === segments.length - 1) { n = index; break }
        start += length
      }
      const offset = Math.max(0, Math.min(target - start, Math.max(0, (segments[n]?.seconds || 0) - 0.05)))
      if (n === state.n && source && Number.isFinite(active.duration)) {
        active.currentTime = Math.min(offset, Math.max(0, active.duration - 0.05))
        // After the chapter ended, a seek inside the last part is where play resumes.
        publish({ offset, ...(state.phase === 'ended' ? { phase: 'paused' } : {}) })
        persist()
        return
      }
      this.seek(n, offset)
    },
    speed(rate) {
      for (const element of elements) element.playbackRate = rate
      publish({ rate })
      persist()
    },
    volume(volume) {
      setVolume(volume)
      try { storage?.setItem?.('lv-volume', String(volume)) } catch { /* storage can be blocked */ }
      publish({ volume })
      persist()
    },
    // mode: 15 | 30 | 60 minutes, 'chapter' (stop at the end of this chapter), or null to cancel.
    sleep(mode) {
      clearSleep()
      if (mode === 'chapter') { publish({ sleep: { mode, chapter: state.chapter } }); return }
      if (!SLEEP_MINUTES.includes(mode)) { publish({ sleep: null }); return }
      const until = Date.now() + mode * 60_000
      publish({ sleep: { mode, until } })
      sleepTimer = setInterval(() => {
        if (Date.now() < until) return
        clearInterval(sleepTimer)
        sleepTimer = null
        fadeOut()
      }, 1000)
    },
    bookmark() { persist(true) },
    flush() { persist() },
    dispose() {
      persist()
      previewStop?.()
      suspend()
      clearSleep()
      endedListeners.clear()
      for (const element of elements) {
        for (const [key, listener] of Object.entries(events)) element.removeEventListener(key, listener)
        element.removeAttribute('src')
        element.load()
      }
      sessionCall(session => { for (const action of sessionActions) session.setActionHandler(action, null) })
    },
  }

  setVolume(state.volume)
  sessionCall(session => {
    session.setActionHandler('play', () => api.play())
    session.setActionHandler('pause', () => api.pause())
    session.setActionHandler('previoustrack', () => api.seek(state.n - 1))
    session.setActionHandler('nexttrack', () => api.seek(state.n + 1))
  })
  return api
}
