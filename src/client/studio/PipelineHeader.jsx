import { translate as t } from '../i18n/locale.mjs'
import React, { useId } from 'react'
import { draftChanges } from './SaveBar.jsx'
import { chapterRoles, mergeRoles } from '../workbench/state.mjs'
import { scriptGroups } from './scriptAudio.mjs'
import { productionView } from '../workbench/productionView.mjs'
// Step cards double as the studio navigation. Each summary states facts about
// this chapter (what exists now), not what the next production would do.
export function PipelineHeader({ w, tab, change, openQueue, shownEngine }) {
  const id = useId()
  const chapter=w.chapter
  const state=w.scriptDraft ?? chapter?.editorial
  const annotations=Object.values(state?.annotations ?? {})
  const legacy=chapter?.editorial?.cast && Object.values(chapter.editorial.annotations ?? {}).every(row=>!row.instruct)
  const roles=chapter ? chapterRoles(mergeRoles(chapter,w.roleDraft).roles, scriptGroups(chapter, w.scriptDraft), w.roleDraft).inChapter : []
  const engine = shownEngine || w.options.engine
  const assigned=roles.filter(role=>role.voices?.[engine]).length
  const changes=draftChanges(w)
  const audio=productionView(chapter, w.options).audio
  const job=chapter?.operation
  const script=legacy?t('旧版台词（无逐句语气）'):annotations.length?t("{v1} 段 · {v2} 个角色 · 逐句语气", { v1: annotations.length, v2: new Set(annotations.map(row=>row.roleId)).size }):t('尚未编剧')
  const steps=[
    ['text',t('正文'),t("{v1} 字 · ", { v1: (w.draft.text ?? chapter?.text ?? '').length })+(state?.cleaned?t("已清洗 {v1} 行", { v1: state.removed.length }):t('未清洗')),Object.keys(w.draft).length?t('有未保存修改'):'',Boolean(Object.keys(w.draft).length)],
    ['script',t('台词'),script+(w.options.mode==='reading'&&annotations.length?t(' · 单人朗读时不用'):''),w.scriptDraft?t("{v1} 处未保存", { v1: changes.groups }):w.options.mode==='multi'&&!state?.cast?t('需编剧'):'',Boolean(w.scriptDraft)],
    ['roles',t('角色'),t("{v1} · 本章 {v2} 个角色 · {v3} 个已选音色", { v1: engine==='edge'?'Edge':'LaiVox', v2: roles.length, v3: assigned }),w.roleDraft?t('配音草稿未保存'):'',Boolean(w.roleDraft)],
    ['audio',t('合成'),audio.has?audio.label+(audio.note?' · '+audio.note:''):t('尚未制作'),job?.state==='paused'?t('已暂停'):['queued','running'].includes(job?.state)?t('进行中'):audio.stale?t('需更新'):'',false]
  ]
  return <nav className="lv-pipeline" aria-label={t("制作步骤")}>{steps.map(([step,label,summary,badge,dirty],i)=><button key={step} aria-label={label} aria-describedby={id+step}
    aria-current={step===tab?'step':undefined} onClick={()=>step==='audio'?openQueue():change(step)}>
    <span className="lv-pipeline-number" aria-hidden="true">{String(i+1).padStart(2,'0')}</span><strong aria-hidden="true">{label}</strong><small id={id+step}>{summary}</small>{badge && <span className="lv-pipeline-badge" data-dirty={dirty}>{badge}</span>}</button>)}</nav>
}
