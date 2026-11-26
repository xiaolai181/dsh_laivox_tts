import { roleDisplayName } from '../i18n/display.mjs'
import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useState } from 'react'
import { normalizeInstruct, INSTRUCT_PRESETS, presetIntensity, legacyInstruct } from '../../domain/voice-direction.mjs'
import { emotions } from '../stage/ImmersiveLines.jsx'
import { Tooltip } from '../components/Popover.jsx'

const MAX_ROLE_CHIPS = 6

// Three choices per line, top to bottom: who speaks, the emotion, and how it
// is said. Picking an emotion applies its first preset; each preset carries
// its own intensity (shown as dots), so there is no separate intensity field.
export function ScriptRowEditor({ part, roles, others = [], disabled, label, change, newRole, engine = 'edge' }) {
  const emotion = part.emotion ?? 'neutral'
  const [direction, setDirection] = useState(part.instruct ?? '')
  useEffect(() => setDirection(part.instruct ?? ''), [part.instruct])
  const custom = part.instruct && !INSTRUCT_PRESETS[emotion]?.includes(part.instruct)
  function commitDirection() {
    const value = normalizeInstruct(direction)
    setDirection(value)
    if (value !== (part.instruct ?? '')) change({ instruct: value || undefined })
  }
  return <div className="lv-row-editor">
    {roles.length <= MAX_ROLE_CHIPS
      ? <div className="lv-inline lv-row-roles" role="group" aria-label={t("{v1}角色", { v1: label })}>{roles.map(role=><button disabled={disabled} key={role.id} aria-pressed={part.roleId===role.id} onClick={()=>change({roleId:role.id})}>{roleDisplayName(role)}</button>)}<button disabled={disabled} className="lv-subtle" onClick={() => newRole(part)}>{t("＋新角色")}</button></div>
      : <div className="lv-inline lv-row-roles"><label>{t("说话人")}<select aria-label={t("{v1}角色", { v1: label })} disabled={disabled} value={roles.some(role => role.id === part.roleId) ? part.roleId : ''} onChange={event=>change({roleId:event.target.value})}>
          {roles.map(role=><option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}</select></label><button disabled={disabled} className="lv-subtle" onClick={() => newRole(part)}>{t("＋新角色")}</button></div>}
    {others.length > 0 && <label>{t("其他角色")}<select aria-label={t("{v1}其他角色", { v1: label })} disabled={disabled} value={others.some(role => role.id === part.roleId) ? part.roleId : ''} onChange={event => event.target.value && change({ roleId: event.target.value })}>
      <option value="">{t("其他角色…")}</option>{others.map(role => <option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}</select></label>}
    <div className="lv-inline lv-row-emotions" role="group" aria-label={t("{v1}情绪", { v1: label })}>{Object.entries(emotions).map(([value,name])=><button disabled={disabled} key={value} aria-pressed={emotion===value} onClick={()=>change({emotion:value,intensity:presetIntensity(value,0),instruct:INSTRUCT_PRESETS[value][0]})}>{t(name)}</button>)}</div>
    <div className="lv-row-directions">
      <div className="lv-inline" role="group" aria-label={t("预设语气")}>{INSTRUCT_PRESETS[emotion].map((text,index)=>{
        const strength = presetIntensity(emotion,index)
        return <button disabled={disabled} key={text} className="lv-direction-chip" aria-pressed={part.instruct===text} onClick={()=>change({emotion,instruct:text,intensity:strength})}>{t(text)}{strength>0 && <i className="lv-strength" data-level={strength} aria-hidden="true"/>}</button>
      })}</div>
      <div className="lv-row-custom">
        <label>{custom ? t('自定义语气') : t('或写一句语气')}<input disabled={disabled} value={direction} placeholder={t('例如：') + t(legacyInstruct(emotion,part.intensity) || '轻声说，带点犹豫')}
          onChange={e=>setDirection(e.target.value)} onBlur={() => commitDirection()} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitDirection() } }}/></label>
        <button type="button" disabled={disabled} onClick={() => commitDirection()}>{t('使用')}</button>
        <Tooltip text={t("Edge 仅按情绪和强度调整语速与音调；手写语气在使用 LaiVox（推荐 · 增值付费）时直接生效。")}><span className="lv-help" tabIndex={0} aria-label={t("语气说明")}>?</span></Tooltip>
      </div>
      {engine !== 'laivox' && <small className="lv-row-engine-hint">{t("手写语气在使用 LaiVox 引擎（推荐 · 增值付费）时直接生效；Edge 仅按情绪调整语速与音调。")}</small>}
      {[...direction].length>60 && <small role="status">{t("语气最多 60 字")}</small>}
    </div>
  </div>
}
