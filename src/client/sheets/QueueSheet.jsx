import { displayText, translate as t } from '../i18n/locale.mjs'
import React from 'react'
import { Icon } from '../components/Icon.jsx'
import { Popover } from '../components/Popover.jsx'
import { JobProgress, jobActive } from '../jobs/JobProgress.jsx'
import { useQueue } from '../jobs/useQueue.mjs'

const GROUPS = [['running', '进行中'], ['queued', '等待'], ['paused', '已暂停']]
const PURPOSE = { clean: '清洗', cast: '编剧', generate: '生成' }

function JobRow({ job, pending, run, open }) {
  const name = t(PURPOSE[job.purpose] ?? '生成')
  const paused = job.state === 'paused'
  const actionLabel = paused ? t('继续{purpose}', { purpose: name }) : t('暂停{purpose}', { purpose: name })
  return <article className="lv-queue-row" data-state={job.state}>
    <span className="lv-status-dot" aria-hidden="true"/>
    <div className="lv-queue-main">
      <button type="button" className="lv-link lv-queue-title" title={job.title} onClick={() => open(job.chapter, job.purpose === 'generate' ? job.id : null)}>
        {job.bookTitle && <span>{job.bookTitle} · </span>}{job.title ?? t('章节')}</button>
      <JobProgress job={job} actionPending={pending}/>
    </div>
    {jobActive(job) && <div className="lv-queue-actions">
      <button type="button" className="lv-icon-button" disabled={Boolean(pending)} aria-label={actionLabel} title={actionLabel}
        onClick={() => run(job.id, paused ? 'resume' : 'pause')}><Icon name={paused ? 'Play' : 'Pause'}/></button>
      <button type="button" className="lv-icon-button" disabled={Boolean(pending)} aria-label={t("取消任务")} title={t("取消任务")} onClick={() => run(job.id, 'cancel')}><Icon name="X"/></button>
    </div>}
  </article>
}

// Compact task list in the side sheet: what is running, waiting and paused,
// with finished jobs folded away. Bulk actions live in the ⋯ menu.
export function QueueSheet({ scope, clearScope, actions, run, open, refreshKey, decide, notify, openStorage }) {
  const q = useQueue({ scope, refreshKey, decide, notify })
  const jobs = q.data?.jobs ?? []
  const finished = jobs.filter(job => !jobActive(job))
  return <section className="lv-queue" aria-label={t("制作任务")}>
    <div className="lv-queue-bar">
      {scope ? <span className="lv-queue-scope">{scope.chapter ? t('只看本章') : t('只看本书')}<button type="button" className="lv-link" disabled={Boolean(q.bulk)} onClick={clearScope}>{t("显示全部")}</button></span>
        : <small>{t('{running} 个进行中 · {paused} 个已暂停', { running: (q.counts.running ?? 0) + (q.counts.queued ?? 0), paused: q.counts.paused ?? 0 })}</small>}
      <Popover label={t("批量操作")} trigger={<Icon name="Ellipsis"/>} placement="bottom-end" className="lv-icon-button">
        {close => <div className="lv-menu lv-queue-bulk">
          {[['pause', t('全部暂停')], ['resume', t('全部继续')], ['cancel', t('全部取消')]].map(([mode, label]) =>
            <button key={mode} type="button" disabled={Boolean(q.bulk) || !q.applicable(mode)} onClick={() => { close(); void q.bulkRun(mode) }}>{label}（{q.applicable(mode)}）</button>)}
        </div>}
      </Popover>
    </div>
    {q.bulk && <small role="status">{t("正在处理…")}</small>}
    {jobs.some(job => job.error === 'AUDIO_LIMIT') && <p className="lv-queue-note" role="status">{t("有任务因音频空间不足暂停。清理音频后可在 ⋯ 里全部继续。")}{openStorage && <button type="button" className="lv-link" onClick={openStorage}>{t("清理旧版音频")}</button>}</p>}
    {q.error && <p role="alert" className="lv-error">{displayText(q.error)} <button type="button" onClick={q.reload}>{t("重新加载")}</button></p>}
    {!q.data && !q.error && <p role="status">{t("正在读取任务…")}</p>}
    {q.data?.total === 0 && <p className="lv-muted">{t("这里还没有任务。打开一章，在制作条上开始制作。")}</p>}
    {GROUPS.map(([id, label]) => {
      const rows = jobs.filter(job => job.state === id)
      if (!rows.length) return null
      return <section className="lv-queue-group" key={id}><h3>{t(label)} <small>{rows.length}</small></h3>
        {rows.map(job => <JobRow key={job.id} job={job} pending={actions.get(job.id)} run={run} open={open}/>)}</section>
    })}
    {finished.length > 0 && <details className="lv-queue-group lv-queue-finished"><summary>{t("最近完成") + " "}<small>{finished.length}</small></summary>
      {finished.map(job => <JobRow key={job.id} job={job} pending={actions.get(job.id)} run={run} open={open}/>)}</details>}
    {q.page && <div className="lv-heading lv-page-nav"><button type="button" disabled={!q.page.previous} onClick={q.page.previous}>{t("上一页")}</button>
      <small>{q.page.index} / {q.page.count}</small>
      <button type="button" disabled={!q.page.next} onClick={q.page.next}>{t("下一页")}</button></div>}
  </section>
}
