import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useState } from 'react'
import { explain, get, post, url } from '../api.mjs'

export function NotesSheet({ book, bookTitle, draftNote, navigate, close, notify, onChanged }) {
  const [notes, setNotes] = useState([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [quote, setQuote] = useState(draftNote?.quote ?? '')
  const [speaker, setSpeaker] = useState(draftNote?.speaker ?? '')
  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState(null)
  const [editBody, setEditBody] = useState('')

  useEffect(() => {
    setQuote(draftNote?.quote ?? '')
    setSpeaker(draftNote?.speaker ?? '')
    setBody('')
  }, [draftNote?.chapter, draftNote?.partIndex, draftNote?.quote])

  async function load(qText = query) {
    if (!book) return
    setLoading(true)
    setError('')
    try {
      const data = await get('notes/list', { book, q: qText, limit: 200 })
      setNotes(data?.notes ?? [])
      setTotal(Number(data?.total) || 0)
    } catch (err) {
      setError(deferText(() => explain(err)))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load('') }, [book])

  async function addNote(event) {
    event.preventDefault()
    if (!quote.trim() || !(draftNote?.chapter) || busy) return
    setBusy(true)
    setError('')
    try {
      await post('notes/save', {
        book,
        chapter: draftNote.chapter,
        partIndex: draftNote.partIndex ?? 0,
        charOffset: draftNote.charOffset ?? 0,
        quote: quote.trim(),
        speaker: speaker.trim(),
        body: body.trim(),
      })
      setBody('')
      await load(query)
      onChanged?.()
      notify?.(deferText(() => t('已保存听书批注')))
    } catch (err) {
      setError(deferText(() => explain(err)))
    } finally {
      setBusy(false)
    }
  }

  async function saveEdit(id) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await post('notes/save', { id, body: editBody.trim() })
      setEditingId(null)
      await load(query)
      onChanged?.()
      notify?.(deferText(() => t('批注已更新')))
    } catch (err) {
      setError(deferText(() => explain(err)))
    } finally {
      setBusy(false)
    }
  }

  async function removeNote(id) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await post('notes/delete', { id })
      await load(query)
      onChanged?.()
      notify?.(deferText(() => t('已删除批注')))
    } catch (err) {
      setError(deferText(() => explain(err)))
    } finally {
      setBusy(false)
    }
  }

  async function exportMarkdown() {
    if (!book) return
    try {
      const res = await fetch(url('notes/export', { book }), { cache: 'no-store' })
      if (!res.ok) throw new Error('SERVICE_UNAVAILABLE')
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = ((bookTitle || 'notes') + '-笔记.md').replace(/[\\/:*?"<>|]/g, '_')
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000)
      notify?.(deferText(() => t('已导出 Markdown 笔记')))
    } catch (err) {
      setError(deferText(() => explain(err)))
    }
  }

  return <section className="lv-notes-sheet">
    <div className="lv-heading">
      <div>
        <small className="lv-kicker">{t("听书批注")}</small>
        <strong>《{bookTitle || t('当前书籍')}》 · {t("{count} 条", { count: total })}</strong>
      </div>
      <button type="button" disabled={!notes.length || busy} onClick={() => void exportMarkdown()}>{t("导出 Markdown 笔记")}</button>
    </div>

    {draftNote?.chapter && <form className="lv-export-panel" onSubmit={addNote}>
      <small>{t("第 {v1} 章", { v1: draftNote.ordinal ?? 1 })} · {draftNote.chapterTitle || ''}{speaker ? ` · ${speaker}` : ''}</small>
      <textarea rows={2} maxLength={2000} value={quote} onChange={e => setQuote(e.target.value)} placeholder={t("原句摘录")} required/>
      <textarea rows={2} maxLength={4000} value={body} onChange={e => setBody(e.target.value)} placeholder={t("记下你的想法（可留空直接收藏）")}/>
      <div className="lv-inline">
        <button type="submit" className="lv-primary" disabled={busy || !quote.trim()}>{t("保存批注")}</button>
      </div>
    </form>}

    <div className="lv-inline">
      <input aria-label={t("搜索批注")} placeholder={t("搜索原句、角色或笔记内容")} value={query}
        onChange={e => { setQuery(e.target.value); void load(e.target.value) }}/>
    </div>

    {error && <p className="lv-error" role="alert">{displayText(error)}</p>}
    {loading && <small role="status">{t("正在加载批注…")}</small>}
    {!loading && !notes.length && <p className="lv-muted">{t("还没有听书批注。可在播放器「更多 → 收藏此句 / 记批注」添加。")}</p>}

    <div className="lv-notes-list" style={{ display: 'grid', gap: 10 }}>
      {notes.map(item => <article key={item.id} className="lv-export-panel">
        <div className="lv-heading">
          <small>{t("第 {v1} 章", { v1: item.ordinal })} · {item.chapterTitle}{item.speaker ? ` · ${item.speaker}` : ''}</small>
          <div className="lv-inline">
            <button type="button" className="lv-link" onClick={() => { close(); navigate({ chapter: item.chapter, start: item.charOffset }) }}>{t("跳回此处")}</button>
            <button type="button" className="lv-link" onClick={() => { setEditingId(item.id); setEditBody(item.body ?? '') }}>{t("编辑")}</button>
            <button type="button" className="lv-link" disabled={busy} onClick={() => void removeNote(item.id)}>{t("删除")}</button>
          </div>
        </div>
        <blockquote>{item.quote}</blockquote>
        {editingId === item.id
          ? <div className="lv-inline">
            <input value={editBody} maxLength={4000} onChange={e => setEditBody(e.target.value)}/>
            <button type="button" className="lv-primary" disabled={busy} onClick={() => void saveEdit(item.id)}>{t("保存")}</button>
            <button type="button" onClick={() => setEditingId(null)}>{t("取消")}</button>
          </div>
          : item.body && <p>{item.body}</p>}
      </article>)}
    </div>
  </section>
}
