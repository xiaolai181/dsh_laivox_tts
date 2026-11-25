import { displayText, translate as t } from '../i18n/locale.mjs'
import React, { useSyncExternalStore } from 'react'
import { explain } from '../api.mjs'
import { Icon } from '../components/Icon.jsx'
import { shouldShowNovelCapsule } from './capsuleState.mjs'

const quietSpeech = { subscribe: () => () => {}, getSnapshot: () => null }

// Floats over the DSH frame while the workbench is closed, in the host's look.
// While a message or the AI is being read aloud it shows that reading (the tool
// card may be folded away); afterwards it offers to continue the novel.
export function MiniCapsule({ player, open, notice, dismissed = false, dismiss, mode = 'auto', speech }) {
  const s=useSyncExternalStore(player.subscribe,player.getSnapshot)
  const voice=useSyncExternalStore((speech ?? quietSpeech).subscribe,(speech ?? quietSpeech).getSnapshot)
  if(voice && ['loading','playing','blocked','error'].includes(voice.phase)){
    const label=voice.phase==='loading'?t('正在准备朗读'):voice.phase==='blocked'?t('点一下开始朗读'):voice.phase==='error'?explain({message:voice.error}):t("正在朗读 {v1} / {v2}", { v1: voice.n+1, v2: voice.parts })
    return <section className="lv-mini-capsule" aria-label={t("朗读")}>
      {voice.phase==='blocked'
        ? <button className="lv-hplay" aria-label={t("播放朗读")} onClick={()=>void speech.unblock()}><Icon name="Play" size={14}/></button>
        : <button className="lv-hplay" aria-label={t("停止朗读")} disabled={voice.phase==='error'} onClick={()=>speech.stop()}><Icon name="Square" size={13}/></button>}
      <span role={voice.phase==='error'?'alert':'status'}>{label}</span>
      <button className="lv-hbtn" onClick={()=>speech.stop()}>{voice.phase==='error'?t('关闭'):t('停止')}</button>
    </section>
  }
  const part=s.segments[s.n]
  const playing=['playing','buffering'].includes(s.phase)
  // After a reading paused the novel: continuing is the user's choice.
  const resume=!playing && voice?.resume?.chapter===s.chapter ? voice.resume : null
  if(!shouldShowNovelCapsule({ phase: s.phase, job: s.job, segments: s.segments, resume, notice, dismissed, mode }))return null
  return <section className="lv-mini-capsule" aria-label={t("小说播放器")}>
    <button className="lv-hplay" disabled={(s.settled && !s.segments.some(row=>row.ready)) || s.phase==='blocked'} aria-label={playing?t('暂停播放'):t('播放')} onClick={()=>{if(resume)speech.resumeNovel();else player.toggle()}}><Icon name={playing?'Pause':'Play'} size={14}/></button>
    {notice ? <span role="status">{displayText(notice)}</span> : resume ? <span role="status">{t("朗读已结束 · 继续听")}</span> : <span>{[...(part?.text??s.title)].slice(0,18).join('')}</span>}
    {resume ? <button className="lv-hbtn" onClick={()=>speech.resumeNovel()}>{t("继续听")}</button> : <button className="lv-hbtn" onClick={()=>open(s.chapter,s.job)}>{t("回到小说")}</button>}
    {dismiss && <button type="button" className="lv-hbtn lv-hclose lv-hicon"
      aria-label={playing ? t('暂停并关闭播放器') : t('关闭播放器')}
      title={playing ? t('暂停并关闭') : t('关闭')}
      onClick={() => { if (playing) player.pause(); if (resume) speech?.dismissResume?.(); dismiss() }}>
      <Icon name="X" size={14}/>
    </button>}
  </section>
}
