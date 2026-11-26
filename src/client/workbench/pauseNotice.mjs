import { deferText, translate as t } from '../i18n/locale.mjs'

export const NEEDS_ACTION_KINDS = new Set(['account', 'membership', 'quota', 'outdated', 'voice'])
export const MAX_PAUSED_SCAN_PAGES = 10

export function pauseNoticeKey(job) {
  if (job?.state !== 'paused' || !NEEDS_ACTION_KINDS.has(job?.laivoxPause?.kind)) return null
  return `${job.id}:${job.error ?? ''}:${job.laivoxPause.kind}`
}

// Mirrors ProductionBar.jsx primary action rules so Toast, ProductionLive and
// ProductionBar always send the user to the exact matching surface.
export function pauseActionSpec(pause, packPage) {
  if (!pause) return null
  if (pause.kind === 'quota' && pause.canAuthorize) return { type: 'openDay', label: '开启下一个使用日' }
  if (pause.kind === 'account') return { type: 'settings', label: '打开设置' }
  if (pause.kind === 'voice') return { type: 'roles', label: '打开角色' }
  if ((pause.kind === 'quota' || pause.kind === 'membership') && pause.ledger === 'pack' && packPage) {
    return { type: 'link', href: packPage, label: '购买朗读时长包 ↗' }
  }
  return null
}

export function pauseNoticeFor(job, { explain, packPage, currentChapterId, openDay, openSettings, openRoles, openQueue } = {}) {
  const spec = pauseActionSpec(job?.laivoxPause, packPage)
  const otherChapter = Boolean(currentChapterId && job?.chapter && job.chapter !== currentChapterId)
  const text = deferText(() => {
    const reason = explain(job?.retryAfter ? { message: job.error, retryAfter: job.retryAfter } : job?.error)
    return otherChapter && job?.title ? job.title + ' · ' + reason : reason
  })
  let action = null
  if (spec?.type === 'openDay' && openDay) action = { label: deferText(() => t(spec.label)), run: openDay }
  else if (spec?.type === 'settings' && openSettings) action = { label: deferText(() => t(spec.label)), run: openSettings }
  else if (spec?.type === 'roles' && openRoles) action = { label: deferText(() => t(spec.label)), run: openRoles }
  else if (spec?.type === 'link') action = { label: deferText(() => t(spec.label)), href: spec.href }
  else if (otherChapter && openQueue) action = { label: deferText(() => t('查看任务')), run: openQueue }
  return { text, ...(action ?? {}), dismissible: true, durationMs: 12_000 }
}

export function diffNewPausedJobs(previousIds, scannedJobs) {
  if (!Array.isArray(scannedJobs) || !scannedJobs.length) return []
  const seen = previousIds instanceof Set ? previousIds : new Set()
  return scannedJobs.filter(job => job?.id && !seen.has(job.id))
}

export async function scanPausedJobs(fetchPage, { maxPages = MAX_PAUSED_SCAN_PAGES } = {}) {
  const jobs = []
  let offset = 0
  let pages = 0
  let total = 0
  let complete = false
  while (pages < maxPages) {
    pages++
    const page = await fetchPage(offset)
    const list = Array.isArray(page?.jobs) ? page.jobs : []
    total = Number.isInteger(page?.total) ? page.total : offset + list.length
    jobs.push(...list)
    offset += list.length
    if (list.length === 0 || offset >= total) {
      complete = true
      break
    }
  }
  return { jobs, complete, total }
}
