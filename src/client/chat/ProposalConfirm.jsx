import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState } from 'react'
import { explain, get } from '../api.mjs'
import { Icon } from '../components/Icon.jsx'
import { modelIdentity, ModelOptions } from '../editorial/ModelOptions.jsx'
import { makeSummary, proposalSummary } from './proposalConfirm.mjs'

// A proposal under the reply, in the dock or on its tool card: a text to read
// (laivox_propose, /laivox) or a production batch for a book (laivox_make).
function requestSettings() {
  try { sessionStorage.setItem('laivox-open-production', '1') } catch { /* private mode */ }
  window.dispatchEvent(new Event('laivox-request-settings'))
}

function useHostedPlan({ enabled, session, id, options, actions, formatError = explain }) {
  const [revision, setRevision] = useState(0)
  const key = JSON.stringify([session, id, options ?? null, revision])
  const [state, setState] = useState({ key: '', plan: null, pending: false, error: '' })
  useEffect(() => {
    if (!enabled) {
      setState({ key, plan: null, pending: false, error: '' })
      return undefined
    }
    const controller = new AbortController()
    setState({ key, plan: null, pending: true, error: '' })
    const timer = setTimeout(() => {
      actions.preview(session, id, options, controller.signal).then(plan => {
        if (!controller.signal.aborted) setState({ key, plan, pending: false, error: '' })
      }).catch(error => {
        if (controller.signal.aborted || error?.name === 'AbortError') return
        setState({ key, plan: null, pending: false, error: deferText(() => formatError(error)) })
      })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [enabled, key])
  const current = enabled && state.key === key ? state : { plan: null, pending: enabled, error: '' }
  return {
    ...current,
    refresh: () => setRevision(value => value + 1),
    expire: error => setState(value => value.key === key
      ? { key, plan: null, pending: false, error: deferText(() => explain(error)) }
      : value),
  }
}

function PlanNotice({ hosted, busy }) {
  if (!hosted.error) return null
  return <div className="lv-hline">
    <span className="lv-halert lv-hgrow" role="alert">{displayText(hosted.error)}</span>
    <button type="button" className="lv-hbtn" disabled={busy} onClick={hosted.refresh}>{t('重新预览')}</button>
  </div>
}

function useKeyMissing(needed) {
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!needed) { setMissing(false); return undefined }
    const abort = new AbortController()
    get('key', {}, abort.signal).then(value => { if (!abort.signal.aborted) setMissing(value?.configured === false) }).catch(() => {})
    return () => abort.abort()
  }, [needed])
  return missing
}

const makePlanError = error => error?.message === 'VERSION_CONFLICT'
  ? t('章节在制作方案生成后被修改过，请让 AI 重新生成制作方案。') : explain(error)

export function ProposalConfirm(props) {
  return props.proposal?.kind === 'make' ? <MakeConfirm {...props}/> : <TextConfirm {...props}/>
}

// A production batch: confirm or dismiss as a whole; the chapter list is only
// shown. A chapter edited since the proposal fails the confirmation, and the AI
// has to make a new batch.
function MakeConfirm({ proposal, session, actions, onSettled }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const summary = makeSummary(proposal)
  const hosted = useHostedPlan({ enabled: summary.usesAi, session, id: proposal.id, actions, formatError: makePlanError })
  const model = modelIdentity(hosted.plan?.selection) || (hosted.pending ? t('正在读取制作方案…') : '')
  const requests = hosted.plan?.requests
  async function settle(work) {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError('')
    try {
      const result = await work()
      onSettled?.(result)
    }
    catch (failure) {
      if (alive.current) {
        if (failure?.message === 'MODEL_PLAN_STALE') hosted.expire(failure)
        else setError(deferText(() => makePlanError(failure)))
      }
    }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const hidden = Math.max(0, summary.chapters - summary.titles.length)
  const keyMissing = useKeyMissing(summary.engine === 'LaiVox')
  return <div className="lv-hproposal">
    <div className="lv-hline">
      <span className="lv-hdot" aria-hidden="true"/>
      <span className="lv-hgrow"><span className="lv-htitle">{summary.title}</span>
        <span className="lv-hmeta">{" " + summary.engine + " " + t("· 制作") + " "}{summary.chapters}{" " + t("章 ·") + " "}{summary.mode}</span>
        {summary.engine === 'LaiVox' && <span className="lv-hmeta">{t("LaiVox（推荐 · 增值付费）· 消耗当前 Key 朗读额度 · 约 {v1} 字", { v1: summary.characters })}</span>}
        {summary.usesAi && model && <span className="lv-hmeta">{model}{requests == null ? '' : ' · ' + t('预计 {requests} 次常规请求', { requests })}</span>}</span>
      <span className="lv-hactions">
        <button className="lv-hbtn lv-hprimary" disabled={busy || (summary.usesAi && (!hosted.plan?.confirmation || hosted.pending))} onClick={() => { if (keyMissing) { requestSettings(); return } settle(async () => {
          if (!summary.usesAi) return actions.confirm(session, proposal.id)
          return actions.confirm(session, proposal.id, { confirmation: hosted.plan.confirmation })
        }) }}>{busy ? t('正在加入…') : keyMissing ? t('先连接 LaiVox') : t('确认制作')}</button>
        <button className="lv-hbtn" disabled={busy} onClick={() => settle(() => actions.dismiss(session, proposal.id))}>{t("忽略")}</button>
        <button className="lv-hbtn" disabled={busy} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? t('收起') : t('章节')}<Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={14}/></button>
      </span>
    </div>
    {open && <div className="lv-hexpand">
      <ol className="lv-hlist">{summary.titles.map((title, index) => <li key={index}>{title}</li>)}</ol>
      {hidden > 0 && <span className="lv-hhint">{t("另有") + " "}{hidden}{" " + t("章")}</span>}
      <span className="lv-hhint">{summary.usesAi && hosted.plan
        ? t("会把正文发给 {model}，预计 {requests} 次常规请求，使用 DSH 模型额度。", { model, requests })
        : summary.usesAi ? t('正在读取制作方案…')
        : t("正文发往 {v1} 在线语音，不使用 DSH 模型额度。", { v1: summary.engine })}{t("确认后排在已有任务之后，不打断正在制作的内容。")}</span>
    </div>}
    <PlanNotice hosted={hosted} busy={busy}/>
    {error && <span className="lv-halert" role="alert">{displayText(error)}</span>}
  </div>
}

// A text proposal as one summary line: confirm, dismiss, or open "adjust" to edit
// the text and the AI options. The text is fetched only when "adjust" opens.
function slimSelection(value) {
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  const slim = { provider: value.provider, model: value.model }
  if (value.reasoningEffort === null || typeof value.reasoningEffort === 'string') slim.reasoningEffort = value.reasoningEffort
  return slim
}

function TextConfirm({ proposal, session, actions, onSettled }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(null)
  const [clean, setClean] = useState(proposal.clean === true)
  const [cast, setCast] = useState(proposal.cast === true)
  const [models, setModels] = useState(null)
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    if (!open || text !== null) return undefined
    const controller = new AbortController()
    actions.state(session, proposal.id, controller.signal)
      .then(value => { if (alive.current && typeof value?.text === 'string') setText(value.text) })
      .catch(failure => { if (alive.current && failure?.name !== 'AbortError') setError(deferText(() => explain(failure))) })
    return () => controller.abort()
  }, [open, text, session, proposal.id])
  useEffect(() => {
    if (!open || !(clean || cast) || models) return undefined
    const controller = new AbortController()
    get('models', {}, controller.signal)
      .then(value => { if (!controller.signal.aborted) setModels(Array.isArray(value) ? value : []) })
      .catch(() => { if (!controller.signal.aborted) setModels([]) })
    return () => controller.abort()
  }, [open, clean, cast, models])
  const previewOptions = open
    ? { clean, cast, ...(text !== null ? { text } : {}), ...(picked ? { selection: picked } : {}) }
    : undefined
  const summary = proposalSummary(proposal, previewOptions ?? {})
  const hosted = useHostedPlan({ enabled: summary.usesAi, session, id: proposal.id, options: previewOptions, actions })
  const engineName = proposal.engine === 'laivox' ? 'LaiVox' : 'Edge'
  const pitched = open ? (cast ? 'multi' : 'reading') : (proposal.mode === 'multi' || proposal.cast === true ? 'multi' : 'reading')
  const keyMissing = useKeyMissing(proposal.engine === 'laivox')
  const model = modelIdentity(hosted.plan?.selection) || (hosted.pending ? t('正在读取制作方案…') : '')
  const requests = hosted.plan?.requests
  async function settle(work) {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError('')
    // Not `onSettled?.(await work())`: an absent callback would skip evaluating
    // its argument, and the request would never be sent.
    try {
      const result = await work()
      onSettled?.(result)
    }
    catch (failure) {
      if (alive.current) {
        if (failure?.message === 'MODEL_PLAN_STALE') hosted.expire(failure)
        else setError(deferText(() => explain(failure)))
      }
    }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }
  const confirm = () => settle(async () => {
    if (!summary.usesAi) return actions.confirm(session, proposal.id, previewOptions)
    return actions.confirm(session, proposal.id, { ...(previewOptions ?? {}), confirmation: hosted.plan.confirmation })
  })
  const dismiss = () => settle(() => actions.dismiss(session, proposal.id))
  return <div className="lv-hproposal">
    <div className="lv-hline">
      <span className="lv-hdot" aria-hidden="true"/>
      <span className="lv-hgrow"><span className="lv-htitle">{summary.title}</span>
        <span className="lv-hmeta"> · {engineName} · {summary.characters.toLocaleString()}{" " + t("字 ·") + " "}{summary.mode}</span>
        {proposal.engine === 'laivox' && <span className="lv-hmeta">{pitched === 'multi' ? t('推荐使用 LaiVox（增值付费）：按每句语气拟人演绎，消耗当前 Key 朗读额度') : t('推荐使用 LaiVox（增值付费）：拟人自然朗读，消耗当前 Key 朗读额度')}</span>}
        {summary.usesAi && model && <span className="lv-hmeta">{model}{requests == null ? '' : ' · ' + t('预计 {requests} 次常规请求', { requests })}</span>}</span>
      <span className="lv-hactions">
        <button className="lv-hbtn lv-hprimary" disabled={busy || (open && text !== null && !text.trim()) || (summary.usesAi && (!hosted.plan?.confirmation || hosted.pending))} onClick={() => { if (keyMissing) { requestSettings(); return } confirm() }}>{busy ? t('正在加入…') : keyMissing ? t('先连接 LaiVox') : t('确认生成')}</button>
        <button className="lv-hbtn" disabled={busy} onClick={dismiss}>{t("忽略")}</button>
        <button className="lv-hbtn" disabled={busy} aria-expanded={open} onClick={() => setOpen(value => !value)}>
          {open ? t('收起') : t('调整')}<Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={14}/></button>
      </span>
    </div>
    {open && <div className="lv-hexpand">
      {text === null && !error ? <span className="lv-hhint">{t("正在读取正文…")}</span>
        : <textarea aria-label={t("确认要朗读的正文")} disabled={busy} rows={3} value={text ?? ''} onChange={event => setText(event.target.value)}/>}
      <small>{t('正在确认的是上面看到的正文。')}</small>
      <div>
        <label><input type="checkbox" disabled={busy} checked={clean} onChange={event => setClean(event.target.checked)}/>{" " + t("AI 清洗")}</label>
        <label><input type="checkbox" disabled={busy} checked={cast} onChange={event => setCast(event.target.checked)}/>{" " + t("AI 编剧（多角色）")}</label>
      </div>
      {(clean || cast) && models?.length > 0 && <ModelOptions models={models} selection={picked ?? proposal.selection} disabled={busy} onChange={value => setPicked(slimSelection(value))}/>}
      {proposal.engine !== 'laivox' && cast && <span className="lv-hhint">{t("当前为 Edge 在线语音，暂不支持逐句语气演绎；可在工作台改用 LaiVox（推荐 · 增值付费）。")}</span>}
      <span className="lv-hhint">{summary.usesAi && hosted.plan
        ? t("开启 AI 时会把正文发给 {model}，预计 {requests} 次常规请求，使用 DSH 模型额度。", { model, requests })
        : summary.usesAi ? t('正在读取制作方案…')
        : t("确认后正文发往 {v1} 在线语音，不使用 DSH 模型额度。", { v1: proposal.engine === 'laivox' ? 'LaiVox' : 'Edge' })}</span>
    </div>}
    <PlanNotice hosted={hosted} busy={busy}/>
    {error && <span className="lv-halert" role="alert">{displayText(error)}</span>}
  </div>
}
