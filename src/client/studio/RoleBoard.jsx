import { roleDisplayName, roleMatchesQuery } from '../i18n/display.mjs'
import { deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { roleColor } from '../stage/roleColor.mjs'
import { roleNameKey } from '../../domain/production.mjs'
import { ROLE_AGES } from '../../domain/voice-assignment.mjs'
import { chapterRoles, mergeRoles } from '../workbench/state.mjs'
import { scriptGroups } from './scriptAudio.mjs'
import { changedAutomaticVoices, effectiveVoices, narratorDefaultFor, sharedVoice } from './voiceLabels.mjs'
import { useVoiceDirectory, VoicePicker } from '../editorial/VoicePicker.jsx'
import { explain, getAudio } from '../api.mjs'
import { Icon } from '../components/Icon.jsx'
import { Overlay } from '../components/Overlay.jsx'
import { previewChannel } from '../player/previewChannel.mjs'

const AGE_LABELS = { child: '儿童', teen: '少年', young: '青年', middle: '中年', elder: '老年' }
const describe = role => [role.gender === 'female' ? t('女') : role.gender === 'male' ? t('男') : '', AGE_LABELS[role.age] ? t(AGE_LABELS[role.age]) : ''].filter(Boolean).join(' · ')
// Edge voices only stand in for each other within one language prefix.
const family = (engine, id) => engine === 'edge' ? String(id).split('-').slice(0, 2).join('-') : ''

export function RoleBoard({ roles, chapter, scriptDraft, roleDraft, conflicts, edit, saveVoice, saveProfile, upgradeRule, decide, resolve, discard, options, player, notify, busy, requestNew, keyInfo, shownEngine, openSettings, narratorSetting, openScript, onCreated, onBlankCreate }) {
  const blankForm = () => ({ id: crypto.randomUUID(), create: true, name: '', gender: '', age: '' })
  const [form, setForm] = useState(null)
  const [formProblem, setFormProblem] = useState('')
  const [formPending, setFormPending] = useState(false)
  useEffect(() => { if (requestNew) { setFormProblem(''); setForm(blankForm()) } }, [requestNew])
  const [picking, setPicking] = useState(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [preview, setPreview] = useState(null)
  const previewToken = useRef(0)
  const engine = shownEngine || options.engine
  const edgeDirectory = useVoiceDirectory('edge')
  const directory = useVoiceDirectory(engine)
  const directoryFor = name => name === 'edge' ? edgeDirectory : directory
  const voiceName = (name, id) => directoryFor(name).voices?.find(voice => voice.id === id)?.name || id
  const groups = useMemo(() => scriptGroups(chapter, scriptDraft), [chapter, scriptDraft])
  const split = useMemo(() => chapterRoles(roles, groups, roleDraft), [roles, groups, roleDraft])
  const counts = useMemo(() => new Map(split.inChapter.map(role => [role.id, role.count])), [split])
  // What planning will use: same rule, same parts, same catalogue. With an
  // unsaved draft these are the voices after saving.
  const narratorDefault = narratorDefaultFor(engine, keyInfo?.account, directory.voices, narratorSetting)
  const voices = useMemo(() => effectiveVoices(chapter, roles, directory.voices, engine, chapter?.voiceRule, narratorDefault),
    [chapter, roles, directory.voices, engine, narratorDefault])
  const edgeVoices = useMemo(() => engine === 'edge' ? voices : effectiveVoices(chapter, roles, edgeDirectory.voices, 'edge'),
    [engine, voices, chapter, roles, edgeDirectory.voices])
  const cascade = useMemo(() => {
    if (!roleDraft) return []
    const saved = effectiveVoices(chapter, mergeRoles(chapter, null).roles, directory.voices, engine, chapter?.voiceRule, narratorDefault)
    return changedAutomaticVoices(saved, voices, roles, engine)
  }, [roleDraft, chapter, directory.voices, engine, voices, roles, narratorDefault])
  const ruleChanges = useMemo(() => chapter.voiceRule === 1
    ? changedAutomaticVoices(voices, effectiveVoices(chapter, roles, directory.voices, engine, 2, narratorDefault), roles, engine) : [],
  [chapter, voices, roles, directory.voices, engine, narratorDefault])
  const searchKey = roleNameKey(query)
  const filtered = (query.trim() ? roles : split.inChapter).filter(role => roleMatchesQuery(role, searchKey))
  const maximum = Math.max(0, Math.ceil(filtered.length / 24) - 1)
  const shown = Math.min(page, maximum)
  // Two roles of this chapter sharing a voice, when another voice is free to
  // tell them apart (an Edge chapter in Traditional Chinese has only two).
  const usedHere = new Set(split.inChapter.map(role => voices?.get(role.id)))
  const clash = role => {
    if (role.id === 'narrator' || !voices) return null
    const other = sharedVoice(role, voices, split.inChapter)
    if (!other) return null
    const mine = voices.get(role.id)
    const spare = (directory.voices ?? []).some(voice => voice.auto !== false && voice.usable !== false && !usedHere.has(voice.id) && family(engine, voice.id) === family(engine, mine))
    return spare ? other : null
  }
  // A chosen LaiVox voice that was deleted in the extension or is locked for the membership.
  const laivoxVoiceGone = role => engine === 'laivox' && Boolean(role.voices?.laivox) && Array.isArray(directory.voices)
    && !directory.voices.some(voice => voice.id === role.voices.laivox && voice.usable !== false)
  const keyMissing = engine === 'laivox' && keyInfo?.configured === false
  const previewVoice = (role, name, assigned) => role.voices?.[name] || assigned?.get(role.id) || ''
  const previewKeyOf = (role, name, assigned) => {
    const id = previewVoice(role, name, assigned)
    return id ? 'role:' + role.id + ':' + name + ':' + id : ''
  }
  useEffect(() => {
    const channel = previewChannel()
    if (!channel?.subscribe) return undefined
    return channel.subscribe(() => {
      const key = channel.currentKey()
      setPreview(current => {
        if (!current) return null
        if (key === current.key) return current.phase === 'playing' ? current : { ...current, phase: 'playing' }
        if (!key && current.phase === 'loading') return current
        return null
      })
    })
  }, [player])
  async function previewRole(role, name, assigned) {
    const id = previewVoice(role, name, assigned)
    const channel = previewChannel()
    if (!id || !channel || (name === 'laivox' && keyMissing)) return
    const key = previewKeyOf(role, name, assigned)
    if (channel.currentKey() === key || preview?.key === key) {
      previewToken.current++
      channel.stop()
      setPreview(null)
      return
    }
    const mine = ++previewToken.current
    setPreview({ key, phase: 'loading' })
    try { await channel.play(key, [signal => getAudio(name, id, signal)]) }
    catch (error) { if (mine === previewToken.current) notify(deferText(() => explain(error))) }
    finally { if (mine === previewToken.current) setPreview(null) }
  }
  function voiceLabel(role, name, assigned) {
    if (role.voices?.[name]) return voiceName(name, role.voices[name])
    const automatic = assigned?.get(role.id)
    if (role.id === 'narrator' && narratorDefault && automatic === narratorDefault.voiceId) return voiceName(name, automatic)
    return automatic ? t('自动 · {name}', { name: voiceName(name, automatic) }) : t('自动')
  }
  const pickerCatalog = picking ? directoryFor(picking.engine).voices : null
  const pickerAutomatic = useMemo(() => {
    if (!picking) return ''
    const stripped = roles.map(item => {
      if (item.id !== picking.id) return item
      const next = { ...item.voices }
      delete next[picking.engine]
      return { ...item, voices: next }
    })
    return effectiveVoices(chapter, stripped, pickerCatalog, picking.engine, chapter?.voiceRule, narratorDefault)?.get(picking.id) || ''
  }, [picking, roles, chapter, pickerCatalog, narratorDefault])
  // A role that exists only in the unsaved draft cannot be saved on its own.
  const draftOnly = id => id !== 'narrator' && !chapter.roles?.some(role => role.id === id)
  async function confirmUpgrade() {
    const shownChanges = ruleChanges.slice(0, 8).map(change => roleDisplayName(change.role) + '：' + voiceName(engine, change.from) + ' → ' + voiceName(engine, change.to))
    const choice = await decide({
      title: deferText(() => t('按新规则重新分配音色？')),
      text: deferText(() => t('自动分配会按性别和年龄重新挑选：{list}{more}。这些角色已生成的音频会在下次制作时重新合成，LaiVox 按用量计费；手动选过的音色不变。',
        { list: shownChanges.join('；'), more: ruleChanges.length > 8 ? t('等 {count} 个角色', { count: ruleChanges.length }) : '' })),
      choices: [['upgrade', deferText(() => t('重新分配'))], [null, deferText(() => t('取消'))]],
    })
    if (choice === 'upgrade') await upgradeRule()
  }
  const valid = form?.name.trim() && !roles.some(role => role.id !== form.id && roleNameKey(role.name) === roleNameKey(form.name))
  const formDirty = Boolean(form) && (form.create
    ? Boolean(form.name || form.gender || form.age)
    : ['name', 'gender', 'age'].some(field => form[field] !== (form.original?.[field] ?? '')))
  function closeForm() {
    if (!formDirty) { setForm(null); setFormProblem(''); setFormPending(false); return }
    void decide({
      title: deferText(() => t('放弃这次修改？')),
      text: deferText(() => t('这次填写的内容会丢失。')),
      choices: [['discard', deferText(() => t('放弃修改'))], [null, deferText(() => t('继续编辑'))]],
      destructive: true,
    }).then(choice => { if (choice === 'discard') { setForm(null); setFormProblem(''); setFormPending(false) } })
  }
  function openEditor(role) {
    setFormProblem('')
    setForm({ id: role.id, name: role.name, gender: role.gender || '', age: role.age ?? '', original: role })
  }
  async function submitForm(event) {
    event.preventDefault()
    if (!valid || busy || roleDraft || !saveProfile) return
    const { original, ...patch } = form
    const changed = field => patch[field] !== (original?.[field] ?? '')
    const body = {
      id: patch.id, ...(patch.create ? { create: true } : {}),
      ...(!original || changed('name') ? { name: patch.name.trim() } : {}),
      ...(!original || changed('gender') ? { gender: patch.gender } : {}),
      ...((original ? changed('age') : patch.age) ? { age: patch.age } : {}),
    }
    const result = await saveProfile(body)
    if (result?.ok) {
      const created = patch.create
      setForm(null)
      setFormProblem('')
      setFormPending(false)
      if (created) onCreated?.(patch.id)
      return
    }
    if (result?.reason === 'dismissed' || result?.reason === 'busy') return
    setFormPending(result?.reason === 'pending')
    setFormProblem(result?.reason === 'conflict' ? t('角色已在别处修改，已载入最新内容，请再保存一次。') : explain(result?.error || { message: 'SERVICE_UNAVAILABLE' }))
  }
  const formKey = form ? [form.id, form.name, form.gender, form.age].join('\u0000') : ''
  const formVoices = useMemo(() => {
    if (!form || !directory.voices?.length) return null
    const nextRole = { id: form.id, name: form.name, gender: form.gender, age: form.age, voices: roles.find(role => role.id === form.id)?.voices ?? {} }
    if (nextRole.voices?.[engine]) return { manual: true }
    const nextRoles = roles.some(role => role.id === form.id) ? roles.map(role => role.id === form.id ? { ...role, ...nextRole } : role) : [...roles, nextRole]
    const next = effectiveVoices(chapter, nextRoles, directory.voices, engine, chapter?.voiceRule, narratorDefault)
    return { afterId: next?.get(form.id) || '', others: changedAutomaticVoices(voices, next, nextRoles, engine).filter(change => change.role.id !== form.id) }
  }, [formKey, roles, chapter, directory.voices, engine, narratorDefault, voices])
  function formPreview() {
    if (!formVoices) return t('正在读取音色…')
    if (formVoices.manual) return t('已手动指定音色，性别和年龄不会改变它。')
    const afterName = formVoices.afterId ? voiceName(engine, formVoices.afterId) : t('自动')
    const beforeId = voices?.get(form.id) || ''
    const self = beforeId && formVoices.afterId && beforeId !== formVoices.afterId
      ? t('本章自动音色：{from} → {to}', { from: voiceName(engine, beforeId), to: afterName })
      : t('本章自动音色：{name}', { name: afterName })
    return formVoices.others.length ? self + t('。同时改变：{names}', { names: formVoices.others.slice(0, 6).map(change => roleDisplayName(change.role)).join('、') }) : self
  }
  const working = Boolean(chapter.operation && ['queued', 'running', 'paused'].includes(chapter.operation.state))
  function countLabel(role) {
    if (!counts.has(role.id)) return t('书内角色')
    const count = counts.get(role.id)
    const label = t("本章 {v1} 段", { v1: count })
    if (count > 0 && openScript) return <button type="button" className="lv-link" onClick={() => openScript(role.id)}>{label}</button>
    return label
  }
  function previewButton(role, name, assigned) {
    const key = previewKeyOf(role, name, assigned)
    const mine = preview?.key === key
    const icon = mine && preview.phase === 'loading' ? 'LoaderCircle' : mine ? 'Pause' : 'Play'
    const label = mine && preview.phase === 'loading' ? t('正在试听') : mine ? t('停止试听') : t('试听')
    return <button type="button" className="lv-subtle lv-role-preview" aria-label={label + ' ' + roleDisplayName(role)} disabled={busy || !key || keyMissing || !previewChannel()} title={keyMissing ? t('连接 LaiVox 后可选') : label} onClick={() => previewRole(role, name, assigned)}><Icon name={icon}/></button>
  }
  function voiceButton(role, name, assigned) {
    const label = keyMissing ? t('连接 LaiVox 后可选') : voiceLabel(role, name, assigned)
    return <button className="lv-role-pick" disabled={busy || keyMissing} title={label} onClick={() => setPicking({ id: role.id, engine: name })} aria-label={t("为{v1}选择音色", { v1: roleDisplayName(role) })}><span>{label}</span><small>{t("换一个")}</small></button>
  }
  return <div className="lv-panel-content">
    <div className="lv-heading"><small>{t('本章出场 {count} 个角色 · 音色设置作用于《{title}》全书。', { count: split.inChapter.length, title: chapter.bookTitle })}{engine === 'edge' ? ' ' + t('当前为 Edge 在线语音；改用 LaiVox（推荐 · 增值付费）可使用拟人情感演绎与自有音色。') : ' ' + t('当前为 LaiVox（推荐 · 增值付费）。')}</small>
      <button disabled={busy} onClick={() => { onBlankCreate?.(); setFormProblem(''); setForm(blankForm()) }}>{t("新增角色")}</button></div>
    {options.mode === 'reading' && <p role="status">{t("当前是单人朗读，角色和语气不会用到。")}</p>}
    {ruleChanges.length > 0 && <div className="lv-heading lv-rule-note"><small>{working ? t('本书沿用旧的自动分配规则（制作结束后可改用新规则）') : t('本书沿用旧的自动分配规则')}</small>
      <button disabled={busy || working || Boolean(roleDraft)} title={roleDraft ? t('先保存或放弃角色修改') : undefined} onClick={() => void confirmUpgrade()}>{t('按新规则重新分配')}</button></div>}
    {roleDraft && <div className="lv-heading"><small role="status">{t("角色修改尚未保存")}</small><button disabled={busy} onClick={() => { setForm(null); setFormProblem(''); discard() }}>{t("放弃配音草稿")}</button></div>}
    {cascade.length > 0 && <small role="status" className="lv-role-clash">{t('保存后 {count} 个角色的自动音色会改变：{names}。这些角色已生成的音频会重新合成。',
      { count: cascade.length, names: cascade.slice(0, 6).map(change => roleDisplayName(change.role)).join('、') + (cascade.length > 6 ? '…' : '') })}</small>}
    {conflicts.map(conflict => <div key={conflict.role + ':' + conflict.field} className="lv-card">
      <p>{roleDisplayName(roles.find(role => role.id === conflict.role))} · {t('{field}已变化', { field: t(conflict.label) })}</p>
      {conflict.field !== 'create' && <small>{t("当前") + " "}{conflict.live || t('未设置')}{" " + t("· 草稿") + " "}{conflict.value || t('未设置')}</small>}
      <div className="lv-inline"><button disabled={busy} onClick={() => resolve(conflict, false)}>{t("使用当前值")}</button>
        {conflict.field !== 'create' && <button disabled={busy} onClick={() => resolve(conflict, true)}>{t("保留草稿值")}</button>}</div>
    </div>)}
    {roles.length > 6 && <label>{t("搜索角色")}<input placeholder={t("按角色名搜索")} value={query} onChange={event => { setQuery(event.target.value); setPage(0) }}/></label>}
    <div className="lv-role-grid">{filtered.slice(shown * 24, (shown + 1) * 24).map(role => {
      const other = clash(role)
      return <article className="lv-card lv-role-card" key={role.id} style={{'--lv-role-color':roleColor(role.id)}}>
        <div className="lv-role-head">
          <div><strong>{roleDisplayName(role)}</strong><small>{countLabel(role)}{describe(role) ? ' · ' + describe(role) : ''}</small></div>
          {role.id !== 'narrator' && <button type="button" className="lv-subtle lv-icon-button" aria-label={t('编辑 {name}', { name: roleDisplayName(role) })} disabled={busy} onClick={() => openEditor(role)}><Icon name="Pencil"/></button>}
        </div>
        {other && <small className="lv-role-clash">{t('与「{name}」同一音色 ·', { name: roleDisplayName(other) }) + " "}<button type="button" className="lv-link" disabled={busy} onClick={() => setPicking({id:role.id,engine})}>{t("换一个")}</button></small>}
        {laivoxVoiceGone(role) && <small className="lv-role-clash">{t("音色不可用 ·") + " "}<button type="button" className="lv-link" disabled={busy} onClick={() => setPicking({id:role.id,engine:'laivox'})}>{t("换一个")}</button></small>}
        <div className="lv-role-voice">
          {previewButton(role, engine, voices)}
          {voiceButton(role, engine, voices)}
          {keyMissing && <button type="button" className="lv-link" onClick={() => openSettings?.()}>{t('打开设置')}</button>}
        </div>
        {engine === 'laivox' && <details className="lv-role-edge"><summary title={t('仅在手动用 Edge 补完剩余段时使用')}>{t('备用 Edge')}</summary>
          <button className="lv-subtle" disabled={busy} onClick={() => setPicking({ id: role.id, engine: 'edge' })}>{voiceLabel(role, 'edge', edgeVoices)}</button></details>}
      </article>
    })}</div>
    {!query.trim() && split.others.length > 0 && <details className="lv-role-others"><summary>{t("全书其他角色（")}{split.others.length}）</summary>
      <div className="lv-role-list">{split.others.map(role => <div className="lv-role-row" key={role.id} style={{'--lv-role-color':roleColor(role.id)}}>
        <strong>{roleDisplayName(role)}</strong>
        {previewButton(role, engine, voices)}
        {voiceButton(role, engine, voices)}
        {role.id !== 'narrator' && <button type="button" className="lv-subtle lv-icon-button" aria-label={t('编辑 {name}', { name: roleDisplayName(role) })} disabled={busy} onClick={() => openEditor(role)}><Icon name="Pencil"/></button>}
      </div>)}</div></details>}
    {maximum > 0 && <div className="lv-heading"><button disabled={!shown} onClick={() => setPage(shown - 1)}>{t("上一页")}</button>
      <small>{shown + 1} / {maximum + 1}</small><button disabled={shown === maximum} onClick={() => setPage(shown + 1)}>{t("下一页")}</button></div>}
    {form && <Overlay title={form.create ? t('新增角色') : t('编辑 {name}', { name: roleDisplayName(form.original ?? { id: form.id, name: form.name }) })} close={closeForm}>
      <form className="lv-panel-content" onSubmit={submitForm}>
        <label>{t("角色名")}<input autoFocus value={form.name} maxLength={48} onChange={event => setForm({ ...form, name: event.target.value })}/></label>
        <label>{t("性别")}<select value={form.gender} onChange={event => setForm({ ...form, gender: event.target.value })}>
          <option value="">{t("未标注")}</option><option value="female">{t("女")}</option><option value="male">{t("男")}</option>
        </select></label>
        <label>{t("年龄")}<select value={form.age} onChange={event => setForm({ ...form, age: event.target.value })}>
          <option value="">{t("未标注")}</option>{ROLE_AGES.map(age => <option key={age} value={age}>{t(AGE_LABELS[age])}</option>)}
        </select></label>
        <small role="status">{formPreview()}</small>
        {form.name.trim() && !valid && <small className="lv-error">{t("书中已有同名角色。")}</small>}
        {roleDraft && <small className="lv-error">{t('先保存或放弃角色修改')}</small>}
        {formProblem && <small role="alert" className="lv-error">{formProblem}</small>}
        {formPending && <small role="status">{t('重试会先确认上一次提交的结果；之后改动的内容要在确认后再保存一次。')}</small>}
        <div className="lv-inline"><button type="button" onClick={closeForm}>{t("取消")}</button>
          <button className="lv-primary" disabled={!valid || busy || Boolean(roleDraft)}>{formPending ? t('重试') : t('保存')}</button></div>
      </form>
    </Overlay>}
    {picking && <VoicePicker key={picking.engine + ':' + picking.id} engine={picking.engine} directory={directoryFor(picking.engine)} voice={roles.find(role => role.id === picking.id)?.voices?.[picking.engine] ?? ''} narrator={picking.id === 'narrator'}
      automatic={pickerAutomatic} automaticName={pickerAutomatic ? voiceName(picking.engine, pickerAutomatic) : ''}
      draftOnly={draftOnly(picking.id)} book={chapter.book} roleName={roleDisplayName(roles.find(role => role.id === picking.id) ?? { id: picking.id, name: '' })} close={() => setPicking(null)} player={player} notify={notify}
      choose={(voice, extra) => draftOnly(picking.id) ? edit({ id: picking.id, voices: { [picking.engine]: voice } }) : saveVoice(picking.id, picking.engine, voice, extra)}/>}
  </div>
}
