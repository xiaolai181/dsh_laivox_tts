import { translate as t } from './i18n/locale.mjs'
import { PLUGIN_ID } from '../domain/plugin.mjs'
import { messages } from '../domain/messages.mjs'

export function url(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null))
  return 'api/' + PLUGIN_ID + '/' + path + (query.size ? '?' + query : '')
}

async function read(response) {
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(result?.error ?? 'SERVICE_UNAVAILABLE')
    error.current = result?.current
    error.details = result?.details
    error.detail = result?.detail
    error.status = response.status
    if (Number.isSafeInteger(result?.retryAfter) && result.retryAfter > 0 && result.retryAfter <= 86_400) error.retryAfter = result.retryAfter
    throw error
  }
  return result
}

const deadline = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)
export const POST_TIMEOUT_MS = 135_000
// One review round stays inside this limit. A longer book continues from the saved checkpoint.
export const REVIEW_POST_TIMEOUT_MS = 120_000
export const get = (path, params, signal) => fetch(url(path, params), { cache: 'no-store', signal: deadline(signal, 25_000) }).then(read)
export const post = (path, body, keepalive = false, signal, timeout = POST_TIMEOUT_MS) => fetch(url(path), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive, signal: deadline(signal, timeout),
}).then(read)
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return Math.round(value) + ' B'
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
  return size.toFixed(1) + ' ' + units[unit]
}
export const getAudio = async (engine, voice, signal) => {
  const response = await fetch(url('voices/preview', { engine, voice }), { signal: deadline(signal, 26_000), cache: 'no-store' })
  if (!response.ok) await read(response)
  return response.blob()
}
// Chapter downloads (progress, cancel, one at a time) live in workbench/downloads.mjs.
export const upload = (file, signal) => fetch(url('import/upload', { name: file.name }), {
  method: 'POST', body: file, signal,
}).then(read)


export function explain(error) {
  if (error?.name === 'TimeoutError') return t('请求超时。请检查连接后重试。')
  if (error instanceof TypeError && !error.status) return t('无法连接本地服务，请重试。')
  const code = error?.message ?? error
  let message = Object.hasOwn(messages, code) ? t(messages[code]) : t('操作未完成{v1}。', { v1: code ? '（' + code + '）' : '' })
  if (Number.isSafeInteger(error?.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86_400) {
    message += ' ' + t('服务繁忙，请等待约 {seconds} 秒后重试。', { seconds: error.retryAfter })
  }
  const detail = typeof error?.detail === 'string' ? error.detail.replace(/\s+/gu, ' ').trim() : ''
  if (!detail) return message
  return message + '（' + (detail.length > 200 ? detail.slice(0, 200) + '…' : detail) + '）'
}

const names = { queued: '排队中', running: '处理中', paused: '已暂停', completed: '已完成', cancelled: '已取消',
  cleaning: 'AI 清洗', scripting: '角色与情绪标注', synthesizing: '合成音频' }
export const statusLabel = job => t(job?.state === 'running' ? names[job.stage] ?? names.running : names[job?.state])
