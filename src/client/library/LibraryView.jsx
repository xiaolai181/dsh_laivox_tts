import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState } from 'react'
import { explain, formatBytes, get, post } from '../api.mjs'
import { roleColor } from '../stage/roleColor.mjs'
import { Popover } from '../components/Popover.jsx'
import { Icon } from '../components/Icon.jsx'
import { StorageUsage } from '../components/Metrics.jsx'
import { rovingIndex } from '../studio/roving.mjs'
import { ChapterReview, cutLabels } from './ChapterReview.jsx'

function exportText(state) {
  if (!state) return ''
  if (state.state === 'running') return t("正在导出 {v1}/{v2} 章（{v3}）", { v1: Number(state.done) || 0, v2: Number(state.total) || 0, v3: formatBytes(state.bytes) })
  if (state.state === 'done') return t("导出完成 · {v1}", { v1: formatBytes(state.bytes) })
  if (state.state === 'cancelled') return t('导出已取消')
  return t("导出失败{v1}", { v1: state.error ? '：' + displayText(state.error) : '' })
}

export function ImportPreview({ entry, close, openBook, refresh, published, decide }) {
  const [data, setData] = useState(entry.data)
  const [exclude, setExclude] = useState(new Set())
  const [duplicate, setDuplicate] = useState(null)
  const [busy, setBusy] = useState(false)
  const [reviewCanLeave, setReviewCanLeave] = useState(false)
  const [message, setMessage] = useState('')
  const [encoding, setEncoding] = useState(data.encoding)
  const [split, setSplit] = useState(data.split)
  const [page, setPage] = useState(0)
  const [focused, setFocused] = useState(null)
  const pending = useRef(false)

  function update(next) {
    setData(next)
    if (next.revision !== data.revision) {
      setPage(0)
      setExclude(new Set())
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

  const publish = force => perform('publish', { revision: data.revision, duplicate: force, chapters: data.chapters.flatMap((_, i) => exclude.has(i) ? [] : [i]) })
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
      {data.chapters.slice(page * 80, page * 80 + 80).map((chapter, local) => {
        const index = page * 80 + local
        return <div className="lv-import-item" key={chapter.offset}><input type="checkbox" aria-label={t("导入 {v1}", { v1: chapter.title })} disabled={busy} checked={!exclude.has(index)} onChange={event => {
          const next = new Set(exclude)
          if (event.target.checked) next.delete(index)
          else next.add(index)
          setExclude(next)
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
    <div className="lv-inline">
      {duplicate ? <><span>{t("书架已有此文件")}</span><button disabled={busy} onClick={() => { close(); void openBook(duplicate) }}>{t("打开已有书")}</button><button disabled={busy} onClick={() => publish(true)}>{t("创建副本")}</button></>
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

export function LibraryView({ books, chapters, selectedBook, active, booksQuery, changeBooksQuery, chapterQuery, changeChapterQuery,
  selectShelfBook, openChapter, listenChapter, clearAudio, uploading, cancelUpload, continueImport,
  batch, toggleBatch, selection, toggleChapter, selectRows, invertRows, clearSelection, selectBook, generateBatch, recastSelected,
  exportState, exportFormat, setExportFormat, exportBook, cancelExport, renameBook, deleteBook,
  disabled, append, options }) {
  const data = books.value
  const contents = chapters.value
  const rows = Array.isArray(contents) ? contents : []
  const activeRef = useRef(null)
  const contentsHeading = useRef(null)
  const moveToContents = useRef(false)
  const anchor = useRef(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const book = selectedBook?.id
  const exportInfo = exportState && exportState.book === book ? exportState : null
  useEffect(() => { setRenaming(false); setName('') }, [book])
  async function saveName() {
    if (!name.trim()) return
    const saved = await renameBook(book, name)
    if (saved) { setRenaming(false); setName('') }
  }
  useEffect(() => {
    if (active) activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [active, contents])
  useEffect(() => {
    if (moveToContents.current) {
      moveToContents.current = false
      contentsHeading.current?.focus()
    }
  }, [book])
  useEffect(() => { anchor.current = null }, [book, batch])
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
  return <aside className="lv-shelf" aria-label={t("书架")}>
    {uploading && <div className="lv-inline"><small role="status">{t("正在打开导入预览…")}</small><button onClick={cancelUpload}>{t("取消")}</button></div>}
    {data?.imports?.length > 0 && <div className="lv-import-banner" role="status"><span>{t('待完成导入（{count} 本）', { count: data.imports.length })}</span>
      {data.imports.map(item => <button key={item.id} title={item.title} disabled={uploading} onClick={() => continueImport(item.id)}>{t("继续导入") + " · "}{item.title}</button>)}</div>}
    {data?.migrationWarning && <small role="status">{t("旧版存档暂未迁入，原文件仍在本机。")}</small>}
    <input aria-label={t("搜索书名")} placeholder={t("搜索书名")} value={booksQuery} onChange={event => changeBooksQuery(event.target.value)}/>
    {books.error && <div role="alert" className="lv-error">{displayText(books.error)} <button onClick={books.reload}>{t("重试")}</button></div>}
    {!data && !books.error && <small role="status">{t("正在读取书架…")}</small>}
    {data && !data.books.length && <p className="lv-muted">{booksQuery ? t('没有匹配的书籍。') : t('还没有书籍。可以导入文件，或新建书籍后粘贴正文。')}</p>}
    <div className="lv-books" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      const buttons = [...event.currentTarget.querySelectorAll(':scope > button')]
      const index = buttons.indexOf(document.activeElement)
      if (index < 0) return
      event.preventDefault()
      buttons[rovingIndex(event.key, index, buttons.length)]?.focus()
    }}>{data?.books?.map(item => <button key={item.id} aria-pressed={book === item.id} disabled={disabled} onClick={() => {
      if (book === item.id) contentsHeading.current?.focus()
      else { moveToContents.current = true; selectShelfBook(item) }
    }}>
      <i aria-hidden="true" className="lv-book-cover" style={{'--lv-role-color':roleColor(item.id)}}><span className="lv-book-title">{item.title}</span></i>
      <span className="lv-book-meta">{item.chapters}{" " + t("章")}{item.audioBytes > 0 && <Icon name="Headphones"/>}</span>
    </button>)}</div>
    <div className="lv-inline">
      {books.previous && <button onClick={books.previous}>{t("上页书架")}</button>}
      {books.next && <button onClick={books.next}>{t("更多书籍")}</button>}
    </div>
    {data?.space && <StorageUsage compact space={data.space}/>}
    {book && <><div className="lv-heading lv-contents-heading">
      <h2 ref={contentsHeading} tabIndex={-1}>{t('《{title}》的章节目录', { title: selectedBook.title })}</h2>
      <div className="lv-inline">
        <button disabled={disabled} onClick={append}>{t("添加章节")}</button>
        <button disabled={disabled} aria-pressed={batch} onClick={toggleBatch}>{batch ? t('结束选择') : t('批量选择')}</button>
        {/* Book-wide actions sit at the top: a long chapter list must not hide them. */}
        <Popover label={t("书籍操作")} trigger={t("书籍操作")} placement="bottom-end">{close => <div className="lv-menu lv-book-menu">
          <button disabled={disabled || renaming} onClick={() => { close(); setName(selectedBook.title); setRenaming(true) }}>{t("重命名")}</button>
          <button disabled={disabled} onClick={() => { close(); clearAudio({ book }) }}>{t("清理书中音频")}</button>
          <hr className="lv-menu-divider"/>
          {['mp3', 'wav'].map(format => <button key={format} disabled={disabled || exportInfo?.state === 'running'}
            onClick={() => { close(); exportBook(book, format, selectedBook.title) }}>{t('导出整本 · {format}', { format: format.toUpperCase() })}</button>)}
          <hr className="lv-menu-divider"/>
          <button className="lv-destructive" disabled={disabled} onClick={() => { close(); deleteBook(book, {
            title: selectedBook.title, chapters: selectedBook.chapters, audioBytes: selectedBook.audioBytes }) }}>{t("删除本书")}</button>
        </div>}</Popover>
      </div>
    </div>
      {renaming && <form className="lv-rename" onSubmit={event => { event.preventDefault(); void saveName() }}>
        <input aria-label={t("新的书名")} value={name} maxLength={180} autoFocus onChange={event => setName(event.target.value)}/>
        <button className="lv-primary" disabled={!name.trim()}>{t("保存")}</button>
        <button type="button" onClick={() => setRenaming(false)}>{t("取消")}</button>
      </form>}
      {exportInfo && <small className="lv-export" role="status">{exportText(exportInfo)}{exportInfo.state === 'running' && <>{" "}<button type="button" className="lv-link" onClick={() => cancelExport?.()}>{t('取消')}</button></>}</small>}
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
          {!batch && chapter.hasAudio && <button type="button" className="lv-subtle lv-chapter-listen" aria-label={t("收听") + " · " + chapter.title} onClick={() => listenChapter?.(chapter.id)}>{t("收听")}</button>}
        </div>
      })}</div>
      <div className="lv-inline">
        {chapters.previous && <button onClick={chapters.previous}>{t("上一页")}</button>}
        {chapters.next && <button onClick={chapters.next}>{t("下一页")}</button>}
      </div>
    </>}
  </aside>
}
