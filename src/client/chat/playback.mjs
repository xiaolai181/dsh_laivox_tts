// Latest click wins. Fetching a reading must not replace a more recent choice,
// navigation, or a play/pause action made while the request was in flight.
export function createChatPlayback({ get, player, remember = () => {} }) {
  let version = 0
  let controller
  function cancel() { version++; controller?.abort() }
  return {
    cancel,
    async listen(chapter, job) {
      cancel()
      const current = version
      controller = new AbortController()
      const before = player.getSnapshot()
      try {
        const value = await get('chapter', { id: chapter, job }, controller.signal)
        const now = player.getSnapshot()
        if (current !== version || now.chapter !== before.chapter || now.job !== before.job || now.phase !== before.phase) return false
        if (before.phase !== 'playing' && (now.n !== before.n || now.offset !== before.offset)) return false
        if (!value.playbackJob || !value.media?.some(part => part.ready)) throw new Error('READING_AUDIO_UNAVAILABLE')
        const same = now.chapter === value.id && now.job === value.playbackJob.id
        const saved = value.playback?.job === value.playbackJob.id ? value.playback : null
        const n = Math.min(same ? now.n : saved?.n ?? 0, value.media.length - 1)
        const offset = same ? now.offset : saved?.offset ?? 0
        const ended = n === value.media.length - 1 && value.media[n].seconds > 0 && offset >= value.media[n].seconds - .1
        const target = ended ? 0 : n
        if (!value.media[target]?.ready && !['running', 'queued'].includes(value.playbackJob.state)) throw new Error('READING_AUDIO_UNAVAILABLE')
        player.update(value, true)
        if (ended) player.seek(0)
        player.play()
        remember(value.id)
        return true
      } catch (error) {
        if (current !== version || error?.name === 'AbortError') return false
        throw error
      }
    },
  }
}
