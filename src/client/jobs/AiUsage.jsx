import React from 'react'
import { translate as t } from '../i18n/locale.mjs'
import { Icon } from '../components/Icon.jsx'

export function AiUsage({ ai }) {
  if (!(ai?.requests > 0)) return null
  const tokens = ai.tokens
  const reported = tokens?.reported > 0
  const total = reported ? tokens.input + tokens.output : 0
  const count = value => value.toLocaleString()
  return <div className="lv-ai-usage">
    <small className="lv-metric-caption"><Icon name="Cpu" size={14}/><span>
      {reported ? t('DSH 模型已调用 {reported} / {requests} 次 · 输入 {input} · 输出 {output}', {
        requests: count(ai.requests), reported: count(tokens.reported), input: count(tokens.input), output: count(tokens.output),
      }) : t('DSH 模型已调用 {requests} 次 · 暂未返回用量统计', { requests: count(ai.requests) })}
    </span></small>
    {total > 0 && <div className="lv-token-split" aria-hidden="true" style={{ '--lv-token-input': tokens.input / total }}><span/></div>}
  </div>
}
