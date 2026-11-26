import { translate as t } from '../i18n/locale.mjs'
import React, { useSyncExternalStore } from 'react'
import { ImmersiveLines } from './ImmersiveLines.jsx'
import { ProseView } from './ProseView.jsx'
import { EmptyStage } from './EmptyStage.jsx'
import { MODE_NAMES, ProductionBar } from './ProductionBar.jsx'
import { ProductionLive } from './ProductionLive.jsx'
import { ProseChrome } from './ProseChrome.jsx'
import { pauseNoticeKey } from '../workbench/pauseNotice.mjs'
export function StageScene({ w, player, immersive, setImmersive, navigate, listenFrom, create, openImport, books, openBook, openLibrary }) {
  const chapter=w.chapter
  const s = useSyncExternalStore(player.subscribe, player.getSnapshot)
  if (w.booting && !chapter) return <section role="status">{t("正在打开章节…")}</section>
  // The kicker describes the audio being heard, not the next production.
  const heard = t(MODE_NAMES[chapter?.playbackJob?.mode])
  // Browsing another chapter while one plays: offer the way back.
  // With some audio already playable the production sheet folds into a strip.
  const hasAudio = Boolean(chapter?.media?.some(part => part.ready))
  const needsPauseAction = Boolean(chapter?.operation && pauseNoticeKey(chapter.operation))
  const elsewhere = s.chapter && chapter && s.chapter !== chapter.id && s.segments.length > 0 && ['playing', 'buffering', 'paused'].includes(s.phase)
  const prose = Boolean(chapter) && !immersive
  return <section className="lv-stage" data-prose={prose ? 'true' : undefined}>
    {elsewhere && <button type="button" className="lv-now-playing" onClick={() => navigate(s.chapter)}>
      <i aria-hidden="true"/><span>{t("正在播放：")}{s.title || t('另一章')}</span><strong>{t("回到正在播放")}</strong></button>}
    <ProseChrome enabled={prose} forceOpen={needsPauseAction}>
      {chapter && <header className="lv-stage-head"><div><small className="lv-kicker">{[chapter.isSnippet ? t('对话片段') : chapter.bookTitle, chapter.isSnippet ? null : t("第 {v1} 章", { v1: chapter.ordinal }), heard].filter(Boolean).join(' · ')}</small><h1>{chapter.title}</h1></div>
        {chapter.media?.length > 0 && <div className="lv-segmented"><button aria-pressed={immersive} onClick={()=>setImmersive(true)}>{t("沉浸")}</button><button aria-pressed={!immersive} onClick={()=>setImmersive(false)}>{t("全文")}</button></div>}</header>}
      <ProductionBar w={w}/>
    </ProseChrome>
    {chapter?.operation?.live && <ProductionLive key={chapter.operation.id} chapter={chapter} operation={chapter.operation} player={player}
      collapsible={hasAudio} listenFrom={listenFrom} packPage={w.keyInfo?.packPage}
      onOpenDay={() => void w.openUsageDayAction()} onOpenSettings={() => w.setPanel('production')} onOpenRoles={() => w.setPanel('roles')}/>}
    {!chapter ? <EmptyStage w={w} create={create} openImport={openImport} books={books} openBook={openBook} openLibrary={openLibrary}/> : !chapter.media?.length ? <>
      <EmptyStage w={w} create={create} openImport={openImport}/>
      <ProseView chapter={chapter} player={player} draft={w.draft} busy={w.busy} notify={w.flashNotice} navigate={navigate} onSeek={listenFrom}/>
    </> : immersive
      ? <ImmersiveLines chapter={chapter} player={player} listenFrom={listenFrom}/>
      : <ProseView chapter={chapter} player={player} draft={w.draft} busy={w.busy} notify={w.flashNotice} navigate={navigate} onSeek={listenFrom}/>}
  </section>
}
