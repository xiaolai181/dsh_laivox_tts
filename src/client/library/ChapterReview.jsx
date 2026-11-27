import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { explain, get, post, REVIEW_POST_TIMEOUT_MS } from '../api.mjs'
import { modelIdentity, ModelOptions } from '../editorial/ModelOptions.jsx'
import { LevelBar } from '../components/Metrics.jsx'
import { AiUsage } from '../jobs/AiUsage.jsx'

export const cutLabels = { structure: '目录结构', heading: '正文标题', spine: '章节文件', learned: '标题样式', suggested: '建议分章', manual: '手动分章', split: '超长拆分' }

export function ChapterReview({ data, session, onUpdate, busy, setBusy, setReviewCanLeave, onError, focused, focus, close, decide }) {
  const [models, setModels] = useState(undefined)
  const [modelsTry, setModelsTry] = useState(0)
  const [selection, setSelection] = useState(null)
  const selected = selection ?? models?.[0]
  const [progress, setProgress] = useState('')
  const [phase, setPhase] = useState(null)
  const [context, setContext] = useState(null)
  const [contextError, setContextError] = useState('')
  const [cursor, setCursor] = useState(null)
  const owner = useRef(null)
  const latest = useRef(null)
  const confirmed = useRef(null)
  const reviewKey = JSON.stringify([data.id, session, data.revision, selected?.provider, selected?.model, selected?.reasoningEffort])
  const capped = data.ai.spent >= data.ai.budget || data.ai.requests >= data.ai.requestLimit

  useEffect(() => {
    const load = new AbortController()
    get('models', {}, load.signal).then(result => {
      if (!load.signal.aborted) setModels(Array.isArray(result) ? result : [])
    }).catch(() => {
      if (!load.signal.aborted) setModels(null)
    })
    return () => load.abort()
  }, [modelsTry])

  useLayoutEffect(() => {
    latest.current = reviewKey
    confirmed.current = null
  }, [reviewKey])
  useLayoutEffect(() => () => {
    const operation = owner.current
    owner.current = null
    operation?.lifetime.abort()
  }, [])
  const cursorOffset = cursor?.anchor === focused?.offset ? cursor?.offset : null
  const offset = cursorOffset ?? focused?.offset
  useEffect(() => {
    const load = new AbortController()
    setContext(null)
    setContextError('')
    if (offset != null) get('import/context', { id: data.id, session, offset }, load.signal).then(value => {
      if (!load.signal.aborted) setContext(value)
    }).catch(error => { if (!load.signal.aborted) setContextError(deferText(() => explain(error))) })
    return () => load.abort()
  }, [data.id, session, offset])

  function inspect(item) {
    setCursor(null)
    focus(item)
  }

  function beginReview(nextPhase) {
    const operation = { lifetime: new AbortController(), request: new AbortController() }
    owner.current = operation
    setBusy(true)
    setPhase(nextPhase)
    return operation
  }

  function finishReview(operation, ready) {
    if (owner.current !== operation) return
    owner.current = null
    setPhase(ready ? null : 'refresh')
    setReviewCanLeave(!ready)
    setBusy(!ready)
  }

  async function refreshSettled(operation) {
    setPhase('settling')
    setReviewCanLeave(true)
    setProgress(deferText(() => t('正在结束复核并刷新预览…')))
    try {
      const result = await get('import/preview', { id: data.id, session, settled: 1 }, operation.lifetime.signal)
      if (owner.current !== operation) return false
      onUpdate(result)
      setProgress(deferText(() => t('复核进度已刷新。可以继续未完成的批次。')))
      return true
    } catch {
      if (owner.current === operation) setProgress(deferText(() => t('暂未取得最新复核结果。请刷新预览后继续。')))
      return false
    }
  }

  async function refreshReview() {
    if (owner.current || phase !== 'refresh') return
    const operation = beginReview('settling')
    finishReview(operation, await refreshSettled(operation))
  }

  async function analyze() {
    if (!selected || owner.current || busy || capped) return
    const operation = beginReview('confirming')
    let ready = true
    try {
      const { provider, model, reasoningEffort } = selected
      if (confirmed.current !== reviewKey && decide) {
        const chosen = await decide({
          title: deferText(() => t('使用 AI 复核分章？')),
          text: deferText(() => t('{model}。本版本还可提交约 {chars} 字样本进行 AI 检查，最多 {requests} 次 DSH 模型请求。', {
            model: modelIdentity(selected, reasoningEffort === null ? undefined : t('按当前模型设置')),
            chars: Math.max(0, data.ai.budget - data.ai.spent).toLocaleString(),
            requests: Math.max(0, data.ai.requestLimit - data.ai.requests),
          })),
          choices: [['start', deferText(() => data.ai.requests > 0 ? t('继续复核') : t('开始复核'))], [null, deferText(() => t('取消'))]],
        })
        if (!chosen || owner.current !== operation || latest.current !== reviewKey) return
        confirmed.current = reviewKey
      }
      setPhase('reviewing')
      setProgress(deferText(() => t('正在按小批次判断标题和疑点…')))
      onError('')
      const signal = AbortSignal.any([operation.lifetime.signal, operation.request.signal])
      let result
      for (let round = 0; round < data.ai.requestLimit; round++) {
        result = await post('import/action', {
          id: data.id, session, action: 'analyze', selection: { provider, model, reasoningEffort },
        }, false, signal, REVIEW_POST_TIMEOUT_MS)
        signal.throwIfAborted()
        if (owner.current !== operation) return
        onUpdate(result)
        if (!result.ai.partial) break
      }
      setProgress(deferText(() => result.ai.spent === data.ai.spent ? t('没有需要继续发送的样本。')
        : result.suggestions.length ? t('复核完成。请查看建议分节。') : t('本轮复核完成。')))
    } catch (error) {
      if (owner.current !== operation) return
      if (!operation.request.signal.aborted) onError(deferText(() => explain(error)))
      ready = await refreshSettled(operation)
    } finally {
      finishReview(operation, ready)
    }
  }

  async function change(from, to) {
    setBusy(true)
    onError('')
    try {
      const result = await post('import/action', {
        id: data.id, session, action: 'cut', revision: data.revision, from, to,
      })
      onUpdate(result)
      close()
      setCursor(null)
    } catch (error) {
      onError(explain(error))
      if (error.message === 'VERSION_CONFLICT') await get('import/preview', { id: data.id, session }).then(onUpdate).catch(() => {})
    } finally { setBusy(false) }
  }

  return <section className="lv-chapter-review" aria-label={t("章节识别")}>
    <div className="lv-inline">
      {Array.isArray(models) && models.length > 0 && <ModelOptions models={models} selection={selected} onChange={setSelection} disabled={busy}/>}
      {models === null && <><small role="alert" className="lv-error">{t('模型列表暂不可用。')}</small><button type="button" onClick={() => { setModels(undefined); setModelsTry(n => n + 1) }}>{t('重试')}</button></>}
      <button disabled={busy || !models?.length || capped} onClick={analyze}>{data.ai.requests > 0 ? t('继续复核') : t('AI 辅助分章')}</button>
      {phase === 'reviewing' && <button onClick={() => owner.current?.request.abort()}>{t("停止复核")}</button>}
      {phase === 'refresh' && <button onClick={refreshReview}>{t('刷新复核预览')}</button>}
    </div>
    <small>
      {models === undefined ? t('正在读取模型…') : models === null ? '' : models.length ? t('启用后，仅向所选模型发送候选标题和断点附近的摘录。') : t('配置 DSH 模型后可复核疑点。')}
      {models !== null ? ' ' : ''}{t('已使用 {used} / {budget} 字符 · {done} / {limit} 次请求。',
        { used: data.ai.spent.toLocaleString(), budget: data.ai.budget.toLocaleString(), done: data.ai.requests, limit: data.ai.requestLimit })}</small>
    <div className="lv-review-meters">
      <LevelBar label={t('AI 检查字数上限')} value={data.ai.spent} max={data.ai.budget}/>
      <LevelBar label={t('AI 检查次数上限')} value={data.ai.requests} max={data.ai.requestLimit}/>
    </div>
    <AiUsage ai={data.ai}/>
    {capped && <small>{t("已达到此版本的复核上限，仍可手动分章。")}</small>}
    {progress && <small role="status">{displayText(progress)}</small>}
    {data.suggestions.length > 0 && <details open>
      <summary>{t("建议分章 ·") + " "}{data.suggestions.length}{" " + t("处")}</summary>
      <div className="lv-break-suggestions">
        {data.suggestions.map((suggestion, n) => <button key={suggestion.offset} disabled={busy} onClick={() => inspect(suggestion)}>
          {suggestion.title || t("查看位置 {v1}", { v1: n + 1 })}
        </button>)}
      </div>
    </details>}
    {focused && <div className="lv-cut-context">
      <div className="lv-heading">
        <strong>{focused.title || t('建议分章位置')}</strong>
        <button disabled={busy} onClick={() => { close(); setCursor(null) }}>{t("收起")}</button>
      </div>
      {contextError && <small role="alert">{displayText(contextError)}</small>}
      {context ? <>
        {context.before && <blockquote>{context.before}</blockquote>}
        <div className="lv-cut-line">{t("从这里开始新一章")}</div>
        <blockquote>{context.after}</blockquote>
        <div className="lv-inline">
          <button disabled={busy || context.previous == null} onClick={() => setCursor({ anchor: focused.offset, offset: context.previous })}>{t("上一行")}</button>
          <button disabled={busy || context.next == null} onClick={() => setCursor({ anchor: focused.offset, offset: context.next })}>{t("下一行")}</button>
          {focused.kind === 'split' ? <small>{t("这一章因超过 10 万字被自动拆分，这条分界不能取消或移动。")}</small>
          : focused.kind === 'suggested' ? <>
            <button className="lv-primary" disabled={busy || context.offset === 0} onClick={() => change(focused.offset, context.offset)}>{t("在此分章")}</button>
            <button disabled={busy} onClick={() => change(focused.offset, null)}>{t("忽略建议")}</button>
          </> : <>
            {focused.offset > 0 && <button disabled={busy} onClick={() => change(focused.offset, null)}>{t("并入上一章")}</button>}
            {focused.offset > 0 && cursorOffset != null && cursorOffset !== focused.offset && <button disabled={busy || context.offset === 0} onClick={() => change(focused.offset, context.offset)}>{t("移至此处分章")}</button>}
            {cursorOffset != null && context.offset !== focused.offset && <button className="lv-primary" disabled={busy || context.offset === 0} onClick={() => change(null, context.offset)}>{t("在此拆分为新章")}</button>}
          </>}
        </div>
      </> : !contextError && <small role="status">{t("正在读取附近正文…")}</small>}
    </div>}
  </section>
}
