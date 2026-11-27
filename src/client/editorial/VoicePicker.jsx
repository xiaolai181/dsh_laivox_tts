import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState } from 'react'
import { explain, get, getAudio } from '../api.mjs'
import { previewChannel } from '../player/previewChannel.mjs'
import { Overlay } from '../components/Overlay.jsx'
import { recommendedLaivoxNarrators } from '../../domain/voice-assignment.mjs'

export function useVoiceDirectory(engine) {
  const [loaded, setLoaded] = useState({ engine, voices: null, problem: '' })
  const [retry, setRetry] = useState({ n: 0, fresh: false })
  useEffect(() => {
    const abort = new AbortController()
    setLoaded({ engine, voices: null, problem: '' })
    // fresh re-reads LaiVox voices at once (after changing them in the extension).
    get('voices', { engine, ...(retry.fresh ? { refresh: 1 } : {}) }, abort.signal).then(result => {
      if (!abort.signal.aborted) setLoaded({ engine, voices: result, problem: '' })
    }).catch(error => {
      if (!abort.signal.aborted) setLoaded({ engine, voices: null, problem: deferText(() => explain(error)) })
    })
    return () => abort.abort()
  }, [engine, retry])
  return { ...(loaded.engine === engine ? loaded : { voices: null, problem: '' }),
    reload: () => setRetry(value => ({ n: value.n + 1, fresh: false })), refresh: () => setRetry(value => ({ n: value.n + 1, fresh: true })) }
}

// A LaiVox voice of the user's own that the current membership cannot use.
const LOCKED = '当前账号状态下暂不可用于合成'

// choose(voice) saves the voice and may reject; the panel stays open to show why.
// draftOnly: the role exists only in the unsaved draft, so the voice joins the draft.
export function VoicePicker({ engine, directory, voice, choose, close, player, notify, draftOnly = false, book, roleName = '', narrator = false, automatic = '', automaticName = '' }) {
  const { voices, problem: directoryError, reload, refresh } = directory
  const [selection, setSelection] = useState(voice)
  const [query, setQuery] = useState('')
  const [gender, setGender] = useState('')
  const [age, setAge] = useState('')
  const [page, setPage] = useState(0)
  const [problem, setProblem] = useState('')
  const [tasks, setTasks] = useState(null)
  const [playing, setPlaying] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saveProblem, setSaveProblem] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    if (draftOnly || !book) return undefined
    const abort = new AbortController()
    get('jobs/page', { book, countsOnly: 1 }, abort.signal).then(page => {
      const counts = page?.counts ?? {}
      const total = (counts.running ?? 0) + (counts.queued ?? 0) + (counts.paused ?? 0)
      if (!abort.signal.aborted) setTasks(total)
    }).catch(() => { if (!abort.signal.aborted) setTasks(null) })
    return () => abort.abort()
  }, [book, draftOnly])
  const run = useRef(0)
  function stop(update = true) {
    run.current++
    previewChannel()?.cancelPrefix('voice:' + engine + ':')
    if (update) setPlaying(null)
  }
  useEffect(() => () => { run.current++; previewChannel()?.cancelPrefix('voice:' + engine + ':') }, [engine])

  async function play(id) {
    const channel = previewChannel()
    if (!channel) return
    if (playing?.id === id) { stop(); return }
    const mine = ++run.current
    setProblem(''); setPlaying({ id, loading: true })
    try {
      await channel.play('voice:' + engine + ':' + id, [async signal => {
        const blob = await getAudio(engine, id, signal)
        if (mine === run.current) setPlaying({ id, loading: false })
        return blob
      }])
      if (mine === run.current) setPlaying(null)
    } catch (error) {
      if (mine === run.current) { setPlaying(null); setProblem(deferText(() => explain(error))) }
    }
  }

  async function confirm() {
    stop()
    if (draftOnly) {
      choose(selection)
      close()
      notify(deferText(() => t('音色已加入草稿，保存角色后生效。')))
      return
    }
    setSaving(true); setSaveProblem('')
    try {
      await choose(selection, { confirmedCount: tasks ?? undefined })
      close()
    } catch (error) {
      if (alive.current) setSaveProblem(deferText(() => explain(error)))
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  const labelGender = raw => ['male', '男'].includes(raw) ? 'male' : ['female', '女'].includes(raw) ? 'female' : 'unknown'
  const ages = [...new Set((voices ?? []).map(item => item.age_group ?? item.age ?? t('未标注')))]
  const filtered = (voices ?? []).filter(item => (item.name ?? item.id).toLowerCase().includes(query.trim().toLowerCase()) &&
    (!gender || labelGender(item.gender) === gender) && (!age || (item.age_group ?? item.age ?? t('未标注')) === age))
  // LaiVox lists the presets and, from a gateway that offers them, the user's own voices.
  const grouped = engine === 'laivox' && (voices ?? []).some(item => item.owner)
  const laivoxNarrator = engine === 'laivox' && narrator
  const recommended = laivoxNarrator ? recommendedLaivoxNarrators(filtered) : []
  const presets = filtered.filter(item => !recommended.includes(item) && (!grouped || item.owner !== 'mine'))
  const mine = grouped ? filtered.filter(item => item.owner === 'mine') : []
  const maximum = Math.max(0, Math.ceil(presets.length / 30) - 1)
  const shown = Math.min(page, maximum)
  const usable = !selection || voices?.some(item => item.id === selection && item.usable !== false)
  const unchanged = !draftOnly && (selection || '') === (voice || '')
  const row = item => <div className="lv-voice-row" key={item.id} title={item.usable === false ? t(LOCKED) : undefined}>
    <label className="lv-choice" title={item.name ?? item.id}><input type="radio" name="lv-voice" checked={selection === item.id} disabled={item.usable === false}
      onChange={() => { stop(); setSelection(item.id) }}/><span>{item.name || item.id}</span>
      {<small>{[item.owner === 'mine' ? (item.usable === false ? t(LOCKED) : '') : [item.id.startsWith('en-US') ? t('美式英语') : item.id.startsWith('en-GB') ? t('英式英语') : item.id.startsWith('zh-TW') ? t('繁体中文') : '', item.age === 'child' ? t('童声') : '', item.auto === false ? t('口音，需手动选择') : ''].filter(Boolean).join(' · '), automatic && item.id === automatic ? t('本章自动结果') : ''].filter(Boolean).join(' · ')}</small>}</label>
    <button type="button" aria-label={playing?.id === item.id ? t("停止试听 {v1}", { v1: item.name ?? item.id }) : t("试听 {v1}", { v1: item.name ?? item.id })}
      onClick={() => play(item.id)}>{playing?.id === item.id ? (playing.loading ? t('取消试听') : t('停止')) : t('试听')}</button>
  </div>
  return <Overlay title={t("选择音色")} close={close}>
    <div className="lv-panel-content">
      <label>{t("搜索音色")}<input value={query} onChange={event => { setQuery(event.target.value); setPage(0) }} placeholder={t("按名称搜索")}/></label>
      <div className="lv-inline"><label>{t("性别")}<select value={gender} onChange={event => { setGender(event.target.value); setPage(0) }}>
        <option value="">{t("全部")}</option><option value="female">{t("女声")}</option><option value="male">{t("男声")}</option><option value="unknown">{t("未标注")}</option>
      </select></label>
      {engine === 'laivox' && ages.length > 0 && <label>{t("年龄")}<select value={age} onChange={event => { setAge(event.target.value); setPage(0) }}>
        <option value="">{t("全部")}</option>{ages.map(item => <option key={item}>{item}</option>)}
      </select></label>}</div>
      <label className="lv-choice lv-voice-auto"><input type="radio" name="lv-voice" checked={!selection} onChange={() => { stop(); setSelection('') }}/><span>{laivoxNarrator ? (automaticName ? t('使用默认旁白（本章当前：{name}）', { name: automaticName }) : t('使用默认旁白')) : (automaticName ? t('自动分配（本章当前：{name}）', { name: automaticName }) : t('自动分配'))}</span></label>
      {voices === null && !directoryError && <p role="status">{t("正在读取音色…")}</p>}
      {directoryError && <p role="alert" className="lv-error">{displayText(directoryError)} <button type="button" onClick={reload}>{t("重新加载")}</button></p>}
      {problem && <p role="alert" className="lv-error">{displayText(problem)}</p>}
      {voices && filtered.length === 0 && !grouped && <p className="lv-muted">{t("没有符合筛选条件的音色。")}</p>}
      {recommended.length > 0 && <section aria-label={t('推荐旁白音色')} className="lv-narrator-recommendations">
        <small>{t('推荐旁白音色')}</small>
        <div className="lv-voice-list">{recommended.map(row)}</div>
      </section>}
      {grouped && <div className="lv-heading"><small>{t("系统音色")}</small><button type="button" onClick={refresh}>{t("刷新")}</button></div>}
      <div className="lv-voice-list">{presets.slice(shown * 30, (shown + 1) * 30).map(row)}</div>
      {maximum > 0 && <div className="lv-heading"><button disabled={!shown} onClick={() => setPage(shown - 1)}>{t("上一页")}</button>
        <small>{shown + 1} / {maximum + 1}</small><button disabled={shown === maximum} onClick={() => setPage(shown + 1)}>{t("下一页")}</button></div>}
      {grouped && <><div className="lv-heading"><small>{t("我的音色")}</small><button type="button" onClick={refresh}>{t("刷新")}</button></div>
        {mine.length ? <div className="lv-voice-list">{mine.map(row)}</div>
          : <p className="lv-muted">{t("在 LaiVox 浏览器扩展中上传自有音色后，点此刷新即可使用。")}</p>}</>}
      {!usable && voices && <small role="status">{t("原音色已不可用，请重新选择。")}</small>}
      {/* Stays at the bottom of the panel: the list can be long. */}
      {!draftOnly && <><p role="status">{t("{name} 在本书已生成的音频，会在下次制作时重新合成", { name: roleName })}</p>
        {tasks > 0 && <p role="status">{t("会先停止本书 {count} 个未结束的任务", { count: tasks })}</p>}</>}
      <div className="lv-voice-actions">
        {saveProblem && <small role="alert" className="lv-error">{displayText(saveProblem)}</small>}
        <div className="lv-inline lv-dialog-actions"><button type="button" onClick={close}>{t("取消")}</button>
          <button type="button" className="lv-primary" disabled={unchanged ? false : !usable || saving} onClick={() => { if (unchanged) close(); else void confirm() }}>
            {saving ? t('正在保存…') : unchanged ? t('关闭') : draftOnly ? t('加入草稿') : t('使用此音色')}</button></div>
      </div>
    </div>
  </Overlay>
}
