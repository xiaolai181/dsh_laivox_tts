// Instant speech in the browser: one <audio> playing the parts of the
// current reading in order, fetching part n+1 while n plays. The newest request
// wins: it stops the previous reading, and a late answer for an older one never
// takes playback back. Speech and the novel never play together: starting to
// read pauses the novel and offers "continue listening" afterwards; pressing
// play on the novel stops the reading.
import { previewChannel } from '../player/previewChannel.mjs'

const RESUME_HINT_MS = 10 * 60 * 1000
const pageId = crypto.randomUUID()

export function createSpeechPlayer({ post, partUrl, player, createAudio = () => new Audio(), fetchPart = defaultFetch }) {
  let state = { phase: 'idle', speechId: null, n: 0, parts: 0, source: null, error: null, truncated: false, resume: null }
  const listeners = new Set()
  let version = 0
  let controller = null
  let audio = null
  let objectUrl = null
  let prefetched = null
  let request = null
  let resumeTimer = null
  const played = new Set()
  const claiming = new Set()
  player?.subscribe?.(() => { if (audio) audio.volume = player.getSnapshot().volume ?? 1 })
  let lastWarm = 0

  function publish(changes) {
    state = { ...state, ...changes }
    for (const listener of listeners) { try { listener() } catch { /* a listener must not break playback */ } }
  }
  function element() {
    if (audio) return audio
    audio = createAudio()
    audio.preload = 'auto'
    return audio
  }
  function release() {
    if (objectUrl) { try { URL.revokeObjectURL(objectUrl) } catch { /* not a blob url */ } }
    objectUrl = null
  }
  function quiet() {
    controller?.abort()
    controller = null
    prefetched = null
    if (audio) { audio.onended = null; audio.onerror = null; try { audio.pause() } catch { /* not started */ } }
    release()
  }

  // The novel was playing: pause it and remember where, for "continue listening".
  function takeFocus() {
    const novel = player?.getSnapshot()
    if (novel && ['playing', 'buffering'].includes(novel.phase) && novel.chapter) {
      player.pause()
      setResume({ chapter: novel.chapter, job: novel.job, title: novel.title, bookTitle: novel.bookTitle })
    }
  }
  function setResume(resume) {
    clearTimeout(resumeTimer)
    resumeTimer = null
    if (resume) {
      resumeTimer = setTimeout(() => publish({ resume: null }), RESUME_HINT_MS)
      resumeTimer.unref?.()
    }
    publish({ resume })
  }

  async function playPart(mine, n) {
    if (mine !== version) return
    if (n >= state.parts) { controller = null; publish({ phase: 'idle', n }); return }
    publish({ n, phase: state.phase === 'playing' ? 'playing' : 'loading' })
    let blob
    try {
      blob = await (prefetched?.n === n ? prefetched.promise : fetchPart(partUrl(state.speechId, n), controller.signal))
    } catch (error) {
      if (mine !== version || error?.name === 'AbortError') return
      controller = null
      publish({ phase: 'error', error: error?.message ?? 'SERVICE_UNAVAILABLE' })
      return
    }
    if (mine !== version) return
    // Fetch the next part while this one plays.
    if (n + 1 < state.parts) {
      const promise = fetchPart(partUrl(state.speechId, n + 1), controller.signal)
      promise.catch(() => {})
      prefetched = { n: n + 1, promise }
    } else prefetched = null
    const media = element()
    media.volume = player?.getSnapshot?.().volume ?? 1
    release()
    objectUrl = URL.createObjectURL(blob)
    media.src = objectUrl
    media.onended = () => { if (mine === version) void playPart(mine, n + 1) }
    media.onerror = () => { if (mine === version) { controller = null; publish({ phase: 'error', error: 'AUDIO_PLAYBACK_FAILED' }) } }
    try {
      await media.play()
      if (mine === version) publish({ phase: 'playing' })
    } catch (error) {
      if (mine !== version) return
      // The browser wants a click first (autoplay policy): show a play button.
      if (error?.name === 'NotAllowedError') publish({ phase: 'blocked' })
      else { controller = null; publish({ phase: 'error', error: 'AUDIO_PLAYBACK_FAILED' }) }
    }
  }

  function begin(changes) {
    const mine = ++version
    quiet()
    controller = new AbortController()
    takeFocus()
    publish({ phase: 'loading', n: 0, error: null, ...changes })
    return mine
  }

  const api = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => state,
    // Read a text: the Host splits and synthesizes it, then the parts play here.
    async speak({ text, voice, source = null, session = null }) {
      const previous = state.speechId
      request = { text, voice, source, session }
      previewChannel()?.stop()
      const mine = begin({ speechId: null, parts: 0, source, truncated: false })
      if (previous) void post('speech/cancel', { speechId: previous }).catch(() => {})
      let started
      try { started = await post('speech/start', { text, voice: voice ?? null, session, owner: pageId }, false, controller.signal) }
      catch (error) {
        if (mine !== version || error?.name === 'AbortError') return
        controller = null
        publish({ phase: 'error', error: error?.message ?? 'SERVICE_UNAVAILABLE' })
        return
      }
      if (mine !== version) { void post('speech/cancel', { speechId: started.speechId }).catch(() => {}); return }
      played.add(started.speechId)
      publish({ speechId: started.speechId, parts: started.parts, truncated: Boolean(started.truncated) })
      await playPart(mine, 0)
    },
    // Play a reading the Host already started (a laivox_speak tool call). Each
    // reading plays by itself at most once; replays go through speak().
    async play({ speechId, parts, source = null, text = null }) {
      if (!speechId || played.has(speechId) || claiming.has(speechId)) return false
      claiming.add(speechId)
      let claimed = false
      try { claimed = (await post('speech/claim', { speechId, page: pageId }))?.ok === true }
      catch { /* a failed claim does not autoplay */ }
      finally { claiming.delete(speechId) }
      if (!claimed || played.has(speechId)) return false
      previewChannel()?.stop()
      played.add(speechId)
      request = text ? { text, source } : null
      const mine = begin({ speechId, parts, source, truncated: false })
      await playPart(mine, 0)
      return true
    },
    hasPlayed: speechId => played.has(speechId),
    // The play button after the browser refused to start audio by itself.
    async unblock() {
      if (state.phase !== 'blocked' || !audio) return
      const mine = version
      try { await audio.play(); if (mine === version) publish({ phase: 'playing' }) }
      catch { if (mine === version) publish({ phase: 'blocked' }) }
    },
    retry() {
      if (request?.text) return api.speak(request)
      return Promise.resolve()
    },
    stop() {
      const speechId = state.speechId
      const active = state.phase !== 'idle' && state.phase !== 'error'
      version++
      quiet()
      if (speechId && active) void post('speech/cancel', { speechId }).catch(() => {})
      publish({ phase: 'idle', error: null })
    },
    // "Continue listening" after a reading: the user decides, never automatic.
    resumeNovel() {
      const resume = state.resume
      setResume(null)
      if (resume && player?.getSnapshot().chapter === resume.chapter) player.play()
      return resume
    },
    dismissResume() { setResume(null) },
    // Open the connection for this text's voice ahead of a click (hover on the
    // button); at most every 20 seconds.
    warm(text) {
      if (Date.now() - lastWarm < 20_000 || !text) return
      lastWarm = Date.now()
      void post('speech/warm', { text: String(text).slice(0, 2000) }).catch(() => {})
    },
    dispose() { version++; quiet(); clearTimeout(resumeTimer); listeners.clear(); unsubscribe?.() },
  }

  // Playing the novel stops the reading; the "continue" hint is no longer needed.
  let lastNovel = player?.getSnapshot().phase
  const unsubscribe = player?.subscribe(() => {
    const phase = player.getSnapshot().phase
    if (phase === lastNovel) return
    lastNovel = phase
    if (phase !== 'playing') return
    if (['loading', 'playing', 'blocked'].includes(state.phase)) api.stop()
    if (state.resume) setResume(null)
  })
  return api
}

async function defaultFetch(url, signal) {
  const response = await fetch(url, { cache: 'no-store', signal })
  if (!response.ok) {
    let code = 'SERVICE_UNAVAILABLE'
    try { code = (await response.json()).error ?? code } catch { /* not JSON */ }
    throw new Error(code)
  }
  return response.blob()
}
