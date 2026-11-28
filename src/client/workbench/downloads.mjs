import { deferText, translate as t } from '../i18n/locale.mjs'
import { explain, formatBytes, get, url } from '../api.mjs'

// Chapter downloads (WAV/MP3). The host prepares the whole file before the
// browser can save it, which takes a while for a long chapter, so every
// download is tracked here: what it is doing, how many parts are ready, and a
// way to cancel. Progress comes from the host (media/book/progress by export
// id), not from the response bytes, which may only arrive at the end.
// One download per job and format at a time; components only display it.
const CLEAR_AFTER_MS = 60_000
const POLL_MS = 1000

const downloads = new Map()
const listeners = new Set()
let snapshot = new Map()

function publish() {
  snapshot = new Map(downloads)
  for (const listener of listeners) listener()
}

export const subscribeDownloads = listener => { listeners.add(listener); return () => listeners.delete(listener) }
export const downloadsSnapshot = () => snapshot
export const downloadKey = (job, format) => job + ':' + format

function save(blob, disposition, fallback) {
  const encoded = /filename\*=UTF-8''([^;]+)/u.exec(disposition ?? '')?.[1]
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = encoded ? decodeURIComponent(encoded) : fallback
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
}

// Starts (or joins) the download of one chapter's audio. Resolves with '' or
// the message of a failure; start, completion and cancellation are announced
// through notify. Dependencies are injectable for tests.
export function startChapterDownload({ job, format, title, speakers = true, notify = () => {}, fetchImpl = fetch, getImpl = get, saveImpl = save, poll = POLL_MS }) {
  const key = downloadKey(job, format)
  const current = downloads.get(key)
  // A second click joins the download in progress; its outcome is announced once.
  if (current?.phase === 'preparing') {
    notify(deferText(() => t('正在准备中')))
    return current.promise.then(() => '')
  }
  const isSubtitle = format === 'srt' || format === 'lrc' || format === 'md'
  const id = crypto.randomUUID()
  const abort = new AbortController()
  const label = format.toUpperCase()
  const entry = { key, job, format, title: title || '', phase: 'preparing', done: 0, total: 0, cancel: () => abort.abort() }
  downloads.set(key, entry)
  publish()
  notify(deferText(() => t('正在准备 {format}，完成后会自动下载', { format: label })))
  let timer
  const update = changes => {
    if (downloads.get(key) !== entry) return
    Object.assign(entry, changes)
    publish()
  }
  async function follow() {
    try {
      const progress = await getImpl('media/book/progress', { id })
      if (entry.phase !== 'preparing') return
      if (progress.done !== entry.done || progress.total !== entry.total) update({ done: Number(progress.done) || 0, total: Number(progress.total) || 0 })
    } catch { /* the request may not have reached the host yet; the download itself reports failures */ }
    if (entry.phase === 'preparing') { timer = setTimeout(follow, poll); timer.unref?.() }
  }
  if (!isSubtitle) {
    timer = setTimeout(follow, Math.min(poll, 300))
    timer.unref?.()
  }
  function finish(phase, changes = {}) {
    clearTimeout(timer)
    update({ phase, ...changes })
    const clear = setTimeout(() => { if (downloads.get(key) === entry) { downloads.delete(key); publish() } }, CLEAR_AFTER_MS)
    clear.unref?.()
  }
  entry.promise = (async () => {
    try {
      const requestUrl = isSubtitle
        ? url('media/chapter/subtitles', { job, format, speakers: speakers ? '1' : '0' })
        : url('media/chapter', format === 'mp3' ? { job, format, export: id } : { job, export: id })
      const response = await fetchImpl(requestUrl, { cache: 'no-store', signal: abort.signal })
      if (!response.ok) {
        let code = 'SERVICE_UNAVAILABLE'
        try { code = (await response.json()).error ?? code } catch {}
        // A plain link would leave a failed export (409, 404) without any message.
        throw new Error(response.status === 404 && code === 'SERVICE_UNAVAILABLE' ? 'AUDIO_MISSING' : code)
      }
      const blob = await response.blob()
      if (abort.signal.aborted) throw abort.signal.reason
      saveImpl(blob, response.headers.get('Content-Disposition'), (title || 'novel') + '.' + format)
      finish('done', { done: entry.total || entry.done })
      notify(deferText(() => t('已开始下载 · {size}', { size: formatBytes(blob.size) })))
      return ''
    } catch (error) {
      if (abort.signal.aborted) {
        finish('cancelled')
        notify(deferText(() => t('已取消下载')))
        return ''
      }
      const message = deferText(() => explain(error))
      finish('error', { error: message })
      return message
    }
  })()
  return entry.promise
}

export function startBookExportDownload({ book, title = '', params = {}, notify = () => {}, fetchImpl = fetch, getImpl = get, saveImpl = save, poll = POLL_MS }) {
  const format = params.format === 'wav' ? 'wav' : 'mp3'
  const mode = params.mode === 'single' ? 'single' : 'zip'
  const key = 'book:' + book + ':' + mode + ':' + format
  const current = downloads.get(key)
  if (current?.phase === 'preparing') {
    notify(deferText(() => t('正在准备中')))
    return current.promise.then(() => '')
  }
  const id = crypto.randomUUID()
  const abort = new AbortController()
  const label = mode === 'single' && (!params.subtitles || params.subtitles === 'none') ? format.toUpperCase() : 'ZIP'
  const entry = { key, book, format, title, phase: 'preparing', done: 0, total: 0, cancel: () => abort.abort() }
  downloads.set(key, entry)
  publish()
  notify(deferText(() => t('正在准备 {format}，完成后会自动下载', { format: label })))
  let timer
  const update = changes => {
    if (downloads.get(key) !== entry) return
    Object.assign(entry, changes)
    publish()
  }
  async function follow() {
    try {
      const progress = await getImpl('media/book/progress', { id })
      if (entry.phase !== 'preparing') return
      if (progress.done !== entry.done || progress.total !== entry.total) update({ done: Number(progress.done) || 0, total: Number(progress.total) || 0 })
    } catch {}
    if (entry.phase === 'preparing') { timer = setTimeout(follow, poll); timer.unref?.() }
  }
  timer = setTimeout(follow, Math.min(poll, 300))
  timer.unref?.()
  function finish(phase, changes = {}) {
    clearTimeout(timer)
    update({ phase, ...changes })
    const clear = setTimeout(() => { if (downloads.get(key) === entry) { downloads.delete(key); publish() } }, CLEAR_AFTER_MS)
    clear.unref?.()
  }
  entry.promise = (async () => {
    try {
      const response = await fetchImpl(url('media/book', { book, ...params, export: id }), { cache: 'no-store', signal: abort.signal })
      if (!response.ok) {
        let code = 'SERVICE_UNAVAILABLE'
        try { code = (await response.json()).error ?? code } catch {}
        throw new Error(code)
      }
      const blob = await response.blob()
      if (abort.signal.aborted) throw abort.signal.reason
      const ext = mode === 'single' && (!params.subtitles || params.subtitles === 'none') ? format : 'zip'
      saveImpl(blob, response.headers.get('Content-Disposition'), (title || 'novel') + '.' + ext)
      finish('done', { done: entry.total || entry.done })
      notify(deferText(() => t('已开始下载 · {size}', { size: formatBytes(blob.size) })))
      return ''
    } catch (error) {
      if (abort.signal.aborted) {
        finish('cancelled')
        notify(deferText(() => t('已取消下载')))
        return ''
      }
      const message = deferText(() => explain(error))
      finish('error', { error: message })
      return message
    }
  })()
  return entry.promise
}

// Kept for existing callers: resolves with '' or the message to show.
export function downloadChapter(job, format, title) {
  return startChapterDownload({ job, format, title })
}

export async function startExcerptDownload({ job, from, to, format = 'mp3', subtitles = 'srt', speakers = true, title = '', notify = () => {}, fetchImpl = fetch, saveImpl = save }) {
  notify(deferText(() => t('正在截取高光片段…')))
  try {
    const response = await fetchImpl(url('media/excerpt', { job, from, to, format, subtitles, speakers: speakers ? '1' : '0' }), { cache: 'no-store' })
    if (!response.ok) {
      let code = 'SERVICE_UNAVAILABLE'
      try { code = (await response.json()).error ?? code } catch {}
      throw new Error(code)
    }
    const blob = await response.blob()
    const ext = format === 'zip' || (subtitles && subtitles !== 'none') ? 'zip' : format
    saveImpl(blob, response.headers.get('Content-Disposition'), ((title || 'novel') + '-高光片段.' + ext))
    notify(deferText(() => t('已导出高光片段 · {size}', { size: formatBytes(blob.size) })))
    return ''
  } catch (error) {
    const message = deferText(() => explain(error))
    notify(message)
    return message
  }
}

// "正在准备 MP3 · 12/199 段" for a download in progress, '' otherwise.
export function downloadLabel(entry) {
  if (entry?.phase !== 'preparing') return ''
  const label = entry.format.toUpperCase()
  return entry.total ? t('正在准备 {format} · {done}/{total} 段', { format: label, done: entry.done, total: entry.total })
    : t('正在准备 {format}…', { format: label })
}
