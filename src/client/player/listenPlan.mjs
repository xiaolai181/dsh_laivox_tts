const ACTIVE = ['queued', 'running', 'paused']

// One decision for every "listen from here" control. Playback of a previous
// revision is not treated as ready audio for the current text.
export function decideListen({ chapter, playerJob, start, offset = 0, mode }) {
  const operation = chapter?.operation
  const active = operation && (operation.purpose ?? 'generate') === 'generate' && ACTIVE.includes(operation.state) ? operation : null
  const playback = chapter?.playbackJob
  const media = chapter?.media ?? []
  const index = media.findIndex(part => part.end > start)
  // A finished version keeps playing the sentence that was clicked, even while a
  // newer job is running. A stale chapter with nothing in progress still starts
  // a new generation so the edited text gets audio.
  const playbackComplete = media.length > 0 && media.every(part => part.ready) && !playback?.open
  const sameVersion = !chapter?.playbackStale && (!active || active.id === playback?.id)
  const keepFinished = Boolean(active) && active.id !== playback?.id && playbackComplete
  if (index >= 0 && media[index].ready && (sameVersion || keepFinished)) return { type: 'play', n: index, offset }
  if (!active) return { type: 'start', focusStart: start }
  if (mode && active.mode && active.mode !== mode) return { type: 'mismatch', mode: active.mode }
  const scope = active.scope === 'range' ? 'range' : 'chapter'
  if (active.state === 'paused' || active.state === 'queued') return { type: 'resume', id: active.id, start, scope }
  if (playerJob !== active.id) return { type: 'adopt', id: active.id, start, scope }
  const parts = playback?.id === active.id ? chapter.media ?? [] : []
  const n = parts.findIndex(part => part.end > start)
  return { type: 'steer', id: active.id, n: n >= 0 ? n : null, start, end: n >= 0 ? parts[n].end : null, scope }
}
