import React from 'react'
import { Popover } from '../components/Popover.jsx'
import { Icon } from '../components/Icon.jsx'
import { translate as t } from '../i18n/locale.mjs'
export function BookSwitcher({ chapter, draftBookTitle, books, openBook, openLibrary }) {
  return <Popover label={t('切换书籍')} placement="bottom-start" trigger={<><span>{chapter?.isSnippet ? t('对话片段') : chapter?.bookTitle ?? draftBookTitle ?? t('我的书架')}</span>{!chapter?.isSnippet && chapter?.bookTitle && Number.isInteger(chapter.ordinal) && <small className="lv-book-switcher-chapter">{t('第 {chapter} 章', { chapter: chapter.ordinal })}</small>}<Icon name="ChevronDown"/></>}>
    {close => <div className="lv-menu">{books?.map(book => <button key={book.id} onClick={() => { close(); openBook(book.id) }}>{book.title}</button>)}
      <button onClick={() => { close(); openLibrary() }}>{t('打开书架')}</button></div>}
  </Popover>
}
