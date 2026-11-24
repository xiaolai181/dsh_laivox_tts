import { deferText, translate as t } from '../i18n/locale.mjs'
import React, { useMemo } from 'react'
import { groupSpeech, segmentChapter, segmentVersion } from '../../domain/segment.mjs'
import { productionView } from '../workbench/productionView.mjs'

// Only the title and the text are edits; the draft also carries its base and book.
const textEdits = draft => ['text', 'title'].filter(key => draft?.[key] !== undefined).length
export function draftChanges(w) {
  if (!w.chapter) return {groups:0,count:0}
  const state=w.scriptDraft
  const groups=state ? groupSpeech(segmentChapter(w.chapter.text,state.removed,segmentVersion(w.chapter.editorial)).map(part=>({...part,...state.annotations[part.id]}))) : []
  const changed=groups.filter(group=>group.sourceIds.some(id=>{
    const row=state.annotations[id] ?? {}, old=w.chapter.editorial?.annotations?.[id] ?? {}
    return ['roleId','emotion','intensity','instruct'].some(key=>row[key]!==old[key])
  })).length
  const oldRemoved=new Set(w.chapter.editorial?.removed ?? [])
  const newRemoved=new Set(state?.removed ?? oldRemoved)
  const removedChanges=[...new Set([...oldRemoved,...newRemoved])].filter(id=>oldRemoved.has(id)!==newRemoved.has(id)).length
  return {groups:changed,count:textEdits(w.draft)+changed+removedChanges+(w.roleDraft?.patches.size ?? 0)}
}
export function SaveBar({ w, save, blocked }) {
  const changes=useMemo(()=>draftChanges(w),[w.chapter,w.draft,w.scriptDraft,w.roleDraft])
  if (!w.dirty || !w.chapter) return null
  const types=[textEdits(w.draft)?t('正文'):'',w.scriptDraft?t('台词'):'',w.roleDraft?t('配音'):''].filter(Boolean)
  const view = productionView(w.chapter, w.options)
  const rolesOnly = Boolean(w.roleDraft) && !textEdits(w.draft) && !w.scriptDraft
  const consequence = [view.locks.save, rolesOnly ? t('音色改动影响全书，其他章节需要各自更新') : ''].filter(Boolean).join(' · ')
  return <div className="lv-save-bar" role="region" aria-label={t("未保存修改")}><span>{t('{types}有 {count} 处修改未保存', { types: types.join(t('、')), count: changes.count })}{changes.groups>0 && !w.roleDraft ? t(" · 约 {v1} 段台词受影响", { v1: changes.groups }) : ''}{consequence && <small>{consequence}</small>}</span>
    <button disabled={w.busy} onClick={async()=>{if(await w.decide({title:deferText(() => t('放弃未保存的修改？')),text:deferText(() => t('正文、台词和配音的修改都会丢失，无法恢复。')),choices:[['discard',deferText(() => t('放弃修改'))],[null,deferText(() => t('继续编辑'))]],destructive:true})!=='discard')return;w.editDraft({});w.editScript(null);w.discardRoles()}}>{t("放弃")}</button>
    <button disabled={w.busy} onClick={save}>{t("保存修改")}</button>
    <button className="lv-save-action" disabled={w.busy} onClick={() => void w.generate('generate', false, '', { clean: false, preconfirmed: true })}>{rolesOnly ? t('保存并更新本章音频') : view.audio.has ? t('保存并更新音频') : t('保存并开始制作')}</button>{blocked}</div>
}
