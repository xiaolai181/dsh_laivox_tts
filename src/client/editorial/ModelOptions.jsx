import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useState } from 'react'
import { get } from '../api.mjs'

const localized = { off: '关闭思考', minimal: '极低', low: '低', medium: '中', high: '高', max: '最高' }
const effortLabel = effort => localized[effort.id] ? t(localized[effort.id]) : effort.name ?? effort.id

export function modelIdentity(selection, fallback = t('跟随模型默认')) {
  if (!selection) return ''
  const model = selection.name && selection.model && selection.name !== selection.model
    ? selection.name + ' (' + selection.model + ')' : selection.name ?? selection.model
  const effort = selection.reasoningEffort
  return [model, selection.provider, effort ? effortLabel({ id: effort }) : fallback].filter(Boolean).join(' · ')
}

export function ModelOptions({ models, selection, onChange, disabled }) {
  const index = models.findIndex(item => item.provider === selection?.provider && item.model === selection?.model)
  const selected = index >= 0 ? models[index] : null
  const provider = selected?.provider
  const model = selected?.model
  const [result, setResult] = useState(null)
  useEffect(() => {
    if (!provider || !model) return
    const controller = new AbortController()
    get('models/reasoning', { provider, model }, controller.signal).then(info => {
      if (!controller.signal.aborted) setResult({ provider, model, info })
    }).catch(() => {
      if (!controller.signal.aborted) setResult({ provider, model, failed: true })
    })
    return () => controller.abort()
  }, [provider, model])

  const current = result?.provider === provider && result?.model === model ? result : null
  const efforts = current?.info?.efforts ?? []
  const defaultEffort = efforts.find(effort => effort.id === current?.info?.defaultEffort)
  const defaultLabel = defaultEffort ? t("模型默认（{v1}）", { v1: effortLabel(defaultEffort) }) : t('跟随模型默认')
  const requested = selection?.reasoningEffort
  const value = requested === undefined ? (efforts.some(effort => effort.id === 'off') ? 'off' : '') : (requested ?? '')
  const unavailable = value && !efforts.some(effort => effort.id === value)
  return <>
    <label>{t("DSH 模型") + " "}<select disabled={disabled} value={index} onChange={event => onChange(models[Number(event.target.value)])}>
      <option value={-1} disabled>{models.length ? t('请选择') : t('请先配置 DSH 模型')}</option>
      {models.map((item, i) => <option key={item.provider + '/' + item.model} value={i}>
        {item.name || item.model} · {item.provider}
      </option>)}
    </select></label>
    {(efforts.length > 0 || value) && <label>{t("思考级别")}<select disabled={disabled} value={value} onChange={event => onChange({ ...selected, reasoningEffort: event.target.value || null })}>
        <option value="">{defaultLabel}</option>
        {unavailable && <option value={value} disabled>{t("当前级别不可用")}</option>}
        {efforts.map(effort => <option key={effort.id} value={effort.id}>{effortLabel(effort)}</option>)}
      </select>
    </label>}
    {current?.failed && <small role="status">{t("暂时无法读取思考级别。")}</small>}
  </>
}
