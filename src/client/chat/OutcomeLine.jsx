import { translate as t } from '../i18n/locale.mjs'
import React from 'react'
import { readingName } from './dockModel.mjs'
import { ListenButton } from './ListenButton.jsx'

// The last finished or cancelled reading of this conversation, as one quiet line.
export function OutcomeLine({ job, open, listen, player, manage }) {
  if (!job) return null
  const name = readingName(job)
  const done = job.state === 'completed'
  const playable = done && job.purpose === 'generate'
  const status = done ? ({ clean: t('清洗完成'), cast: t('编剧完成') }[job.purpose] ?? t('朗读已生成')) : t('已取消')
  return <div className="lv-hline" aria-label={t("朗读结果")}>
    <span className="lv-hgrow"><span className="lv-hmeta">{status}{Boolean(job.isSnippet) && <> · {manage ? <button className="lv-hlink" title={t("在对话片段中管理")} onClick={manage}>{t("对话片段")}</button> : t('对话片段')}</>}</span><span className="lv-hmeta"> · </span><span>{name}</span></span>
    <span className="lv-hactions">
      {playable && <ListenButton key={job.id} chapter={job.chapter} job={job.id} {...{ player, listen }}/>}
      <button className="lv-hbtn" onClick={() => open(job.chapter, playable ? job.id : null)}>{t("打开章节")}</button>
      {job.nextId && <button className="lv-hbtn" onClick={() => open(job.nextId, null)}>{t("打开下一章")}</button>}
    </span>
  </div>
}
