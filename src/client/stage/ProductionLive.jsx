import { getLanguage, translate as t } from '../i18n/locale.mjs'
import React, { memo, useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from '../components/Icon.jsx'
import { ActivityMark, LevelBar } from '../components/Metrics.jsx'
import { AiUsage } from '../jobs/AiUsage.jsx'
import { roleColor } from './roleColor.mjs'
import { buildMosaic } from './liveMosaic.mjs'
import { emotions } from './ImmersiveLines.jsx'

const STATE_NAMES = { removed: '已清洗移除', pending: '待处理', cast: '已编剧', ready: '已合成' }

// One block per segment, laid out like squares on manuscript paper. Kept in a
// memoized child so the 2-second progress polls only repaint what changed.
const Mosaic = memo(function Mosaic({ blocks, names, pick, language }) {
  return <div className="lv-live-paper" role="list" aria-label={t('制作进度（每块是一句）', undefined, language)}>
    {blocks.map(block => <button type="button" role="listitem" key={block.key} className="lv-live-block" data-state={block.state}
      data-sweep={block.sweep || undefined} data-playing={block.playing || undefined}
      style={{ '--lv-block': Math.max(8, Math.min(120, Math.round(block.chars * 1.4))) + 'px', '--lv-role-color': block.roleId ? roleColor(block.roleId) : undefined }}
      aria-label={(names(block.roleId) ? names(block.roleId) + ' · ' : '') + t(STATE_NAMES[block.state], undefined, language)
        + (block.emotion ? ' · ' + t(emotions[block.emotion] ?? block.emotion, undefined, language) : '')}
      disabled={block.state === 'removed'} onClick={() => pick(block)}/>)}
  </div>
})

function Step({ index, title, count, unit, active, done, stage, state }) {
  return <li className="lv-live-step" data-active={active || undefined} data-done={done || undefined}>
    <span className="lv-live-step-mark">{done ? <Icon name="Check" size={12}/>
      : active ? <ActivityMark state={state} stage={stage}/> : index}</span>
    <span>{title}</span>{count && <small>{count.done} / {count.total} {unit}</small>}
  </li>
}

// The production as it happens: cleaning, scripting and synthesis on one
// sheet. Clicking a synthesized block plays from there; clicking one that is
// not ready yet asks the job to synthesize it next.
export function ProductionLive({ chapter, operation, player, listenFrom, collapsible = false }) {
  const live = operation?.live
  const s = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const [open, setOpen] = useState(!collapsible)
  const playingPart = s.chapter === chapter?.id && s.job === operation?.id ? s.segments[s.n] : null
  const playing = playingPart ? { start: playingPart.start, end: playingPart.end } : null
  const mosaic = useMemo(() => live && chapter?.text ? buildMosaic(chapter.text, live, { playing }) : null,
    [chapter?.text, live, playing?.start, playing?.end])
  const roleName = useMemo(() => {
    const names = new Map((chapter?.roles ?? []).map(role => [role.id, role.name]))
    return id => !id ? '' : id === 'narrator' ? t('旁白') : names.get(id) ?? t('新角色')
  }, [chapter?.roles])
  // A stable click handler keeps the memoized mosaic from repainting on every poll.
  const picker = useRef(null)
  const pickStable = useCallback(block => picker.current?.(block), [])
  if (!live || !chapter) return null
  const stage = live.stage ?? operation.stage
  const synthesis = operation.synthesis ?? (live.parts ? { done: live.parts.filter(part => part[2]).length, total: live.parts.length } : null)
  const steps = [
    live.clean && { key: 'clean', title: t('清洗'), count: live.clean, unit: t('批'), active: stage === 'cleaning', done: live.clean.done >= live.clean.total },
    live.cast && { key: 'cast', title: t('编剧'), count: live.cast, unit: t('批'), active: stage === 'scripting', done: live.cast.done >= live.cast.total },
    { key: 'synth', title: t('合成'), count: synthesis?.total ? synthesis : null, unit: t('段'), active: stage === 'synthesizing', done: synthesis?.total > 0 && synthesis.done >= synthesis.total },
  ].filter(Boolean)
  const activeStep = steps.find(step => step.active)
  function pick(block) {
    if (block.state === 'removed') return
    listenFrom?.(block.start)
  }
  picker.current = pick
  return <section className="lv-live" aria-label={t("制作现场")} data-paused={operation.state === 'paused' || undefined}>
    <header className="lv-live-head">
      <ol className="lv-live-steps">{steps.map((step, index) => <Step key={step.key} index={index + 1} stage={stage} state={operation.state} {...step}/>)}</ol>
      {collapsible && <button type="button" className="lv-live-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? t('收起') : t('展开制作现场')}</button>}
    </header>
    {open && activeStep && <LevelBar label={stage === 'synthesizing' ? t('合成进度') : t('AI 处理进度')}
      progress busy={operation.state === 'running'} value={activeStep.count?.done} max={activeStep.count?.total ?? 0}
      tone={operation.state === 'paused' ? 'muted' : 'accent'}/>}
    {open && <AiUsage ai={operation.ai}/>}
    {open && mosaic && <>
      {mosaic.blocks.length > 0 && <Mosaic blocks={mosaic.blocks} names={roleName} pick={pickStable} language={getLanguage()}/>}
      {mosaic.roles.length > 0 && <div className="lv-live-roster" aria-label={t("出场角色")}>{mosaic.roles.map(id =>
        <span key={id} className="lv-live-role" style={{ '--lv-role-color': roleColor(id) }}><i className="lv-role-dot"/>{roleName(id)}</span>)}</div>}
      {live.notes?.length > 0 && <p className="lv-live-notes"><small>{t("本批语气提示")}</small>{live.notes.map(note => <span key={note}>「{note}」</span>)}</p>}
      <small className="lv-live-help">{operation.state === 'paused' ? t('已暂停，进度停在这里。') : t('点已合成的块从那里听；点还没合成的块，优先合成那里。')}</small>
    </>}
    {open && !mosaic?.blocks.length && <small className="lv-live-help">{t("正在准备制作数据…")}</small>}
  </section>
}
