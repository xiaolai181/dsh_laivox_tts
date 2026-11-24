import { deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { sourceLines } from '../../domain/segment.mjs'
import { positionAt } from './readingPosition.mjs'
import { useMarks, useSmoothOffset } from '../player/useMarks.mjs'

function activeLineAt(lines, position) {
  if (!Number.isFinite(position)) return -1
  let left = 0, right = lines.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (lines[middle].start <= position) left = middle + 1
    else right = middle
  }
  return left > 0 ? lines[left - 1].id : -1
}

// One paragraph, with the part being spoken marked as a sentence and the part
// of it already spoken drawn darker.
function Paragraph({ line, span }) {
  const text = line.text || ' '
  if (!span) return text
  const end = line.start + line.text.length
  const from = Math.max(span.start, line.start)
  const to = Math.min(span.end, end)
  if (from >= to) return text
  const read = Math.max(from, Math.min(to, span.read))
  const at = value => value - line.start
  return <>
    {line.text.slice(0, at(from))}
    <mark className="lv-prose-sentence"><span className="lv-prose-read">{line.text.slice(at(from), at(read))}</span>{line.text.slice(at(read), at(to))}</mark>
    {line.text.slice(at(to))}
  </>
}

export function ProseView({ chapter, player, notify, onSeek }) {
  const [tab, setTab] = useState(() => chapter?.editorial?.cleaned || chapter?.editorial?.removed?.length ? 'cleaned' : 'reader')
  const [follow, setFollow] = useState(true)
  const [page, setPage] = useState(0)
  const linesRef = useRef(null)
  const playing = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const preview = chapter?.cleanPreview
  const removed = preview?.removed ?? chapter?.editorial?.removed
  const hasClean = Boolean(preview || chapter?.editorial?.cleaned || removed?.length)
  const cleaned = tab === 'cleaned' && hasClean
  const original = chapter?.text
  const lines = useMemo(() => original ? sourceLines(original) : [], [original])
  const visible = useMemo(() => {
    if (!cleaned || !removed?.length) return lines
    const hidden = new Set(removed)
    return lines.filter(line => !hidden.has(line.id))
  }, [lines, cleaned, removed])
  const here = playing.chapter === chapter?.id && (playing.phase !== 'idle' || playing.offset > 0 || playing.n > 0)
  const part = here ? playing.segments[playing.n] : undefined
  const offset = useSmoothOffset(playing, here)
  const marks = useMarks(here && !playing.stale ? playing.job : null, playing.n, part?.ready, playing.segments[playing.n + 1]?.ready)
  // Old audio after the text changed: its offsets point into the old text, so
  // only the paragraph is marked, approximately.
  const stale = here && Boolean(playing.stale ?? chapter?.playbackStale)
  let span = null
  if (part && !stale && Number.isFinite(part.start) && Number.isFinite(part.end) && part.end > part.start) {
    const text = part.text ?? original.slice(part.start, part.end)
    const { read } = positionAt(text, offset, part.seconds, marks)
    span = { start: part.start, end: part.end, read: part.start + Math.round((text.length ? read / text.length : 0) * (part.end - part.start)) }
  }
  const active = activeLineAt(lines, part?.start)
  const index = useMemo(() => active < 0 ? -1 : visible.findIndex(line => line.id === active), [visible, active])
  const max = Math.max(0, Math.ceil(visible.length / 160) - 1)
  const shown = follow && index >= 0 ? Math.floor(index / 160) : Math.min(page, max)

  useEffect(() => {
    if (follow && index >= 0) linesRef.current?.querySelector('[aria-current=true]')?.scrollIntoView({ block: 'nearest' })
  }, [index, follow, tab])
  useEffect(() => {
    if (tab === 'cleaned' && !hasClean) { setTab('reader'); notify(deferText(() => t('清洗预览已结束，已返回原文。'))) }
  }, [tab, hasClean])

  const hasAudio = Boolean(chapter?.media?.some(part => part.ready))

  if (!chapter) return null

  return <section className="lv-reader">
    {(hasClean || hasAudio) && <div className="lv-prose-toolbar lv-reading-width">
      {hasClean && <nav className="lv-segmented" aria-label={t("章节视图")}>{[['reader', t('原文')], ['cleaned', t('清洗后正文')]].map(([id, label]) =>
        <button key={id} aria-pressed={tab === id} onClick={() => { setTab(id); setPage(0) }}>{label}</button>)}</nav>}
      {hasAudio && <label className="lv-check"><input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)}/>{" " + t("跟随朗读")}</label>}
    </div>}
    <div className="lv-reading-width">
      {stale && <p className="lv-prose-stale" role="status">{t("正文已修改，旧音频的位置可能对不上；更新音频后可逐句跟随。")}</p>}
      {cleaned && <div className="lv-heading lv-cleaned-result"><small>{preview ? t('本次清洗预览') : t('已保存的清洗结果')}{" " + t("· 移除") + " "}{removed?.length ?? 0}{" " + t("行")}</small>
        <button onClick={() => void navigator.clipboard.writeText(visible.map(line => line.text).join('\n'))
          .then(() => notify(deferText(() => t('已复制清洗后正文'))), () => notify(deferText(() => t('无法访问剪贴板，可以手动复制。'))))}>{t("复制正文")}</button></div>}
      <article className="lv-prose" ref={linesRef} aria-label={cleaned ? t('清洗后的小说正文') : t('小说原文')}>
        {visible.slice(shown * 160, (shown + 1) * 160).map(line => <p key={line.id} aria-current={active === line.id ? 'true' : undefined}
          role={onSeek ? 'button' : undefined} tabIndex={onSeek ? 0 : undefined} aria-label={onSeek ? t('从这一行播放') : undefined}
          onClick={onSeek ? () => {
            // Selecting text to copy ends with a click too; that must not start playback or synthesis.
            if (typeof window !== 'undefined' && window.getSelection?.()?.isCollapsed === false) return
            onSeek(line.start)
          } : undefined}
          onKeyDown={onSeek ? event => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            onSeek(line.start)
          } : undefined}><Paragraph line={line} span={span}/></p>)}
      </article>
      {max > 0 && <div className="lv-heading lv-page-nav"><button disabled={shown === 0} onClick={() => { setFollow(false); setPage(shown - 1) }}>{t("前一页正文")}</button>
        <small>{shown + 1} / {max + 1}</small><button disabled={shown === max} onClick={() => { setFollow(false); setPage(shown + 1) }}>{t("后一页正文")}</button></div>}
    </div>
  </section>
}
