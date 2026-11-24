import { translate as t } from '../i18n/locale.mjs'
import { deliveryLabel } from '../i18n/display.mjs'
import React, { useSyncExternalStore } from 'react'
import { roleColor } from './roleColor.mjs'
import { positionAt } from './readingPosition.mjs'
import { useMarks, useSmoothOffset } from '../player/useMarks.mjs'
import { GapNotice } from './GapNotice.jsx'
export const emotions = { neutral: '平静', happy: '喜悦', sad: '悲伤', angry: '愤怒', afraid: '害怕', tense: '紧张', gentle: '温柔' }

function partText(chapter, part) {
  return part?.text ?? (chapter.playbackStale ? t('旧版音频') : chapter.text.slice(part?.start ?? 0, part?.end ?? 0))
}

export function ImmersiveLines({ chapter, player, listenFrom }) {
  const s = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const here = s.chapter === chapter.id
  const segments = here ? s.segments : chapter.media
  const current = here ? s.n : 0
  const part = segments[current]
  const offset = useSmoothOffset(s, here)
  const marks = useMarks(here ? s.job : null, current, part?.ready, segments[current + 1]?.ready)
  const currentText = part ? partText(chapter, part) : ''
  const position = here ? positionAt(currentText, offset, part?.seconds, marks) : { read: 0, word: null }
  const ratio = currentText.length ? position.read / currentText.length : 0
  const from = Math.max(0, current - 2)
  return <div className="lv-immersive" aria-label={t("沉浸收听")} data-timing={marks?.length ? 'word' : 'estimate'}>{segments.slice(from, current + 3).map((line, index) => {
    const n = from + index
    const selected = n === current
    const text = selected ? currentText : partText(chapter, line)
    const role = line.roleId === 'narrator' ? t('旁白') : chapter.roles.find(role => role.id === line.roleId)?.name ?? t('待改派')
    const [wordStart, wordEnd] = selected && position.word ? position.word : [position.read, position.read]
    return <div key={line.id ?? n} className={selected ? 'lv-current-line' : 'lv-context-line'} data-dialogue={line.roleId !== 'narrator'} style={{ '--lv-role-color': roleColor(line.roleId) }}>
      {selected && <div className="lv-speaking"><i className="lv-role-dot"/><strong>{role}</strong><span>· {line.intensity === 2 ? t('强烈 · ') : ''}{t(emotions[line.emotion] ?? '平静')}</span>{line.instruct && <span>· {deliveryLabel(line.instruct)}</span>}{chapter.playbackJob?.engine === 'laivox' && <small>LaiVox</small>}</div>}
      <button className="lv-line-button" onClick={() => listenFrom?.(line.start)}>
        {selected ? <>
          <span className="lv-read">{text.slice(0, wordStart)}</span>
          {wordEnd > wordStart && <span className="lv-word">{text.slice(wordStart, wordEnd)}</span>}
          <span className="lv-unread">{text.slice(Math.max(wordEnd, position.read))}</span>
        </> : text}
      </button>
      {selected && <div className="lv-sentence-progress"><i style={{ width: ratio * 100 + '%' }}/></div>}
      {selected && <GapNotice chapter={chapter} part={line} listenFrom={listenFrom}/>}
    </div>
  })}</div>
}
