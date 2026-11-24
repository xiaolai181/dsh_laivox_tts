import { useEffect, useRef, useState } from 'react'

export function sceneFromWorkbench({ page, panel, reason }) {
  if (page === 'import') return { scene: 'library', libraryTab: 'books' }
  if (page === 'snippets') return { scene: 'library', libraryTab: 'snippets' }
  if (page === 'queue') return { sheet: 'queue' }
  if (panel === 'production') return { sheet: 'settings', focus: reason === 'MODEL_NOT_CONFIGURED' ? 'models' : 'laivox' }
  if (panel === 'settings') return { sheet: 'settings' }
  if (panel === 'roles') return { scene: 'studio', studioTab: 'roles' }
  if (panel === 'script') return { scene: 'studio', studioTab: 'script' }
  return {}
}

// Where the workbench opens: listening when a chapter is being restored (the
// last one, one asked for from the conversation, or audio already playing),
// otherwise the shelf.
export function initialScene(remembered, booting) {
  return remembered ?? (booting ? 'listen' : 'library')
}

// A restore that ended without a chapter (deleted, or could not be read) falls
// back to the shelf, unless the user already chose a scene or is creating a book.
export function restoreFallback({ wasBooting, booting, hasChapter, chosen, creating }) {
  return wasBooting && !booting && !hasChapter && !chosen && !creating ? 'library' : null
}

export function useScene(w, memory) {
  const [scene, updateScene] = useState(() => initialScene(memory.scene, w.booting))
  const [studioTab, setStudioTab] = useState('text')
  const [sheet, setSheet] = useState(null)
  const [focus, setFocus] = useState(null)
  const [railOpen, setRailOpen] = useState(false)
  // 「书架」or「对话音频」inside the library scene; kept while the panel is reopened.
  const [libraryTab, updateLibraryTab] = useState(memory.libraryTab === 'snippets' ? 'snippets' : 'books')
  function setLibraryTab(value) { memory.libraryTab = value; updateLibraryTab(value) }
  const [immersive, updateImmersive] = useState(memory.immersive !== false)
  function setScene(value) {
    const apply = () => { memory.scene = value; updateScene(value) }
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const transition=document.startViewTransition(apply)
      void transition.ready.catch(()=>{})
      void transition.finished.catch(()=>{})
    }
    else apply()
  }
  function openSheet(name, target) { setFocus(target ?? null); setSheet(name) }
  const previousChapter = useRef(memory.activeId)
  // Opening another chapter returns to listening, except the previous/next buttons
  // of the studio, which keep the user where they are working.
  useEffect(() => { if(w.chapter?.id){if(previousChapter.current!==w.chapter.id){if(memory.keepScene===w.chapter.id)memory.keepScene=null;else setScene('listen')}previousChapter.current=w.chapter.id} }, [w.chapter?.id])
  const wasBooting = useRef(w.booting)
  useEffect(() => {
    const next = restoreFallback({ wasBooting: wasBooting.current, booting: w.booting, hasChapter: Boolean(w.chapter),
      chosen: memory.scene != null, creating: Boolean(memory.creation) })
    wasBooting.current = w.booting
    if (next) setScene(next)
  }, [w.booting])
  useEffect(() => {
    const next = sceneFromWorkbench({ page: w.page, panel: w.panel, reason: w.errorCode })
    if (next.scene) setScene(next.scene)
    if (next.studioTab) setStudioTab(next.studioTab)
    if (next.libraryTab) setLibraryTab(next.libraryTab)
    if (next.sheet) openSheet(next.sheet, next.focus)
    if (w.page === 'queue' || w.page === 'snippets') w.setPage('reader')
    if (w.panel) w.setPanel(null)
  }, [w.page, w.panel])
  return { scene, setScene, studioTab, setStudioTab, libraryTab, setLibraryTab, sheet, focus, openSheet, closeSheet: () => setSheet(null), railOpen, setRailOpen,
    immersive, setImmersive: value => { memory.immersive = value; updateImmersive(value) } }
}
