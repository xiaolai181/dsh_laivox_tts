import React from 'react'
import { Icon } from '../components/Icon.jsx'
import { BookSwitcher } from './BookSwitcher.jsx'
import { translate as t } from '../i18n/locale.mjs'
export function TopBar({ chapter, draftBookTitle, books, openBook, scene, setScene, tasks, openQueue, openSettings, openRail }) {
  return <header className="lv-top">
    <button className="lv-rail-toggle lv-icon-button" aria-label={t('目录')} onClick={openRail}><Icon name="Menu"/></button>
    <div className="lv-brand"><span className="lv-mark"><Icon name="AudioLines"/></span><strong>LaiVox</strong></div>
    <div className="lv-book-switcher"><BookSwitcher chapter={chapter} draftBookTitle={draftBookTitle} books={books} openBook={openBook} openLibrary={() => setScene('library')}/></div>
    <nav className="lv-scene-tabs" role="tablist" aria-label={t('工作台')}>
      {[['listen','收听'],['studio','制作'],['library','书架']].map(([value,label]) => <button role="tab" key={value} aria-selected={scene===value} onClick={() => setScene(value)}>{t(label)}</button>)}
    </nav>
    <button className="lv-task-pill" onClick={openQueue} aria-label={t('任务')} title={tasks > 0 ? t('{count} 个任务', { count: tasks }) : t('任务')}>
      {tasks > 0 && <i/>}<span className="lv-task-label">{tasks > 0 ? t('{count} 个任务', { count: tasks }) : t('任务')}</span>
      <span className="lv-task-compact" aria-hidden="true">{tasks > 0 ? Math.min(tasks, 99) + (tasks > 99 ? '+' : '') : <Icon name="ListTodo"/>}</span>
    </button>
    <button className="lv-icon-button" aria-label={t('设置')} onClick={openSettings}><Icon name="Settings"/></button>
  </header>
}
