import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { explain, get, post } from '../api.mjs'
import { Icon } from '../components/Icon.jsx'
import { clearLastChapter, lastChapter } from '../workbench/state.mjs'
import { dockDismissed, dockHeadline, dockKeys, dockView, formatOffset, jobLine, readingName } from './dockModel.mjs'
import { ListenButton } from './ListenButton.jsx'
import { ProposalConfirm } from './ProposalConfirm.jsx'

const SHOWN_JOBS = 3

function JobRow({ job, open, resume, busy, now }) {
  const line = jobLine(job, explain, now)
  return <div className="lv-hdock-row">
    <div className="lv-hgrow">
      <span>{line.name}</span><span className={line.error ? 'lv-hmeta lv-herror' : 'lv-hmeta'}> · {[line.status, ...line.detail].join(' · ')}</span>
      {line.percent !== null && <div className="lv-hprogress" role="progressbar" aria-label={t("制作进度")} aria-valuenow={line.percent} aria-valuemin={0} aria-valuemax={100}><i style={{ width: line.percent + '%' }}/></div>}
    </div>
    <span className="lv-hactions">
      {job.state === 'paused' && <button className="lv-hbtn" disabled={busy} onClick={() => resume(job.id)}>{t("继续制作")}</button>}
      <button className="lv-hbtn" onClick={() => open(job.chapter, job.purpose === 'generate' ? job.id : null)}>{t("打开")}</button>
    </span>
  </div>
}

// The dock above the composer: one line by default (the host's own docks use the
// same geometry), expanded in place to confirm proposals and follow jobs.
// mode (setting): 'auto' also offers "continue listening"; 'active' only for
// proposals, imports and jobs; 'never' hides the bar. × hides what is on it now.
export function NovelDock({ session, open, openWorkbench, manage, preview, listen, player, feed, actions, mode = 'auto', dismissals }) {
  const subscribe = useCallback(listener => feed.subscribe(session, listener), [feed, session])
  const snapshotOf = useCallback(() => feed.getSnapshot(session), [feed, session])
  const snapshot = useSyncExternalStore(subscribe, snapshotOf)
  const playback = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const [resume, setResume] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [, setClosed] = useState(0)
  const actionInFlight = React.useRef(false)
  const live = playback.chapter && playback.title ? playback : null
  const view = dockView({ ...snapshot, resume: live?.job || mode !== 'auto' ? null : resume, error })
  const idle = mode === 'auto' && Boolean(snapshot) && !(snapshot.jobs?.length) && !(snapshot.proposals?.length) && !(snapshot.imports?.length) && !live
  useEffect(() => {
    if (!idle) return undefined
    const id = lastChapter()
    if (!id) { setResume(null); return undefined }
    const controller = new AbortController()
    let current = true
    get('chapter/resume', { id }, controller.signal).then(value => { if (current) setResume(value) }).catch(failure => {
      if (!current || failure?.name === 'AbortError') return
      if (failure?.status === 404) { clearLastChapter(); if (current) setResume(null) }
    })
    return () => { current = false; controller.abort() }
  }, [idle, session])
  // A failure message belongs to the state it was about; a new snapshot clears it.
  useEffect(() => { setError('') }, [snapshot])
  const counting = view.jobs.some(job => job.state === 'paused' && Number.isFinite(job.autoResume?.at))
  useEffect(() => {
    if (!counting) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [counting])
  async function settle(work) {
    if (actionInFlight.current) return
    actionInFlight.current = true
    setBusy(true); setError('')
    feed.beginAction(session)
    try { await work() }
    catch (failure) { setError(deferText(() => explain(failure))) }
    finally { feed.endAction(session); actionInFlight.current = false; setBusy(false) }
  }
  const resumeJob = id => settle(async () => {
    await post('jobs/action', { id, action: 'resume' })
    feed.replace(session, await get('session', { id: session }))
  })
  if (!snapshot || mode === 'never') return null
  const glyph = <span className="lv-hglyph"><Icon name="AudioLines" size={16}/></span>
  const close = keys => () => { dismissals?.set(session, keys); setClosed(value => value + 1) }
  const shell = (head, body, keys) => <div className="lv-host lv-hdock" role="region" aria-label={t("小说配音（LaiVox）")}>
    <div className="lv-hdock-panel"><div className="lv-hdock-head">{head}
      {dismissals && <button className="lv-hbtn lv-hclose" aria-label={t("隐藏 LaiVox 栏")} title={t("隐藏，有新的待确认或新任务时再出现")} onClick={close(keys)}><Icon name="X" size={14}/></button>}
    </div>{body}</div></div>
  if (snapshot.unreachable) return dockDismissed(['unreachable'], dismissals?.get(session)) ? null : shell(<>{glyph}<span className="lv-hdock-count">LaiVox · <span className="lv-hmeta">{t("暂时连不上插件")}</span></span>
    <button className="lv-hbtn" onClick={() => feed.retry(session)}>{t("重试")}</button></>, null, ['unreachable'])
  if (view.empty) return null
  const keys = dockKeys(view)
  if (dockDismissed(keys, dismissals?.get(session))) return null
  if (view.resume) {
    const clock = formatOffset(view.resume.offset)
    const segment = Number.isInteger(view.resume.n) ? t("第 {v1} 段", { v1: view.resume.n + 1 }) : ''
    return shell(<>{glyph}<span className="lv-hdock-count">{t("继续听") + " "}<span>{readingName(view.resume)}</span>
      {(segment || clock) && <span className="lv-hmeta"> {segment}{segment && clock ? ' · ' : ''}{clock && <span className="lv-htime">{clock}</span>}</span>}</span>
      <ListenButton key={view.resume.id + ':' + view.resume.job} chapter={view.resume.id} job={view.resume.job} label={t("继续听")} {...{ player, listen }}/></>, null, keys)
  }
  const headline = dockHeadline(view)
  const hidden = view.jobs.length - SHOWN_JOBS + (Number.isInteger(snapshot.overflow) ? snapshot.overflow : 0)
  return shell(<>
    {glyph}
    <span className="lv-hdock-count">LaiVox · {headline.text}{headline.percent !== null && <span className="lv-hmeta"> {headline.percent}%</span>}</span>
    <button className="lv-hbtn" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? t('收起') : t('查看')}
      <Icon name={expanded ? 'ChevronUp' : 'ChevronDown'} size={14}/></button>
  </>, <>
    {expanded && <div className="lv-hdock-body">
      {view.proposals.map(proposal => <div className="lv-hdock-row" key={proposal.id}>
        <div className="lv-hgrow"><ProposalConfirm proposal={proposal} session={session} actions={actions}/></div></div>)}
      {view.imports.map(item => <div className="lv-hdock-row" key={item.id}>
        <span className="lv-hgrow">{item.title} <span className="lv-hmeta">{t("· 导入预览")}</span></span>
        <span className="lv-hactions"><button className="lv-hbtn" onClick={() => preview(item.id, session)}>{t("打开预览")}</button></span></div>)}
      {view.jobs.slice(0, SHOWN_JOBS).map(job => <JobRow key={job.id} job={job} open={open} busy={busy} resume={resumeJob} now={now}/>)}
      {manage && view.jobs.some(job => job.isSnippet) && <div className="lv-hdock-row"><span className="lv-hgrow lv-hmeta">{t("朗读结果保存在对话片段里")}</span>
        <span className="lv-hactions"><button className="lv-hbtn" onClick={manage}>{t("在对话片段中管理")}</button></span></div>}
      {hidden > 0 && <div className="lv-hdock-row"><span className="lv-hgrow lv-hmeta">{t("还有") + " "}{hidden}{" " + t("章")}</span>
        <span className="lv-hactions"><button className="lv-hbtn" onClick={openWorkbench}>{t("在工作台查看")}</button></span></div>}
    </div>}
    {error && <div className="lv-hdock-row"><span className="lv-halert" role="alert">{displayText(error)}</span></div>}
  </>, keys)
}
