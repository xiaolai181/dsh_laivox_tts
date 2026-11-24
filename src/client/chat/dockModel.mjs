import { translate as t } from '../i18n/locale.mjs'
const ACTIVE = new Set(['queued', 'running', 'paused'])

export function queueSummary(counts, overflow) {
  const parts = []
  if (counts.queued) parts.push(t("{v1} 章排队", { v1: counts.queued }))
  if (counts.running) parts.push(t("{v1} 章在做", { v1: counts.running }))
  if (counts.paused) parts.push(t("{v1} 章已暂停", { v1: counts.paused }))
  if (overflow) parts.push(t("还有 {v1} 章未列出", { v1: overflow }))
  return parts.join(' · ')
}

export function formatOffset(offset) {
  if (!Number.isFinite(offset) || offset <= 0) return ''
  const total = Math.floor(offset)
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0')
}

export function readingName(value) {
  const title = value?.title?.trim() ?? ''
  const book = value?.bookTitle?.trim() ?? ''
  if (value?.isSnippet || !book || book === title) return title || t('对话朗读')
  return '《' + book + '》' + (title ? ' · ' + title : '')
}

export function resumeLabel(resume) {
  if (!resume?.id) return ''
  const segment = Number.isInteger(resume.n) && resume.n >= 0 ? t(" · 第 {v1} 段", { v1: resume.n + 1 }) : ''
  const clock = formatOffset(resume.offset)
  return t("上次听到 · {v1}{v2}{v3}", { v1: readingName(resume), v2: segment, v3: clock ? ' · ' + clock : '' })
}

// Active jobs stay in the dock. A finished or cancelled job is not part of this
// view; the conversation tail renders that one row.
export function dockView({ proposals, imports, jobs, overflow, resume, latest, error } = {}) {
  const active = (Array.isArray(jobs) ? jobs : []).filter(job => ACTIVE.has(job?.state))
  const counts = { queued: 0, running: 0, paused: 0 }
  for (const job of active) counts[job.state] += 1
  const extra = Number.isInteger(overflow) && overflow > 0 ? overflow : 0
  const pending = Array.isArray(proposals) ? proposals : []
  const listed = (Array.isArray(imports) ? imports : []).slice(0, 3)
  const idle = pending.length === 0 && listed.length === 0 && active.length === 0
  const duplicate = latest?.chapter === resume?.id && latest?.state === 'completed' && latest?.purpose === 'generate' && latest?.id === resume?.job
  const resumeRow = idle && resume?.id && resume.job && !duplicate ? resume : null
  return {
    proposal: pending[0] ?? null,
    proposals: pending,
    imports: listed,
    jobs: active,
    visible: active.slice(0, 2),
    folded: active.slice(2),
    summary: queueSummary(counts, extra),
    resume: resumeRow,
    empty: idle && !resumeRow && !error,
  }
}

export function turnNumber(turn) {
  if (typeof turn === 'number' && Number.isInteger(turn)) return turn
  if (turn && typeof turn.turn === 'number' && Number.isInteger(turn.turn)) return turn.turn
  return undefined
}

export function isLastTurn(turn, snapshot) {
  const mine = turnNumber(turn)
  const order = snapshot?.timeline?.turnOrder
  const last = order && typeof order.at === 'function' ? order.at(-1) : undefined
  return typeof mine === 'number' && mine === last
}

// One collapsed line for the dock, in the order a listener cares about.
export function dockHeadline({ proposals = [], jobs = [], imports = [] } = {}) {
  const parts = []
  // A production batch (laivox_make) is not a passage of text, so a mixed list counts items.
  if (proposals.length) parts.push(proposals.length + (proposals.some(item => item?.kind === 'make') ? t(' 项待确认') : t(' 段待确认')))
  const making = jobs.filter(job => job.state === 'running' || job.state === 'queued').length
  const paused = jobs.filter(job => job.state === 'paused').length
  if (making) parts.push(t("{v1} 章制作中", { v1: making }))
  if (paused) parts.push(t("{v1} 章已暂停", { v1: paused }))
  if (imports.length) parts.push(t("{v1} 个导入待预览", { v1: imports.length }))
  const running = jobs.find(job => job.state === 'running')
  const percent = running ? jobPercent(running) : null
  return { text: parts.join(' · '), percent }
}

function jobCount(job) {
  if (job.stage === 'cleaning') return [job.counts?.clean, t('批')]
  if (job.stage === 'scripting') return [job.counts?.cast, t('批')]
  if (job.stage === 'synthesizing' || job.synthesis) return [job.synthesis, t('段')]
  return []
}

export function jobPercent(job) {
  const [count] = jobCount(job)
  return count?.total > 0 ? Math.round(Math.min(1, count.done / count.total) * 100) : null
}

const STATE_TEXT = { queued: '排队中', paused: '已暂停', completed: '已完成', cancelled: '已取消' }
const STAGE_TEXT = { cleaning: 'AI 清洗', scripting: '编剧', synthesizing: '合成' }

// A dock row keeps everything the job progress shows in the workbench (stage and
// count, AI usage, automatic retry, the reason it stopped) on one or two short
// lines. `explain` turns an error code into text; `now` drives the countdown.
export function jobLine(job, explain = code => code, now = Date.now()) {
  const [count, unit] = jobCount(job)
  const stage = t(job.state === 'running' ? STAGE_TEXT[job.stage] ?? '处理中' : STATE_TEXT[job.state] ?? job.state)
  const status = stage + (job.state === 'running' && count?.total > 0 ? ' ' + count.done + '/' + count.total + ' ' + unit : '')
  const detail = []
  if (job.error) detail.push(explain(job.retryAfter ? { message: job.error, retryAfter: job.retryAfter } : job.error))
  else if (job.state === 'paused' && job.pauseReason === 'newer-task') detail.push(t('因开始新任务已自动暂停'))
  else if (job.state === 'paused' && job.pauseReason === 'restart') detail.push(t('插件重启时暂停'))
  const auto = job.state === 'paused' && Number.isFinite(job.autoResume?.at) ? job.autoResume : null
  if (auto) {
    const left = Math.max(0, Math.ceil((auto.at - now) / 1000))
    detail.push(left > 0 ? t("{v1} 秒后自动重试（第 {v2} 次）", { v1: left, v2: auto.attempt }) : t('正在自动重试…'))
  }
  if (Number.isInteger(job.errorPart?.n)) detail.push(t("第 {v1} 段", { v1: job.errorPart.n + 1 }))
  if (job.ai && Number.isFinite(Number(job.ai.requests)) && !job.error) detail.push(t("AI {v1} 次", { v1: Number(job.ai.requests) }))
  return { name: readingName(job), status, detail, percent: job.state === 'running' ? jobPercent(job) : null,
    error: Boolean(job.error), countdown: Boolean(auto) }
}

// What the dock currently shows, as stable keys. Closing it with × stores these;
// the dock stays hidden until something not in that set appears.
export function dockKeys(view) {
  return [
    ...(view?.proposals ?? []).map(item => 'p:' + item.id),
    ...(view?.jobs ?? []).map(item => 'j:' + item.id),
    ...(view?.imports ?? []).map(item => 'i:' + item.id),
    ...(view?.resume ? ['r:' + view.resume.id + ':' + view.resume.job] : []),
  ]
}

export function dockDismissed(keys, dismissed) {
  return Boolean(dismissed) && keys.length > 0 && keys.every(key => dismissed.has(key))
}
