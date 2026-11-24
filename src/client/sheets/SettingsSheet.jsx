import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useId, useRef, useState } from 'react'
import { explain, formatBytes, get, getAudio, post } from '../api.mjs'
import { useVoiceDirectory } from '../editorial/VoicePicker.jsx'
import { RETENTION_CHOICES, shortenWarning } from '../library/snippets.mjs'
import { ModelOptions } from '../editorial/ModelOptions.jsx'
import { MODE_NAMES } from '../stage/ProductionBar.jsx'
import { engineSettingNote } from '../workbench/enginePitch.mjs'
import { deniedLine, ledgerLine, openUsageDay, shortDate, usageLine } from '../workbench/laivox.mjs'
import { previewChannel } from '../player/previewChannel.mjs'
import { ActivityMark, LevelBar, StorageUsage } from '../components/Metrics.jsx'
import { Icon } from '../components/Icon.jsx'
import { LAIVOX_DEFAULT_NARRATOR, narratorDefaultFor, recommendedLaivoxNarrators } from '../../domain/voice-assignment.mjs'

// Every control here takes effect and is saved as soon as it changes; there is
// no separate save step. Production choices (mode, cleaning, model, engine)
// also apply to the current session right away.

function Appearance({ values, save }) {
  const skin = values.skin ?? 'paper'
  const theme = values.theme ?? 'system'
  return <section className="lv-card"><h3>{t("外观")}</h3>
    <div className="lv-skin-previews" role="group" aria-label={t("风格")}>{[['paper', t('纸墨')], ['graphite', t('石墨')]].map(([value, label]) =>
      <button type="button" key={value} className="lv-ui lv-skin-preview" data-skin={value} data-theme={theme} aria-pressed={skin === value}
        onClick={() => { if (skin !== value) void save({ skin: value }) }}><span>{t("文")}</span>{label}</button>)}</div>
    <div className="lv-segmented" role="group" aria-label={t("明暗")}>{[['system', t('跟随系统')], ['light', t('浅色')], ['dark', t('深色')]].map(([value, label]) =>
      <button type="button" key={value} aria-pressed={theme === value} onClick={() => { if (theme !== value) void save({ theme: value }) }}>{label}</button>)}</div>
  </section>
}

function Listening({ values, save }) {
  return <section className="lv-card"><h3>{t("听书")}</h3>
    <label className="lv-check"><input type="checkbox" checked={values.paragraphPause !== false} onChange={event => void save({ paragraphPause: event.target.checked })}/>{" " + t("段落之间稍作停顿")}</label>
    <label className="lv-check"><input type="checkbox" checked={values.autoContinue !== false} onChange={event => void save({ autoContinue: event.target.checked })}/>{" " + t("章末自动续播下一章")}</label>
  </section>
}

// The LaiVox bar above the chat input. Proposals waiting for confirmation are
// shown under the reply either way; this only decides when the bar appears.
function Conversation({ values, save }) {
  const value = values.chatDock ?? 'auto'
  return <section className="lv-card"><h3>{t("对话工作条")}</h3>
    <div className="lv-segmented" role="group" aria-label={t("输入框上方的 LaiVox 栏")}>{[['auto', t('自动')], ['active', t('只在待确认或制作中')], ['never', t('不显示')]].map(([key, label]) =>
      <button type="button" key={key} aria-pressed={value === key} onClick={() => { if (value !== key) void save({ chatDock: key }) }}>{label}</button>)}</div>
    <small>{t("控制输入框上方的 LaiVox 栏何时显示。「自动」时也会显示「继续听」；待确认的朗读任务和导入始终显示在回答下方。")}</small>
  </section>
}

// Voices for reading chat messages and AI replies aloud, by language.
const SPEECH_LANGUAGES = [['zh-CN', '简体中文', 'zh-CN-'], ['zh-TW', '繁体中文', 'zh-TW-'], ['en', '英文', 'en-']]
const SPEECH_DEFAULTS = { 'zh-CN': 'zh-CN-XiaoxiaoNeural', 'zh-TW': 'zh-TW-HsiaoChenNeural', en: 'en-US-AriaNeural' }
// The voices of one language; the chosen one stays listed even when the
// directory is still loading or no longer has it.
function speechOptions(voices, prefix, chosen) {
  const list = (voices ?? []).filter(voice => voice.id.startsWith(prefix))
  return list.some(voice => voice.id === chosen) ? list : [{ id: chosen, name: chosen }, ...list]
}
function Speech({ values, save }) {
  const chosen = { ...SPEECH_DEFAULTS, ...(values.speechVoices ?? {}) }
  const { voices, problem, reload } = useVoiceDirectory('edge')
  const [preview, setPreview] = useState({ id: null, error: '' })
  const run = useRef(0)
  useEffect(() => () => { run.current++ }, [])
  async function listen(id) {
    const channel = previewChannel()
    if (!channel) return
    if (preview.id === id) {
      if (String(channel.currentKey() ?? '').startsWith('speech:')) channel.stop()
      setPreview({ id: null, error: '' })
      return
    }
    const mine = ++run.current
    setPreview({ id, error: '' })
    try {
      await channel.play('speech:' + id, [signal => getAudio('edge', id, signal)])
      if (mine === run.current) setPreview({ id: null, error: '' })
    } catch (error) {
      if (mine === run.current) setPreview({ id: null, error: deferText(() => explain(error)) })
    }
  }
  return <section className="lv-card"><h3 id="lv-speech">{t("对话消息朗读（Edge）")}</h3>
    <small>{t("仅用于对话里「用 Edge 朗读」和 AI 即时朗读，按文字语言自动选择（不影响小说制作音色）。")}</small>
    {SPEECH_LANGUAGES.map(([key, label, prefix]) => <div className="lv-inline lv-speech-voice" key={key}>
      <label>{t(label)}<select aria-label={t("{v1}朗读音色", { v1: t(label) })} value={chosen[key]} disabled={!voices}
        onChange={event => { if (event.target.value !== chosen[key]) void save({ speechVoices: { ...chosen, [key]: event.target.value } }) }}>
        {speechOptions(voices, prefix, chosen[key]).map(voice =>
          <option key={voice.id} value={voice.id}>{voice.name ?? voice.id}</option>)}
      </select></label>
      <button type="button" aria-label={t("试听{v1}朗读音色", { v1: t(label) })} onClick={() => void listen(chosen[key])}>{preview.id === chosen[key] ? t('停止') : t('试听')}</button>
    </div>)}
    {problem && <div className="lv-inline"><small role="alert" className="lv-error">{displayText(problem)}</small><button type="button" onClick={reload}>{t("重试")}</button></div>}
    {preview.error && <small role="alert" className="lv-error">{displayText(preview.error)}</small>}
    <small>{t("朗读会把文字发送到微软 Edge 在线语音服务，不需要账号。")}</small>
  </section>
}

const ENGINE_NAMES = [['edge', 'Edge 在线语音'], ['laivox', 'LaiVox']]

function Production({ options, choose, models, reloadModels, busy }) {
  return <section className="lv-card"><h3 id="lv-models">{t("制作与发声")}</h3>
    <span className="lv-field-label">{t("发声引擎")}</span>
    <div className="lv-segmented" role="group" aria-label={t("语音引擎")}>{ENGINE_NAMES.map(([value, label]) =>
      <button type="button" key={value} disabled={busy} aria-pressed={options.engine === value}
        title={value === 'laivox' ? t('推荐使用 · 增值付费，需 API Key（支持会员额度或朗读时长包）') : t('内置在线语音 · 无需账号')}
        onClick={() => { if (options.engine !== value) void choose({ engine: value }) }}>
        {t(label)}{value === 'laivox' && <span className="lv-badge-rec">{t('推荐')}</span>}
      </button>)}</div>
    <small>{engineSettingNote(options.engine, options.mode)}</small>
    <span className="lv-field-label">{t("默认制作模式")}</span>
    <div className="lv-segmented" role="group" aria-label={t("默认制作模式")}>{Object.entries(MODE_NAMES).map(([value, label]) =>
      <button type="button" key={value} disabled={busy} aria-pressed={options.mode === value} onClick={() => { if (options.mode !== value) void choose({ mode: value }) }}>{t(label)}</button>)}</div>
    <label className="lv-check"><input type="checkbox" disabled={busy} checked={options.clean} onChange={event => void choose({ clean: event.target.checked })}/>{" " + t("每次制作前先用 AI 清洗正文")}</label>
    <small>{t("关闭时，检测到疑似广告行会在制作条上提示，可只对这一次清洗。")}</small>
    {models?.length ? <ModelOptions models={models} selection={options.selection ?? models[0]} disabled={busy} onChange={selection => void choose({ selection })}/>
      : <div className="lv-inline"><small>{models ? t('请先在 DSH 配置文本模型。') : t('模型列表暂不可用。')}</small><button type="button" onClick={() => reloadModels()}>{t("重试")}</button></div>}
    <small>{t("清洗和编剧会把相关正文发送给所选 DSH 模型，并消耗该模型的额度。开启思考会更耗时与消耗更多额度。")}</small>
  </section>
}

function Storage({ values, save, space, compact, decide, changed }) {
  const stored = Number(values.audioLimit)
  const storedGib = Number.isFinite(stored) && stored > 0 ? Number((stored / 1024 ** 3).toFixed(2)) : 2
  const [limit, setLimit] = useState(String(storedGib))
  const [limitError, setLimitError] = useState('')
  const [storage, setStorage] = useState({ busy: false, message: '' })
  useEffect(() => { setLimit(String(storedGib)) }, [storedGib])
  function commitLimit() {
    const gib = Number(limit)
    if (!Number.isFinite(gib) || gib < 0.5 || gib > 20) { setLimitError(deferText(() => t('音频上限需在 0.5–20 GiB 之间。'))); return }
    setLimitError('')
    const bytes = Math.round(gib * 1024 ** 3)
    if (bytes !== stored) void save({ audioLimit: bytes })
  }
  async function compactStorage() {
    setStorage({ busy: true, message: '' })
    try {
      const result = await compact()
      const before = Number(result?.before) || 0
      const after = Number(result?.after) || 0
      setStorage({ busy: false, message: deferText(() => t("已回收 {v1}（{v2} → {v3}）", { v1: formatBytes(Math.max(0, before - after)), v2: formatBytes(before), v3: formatBytes(after) })) })
    } catch { setStorage({ busy: false, message: '' }) }
  }
  return <section className="lv-card"><h3 id="lv-storage">{t("存储")}</h3>
    <StorageUsage space={space}/>
    <label>{t("音频上限（GiB）")}<input type="number" min="0.5" max="20" step="0.5" value={limit}
      onChange={event => { setLimit(event.target.value); setLimitError('') }} onBlur={commitLimit}
      onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}/></label>
    <small>{t("可设置 0.5–20 GiB，重新打开 DSH 后生效。")}</small>
    <small>{t("新的 LaiVox 段落优先保存为 MP3。转码失败时保留原来的 WAV，已有音频保持原样。")}</small>
    {limitError && <small role="alert" className="lv-error">{displayText(limitError)}</small>}
    <Retention values={values} save={save} decide={decide}/>
    <StaleAudio decide={decide} changed={changed}/>
    <div className="lv-inline"><button type="button" className="lv-metric-action" disabled={storage.busy} onClick={compactStorage}>
      {storage.busy && <ActivityMark state="running"/>}{storage.busy ? t('正在回收…') : t('回收数据库空间')}
    </button></div>
    {storage.message && <small role="status">{displayText(storage.message)}</small>}
  </section>
}

// How long conversation readings stay after the last listen. Shortening it
// deletes the older ones at once, so it asks first when any would go.
function Retention({ values, save, decide }) {
  const value = values.snippetRetention ?? '7d'
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')
  const order = ['1d', '7d', '30d', 'never']
  async function choose(next) {
    if (next === value || checking) return
    setMessage('')
    if (order.indexOf(next) < order.indexOf(value)) {
      setChecking(true)
      let count = 0
      try { count = Number((await get('snippets/expiring', { retention: next }))?.count) || 0 }
      catch (error) { setMessage(deferText(() => explain(error))); setChecking(false); return }
      setChecking(false)
      if (shortenWarning(next, count) && await decide({ title: deferText(() => t('缩短保留期？')),
        text: deferText(() => shortenWarning(next, count)),
        choices: [['save', deferText(() => t('缩短并删除'))], [null, deferText(() => t('返回'))]], destructive: true }) !== 'save') return
    }
    void save({ snippetRetention: next })
  }
  return <>
    <span className="lv-field-label">{t("对话片段保留期")}</span>
    <div className="lv-segmented" role="group" aria-label={t("对话片段保留期")}>{RETENTION_CHOICES.map(([key, label]) =>
      <button type="button" key={key} disabled={checking} aria-pressed={value === key} onClick={() => void choose(key)}>{t(label)}</button>)}</div>
    <small>{t("仅针对对话中生成的片段，从最后一次收听算起；到期后删除正文、音频和播放进度。制作中的不会删除，保存到书架的不受影响。")}</small>
    {message && <small role="alert" className="lv-error">{displayText(message)}</small>}
  </>
}

// Audio made for earlier versions of chapters (before an edit, another voice or
// mode). Measured when the settings open; removed only on request.
export function StaleAudio({ decide, changed }) {
  const [stale, setStale] = useState(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [attempt, reload] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    get('storage/stale-audio', {}, abort.signal).then(result => { if (!abort.signal.aborted) setStale(result) })
      .catch(error => { if (!abort.signal.aborted) setMessage(deferText(() => explain(error))) })
    return () => abort.abort()
  }, [attempt])
  async function clear() {
    if (await decide({ title: deferText(() => t("清理 {v1} 旧版音频？", { v1: formatBytes(stale.bytes) })),
      text: deferText(() => t("涉及 {v1} 章。当前版本和正在收听的完整版本会保留。", { v1: stale.chapters })),
      choices: [['clear', deferText(() => t('清理旧版音频'))], [null, deferText(() => t('返回'))]], destructive: true }) !== 'clear') return
    setBusy(true); setMessage('')
    try {
      const result = await post('storage/stale-audio/clear', {})
      setMessage(deferText(() => t("已清理 {v1}", { v1: formatBytes(result?.bytes) }) + (result?.skipped ? t("，{v1} 章正在制作或导出，稍后可再清理", { v1: result.skipped }) : '')))
      changed?.()
    } catch (error) { setMessage(deferText(() => explain(error))) }
    finally { setBusy(false); reload(n => n + 1) }
  }
  return <>
    <div className="lv-inline">
      <small>{t("旧版音频") + " "}{stale ? formatBytes(stale.bytes) : '—'}</small>
      {stale?.bytes > 0 && <button type="button" disabled={busy} onClick={clear}>{busy ? t('正在清理…') : t('清理')}</button>}
    </div>
    {message && <small role="status">{displayText(message)}</small>}
  </>
}

function NarratorDefault({ account, values, save }) {
  const stored = values?.laivoxNarratorDefault
  const { voices, problem, reload } = useVoiceDirectory('laivox')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const [preview, setPreview] = useState({ playing: false, error: '' })
  const previewKey = 'settings-narrator:' + useId()
  const previewRun = useRef(0)
  useEffect(() => () => {
    previewRun.current++
    previewChannel()?.cancel(previewKey)
  }, [previewKey])
  function stopPreview() {
    previewRun.current++
    previewChannel()?.cancel(previewKey)
    setPreview({ playing: false, error: '' })
  }
  async function listen(voiceId) {
    if (preview.playing) { stopPreview(); return }
    const channel = previewChannel()
    if (!voiceId || !channel) return
    const mine = ++previewRun.current
    setPreview({ playing: true, error: '' })
    try {
      await channel.play(previewKey, signal => getAudio('laivox', voiceId, signal), { restorePlayback: true })
      if (mine === previewRun.current) setPreview({ playing: false, error: '' })
    } catch (error) {
      if (mine === previewRun.current) setPreview({ playing: false, error: deferText(() => explain(error)) })
    }
  }
  async function choose(voiceId) {
    stopPreview()
    setSaving(true)
    setSaveError('')
    try { await save({ laivoxNarratorDefault: voiceId === LAIVOX_DEFAULT_NARRATOR.voiceId ? null : { account, voiceId } }) }
    catch (err) { setSaveError(deferText(() => explain(err))) }
    finally { setSaving(false) }
  }
  const usable = (Array.isArray(voices) ? voices : []).filter(voice => voice?.usable !== false && typeof voice?.id === 'string')
  const selected = narratorDefaultFor('laivox', account, usable, stored)
  const recommended = recommendedLaivoxNarrators(usable)
  const others = usable.filter(voice => voice.owner !== 'mine' && !recommended.includes(voice))
  const options = group => group.map(voice => <option key={voice.id} value={voice.id}>{voice.name || voice.id}</option>)
  const own = usable.filter(voice => voice.owner === 'mine')
  return <div className="lv-laivox-narrator">
    <div className="lv-laivox-voice-control">
      <label>{t('默认朗读／旁白音色')}
        <select value={selected?.voiceId ?? ''} disabled={saving || !voices} onChange={event => void choose(event.target.value)}>
          {!selected && <option value="" disabled>{voices ? t('默认音色不可用') : t('正在读取音色…')}</option>}
          {recommended.length > 0 && <optgroup label={t('推荐旁白音色')}>{options(recommended)}</optgroup>}
          {others.length > 0 && <optgroup label={t('系统音色')}>{options(others)}</optgroup>}
          {own.length > 0 && <optgroup label={t('我的音色')}>{options(own)}</optgroup>}
        </select>
      </label>
      <button type="button" className="lv-metric-action" disabled={saving || !selected} onClick={() => void listen(selected?.voiceId)}
        aria-pressed={preview.playing}>
        {preview.playing ? <ActivityMark state="running" stage="synthesizing"/> : <Icon name="Play" size={14}/>}
        {preview.playing ? t('停止试听') : t('试听')}
      </button>
    </div>
    <small>{t('用于单人朗读和多人制作的旁白。角色单独指定的音色优先。')}</small>
    {stored?.account && stored.account !== account && <small>{t('已保存的默认音色属于另一个账号。')}</small>}
    {voices && stored?.account && stored.account === account && stored.voiceId !== selected?.voiceId && <small>{t('已保存的默认音色目前不可用。')}</small>}
    {problem && <div className="lv-inline"><small role="alert">{displayText(problem)}</small><button type="button" onClick={reload}>{t('重试')}</button></div>}
    {(saveError || preview.error) && <small role="alert">{displayText(saveError || preview.error)}</small>}
  </div>
}

// LaiVox account card: shown once LaiVox is chosen, a key was saved, or the
// user opens the collapsed LaiVox intro. It talks to LaiVox only while mounted.
function LaivoxCard({ keyInfo, reloadKey, decide, values, save, embedded = false }) {
  const [secret, setSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [reading, setReading] = useState(null)
  const [loading, setLoading] = useState(false)
  const [opening, setOpening] = useState(false)
  const statusRequest = useRef(null)
  const configured = keyInfo?.configured === true
  const current = reading?.key === keyInfo ? reading : null
  const status = current?.status
  const usage = current?.usage
  async function load(fresh = false) {
    statusRequest.current?.abort()
    const request = new AbortController()
    statusRequest.current = request
    setReading(previous => previous?.key === keyInfo ? { ...previous, error: '' } : { key: keyInfo })
    if (!configured) { setLoading(false); return }
    setLoading(true)
    try {
      const value = await get('laivox/status', fresh ? { fresh: 1 } : {}, request.signal)
      if (request.signal.aborted) return
      if (!value?.account) throw new Error('SERVICE_UNAVAILABLE')
      const sameLedger = previous => previous?.key === keyInfo && previous.status?.account === value.account && previous.status.ledger === value.ledger
      setReading(previous => value.features?.usage && value.synthesisAllowed !== false && sameLedger(previous)
        ? { ...previous, status: value }
        : { key: keyInfo, status: value })
      if (value.features?.usage && value.synthesisAllowed !== false) {
        const read = await get('laivox/usage', { account: value.account }, request.signal)
        if (request.signal.aborted) return
        if (read?.status === 'ok' && read.usage && (!value.ledger || !read.usage.ledger || value.ledger === read.usage.ledger)) {
          setReading({ key: keyInfo, status: value, usage: read.usage, at: Date.now() })
        } else {
          setReading({ key: keyInfo, status: value, error: deferText(() => t('用量暂时无法读取，请稍后重试。')) })
        }
      }
    } catch (error) {
      if (!request.signal.aborted) {
        const invalid = ['LAIVOX_KEY_REQUIRED', 'LAIVOX_KEY_INVALID', 'LAIVOX_ACCOUNT_CHANGED', 'LAIVOX_KEY_SUSPENDED', 'ACCOUNT_DISABLED'].includes(error.message)
        setReading(previous => ({
          ...(invalid ? {} : previous), key: keyInfo, error: deferText(() => explain(error)),
        }))
      }
    } finally {
      if (!request.signal.aborted) setLoading(false)
    }
  }
  useEffect(() => {
    void load()
    return () => statusRequest.current?.abort()
  }, [keyInfo])
  async function saveKey(event) {
    event.preventDefault()
    setSaving(true); setMessage(''); setFailed(false)
    try {
      const next = await post('key/save', { apiKey: secret })
      statusRequest.current?.abort()
      setReading(null)
      setSecret('')
      await reloadKey(next)
      setMessage(deferText(() => t('Key 已保存')))
    } catch (error) { setFailed(true); setMessage(deferText(() => explain(error))) }
    finally { setSaving(false) }
  }
  async function clearKey() {
    setClearing(true); setMessage(''); setFailed(false)
    try {
      const next = await post('key/clear', {})
      statusRequest.current?.abort()
      setReading(null)
      await reloadKey(next)
      setMessage(deferText(() => t('Key 已清除')))
    } catch (error) { setFailed(true); setMessage(deferText(() => explain(error))) }
    finally { setClearing(false) }
  }
  async function openDay() {
    setOpening(true); setMessage(''); setFailed(false)
    try {
      const result = await openUsageDay(decide)
      if (result.usage) setReading(previous => previous?.key === keyInfo ? { ...previous, usage: result.usage, at: Date.now() } : previous)
      if (result.opened) setMessage(deferText(() => t('已开启下一个使用日')))
      else if (result.message) { setFailed(true); setMessage(result.message) }
    } catch (error) { setFailed(true); setMessage(deferText(() => explain(error))) }
    finally { setOpening(false) }
  }
  const denied = status && status.synthesisAllowed === false
  // Sale paused when the gateway switched the pack feature off: no purchase link.
  const packOnSale = status?.features?.pack !== false
  const packLink = keyInfo?.packPage && packOnSale
    ? <a href={keyInfo.packPage} target="_blank" rel="noopener noreferrer">{status?.ledger === 'pack' && status?.pack?.active ? t('续费朗读时长包 ↗') : t('购买朗读时长包 ↗')}</a>
    : null
  const canOpen = Boolean(!current?.error && usage?.usedUp && usage?.canAuthorize)
  const accountId = status?.account ?? keyInfo?.account
  const masked = status?.account && keyInfo?.account && status.account !== keyInfo.account ? null : keyInfo?.masked
  const account = accountId ? t("已连接账号 {v1}", { v1: accountId }) : t('已连接 LaiVox 账号')
  const expiry = status?.expiresAt ? t('Key 到期 {v1}', { v1: shortDate(status.expiresAt) }) : ''
  const poolExpiry = !denied && usage?.model === 'pool' && usage.state === 'active' && !usage.unlimited ? shortDate(usage.pool?.endsAt) : ''
  const sampled = current?.at ? new Date(current.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  const updatingKey = saving || clearing
  const measured = !denied && usage && !usage.unlimited && ['active', 'provisional'].includes(usage.state) && Number.isFinite(usage.remainingPct)
  return <form className={embedded ? 'lv-laivox-settings lv-laivox-embedded' : 'lv-card lv-laivox-settings'} onSubmit={saveKey}>
    {!embedded && <h3 id="lv-laivox">{configured ? t('LaiVox 已连接') : t('连接 LaiVox（推荐 · 增值付费）')}</h3>}
    {configured && <div className="lv-laivox-account" role="status">
      <small>{t('已连接')}{masked ? '（' + masked + '）' : ''}</small>
      {expiry && <small>{expiry}</small>}
    </div>}
    {!configured && <small>{t("LaiVox 为增值付费引擎：可使用单独购买的朗读时长包，或 LaiVox 会员在官网签发的 API Key。")}</small>}
    {configured && <section className="lv-laivox-quota" aria-label={t('朗读额度')}>
      {status?.outdated && <small role="alert">{t("请更新插件后继续使用 LaiVox。")}</small>}
      {status && !denied && <small className="lv-metric-caption"><Icon name="AudioLines" size={15}/>
        <span>{usage && status.ledger === 'pack' ? t('当前 Key 使用朗读时长包。') : ledgerLine(status)}</span>
      </small>}
      {denied ? <strong role="alert">{deniedLine(status)}</strong>
        : usage ? <strong>{usageLine(usage, { includePoolExpiry: false })}</strong>
        : (loading || current?.error) && <strong>{loading ? t('正在刷新…') : t('朗读剩余未知')}</strong>}
      {measured && <LevelBar label={t('朗读额度')} value={usage.remainingPct}
        tone={current?.error ? 'muted' : usage.remainingPct <= 15 ? 'warn' : 'accent'}/>}
      {!usage && loading && <LevelBar label={t('正在刷新…')} progress busy/>}
      {current?.error && <small role="alert">{displayText(current.error)}</small>}
      {!denied && (poolExpiry || sampled) && <div className="lv-quota-meta">
        {poolExpiry && <small className="lv-metric-caption"><Icon name="Clock3" size={13}/><span>{t('{v1} 到期', { v1: poolExpiry })}</span></small>}
        {sampled && <small>{current?.error
          ? t('显示 {v1} 的上次读数', { v1: sampled })
          : t('更新于 {v1}', { v1: sampled })}</small>}
      </div>}
      <div className="lv-inline">
        {canOpen && <button type="button" className="lv-primary" disabled={opening || loading || updatingKey} onClick={() => void openDay()}>{opening ? t('正在开启…') : t('开启下一个使用日')}</button>}
        <button type="button" className="lv-metric-action" disabled={loading || opening || updatingKey} onClick={() => void load(true)}>
          {loading && <ActivityMark state="running"/>}{loading ? t('正在刷新…') : current?.error ? t('重试') : t('刷新')}
        </button>
        {keyInfo?.keyPage && <a href={keyInfo.keyPage} target="_blank" rel="noopener noreferrer">{t("管理额度 ↗")}</a>}
        {packLink}
      </div>
    </section>}
    {configured && accountId && !updatingKey && <NarratorDefault key={accountId + ':' + (keyInfo?.masked ?? '')} account={accountId} values={values} save={save}/>}
    {configured ? <details>
      <summary>{t('管理 Key')}</summary>
      {accountId && <small className="lv-laivox-account-id">{account}</small>}
      <label>LaiVox API Key<input type="password" autoComplete="off" value={secret} disabled={updatingKey || opening}
        placeholder={t('已保存，可粘贴新 Key 替换')} onChange={event => setSecret(event.target.value)}/></label>
      <div className="lv-inline">
        <button disabled={!secret.trim() || updatingKey || opening}>{saving ? t('正在验证…') : t('保存 Key')}</button>
        <button type="button" className="lv-subtle" disabled={updatingKey || opening} onClick={clearKey}>{clearing ? t('正在清除…') : t('清除 Key')}</button>
      </div>
    </details> : <>
      <label>LaiVox API Key<input type="password" autoComplete="off" value={secret} disabled={saving || clearing}
        placeholder="lvtts_…" onChange={event => setSecret(event.target.value)}/></label>
      <div className="lv-inline">
        <button className="lv-primary" disabled={!secret.trim() || saving || clearing}>{saving ? t('正在验证…') : t('验证并保存')}</button>
      </div>
      {keyInfo?.keyPage && <a href={keyInfo.keyPage} target="_blank" rel="noopener noreferrer">{t("获取或更换 API Key ↗")}</a>}
      {packLink}
    </>}
    {message && <small role={failed ? 'alert' : 'status'}>{displayText(message)}</small>}
  </form>
}

// Keeps zero requests to LaiVox when Edge is selected and no key is configured,
// while still giving users a visible entry to learn about and connect LaiVox.
function LaivoxCardGate({ active, focus, keyInfo, reloadKey, decide, values, save }) {
  const [expanded, setExpanded] = useState(focus === 'laivox')
  useEffect(() => { if (focus === 'laivox') setExpanded(true) }, [focus])
  if (active) return <LaivoxCard keyInfo={keyInfo} reloadKey={reloadKey} decide={decide} values={values} save={save}/>
  return <section className="lv-card lv-laivox-fold">
    <h3 id="lv-laivox">{t('LaiVox 引擎')} <span className="lv-badge-rec">{t('推荐 · 增值付费')}</span></h3>
    <small>{t('拟人情感演绎，支持多角色逐句语气与自有音色。属增值付费功能，使用会员朗读额度或单独购买的朗读时长包。')}</small>
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{t('配置 API Key 或查看时长包说明')}</summary>
      {expanded && <LaivoxCard embedded keyInfo={keyInfo} reloadKey={reloadKey} decide={decide} values={values} save={save}/>}
    </details>
  </section>
}

export function SettingsSheet({ w, space, focus, player }) {
  const root = useRef(null)
  useEffect(() => {
    if (!focus) return
    const heading = root.current?.querySelector('#lv-' + focus)
    heading?.scrollIntoView({ block: 'start' })
    heading?.parentElement.querySelector('input,select,button')?.focus({ preventScroll: true })
  }, [focus])
  const values = w.settings.values
  const laivoxActive = w.options.engine === 'laivox' || Boolean(w.keyInfo?.configured)
  return <div ref={root} className="lv-panel-content">
    <Production options={w.options} choose={w.chooseOptions} models={w.models} reloadModels={w.reloadModels} busy={w.busy}/>
    <LaivoxCardGate active={laivoxActive} focus={focus} keyInfo={w.keyInfo} reloadKey={w.reloadKey} decide={w.decide} values={values} save={w.saveSetting}/>
    <Listening values={values} save={w.saveSetting}/>
    <Speech values={values} save={w.saveSetting} player={player}/>
    <Conversation values={values} save={w.saveSetting}/>
    <Appearance values={values} save={w.saveSetting}/>
    <Storage values={values} save={w.saveSetting} space={space} compact={w.compact} decide={w.decide} changed={w.refreshShelf}/>
  </div>
}
