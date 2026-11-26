import { translate as t } from '../i18n/locale.mjs'

export const MODE_NAMES = { reading: '单人朗读', multi: '多角色演绎' }
const ENGINE_NAMES = { edge: 'Edge', laivox: 'LaiVox' }
const ACTIVE = ['queued', 'running', 'paused']

const engineName = engine => ENGINE_NAMES[engine] ?? engine ?? ''

function audioOf(chapter) {
  const parts = chapter?.media ?? []
  const ready = parts.filter(part => part.ready).length
  const playback = chapter?.playbackJob
  if (!playback || !ready) return { has: false, complete: false, stale: false, staleReason: null, engine: null, mode: null, label: t('尚未制作'), note: '' }
  const stale = Boolean(chapter.playbackStale)
  const reason = chapter.staleReason ?? null
  const note = stale
    ? (reason === 'text' ? t('正文已修改') : reason === 'edit' ? t('台词或音色已修改') : t('内容已修改'))
    : ready < parts.length ? t('已生成 {v1} / {v2} 段', { v1: ready, v2: parts.length }) : ''
  const mode = playback.mode ? t(MODE_NAMES[playback.mode]) : ''
  return {
    has: true, complete: ready === parts.length, stale, staleReason: stale ? reason : null,
    engine: playback.engine ?? null, mode: playback.mode ?? null,
    label: [mode, engineName(playback.engine)].filter(Boolean).join(' · '), note,
  }
}

// One reading of the chapter for the production bar, the script page, the save
// bar and the player. `shown` follows a running job; `next` is the one button.
export function productionView(chapter, options = {}, { keyMissing = false } = {}) {
  const engine = options.engine ?? 'edge'
  const mode = options.mode ?? 'reading'
  const job = chapter?.operation ?? null
  const active = Boolean(job && ACTIVE.includes(job.state))
  const shown = {
    engine: active && job.engine ? job.engine : engine,
    mode: active && job.mode ? job.mode : mode,
    locked: active,
  }
  const audio = audioOf(chapter)
  const playbackId = chapter?.playbackJob?.id ?? null
  const newer = active && (job.purpose ?? 'generate') === 'generate' && job.id !== playbackId
    ? { id: job.id, done: job.synthesis?.done ?? 0, total: job.synthesis?.total ?? job.total ?? 0,
      scope: job.scope === 'range' || job.retake ? 'range' : 'chapter', state: job.state, retake: Boolean(job.retake) }
    : null
  const filled = chapter?.playbackJob?.filled || (chapter?.media ?? []).filter(part => part.filled).length
  const older = chapter?.previousComplete?.id && chapter.previousComplete.id !== playbackId ? { id: chapter.previousComplete.id } : null
  const warnings = []
  if (options.clean && mode === 'multi' && chapter?.editorial?.cast) warnings.push(t('会先清洗并重新编剧，覆盖手工修改的台词'))
  if (!active && mode === 'multi' && !chapter?.editorial?.cast) warnings.push(t('开始前会先用 AI 编剧'))
  let next
  if (active) next = job.state === 'paused'
    ? { kind: 'resume', label: t('继续制作'), hint: '', warnings }
    : { kind: 'pause', label: t('暂停'), hint: '', warnings }
  else if (engine === 'laivox' && keyMissing) next = { kind: 'connect', label: t('连接 LaiVox'), hint: t('保存 API Key 后才能用 LaiVox 制作'), warnings }
  else if (audio.complete && filled > 0 && engine === 'laivox') next = {
    kind: 'start', label: t('用 LaiVox 重做 {v1} 段', { v1: filled }), hint: t('其余段复用'), warnings,
  }
  else if (!audio.has) next = { kind: 'start', label: t('开始制作'), hint: '', warnings }
  else if (audio.engine && audio.engine !== engine) next = {
    kind: 'start', label: t('改用 {name}', { name: engineName(engine) }),
    hint: t('整章用 {name} 重新合成，做完前继续播放现在的版本', { name: engineName(engine) }), warnings,
  }
  else if (audio.mode && audio.mode !== mode) next = {
    kind: 'start', label: t('改为{v1}', { v1: t(MODE_NAMES[mode]) }),
    hint: t('已有的音频在完成前仍可收听'), warnings,
  }
  else if (audio.stale) next = { kind: 'start', label: t('更新音频'), hint: t('只重做受影响的段，其余复用'), warnings }
  else if (!audio.complete) next = { kind: 'start', label: t('继续制作'), hint: t('只合成缺少的段'), warnings }
  else next = { kind: 'none', label: t('已是最新'), hint: '', warnings }
  const running = Boolean(job && ['queued', 'running'].includes(job.state))
  const locks = {
    save: !active ? null : job.state === 'running'
      ? t('本章有制作正在进行，保存前需要先停止它')
      : t('会停止本章暂停的制作，已合成的音频保留'),
    retake: running ? t('本章制作结束后可以重新合成')
      : job?.state === 'paused' ? t('本章有已暂停的任务，先继续或取消后再重新合成') : null,
    edit: null,
  }
  return { shown, audio, newer, older, next, locks, active }
}
