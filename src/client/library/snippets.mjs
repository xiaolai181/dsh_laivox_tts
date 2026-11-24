import { translate as t } from '../i18n/locale.mjs'
// Conversation readings ("对话音频") as the list shows them: grouped by the
// conversation they came from, newest listen first, with when they expire.
const DAY = 86_400_000
const HOUR = 3_600_000

export const RETENTION_CHOICES = [['1d', '1 天'], ['7d', '7 天'], ['30d', '30 天'], ['never', '永不']]
const RETENTION_DAYS = { '1d': 1, '7d': 7, '30d': 30 }

export function retentionLabel(value) {
  if (value === 'never') return t('一直保留')
  return t('保留 ') + t(RETENTION_CHOICES.find(([key]) => key === value)?.[1] ?? '7 天')
}

// Shortening the period deletes readings at the next cleanup; the warning names
// how many and how old.
export function shortenWarning(value, count) {
  const days = RETENTION_DAYS[value]
  if (!days || !count) return ''
  return t("将删除 {v1} 条超过 {v2} 天未听的对话片段，正文、音频和播放进度都无法恢复。", { v1: count, v2: days })
}

// "最后收听 3 小时前"; a reading never listened to counts from when it was made.
export function agoText(touched, now = Date.now()) {
  const elapsed = Math.max(0, now - (Number(touched) || now))
  if (elapsed < HOUR) return t('刚刚')
  if (elapsed < DAY) return t("{v1} 小时前", { v1: Math.floor(elapsed / HOUR) })
  return t("{v1} 天前", { v1: Math.floor(elapsed / DAY) })
}

// Empty when the readings are kept forever. Rounded up, so "1 天后" never shows
// for something that goes in an hour; under a day it says "今天".
export function expiryText(touched, retention, now = Date.now()) {
  const days = RETENTION_DAYS[retention] ?? (retention === 'never' ? null : 7)
  if (days === null) return ''
  const left = (Number(touched) || now) + days * DAY - now
  if (left <= DAY) return t('今天删除')
  return t("{v1} 天后删除", { v1: Math.ceil(left / DAY) })
}

const monthDay = time => {
  const date = new Date(Number(time) || Date.now())
  return t("{v1} 月 {v2} 日", { v1: date.getMonth() + 1, v2: date.getDate() })
}

// The conversation title when DSH still knows it; otherwise "会话 · 11 月 17 日"
// (the day of the newest reading in that group).
export function sessionLabel(title, time) {
  const text = typeof title === 'string' ? title.trim() : ''
  return text || t("会话 · {v1}", { v1: monthDay(time) })
}

// Groups keep the order of their newest reading; rows inside a group are newest
// first. `titles` maps a session id to its title (may be missing).
export function groupSnippets(items, titles = {}) {
  const groups = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    const key = item.session ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item)
  }
  return [...groups].map(([session, rows]) => {
    const sorted = [...rows].sort((a, b) => (Number(b.touched) || 0) - (Number(a.touched) || 0))
    return { session, title: sessionLabel(titles[session], sorted[0]?.touched), items: sorted }
  }).sort((a, b) => (Number(b.items[0]?.touched) || 0) - (Number(a.items[0]?.touched) || 0))
}

export function durationText(seconds) {
  const value = Math.round(Number(seconds) || 0)
  if (value <= 0) return ''
  if (value < 60) return t("{v1} 秒", { v1: value })
  return t("{v1} 分 {v2} 秒", { v1: Math.floor(value / 60), v2: String(value % 60).padStart(2, '0') })
}
