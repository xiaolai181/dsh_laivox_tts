import { deferText, translate as t } from '../i18n/locale.mjs'
import { useEffect, useRef, useState } from 'react'
import { explain, get, post } from '../api.mjs'

// Job list for the task sheet: polled while open, paged by 30, optionally
// limited to one book or chapter. Bulk actions apply to the same scope.
export function useQueue({ scope, refreshKey, decide, notify }) {
  const [offset, setOffset] = useState(0)
  const [result, setResult] = useState(null)
  const [retry, setRetry] = useState(0)
  const [bulk, setBulk] = useState(null)
  const scopeKey = JSON.stringify([scope?.book ?? null, scope?.chapter ?? null, scope?.state ?? null])
  const currentScope = useRef(scopeKey)
  currentScope.current = scopeKey
  const pending = useRef(null)
  const data = result?.scopeKey === scopeKey ? result.data : null
  const error = result?.scopeKey === scopeKey ? result.error : ''
  useEffect(() => { setOffset(0) }, [scopeKey])
  useEffect(() => () => { pending.current?.abort() }, [])
  useEffect(() => {
    const abort = new AbortController()
    let timer
    async function refresh() {
      try {
        const value = await get('jobs/page', { ...scope, offset }, abort.signal)
        if (!abort.signal.aborted) setResult({ scopeKey, data: value, error: '' })
      } catch (failure) {
        if (!abort.signal.aborted) setResult(previous => ({
          scopeKey, data: previous?.scopeKey === scopeKey ? previous.data : null, error: deferText(() => explain(failure)),
        }))
      }
      finally { if (!abort.signal.aborted) timer = setTimeout(refresh, 3200) }
    }
    void refresh()
    return () => { clearTimeout(timer); abort.abort() }
  }, [scopeKey, offset, refreshKey, retry])
  const counts = data?.counts ?? {}
  function applicable(mode) {
    const states = mode === 'pause' ? ['running', 'queued'] : mode === 'resume' ? ['paused'] : ['running', 'queued', 'paused']
    return states.reduce((total, id) => total + (counts[id] ?? 0), 0)
  }
  async function bulkRun(mode) {
    if (pending.current || !applicable(mode)) return
    const request = new AbortController()
    pending.current = request
    const sameScope = () => !request.signal.aborted && currentScope.current === scopeKey
    const verb = () => mode === 'pause' ? t('暂停') : mode === 'resume' ? t('继续') : t('取消')
    setBulk(mode)
    try {
      let ids
      if (mode !== 'resume') {
        const preview = await post('jobs/action', { action: 'bulk-preview', mode, ...(scope ? { scope } : {}) }, false, request.signal)
        if (!sameScope()) return
        ids = preview.ids
        if (!ids.length) { notify(deferText(() => t('当前没有可操作的任务。'))); setRetry(n => n + 1); return }
        const choice = await decide({
          title: deferText(() => t("{v1} {v2} 个任务？", { v1: verb(), v2: ids.length })),
          text: deferText(() => (scope?.chapter ? t('范围：本章。') : scope?.book ? t('范围：本书。') : t('范围：全部任务。'))
            + (mode === 'cancel' ? t('任务将结束，已生成的音频仍可播放。') : t('正在处理的任务会停下，之后可以全部继续。'))),
          choices: [[mode, deferText(() => t("{v1}这些任务", { v1: verb() }))], [null, deferText(() => t('返回'))]],
          destructive: true,
        })
        if (choice !== mode || !sameScope()) return
      }
      const result = await post('jobs/action', { action: 'bulk', mode, ...(scope ? { scope } : {}), ids })
      notify(deferText(() => {
        const parts = [t("已{v1} {v2} 个任务", { v1: verb(), v2: result.applied ?? 0 })]
        if (result.skipped) parts.push(t("跳过 {v1} 个", { v1: result.skipped }))
        if (result.failed) parts.push(t("失败 {v1} 个", { v1: result.failed }))
        return parts.join('，')
      }))
      setRetry(n => n + 1)
    } catch (failure) {
      if (sameScope()) setResult(previous => ({
        scopeKey, data: previous?.scopeKey === scopeKey ? previous.data : null, error: deferText(() => explain(failure)),
      }))
    } finally {
      pending.current = null
      if (!request.signal.aborted) setBulk(null)
    }
  }
  return {
    data, error, counts, bulk, applicable, bulkRun, reload: () => setRetry(n => n + 1),
    page: data?.total > 30 ? { index: Math.floor(offset / 30) + 1, count: Math.ceil(data.total / 30),
      previous: offset ? () => setOffset(offset - 30) : null, next: offset + 30 < data.total ? () => setOffset(offset + 30) : null } : null,
  }
}
