import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useSyncExternalStore } from 'react'
import { explain } from '../api.mjs'
import { speakView } from './speakCard.mjs'

// The laivox_speak tool card. It starts playing by itself only when this mount
// saw the call go from running to a result, the page is visible, and the reading
// has not played yet; a card rendered from history never plays by itself.
export function SpeakCard({ phase, block, sessionId, speech }) {
  const view = speakView({ phase, block })
  const state = useSyncExternalStore(speech.subscribe, speech.getSnapshot)
  const sawRunning = useRef(view.kind === 'running')
  useEffect(() => {
    if (view.kind === 'running') { sawRunning.current = true; return }
    if (view.kind !== 'started' || !sawRunning.current) return
    sawRunning.current = false
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    void speech.play({ speechId: view.speechId, parts: view.parts, source: 'tool:' + view.speechId, text: view.text })
  }, [view.kind, view.speechId])
  const line = body => <div className="lv-host lv-htool"><div className="lv-hline">{body}</div></div>
  if (view.kind === 'running') return line(<span className="lv-hmeta">{t("正在准备朗读…")}</span>)
  if (view.kind === 'failed') return line(<span className="lv-halert" role="alert">{t("朗读没有开始")}{view.detail ? '：' + view.detail : '。'}</span>)
  const source = 'tool:' + view.speechId
  const mine = state.source === source
  const phaseNow = mine ? state.phase : 'idle'
  // A replay reads the original text again (the old id may have expired).
  const again = () => void speech.speak({ text: view.text, source, session: sessionId ?? null })
  const meta = <span className="lv-hmeta">{t("朗读 ·") + " "}{view.characters}{" " + t("字")}</span>
  if (phaseNow === 'loading' || phaseNow === 'playing') {
    return line(<>{meta}<span className="lv-hgrow lv-hmeta"> · {phaseNow === 'loading' ? t('正在准备') : t("正在朗读 {v1} / {v2}", { v1: state.n + 1, v2: state.parts })}</span>
      <span className="lv-hactions"><button type="button" className="lv-hbtn" onClick={() => speech.stop()}>{t("停止")}</button></span></>)
  }
  if (phaseNow === 'blocked') {
    return line(<>{meta}<span className="lv-hgrow lv-hmeta">{" " + t("· 点一下开始播放")}</span>
      <span className="lv-hactions"><button type="button" className="lv-hbtn lv-hprimary" onClick={() => void speech.unblock()}>{t("播放")}</button></span></>)
  }
  if (phaseNow === 'error') {
    return line(<>{meta}<span className="lv-hgrow lv-halert" role="alert"> · {explain({ message: state.error })}</span>
      <span className="lv-hactions">{view.text && <button type="button" className="lv-hbtn" onClick={again}>{t("重试")}</button>}</span></>)
  }
  const done = speech.hasPlayed(view.speechId) || mine
  return line(<>{meta}<span className="lv-hgrow"/>
    <span className="lv-hactions">{view.text && <button type="button" className="lv-hbtn" onClick={again}>{done ? t('重听') : t('朗读')}</button>}</span></>)
}
