import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState } from 'react'
import { explain, formatBytes, get, post } from '../api.mjs'
import { roleColor } from '../stage/roleColor.mjs'
import { Popover } from '../components/Popover.jsx'
import { Icon } from '../components/Icon.jsx'
import { StorageUsage } from '../components/Metrics.jsx'
import { rovingIndex } from '../studio/roving.mjs'
import { ChapterReview, cutLabels } from './ChapterReview.jsx'
import { nextShelfDetailOnResize } from './shelfLayout.mjs'

function exportText(state) {
  if (!state) return ''
  if (state.state === 'running') return t("正在导出 {v1}/{v2} 章（{v3}）", { v1: Number(state.done) || 0, v2: Number(state.total) || 0, v3: formatBytes(state.bytes) })
  if (state.state === 'done') return t("导出完成 · {v1}", { v1: formatBytes(state.bytes) })
  if (state.state === 'cancelled') return t('导出已取消')
  return t("导出失败{v1}", { v1: state.error ? '：' + displayText(state.error) : '' })
}

const chapterKey = chapter => chapter.offset + ':' + chapter.count
const EXPORT_PREFS_KEY = 'lv-export-prefs'
const DEFAULT_EXPORT_PREFS = { format: 'mp3', mode: 'zip', subtitles: 'srt', speakers: true }

function loadExportPrefs() {
  try {
    const raw = globalThis.localStorage?.getItem?.(EXPORT_PREFS_KEY)
    if (!raw) return DEFAULT_EXPORT_PREFS
    const parsed = JSON.parse(raw)
    return {
      format: parsed?.format === 'wav' ? 'wav' : 'mp3',
      mode: parsed?.mode === 'single' ? 'single' : 'zip',
      subtitles: ['none', 'srt', 'lrc', 'both'].includes(parsed?.subtitles) ? parsed.subtitles : 'srt',
      speakers: parsed?.speakers !== false,
    }
  } catch { return DEFAULT_EXPORT_PREFS }
}

function saveExportPrefs(cfg) {
  try {
    globalThis.localStorage?.setItem?.(EXPORT_PREFS_KEY, JSON.stringify({
      format: cfg.format,
      mode: cfg.mode,
      subtitles: cfg.subtitles,
      speakers: cfg.speakers,
    }))
  } catch { /* ignore storage restrictions */ }
}

export function ImportPreview({ entry, close, openBook, refresh, published, decide }) {
  const [data, setData] = useState(entry.data)
  const [exclude, setExclude] = useState(new Set())
  const dataRef = useRef(data)
  const excludeRef = useRef(exclude)
  dataRef.current = data
  excludeRef.current = exclude
  const [duplicate, setDuplicate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [reviewCanLeave, setReviewCanLeave] = useState(false)
  const [message, setMessage] = useState('')
  const [encoding, setEncoding] = useState(data.encoding)
  const [split, setSplit] = useState(data.split)
  const [page, setPage] = useState(0)
  const [focused, setFocused] = useState(null)
  const pending = useRef(false)

  function updateExclude(next) {
    excludeRef.current = next
    setExclude(next)
  }

  function update(next) {
    const previous = dataRef.current
    const prevExclude = excludeRef.current
    dataRef.current = next
    setData(next)
    if (next.revision !== previous.revision) {
      setPage(0)
      if (next.encoding !== previous.encoding) {
        updateExclude(new Set())
        if (prevExclude.size > 0) setMessage(deferText(() => t('编码已切换，请重新确认要跳过的章节。')))
      } else {
        const nextKeys = new Set((next.chapters ?? []).map(chapterKey))
        const kept = new Set([...prevExclude].filter(key => nextKeys.has(key)))
        updateExclude(kept)
        if (kept.size < prevExclude.size) setMessage(deferText(() => t('部分章节范围已变动，请确认待导入列表。')))
      }
      setDuplicate(null)
      setFocused(null)
    }
  }

  async function reloadPreview() {
    const result = await get('import/preview', { id: data.id, session: entry.session })
    update(result)
    return result
  }

  async function perform(action, fields) {
    if (pending.current || busy) return
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      const result = await post('import/action', { id: data.id, session: entry.session, action, ...fields })
      if (action === 'reparse') {
        update(result); setFocused(null)
      } else if (action === 'discard') {
        close(); refresh()
      } else if (result.duplicate) setDuplicate(result.duplicate)
      else { close(); refresh(); published?.(); await openBook(result.id) }
    } catch (error) {
      if (error.message === 'VERSION_CONFLICT') {
        try { await reloadPreview(); setMessage(deferText(() => t('预览已更新，请确认后再导入。'))) }
        catch (reloadError) { setMessage(deferText(() => explain(reloadError))) }
      } else setMessage(deferText(() => explain(error)))
    }
    finally { pending.current = false; setBusy(false) }
  }

  const selectedOrdinals = data.chapters.flatMap((chapter, i) => exclude.has(chapterKey(chapter)) ? [] : [i])
  const publish = (force, appendToBook) => perform('publish', {
    revision: data.revision,
    duplicate: force,
    ...(appendToBook ? { appendToBook } : {}),
    chapters: selectedOrdinals,
  })
  return <section className="lv-preview" aria-label={t("导入预览")}>
    <div className="lv-heading"><div><small className="lv-kicker">{t("导入预览")}</small><h1>{data.title}</h1><small>{data.format.toUpperCase()} · {data.chapters.length}{" " + t("章")}</small></div><button onClick={close} disabled={busy && !reviewCanLeave}>{t("暂存稍后导入")}</button></div>
    <details className="lv-import-advanced" open={focused ? true : undefined}>
      <summary>{t("分章与正文复核")}</summary>
      {data.format === 'txt' && <div className="lv-inline">
      <label>{t("编码") + " "}<select value={encoding} onChange={event => setEncoding(event.target.value)}>{['utf-8','utf-16le','utf-16be','gb18030','big5'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label><input type="checkbox" checked={split} onChange={e => setSplit(e.target.checked)}/>{" " + t("自动分章")}</label>
      <button disabled={busy} onClick={() => perform('reparse', { encoding, split })}>{t("更新预览")}</button>
      </div>}
      <ChapterReview data={data} session={entry.session} onUpdate={update} busy={busy} setBusy={setBusy} setReviewCanLeave={setReviewCanLeave} onError={setMessage}
        decide={decide} focused={focused} focus={setFocused} close={() => setFocused(null)}/>
    </details>
    {data.warnings?.includes('EPUB_TOC_FALLBACK') && <small role="status">{t("部分目录与正文不一致，已根据书内结构分章。")}</small>}
    {data.warnings?.includes('PDF_TOC_FALLBACK') && <small role="status">{t("部分目录与正文不一致，已根据排版与标题分章。")}</small>}
    {data.warnings?.includes('PDF_PARTIAL_IMAGE_PAGES') && <small role="status">{t("部分页面未检测到文字（可能是插图或扫描页），已自动跳过。")}</small>}
    {data.splitCount > 0 && <small role="status">{t("有 {v1} 章因超过 10 万字已自动拆分。", { v1: data.splitCount })}</small>}
    <div className="lv-import-grid"><div className="lv-preview-list" aria-label={t("待导入章节")}>
      {data.chapters.slice(page * 80, page * 80 + 80).map(chapter => {
        const key = chapterKey(chapter)
        return <div className="lv-import-item" key={chapter.offset}><input type="checkbox" aria-label={t("导入 {v1}", { v1: chapter.title })} disabled={busy} checked={!exclude.has(key)} onChange={event => {
          const next = new Set(exclude)
          if (event.target.checked) next.delete(key)
          else next.add(key)
          updateExclude(next)
        }}/><button className="lv-link" type="button" disabled={busy} onClick={() => setFocused(chapter)}>{chapter.title}</button>
          <small>{cutLabels[chapter.kind] ? t(cutLabels[chapter.kind]) + ' · ' : ''}{chapter.count.toLocaleString()}{" " + t("字符")}</small>
        </div>
      })}
    </div><blockquote aria-label={t("正文样例")}>{data.sample}</blockquote></div>
    <div className="lv-inline">
      {page > 0 && <button onClick={() => setPage(page - 1)}>{t("前 80 章")}</button>}
      {(page + 1) * 80 < data.chapters.length && <button onClick={() => setPage(page + 1)}>{t("后 80 章")}</button>}
    </div>
    {message && <p role="alert">{displayText(message)}</p>}
    {!duplicate && data.matchedBook && <div className="lv-export" role="status">
      <span>{t("检测到书架已有同源书籍《{title}》（已有 {existing} 章，可追加 {count} 章新内容）", {
        title: data.matchedBook.title,
        existing: data.matchedBook.existingChapters,
        count: data.matchedBook.newChaptersCount,
      })}</span>
    </div>}
    <div className="lv-inline">
      {duplicate ? <><span>{t("书架已有此文件")}</span><button disabled={busy} onClick={() => { close(); void openBook(duplicate) }}>{t("打开已有书")}</button><button disabled={busy} onClick={() => publish(true)}>{t("创建副本")}</button></>
        : data.matchedBook
          ? <>
            <button className="lv-primary" disabled={busy || exclude.size === data.chapters.length} onClick={() => publish(false, data.matchedBook.id)}>{t("追加到《{title}》（保留角色与音频）", { title: data.matchedBook.title })}</button>
            <button disabled={busy || exclude.size === data.chapters.length} onClick={() => publish(false)}>{t("作为新书导入")}</button>
          </>
          : <button className="lv-primary" disabled={busy || exclude.size === data.chapters.length} onClick={() => publish(false)}>{t("导入") + " "}{data.chapters.length - exclude.size}{" " + t("章")}</button>}
      <button disabled={busy} onClick={() => { setMessage(''); reloadPreview().catch(error => setMessage(deferText(() => explain(error)))) }}>{t("重新读取")}</button>
      <button disabled={busy} onClick={() => perform('discard')}>{t("放弃导入")}</button>
    </div>
  </section>
}

function chapterState(chapter) {
  if (chapter.jobState === 'running' || chapter.jobState === 'queued') return [t('处理中'), 'lv-muted']
  if (chapter.jobState === 'paused') {
    if (chapter.jobAutoResume) return [t('自动重试中'), 'lv-muted']
    if (chapter.jobPause) return [t('需处理'), 'lv-warn']
    if (chapter.jobError) return [t('失败'), 'lv-error']
    return [t('已暂停'), 'lv-muted']
  }
  if (chapter.hasAudio) return [t('有音频'), 'lv-muted']
  return null
}

export function LibraryView({ books, chapters, selectedBook, active, mode = 'books', split = false, openShelfDetail, closeShelfDetail, openBook,
  booksQuery, changeBooksQuery, chapterQuery, changeChapterQuery,
  selectShelfBook, openChapter, listenChapter, clearAudio, uploading, cancelUpload, continueImport,
  batch, toggleBatch, selection, toggleChapter, selectRows, invertRows, clearSelection, selectBook, generateBatch, recastSelected,
  exportState, exportFormat, setExportFormat, exportBook, cancelExport, renameBook, deleteBook,
  openBookNotes, disabled, append, options }) {
  const data = books.value
  const contents = chapters.value
  const rows = Array.isArray(contents) ? contents : []
  const listKey = rows.map(row => row.id).join(',')
  const activeRef = useRef(null)
  const contentsHeading = useRef(null)
  const moveToContents = useRef(false)
  const anchor = useRef(null)
  const prevSplit = useRef(split)
  const prevMode = useRef(mode)
  const returnBookId = useRef(null)
  const booksContainerRef = useRef(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [exportOpen, setExportOpen] = useState(false)
  const [exportCfg, setExportCfg] = useState(() => ({ scope: 'all', from: 1, to: 1, ...loadExportPrefs() }))
  const updateExportCfg = patch => setExportCfg(prev => {
    const next = { ...prev, ...patch }
    saveExportPrefs(next)
    return next
  })
  const [exportPlan, setExportPlan] = useState(null)
  const [planLoading, setPlanLoading] = useState(false)
  const book = selectedBook?.id
  const exportInfo = exportState && exportState.book === book ? exportState : null
  useEffect(() => {
    setRenaming(false); setName(''); setExportOpen(false); setExportPlan(null)
    if (selectedBook?.chapters) setExportCfg(c => ({ ...c, from: 1, to: selectedBook.chapters }))
  }, [book, selectedBook?.chapters])
  useEffect(() => {
    if (!exportOpen || !book) return undefined
    const controller = new AbortController()
    setPlanLoading(true)
    const params = {
      book,
      format: exportCfg.format,
      mode: exportCfg.mode,
      ...(exportCfg.scope === 'range' ? { from: exportCfg.from, to: exportCfg.to } : {}),
      ...(exportCfg.scope === 'selected' && selection.size ? { chapters: [...selection.keys()].join(',') } : {}),
    }
    get('media/export-plan', params, controller.signal)
      .then(value => { if (!controller.signal.aborted) setExportPlan(value) })
      .catch(() => { if (!controller.signal.aborted) setExportPlan(null) })
      .finally(() => { if (!controller.signal.aborted) setPlanLoading(false) })
    return () => controller.abort()
  }, [exportOpen, book, exportCfg.format, exportCfg.mode, exportCfg.scope, exportCfg.from, exportCfg.to, selection.size])
  async function saveName() {
    if (!name.trim()) return
    const saved = await renameBook(book, name)
    if (saved) { setRenaming(false); setName('') }
  }
  useEffect(() => {
    if (active) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active, contents])
  useEffect(() => {
    if (moveToContents.current && (mode === 'split' || mode === 'detail')) {
      moveToContents.current = false
      contentsHeading.current?.focus()
    }
  }, [book, mode])
  useEffect(() => {
    const wasSplit = prevSplit.current
    prevSplit.current = split
    if (wasSplit === split) return
    const keepDetail = nextShelfDetailOnResize({ wasSplit, isSplit: split, detail: mode === 'detail', batch, renaming })
    if (wasSplit && !split) {
      if (keepDetail && book) openShelfDetail?.()
      else closeShelfDetail?.()
    }
  }, [split, mode, batch, renaming, book])
  useEffect(() => {
    const wasMode = prevMode.current
    prevMode.current = mode
    if (wasMode === 'detail' && mode === 'books' && returnBookId.current) {
      const targetId = returnBookId.current
      returnBookId.current = null
      const buttons = [...(booksContainerRef.current?.querySelectorAll(':scope > button') ?? [])]
      buttons.find(button => button.dataset.bookId === targetId)?.focus()
    }
  }, [mode])
  useEffect(() => { anchor.current = null }, [book, batch, chapterQuery, listKey])
  function toggleAt(row, index, shift) {
    if (shift && anchor.current != null) {
      const from = Math.min(anchor.current, index)
      const to = Math.max(anchor.current, index)
      selectRows(rows.slice(from, to + 1), true)
      return
    }
    toggleChapter(row)
    anchor.current = index
  }
  const bookActions = book && <div className="lv-inline">
    <button disabled={disabled} onClick={append}>{t("添加章节")}</button>
    <button disabled={disabled} aria-pressed={batch} onClick={toggleBatch}>{batch ? t('结束选择') : t('批量选择')}</button>
    {/* Book-wide actions sit at the top: a long chapter list must not hide them. */}
    <Popover label={t("书籍操作")} trigger={t("书籍操作")} placement="bottom-end">{close => <div className="lv-menu lv-book-menu">
      <button disabled={disabled || renaming} onClick={() => { close(); setName(selectedBook.title); setRenaming(true) }}>{t("重命名")}</button>
      <button disabled={disabled} onClick={() => { close(); clearAudio({ book }) }}>{t("清理书中音频")}</button>
      <hr className="lv-menu-divider"/>
      {['mp3', 'wav'].map(format => <button key={format} disabled={disabled || exportInfo?.state === 'running'}
        onClick={() => { close(); exportBook(book, format, selectedBook.title) }}>{t('导出整本 · {format}', { format: format.toUpperCase() })}</button>)}
      <button disabled={disabled || exportInfo?.state === 'running'} onClick={() => { close(); setExportOpen(open => !open) }}>{t("高级导出与字幕…")}</button>
      {openBookNotes && <button disabled={disabled} onClick={() => { close(); openBookNotes({ book, bookTitle: selectedBook.title }) }}>{t("听书批注与导出…")}</button>}
      <hr className="lv-menu-divider"/>
      <button className="lv-destructive" disabled={disabled} onClick={() => { close(); deleteBook(book, {
        title: selectedBook.title, chapters: selectedBook.chapters, audioBytes: selectedBook.audioBytes }) }}>{t("删除本书")}</button>
    </div>}</Popover>
  </div>
  const booksPane = <>
    {uploading && <div className="lv-inline"><small role="status">{t("正在打开导入预览…")}</small><button onClick={cancelUpload}>{t("取消")}</button></div>}
    {data?.imports?.length > 0 && <div className="lv-import-banner" role="status"><span>{t('待完成导入（{count} 本）', { count: data.imports.length })}</span>
      {data.imports.map(item => <button key={item.id} title={item.title} disabled={uploading} onClick={() => continueImport(item.id)}>{t("继续导入") + " · "}{item.title}</button>)}</div>}
    {data?.migrationWarning && <small role="status">{t("旧版存档暂未迁入，原文件仍在本机。")}</small>}
    <input aria-label={t("搜索书名")} placeholder={t("搜索书名")} value={booksQuery} onChange={event => changeBooksQuery(event.target.value)}/>
    {books.error && <div role="alert" className="lv-error">{displayText(books.error)} <button onClick={books.reload}>{t("重试")}</button></div>}
    {!data && !books.error && <small role="status">{t("正在读取书架…")}</small>}
    {data && !data.books.length && <p className="lv-muted">{booksQuery ? t('没有匹配的书籍。') : t('还没有书籍。可以导入文件，或新建书籍后粘贴正文。')}</p>}
    <div ref={booksContainerRef} className="lv-books" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll(':scope > button')]
      const index = buttons.indexOf(document.activeElement)
      if (index < 0) return
      event.preventDefault()
      buttons[rovingIndex(event.key, index, buttons.length)]?.focus()
    }}>{data?.books?.map(item => <button key={item.id} data-book-id={item.id} aria-pressed={book === item.id} disabled={disabled} onClick={() => {
      if (mode !== 'split') {
        returnBookId.current = item.id
        moveToContents.current = true
        selectShelfBook(item)
        openShelfDetail?.()
        return
      }
      if (book === item.id) contentsHeading.current?.focus()
      else { moveToContents.current = true; selectShelfBook(item) }
    }} onDoubleClick={() => {
      if (mode === 'split' && !disabled) void openBook?.(item.id)
    }}>
      <i aria-hidden="true" className="lv-book-cover" style={{'--lv-role-color':roleColor(item.id)}}><span className="lv-book-title">{item.title}</span></i>
      <span className="lv-book-meta">{item.chapters}{" " + t("章")}{item.audioBytes > 0 && <Icon name="Headphones"/>}</span>
    </button>)}</div>
    <div className="lv-inline">
      {books.previous && <button onClick={books.previous}>{t("上页书架")}</button>}
      {books.next && <button onClick={books.next}>{t("更多书籍")}</button>}
    </div>
    {data?.space && <StorageUsage compact space={data.space}/>}
  </>
  const chaptersPane = <>
    {mode === 'detail' && <div className="lv-shelf-detail-bar">
      <button type="button" className="lv-subtle lv-shelf-back" onClick={closeShelfDetail}><Icon name="ChevronLeft" size={16}/><span>{t("返回书架")}</span></button>
      {bookActions}
    </div>}
    {!book && mode === 'split' && <div className="lv-shelf-empty-detail"><p className="lv-muted">{t("选择一本书查看章节目录")}</p></div>}
    {book && <>{mode === 'detail' ? <h2 ref={contentsHeading} tabIndex={-1} className="lv-shelf-detail-heading">{t('《{title}》的章节目录', { title: selectedBook.title })}</h2>
      : <div className="lv-heading lv-contents-heading">
        <h2 ref={contentsHeading} tabIndex={-1}>{t('《{title}》的章节目录', { title: selectedBook.title })}</h2>
        {bookActions}
      </div>}
      {renaming && <form className="lv-rename" onSubmit={event => { event.preventDefault(); void saveName() }}>
        <input aria-label={t("新的书名")} value={name} maxLength={180} autoFocus onChange={event => setName(event.target.value)}/>
        <button className="lv-primary" disabled={!name.trim()}>{t("保存")}</button>
        <button type="button" onClick={() => setRenaming(false)}>{t("取消")}</button>
      </form>}
      {exportInfo && <small className="lv-export" role="status">{exportText(exportInfo)}{exportInfo.state === 'running' && <>{" "}<button type="button" className="lv-link" onClick={() => cancelExport?.()}>{t('取消')}</button></>}</small>}
      {exportOpen && <form className="lv-export-panel" aria-label={t("高级导出与字幕")} onSubmit={event => {
        event.preventDefault()
        exportBook(book, {
          format: exportCfg.format,
          mode: exportCfg.mode,
          subtitles: exportCfg.subtitles,
          speakers: exportCfg.speakers,
          ...(exportCfg.scope === 'range' ? { from: exportCfg.from, to: exportCfg.to } : {}),
          ...(exportCfg.scope === 'selected' && selection.size ? { chapters: [...selection.keys()].join(',') } : {}),
        }, selectedBook.title)
        setExportOpen(false)
      }}>
        <div className="lv-inline">
          <label>{t("范围") + " "}<select value={exportCfg.scope} onChange={e => updateExportCfg({ scope: e.target.value })}>
            <option value="all">{t("全本")}</option>
            <option value="range">{t("章节范围")}</option>
            {selection.size > 0 && <option value="selected">{t("已选章节（{count}）", { count: selection.size })}</option>}
          </select></label>
          {exportCfg.scope === 'range' && <>
            <label>{t("从第") + " "}<input type="number" min="1" max={selectedBook.chapters || 5000} value={exportCfg.from} onChange={e => updateExportCfg({ from: Math.max(1, Number(e.target.value) || 1) })}/></label>
            <label>{t("到第") + " "}<input type="number" min="1" max={selectedBook.chapters || 5000} value={exportCfg.to} onChange={e => updateExportCfg({ to: Math.max(1, Number(e.target.value) || 1) })}/></label>
          </>}
        </div>
        <div className="lv-inline">
          <label>{t("打包") + " "}<select value={exportCfg.mode} onChange={e => updateExportCfg({ mode: e.target.value, ...(e.target.value === 'single' ? { format: 'mp3' } : {}) })}>
            <option value="zip">{t("每章一个文件（ZIP）")}</option>
            <option value="single">{t("合并为单个文件")}</option>
          </select></label>
          <label>{t("音频格式") + " "}<select value={exportCfg.format} onChange={e => updateExportCfg({ format: e.target.value })}>
            <option value="mp3">MP3</option>
            <option value="wav">WAV</option>
          </select></label>
          <label>{t("字幕") + " "}<select value={exportCfg.subtitles} onChange={e => updateExportCfg({ subtitles: e.target.value })}>
            <option value="none">{t("不附字幕")}</option>
            <option value="srt">SRT</option>
            <option value="lrc">LRC</option>
            <option value="both">SRT + LRC</option>
          </select></label>
        </div>
        {exportCfg.subtitles !== 'none' && <label className="lv-check"><input type="checkbox" checked={exportCfg.speakers} onChange={e => updateExportCfg({ speakers: e.target.checked })}/>{" " + t("字幕中标明说话人角色名")}</label>}
        <small role="status">{planLoading ? t("正在计算预计时长…")
          : exportPlan ? t("可导出 {ready}/{total} 章 · 音频约 {mins} 分钟 · 预计耗时 {eta} 秒", {
            ready: exportPlan.readyCount, total: exportPlan.totalChapters,
            mins: Math.max(1, Math.round((exportPlan.totalSeconds || 0) / 60)),
            eta: exportPlan.estimatedBuildSeconds || 1,
          }) + (exportPlan.skippedCount ? t("（跳过 {count} 章）", { count: exportPlan.skippedCount }) : '')
          : t("选择导出范围与字幕格式。")}</small>
        <div className="lv-inline">
          <button type="submit" className="lv-primary" disabled={disabled || exportInfo?.state === 'running' || exportPlan?.readyCount === 0}>{t("开始导出")}</button>
          <button type="button" onClick={() => setExportOpen(false)}>{t("关闭")}</button>
        </div>
      </form>}
      <input aria-label={t("搜索章节")} placeholder={t("搜索章节")} value={chapterQuery} onChange={event => changeChapterQuery(event.target.value)}/>
      {chapters.error && <div role="alert" className="lv-error">{displayText(chapters.error)} <button onClick={chapters.reload}>{t("重试")}</button></div>}
      {!contents && !chapters.error && <small role="status">{t("正在读取目录…")}</small>}
      {contents?.length === 0 && <small>{t("没有匹配的章节。")}</small>}
      {batch && <div className="lv-batch">
        <small>{t("已选") + " "}{selection.size}{" " + t("/ 500 章")}</small>
        <div className="lv-inline">
          <button disabled={!rows.length || disabled} onClick={() => selectRows(rows)}>{t("全选本页")}</button>
          <button disabled={!rows.length || disabled} onClick={() => selectRows(rows, true)}>{t("追加本页")}</button>
          <button disabled={!rows.length || disabled} onClick={() => invertRows(rows)}>{t("反选本页")}</button>
          <button disabled={!selection.size || disabled} onClick={clearSelection}>{t("清空")}</button>
          <button disabled={disabled} onClick={selectBook}>{t("全选本书")}</button>
        </div>
        <div className="lv-inline">
          <button className="lv-primary" disabled={!selection.size || disabled} onClick={generateBatch}>{t("批量制作")}</button>
          <button disabled={!selection.size || disabled} onClick={recastSelected}>{t("重新编剧")}</button>
          {options && <small className="lv-batch-config">{t('当前设置：{engine} · {mode}', {
            engine: options.engine === 'laivox' ? t('LaiVox（推荐 · 增值付费）') : t('Edge 在线语音'),
            mode: options.mode === 'multi' ? t('多角色演绎') : t('单人朗读'),
          })}</small>}
        </div>
      </div>}
      <div className="lv-contents" onKeyDown={event => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        if (event.target.closest('input, textarea, select')) return
        const items = [...event.currentTarget.querySelectorAll(':scope > div')]
        const index = items.indexOf(event.target.closest('.lv-contents > div'))
        if (index < 0) return
        event.preventDefault()
        items[rovingIndex(event.key, index, items.length)]?.querySelector('button.lv-link')?.focus()
      }}>{rows.map((chapter, index) => {
        const state = chapterState(chapter)
        return <div key={chapter.id} className={active === chapter.id ? 'lv-active' : ''}
          ref={active === chapter.id ? activeRef : undefined}>
          {batch && <input type="checkbox" aria-label={t("加入批量生成 · {v1}", { v1: chapter.title })} checked={selection.has(chapter.id)}
            disabled={disabled || (selection.size >= 500 && !selection.has(chapter.id))} readOnly
            onClick={event => toggleAt(chapter, index, event.shiftKey)}/>}
          <span className="lv-ordinal">{chapter.ordinal}</span>
          <button className="lv-link" title={chapter.title} aria-current={active === chapter.id ? 'true' : undefined} aria-label={chapter.title + (state ? ' ' + state[0] : '')} disabled={disabled}
            onClick={event => batch ? toggleAt(chapter, index, event.shiftKey) : openChapter(chapter.id)}>{chapter.title}</button>
          {state && <small className={'lv-chapter-state ' + state[1]} title={state[0]}>{state[0]}</small>}
          {!batch && Boolean(chapter.hasAudio) && <button type="button" className="lv-chapter-listen" aria-label={t("收听") + " · " + chapter.title} onClick={() => listenChapter?.(chapter.id)}><Icon name="Play" size={13}/><span>{t("收听")}</span></button>}
        </div>
      })}</div>
      <div className="lv-inline">
        {chapters.previous && <button onClick={chapters.previous}>{t("上一页")}</button>}
        {chapters.next && <button onClick={chapters.next}>{t("下一页")}</button>}
      </div>
    </>}
  </>
  return <aside className={'lv-shelf' + (mode === 'split' ? ' lv-shelf-split' : '')} aria-label={t("书架")}>
    {mode === 'split'
      ? <><div className="lv-shelf-books-pane">{booksPane}</div><div className="lv-shelf-chapters-pane">{chaptersPane}</div></>
      : mode === 'detail'
        ? <div className="lv-shelf-chapters-pane">{chaptersPane}</div>
        : <div className="lv-shelf-books-pane">{booksPane}</div>}
  </aside>
}
