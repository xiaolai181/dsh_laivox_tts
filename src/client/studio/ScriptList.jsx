import { roleDisplayName, roleMatchesQuery } from '../i18n/display.mjs'
import { roleNameKey } from '../../domain/production.mjs'
import { deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { RemovedLines } from './RemovedLines.jsx'
import { Icon } from '../components/Icon.jsx'
import { ScriptRowEditor } from './ScriptRowEditor.jsx'
import { INSTRUCT_PRESETS, presetIntensity } from '../../domain/voice-direction.mjs'
import { roleColor } from '../stage/roleColor.mjs'
import { groupSpeech, segmentChapter, segmentVersion } from '../../domain/segment.mjs'
import { explain, get, post, url } from '../api.mjs'
import { startExcerptDownload } from '../workbench/downloads.mjs'
import { chapterRoles } from '../workbench/state.mjs'
import { rowAudio, rowChanged, rowQueued, rowRetakeState } from './scriptAudio.mjs'
import { productionView } from '../workbench/productionView.mjs'
import { previewChannel } from '../player/previewChannel.mjs'
import { rovingIndex } from './roving.mjs'
import { pauseActionSpec } from '../workbench/pauseNotice.mjs'
import { notePackOpened } from '../workbench/packLink.mjs'
import { useVoiceDirectory, VoicePicker } from '../editorial/VoicePicker.jsx'
import { effectiveVoices, narratorDefaultFor } from './voiceLabels.mjs'

const labels = { neutral: '平静', happy: '喜悦', sad: '悲伤', angry: '愤怒', afraid: '害怕', tense: '紧张', gentle: '温柔' }
export function ScriptList({ chapter, roles, draft, setDraft, stale, textDirty, notify, busy, player, newRole, options, generate, jobAction, actions, openSettings, openRoles, openDay, packPage, onPreparePack, focus, onFocusApplied, pendingCount = 0, confirmSave, saveVoice, narratorSetting, keyInfo }) {
  const listRef = useRef(null)
  const [roleFilter, setRoleFilter] = useState('')
  const [search, setSearch] = useState('')
  const [dialogueOnly, setDialogueOnly] = useState(false)
  const [selection, setSelection] = useState(new Set())
  const [selecting, setSelecting] = useState(false)
  const [page, setPage] = useState(0)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [picking, setPicking] = useState(null)
  const [rowFocus, setRowFocus] = useState(0)
  const [plan, setPlan] = useState(null)
  const [planTry, setPlanTry] = useState(0)
  const readOnly = stale || textDirty || busy
  const state = draft ?? chapter.editorial ?? { removed: [], annotations: {} }
  const version = segmentVersion(chapter.editorial)
  const change = (part, change) => {
    const annotations = { ...state.annotations }
    for (const id of part.sourceIds) {
      const previous = annotations[id] ?? { roleId: 'narrator', emotion: 'neutral', intensity: 0 }
      annotations[id] = { ...previous, ...change, id }
    }
    setDraft({ ...state, version, annotations })
  }
  const segments = useMemo(() => draft ? segmentChapter(chapter.text, state.removed, version) : chapter.script, [chapter.text, chapter.script, state.removed, !!draft, version])
  const groups = useMemo(() => groupSpeech(segments.map(part => ({ ...part, ...state.annotations[part.id] }))), [segments, state.annotations])
  const split = useMemo(() => chapterRoles(roles, groups, null), [roles, groups])
  const view = productionView(chapter, options)
  const mode = view.shown.mode
  const engine = view.shown.engine
  const directory = useVoiceDirectory(engine)
  const narratorDefault = narratorDefaultFor(engine, keyInfo?.account, directory.voices, narratorSetting)
  const assigned = useMemo(() => effectiveVoices(chapter, roles, directory.voices, engine, chapter?.voiceRule, narratorDefault), [chapter, roles, directory.voices, engine, narratorDefault])
  const keyMissing = engine === 'laivox' && keyInfo?.configured === false
  useEffect(() => {
    if (!focus?.token) return undefined
    if (focus.roleId) setRoleFilter(focus.roleId)
    if (focus.partId) setEditing(focus.partId)
    onFocusApplied?.()
    return undefined
  }, [focus?.token])
  useEffect(() => {
    if (!chapter?.id) return
    const abort = new AbortController()
    get('chapter/audio-plan', { id: chapter.id, engine, mode }, abort.signal).then(value => {
      if (!abort.signal.aborted) setPlan(value)
    }).catch(() => { if (!abort.signal.aborted) setPlan(null) })
    return () => abort.abort()
  }, [chapter?.id, chapter?.rev, chapter?.rolesRev, chapter?.editorialResultJob, chapter?.operation?.id, chapter?.operation?.state, chapter?.operation?.synthesis?.done, chapter?.operation?.scope, engine, mode, planTry])
  useEffect(() => () => {
    const channel = previewChannel()
    if (String(channel?.currentKey() ?? '').startsWith('line:')) channel.stop()
  }, [])
  async function previewRow(part) {
    const channel = previewChannel()
    if (!channel) return
    const key = 'line:' + part.id
    if (channel.currentKey() === key) { channel.stop(); return }
    const hits = rowAudio(part, plan).hits.filter(row => row[2] === 1 && row[3])
    try {
      await channel.play(key, hits.map(row => async () => {
        const response = await fetch(url('media/clip', { chapter: chapter.id, key: row[3] }), { cache: 'no-store' })
        if (!response.ok) { const error = new Error('CLIP_MISSING'); error.missing = true; throw error }
        return response.blob()
      }))
    } catch (error) {
      if (error?.missing) { notify(deferText(() => t('音频已不可用'))); setPlan(null); return }
      notify(deferText(() => t("试听失败：{v1}", { v1: explain(error) })))
    }
  }
  async function synthesize(part) {
    try { await synthesizePart(part) }
    catch (error) { notify(deferText(() => explain(error))) }
  }
  async function synthesizePart(part) {
    const operation = chapter.operation
    const active = operation && ['queued', 'running', 'paused'].includes(operation.state)
    const modeName = operation?.mode === 'multi' ? '多角色演绎' : '单人朗读'
    const startPart = async () => {
      const result = await generate?.('generate', false, '', { only: { start: part.start, end: part.end }, focusStart: part.start })
      if (result?.reason === 'busy') notify(deferText(() => t('正在处理上一个操作')))
      else if (result?.reason === 'pending') notify(deferText(() => t('上一次制作还在确认，请稍候')))
    }
    if (active && operation.engine && operation.engine !== engine) { notify(deferText(() => t('当前任务用的是另一套引擎，先等它结束或停止'))); return }
    if (active && operation.mode && operation.mode !== mode) { notify(deferText(() => t("当前任务是{v1}，先等它结束或停止", { v1: t(modeName) }))); return }
    if (active && operation.retake) { notify(deferText(() => t('本章正在重新合成指定段落，先等它结束或取消'))); return }
    if (active && operation.state === 'paused') {
      if (operation.laivoxPause && ['quota', 'account', 'membership', 'outdated', 'voice'].includes(operation.laivoxPause.kind)) {
        notify(deferText(() => t('这一段要等额度或账号的问题解决后才能继续')))
        return
      }
      if (operation.scope === 'range') {
        const result = await post('jobs/action', { action: 'include', id: operation.id, start: part.start, end: part.end })
        if (result?.included) {
          await post('jobs/action', { id: operation.id, action: 'resume', start: part.start })
          notify(deferText(() => t('已继续制作，并先做这一段')))
          return
        }
        await startPart()
        return
      }
      await post('jobs/action', { id: operation.id, action: 'resume', start: part.start })
      notify(deferText(() => t('已继续制作，并先做这一段')))
      return
    }
    if (active && operation.state === 'queued' && operation.scope !== 'range') {
      notify(deferText(() => t('本章任务已在排队中，稍候会自动开始')))
      return
    }
    const index = plan?.parts?.findIndex(row => row[0] < part.end && row[1] > part.start) ?? -1
    if (active && operation.state === 'running' && operation.scope !== 'range' && index >= 0) {
      await post('jobs/action', { action: 'focus', id: operation.id, n: index })
      notify(deferText(() => t('已优先合成这里，稍候即可收听')))
      return
    }
    if (active && operation.scope === 'range') {
      const result = await post('jobs/action', { action: 'include', id: operation.id, start: part.start, end: part.end })
      if (result?.included) { notify(deferText(() => t('已加入当前制作任务'))); return }
      await startPart()
      return
    }
    if (!active) await startPart()
  }
  // Listening is the judge: a part that already has audio can be made again.
  // LaiVox gives a different take each time; the old audio stays until the new
  // one is stored. Edge answers the same text with the same audio, so it is not offered.
  async function retake(part) {
    try {
      const result = await generate?.('generate', false, '', { only: { start: part.start, end: part.end }, focusStart: part.start, retake: true, clean: false, keepDrafts: true })
      if (result?.ok) notify(deferText(() => t('正在重新合成这一段，完成后替换原来的音频')))
      else if (result?.reason === 'busy') notify(deferText(() => t('正在处理上一个操作')))
      else if (result?.reason === 'pending') notify(deferText(() => t('上一次制作还在确认，请稍候')))
    } catch (error) { notify(deferText(() => explain(error))) }
  }
  async function saveAndRetake(part) {
    if (pendingCount > 1) {
      const choice = await confirmSave?.({
        title: deferText(() => t('保存并重做本句？')),
        text: deferText(() => t('会一并保存 {count} 处修改，只重做这一句。', { count: pendingCount })),
        choices: [['save', deferText(() => t('保存并重做'))], [null, deferText(() => t('取消'))]],
      })
      if (choice !== 'save') return
    }
    try {
      const result = await generate?.('generate', false, '', { only: { start: part.start, end: part.end }, focusStart: part.start, clean: false })
      if (result?.reason === 'busy') notify(deferText(() => t('正在处理上一个操作')))
      else if (result?.reason === 'pending') notify(deferText(() => t('上一次制作还在确认，请稍候')))
    } catch (error) { notify(deferText(() => explain(error))) }
  }
  const retakeStateOf = part => rowRetakeState(part, chapter.operation, mode, engine)
  const removedDirty = Boolean(draft) && [...new Set([...(chapter.editorial?.removed ?? []), ...(state.removed ?? [])])].some(id => new Set(chapter.editorial?.removed ?? []).has(id) !== new Set(state.removed ?? []).has(id))
  const retakeBlock = chapter.operation && ['queued', 'running'].includes(chapter.operation.state) ? t('本章制作结束后可以重新合成')
    : chapter.operation?.state === 'paused' ? t('本章有已暂停的任务，先继续或取消后再重新合成')
    : removedDirty ? t('已移除的行有未保存修改，先保存或放弃') : ''
  function lineFacts(part) {
    const changed = Boolean(draft) && rowChanged(part, state.annotations, chapter.editorial?.annotations)
    const audio = rowAudio(part, plan)
    const retakeState = changed ? null : retakeStateOf(part)
    const queued = !changed && !retakeState && audio.audio !== 'ready' && rowQueued(part, chapter.operation, mode, engine)
    const text = changed ? (mode === 'reading' ? t('已修改 · 单人朗读不使用') : t('已修改 · 保存后重新合成这一行'))
      : retakeState === 'active' ? t('重新合成中')
      : retakeState === 'paused' ? (chapter.operation?.error ? t('重新合成失败') : t('重新合成已暂停'))
      : queued ? t('排队中')
      : plan?.status === 'ok' ? (audio.audio === 'ready' ? t('已合成') : audio.audio === 'partial' ? t('部分已合成') : t('未合成')) : ''
    const edge = !changed && audio.hits.some(row => row[4] === 'edge') ? t(' · Edge 补完') : ''
    return { changed, audio, retakeState, status: text + edge }
  }
  const filtered = groups.filter(part => (!roleFilter || part.roleId === roleFilter) && (!dialogueOnly || part.roleId !== 'narrator') && part.text.includes(search.trim()))
  useEffect(() => { setPage(0) },[roleFilter, search, dialogueOnly])
  useEffect(() => { listRef.current?.scrollIntoView({block:'nearest'}) },[page])
  function batchChange(patch) {
    const sourceIds = groups.filter(part => selection.has(part.id)).flatMap(part => part.sourceIds)
    if (!sourceIds.length) return
    change({sourceIds}, patch)
    notify(deferText(() => t('已写入草稿，尚未保存')))
  }
  const max = Math.max(0, Math.ceil(filtered.length / 100) - 1)
  const shown = Math.min(page, max)
  const pageRows = filtered.slice(shown * 100, shown * 100 + 100)
  const focusIndex = pageRows.length ? Math.min(rowFocus, pageRows.length - 1) : 0
  function onRowKey(event) {
    if (event.defaultPrevented) return
    const target = event.target
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return
    if (event.key === 'Escape') {
      if (!editing) return
      event.preventDefault()
      event.stopPropagation()
      setEditing(null)
      listRef.current?.querySelectorAll('article')[focusIndex]?.focus()
      return
    }
    if (event.key === 'Enter' && target.tagName === 'ARTICLE') {
      event.preventDefault()
      const part = pageRows[focusIndex]
      if (part) setEditing(editing === part.id ? null : part.id)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const next = rovingIndex(event.key, focusIndex, pageRows.length)
    setRowFocus(next)
    const row = listRef.current?.querySelectorAll('article')[next]
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: 'nearest' })
  }
  const searchKey = roleNameKey(query)
  const listedRoles = split.inChapter.filter(role => roleMatchesQuery(role, searchKey))
  const roleIds = new Map(roles.map(role => [role.id, role]))
  function lineVoice(roleId) {
    if (!directory.voices || keyMissing) return t('自动')
    const role = roleIds.get(roleId)
    const manual = role?.voices?.[engine]
    const id = manual || assigned?.get(roleId) || ''
    if (!id) return t('自动')
    const name = directory.voices.find(voice => voice.id === id)?.name || id
    if (manual || (roleId === 'narrator' && narratorDefault && id === narratorDefault.voiceId)) return name
    return t('自动 · {name}', { name })
  }
  const pickerAutomatic = useMemo(() => {
    if (!picking) return ''
    const stripped = roles.map(role => {
      if (role.id !== picking) return role
      const voices = { ...role.voices }
      delete voices[engine]
      return { ...role, voices }
    })
    return effectiveVoices(chapter, stripped, directory.voices, engine, chapter?.voiceRule, narratorDefault)?.get(picking) || ''
  }, [picking, roles, chapter, directory.voices, engine, narratorDefault])
  const canPickVoice = roleId => !keyMissing && Boolean(saveVoice) && (roleId === 'narrator' || chapter.roles?.some(role => role.id === roleId))
  function controls(part, label) {
    return <ScriptRowEditor part={part} roles={listedRoles} others={split.others} disabled={readOnly} label={label} change={patch=>change(part,patch)} newRole={newRole} engine={engine}/>
  }
  const batchExcerpt = () => {
    const jobId = chapter.playbackJob?.id
    const media = chapter.media ?? []
    if (!jobId || !media.length || !selection.size) return
    const selectedParts = groups.filter(part => selection.has(part.id))
    if (!selectedParts.length) return
    const minStart = Math.min(...selectedParts.map(p => p.start))
    const maxEnd = Math.max(...selectedParts.map(p => p.end))
    const indices = []
    media.forEach((m, idx) => {
      if (m.ready && m.end > minStart && m.start < maxEnd) indices.push(idx)
    })
    if (!indices.length) return
    void startExcerptDownload({ job: jobId, from: indices[0], to: indices.at(-1), format: 'mp3', subtitles: 'srt', speakers: true, title: chapter.title, notify })
  }
  const canExcerpt = Boolean(chapter.playbackJob?.id && chapter.media?.some(m => m.ready) && selection.size > 0)
  return <section className="lv-editor" aria-label={t("角色与台词")}>
    <div className="lv-heading"><small>{groups.length}{" " + t("段 · 按当前模式：")}{mode === 'multi' ? t('多角色演绎') : t('单人朗读')} · {draft ? t('修改尚未保存') : t('点击「调整」编辑配音')}{plan?.status === 'ok' ? t(" · 已合成 {v1} / {v2} 段", { v1: groups.filter(part => rowAudio(part, plan).audio === 'ready' && !rowChanged(part, state.annotations, chapter.editorial?.annotations)).length, v2: groups.length }) : ''}</small>
      {draft && <div className="lv-inline"><button disabled={busy} onClick={() => setDraft(null)}>{t("放弃台词草稿")}</button>
        {stale && <button onClick={() => navigator.clipboard.writeText(JSON.stringify(draft.annotations, null, 2))
          .then(() => notify(deferText(() => t('已复制台词标注草稿'))), () => notify(deferText(() => t('无法访问剪贴板。'))))}>{t("复制台词标注")}</button>}</div>}
    </div>
    {stale && <p role="status">{t("本章已有新结果。请先复制需要保留的台词修改，或放弃草稿后重新编辑。")}</p>}
    {textDirty && <p role="status">{t("正文有未保存修改。请先保存正文，再编辑新台词。")}</p>}
    <RemovedLines chapter={chapter} state={state} setDraft={setDraft} readOnly={readOnly}/>
    {roles.length > 40 && <label>{t("筛选可改派的角色")}<input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("输入角色名查看更多")}/></label>}
    {plan?.status === 'needs-script' && <p role="status">{t("多角色演绎还没有可用台词，开始制作时会先编剧。")}</p>}
    {plan?.status === 'pending' && <p role="status">{t("正在准备这一章的分段，好了会显示哪些已经合成。")}</p>}
    {plan?.status === 'clean' && <p role="status">{t("开启了清洗，要等这次制作开始后才能判断哪些段已有音频。")}</p>}
    {mode === 'reading' && <p role="status">{t("当前是单人朗读，角色和语气不会用到。")}</p>}
    {retakeBlock && engine === 'laivox' && plan?.status === 'ok' && groups.some(part => rowAudio(part, plan).audio === 'ready') && <p role="status">{retakeBlock}</p>}
    {plan?.status === 'needs-engine' && <p role="status">{plan.reason ? explain(plan.reason) : t("用 LaiVox 开始制作后，会显示哪些段已经合成。")}<button type="button" onClick={() => setPlanTry(value => value + 1)}>{t("重试")}</button></p>}
    <div className="lv-script-filters"><div className="lv-chip-row"><button className="lv-chip" aria-pressed={!roleFilter} onClick={()=>setRoleFilter('')}>{t("全部")}</button>{split.inChapter.map(role=><button className="lv-chip" key={role.id} aria-pressed={roleFilter===role.id} onClick={()=>setRoleFilter(role.id)}><i className="lv-role-dot" style={{'--lv-role-color':roleColor(role.id)}}/>{roleDisplayName(role)} · {groups.filter(part=>part.roleId===role.id).length}</button>)}</div>
      <div className="lv-inline"><label className="lv-check"><input type="checkbox" checked={dialogueOnly} onChange={e=>setDialogueOnly(e.target.checked)}/>{t("只看对白")}</label><input aria-label={t("搜索台词")} value={search} onChange={e=>setSearch(e.target.value)} placeholder={t("搜索台词")}/><button aria-pressed={selecting} onClick={()=>{setSelecting(!selecting);setSelection(new Set())}}>{t("批量选择")}</button></div>
      {selecting && <div className="lv-inline"><span>{t("已选") + " "}{selection.size}{" " + t("段")}</span><button disabled={readOnly} onClick={()=>setSelection(new Set(filtered.map(part=>part.id)))}>{t("全选筛选结果")}</button>
        <select aria-label={t("批量改派说话人")} disabled={readOnly || !selection.size} value="" onChange={e=>batchChange({roleId:e.target.value})}><option value="">{t("改派说话人")}</option>{roles.map(role=><option key={role.id} value={role.id}>{roleDisplayName(role)}</option>)}</select>
        <select aria-label={t("批量设置情绪")} disabled={readOnly || !selection.size} value="" onChange={e=>batchChange({emotion:e.target.value,intensity:presetIntensity(e.target.value),instruct:INSTRUCT_PRESETS[e.target.value][0]})}><option value="">{t("设置情绪")}</option>{Object.entries(labels).map(([id,label])=><option key={id} value={id}>{t(label)}</option>)}</select>
        <button disabled={readOnly || !selection.size} onClick={()=>batchChange({instruct:undefined})}>{t("清除语气")}</button>
        {canExcerpt && <button type="button" onClick={batchExcerpt}>{t("导出高光片段")}</button>}</div>}
    </div>
    <div className="lv-script" ref={listRef} onKeyDown={onRowKey}>{pageRows.map((part, index) => {
      const { roleId, emotion } = part
      const number = groups.indexOf(part) + 1
      const facts = lineFacts(part)
      const ready = plan?.status === 'ok' && !facts.changed && facts.audio.audio === 'ready'
      const speaker = roleDisplayName(roleIds.get(roleId)) ?? (roleId === 'narrator' ? t('旁白') : t('待改派'))
      const op = chapter.operation
      const opPending = op ? actions?.get(op.id) : null
      const retakeError = facts.retakeState === 'paused' && op?.error ? explain(op.retryAfter ? { message: op.error, retryAfter: op.retryAfter } : op.error) : ''
      const pauseSpec = facts.retakeState === 'paused' ? pauseActionSpec(op?.laivoxPause, packPage) : null
      return <article key={part.id} tabIndex={selecting ? undefined : (index === focusIndex ? 0 : -1)} style={{'--lv-role-color':roleColor(part.roleId)}} data-dialogue={part.roleId !== 'narrator'} onFocus={() => setRowFocus(index)}>
        {selecting && <input className="lv-script-check" type="checkbox" aria-label={t("选择第 {v1} 段", { v1: number })} checked={selection.has(part.id)} onChange={e=>setSelection(current=>{const next=new Set(current);if(e.target.checked) next.add(part.id);else next.delete(part.id);return next})}/>}
        <div className="lv-script-who"><span>{number} · {speaker}</span><small>{part.intensity===2?t('强烈 · '):''}{t(labels[emotion])}</small><small>{lineVoice(roleId)}{canPickVoice(roleId) && <button type="button" className="lv-link" disabled={busy} onClick={() => setPicking(roleId)}>{t('换音色')}</button>}</small></div>
        <div className="lv-script-main">
          <p>{part.text}</p>
          <button className="lv-direction" onClick={()=>setEditing(part.id)}>{part.instruct ? '— '+part.instruct : t('旧版语气')}</button>
          {retakeError && <small className="lv-script-error" role="alert">{retakeError}</small>}
          {editing === part.id && <>
            {controls(part, t("第 {v1} 段", { v1: number }))}
            {part.sourceIds.length > 1 && <details className="lv-script-detail"><summary>{t("分别调整片段")}</summary>
              {part.sourceIds.map(id => <div className="lv-script-fragment" key={id}>
                <p>{segments[id].text}</p>
                {controls({ ...segments[id], ...state.annotations[id], sourceIds: [id] }, t("原始片段 {v1} ", { v1: id + 1 }))}
              </div>)}
            </details>}
          </>}
        </div>
        <div className="lv-script-actions">
          {facts.status && <small className="lv-script-status" data-error={Boolean(retakeError) || undefined}>{facts.status}</small>}
          <button className="lv-subtle" aria-expanded={editing === part.id} aria-label={t("调整第 {v1} 段", { v1: number })} onClick={() => setEditing(editing === part.id ? null : part.id)}>{editing === part.id ? t('收起') : t('调整')}</button>
          {plan?.status === 'ok' && facts.audio.audio !== 'ready' && <button disabled={Boolean((chapter.operation?.laivoxPause && ['quota', 'account', 'membership', 'outdated', 'voice'].includes(chapter.operation.laivoxPause.kind) && chapter.operation.state === 'paused') || (chapter.operation?.retake && ['queued', 'running', 'paused'].includes(chapter.operation.state)))} onClick={() => synthesize(part)}>{chapter.operation?.state === 'running' && chapter.operation?.scope !== 'range' && chapter.operation?.mode === mode ? t('先合成这段') : t('合成这段')}</button>}
          {facts.retakeState === 'active' && jobAction && <span className="lv-script-retake-actions">
            <button type="button" className="lv-subtle" disabled={Boolean(opPending)} aria-label={t('取消重新合成第 {v1} 段', { v1: number })} onClick={() => void jobAction(op.id, 'cancel')}>{opPending === 'cancel' ? t('正在取消') : t('取消')}</button>
          </span>}
          {facts.retakeState === 'paused' && jobAction && <span className="lv-script-retake-actions">
            {pauseSpec?.type === 'settings' && openSettings && <button type="button" className="lv-primary" onClick={openSettings}>{t(pauseSpec.label)}</button>}
            {pauseSpec?.type === 'openDay' && openDay && <button type="button" className="lv-primary" onClick={openDay}>{t(pauseSpec.label)}</button>}
            {pauseSpec?.type === 'roles' && openRoles && <button type="button" className="lv-primary" onClick={openRoles}>{t(pauseSpec.label)}</button>}
            {pauseSpec?.type === 'link' && <a className="lv-link" href={pauseSpec.href} target="_blank" rel="noopener noreferrer" onPointerEnter={onPreparePack} onFocus={onPreparePack} onClick={() => notePackOpened()}>{t(pauseSpec.label)}</a>}
            <button type="button" className="lv-subtle" disabled={Boolean(opPending)} aria-label={t('重试重新合成第 {v1} 段', { v1: number })} onClick={() => void jobAction(op.id, 'resume')}>{opPending === 'resume' ? t('正在继续') : t('重试')}</button>
            <button type="button" className="lv-subtle" disabled={Boolean(opPending)} aria-label={t('取消重新合成第 {v1} 段', { v1: number })} onClick={() => void jobAction(op.id, 'cancel')}>{opPending === 'cancel' ? t('正在取消') : t('取消')}</button>
          </span>}
          {facts.changed && mode !== 'reading' && <button disabled={busy} onClick={() => void saveAndRetake(part)}>{t('保存并重做本句')}</button>}
          <span className="lv-script-extra">
            {ready && <button className="lv-script-preview" aria-label={t("试听第 {v1} 段", { v1: number })} onClick={() => previewRow(part)}><Icon name="Play"/></button>}
            {ready && engine === 'laivox' && !facts.retakeState && <button className="lv-subtle" disabled={busy || Boolean(retakeBlock)}
              title={retakeBlock || t('再合成一次这一段，听感会不同；计入 LaiVox 用量')}
              aria-label={t("重新合成第 {v1} 段", { v1: number })} onClick={() => retake(part)}>{t("重新合成")}</button>}
          </span>
        </div>
      </article>
    })}</div>
    <div className="lv-inline">
      {shown > 0 && <button onClick={() => setPage(shown - 1)}>{t("上一页")}</button>}
      {shown < max && <button onClick={() => setPage(shown + 1)}>{t("下一页")}</button>}
    </div>
    {picking && <VoicePicker engine={engine} directory={directory} voice={roles.find(role => role.id === picking)?.voices?.[engine] ?? ''} narrator={picking === 'narrator'}
      automatic={pickerAutomatic} automaticName={directory.voices?.find(voice => voice.id === pickerAutomatic)?.name || pickerAutomatic}
      book={chapter.book} roleName={roleDisplayName(roleIds.get(picking) ?? { id: picking, name: '' })} close={() => setPicking(null)} player={player} notify={notify}
      choose={(voice, extra) => saveVoice(picking, engine, voice, extra)}/>}
  </section>
}
