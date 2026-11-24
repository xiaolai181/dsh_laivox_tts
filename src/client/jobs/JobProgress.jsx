import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useState } from 'react'
import { explain, statusLabel } from '../api.mjs'
import { ActivityMark, LevelBar } from '../components/Metrics.jsx'
import { AiUsage } from './AiUsage.jsx'

// A paused job may already have a retry scheduled. Tick once a second so the
// countdown stays honest without asking the server again.
function useCountdown(auto) {
  const [now, setNow] = useState(() => Date.now())
  const at = auto?.at
  useEffect(() => {
    if (!Number.isFinite(at)) return undefined
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [at])
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - now) / 1000)) : 0
}

function currentCount(job) {
  if (job.stage === 'cleaning') return [job.counts?.clean, '批', '已完成']
  if (job.stage === 'scripting') return [job.counts?.cast, '批', '已完成']
  if (job.stage === 'synthesizing') return [job.synthesis, '段', '已生成']
  return []
}

// Two lines at most: what the job is doing, then why it stopped (or what it
// has used). The raw error code stays visible, muted, while the plugin is
// still being debugged; the worker's full message folds into a detail.
export function JobProgress({ job, actionPending }) {
  const [count, unit, prefix] = currentCount(job)
  const label = actionPending === 'pause' ? t('正在暂停') : actionPending === 'resume' ? t('正在继续')
    : actionPending === 'cancel' ? t('正在取消') : statusLabel(job)
  const active = ['queued', 'running', 'paused'].includes(job.state)
  const waiting = !actionPending && job.state === 'running' && unit === '批' && count?.done < count?.total
  const cause = typeof job.errorDetail === 'string' ? job.errorDetail.trim() : ''
  const part = job.errorPart && (Number.isInteger(job.errorPart.n) || job.errorPart.text) ? job.errorPart : null
  const auto = job.state === 'paused' && job.autoResume && Number.isFinite(job.autoResume.at) ? job.autoResume : null
  const left = useCountdown(auto)
  const skipped = Number.isInteger(job.skipped) && job.skipped > 0 ? job.skipped : 0
  const running = job.state === 'running' && !actionPending
  const summary = label + (active && count ? ' · ' + t(prefix) + ' ' + count.done + ' / ' + count.total + ' ' + t(unit) : '')
    + (waiting ? t("，正在处理第 {v1} 批", { v1: count.done + 1 }) : '')
  const detail = []
  if (job.error) detail.push(explain({ message: job.error, retryAfter: job.retryAfter }))
  else if (job.yieldWait && job.state === 'running') detail.push(t('等待当前 AI 批次完成'))
  else if (job.state === 'paused' && job.pauseReason === 'newer-task') detail.push(t('因开始新任务已自动暂停，可手动继续'))
  else if (job.state === 'paused' && job.pauseReason === 'restart') detail.push(t('插件重启时暂停，可继续'))
  if (auto) detail.push(left > 0 ? t("自动重试 {v1} 秒后（第 {v2} 次）", { v1: left, v2: auto.attempt }) : t('正在自动重试…'))
  if (cause) detail.push(t("原因：{v1}", { v1: cause.length > 80 ? cause.slice(0, 80) + '…' : cause }))
  if (part) detail.push(t("出错段落{v1}：", { v1: Number.isInteger(part.n) ? ' ' + (part.n + 1) : '' }) + (part.text || t('（无文本）')) + (part.text && part.text.length >= 80 ? '…' : ''))
  if (skipped) detail.push(t("跳过 {v1} 段无可朗读内容", { v1: skipped }))
  if (Number(job.filled) > 0) detail.push(t("{v1} 段由 Edge 补完", { v1: job.filled }))
  return <div className="lv-job-progress">
    <small className="lv-metric-caption" role="status"><ActivityMark state={job.state} stage={job.stage} error={job.error} pending={actionPending}/><span>{summary}</span></small>
    {active && <LevelBar label={unit === '批' ? t('AI 处理进度') : t('合成进度')} progress busy={running}
      value={count?.done} max={count?.total ?? 0} tone={job.error ? 'warn' : running ? 'accent' : 'muted'}/>}
    {detail.length > 0 && <small className="lv-job-detail" data-error={Boolean(job.error) || undefined}>{detail.join(' · ')}</small>}
    {(cause || job.error) && <details className="lv-error-detail"><summary>{t("查看错误详情")}</summary><pre>{[job.error ? '[' + job.error + ']' : '', cause].filter(Boolean).join('\n')}</pre></details>}
    <AiUsage ai={job.ai}/>
    {Array.isArray(job.attempts) && job.attempts.length > 0 && <details className="lv-error-detail">
      <summary>{t('最近的模型尝试')}</summary>
      <ol>{job.attempts.map((item, index) => <li key={index}>{t(item.phase === 'cast' ? '编剧' : item.phase === 'clean' ? '清洗' : '复核')}
        {Number.isInteger(item.batch) ? ' · ' + t('第 {batch} 批', { batch: item.batch + 1 }) : ''}
        {item.model ? ' · ' + item.model : ''}
        {' · '}{item.reason === 'stop' ? t('已完成') : item.reason === 'interrupted' ? t('已中止') : explain(item.reason)}
        {' · '}{t(item.usageState === 'reported' ? '已统计用量' : '暂无用量统计')}</li>)}</ol>
    </details>}
  </div>
}

export function jobActive(job) {
  return ['queued', 'running', 'paused'].includes(job?.state)
}
