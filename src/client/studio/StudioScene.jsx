import { translate as t } from '../i18n/locale.mjs'
import React, {useState} from 'react'
import { PipelineHeader } from './PipelineHeader.jsx'
import { CreateChapterForm, TextStep } from './TextStep.jsx'
import { ScriptList } from './ScriptList.jsx'
import { RoleBoard } from './RoleBoard.jsx'
import { ProductionBar } from '../stage/ProductionBar.jsx'
import { productionView } from '../workbench/productionView.mjs'
// The four step cards are the only navigation here; the production bar on top
// is the same one as on the stage, so starting and stopping work the same way.
export function StudioScene({ w, player, tab, change, roleData, staleScript, saveCreation, cancelCreation, openQueue }) {
  const [newRole,setNewRole]=useState(0)
  const chapter=w.chapter
  if (!chapter && w.booting) return <section className="lv-studio" role="status">{t("正在打开章节…")}</section>
  if (w.creating) return <section className="lv-studio">
    <h1>{w.appendBook ? t('添加章节') : t('新建书籍')}</h1>
    <CreateChapterForm w={w} save={saveCreation} cancel={cancelCreation}/>
  </section>
  const needsScript = w.options.mode==='multi' && !chapter.editorial?.cast
  const shownEngine = productionView(chapter, w.options, { keyMissing: w.options.engine === 'laivox' && w.keyInfo?.configured === false }).shown.engine
  return <section className="lv-studio"><header className="lv-heading"><h1>{chapter.title}</h1><div className="lv-inline"><button disabled={!chapter.previousId || w.busy} onClick={()=>w.navigate({chapter:chapter.previousId,keepScene:true})}>{t("上一章")}</button><button disabled={!chapter.nextId || w.busy} onClick={()=>w.navigate({chapter:chapter.nextId,keepScene:true})}>{t("下一章")}</button></div></header>
    <ProductionBar w={w}/>
    <PipelineHeader w={w} tab={tab} change={change} openQueue={openQueue} shownEngine={shownEngine}/>
    {tab==='text' && <TextStep w={w} staleScript={Boolean(staleScript)}/>}
    {tab==='script' && <>
      {needsScript && <div className="lv-studio-hint"><span>{t("还没有台词。可以先让 AI 编剧，检查后再合成。")}</span><button disabled={w.busy || productionView(chapter, w.options).active} title={productionView(chapter, w.options).active ? t('本章制作进行中') : undefined} onClick={()=>w.generate('cast')}>{t("只编剧")}</button></div>}
      <ScriptList key={chapter.id} chapter={chapter} roles={roleData.roles} draft={w.scriptDraft} setDraft={w.editScript} stale={Boolean(staleScript)} textDirty={w.draft.text!==undefined && w.draft.text!==chapter.text} notify={w.flashNotice} busy={w.busy} player={player} options={w.options} generate={w.generate} newRole={()=>{setNewRole(value=>value+1);change('roles')}}/></>}
    {tab==='roles' && <RoleBoard keyInfo={w.keyInfo} narratorSetting={w.settings.values.laivoxNarratorDefault} shownEngine={shownEngine} openSettings={() => w.setPanel('production')} requestNew={newRole} {...roleData} chapter={chapter} roleDraft={w.roleDraft} scriptDraft={w.scriptDraft} edit={w.editRole} saveVoice={w.saveRoleVoice} upgradeRule={w.upgradeVoiceRule} decide={w.decide} resolve={w.chooseRoleConflict} discard={w.discardRoles} options={w.options} player={player} notify={w.flashNotice} busy={w.busy}/>}
  </section>
}
