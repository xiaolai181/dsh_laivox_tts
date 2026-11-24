import { translate as t } from '../i18n/locale.mjs'
import React, { useState, useSyncExternalStore } from 'react'
import { explain } from '../api.mjs'
import { Icon } from '../components/Icon.jsx'
import { messageText } from './messageText.mjs'

const NOTICE_KEY = 'laivox-speech-notice-seen'
let noticeShownThisRun = false

// Shown once: speech sends the text to Microsoft's online service. Remembered in
// localStorage when it works, otherwise once per run.
function noticeSeen() {
  if (noticeShownThisRun) return true
  try { return localStorage.getItem(NOTICE_KEY) === '1' } catch { return false }
}
function markNoticeSeen() {
  noticeShownThisRun = true
  try { localStorage.setItem(NOTICE_KEY, '1') } catch { /* private window */ }
}

// The "read aloud" button next to the host's copy and feedback buttons.
export function SpeakAction({ messageId, useChat, sessionId, speech }) {
  const text = useChat(snapshot => messageText(snapshot, messageId))
  const state = useSyncExternalStore(speech.subscribe, speech.getSnapshot)
  const [notice, setNotice] = useState(false)
  if (!text || !text.trim()) return null
  const source = 'message:' + messageId
  const mine = state.source === source
  const phase = mine ? state.phase : 'idle'
  const busy = phase === 'loading' || phase === 'playing'
  function click() {
    if (phase === 'blocked') { void speech.unblock(); return }
    if (busy) { speech.stop(); return }
    if (!noticeSeen()) { markNoticeSeen(); setNotice(true) }
    void speech.speak({ text, source, session: sessionId ?? null })
  }
  const label = phase === 'loading' ? t('正在准备朗读，点击取消') : phase === 'playing' ? t('停止朗读') : phase === 'blocked' ? t('播放朗读') : t('用 Edge 朗读')
  const icon = phase === 'loading' ? 'LoaderCircle' : phase === 'playing' ? 'Square' : phase === 'blocked' ? 'Play' : 'Volume2'
  return <span className="lv-host lv-hspeak">
    <button type="button" className={'lv-hbtn lv-hicon' + (phase === 'loading' ? ' lv-hspinning' : '')} aria-label={label} title={label}
      onPointerEnter={() => { if (phase === 'idle') speech.warm(text) }} onClick={click}><Icon name={icon} size={15}/></button>
    {mine && phase === 'error' && <span className="lv-halert" role="alert">{explain({ message: state.error })}
      <button type="button" className="lv-hbtn" onClick={() => void speech.speak({ text, source, session: sessionId ?? null })}>{t("重试")}</button></span>}
    {mine && phase !== 'error' && state.truncated && <span className="lv-hmeta">{t("只读前 20,000 字")}</span>}
    {notice && <span className="lv-hmeta" role="status">{t("朗读会把这段文字发送到微软 Edge 在线语音服务。")}<button type="button" className="lv-hbtn" onClick={() => setNotice(false)}>{t("知道了")}</button></span>}
  </span>
}
