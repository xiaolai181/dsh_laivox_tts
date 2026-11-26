import { deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useMemo, useState } from 'react'
import { explain } from '../api.mjs'
import { Icon } from '../components/Icon.jsx'
import { ActivityMark, LevelBar } from '../components/Metrics.jsx'
import { Popover } from '../components/Popover.jsx'
import { JobProgress } from '../jobs/JobProgress.jsx'
import { detectNoiseLines, NOISE_SUGGEST_MIN } from '../../domain/noise.mjs'
import { ACTIVE, MODE_NAMES } from './production.mjs'
import { productionView } from '../workbench/productionView.mjs'
import { openUsageDay } from '../workbench/laivox.mjs'

export { MODE_NAMES }

const STAGE_TEXT = {
  queued: () => t('等待制作'),
  cleaning: job => t("AI 清洗 {v1} / {v2} 批", { v1: job.counts?.clean?.done ?? 0, v2: job.counts?.clean?.total ?? 0 }),
  // While scripting and synthesis overlap the number of parts still grows, so only
  // the parts already made are shown.
  scripting: job => t("AI 编剧 {v1} / {v2} 批", { v1: job.counts?.cast?.done ?? 0, v2: job.counts?.cast?.total ?? 0 })
    + (job.open && job.synthesis?.done ? t(' · 已合成 {count} 段', { count: job.synthesis.done }) : ''),
  synthesizing: job => t("合成 {v1} / {v2} 段", { v1: job.synthesis?.done ?? 0, v2: job.synthesis?.total ?? 0 }),
}
export function jobLine(job, pending) {
  if (pending === 'pause') return t('正在暂停…')
  if (pending === 'resume') return t('正在继续…')
  if (pending === 'cancel') return t('正在停止…')
  if (job.state === 'paused') return t('已暂停 · ') + (job.error ? explain(job.retryAfter ? { message: job.error, retryAfter: job.retryAfter } : job.error) : job.pauseReason === 'newer-task' ? t('因开始新任务已自动暂停') : job.pauseReason === 'restart' ? t('插件重启时暂停') : t('可随时继续'))
  if (job.yieldWait && job.state === 'running') return t('等待当前 AI 批次完成')
  return (STAGE_TEXT[job.state === 'running' ? job.stage : job.state] ?? (() => t('制作中')))(job)
}

// A paused LaiVox job whose cause continuing cannot fix (quota, key, voice) offers
// the one step that can; the plain "continue" comes back once a usage day is open.
const NEEDS_ACTION = new Set(['quota', 'account', 'membership', 'outdated', 'voice'])

function LaivoxPauseActions({ w, pause, opened, fill, retry }) {
  const [opening, setOpening] = useState(false)
  async function openDay() {
    setOpening(true)
    try {
      const result = await openUsageDay(w.decide)
      if (result.opened) { opened(); w.flashNotice(deferText(() => t('已开启下一个使用日，点「继续制作」接着制作'))) }
      else if (result.message) w.flashNotice(result.message)
    } catch (error) { w.errors(error) }
    finally { setOpening(false) }
  }
  const main = pause.kind === 'quota' && pause.canAuthorize
    ? <button type="button" className="lv-primary" disabled={opening} onClick={() => void openDay()}>{opening ? t('正在开启…') : t('开启下一个使用日')}</button>
    : pause.kind === 'account' ? <button type="button" className="lv-primary" onClick={() => w.setPanel('production')}>{t("打开设置")}</button>
      : pause.kind === 'voice' ? <button type="button" className="lv-primary" onClick={() => w.setPanel('roles')}>{t("打开角色")}</button>
        // A pack key whose hours ran out or lapsed can buy more on the web page.
        : (pause.kind === 'quota' || pause.kind === 'membership') && pause.ledger === 'pack' && w.keyInfo?.packPage
          ? <a className="lv-primary" href={w.keyInfo.packPage} target="_blank" rel="noopener noreferrer">{t('购买朗读时长包 ↗')}</a> : null
  // The other ledger is usable: the key can be switched to it on the web page instead of buying more.
  const ledgerPause = pause.kind === 'quota' || pause.kind === 'membership'
  const switchHint = !ledgerPause ? ''
    : pause.ledger === 'pack' ? (pause.membershipAvailable ? t('你的会员有效，可以在官网把这把 Key 改回使用会员额度。') : '')
      : pause.packAvailable ? t('你有可用的朗读时长包，可以在官网把这把 Key 改为使用时长包。') : ''
  // With nothing else to do (membership, outdated plugin, no usage day left), finishing with Edge is the main step.
  const actions = <div className="lv-inline">{main}{retry && <button type="button" onClick={retry}>{t('重试')}</button>}{fill && <button type="button" className={main ? '' : 'lv-primary'} onClick={fill}>{t("用 Edge 补完剩余段")}</button>}</div>
  if (!switchHint) return actions
  return <>{actions}<small role="status">{switchHint}{w.keyInfo?.keyPage && <>{' '}<a href={w.keyInfo.keyPage} target="_blank" rel="noopener noreferrer">{t("获取或更换 API Key ↗")}</a></>}</small></>
}

// How many parts are still waiting; 0 when the job paused before planning them.
function partsLeft(job) {
  const total = Number(job.synthesis?.total ?? job.total) || 0
  return Math.max(0, total - (Number(job.synthesis?.done) || 0))
}

const ENGINE_NAMES = [['edge', 'Edge'], ['laivox', 'LaiVox']]

export function ProductionBar({ w, compact = false, openQueue }) {
  const chapter = w.chapter
  const job = chapter?.operation
  const active = ACTIVE.includes(job?.state)
  const pending = job ? w.actions.get(job.id) : null
  const keyMissing = w.options.engine === 'laivox' && w.keyInfo?.configured === false
  const view = productionView(chapter, w.options, { keyMissing })
  const facts = view.audio
  const primary = view.next
  const shownMode = view.shown.mode
  const shownEngine = view.shown.engine
  // The production sheet below already shows running progress in detail.
  const showStatus = active && !(job.live && job.state !== 'paused')
  const [cleanOnce, setCleanOnce] = useState(false)
  const [dayOpenedFor, setDayOpenedFor] = useState(null)
  useEffect(() => {
    if (job?.state !== 'paused' && dayOpenedFor) setDayOpenedFor(null)
  }, [job?.id, job?.state])
  const noise = useMemo(() => detectNoiseLines(chapter?.text ?? ''), [chapter?.id, chapter?.rev, chapter?.text])
  const suggestClean = !active && !w.options.clean && !chapter?.editorial?.cleaned && noise.length >= NOISE_SUGGEST_MIN
  if (!chapter) return null
  const start = (purpose = 'generate', extra = {}) => w.generate(purpose, false, '', { ...(suggestClean && cleanOnce ? { clean: true } : {}), ...extra })
  function runPrimary() {
    if (primary.kind === 'connect') return w.setPanel('production')
    if (primary.kind === 'pause') return w.jobAction(job.id, 'pause')
    if (primary.kind === 'resume') return w.jobAction(job.id, 'resume')
    if (primary.kind === 'start') { setCleanOnce(false); return start() }
  }
  const pause = job?.state === 'paused' && job.laivoxPause && NEEDS_ACTION.has(job.laivoxPause.kind) ? job.laivoxPause : null
  const keyUnlocked = (w.keySavedAt ?? 0) > 0 && Boolean(job?.id) && !w.resumedAfterKey?.has(job.id)
  const blocked = Boolean(pause)
    && !(pause.kind === 'quota' && dayOpenedFor === job.id)
    && !(pause.kind === 'account' && keyUnlocked)
  // Finishing with Edge: offered when LaiVox cannot go on (a pause above) or kept failing
  // after its automatic retries; never chosen for the user.
  const canFill = job?.engine === 'laivox' && job.state === 'paused' && !job.fill && !job.retake && job.purpose === 'generate'
    && (partsLeft(job) > 0 || !(Number(job.total) > 0)) && (Boolean(pause) || (Boolean(job.error) && !job.autoResume))
  async function fill() {
    const left = partsLeft(job)
    const choice = await w.decide({ title: deferText(() => t('用 Edge 补完剩余段')),
      text: deferText(() => t('{scope}将改用 Edge 音色合成，这一章会有两种音色。以后可以用 LaiVox 重新生成这一章。',
        { scope: left > 0 ? t('剩余 {v1} 段', { v1: left }) : t('这一章') })),
      choices: [['fill', deferText(() => t('用 Edge 补完'))], [null, deferText(() => t('取消'))]] })
    if (choice === 'fill') await w.jobAction(job.id, 'fill-edge')
  }
  const progress = job?.stage === 'cleaning' ? job.counts?.clean : job?.stage === 'scripting' ? job.counts?.cast : job?.synthesis
  const running = job?.state === 'running' && !pending
  return <section className="lv-production" data-compact={compact} aria-label={t("制作")}>
    <div className="lv-production-main">
      <div className="lv-production-facts">
        <small>{t("当前音频")}</small>
        <strong>{facts.label}</strong>{facts.note && <span data-warn={facts.stale}>{facts.note}</span>}
      </div>
        <div className="lv-production-options">
          <small>{t("此后各章的默认")}</small>
        <div className="lv-segmented lv-production-mode" role="group" aria-label={t("发声引擎")}>
          {ENGINE_NAMES.map(([value, label]) => <button key={value} type="button" aria-pressed={shownEngine === value}
            title={value === 'laivox' ? t('推荐使用 · 增值付费，需 API Key（支持会员额度或朗读时长包）') : t('内置在线语音 · 无需账号')}
            disabled={w.busy || view.shown.locked} onClick={() => { if (w.options.engine !== value) void w.chooseOptions({ engine: value }) }}>
            {label}{value === 'laivox' && <span className="lv-badge-rec">{t('推荐')}</span>}
          </button>)}
        </div>
        <div className="lv-segmented lv-production-mode" role="group" aria-label={t("制作模式")}>
          {Object.entries(MODE_NAMES).map(([value, label]) => <button key={value} type="button" aria-pressed={shownMode === value}
            disabled={w.busy || view.shown.locked} onClick={() => { if (w.options.mode !== value) void w.chooseOptions({ mode: value }) }}>{t(label)}</button>)}
        </div>
      </div>
      <div className="lv-production-actions">
        {primary.kind === 'none'
          ? <span className="lv-production-done"><Icon name="Check" size={14}/>{t("已是最新")}</span>
          : !(blocked && primary.kind === 'resume') && <button type="button" className="lv-primary" disabled={w.busy || Boolean(pending)} onClick={runPrimary}>{primary.label}</button>}
        {active && <button type="button" disabled={Boolean(pending)} onClick={() => w.jobAction(job.id, 'cancel')}>{t("停止")}</button>}
        <Popover label={t("更多制作操作")} trigger={<Icon name="Ellipsis"/>} placement="bottom-end" className="lv-icon-button">
          {close => <div className="lv-menu">
            <button disabled={w.busy || active} onClick={() => { close(); void start('clean') }}>{chapter.editorial?.cleaned ? t('重新清洗正文') : t('仅清洗正文')}</button>
            {w.options.mode === 'multi' && <button disabled={w.busy || active} onClick={() => { close(); void start('cast') }}>{chapter.editorial?.cast ? t('重新编剧（不合成）') : t('只编剧，先检查台词')}</button>}
            <button disabled={w.busy || active} onClick={() => { close(); void start('generate', { showPlan: true }) }}>{t("预览制作方案")}</button>
            {openQueue && <button onClick={() => { close(); openQueue() }}>{t("查看本章任务")}</button>}
          </div>}
        </Popover>
      </div>
    </div>
    {(primary.hint || primary.warnings.length > 0) && <small className="lv-production-hint">{[primary.hint, ...primary.warnings].filter(Boolean).join(' · ')}</small>}
    {suggestClean && <label className="lv-check lv-production-noise">
      <input type="checkbox" checked={cleanOnce} disabled={w.busy} onChange={event => setCleanOnce(event.target.checked)}/>{t('疑似广告 {count} 行 · 本次一并用 AI 清洗', { count: noise.length })}{w.options.mode === 'multi' && chapter.editorial?.cast ? t('（会重新编剧）') : ''}
    </label>}
    {showStatus && <div className="lv-production-status" data-paused={job.state === 'paused'}>
      <span className="lv-metric-caption" role="status">
        <ActivityMark state={job.state} stage={job.stage} error={job.error} pending={pending}/>{jobLine(job, pending)}
      </span>
      <LevelBar label={t('制作进度')} progress busy={running} value={progress?.done} max={progress?.total ?? 0}
        tone={job.error ? 'warn' : running ? 'accent' : 'muted'}/>
      {job.laivoxPause?.kind === 'held' && job.laivoxPause.until && <small role="status">{t('暂停至 {time}', { time: new Date(job.laivoxPause.until).toLocaleTimeString() })}</small>}
      {blocked && !pending && <LaivoxPauseActions w={w} pause={pause} opened={() => setDayOpenedFor(job.id)} fill={canFill ? () => void fill() : null}
        retry={((pause.kind === 'quota' && !pause.canAuthorize) || pause.kind === 'membership') ? () => void w.jobAction(job.id, 'resume') : null}/>}
      {!blocked && canFill && !pending && <div className="lv-inline"><button type="button" onClick={() => void fill()}>{t("用 Edge 补完剩余段")}</button></div>}
      {(job.error || job.autoResume) && <details><summary>{t("详情")}</summary><JobProgress job={job} actionPending={pending}/></details>}
    </div>}
  </section>
}
