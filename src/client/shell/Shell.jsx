import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { explain, get, upload } from '../api.mjs'
import { Decision, Overlay } from '../components/Overlay.jsx'
import { Sheet } from '../components/Sheet.jsx'
import { workbenchInsets } from '../components/frame.mjs'
import { PlanSheet } from '../sheets/PlanSheet.jsx'
import { ToastRegion } from '../components/Toast.jsx'
import { LibraryView, ImportPreview } from '../library/LibraryView.jsx'
import { LibraryScene } from '../library/LibraryScene.jsx'
import { SHELF_SPLIT_WIDTH, shelfMode, shouldLoadShelfChapters } from '../library/shelfLayout.mjs'
import { SnippetsView } from '../library/SnippetsView.jsx'
import { QueueSheet } from '../sheets/QueueSheet.jsx'
import { SettingsSheet } from '../sheets/SettingsSheet.jsx'
import { jobActive } from '../jobs/JobProgress.jsx'
import { TransportDock } from '../player/TransportDock.jsx'
import { shortcutAction, stepRate } from '../player/shortcuts.mjs'
import { continueDecision } from '../player/continuePlan.mjs'
import { mergeRoles } from '../workbench/state.mjs'
import { useWorkbench } from '../workbench/useWorkbench.mjs'
import { productionView } from '../workbench/productionView.mjs'
import { useScene } from '../workbench/useScene.mjs'
import { TopBar } from './TopBar.jsx'
import { ChapterRail } from './ChapterRail.jsx'
import { StageScene } from '../stage/StageScene.jsx'
import { StudioScene } from '../studio/StudioScene.jsx'
import { SaveBar } from '../studio/SaveBar.jsx'
import { deferText, getLanguage, translate as t } from '../i18n/locale.mjs'

function useResults(path, scope, size, initialOffset, version, query) {
  const [offset, setOffset] = useState(initialOffset)
  const [state, setState] = useState({ scope, value: null, error: '' })
  const [attempt, retry] = useState(0)
  useEffect(() => { setOffset(initialOffset) }, [scope, initialOffset])
  useEffect(() => { setOffset(0) }, [query])
  useEffect(() => {
    if (scope === false) return
    const abort = new AbortController()
    const timer = setTimeout(() => {
      get(path, { q: query, offset, book: scope || undefined }, abort.signal).then(value => {
        if (!abort.signal.aborted) setState({ scope, value, error: '' })
      }).catch(error => {
        if (!abort.signal.aborted) setState(previous => ({ scope, value: previous.scope === scope ? previous.value : null, error: deferText(() => explain(error)) }))
      })
    }, query ? 250 : 0)
    return () => { clearTimeout(timer); abort.abort() }
  }, [path, scope, query, offset, version, attempt])
  const value = state.scope === scope ? state.value : null
  const count = (value?.books ?? value)?.length ?? 0
  return { value, error: state.scope === scope ? state.error : '', reload: () => retry(n => n + 1), first: () => setOffset(0),
    previous: offset > 0 ? () => setOffset(Math.max(0, offset - size)) : undefined,
    next: count === size ? () => setOffset(offset + size) : undefined }
}

export function Shell({ player, navigation, memory, isPanelActive, useSessions }) {
  const w = useWorkbench(player, navigation, memory)
  const { chapter, options, busy, panel, page } = w
  const scene = useScene(w, memory)
  const [skin,setSkin] = useState(null)
  const root = useRef(null)
  const fileInput = useRef(null)
  const importing = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [width, setWidth] = useState(1000)
  const shelfOpen=scene.railOpen
  const setShelfOpen=scene.setRailOpen
  const [booksQuery, setBooksQuery] = useState('')
  const [chapterQuery, setChapterQuery] = useState('')
  const [shelfQuery, setShelfQuery] = useState('')
  const [shelfPick, setShelfPick] = useState(null)
  const [shelfDetail, setShelfDetail] = useState(false)
  const [batch, setBatch] = useState(false)
  const selectingAll = useRef(null)
  const [theme, setTheme] = useState(null)
  const [activity, bumpActivity] = useState(0)
  const active = jobActive(chapter?.operation)
  const books = useResults('library/books', null, 40, 0, w.shelfVersion, booksQuery)
  const shelfBookId = shelfPick?.id ?? (!chapter?.isSnippet ? chapter?.book : null)
  const shelfBook = books.value?.books?.find(item => item.id === shelfBookId) ??
    shelfPick ?? (shelfBookId ? { id: shelfBookId, title: chapter.bookTitle } : null)
  const onShelf = scene.scene === 'library' && scene.libraryTab === 'books' && page !== 'import'
  const shelfSplit = width >= SHELF_SPLIT_WIDTH
  const hasShelfBooks = (books.value?.books?.length ?? 0) > 0
  const viewShelfMode = shelfMode({ split: shelfSplit, hasBooks: hasShelfBooks, hasSelectedBook: Boolean(shelfBook), detail: shelfDetail })
  const shelfChapters = useResults('library/chapters',
    shouldLoadShelfChapters({ onShelf, mode: viewShelfMode, bookId: shelfBookId }) ? shelfBookId : false, 80,
    shelfQuery || shelfBookId !== chapter?.book ? 0 : Math.floor(((chapter?.ordinal ?? 1) - 1) / 80) * 80, w.shelfVersion, shelfQuery)
  const railChapters = useResults('library/chapters', scene.scene !== 'library' || shelfOpen ? w.book || false : false, 80,
    chapterQuery ? 0 : Math.floor(((chapter?.ordinal ?? 1) - 1) / 80) * 80, w.shelfVersion, chapterQuery)
  const roleData = useMemo(() => chapter ? mergeRoles(chapter, w.roleDraft) : { roles: [], conflicts: [] }, [chapter?.roles, w.roleDraft])
  const staleScript = w.scriptDraft && (w.scriptDraft.base.rev !== chapter?.rev || w.scriptDraft.base.editorialResultJob !== chapter?.editorialResultJob)
  const text = w.draft.text ?? chapter?.text ?? ''
  const keyMissing = options.engine === 'laivox' && w.keyInfo?.configured === false
  const view = productionView(chapter, options, { keyMissing })
  const currentStatus = w.actions.get(chapter?.operation?.id)

  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  // Sheets and toasts sit between the top bar and the dock; both change height
  // with the window width, so their edges are measured rather than assumed.
  const insetsObserver = useRef(null)
  function placeInsets() {
    const node = root.current
    if (!node) return
    const { top, bottom } = workbenchInsets(node)
    if (node.style.getPropertyValue('--lv-top-inset') !== top + 'px') node.style.setProperty('--lv-top-inset', top + 'px')
    if (node.style.getPropertyValue('--lv-dock-inset') !== bottom + 'px') node.style.setProperty('--lv-dock-inset', bottom + 'px')
    for (const part of node.querySelectorAll(':scope > .lv-top, :scope > .lv-transport')) insetsObserver.current?.observe(part)
  }
  useLayoutEffect(() => {
    insetsObserver.current = new ResizeObserver(placeInsets)
    insetsObserver.current.observe(root.current)
    return () => insetsObserver.current.disconnect()
  }, [])
  useLayoutEffect(placeInsets)
  useEffect(() => { setChapterQuery('') }, [w.book])
  useEffect(() => {
    if (!chapter || chapter.isSnippet) return
    setShelfPick(current => current?.id === chapter.book ? current : { id: chapter.book, title: chapter.bookTitle })
  }, [chapter?.book, chapter?.isSnippet])
  // Until a chapter has been shown, the shelf opens with its newest book's
  // contents (the built-in samples on a fresh install): one click to listen.
  const autoPick = useRef(true)
  useEffect(() => {
    if (chapter) { autoPick.current = false; return }
    const first = books.value?.books?.[0]
    if (!autoPick.current || !onShelf || shelfPick || booksQuery || !first) return
    autoPick.current = false
    setShelfPick(first)
  }, [chapter, onShelf, books.value, shelfPick, booksQuery])
  useLayoutEffect(() => {
    setShelfQuery(''); setBatch(false); w.clearSelection()
    return () => selectingAll.current?.abort()
  }, [shelfBookId])
  useEffect(() => { if (width >= 1024) setShelfOpen(false) }, [width])
  useEffect(() => () => importing.current?.abort(), [])
  useEffect(() => {
    memory.theme = theme ?? w.settings.values.theme
    memory.skin = skin ?? w.settings.values.skin ?? 'paper'
    window.dispatchEvent(new Event('lv-theme-change'))
  }, [w.settings.values.theme, w.settings.values.skin, theme, skin])
  // Chapter-end handoff while the workbench is open (it owns navigation and
  // drafts). With the panel closed, index.jsx continues in the mini capsule.
  const advancing = useRef(false)
  useEffect(() => {
    if (!player.onEnded) return
    return player.onEnded(() => {
      if (advancing.current) return
      const decision = continueDecision({ panelActive: isPanelActive?.() !== false, autoContinue: w.settings?.values?.autoContinue,
        nextId: w.chapter?.nextId, segments: player.getSnapshot().segments, dirty: w.dirty, open: w.chapter?.playbackJob?.open === true })
      if (decision.action === 'stay') { w.flashNotice(deferText(() => t('有未保存的修改，已停在本章'))); return }
      if (decision.action !== 'workbench') return
      advancing.current = true
      const target = { chapter: decision.chapter, autoplay: true }
      const visit = w.creating ? w.navigate({ ...target, keepScene: true, keepCreation: true }) : nav(target)
      void visit.finally(() => { advancing.current = false })
    })
  }, [w.chapter?.id, w.chapter?.nextId, w.settings?.values?.autoContinue, w.dirty, w.creating])

  function closePanel() { w.setPanel(null); scene.closeSheet(); setTheme(null); setSkin(null) }
  function notify(message) { w.flashNotice(message) }
  async function save() { try { await w.save(undefined, { preconfirmed: true }) } catch (error) { w.errors(error) } }
  async function saveCreation() { try { await w.save(null) } catch (error) { w.errors(error) } }
  function exitShelfDetail() {
    setShelfDetail(false)
    if (batch) { selectingAll.current?.abort(); w.clearSelection(); setBatch(false) }
  }
  function chooseScene(value) {
    if (value === 'library') exitShelfDetail()
    scene.setScene(value)
  }
  function selectLibraryTab(value) {
    if (value !== 'books') exitShelfDetail()
    scene.setLibraryTab(value)
  }
  async function cancelCreation() {
    const appending = Boolean(w.appendBook)
    if (!await w.cancelCreation()) return
    if (appending) setShelfDetail(true)
    else exitShelfDetail()
    scene.setLibraryTab('books')
    scene.setScene('library')
  }
  function showOnShelf(book) {
    setBooksQuery('')
    books.first()
    setShelfPick(book)
    setShelfDetail(true)
    scene.setLibraryTab('books')
    scene.setScene('library')
  }
  async function nav(target) {
    if (await w.navigate(target)) { setShelfOpen(false); setTheme(null); scene.closeSheet(); scene.setScene(target.new ? 'studio' : 'listen'); if(target.new)scene.setStudioTab('text') }
  }
  function openQueue(scope = null) {
    setShelfOpen(false); closePanel(); w.setQueueScope(scope); scene.openSheet('queue')
  }
  function blockedActions() {
    if (!w.blocked) return null
    return <div className="lv-blocked"><small>{t('{count} 个任务未结束。暂停的任务可继续或取消。', { count: w.blocked.total })}</small>
      <div className="lv-inline"><button onClick={() => openQueue({ book: w.blocked.book, chapter: w.blocked.chapter })}>{t("查看相关任务")}</button>
        {w.blocked.jobs.length === 1 && <button onClick={() => w.jobAction(w.blocked.jobs[0].id, 'cancel').finally(() => bumpActivity(n => n + 1))}>{t("取消该任务…")}</button>}</div></div>
  }
  async function openImport(task) {
    importing.current?.abort()
    const abort = new AbortController()
    importing.current = abort
    setUploading(true)
    try {
      const result = await task(abort.signal)
      if (!abort.signal.aborted) { w.showImport({ data: result, session: null }); scene.closeSheet(); setShelfOpen(false); w.refreshShelf() }
    } catch (error) { if (!abort.signal.aborted) w.errors(error) }
    finally { if (importing.current === abort) { importing.current = null; setUploading(false) } }
  }
  async function jumpBookmark() {
    const mark = chapter?.playback?.bookmark
    if (!mark) return
    try {
      const updated = await w.refresh(undefined, mark.job, true)
      if (!updated || updated.playbackJob?.id !== mark.job || !updated.media[mark.n]?.ready) {
        if (updated) await w.refresh(undefined, null, true)
        notify(deferText(() => t('书签所指的音频已不可用。')))
        return
      }
      player.seek(mark.n, mark.offset)
    } catch (error) { w.errors(error) }
  }
  function stepTo(n) {
    const snapshot = player.getSnapshot()
    const part = snapshot.segments[n]
    if (!part) return
    if (!part.ready) { void w.listenFrom(part.start); return }
    w.clearListen()
    player.seek(n)
  }
  function recastSelected() {
    if (!w.selection.size) return
    if (w.selection.size > 50) { notify(deferText(() => t('一次最多重新编剧 50 章，请分批选择'))); return }
    setShelfOpen(false)
    void w.generate('cast', true, deferText(() => t('会重新生成台词并覆盖手工修改。')), { batchBook: shelfBookId })
  }
  function changeSelection(action) {
    selectingAll.current?.abort()
    action()
  }

  const shelf = <LibraryView books={books} chapters={shelfChapters} selectedBook={shelfBook} active={chapter?.id}
    mode={viewShelfMode} split={shelfSplit} openShelfDetail={() => setShelfDetail(true)} closeShelfDetail={exitShelfDetail} openBook={id => nav({ book: id })}
    booksQuery={booksQuery} changeBooksQuery={setBooksQuery} chapterQuery={shelfQuery} changeChapterQuery={setShelfQuery}
    selectShelfBook={setShelfPick} openChapter={id => nav({ chapter: id })} listenChapter={id => nav({ chapter: id, autoplay: true })} clearAudio={w.clearAudio}
    uploading={uploading} cancelUpload={() => importing.current?.abort()}
    continueImport={id => openImport(signal => get('import/preview', { id, settled: 1 }, signal))}
    batch={batch} toggleBatch={() => {
      if (batch) { selectingAll.current?.abort(); w.clearSelection() }
      setBatch(!batch)
    }}
    selection={w.selection} toggleChapter={row => changeSelection(() => w.setSelection(current => {
      const next = new Map(current)
      if (next.has(row.id)) next.delete(row.id)
      else if (next.size < 500) next.set(row.id, row)
      return next
    }))} selectRows={(rows, append) => changeSelection(() => w.selectRows(rows, append))}
    invertRows={rows => changeSelection(() => w.invertRows(rows))} clearSelection={() => changeSelection(w.clearSelection)}
    selectBook={() => {
      selectingAll.current?.abort()
      const abort = new AbortController()
      selectingAll.current = abort
      void w.selectBook(shelfBookId, abort.signal)
    }} recastSelected={recastSelected}
    generateBatch={() => void w.generate('generate', true, '', { batchBook: shelfBookId })} disabled={busy}
    append={() => nav({ new: true, book: shelfBook.id, bookTitle: shelfBook.title })}
    exportState={w.exportState} exportFormat={w.exportFormat} setExportFormat={w.setExportFormat}
    exportBook={w.exportBook} cancelExport={w.cancelExport} options={options} renameBook={async (id, title) => {
      const saved = await w.renameBook(id, title)
      if (saved) setShelfPick(current => current?.id === id ? { ...current, title: title.trim() } : current)
      return saved
    }} deleteBook={async (id, meta) => {
      if (await w.deleteBook(id, meta)) {
        setShelfPick(current => current?.id === id ? null : current)
        if (shelfBookId === id) exitShelfDetail()
      }
    }}/>


  const appearance = { skin: skin ?? w.settings.values.skin ?? 'paper', theme: theme ?? w.settings.values.theme }
  const inProgress = (w.jobCounts.running ?? 0) + (w.jobCounts.queued ?? 0) + (w.jobCounts.paused ?? 0)
  const railBook = !chapter?.isSnippet && (chapter ? { id: chapter.book, title: chapter.bookTitle } : w.appendBook)
  const rail = <ChapterRail chapter={chapter} chapters={railChapters} query={chapterQuery} changeQuery={setChapterQuery}
    navigate={id=>nav({chapter:id})} create={railBook ? () => nav({ new: true, book: railBook.id, bookTitle: railBook.title }) : null}/>
  function keyDown(event) {
    if(event.defaultPrevented || event.target.closest('dialog,[popover],.lv-sheet'))return
    // Esc closes the open side panel even when focus has moved to the dock.
    if(event.key==='Escape' && (scene.sheet || w.dialog?.kind==='plan')){event.preventDefault();if(w.dialog?.kind==='plan')w.answer(null);else closePanel();return}
    if(event.key==='Escape' && onShelf && viewShelfMode==='detail' && !event.target.closest('input,textarea,select')){event.preventDefault();exitShelfDetail();return}
    if(event.target.closest('button,a,[role=tab],[role=listbox]'))return
    const action=shortcutAction(event)
    if(!action)return
    const snapshot=player.getSnapshot()
    const elapsed=snapshot.segments.slice(0,snapshot.n).reduce((sum,part)=>sum+(part.seconds||0),0)+snapshot.offset
    const actions={
      toggle:()=>{w.clearListen();player.toggle()},prev:()=>stepTo(snapshot.n-1),next:()=>stepTo(snapshot.n+1),
      slower:()=>player.speed(stepRate(snapshot.rate,-1)),faster:()=>player.speed(stepRate(snapshot.rate,1)),
      back10:()=>{if(snapshot.segments.every(part=>part.ready)){w.clearListen();player.seekTime(elapsed-10)}},
      forward10:()=>{if(snapshot.segments.every(part=>part.ready)){w.clearListen();player.seekTime(elapsed+10)}},
      search:()=>{if(width<1024){setShelfOpen(true);setTimeout(()=>root.current?.querySelector('[data-lv-chapter-search]')?.focus(),0)}else root.current?.querySelector('[data-lv-chapter-search]')?.focus()},
    }
    event.preventDefault();actions[action]?.()
  }
  return <main ref={root} lang={getLanguage()} className="lv-ui lv-workbench" data-skin={appearance.skin} data-theme={appearance.theme} onKeyDown={keyDown} tabIndex={-1}>
    <input ref={fileInput} type="file" hidden accept=".txt,.epub,.pdf" onChange={event=>{
      const file=event.target.files[0];event.target.value='';if(file)void openImport(signal=>upload(file,signal))
    }}/>
    <TopBar chapter={chapter} draftBookTitle={w.appendBook?.title} books={books.value?.books} openBook={id=>nav({book:id})} scene={scene.scene} setScene={chooseScene} tasks={inProgress} openQueue={()=>openQueue()} openSettings={()=>scene.openSheet('settings')} openRail={()=>setShelfOpen(true)}/>
    <div className="lv-shell-body">
      {width>=1024 && scene.scene!=='library' && (chapter || w.booting) && rail}
      <div className="lv-scene-room">
        {w.error && !scene.sheet && scene.sheet !== 'settings' && <div className="lv-inline lv-error" role="alert">{w.error}{w.memory.activeId && !w.creationSaved && <button onClick={()=>w.reloadChapter().then(w.clearError).catch(w.errors)}>{t("重新加载")}</button>}</div>}
        {blockedActions()}
        {scene.scene==='listen' && <StageScene w={w} player={player} immersive={scene.immersive} setImmersive={scene.setImmersive} navigate={id=>nav({chapter:id})} listenFrom={w.listenFrom} create={()=>nav({new:true})} openImport={()=>fileInput.current.click()} books={books.value?.books} openBook={id=>nav({book:id})} openLibrary={()=>chooseScene('library')}/>}
        {scene.scene==='studio' && <StudioScene w={w} player={player} tab={scene.studioTab} change={scene.setStudioTab} roleData={roleData} staleScript={staleScript} saveCreation={saveCreation} cancelCreation={cancelCreation} openQueue={()=>openQueue({chapter:chapter?.id})}/>}
        {scene.scene==='library' && <LibraryScene create={()=>nav({new:true})} creatingDisabled={busy} importFile={()=>fileInput.current.click()} uploading={uploading}
          tab={page==='import' && w.importEntry ? 'books' : scene.libraryTab} setTab={page==='import' && w.importEntry ? null : selectLibraryTab}
          compactHeader={scene.libraryTab==='books' && !(page==='import' && w.importEntry) && viewShelfMode==='detail'}
          split={scene.libraryTab==='books' && !(page==='import' && w.importEntry) && viewShelfMode==='split'}>
          {scene.libraryTab==='snippets' && !(page==='import' && w.importEntry) ? <SnippetsView useSessions={useSessions} version={w.shelfVersion} decide={w.decide} notify={notify}
            open={(chapter,job)=>nav({chapter,job,autoplay:true})} openBook={showOnShelf} forget={w.forgetBooks}
            renamed={book=>{w.refreshShelf();if(chapter?.book===book)void w.refresh().catch(()=>{})}} openSettings={()=>scene.openSheet('settings','storage')}/>
          : page==='import' && w.importEntry ? <ImportPreview key={w.importEntry.data.id} entry={w.importEntry} close={()=>w.setPage('reader')} refresh={w.refreshShelf} decide={w.decide} openBook={id=>nav({book:id})} published={()=>notify(deferText(() => t('电子书已导入到书架。')))}/> : shelf}
        </LibraryScene>}
      </div>
    </div>
    {!(scene.scene === 'library' || (scene.scene === 'studio' && w.creating)) && <SaveBar w={w} save={save}/>}
    <TransportDock player={player} chapter={chapter} view={view} refresh={w.refresh} listenOlder={w.listenOlder} notify={notify} listenFrom={w.listenFrom} clearListen={w.clearListen} jumpBookmark={chapter?.playback?.bookmark?jumpBookmark:null} clearAudio={chapter?.media?.some(part=>part.ready)?()=>w.clearAudio({chapter:chapter.id}):null}/>
    <ToastRegion message={w.notice} onDismiss={w.clearNotice}/>
    {shelfOpen && width<1024 && <Overlay title={t("目录")} variant="shelf" close={()=>setShelfOpen(false)} {...appearance}>{rail}<button onClick={()=>{setShelfOpen(false);chooseScene('library')}}>{t("打开书架")}</button></Overlay>}
    {scene.sheet==='queue' && <Sheet title={t("任务")} close={closePanel}>
      <QueueSheet scope={w.queueScope} clearScope={()=>w.setQueueScope(null)} actions={w.actions} refreshKey={activity} decide={w.decide} notify={notify}
        run={async(id,action)=>{await w.jobAction(id,action);bumpActivity(n=>n+1)}} close={closePanel} open={(chapter,job)=>nav({chapter,job})} openStorage={()=>scene.openSheet('settings','storage')}/>
    </Sheet>}
    {scene.sheet==='settings' && <Sheet title={t("设置")} close={closePanel}>{w.error && <p role="alert">{w.error}</p>}<SettingsSheet focus={scene.focus} w={w} space={books.value?.space} player={player}/></Sheet>}
    {w.dialog?.kind==='plan' && <Sheet key="plan" title={t("制作单")} className="lv-sheet-plan" close={()=>w.answer(null)}><PlanSheet dialog={w.dialog} answer={w.answer} narratorSetting={w.settings.values.laivoxNarratorDefault} account={w.keyInfo?.account}/></Sheet>}
    {w.dialog && w.dialog.kind!=='plan' && <Decision dialog={w.dialog} answer={w.answer} {...appearance}/>}
  </main>
}
