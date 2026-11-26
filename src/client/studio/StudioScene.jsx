import { translate as t } from '../i18n/locale.mjs'
import React, {useRef, useState} from 'react'
import { PipelineHeader } from './PipelineHeader.jsx'
import { CreateChapterForm, TextStep } from './TextStep.jsx'
import { ScriptList } from './ScriptList.jsx'
import { RoleBoard } from './RoleBoard.jsx'
import { ProductionBar } from '../stage/ProductionBar.jsx'
import { productionView } from '../workbench/productionView.mjs'
import { draftChanges } from './SaveBar.jsx'
import { segmentVersion } from '../../domain/segment.mjs'
// The step cards navigate the chapter. Starting and stopping work stays on the
// production bar, including the link into this chapter's task list.
export function StudioScene({ w, player, tab, change, roleData, staleScript, saveCreation, cancelCreation, openQueue }) {
  const [newRole,setNewRole]=useState(0)
  const [focus,setFocus]=useState(null)
  const adoptRef=useRef(null)
  const chapter=w.chapter
  if (!chapter && w.booting) return <section className="lv-studio" role="status">{t("正在打开章节…")}</section>
  if (w.creating) return <section className="lv-studio">
    <h1>{w.appendBook ? t('添加章节') : t('新建书籍')}</h1>
    <CreateChapterForm w={w} save={saveCreation} cancel={cancelCreation}/>
  </section>
  const needsScript = w.options.mode==='multi' && !chapter.editorial?.cast
  const shownEngine = productionView(chapter, w.options, { keyMissing: w.options.engine === 'laivox' && w.keyInfo?.configured === false }).shown.engine
  function created(id) {
    const part = adoptRef.current
    adoptRef.current = null
    if (!part) return
    const state = w.scriptDraft ?? chapter.editorial ?? { removed: [], annotations: {} }
    const annotations = { ...state.annotations }
    for (const sourceId of part.sourceIds) {
      const previous = annotations[sourceId] ?? { roleId: 'narrator', emotion: 'neutral', intensity: 0 }
      annotations[sourceId] = { ...previous, roleId: id, id: sourceId }
    }
    w.editScript({ ...state, version: segmentVersion(chapter.editorial), annotations })
    setFocus({ token: Date.now(), roleId: id, partId: part.id })
    change('script')
  }
  return <section className="lv-studio"><header className="lv-heading"><h1>{chapter.title}</h1><div className="lv-inline"><button disabled={!chapter.previousId || w.busy} onClick={()=>w.navigate({chapter:chapter.previousId,keepScene:true})}>{t("上一章")}</button><button disabled={!chapter.nextId || w.busy} onClick={()=>w.navigate({chapter:chapter.nextId,keepScene:true})}>{t("下一章")}</button></div></header>
    <ProductionBar w={w} openQueue={() => openQueue()}/>
    <PipelineHeader w={w} tab={tab} change={change} shownEngine={shownEngine}/>
    {tab==='text' && <TextStep w={w} staleScript={Boolean(staleScript)}/>}
    {tab==='script' && <>
      {needsScript && <div className="lv-studio-hint"><span>{t("还没有台词。可以先让 AI 编剧，检查后再合成。")}</span><button disabled={w.busy || productionView(chapter, w.options).active} title={productionView(chapter, w.options).active ? t('本章制作进行中') : undefined} onClick={()=>w.generate('cast')}>{t("只编剧")}</button></div>}
      <ScriptList key={chapter.id} chapter={chapter} roles={roleData.roles} draft={w.scriptDraft} setDraft={w.editScript} stale={Boolean(staleScript)} textDirty={w.draft.text!==undefined && w.draft.text!==chapter.text} notify={w.flashNotice} busy={w.busy} player={player} options={w.options} generate={w.generate} jobAction={w.jobAction} actions={w.actions} openSettings={() => w.setPanel('production')} openRoles={() => change('roles')} openDay={() => void w.openUsageDayAction()} packPage={w.keyInfo?.packPage} focus={focus} onFocusApplied={() => setFocus(null)} pendingCount={draftChanges(w).count} confirmSave={w.decide} saveVoice={w.saveRoleVoice} narratorSetting={w.settings.values.laivoxNarratorDefault} keyInfo={w.keyInfo} newRole={part=>{adoptRef.current=part;setNewRole(value=>value+1);change('roles')}}/></>}
    {tab==='roles' && <RoleBoard keyInfo={w.keyInfo} narratorSetting={w.settings.values.laivoxNarratorDefault} shownEngine={shownEngine} openSettings={() => w.setPanel('production')} requestNew={newRole} openScript={roleId => { setFocus({ token: Date.now(), roleId, partId: null }); change('script') }} onCreated={created} onBlankCreate={() => { adoptRef.current = null }} saveProfile={w.saveRoleProfile} {...roleData} chapter={chapter} roleDraft={w.roleDraft} scriptDraft={w.scriptDraft} edit={w.editRole} saveVoice={w.saveRoleVoice} upgradeRule={w.upgradeVoiceRule} decide={w.decide} resolve={w.chooseRoleConflict} discard={w.discardRoles} options={w.options} player={player} notify={w.flashNotice} busy={w.busy}/>}
  </section>
}
