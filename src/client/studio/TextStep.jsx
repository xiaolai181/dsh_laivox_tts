import { deferText, translate as t } from '../i18n/locale.mjs'
import React from 'react'
import { productionView } from '../workbench/productionView.mjs'
import { RemovedLines } from './RemovedLines.jsx'
export function CreateChapterForm({ w, save, cancel }) {
  const { appendBook, newDraft: draft, busy, creationPending, creationSaved } = w
  const text = draft.text ?? ''
  const bookTitle = draft.bookTitle ?? ''
  const editable = !busy && !creationPending
  const complete = Boolean(text.trim() && (appendBook || bookTitle.trim()))
  if (creationSaved) return <div className="lv-text-step lv-create-chapter">
    <p role="status">{t("内容已保存。")}</p>
    <div className="lv-inline">
      <button type="button" disabled={busy} onClick={cancel}>{t("返回书架")}</button>
      <button type="button" className="lv-primary" disabled={busy} onClick={save}>{t("重新打开已保存章节")}</button>
    </div>
  </div>
  return <form className="lv-text-step lv-create-chapter" onSubmit={event => { event.preventDefault(); void save() }}>
    {appendBook
      ? <p>{t('添加到《{title}》', { title: appendBook.title })}</p>
      : <label>{t("书名")}<input value={bookTitle} maxLength={180} disabled={!editable} required
          onChange={event => w.editNewDraft({ ...draft, bookTitle: event.target.value })}/></label>}
    <label>{appendBook ? t('章节标题') : t('首章标题')}
      <input value={draft.title ?? ''} maxLength={180} disabled={!editable} placeholder={t("可选，默认使用正文首行")}
        onChange={event => w.editNewDraft({ ...draft, title: event.target.value })}/></label>
    <label>{t("章节正文")}<textarea rows="8" value={text} disabled={!editable} required
      onChange={event => w.editNewDraft({ ...draft, text: event.target.value })}/></label>
    <div className="lv-heading">
      <small>{text.length.toLocaleString()}{" " + t("字符")}</small>
      <div className="lv-inline">
        <button type="button" disabled={!editable} onClick={cancel}>{t("取消")}</button>
        <button type="submit" className="lv-primary" disabled={busy || (!creationPending && !complete)}>
          {creationPending ? t('确认保存结果') : appendBook ? t('保存到本书') : t('创建书籍并保存首章')}
        </button>
      </div>
    </div>
  </form>
}

export function TextStep({ w, staleScript }) {
  const text=w.draft.text ?? w.chapter?.text ?? ''
  return <div className="lv-text-step">
    <div className="lv-inline"><button disabled={!w.chapter || w.busy || productionView(w.chapter, w.options).active} title={productionView(w.chapter, w.options).active ? t('本章制作进行中') : undefined} onClick={()=>w.generate('clean')}>{t("仅清洗正文")}</button>
      {w.chapter?.editorial?.cleaned && <button onClick={()=>navigator.clipboard.writeText(w.chapter.text.split('\n').filter((_,i)=>!w.chapter.editorial.removed.includes(i)).join('\n')).then(()=>w.flashNotice(deferText(() => t('已复制清洗后正文'))),()=>w.flashNotice(deferText(() => t('无法访问剪贴板。'))))}>{t("复制清洗后正文")}</button>}</div>
    {w.chapter && <RemovedLines chapter={w.chapter} state={w.scriptDraft ?? w.chapter.editorial ?? {removed:[],annotations:{}}} setDraft={w.editScript} readOnly={w.busy || staleScript || (w.draft.text!==undefined && w.draft.text!==w.chapter.text)}/>}
    <label>{t("章节标题")}<input value={w.draft.title ?? w.chapter?.title ?? ''} onChange={e=>w.editDraft({...w.draft,title:e.target.value})}/></label>
    <label>{t("章节正文")}<textarea rows="16" value={text} onChange={e=>w.editDraft({...w.draft,text:e.target.value})}/></label>
    <div className="lv-heading"><small>{text.length.toLocaleString()}{" " + t("字符")}</small><button disabled={w.busy || !Object.keys(w.draft).length} onClick={async()=>{if(await w.decide({title:deferText(() => t('放弃正文修改？')),text:deferText(() => t('标题和正文的修改会丢失，无法恢复。')),choices:[['discard',deferText(() => t('放弃修改'))],[null,deferText(() => t('继续编辑'))]],destructive:true})==='discard')w.editDraft({})}}>{t("放弃正文修改")}</button></div>
  </div>
}
