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

export async function runFollowListen(ctx, decision, chapterId, start, offset, order) {
  if (!decision || ctx.isStale(order, chapterId)) return
  if (decision.type === 'play') {
    ctx.clearPending()
    ctx.seekAndPlay(decision.n, offset)
    return
  }
  if (decision.type === 'mismatch') {
    ctx.flashMismatch(decision.mode)
    return
  }
  if (decision.type === 'start') {
    const result = await ctx.generate(decision.focusStart)
    if (ctx.isStale(order, chapterId)) return
    if (!result?.ok) {
      if (result?.reason === 'busy') ctx.flashBusy()
      if (result?.reason === 'pending') ctx.flashPending()
      return
    }
    ctx.setPending(chapterId, start)
    ctx.consumeListen()
    return
  }
  if (decision.type === 'adopt') {
    await ctx.refresh(decision.id, true).catch(error => { if (!ctx.isStale(order, chapterId)) ctx.onError(error) })
    if (ctx.isStale(order, chapterId)) return
    const nextView = ctx.getView()
    const nextMode = nextView?.operation && ['queued', 'running', 'paused'].includes(nextView.operation.state) ? nextView.operation.mode : ctx.getMode()
    const next = decideListen({ chapter: nextView, playerJob: ctx.getPlayerJob(), start, offset, mode: nextMode || ctx.getMode() })
    if (next.type !== 'adopt') await runFollowListen(ctx, next, chapterId, start, offset, order)
    return
  }
  try {
    if (decision.scope === 'range') {
      const included = await ctx.includeRange(decision.id, decision.start, decision.end)
      if (ctx.isStale(order, chapterId)) return
      if (!included) {
        const operation = ctx.getView()?.operation
        if (!operation || !['queued', 'running', 'paused'].includes(operation.state)) {
          await runFollowListen(ctx, { type: 'start', focusStart: start }, chapterId, start, offset, order)
        }
        return
      }
    }
    if (decision.type === 'resume' || decision.n == null) {
      await ctx.resumeJob(decision.id, decision.start)
      if (ctx.isStale(order, chapterId)) return
    } else if (decision.scope !== 'range') {
      const { focused } = await ctx.focusJob(decision.id, decision.n)
      if (ctx.isStale(order, chapterId)) return
      if (focused) ctx.flashFocused()
      if (!focused) {
        const operation = ctx.getView()?.operation
        if (!operation || !['queued', 'running', 'paused'].includes(operation.state)) {
          await runFollowListen(ctx, { type: 'start', focusStart: start }, chapterId, start, offset, order)
        } else ctx.setPending(chapterId, start)
        return
      }
    } else if (decision.n != null) {
      await ctx.focusJob(decision.id, decision.n).catch(() => {})
      if (ctx.isStale(order, chapterId)) return
    }
    ctx.setPending(chapterId, start)
    await ctx.refresh().catch(error => { if (!ctx.isStale(order, chapterId)) ctx.onError(error) })
    if (ctx.isStale(order, chapterId)) return
    ctx.consumeListen()
  } catch (error) {
    if (!ctx.isStale(order, chapterId)) ctx.onError(error)
  }
}
