import { roleDisplayName } from '../i18n/display.mjs'
import { displayText, translate as t } from '../i18n/locale.mjs'
import React, { useRef, useState } from 'react'
import { useVoiceDirectory } from '../editorial/VoicePicker.jsx'
import { modelIdentity } from '../editorial/ModelOptions.jsx'
import { groupSpeech } from '../../domain/segment.mjs'
import { roleColor } from '../stage/roleColor.mjs'
import { effectiveVoices, narratorDefaultFor } from '../studio/voiceLabels.mjs'
import { planSynthesisDetail } from '../workbench/enginePitch.mjs'

export function PlanSheet({ dialog, answer, narratorSetting, account }) {
  const plan = dialog.plan
  const options = plan.options
  const directory = useVoiceDirectory(options.engine)
  const chapter = plan.chapter
  const narratorDefault = narratorDefaultFor(options.engine, account, directory.voices, narratorSetting)
  const segments = groupSpeech((chapter?.script ?? []).map(part => ({ ...part, ...chapter?.editorial?.annotations?.[part.id] }))).length
  const reusable = !plan.batch && chapter?.media?.some(part => part.ready)
  const assigned = !plan.batch && chapter ? effectiveVoices(chapter, chapter.roles, directory.voices, options.engine, chapter.voiceRule, narratorDefault) : null
  const voiceName = id => directory.voices?.find(voice => voice.id === id)?.name ?? id
  const chip = role => {
    const chosen = role.voices?.[options.engine]
    if (chosen) return voiceName(chosen)
    const automatic = assigned?.get(role.id)
    if (role.id === 'narrator' && narratorDefault && automatic === narratorDefault.voiceId) return voiceName(automatic)
    return automatic ? t('自动 · {name}', { name: voiceName(automatic) }) : t('自动')
  }
  const openedNarrator = useRef(undefined)
  if (openedNarrator.current === undefined && assigned) openedNarrator.current = assigned.get('narrator') ?? null
  const narratorNow = assigned?.get('narrator') ?? null
  const narratorChanged = openedNarrator.current !== undefined && openedNarrator.current !== narratorNow
  const [acknowledged, setAcknowledged] = useState(false)
  function choose(value) {
    if (value === 'start' && narratorChanged && !acknowledged) {
      setAcknowledged(true)
      return
    }
    answer(value)
  }
  const scope = plan.batch ? t("{v1} 章 · {v2} 字", { v1: plan.chapters.length, v2: Number(plan.characters || 0).toLocaleString() }) : null
  const steps = []
  if (plan.clean > 0) steps.push({ key: 'clean', title: t('清洗正文'), ai: true,
    text: (plan.batch ? t("{v1} 章", { v1: plan.clean }) : t('本章')) + t('：删除广告、导航、水印等非正文行，不改写原文。') })
  if (plan.cast > 0) steps.push({ key: 'cast', title: t('编剧'), ai: true,
    text: (plan.batch ? t("{v1} 章", { v1: plan.cast }) : t('本章')) + t('：分出旁白与角色，为每句定情绪和语气。')
      + (plan.clean > 0 && options.mode === 'multi' ? t('清洗后会重新编剧，覆盖手工修改的台词。') : '') })
  if (plan.purpose === 'generate') steps.push({ key: 'synth', title: t('合成'), ai: false,
    text: (plan.batch ? scope : t("{v1} 段", { v1: segments })) + ' · ' + planSynthesisDetail(options.engine, options.mode)
      + (reusable ? t('。已有音频的段会直接复用') : '') })
  return <div className="lv-plan-sheet" aria-busy={Boolean(dialog.pending)}>
    {dialog.text && <p className="lv-plan-note">{displayText(dialog.text)}</p>}
    {narratorChanged && <p className="lv-plan-note" role="status">{t('默认旁白已改为 {name}。请再确认一次后再开始。', { name: voiceName(narratorNow) })}</p>}
    <ol className="lv-plan-steps">{steps.map((step, index) => <li key={step.key}>
      <span className="lv-plan-index">{index + 1}</span>
      <div><h3>{step.title}{step.ai && <small className="lv-ai-label">AI</small>}</h3><p>{step.text}</p>
        {step.key === 'synth' && !plan.batch && chapter?.roles?.length > 0 && <div className="lv-inline lv-plan-voices">{chapter.roles.map(role =>
          <span key={role.id} className="lv-voice-chip"><i className="lv-role-dot" style={{ '--lv-role-color': roleColor(role.id) }}/>{roleDisplayName(role)} · {chip(role)}</span>)}</div>}
      </div>
    </li>)}</ol>
    {plan.needsModel && <div className="lv-plan-cost">
      {plan.aiPlan?.selection && <p>{modelIdentity(plan.aiPlan.selection)}</p>}
      <p>{t('预计 {requests} 次常规请求，使用 DSH 模型额度。', { requests: plan.estimate.requests })}
        {plan.estimate.cast > 0 ? t('模型输出需要修复时，请求数可能增加。') : ''}
        {plan.estimate.provisional ? t('清洗完成后，编剧次数可能调整。') : ''}</p>
    </div>}
    <footer className="lv-inline lv-plan-actions">{dialog.choices.map(([value, label], index) =>
      <button key={index} type="button" disabled={dialog.pending} className={value === 'start' ? 'lv-primary' : ''} onClick={() => choose(value)}>{displayText(label)}</button>)}</footer>
  </div>
}
