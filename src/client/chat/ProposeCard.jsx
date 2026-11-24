import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { explain } from '../api.mjs'
import { proposeView } from './proposeCard.mjs'
import { finalLine } from './proposalConfirm.mjs'
import { ProposalConfirm } from './ProposalConfirm.jsx'

// The laivox_propose tool card. While the proposal is pending (read from the same
// session feed as the dock) it is confirmed right here; once handled — here, in
// the dock, or by /laivox confirm — it becomes one quiet line.
// `noun` names what the tool creates (a reading proposal, or a production batch).
export function ProposeCard({ phase, block, sessionId, feed, actions, open, noun = t('朗读确认') }) {
  const view = proposeView({ phase, block })
  const id = view.kind === 'summary' || view.kind === 'id' ? view.id : null
  const subscribe = useCallback(listener => feed.subscribe(sessionId, listener), [feed, sessionId])
  const snapshotOf = useCallback(() => feed.getSnapshot(sessionId), [feed, sessionId])
  const snapshot = useSyncExternalStore(subscribe, snapshotOf)
  const pending = id ? snapshot?.proposals?.find(item => item.id === id) : null
  const [final, setFinal] = useState(null)
  const [failure, setFailure] = useState('')
  const [attempt, setAttempt] = useState(0)
  const needsState = Boolean(id && sessionId && snapshot && !pending)
  useEffect(() => {
    if (!needsState) return undefined
    const controller = new AbortController()
    setFailure('')
    actions.state(sessionId, id, controller.signal).then(value => setFinal(value)).catch(error => {
      if (error?.name === 'AbortError') return
      // An unknown id (another session, or a proposal created before this
      // version) simply stays as the tool's own summary.
      if (error?.message === 'PROPOSAL_NOT_FOUND') setFinal({ state: 'unknown' })
      else setFailure(deferText(() => explain(error)))
    })
    return () => controller.abort()
  }, [needsState, id, sessionId, attempt])
  const line = (body) => <div className="lv-host lv-htool"><div className="lv-hline">{body}</div></div>
  if (view.kind === 'preparing') return line(<span className="lv-hmeta">{t('正在创建{noun}…', { noun })}</span>)
  if (view.kind === 'unavailable') return line(<span className="lv-halert" role="alert">{t('未收到可确认的{noun}，请查看工具结果后重试。', { noun })}</span>)
  if (pending) return <div className="lv-host lv-htool"><ProposalConfirm key={pending.id} proposal={pending} session={sessionId} actions={actions}/></div>
  // Right after the tool returns, the feed may not list the new proposal yet; the
  // state read already says it is pending, so offer the buttons now.
  if (final?.state === 'pending') return <div className="lv-host lv-htool"><ProposalConfirm key={final.id} proposal={final} session={sessionId} actions={actions}
    onSettled={() => { setFinal(null); setAttempt(value => value + 1) }}/></div>
  const done = finalLine(final)
  const title = done?.title || view.title || t('朗读确认')
  if (final?.state === 'accepted') return line(<>
    <span className="lv-hgrow"><span className="lv-hmeta">{t("已加入队列 ·") + " "}</span>《{title}》</span>
    {done.chapter && <span className="lv-hactions"><button className="lv-hbtn" onClick={() => open(done.chapter, done.job)}>{t("打开")}</button></span>}
  </>)
  if (final?.state === 'dismissed') return line(<span className="lv-hmeta">{t('已忽略 ·《{title}》', { title })}</span>)
  if (failure) return line(<><span className="lv-hgrow lv-herror" role="alert">{t("无法读取提案状态 ·") + " "}{displayText(failure)}</span>
    <span className="lv-hactions"><button className="lv-hbtn" onClick={() => setAttempt(value => value + 1)}>{t("重试")}</button></span></>)
  return line(<span className="lv-hgrow"><span className="lv-htitle">{title}</span>
    {Number.isInteger(view.characters) && <span className="lv-hmeta"> · {view.characters.toLocaleString()}{" " + t("字")}</span>}
    {!snapshot && <span className="lv-hmeta">{" " + t("· 正在读取状态…")}</span>}</span>)
}
