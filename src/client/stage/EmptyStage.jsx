import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useState } from 'react'
import { post } from '../api.mjs'
import { SAMPLE_BOOK_IDS } from '../../domain/samples.mjs'
import { edgeDeliveryNote, laivoxCapability } from '../workbench/enginePitch.mjs'
import { MODE_NAMES } from './ProductionBar.jsx'

// No audio yet. The production bar above owns the mode and the start button;
// this card only says what pressing it will do, so there is one primary action.
export function EmptyStage({ w, create, openImport, books, openBook, openLibrary }) {
  const [plan,setPlan] = useState(null)
  const chapter = w.chapter
  const signature = JSON.stringify(w.options)
  useEffect(() => {
    if (!chapter?.id) return
    const abort = new AbortController()
    setPlan(null)
    post('jobs/prepare',{...w.options,purpose:'generate',chapters:[chapter.id]},false,abort.signal)
      .then(value => { if (!abort.signal.aborted) setPlan(value) }).catch(() => {})
    return () => abort.abort()
  },[chapter?.id,chapter?.rev,chapter?.editorialResultJob,signature])
  if (!chapter) {
    const sampleBook = Array.isArray(books) ? SAMPLE_BOOK_IDS.map(id => books.find(book => book.id === id)).find(Boolean) : null
    return <div className="lv-empty-stage lv-hero"><small className="lv-kicker">{t("小说配音（LaiVox）")}</small><h1>{t("把故事读给你听")}</h1><p>{t("导入一本小说，或粘贴一章正文开始制作。")}</p>
      <div className="lv-inline"><button className="lv-primary" onClick={openImport}>{t("导入 TXT / EPUB / PDF")}</button><button onClick={create}>{t("粘贴一章正文")}</button>{sampleBook && openBook && <button onClick={() => openBook(sampleBook.id)}>{t("试听示例")}</button>}{Array.isArray(books) && books.length > 0 && openLibrary && <button onClick={openLibrary}>{t("打开书架")}</button>}</div></div>
  }
  if (chapter.operation && ['queued','running','paused'].includes(chapter.operation.state)) return null
  const multi = w.options.mode === 'multi'
  const laivox = w.options.engine === 'laivox'
  const keyMissing = laivox && w.keyInfo?.configured === false
  return <div className="lv-empty-stage"><small className="lv-kicker">{t("这一章还没有音频")}</small>
    <h2>{t(MODE_NAMES[w.options.mode])}</h2>
    <p>{multi
      ? (laivox
        ? t('AI 先读完本章，分出旁白和每个角色，再按每句的语气拟人合成。过程中随时可以暂停或停止。')
        : t('AI 先读完本章，分出旁白和每个角色，再给每句写下语气。过程中随时可以暂停或停止。'))
      : t('用一个声音按段落朗读全文，不调用 AI，马上开始合成。')}</p>
    {plan && <dl className="lv-plan-summary">
      {plan.clean > 0 && <><dt>{t("正文")}</dt><dd>{t("先用 AI 清洗广告和导航行")}</dd></>}
      <dt>{t("台词")}</dt><dd>{plan.cast ? t('AI 编剧，逐句情绪与语气') : multi ? t('沿用已有台词（含你的修改）') : t('不需要')}</dd>
      <dt>{t("合成")}</dt><dd>{laivox ? t('LaiVox（推荐 · 增值付费，消耗当前 Key 朗读额度）') : t('Edge 在线语音（无需账号）')}</dd>
    </dl>}
    {!laivox && <div className="lv-empty-pitch">
      <small>{multi ? edgeDeliveryNote('multi') : laivoxCapability('reading')}</small>
      <button type="button" className="lv-link" disabled={w.busy} onClick={() => void w.chooseOptions({ engine: 'laivox' })}>{t("改用 LaiVox")}</button>
    </div>}
    <div className="lv-inline lv-empty-actions">
      <button type="button" className="lv-primary" disabled={w.busy}
        onClick={() => keyMissing ? w.setPanel('production') : void w.generate('generate')}>
        {keyMissing ? t('连接 LaiVox') : t('开始制作')}
      </button>
      <button type="button" disabled={w.busy} onClick={() => void w.generate('generate', false, '', { showPlan: true })}>{t("预览制作方案")}</button>
    </div>
    <small className="lv-empty-studio-tip">{t("需要先改正文、调台词情绪或选角色音色？可前往顶部「制作」精细调整。")}</small>
  </div>
}
