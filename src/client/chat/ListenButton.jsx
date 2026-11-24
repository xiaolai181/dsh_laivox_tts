import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { explain } from '../api.mjs'

export function ListenButton({ chapter, job, player, listen, label = t('收听') }) {
  const state = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = state.chapter === chapter && (!job || state.job === job)
  const playing = current && ['playing', 'buffering'].includes(state.phase)
  async function click() {
    if (pending.current) return
    setError('')
    if (playing) { player.pause(); return }
    pending.current = true; setLoading(true)
    try { await listen(chapter, job) }
    catch (failure) { if (mounted.current) setError(deferText(() => explain(failure))) }
    finally { pending.current = false; if (mounted.current) setLoading(false) }
  }
  return <span className="lv-hactions">
    <button className="lv-hbtn" disabled={loading} onClick={click}>{loading ? t('正在载入…') : playing ? t('暂停') : current && state.phase === 'paused' ? t('继续播放') : label}</button>
    {(error || (current && state.phase === 'error')) && <span className="lv-halert" role="alert">{displayText(error || t('播放失败，请重试。'))}</span>}
  </span>
}
