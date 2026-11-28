import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { downloadKey, downloadLabel, downloadsSnapshot, startChapterDownload, subscribeDownloads } from '../workbench/downloads.mjs'
import { Icon } from '../components/Icon.jsx'
import { Popover } from '../components/Popover.jsx'
import { FilmStrip } from './FilmStrip.jsx'
import { GapNotice } from '../stage/GapNotice.jsx'
import { PLAYBACK_RATES } from './shortcuts.mjs'
export const clock = seconds => Math.floor(Math.max(0,seconds)/60)+':'+String(Math.floor(Math.max(0,seconds)%60)).padStart(2,'0')
function newerLabel(newer) {
  if (newer.scope === 'range') {
    if (newer.state === 'paused') return newer.retake ? t('重新合成已暂停') : t('局部合成已暂停')
    return newer.retake ? t('正在重新合成选中段') : t('正在合成选中段')
  }
  if (newer.state === 'paused') return t('新版已暂停 {done}/{total}', { done: newer.done, total: newer.total })
  return t('新版制作中 {done}/{total} · 听新版进度', { done: newer.done, total: newer.total })
}
export function TransportDock({ player, chapter, view, refresh, listenOlder, notify, jumpBookmark, clearAudio, listenFrom, clearListen, openNotes, askAi }) {
  const s=useSyncExternalStore(player.subscribe,player.getSnapshot)
  const [now,setNow]=useState(Date.now())
  useEffect(()=>{if(!s.sleep?.until)return;setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer)},[s.sleep?.until])
  // Preparing a chapter file takes a while: its progress and a cancel button stay
  // next to the caption while the menu is closed.
  const downloads=useSyncExternalStore(subscribeDownloads,downloadsSnapshot)
  const preparing=format=>downloads.get(downloadKey(s.job,format))?.phase==='preparing'
  const pending=[...downloads.values()].find(entry=>entry?.phase==='preparing')
  async function download(format) {
    const failure=await startChapterDownload({job:s.job,format,title:s.title,notify})
    if(failure)notify(failure)
  }
  const playing=['playing','buffering'].includes(s.phase)
  const ready=s.segments.filter(part=>part.ready).length
  const all=ready>0 && ready===s.segments.length && !chapter?.playbackJob?.open
  const blocked=s.phase==='blocked' || (Boolean(s.segments[s.n]) && !s.segments[s.n].ready && !chapter?.operation)
  const elapsed=s.segments.slice(0,s.n).reduce((sum,part)=>sum+(part.seconds||0),0)+s.offset
  const duration=s.segments.reduce((sum,part)=>sum+(part.seconds||0),0)
  const hasParts = Boolean(s.job && s.segments.length > 0)
  const caption=!hasParts ? t('尚未制作音频') : s.settled && !ready?t('音频已不可用'):s.phase==='buffering'?t('正在等下一段音频'):s.phase==='error'?t('播放失败，可重试'):s.generationStopped && !playing && !all?t('已生成的音频仍可播放'):clock(elapsed)+(all?' / '+clock(duration):t(" · 已生成 {v1} / {v2} 段", { v1: ready, v2: s.segments.length }))
  function step(n) {
    const part=s.segments[n]
    if(!part)return
    if(!part.ready){void listenFrom?.(part.start);return}
    clearListen?.()
    player.seek(n)
  }
  const sleepLabel=s.sleep?.mode==='chapter'?t('本章结束'):s.sleep?.until?clock((s.sleep.until-now)/1000):t('定时')
  const timer=<Popover label={t("定时关闭")} trigger={<><Icon name="Moon"/>{sleepLabel}</>} className={s.sleep?'lv-timer-active':''}>{close=><div className="lv-menu">{[[15,t('15 分钟')],[30,t('30 分钟')],[60,t('60 分钟')],['chapter',t('本章结束')],[null,t('关闭')]].map(([value,label])=><button key={label} onClick={()=>{player.sleep(value);close()}}>{label}</button>)}</div>}</Popover>
  return <footer className="lv-transport" aria-label={t("小说播放器")}>
    <FilmStrip player={player} chapter={chapter} listenFrom={listenFrom}/>
    <div className="lv-transport-row"><div className="lv-transport-buttons" role="group" aria-label={t("播放控制")}><button aria-label={t("上一段")} disabled={!s.job||s.n===0} onClick={()=>step(s.n-1)}><Icon name="ChevronLeft"/></button>
      <button className="lv-play" disabled={!s.job || (s.settled && !ready) || blocked} aria-label={playing?t('暂停播放'):t('播放')} onClick={()=>{clearListen?.();player.toggle()}}><Icon name={playing?'Pause':'Play'} size={20}/></button>
      <button aria-label={t("下一段")} disabled={!s.job||s.n+1>=s.segments.length} onClick={()=>step(s.n+1)}><Icon name="ChevronRight"/></button></div>
      <div className="lv-transport-caption"><strong>{s.title || chapter?.title || t('选择一章开始收听')}</strong><small>{s.stale ? t('旧版 · {name}', { name: view?.audio?.engine === 'laivox' ? 'LaiVox' : view?.audio?.engine === 'edge' ? 'Edge' : '' }) + ' ' : ''}{caption}{hasParts ? " " + t('第 {n} / {total} 段', { n: Math.min(s.n + 1, s.segments.length), total: s.segments.length }) : ''}</small>{s.swapped && <small role="status">{typeof s.swapped === 'string' ? s.swapped : t('已换成新版音频（{name}）', { name: s.swapped.engine === 'laivox' ? 'LaiVox' : 'Edge' })}</small>}{view?.newer && <small><button type="button" className="lv-link" onClick={() => void refresh?.(undefined, view.newer.id, true)}>{newerLabel(view.newer)}</button></small>}{view?.older && <small><button type="button" className="lv-link" onClick={() => void (listenOlder ? listenOlder(view.older.id) : refresh?.(undefined, view.older.id, true))}>{t('回到完整旧版')}</button></small>}{s.segments[s.n] && !s.segments[s.n].ready && <GapNotice chapter={chapter} part={s.segments[s.n]} listenFrom={listenFrom}/>}
        {pending && <small className="lv-download-status" role="status">{pending.title ? pending.title + ' · ' : ''}{downloadLabel(pending)}{" · "}<button type="button" className="lv-link" onClick={pending.cancel}>{t("取消")}</button></small>}</div>
      <div className="lv-transport-options"><Popover label={t("倍速")} trigger={s.rate+'×'}>{close=><div className="lv-menu">{PLAYBACK_RATES.map(rate=><button key={rate} aria-pressed={rate===s.rate} onClick={()=>{player.speed(rate);close()}}>{rate}×</button>)}</div>}</Popover>
        <div className="lv-wide-control">{timer}</div>
        <div className="lv-wide-control"><Popover label={t("音量")} trigger={<Icon name="Volume2"/>}><input aria-label={t("音量")} type="range" min="0" max="1" step=".05" value={s.volume} onChange={e=>player.volume(Number(e.target.value))}/></Popover></div>
        <Popover label={t("更多")} trigger={<Icon name="Ellipsis"/>}><div className="lv-menu"><div className="lv-narrow-control">{timer}<label>{t("音量")}<input aria-label={t("音量")} type="range" min="0" max="1" step=".05" value={s.volume} onChange={e=>player.volume(Number(e.target.value))}/></label></div>
          <button disabled={!s.segments[s.n]?.ready} onClick={()=>player.bookmark()}>{t("保存书签")}</button>{jumpBookmark && <button onClick={jumpBookmark}>{t("跳到书签")}</button>}
          {chapter && !chapter.isSnippet && openNotes && <button onClick={() => {
            const cur = s.segments[s.n]
            const roleName = cur?.roleId && cur.roleId !== 'narrator' ? (chapter.roles?.find(r => r.id === cur.roleId)?.name ?? '') : t('旁白')
            const quote = cur?.text ?? (cur ? chapter.text.slice(cur.start ?? 0, cur.end ?? 0) : chapter.text.slice(0, 120))
            openNotes({
              book: chapter.book,
              bookTitle: chapter.bookTitle,
              draft: quote.trim() ? {
                chapter: chapter.id,
                chapterTitle: chapter.title,
                ordinal: chapter.ordinal,
                partIndex: s.n ?? 0,
                charOffset: cur?.start ?? 0,
                quote: quote.trim().slice(0, 2000),
                speaker: roleName,
              } : null,
            })
          }}>{t("收藏此句 / 记批注")}</button>}
          {chapter && !chapter.isSnippet && openNotes && <button onClick={() => openNotes({ book: chapter.book, bookTitle: chapter.bookTitle })}>{t("查看本书批注")}</button>}
          {chapter && askAi && <button onClick={() => {
            const cur = s.segments[s.n]
            const roleName = cur?.roleId && cur.roleId !== 'narrator' ? (chapter.roles?.find(r => r.id === cur.roleId)?.name ?? '') : t('旁白')
            const quote = cur?.text ?? (cur ? chapter.text.slice(cur.start ?? 0, cur.end ?? 0) : chapter.text.slice(0, 120))
            if (!quote.trim()) return
            askAi({ bookTitle: chapter.bookTitle, ordinal: chapter.ordinal, chapterTitle: chapter.title, speaker: roleName, quote: quote.trim().slice(0, 400) })
          }}>{t("问 AI 这一段")}</button>}
          {all && ['wav','mp3'].map(format=><button key={format} disabled={preparing(format)} onClick={()=>void download(format)}>{preparing(format)?downloadLabel(downloads.get(downloadKey(s.job,format))):format==='wav'?t("下载 WAV"):t("下载 MP3")}</button>)}
          {all && ['srt','lrc'].map(format=><button key={format} disabled={preparing(format)} onClick={()=>void download(format)}>{format==='srt'?t("导出 SRT 字幕"):t("导出 LRC 字幕")}</button>)}
          {clearAudio && <button onClick={clearAudio}>{t("清理本章音频")}</button>}</div></Popover>
      </div>
    </div>
    {s.saveMessage && <small role={s.saveFailed?'alert':'status'}>{t(s.saveMessage)}{s.saveFailed&&!s.saveMessage.includes('其他窗口')&&<button onClick={()=>player.retrySave()}>{t("重试")}</button>}</small>}
  </footer>
}
