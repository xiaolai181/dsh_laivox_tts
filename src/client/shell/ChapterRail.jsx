import React from 'react'
import { displayText, translate as t } from '../i18n/locale.mjs'
export function ChapterRail({ chapter, chapters, query, changeQuery, navigate, create }) {
  return <aside className="lv-chapter-rail" aria-label={t('章节目录')}>
    <div className="lv-heading"><h2>{t('章节目录')}</h2>{create && <button onClick={create} aria-label={t('添加章节')} title={t('添加章节')}>＋</button>}</div>
    <input data-lv-chapter-search aria-label={t('搜索章节')} placeholder={t('搜索章节')} value={query} onChange={event => changeQuery(event.target.value)}/>
    {chapters.error && <p role="alert">{displayText(chapters.error)}<button onClick={chapters.reload}>{t('重试')}</button></p>}
    <div className="lv-rail-list">{chapters.value?.map(row => {
      const paused = row.jobState === 'paused'
      const state = paused && row.jobAutoResume ? '自动重试中' : paused && row.jobPause ? '需处理' : paused && row.jobError ? '失败' : ['running','queued'].includes(row.jobState) ? '合成中' : paused ? '已暂停' : row.hasAudio ? '可收听' : '无音频'
      return <button key={row.id} aria-current={row.id === chapter?.id ? 'true' : undefined} aria-label={row.title + ' ' + t(state)} onClick={() => navigate(row.id)}>
        <span className="lv-ordinal">{String(row.ordinal).padStart(2,'0')}</span><span>{row.title}</span><i className="lv-chapter-dot" title={t(state)} data-state={state}/></button>
    })}</div>
    <div className="lv-inline">{chapters.previous && <button onClick={chapters.previous}>{t('上一页')}</button>}{chapters.next && <button onClick={chapters.next}>{t('下一页')}</button>}</div>
  </aside>
}
