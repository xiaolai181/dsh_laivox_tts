import { translate as t } from '../i18n/locale.mjs'
import React, { useSyncExternalStore } from 'react'

export function CompanionPane({ player, openWorkbench }) {
  const s = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const playing = ['playing', 'buffering'].includes(s.phase)
  const hasChapter = Boolean(s.chapter && s.job && s.segments?.length)
  const part = hasChapter ? s.segments[s.n] : null
  const speaker = !part ? '' : (part.roleId === 'narrator' || !part.roleId ? t('旁白') : (s.roleNames?.[part.roleId] || ''))
  const text = part?.text || (hasChapter ? t('正在准备音频内容…') : '')

  return <section className="lv-host lv-companion-pane" style={{ display: 'grid', gap: 10, padding: 12 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <strong>{t("伴听视图")}</strong>
      <button type="button" className="lv-hbtn" onClick={openWorkbench}>{t("打开完整工作台")}</button>
    </div>
    {!hasChapter ? <p className="lv-hmeta" style={{ margin: 0 }}>{t("当前还没有正在收听的小说章节。打开工作台选一本书即可边听边聊。")}</p>
      : <>
        <div>
          {s.bookTitle && <div className="lv-hmeta">《{s.bookTitle}》</div>}
          <div style={{ fontWeight: 600 }}>{s.title}</div>
          <small className="lv-hmeta">{t("第 {n} / {total} 段", { n: Math.min(s.n + 1, s.segments.length), total: s.segments.length })}</small>
        </div>
        {text && <blockquote style={{ margin: 0, padding: '8px 10px', borderLeft: '2px solid currentColor', opacity: 0.9 }}>{speaker && <strong>{speaker}：</strong>}{text}</blockquote>}
        <div className="lv-hactions" style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="lv-hbtn" disabled={s.n <= 0} onClick={() => player.seek(s.n - 1)}>{t("上一段")}</button>
          <button type="button" className="lv-hbtn lv-hprimary" onClick={() => player.toggle()}>{playing ? t('暂停播放') : t('播放')}</button>
          <button type="button" className="lv-hbtn" disabled={s.n + 1 >= s.segments.length} onClick={() => player.seek(s.n + 1)}>{t("下一段")}</button>
        </div>
      </>}
  </section>
}
