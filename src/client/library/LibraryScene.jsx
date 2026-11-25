import { translate as t } from '../i18n/locale.mjs'
import React from 'react'
// One header for the library scene: the shelf and the conversation readings
// (「对话音频」) as two tabs; the two ways to add a book belong to the shelf.
export function LibraryScene({ children, create, creatingDisabled, importFile, uploading, tab = 'books', setTab, compactHeader = false, split = false }) {
  const classes = 'lv-library-scene' + (split ? ' lv-library-split' : '') + (compactHeader ? ' lv-library-detail' : '')
  return <section className={classes}>{!compactHeader && <><header className="lv-heading"><h1>{t("我的书架")}</h1>
    {tab === 'books' && <div className="lv-inline"><button className="lv-primary" onClick={importFile} disabled={uploading}>{t("导入 TXT / EPUB / PDF")}</button><button onClick={create} disabled={creatingDisabled}>{t("新建书籍")}</button></div>}</header>
    {setTab && <div className="lv-segmented lv-library-tabs" role="group" aria-label={t("书架内容")}>
      {[['books', t('书籍')], ['snippets', t('对话片段')]].map(([value, label]) =>
        <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}
    </div>}</>}
    {children}</section>
}
