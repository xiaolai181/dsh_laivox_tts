import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { explain, get, post } from '../api.mjs'
import { addChaptersView, exportCardView, gotoCardView, importFileView } from './libraryCards.mjs'
import { downloadsSnapshot, startBookExportDownload, subscribeDownloads } from '../workbench/downloads.mjs'

const line = body => <div className="lv-host lv-htool"><div className="lv-hline">{body}</div></div>

// laivox_add_chapters: free and immediate, so one quiet result line.
export function AddChaptersCard({ phase, block, open }) {
  const view = addChaptersView({ phase, block })
  if (view.kind === 'running') return line(<span className="lv-hmeta">{t("正在添加章节…")}</span>)
  if (view.kind === 'failed') return line(<span className="lv-halert" role="alert">{t("章节没有添加")}{view.detail ? '：' + view.detail : '。'}</span>)
  return line(<>
    <span className="lv-hgrow"><span className="lv-hmeta">{t("已添加") + " "}{view.count}{" " + t("章到")}</span> 《{view.title}》{view.skipped > 0 && <span className="lv-hmeta">{" " + t("· 跳过") + " "}{view.skipped}{" " + t("章重复")}</span>}</span>
    <span className="lv-hactions">{view.first && <button className="lv-hbtn" onClick={() => open(view.first, null)}>{t("打开")}</button>}</span>
  </>)
}

// An import preview the user can bring onto the shelf in one click: on the
// laivox_import_file card and under the reply (the card folds away once the
// turn ends). Both read the same draft; importing or discarding it in either
// place, or in the workbench, settles the other.
export function ImportConfirm({ id, session, title, chapters, feed, openBook, preview }) {
  const subscribe = useCallback(listener => feed.subscribe(session, listener), [feed, session])
  const snapshotOf = useCallback(() => feed.getSnapshot(session), [feed, session])
  const board = useSyncExternalStore(subscribe, snapshotOf)
  const listed = Boolean(board?.imports?.some(item => item.id === id))
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [duplicate, setDuplicate] = useState(null)
  const pending = useRef(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  // Not in the session's draft list (any more): ask where it stands.
  useEffect(() => {
    if (listed || !board) return undefined
    const controller = new AbortController()
    get('import/state', { id, session }, controller.signal).then(value => { if (alive.current) setState(value) }).catch(() => {})
    return () => controller.abort()
  }, [listed, Boolean(board), id, session])
  async function publish(force = false) {
    if (pending.current) return
    pending.current = true
    setBusy(true); setError('')
    feed.beginAction?.(session)
    try {
      const draft = await get('import/preview', { id, session })
      const result = await post('import/action', { id, session, action: 'publish', revision: draft.revision, duplicate: force,
        chapters: draft.chapters.map((_, index) => index) })
      if (result?.duplicate) { if (alive.current) setDuplicate(result.duplicate); return }
      if (alive.current) { setDuplicate(null); setState({ state: 'published', book: result.id, title: draft.title }) }
      feed.replace?.(session, await get('session', { id: session }))
    } catch (failure) {
      if (!alive.current) return
      if (failure?.message === 'IMPORT_NOT_FOUND') setState(await get('import/state', { id, session }).catch(() => ({ state: 'gone' })))
      else setError(deferText(() => failure?.message === 'VERSION_CONFLICT' ? t('预览刚在工作台里改过，请再点一次导入。') : explain(failure)))
    } finally {
      feed.endAction?.(session)
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  const name = state?.title ?? title
  if (state?.state === 'published') {
    return <div className="lv-hline"><span className="lv-hgrow"><span className="lv-hmeta">{t("已导入")}</span> 《{name}》</span>
      <span className="lv-hactions"><button className="lv-hbtn" onClick={() => openBook(state.book)}>{t("打开")}</button></span></div>
  }
  if (state?.state === 'gone' && !listed) return <div className="lv-hline"><span className="lv-hmeta">{t("这条导入预览已丢弃或过期。")}</span></div>
  return <div className="lv-hproposal">
    <div className="lv-hline">
      <span className="lv-hdot" aria-hidden="true"/>
      <span className="lv-hgrow"><span className="lv-htitle">《{name}》</span>
        <span className="lv-hmeta">{" " + t("· 导入预览")}{Number.isFinite(chapters) ? t(" · {v1} 章", { v1: chapters }) : ''}</span></span>
      <span className="lv-hactions">
        {duplicate
          ? <><button className="lv-hbtn" disabled={busy} onClick={() => openBook(duplicate)}>{t("打开已有书")}</button>
            <button className="lv-hbtn" disabled={busy} onClick={() => void publish(true)}>{t("仍然导入")}</button></>
          : <button className="lv-hbtn lv-hprimary" disabled={busy} onClick={() => void publish(false)}>{busy ? t('正在导入…') : t('导入')}</button>}
        <button className="lv-hbtn" disabled={busy} onClick={() => preview(id, session)}>{t("在工作台预览")}</button>
      </span>
    </div>
    {duplicate && <span className="lv-hhint">{t("书架里已有同一个文件导入的书。")}</span>}
    {error && <span className="lv-halert" role="alert">{displayText(error)}</span>}
  </div>
}

// laivox_import_file: the staged preview, imported right here.
export function ImportCard({ phase, block, sessionId, feed, openBook, preview }) {
  const view = importFileView({ phase, block })
  if (view.kind === 'running') return line(<span className="lv-hmeta">{t("正在读取文件并分章…")}</span>)
  if (view.kind === 'failed') return line(<span className="lv-halert" role="alert">{t("文件没有导入")}{view.detail ? '：' + view.detail : '。'}</span>)
  return <div className="lv-host lv-htool"><ImportConfirm id={view.id} session={sessionId} title={view.title} chapters={view.chapters}
    feed={feed} openBook={openBook} preview={preview}/></div>
}

export function ExportCard({ phase, block, openBook }) {
  const view = exportCardView({ phase, block })
  const downloads = useSyncExternalStore(subscribeDownloads, downloadsSnapshot)
  const [notice, setNotice] = useState('')
  if (view.kind === 'running') return line(<span className="lv-hmeta">{t("正在计算导出内容与时长…")}</span>)
  if (view.kind === 'failed') return line(<span className="lv-halert" role="alert">{t("无法生成导出单")}{view.detail ? '：' + view.detail : '。'}</span>)
  const format = view.params.format === 'wav' ? 'wav' : 'mp3'
  const mode = view.params.mode === 'single' ? 'single' : 'zip'
  const entry = downloads.get('book:' + view.book + ':' + mode + ':' + format)
  const preparing = entry?.phase === 'preparing'
  return line(<>
    <span className="lv-hgrow">
      <span className="lv-htitle">《{view.title}》</span>
      <span className="lv-hmeta">{" " + t("· {ready}/{total} 章 · 约 {mins} 分钟", { ready: view.readyCount, total: view.totalChapters, mins: view.minutes })}</span>
      {notice && <span className="lv-hmeta">{" · "}{displayText(notice)}</span>}
    </span>
    <span className="lv-hactions">
      {preparing
        ? <button className="lv-hbtn" onClick={() => entry.cancel()}>{t("取消")}{entry.total ? ` (${entry.done}/${entry.total})` : ''}</button>
        : <button className="lv-hbtn lv-hprimary" onClick={() => void startBookExportDownload({ book: view.book, title: view.title, params: view.params, notify: setNotice })}>{t("开始下载")}</button>}
      <button className="lv-hbtn" onClick={() => openBook(view.book)}>{t("打开")}</button>
    </span>
  </>)
}

export function GotoCard({ phase, block, open }) {
  const view = gotoCardView({ phase, block })
  if (view.kind === 'running') return line(<span className="lv-hmeta">{t("正在定位章节…")}</span>)
  if (view.kind === 'failed') return line(<span className="lv-halert" role="alert">{t("无法定位章节")}{view.detail ? '：' + view.detail : '。'}</span>)
  return line(<>
    <span className="lv-hgrow">
      <span className="lv-htitle">《{view.bookTitle}》</span>
      <span className="lv-hmeta">{" · "}{t("第 {v1} 章", { v1: view.ordinal })}{" · "}{view.chapterTitle}</span>
      {view.preview && <span className="lv-hmeta">{" · "}{view.preview}</span>}
    </span>
    <span className="lv-hactions">
      <button className="lv-hbtn lv-hprimary" onClick={() => open(view.chapter, view.start)}>{t("打开这一章并定位")}</button>
    </span>
  </>)
}
