import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { explain, formatBytes, get, post } from '../api.mjs'
import { downloadKey, downloadsSnapshot, startChapterDownload, subscribeDownloads } from '../workbench/downloads.mjs'
import { Popover } from '../components/Popover.jsx'
import { agoText, durationText, expiryText, groupSnippets, retentionLabel } from './snippets.mjs'

const PAGE = 30
const noSessions = selector => selector({ byId: {} })

// DSH's session list carries the conversation titles; a blank or unknown session
// has none and the group falls back to its date. One string is selected so the
// hook re-renders only when a title actually changes.
function useSessionTitles(useSessions, ids) {
  const key = ids.join('\n')
  const joined = (useSessions ?? noSessions)(state => key ? key.split('\n').map(id => {
    const row = state?.byId?.[id]
    return row && !row.blank && typeof row.title === 'string' ? row.title.replace(/\s+/gu, ' ') : ''
  }).join('\n') : '')
  return useMemo(() => {
    const titles = typeof joined === 'string' ? joined.split('\n') : []
    return Object.fromEntries(key ? key.split('\n').map((id, index) => [id, titles[index] ?? '']) : [])
  }, [key, joined])
}

function Row({ item, retention, now, busy, play, exportAs, edit, remove, pending }) {
  const facts = [durationText(item.seconds), Number(item.audioBytes) > 0 ? formatBytes(item.audioBytes) : '',
    t("{v1} 字", { v1: (Number(item.characters) || 0).toLocaleString() })].filter(Boolean)
  const when = item.active ? t('制作中') : [t("最后收听 {v1}", { v1: agoText(item.touched, now) }), expiryText(item.touched, retention, now)].filter(Boolean).join(' · ')
  const playable = Boolean(item.job) && Number(item.audioBytes) > 0
  return <div className="lv-snippet" role="listitem">
    <div className="lv-snippet-main">
      <strong title={item.title}>{item.title}</strong>
      <small>{facts.join(' · ')}</small>
      <small>{when}</small>
    </div>
    <div className="lv-inline lv-snippet-actions">
      <button className="lv-primary" disabled={busy || !playable} onClick={() => play(item)}>{t("播放")}</button>
      {/* Popovers sit in the top layer and flip, so the transport bar never covers them. */}
      <Popover label={t("导出 · {v1}", { v1: item.title })} placement="bottom-end"
        trigger={pending ? (pending.total ? t('导出中 {done}/{total}', { done: pending.done, total: pending.total }) : t('导出中…')) : t("导出")}>{close => <div className="lv-menu">
        {['wav', 'mp3'].map(format => <button key={format} disabled={busy || item.active || !item.exportable || Boolean(pending)}
          onClick={() => { close(); exportAs(item, format) }}>{format.toUpperCase()}</button>)}</div>}</Popover>
      <Popover label={t("更多操作 · {v1}", { v1: item.title })} trigger="⋯" placement="bottom-end">{close => <div className="lv-menu">
        {pending && <button onClick={() => { close(); pending.cancel() }}>{t("取消导出")}</button>}
        <button disabled={busy} onClick={() => { close(); edit(item, 'rename') }}>{t("重命名")}</button>
        <button disabled={busy} onClick={() => { close(); edit(item, 'adopt') }}>{t("保存到书架")}</button>
        <button className="lv-destructive" disabled={busy || item.active} title={item.active ? t('制作中，完成或取消后才能删除') : undefined}
          onClick={() => { close(); remove(item) }}>{t("删除")}</button></div>}</Popover>
    </div>
  </div>
}

// The conversation readings: listen, export, rename, save to the shelf or delete
// them. They expire after the retention period set in settings (counted from the
// last listen); readings being made are never deleted.
export function SnippetsView({ useSessions, version, decide, notify, open, openBook, forget, renamed, openSettings }) {
  const [offset, setOffset] = useState(0)
  const [state, setState] = useState({ value: null, error: '' })
  const [attempt, reload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(null)
  const [saved, setSaved] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const pending = useRef(false)
  const value = state.value
  useEffect(() => {
    const abort = new AbortController()
    get('snippets', { offset }, abort.signal).then(result => {
      if (abort.signal.aborted) return
      setState({ value: result, error: '' }); setNow(Date.now())
      // Deleted elsewhere (or by the cleanup) until this page ran out: step back.
      if (offset > 0 && !result.items.length) setOffset(Math.max(0, offset - PAGE))
    }).catch(error => { if (!abort.signal.aborted) setState(previous => ({ value: previous.value, error: deferText(() => explain(error)) })) })
    return () => abort.abort()
  }, [offset, version, attempt])
  // Readings still being made change on their own; look again while any is.
  const making = value?.items?.some(item => item.active)
  useEffect(() => {
    if (!making) return undefined
    const timer = setTimeout(() => reload(n => n + 1), 3000)
    return () => clearTimeout(timer)
  }, [making, value])
  const items = value?.items ?? []
  const sessions = useMemo(() => [...new Set(items.map(item => item.session ?? ''))], [items])
  const titles = useSessionTitles(useSessions, sessions)
  const groups = useMemo(() => groupSnippets(items, titles), [items, titles])

  async function perform(work) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try { await work() }
    catch (error) {
      notify(deferText(() => explain(error)))
      if (['SNIPPET_NOT_FOUND', 'JOBS_ACTIVE'].includes(error?.message)) reload(n => n + 1)
    }
    finally { pending.current = false; setBusy(false) }
  }
  async function remove(item) {
    const choice = await decide({ title: deferText(() => t("删除「{v1}」？", { v1: item.title })), text: deferText(() => t('正文、音频和播放进度都会删除，无法恢复。')),
      choices: [['delete', deferText(() => t('删除'))], [null, deferText(() => t('返回'))]], destructive: true })
    if (choice !== 'delete') return
    await perform(async () => {
      await post('snippets/action', { action: 'delete', book: item.book })
      forget([item.book])
      notify(deferText(() => t('已删除这条对话片段')))
      reload(n => n + 1)
    })
  }
  async function removeAll() {
    const total = Number(value?.total) || 0
    const choice = await decide({ title: deferText(() => t("删除全部 {v1} 条对话片段？", { v1: total })), text: deferText(() => t('正文、音频和播放进度都会删除，无法恢复。制作中的会保留。')),
      choices: [['delete', deferText(() => t('全部删除'))], [null, deferText(() => t('返回'))]], destructive: true })
    if (choice !== 'delete') return
    await perform(async () => {
      const result = await post('snippets/action', { action: 'delete-all' })
      forget(Array.isArray(result?.books) ? result.books : [])
      notify(deferText(() => t("已删除 {v1} 条", { v1: Number(result?.deleted) || 0 }) + (result?.skipped ? t("，{v1} 条制作中已保留", { v1: result.skipped }) : '')))
      setOffset(0); reload(n => n + 1)
    })
  }
  async function submitEdit(event) {
    event.preventDefault()
    const title = editing.title.trim()
    if (!title) return
    const { item, mode } = editing
    await perform(async () => {
      await post('snippets/action', { action: mode, book: item.book, title })
      setEditing(null)
      if (mode === 'adopt') { setSaved({ book: item.book, title }); notify(deferText(() => t('已保存到书架'))) }
      else notify(deferText(() => t('已重命名')))
      renamed(item.book)
      reload(n => n + 1)
    })
  }
  // Not wrapped in perform(): preparing a file can take minutes and must not
  // lock the whole list. Progress and cancel are on the row.
  const downloads = useSyncExternalStore(subscribeDownloads, downloadsSnapshot)
  const pendingFor = item => ['wav', 'mp3'].map(format => downloads.get(downloadKey(item.job, format))).find(entry => entry?.phase === 'preparing')
  async function exportAs(item, format) {
    const failure = await startChapterDownload({ job: item.job, format, title: item.title, notify })
    if (failure) notify(failure)
  }

  const total = Number(value?.total) || 0
  return <section className="lv-snippets" aria-label={t("对话片段")}>
    {value && total > 0 && <div className="lv-snippets-summary">
      <span>{t("对话片段共") + " "}{total}{" " + t("条 · 占用") + " "}{formatBytes(value.audioBytes)} · {retentionLabel(value.retention)}
        （<button className="lv-link" onClick={openSettings}>{t("在设置里修改")}</button>）</span>
      <button className="lv-destructive" disabled={busy} onClick={removeAll}>{t("全部删除")}</button>
    </div>}
    {saved && <div className="lv-inline lv-snippets-saved" role="status">
      <span>{t('已把「{title}」保存到书架', { title: saved.title })}</span>
      <button onClick={() => { openBook({ id: saved.book, title: saved.title }); setSaved(null) }}>{t("在书架中打开")}</button>
      <button className="lv-subtle" aria-label={t("关闭提示")} onClick={() => setSaved(null)}>{t("知道了")}</button>
    </div>}
    {state.error && <div role="alert" className="lv-error">{displayText(state.error)} <button onClick={() => reload(n => n + 1)}>{t("重试")}</button></div>}
    {!value && !state.error && <small role="status">{t("正在读取对话片段…")}</small>}
    {value && !total && <p className="lv-muted">{t("还没有对话片段。在对话里用 /laivox 或让 AI 为长文生成有声朗读时，结果会暂存在这里（消息快捷朗读不会保存）。")}</p>}
    {editing && <form className="lv-rename lv-snippets-edit" onSubmit={submitEdit}>
      <label>{editing.mode === 'adopt' ? t('保存到书架的书名') : t('新的名称')}
        <input value={editing.title} maxLength={180} autoFocus onChange={event => setEditing({ ...editing, title: event.target.value })}/></label>
      <button className="lv-primary" disabled={busy || !editing.title.trim()}>{editing.mode === 'adopt' ? t('保存到书架') : t('保存')}</button>
      <button type="button" disabled={busy} onClick={() => setEditing(null)}>{t("取消")}</button>
      {editing.mode === 'adopt' && <small>{t("保存后会成为书架里的一本书，音频和播放进度都保留，不再按保留期删除。")}</small>}
    </form>}
    {groups.map(group => <div className="lv-snippet-group" key={group.session} role="list" aria-label={group.title}>
      <h3>{group.title}</h3>
      {group.items.map(item => <Row key={item.book} item={item} retention={value.retention} now={now} busy={busy} pending={pendingFor(item)}
        play={row => open(row.chapter, row.job)} exportAs={exportAs} remove={remove}
        edit={(row, mode) => { setSaved(null); setEditing({ item: row, mode, title: row.title }) }}/>)}
    </div>)}
    <div className="lv-inline">
      {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t("上一页")}</button>}
      {offset + items.length < total && <button onClick={() => setOffset(offset + PAGE)}>{t("下一页")}</button>}
    </div>
  </section>
}
