import { deferText, displayText, isDeferredText, translate as t } from '../i18n/locale.mjs'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { explain, formatBytes, get, post, url } from '../api.mjs'
import { nextPollDelay } from './polling.mjs'
import { chapterBase, clearLastChapter, dropRoleVoice, lastChapterKey, mergeProgress, mergeRoles, resolveRoleConflict, roleDraftUpdate } from './state.mjs'
import { decideListen } from '../player/listenPlan.mjs'
import { KEEP_PREVIOUS_AUDIO } from '../../domain/production.mjs'
import { estimateAiCalls } from '../../domain/ai.mjs'
import { createSettingsQueue } from './settingsQueue.mjs'
import { openUsageDay } from './laivox.mjs'
import { diffNewPausedJobs, pauseNoticeFor, pauseNoticeKey, scanPausedJobs } from './pauseNotice.mjs'

const pageSize = 80
const activeJob = job => ['queued', 'running', 'paused'].includes(job?.state)
const unknown = error => !error.status || error.status >= 500 || error.message === 'SERVICE_UNAVAILABLE'
const modeOptions = ({ engine, mode, clean, selection }) => ({ engine, mode, clean, selection })
// Fields that change what the workbench renders. Polls with an unchanged
// signature skip the React update but still hand the fresh value back.
const signatureOf = view => [
  view?.rev, view?.rolesRev, view?.editorialResultJob, view?.cleanPreviewJob,
  view?.operation?.id, view?.operation?.state, view?.operation?.rev,
  // Progress inside a running job: without these, cleaning and scripting
  // batches (and the production mosaic) would not repaint until synthesis.
  view?.operation?.stage, view?.operation?.counts?.clean?.done, view?.operation?.counts?.cast?.done,
  view?.operation?.synthesis?.done, view?.operation?.ai?.requests, view?.operation?.error,
  view?.operation?.pauseReason, view?.operation?.laivoxPause?.kind, view?.operation?.laivoxPause?.until, view?.operation?.autoResume?.at, view?.operation?.live?.removed?.length,
  view?.operation?.scope, view?.operation?.retake ? 1 : 0, Array.isArray(view?.operation?.ranges) ? view.operation.ranges.map(range => range.join(':')).join(',') : '',
  Array.isArray(view?.media) ? view.media.length : 0,
  Array.isArray(view?.media) ? view.media.reduce((count, part) => count + (part.ready ? 1 : 0), 0) : 0,
  view?.playbackJob?.id,
  view?.playbackStale ? 1 : 0,
  view?.previousComplete?.id,
].join('|')

// Audio started elsewhere (the chat, the capsule) that the workbench should open.
const livePlayback = player => {
  const live = player.getSnapshot()
  return live.chapter && live.job && ['playing', 'buffering', 'paused', 'blocked'].includes(live.phase) ? live : null
}

export function useWorkbench(player, navigation, memory) {
  const pending = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
  const active = useRef(null)
  const [chapter, setChapter] = useState(null)
  const [creation, setCreation] = useState(memory.creation ?? null)
  const [, redraw] = useState(0)
  const [options, setOptions] = useState(() => memory.options ?? modeOptions(memory.settings.values))
  const [models, setModels] = useState(null)
  const [keyInfo, setKeyInfo] = useState(null)
  const [keySavedAt, setKeySavedAt] = useState(0)
  const [resumedAfterKey, setResumedAfterKey] = useState(() => new Set())
  const keyRead = useRef(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [blocked, setBlocked] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [page, setPage] = useState('reader')
  const [panel, setPanel] = useState(null)
  const [importEntry, setImportEntry] = useState(null)
  const [shelfVersion, changeShelf] = useState(0)
  const [selection, setSelection] = useState(new Map())
  const [queueScope, setQueueScope] = useState(null)
  const [jobCounts, setJobCounts] = useState({})
  const countsRef = useRef(null)
  const [actions, setActions] = useState(new Map())
  // A chapter is about to be restored: the remembered one, one asked for from the
  // conversation, or audio already playing elsewhere (see the mount effect).
  const [booting, setBooting] = useState(() => Boolean(memory.activeId || pending?.chapter || pending?.book || livePlayback(player)))
  const [exportState, setExportState] = useState(null)
  const [exportFormat, setExportFormat] = useState('mp3')
  const life = useRef(false)
  const navOrder = useRef(0)
  const viewOrder = useRef(0)
  const dialogRef = useRef(null)
  const planCancelled = useRef(false)
  const busyRef = useRef(new Set())
  const jobRef = useRef(new Map())
  const pendingListen = useRef(null)
  const steered = useRef(new Set())
  const navRead = useRef(null)
  const noticeTimer = useRef(null)
  const exportRef = useRef({ timer: null })
  const keyInfoRef = useRef(keyInfo)
  keyInfoRef.current = keyInfo
  const pausedBaselineRef = useRef(null)
  const seenPausedRef = useRef(new Set())
  const pendingPausedEdgeRef = useRef(null)
  const pendingBaselineShrinkRef = useRef(false)
  const pendingToastRef = useRef(null)
  const errors = error => {
    if (!life.current) return
    setError(error)
    setBlocked(error.details?.jobs ? error.details : null)
  }
  const repaint = () => { if (life.current) redraw(n => n + 1) }
  function clearNotice() {
    if (noticeTimer.current) { clearTimeout(noticeTimer.current); noticeTimer.current = null }
    if (life.current) setNotice('')
  }
  function flashNotice(message) {
    if (!life.current) return
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice(message)
    const duration = Number.isFinite(message?.durationMs) && message.durationMs > 0 ? message.durationMs : 6000
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null
      if (life.current) setNotice('')
    }, duration)
  }
  function rememberExistingPaused(job) {
    if (!job?.id) return
    pausedBaselineRef.current?.add(job.id)
    const key = pauseNoticeKey(job)
    if (key) seenPausedRef.current.add(key)
  }
  function forgetPausedJob(id) {
    if (!id) return
    pausedBaselineRef.current?.delete(id)
    const prefix = id + ':'
    for (const key of seenPausedRef.current) {
      if (key.startsWith(prefix)) seenPausedRef.current.delete(key)
    }
  }
  async function openUsageDayAction() {
    try {
      const result = await openUsageDay(decide)
      if (result.opened) {
        flashNotice(deferText(() => t('已开启下一个使用日，点「继续制作」接着制作')))
        await refresh().catch(() => {})
      } else if (result.message) flashNotice(result.message)
    } catch (error) { errors(error) }
  }
  function presentPauseNotice(job) {
    if (!life.current || !pauseNoticeKey(job)) return
    const item = pauseNoticeFor(job, {
      explain,
      packPage: keyInfoRef.current?.packPage,
      currentChapterId: active.current?.view?.id,
      openDay: () => void openUsageDayAction(),
      openSettings: () => setPanel('production'),
      openRoles: () => setPanel('roles'),
      openQueue: () => { setQueueScope(null); setPage('queue') },
    })
    if (typeof document !== 'undefined' && document.hidden) pendingToastRef.current = item
    else flashNotice(item)
  }
  const chapterKey = chapter?.id ?? 'new'
  const book = chapter?.book ?? null
  const draft = chapter ? memory.drafts.get(chapterKey) ?? {} : {}
  const appendBook = creation?.book ?? null
  const newDraft = memory.drafts.get('new') ?? {}
  const scriptDraft = memory.scripts.get(chapterKey) ?? null
  const roleDraft = book && memory.roles.get(book)
  const dirty = Object.keys(draft).length > 0 || !!scriptDraft || !!roleDraft
  const busy = busyRef.current.size > 0

  function decide(spec) {
    if (dialogRef.current || !life.current) return Promise.resolve(null)
    return new Promise(resolve => {
      dialogRef.current = resolve
      setDialog(spec)
    })
  }
  function answer(value) {
    dialogRef.current?.(value)
    dialogRef.current = null
    if (value?.revise) {
      if (life.current) setDialog(previous=>({...previous,pending:true,plan:{...previous.plan,options:value.revise}}))
    } else {
      planCancelled.current = value === null && dialog?.kind === 'plan'
      if (life.current) setDialog(null)
    }
  }
  function reviseOptions(value) {
    setOptions(previous => {
      const next = typeof value === 'function' ? value(previous) : value
      memory.options = next
      return next
    })
  }
  function editDraft(value) {
    if (Object.keys(value).length) memory.drafts.set(chapterKey, { ...value, base: draft.base ?? chapterBase(chapter), book })
    else memory.drafts.delete(chapterKey)
    repaint()
  }
  function showCreation(value) {
    memory.creation = value
    if (life.current) setCreation(value)
  }
  function editNewDraft(value) {
    if (!memory.creation) showCreation({ book: null })
    memory.drafts.set('new', { ...value, book: appendBook?.id })
    repaint()
  }
  // Only move a draft onto a newer baseline. Content stays untouched so the
  // user can review it before saving again.
  function rebaseDraft(base) {
    const current = memory.drafts.get(chapterKey)
    if (!current || !base) return false
    memory.drafts.set(chapterKey, { ...current, base })
    repaint()
    return true
  }
  function editScript(value) {
    if (value) memory.scripts.set(chapterKey, { ...value, base: scriptDraft?.base ?? chapterBase(chapter) })
    else memory.scripts.delete(chapterKey)
    repaint()
  }
  function editRole(patch) {
    const current = active.current?.view
    if (!current) return
    memory.roles.set(current.book, roleDraftUpdate(memory.roles.get(current.book), current, patch))
    repaint()
  }
  function chooseRoleConflict(conflict, keep) {
    const next = resolveRoleConflict(roleDraft, chapter, conflict, keep)
    if (next) memory.roles.set(book, next)
    else memory.roles.delete(book)
    repaint()
  }
  // A voice picked in the voice list is saved right away (role/save); it does
  // not wait for the draft's save button. The draft forgets that field so it
  // cannot override the saved value later. Throws for the picker to show.
  async function saveRoleVoice(roleId, engine, voice, extra = {}) {
    const current = active.current?.view
    if (!current) throw new Error('CHAPTER_NOT_FOUND')
    const confirmedCount = Number.isInteger(extra.confirmedCount) ? extra.confirmedCount : null
    let rejoined = false
    try {
      try { await post('role/save', { chapter: current.id, role: roleId, engine, voice }) }
      catch (error) {
        // A voice change affects the whole book: unfinished tasks of the book must stop first.
        if (error?.message !== 'TASKS_BLOCK_SAVE') throw error
        const total = error?.details?.total
        const allow = confirmedCount != null && total <= confirmedCount
        const decision = await stopBlockingTasks(error.details, allow ? { preconfirmed: true, allowBook: true } : {})
        if (!decision) throw error
        await post('role/save', { chapter: current.id, role: roleId, engine, voice })
        if (decision.stopped?.length) { offerRejoin(decision.stopped); rejoined = true }
      }
      const next = dropRoleVoice(memory.roles.get(current.book), roleId, engine, voice)
      if (next) memory.roles.set(current.book, next)
      else memory.roles.delete(current.book)
      if (!rejoined) flashNotice(deferText(() => t('已保存，下次合成生效')))
    } finally {
      // role/save has no receipt: a timeout may still have saved, so read back.
      await refresh().catch(() => {})
    }
  }
  // A role-only save (or a voice-rule upgrade) bumps this chapter without
  // rewriting its text or script. Drafts still based on the revision we just
  // replaced move onto the new base; a draft that was already stale stays put.
  function liftDraftBases(chapterId, beforeRev, committed) {
    if (!committed || committed.rev !== beforeRev + 1) return false
    const next = { rev: committed.rev, rolesRev: committed.rolesRev, editorialResultJob: committed.editorialResultJob ?? null }
    let moved = false
    const body = memory.drafts.get(chapterId)
    if (body?.base?.rev === beforeRev) { memory.drafts.set(chapterId, { ...body, base: next }); moved = true }
    const script = memory.scripts.get(chapterId)
    if (script?.base?.rev === beforeRev) { memory.scripts.set(chapterId, { ...script, base: next }); moved = true }
    return moved
  }
  // Name, gender and age save on their own. The body must not include the open
  // text or script, and the operation key must not collide with a chapter save.
  async function saveRoleProfile(patch) {
    const current = active.current?.view
    if (!current || !patch?.id) return { ok: false, reason: 'failed' }
    const key = 'role-profile:' + current.book + ':' + patch.id
    if (busyRef.current.has(key)) return { ok: false, reason: 'busy' }
    const before = chapterBase(current)
    const body = { id: current.id, book: current.book, base: before, patch: { roles: [patch] } }
    busyRef.current.add(key)
    repaint()
    try {
      let committed
      let rejoined = false
      try {
        committed = (await operation(key, 'production/save', { body, snapshot: null })).result
      } catch (error) {
        if (error?.message !== 'TASKS_BLOCK_SAVE') throw error
        const decision = await stopBlockingTasks(error.details, {})
        if (!decision) { errors(error); return { ok: false, reason: 'dismissed' } }
        committed = (await operation(key, 'production/save', { body, snapshot: null })).result
        if (decision.stopped?.length) { offerRejoin(decision.stopped); rejoined = true }
      }
      liftDraftBases(current.id, before.rev, committed)
      await refresh().catch(() => {})
      setBlocked(null)
      setError('')
      if (!rejoined) flashNotice(deferText(() => t('修改已保存')))
      return { ok: true, id: patch.id }
    } catch (error) {
      if (error?.message === 'OPERATION_PENDING') return { ok: false, reason: 'pending', error }
      if (error?.message === 'VERSION_CONFLICT') {
        await refresh().catch(() => {})
        return { ok: false, reason: 'conflict', error }
      }
      return { ok: false, reason: 'failed', error }
    } finally {
      busyRef.current.delete(key)
      repaint()
    }
  }
  // Moves the book to the latest automatic voice rule after the user confirmed.
  async function upgradeVoiceRule() {
    const current = active.current?.view
    if (!current) return false
    const before = chapterBase(current)
    const text = current.text
    const editorialResultJob = current.editorialResultJob ?? null
    let ok = false
    try {
      await post('book/voice-rule', { book: current.book, rule: 2, baseRolesRev: current.rolesRev })
      ok = true
      flashNotice(deferText(() => t('已改用新的自动分配规则')))
      return true
    } catch (error) {
      flashNotice(deferText(() => explain(error)))
      return false
    } finally {
      const fresh = await refresh().catch(() => null)
      if (ok && fresh && fresh.rev === before.rev + 1 && fresh.text === text && (fresh.editorialResultJob ?? null) === editorialResultJob) {
        if (liftDraftBases(current.id, before.rev, { rev: fresh.rev, rolesRev: fresh.rolesRev, editorialResultJob: fresh.editorialResultJob ?? null })) repaint()
      }
    }
  }
  function discardRoles() {
    memory.roles.delete(book)
    repaint()
  }

  function applyChapter(value, pin = null, adopt = true, autoplay = false) {
    if (active.current?.view.book !== value.book) setSelection(new Map())
    active.current = { view: value, pin, signature: signatureOf(value) }
    memory.activeId = value.id
    try { localStorage.setItem(lastChapterKey, value.id) } catch {}
    if (value?.operation?.state === 'paused') rememberExistingPaused(value.operation)
    setChapter(value); setPage('reader'); setPanel(null)
    setError(''); setBlocked(null); clearNotice()
    player.update(value, adopt)
    if (autoplay && value?.playbackJob && Array.isArray(value.media) && value.media.some(part => part.ready)) player.play()
  }

  async function refresh(signal, pin, takeFocus = false) {
    const target = active.current
    if (!target) return
    if (signal && target.adopting) return
    const order = ++viewOrder.current
    const params = { id: target.view.id, job: pin === undefined ? target.pin : pin }
    const adopting = Boolean(pin) || takeFocus
    if (adopting) target.adopting = order
    try {
      let value = await get(signal ? 'chapter/progress' : 'chapter', params, signal)
      if (signal) {
        const changed = ['rev', 'rolesRev', 'editorialResultJob', 'cleanPreviewJob'].some(key => target.view[key] !== value[key])
          || target.view.playbackJob?.id !== value.playbackJob?.id
        value = changed ? await get('chapter', params, signal) : mergeProgress(target.view, value)
      }
      if (!life.current || active.current !== target || signal?.aborted || order < (target.applied ?? 0) ||
        (target.adopting && order < target.adopting)) return
      target.applied = order
      if (target.pinOlder && !['queued', 'running', 'paused'].includes(value.operation?.state)) {
        target.pinOlder = null
        params.job = undefined
        value = await get('chapter', { id: target.view.id }, signal)
      }
      target.pin = params.job
      const signature = signatureOf(value)
      const quiet = Boolean(signal) && target.signature === signature
      target.view = value
      target.signature = signature
      if (!quiet) {
        setChapter(value)
        player.update(value, adopting || !player.getSnapshot().job)
      }
      const pKey = pauseNoticeKey(value?.operation)
      if (pKey && !seenPausedRef.current.has(pKey)) {
        seenPausedRef.current.add(pKey)
        pausedBaselineRef.current?.add(value.operation.id)
        presentPauseNotice(value.operation)
      }
      return value
    } finally { if (target.adopting === order) target.adopting = null }
  }

  useEffect(() => {
    const open = () => {
      try {
        if (sessionStorage.getItem('laivox-open-production') !== '1') return
        sessionStorage.removeItem('laivox-open-production')
      } catch { return }
      setPanel('production')
    }
    open()
    window.addEventListener('laivox-open-settings', open)
    return () => window.removeEventListener('laivox-open-settings', open)
  }, [])

  async function listenOlder(id) {
    const target = active.current
    if (!target || typeof id !== 'string' || !id) return
    target.pinOlder = id
    return refresh(undefined, id, true)
  }

  async function reloadChapter() {
    if (active.current) return refresh()
    if (!memory.activeId) return
    const value = await get('chapter', { id: memory.activeId })
    if (life.current && !active.current) applyChapter(value)
    return value
  }

  async function operation(key, path, input) {
    let remembered = memory.operations.get(key)
    if (remembered) {
      const result = await get('operations/result', { id: remembered.body.operationId }).catch(() => null)
      if (result) { memory.operations.delete(key); return { result, snapshot: remembered.snapshot, recovered: true } }
    } else {
      remembered = { body: { ...input.body, operationId: crypto.randomUUID() }, snapshot: input.snapshot }
      memory.operations.set(key, remembered)
    }
    try {
      const result = await post(path, remembered.body)
      memory.operations.delete(key)
      return { result, snapshot: remembered.snapshot, recovered: false }
    } catch (error) {
      if (!unknown(error)) { memory.operations.delete(key); throw error }
      throw new Error('OPERATION_PENDING', { cause: error })
    }
  }

  // Both the client-side base check and a server 409 land here. Fetch the
  // latest projection first so a rebase uses the server's current revision.
  async function handleConflict(target) {
    if (!life.current || !active.current) return
    let fresh
    try { fresh = await refresh(undefined, target?.pin) }
    catch (error) { errors(error); return }
    if (!fresh || !life.current) return
    // Only a text draft can move onto the new version. A script draft belongs to
    // the old text and would conflict again on every save, so it is only offered
    // for copying.
    const draftKey = target?.id ?? 'new'
    const canRebase = memory.drafts.has(draftKey) && !memory.scripts.has(draftKey)
    const choice = await decide(canRebase ? {
      title: deferText(() => t('章节版本已变化')),
      text: deferText(() => t('可以载入最新版本并保留你的草稿，检查后再保存；或先复制草稿。')),
      choices: [['rebase', deferText(() => t('载入最新并保留草稿'))], ['copy', deferText(() => t('复制草稿'))], [null, deferText(() => t('暂不保存'))]],
    } : {
      title: deferText(() => t('章节版本已变化')),
      text: deferText(() => memory.scripts.has(draftKey)
        ? t('台词修改基于旧版本，不能直接套用到新版本。可以先复制草稿，放弃台词修改后再重新调整。')
        : t('最新版本已载入。可以先复制草稿，再重新修改。')),
      choices: [['copy', deferText(() => t('复制草稿'))], [null, deferText(() => t('暂不保存'))]],
    })
    if (!life.current) return
    if (choice === 'rebase') {
      if (rebaseDraft(chapterBase(fresh))) flashNotice(deferText(() => t('已载入最新版本，请检查后再次保存')))
      return
    }
    if (choice === 'copy') {
      const key = target?.id ?? 'new'
      const bodyDraft = memory.drafts.get(key) ?? {}
      const script = memory.scripts.get(key)
      const title = bodyDraft.title ?? target?.title ?? ''
      const body = bodyDraft.text ?? target?.text ?? ''
      const payload = [title, body].filter(Boolean).join('\n\n')
        + (script ? '\n\n' + JSON.stringify(script.annotations, null, 2) : '')
      if (!navigator.clipboard?.writeText) { flashNotice(deferText(() => t('无法访问剪贴板，请手动复制。'))); return }
      navigator.clipboard.writeText(payload).then(
        () => flashNotice(deferText(() => t('草稿已复制'))),
        () => flashNotice(deferText(() => t('无法访问剪贴板，请手动复制。'))),
      )
    }
  }

  // A save that unfinished tasks block (TASKS_BLOCK_SAVE): saving would change the
  // revision the tasks were planned for, so they have to stop first. Ask once,
  // stop them, wait until they really ended, and report the choice; null keeps
  // the old behaviour (the error and its "related tasks" banner).
  async function stopBlockingTasks(details, { offerContinue = false, preconfirmed = false, allowBook = false } = {}) {
    if (!details?.total) return null
    const scope = details.chapter ? { chapter: details.chapter } : { book: details.book }
    const count = details.total
    const listed = details.jobs ?? []
    const waitingOnly = listed.length === count && listed.every(job => job.state === 'paused' || job.state === 'queued')
    let choice = 'stop'
    if (!(preconfirmed && waitingOnly && (allowBook || details.chapter))) choice = await decide({
      title: deferText(() => t('先停止相关任务？')),
      text: deferText(() => details.chapter
        ? t('本章还有 {count} 个制作任务未结束（含暂停的）。保存前需要先停止它们；已合成的音频会保留，重新制作时直接复用，正在进行的 AI 清洗或编剧会从头开始。', { count })
        : t('书中还有 {count} 个任务未结束（含暂停的）。修改角色或音色会影响全书，需要先停止这些任务；已合成的音频会保留，重新制作时直接复用，正在进行的 AI 清洗或编剧会从头开始。', { count })),
      choices: [
        ...(details.chapter && offerContinue ? [['continue', deferText(() => t('停止任务，保存并继续制作'))]] : []),
        ['stop', deferText(() => details.chapter ? t('停止任务并保存') : t('停止这些任务并保存'))],
        [null, deferText(() => t('返回'))],
      ],
    })
    if (!choice) return null
    const before = await post('jobs/action', { action: 'bulk-preview', mode: 'cancel', scope })
    const stopped = (before.jobs ?? []).filter(job => job.purpose === 'generate' && job.chapter)
    await post('jobs/action', { action: 'bulk', mode: 'cancel', scope })
    // A running task ends a moment after it is told to: wait until none is left.
    for (let attempt = 0; attempt < 60; attempt++) {
      const { ids } = await post('jobs/action', { action: 'bulk-preview', mode: 'cancel', scope })
      if (!ids?.length) break
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return { choice, stopped }
  }

  async function save(target = active.current?.view, { fromGenerate = false, preconfirmed = false } = {}) {
    try { return await saveOnce(target) }
    catch (error) {
      if (error?.message !== 'TASKS_BLOCK_SAVE' || !target) throw error
      const decision = await stopBlockingTasks(error.details, { offerContinue: !fromGenerate, preconfirmed })
      if (!decision) throw error
      const saved = await saveOnce(target)
      if (saved && decision.choice === 'continue') {
        const job = (error.details?.jobs ?? []).find(item => item.purpose === 'generate') ?? error.details?.jobs?.[0]
        setTimeout(() => { void generate('generate', false, '', { clean: false, ...jobEngine(job) }) }, 0)
      } else if (saved && decision.stopped?.length) offerRejoin(decision.stopped)
      return saved
    }
  }

  async function saveOnce(target = active.current?.view) {
    const key = target?.id ?? 'new'
    const bodyDraft = memory.drafts.get(key)
    const script = memory.scripts.get(key)
    const roles = target && memory.roles.get(target.book)
    const requestKey = 'save:' + key
    const savedChapter = !target && creation?.savedChapter
    if (!savedChapter && !memory.operations.has(requestKey) && !bodyDraft && !script && !roles) return target
    if (busyRef.current.has(requestKey)) return
    busyRef.current.add(requestKey); repaint()
    try {
      if (savedChapter) {
        const value = await get('chapter', { id: savedChapter })
        if (life.current) {
          showCreation(null)
          applyChapter(value)
        }
        return value
      }
      let dropScript = false
      if (!memory.operations.has(requestKey)) {
        if (!target && (!bodyDraft?.text?.trim() || (!appendBook && !bodyDraft?.bookTitle?.trim()))) {
          flashNotice(deferText(() => appendBook ? t('请填写章节正文') : t('请填写书名和首章正文')))
          return
        }
        if (roles && mergeRoles(target, roles).conflicts.length) {
          setPanel('roles')
          throw new Error('ROLE_DRAFT_CONFLICT')
        }
        if (target && bodyDraft?.text !== undefined && bodyDraft.text !== target.text && (script || target.editorial)) {
          const choice = await decide({ title: deferText(() => t('保存新正文？')), text: deferText(() => t('保存后需要重新检查清洗结果和台词。之前生成的音频仍可播放。')),
            choices: [['save', deferText(() => t('保存新正文'))], [null, deferText(() => t('返回编辑'))]] })
          if (!choice) return
          dropScript = true
        }
        const live = chapterBase(target)
        const base = bodyDraft?.base ?? (dropScript ? null : script?.base) ?? live
        if (target && (base.rev !== live.rev || base.editorialResultJob !== live.editorialResultJob ||
          (script && !dropScript && (script.base.rev !== live.rev || script.base.editorialResultJob !== live.editorialResultJob)))) throw new Error('VERSION_CONFLICT')
      }
      const result = await operation(requestKey, 'production/save', {
        body: { id: target?.id, book: target?.book ?? appendBook?.id, base: chapterBase(target), patch: {
          bookTitle: !target && !appendBook ? bodyDraft?.bookTitle : undefined,
          title: bodyDraft?.title, text: bodyDraft?.text, editorial: dropScript ? undefined : script ?? undefined,
          roles: roles ? [...roles.patches.values()] : [],
        } },
        snapshot: { bodyDraft, script, roles },
      })
      const committed = result.result
      const snapshot = result.snapshot
      const later = memory.drafts.get(key)
      if (later === snapshot.bodyDraft) memory.drafts.delete(key)
      else if (later) {
        memory.drafts.delete(key)
        memory.drafts.set(committed.id, { ...later, base: chapterBase(committed) })
      }
      if (memory.scripts.get(key) === snapshot.script) memory.scripts.delete(key)
      if (memory.roles.get(committed.book) === snapshot.roles) memory.roles.delete(committed.book)
      if (!target) showCreation({ book: appendBook, savedChapter: committed.id })
      if (life.current) {
        setBlocked(null); setError('')
        changeShelf(n => n + 1)
        try {
          if (target) await refresh()
          else {
            const value = await get('chapter', { id: committed.id })
            if (life.current) {
              showCreation(null)
              applyChapter(value)
            }
          }
          flashNotice(deferText(() => target ? t('修改已保存') : appendBook ? t('章节已添加') : t('书籍已创建')))
        } catch {
          flashNotice(deferText(() => t('修改已保存，刷新失败。')))
          setError(deferText(() => target ? t('请使用“重新加载”重新读取章节。') : t('内容已保存，请重试打开刚保存的章节。')))
        }
      }
      return committed
    } catch (error) {
      if (error.message === 'VERSION_CONFLICT') {
        await handleConflict(target)
        return
      }
      throw error
    } finally { busyRef.current.delete(requestKey); repaint() }
  }

  async function leave(targetId) {
    const current = active.current?.view
    if (targetId && current?.id === targetId) return 'keep'
    const key = current?.id ?? 'new'
    if (memory.operations.has('save:' + key)) {
      setError(deferText(() => current ? t('请先确认保存结果。点击“保存修改”可安全重试。') : t('请回到制作页，点击“确认保存结果”重试。')))
      return null
    }
    if (!memory.drafts.has(key) && !memory.scripts.has(key) && !memory.roles.has(current?.book)) return 'keep'
    const choice = await decide({ title: deferText(() => t('保留当前修改？')), text: deferText(() => t('当前正文、台词或书级配音还有未保存的修改。')),
      choices: [['save', deferText(() => t('保存后切换'))], ['discard', deferText(() => t('放弃并切换'))], [null, deferText(() => t('留在当前章'))]] })
    if (choice === 'save' && !await save(current)) return null
    return choice
  }

  async function leaveCreation() {
    if (memory.operations.has('save:new')) {
      setError(deferText(() => t('请回到制作页，点击“确认保存结果”重试。')))
      return null
    }
    if (!memory.drafts.has('new')) return 'keep'
    const choice = await decide({ title: deferText(() => t('保留新建内容？')), text: deferText(() => t('书名、标题或正文还有未保存的修改。')),
      choices: [['save', deferText(() => t('保存后切换'))], ['discard', deferText(() => t('放弃并切换'))], [null, deferText(() => t('继续编辑'))]] })
    if (choice === 'save' && !await save(null)) return null
    return choice
  }

  async function cancelCreation() {
    if (busyRef.current.size || dialogRef.current || memory.operations.has('save:new')) return false
    if (memory.drafts.has('new')) {
      const choice = await decide({ title: deferText(() => t('放弃新建内容？')), text: deferText(() => t('已填写的标题和正文将被清除。')),
        choices: [['discard', deferText(() => t('放弃并返回书架'))], [null, deferText(() => t('继续编辑'))]], destructive: true })
      if (choice !== 'discard' || !life.current) return false
    }
    memory.drafts.delete('new')
    showCreation(null)
    setError('')
    return true
  }

  async function navigate(target) {
    const deciding = Boolean(dialogRef.current)
    if (deciding || busyRef.current.size) {
      // Say why nothing happened instead of ignoring the click.
      if (!target.restore) flashNotice(deferText(() => deciding ? t('请先处理当前对话框') : t('正在处理上一个操作，请稍候再试')))
      return false
    }
    const previous = active.current?.view
    if (target.chapter && target.chapter !== previous?.id) pendingListen.current = null
    const order = ++navOrder.current
    navRead.current?.abort()
    const abort = new AbortController()
    navRead.current = abort
    const signal = abort.signal
    try {
      let id = target.chapter
      if (target.book && !id && !target.new) {
        const rows = await get('library/chapters', { book: target.book }, signal)
        id = rows[0]?.id
        if (!id) return false
      }
      if (!life.current || order !== navOrder.current) return false
      const keepCreation = target.restore || target.keepCreation
      const sameDraft = target.new && !creation?.savedChapter && (target.book ?? null) === (appendBook?.id ?? null)
      const leavingCreation = Boolean(creation) || !previous
      let choice = 'keep'
      if (!keepCreation && !sameDraft) {
        if (leavingCreation) choice = await leaveCreation()
        else if (!target.new) choice = await leave(id)
      }
      if (!choice || !life.current || order !== navOrder.current) return false
      const value = target.new ? null : await get('chapter', { id, job: target.job }, signal)
      if (!life.current || order !== navOrder.current) return false
      if (choice === 'discard') {
        if (leavingCreation) memory.drafts.delete('new')
        else {
          memory.drafts.delete(previous.id)
          memory.scripts.delete(previous.id)
          memory.roles.delete(previous.book)
        }
      }
      if (value) {
        if (!keepCreation) showCreation(null)
        if (target.keepScene || (target.restore && creation)) memory.keepScene = value.id
        const autoplay = target.autoplay === true && Boolean(value.playbackJob) && Array.isArray(value.media) && value.media.some(part => part.ready)
        applyChapter(value, target.job, true, autoplay)
        if (target.autoplay && !autoplay) flashNotice(deferText(() => t('下一章还没有可播放的音频')))
      }
      else {
        showCreation({ book: target.book ? { id: target.book, title: target.bookTitle } : null })
        setPage('reader'); setPanel(null)
        setError(''); setBlocked(null); clearNotice()
      }
      return true
    } catch (error) {
      // The remembered chapter was deleted elsewhere: forget it instead of
      // reporting the same missing chapter on every open.
      if (target.restore && error?.message === 'CHAPTER_NOT_FOUND') {
        if (memory.activeId === target.chapter) memory.activeId = null
        clearLastChapter()
        return false
      }
      if (!signal.aborted && order === navOrder.current) errors(error)
      return false
    } finally {
      if (navRead.current === abort) navRead.current = null
      if (life.current && order === navOrder.current) setBooting(false)
    }
  }

  async function reloadModels(signal) {
    try { const value = await get('models', {}, signal); if (!signal?.aborted && life.current) setModels(value) }
    catch (error) { if (!signal?.aborted && life.current) { setModels(null); errors(error) } }
  }
  async function reloadKey(updated) {
    const order = ++keyRead.current
    const value = typeof updated?.configured === 'boolean' ? updated : await get('key')
    if (life.current && order === keyRead.current) {
      setKeyInfo(previous => ({ ...previous, ...value }))
      if (updated?.configured === true) {
        setKeySavedAt(Date.now())
        setResumedAfterKey(new Set())
      }
    }
  }
  // Settings take effect as soon as a control changes; see settingsQueue.mjs
  // for how concurrent saves are merged and conflicts handled.
  const settingSaves = useRef(null)
  settingSaves.current ??= createSettingsQueue({
    read: () => memory.settings,
    // The chat surfaces (dock) read some settings too; tell them a new value is in.
    write: value => { memory.settings = value; repaint(); try { window.dispatchEvent(new Event('lv-settings-change')) } catch {} },
    send: (expectedRevision, changes) => post('settings/save', { expectedRevision, changes }),
    fail: error => flashNotice(deferText(() => t("设置未能保存：{v1}", { v1: explain(error) }))),
  })
  const storedSelection = selection => selection ? {
    provider: selection.provider, model: selection.model,
    ...(selection.reasoningEffort != null ? { reasoningEffort: selection.reasoningEffort } : {}),
  } : null
  function saveSetting(changes) {
    return settingSaves.current.save(Object.hasOwn(changes, 'selection') ? { ...changes, selection: storedSelection(changes.selection) } : changes)
  }
  // Production choices apply to this session at once and become the default.
  function chooseOptions(changes) {
    reviseOptions(previous => ({ ...previous, ...changes }))
    return saveSetting(changes)
  }

  useEffect(() => {
    life.current = true
    const abort = new AbortController()
    let timer
    let inFlight = false
    let again = false
    const hiddenNow = () => typeof document !== 'undefined' && document.hidden
    async function poll() {
      if (!life.current) return
      if (inFlight) { again = true; return }
      inFlight = true
      let counts = {}
      try {
        const data = await get('jobs/page', { countsOnly: 1 }, abort.signal)
        if (abort.signal.aborted) return
        counts = data?.counts ?? {}
        // A job that finished, paused or was cancelled changes what the chapter
        // list and the shelf show (audio badges, storage), so reload them.
        const previous = countsRef.current
        countsRef.current = counts
        if (previous && ['completed', 'cancelled', 'paused'].some(key => (counts[key] ?? 0) !== (previous[key] ?? 0))) changeShelf(n => n + 1)
        if (previous && (counts.paused ?? 0) > (previous.paused ?? 0)) pendingPausedEdgeRef.current = { retries: 0 }
        else if (previous && (counts.paused ?? 0) < (previous.paused ?? 0) && (counts.paused ?? 0) > 0 && pausedBaselineRef.current !== null) {
          pendingBaselineShrinkRef.current = true
        }
        if ((counts.paused ?? 0) === 0 && pausedBaselineRef.current !== null) {
          pausedBaselineRef.current = new Set()
          seenPausedRef.current.clear()
          pendingPausedEdgeRef.current = null
          pendingBaselineShrinkRef.current = false
        }
        setJobCounts(counts)
        // A hidden tab still refreshes the counters but skips the chapter read
        // (and the re-render it would trigger).
        if (!hiddenNow()) await refresh(abort.signal)
        if (!abort.signal.aborted && life.current) {
          if (pausedBaselineRef.current === null) {
            if ((counts.paused ?? 0) === 0) {
              pausedBaselineRef.current = new Set()
              pendingPausedEdgeRef.current = null
              pendingBaselineShrinkRef.current = false
            } else {
              try {
                const scanned = await scanPausedJobs(offset => get('jobs/page', { state: 'paused', offset }, abort.signal))
                if (!abort.signal.aborted && life.current) {
                  const baseline = new Set()
                  for (const job of scanned.jobs) rememberExistingPaused(job)
                  for (const job of scanned.jobs) if (job?.id) baseline.add(job.id)
                  pausedBaselineRef.current = baseline
                  pendingPausedEdgeRef.current = null
                  pendingBaselineShrinkRef.current = false
                }
              } catch { /* Silent: baseline will retry on next poll without alarming the user. */ }
            }
          } else if (pendingPausedEdgeRef.current !== null) {
            try {
              const scanned = await scanPausedJobs(offset => get('jobs/page', { state: 'paused', offset }, abort.signal))
              if (!abort.signal.aborted && life.current) {
                const newJobs = diffNewPausedJobs(pausedBaselineRef.current, scanned.jobs)
                if (scanned.complete) {
                  const merged = new Set(scanned.jobs.map(job => job.id).filter(Boolean))
                  const currentOp = active.current?.view?.operation
                  if (currentOp?.state === 'paused' && currentOp.id) merged.add(currentOp.id)
                  for (const oldId of pausedBaselineRef.current) {
                    if (!merged.has(oldId)) forgetPausedJob(oldId)
                  }
                  pausedBaselineRef.current = merged
                  pendingBaselineShrinkRef.current = false
                } else {
                  for (const job of scanned.jobs) if (job?.id) pausedBaselineRef.current.add(job.id)
                }
                const actionable = []
                for (const job of newJobs) {
                  const pKey = pauseNoticeKey(job)
                  if (pKey && !seenPausedRef.current.has(pKey)) {
                    seenPausedRef.current.add(pKey)
                    actionable.push(job)
                  }
                }
                if (actionable.length > 0) {
                  presentPauseNotice(actionable[0])
                  pendingPausedEdgeRef.current = null
                } else if (newJobs.length > 0) {
                  pendingPausedEdgeRef.current = null
                } else if ((!scanned.complete || (counts.paused ?? 0) > pausedBaselineRef.current.size) && pendingPausedEdgeRef.current.retries < 2) {
                  pendingPausedEdgeRef.current = { retries: pendingPausedEdgeRef.current.retries + 1 }
                } else {
                  pendingPausedEdgeRef.current = null
                }
              }
            } catch { /* Silent: preserve pendingPausedEdgeRef for next poll. */ }
          } else if (pendingBaselineShrinkRef.current) {
            try {
              const scanned = await scanPausedJobs(offset => get('jobs/page', { state: 'paused', offset }, abort.signal))
              if (!abort.signal.aborted && life.current && scanned.complete) {
                const stillPaused = new Set(scanned.jobs.map(job => job.id).filter(Boolean))
                const currentOp = active.current?.view?.operation
                if (currentOp?.state === 'paused' && currentOp.id) stillPaused.add(currentOp.id)
                for (const oldId of pausedBaselineRef.current) {
                  if (!stillPaused.has(oldId)) forgetPausedJob(oldId)
                }
                pausedBaselineRef.current = stillPaused
                pendingBaselineShrinkRef.current = false
              }
            } catch { /* Silent: retry shrinking baseline on next poll. */ }
          }
        }
      } catch (error) {
        if (!abort.signal.aborted && life.current) flashNotice(deferText(() => t('进度暂时无法更新，正在重试。')))
      } finally {
        inFlight = false
        if (!abort.signal.aborted && life.current) {
          if (again) { again = false; void poll() }
          else {
            const activeCount = (counts.running ?? 0) + (counts.queued ?? 0) + (counts.paused ?? 0)
            timer = setTimeout(poll, nextPollDelay({ hidden: hiddenNow(), fast: activeCount > 0, fastMs: 2200, idleMs: 8000 }))
          }
        }
      }
    }
    const wake = () => {
      if (hiddenNow() || !life.current) return
      if (pendingToastRef.current) {
        const queued = pendingToastRef.current
        pendingToastRef.current = null
        flashNotice(queued)
      }
      clearTimeout(timer)
      if (inFlight) { again = true; return }
      void poll()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake)
    void poll()
    void reloadModels(abort.signal)
    void get('settings', {}, abort.signal).then(value => {
      if (abort.signal.aborted) return
      // A save already under way knows a newer revision than this read.
      if (!settingSaves.current.adopt(value)) return
      if (!memory.options) setOptions(modeOptions(value.values))
      repaint()
    }).catch(error => { if (!abort.signal.aborted) errors(error) })
    void reloadKey().catch(error => { if (!abort.signal.aborted) errors(error) })
    if (!pending?.chapter) {
      // Audio started elsewhere (the chat, the capsule) keeps playing: open its
      // chapter and job instead of the remembered one, which would replace it.
      const live = livePlayback(player)
      if (live) {
        void navigate({ chapter: live.chapter, job: live.job, restore: true })
      } else if (memory.activeId) void navigate({ chapter: memory.activeId, restore: true })
    }
    return () => {
      life.current = false; navOrder.current++; navRead.current?.abort(); abort.abort()
      clearTimeout(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake)
      stopExportPoll()
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      answer(null)
    }
  }, [])

  const importOrder = useRef(0)
  function showImport(entry) { importOrder.current++; setImportEntry(entry); setPage('import'); setPanel(null) }
  useEffect(() => {
    if (!pending) return
    navigation.consume(pending)
    // "在对话音频中管理" from the conversation: the list in the library scene.
    if (pending.snippets) { setPage('snippets'); setPanel(null); return }
    if (!pending.import) { void navigate({ chapter: pending.chapter, job: pending.job, book: pending.book }); return }
    const order = ++importOrder.current
    get('import/preview', { id: pending.import, session: pending.session, settled: 1 }).then(data => {
      if (life.current && importOrder.current === order) showImport({ data, session: pending.session })
    }).catch(error => { if (importOrder.current === order) errors(error) })
  }, [pending])

  function clearSelection() { setSelection(new Map()) }
  function selectRows(rows, append = false) {
    setSelection(current => {
      const next = append ? new Map(current) : new Map()
      for (const row of rows) {
        if (next.size >= 500) break
        next.set(row.id, row)
      }
      return next
    })
  }
  function invertRows(rows) {
    setSelection(current => {
      const next = new Map(current)
      for (const row of rows) {
        if (next.has(row.id)) next.delete(row.id)
        else if (next.size < 500) next.set(row.id, row)
      }
      return next
    })
  }
  async function selectBook(bookId, signal) {
    if (!bookId) return null
    try {
      const { ids, total } = await get('library/chapter-ids', { book: bookId }, signal)
      if (signal?.aborted) return null
      const list = (Array.isArray(ids) ? ids : []).slice(0, 500)
      setSelection(new Map(list.map(id => [id, { id }])))
      if (Number(total) > list.length) flashNotice(deferText(() => t("全书共 {v1} 章，已选前 {v2} 章，其余请分批生成", { v1: Number(total).toLocaleString(), v2: list.length })))
      return { total: Number(total) || list.length, selected: list.length }
    } catch (error) { if (!signal?.aborted) errors(error); return null }
  }

  // Only the engine and mode a stopped job really had; a missing value keeps the default.
  function jobEngine(job) {
    return {
      ...(['edge', 'laivox'].includes(job?.engine) ? { engine: job.engine } : {}),
      ...(['reading', 'multi'].includes(job?.mode) ? { mode: job.mode } : {}),
    }
  }

  function offerRejoin(stopped) {
    const jobs = stopped.filter(job => job.purpose === 'generate' && job.chapter)
    const chapters = [...new Set(jobs.map(job => job.chapter))]
    if (!chapters.length) return
    const first = jobs[0]
    flashNotice({
      text: deferText(() => t('已停止 {n} 章的制作', { n: chapters.length })),
      label: t('重新加入'),
      run: () => { void generate('generate', true, '', { ...jobEngine(first), batchChapters: chapters, clean: false }) },
    })
  }

  async function generate(purpose = 'generate', batch = false, note = '', overrides = {}) {
    const { showPlan = false, batchBook = book, listen = false, keepDrafts = false, preconfirmed = false, batchChapters, ...forced } = overrides
    let current = { ...options, ...forced }
    if (current.engine === 'laivox' && keyInfo?.configured === false) {
      setPanel('production')
      flashNotice(deferText(() => t('先连接 LaiVox')))
      return { ok: false, reason: 'key' }
    }
    planCancelled.current = false
    const lock = 'start:' + (batch ? 'batch:' + batchBook : chapter?.id ?? memory.activeId ?? 'new')
    let key = lock
    if (busyRef.current.size || dialogRef.current) return { ok: false, reason: 'busy' }
    const pendingBody = memory.operations.get(lock)?.body
    if (pendingBody && ((forced.focusStart !== undefined && forced.focusStart !== pendingBody.focusStart) ||
      (forced.only && JSON.stringify(forced.only) !== JSON.stringify(pendingBody.only)))) return { ok: false, reason: 'pending' }
    busyRef.current.add(lock); repaint(); setError(''); setBlocked(null)
    let saved = false
    try {
      let target = batch ? null : chapter
      if (!batch && !target && memory.activeId) target = await reloadChapter()
      let input
      if (!memory.operations.has(key)) {
        const mustSave = memory.operations.has('save:' + chapterKey) || (dirty && !keepDrafts)
        if (!batch && (!target || mustSave)) {
          target = await save(target, { fromGenerate: true, preconfirmed })
          if (!target) return { ok: false, reason: 'failed' }
          saved = true
          key = 'start:' + target.id
        }
        const chapters = Array.isArray(batchChapters) && batchChapters.length ? batchChapters : batch ? [...selection.keys()] : [target.id]
        if (!chapters.length) return { ok: false, reason: 'failed' }
        for (;;) {
          const intent = { ...current, purpose, chapters }
          const controller = new AbortController()
          let estimateDialog = false
          const slowTimer = setTimeout(() => {
            if (!life.current || controller.signal.aborted) return
            estimateDialog = true
            decide({ kind: 'estimate', title: deferText(() => t('正在按章计算')),
              text: deferText(() => t('可以取消。当前这一组算完后停止。')),
              choices: [[null, deferText(() => t('取消'))]] }).then(value => { if (value == null) controller.abort() })
          }, 300)
          let plan
          try {
            plan = await post('jobs/prepare', { ...intent, estimateAi: true }, false, controller.signal)
          } catch (error) {
            if (controller.signal.aborted || error?.name === 'AbortError') return { ok: false, reason: 'dismissed' }
            throw error
          } finally {
            clearTimeout(slowTimer)
            if (estimateDialog) answer('computed')
          }
          if (planCancelled.current) return { ok: false, reason: 'dismissed' }
          if (plan.needsModel && !models?.length) {
            setPanel('production')
            throw new Error('MODEL_NOT_CONFIGURED')
          }
          const hosted = plan.aiPlan
          let cleanCharacters = 0
          let castCharacters = 0
          if (!hosted) {
            for (const row of plan.rows ?? []) {
              const characters = Number(row.characters) || 0
              if (row.spec?.clean) cleanCharacters += characters
              if (row.spec?.cast) castCharacters += characters
            }
            if (!cleanCharacters && !castCharacters) {
              if (plan.clean) cleanCharacters = Number(plan.characters) || 0
              if (plan.cast) castCharacters = Number(plan.characters) || 0
            }
          }
          const estimate = hosted
            ? { requests: hosted.requests, provisional: hosted.provisional === true, clean: hosted.clean, cast: hosted.cast }
            : estimateAiCalls({ cleanCharacters, castCharacters })
          const modelName = hosted?.selection?.name ?? current.selection?.name ?? current.selection?.model ?? models?.[0]?.name ?? deferText(() => t('DSH 默认模型'))
          if (plan.needsModel || batch || showPlan) {
            const answer = await decide({ kind: 'plan', title: deferText(() => t('制作单')),
              text: note,
              plan: { ...plan, chapters, estimate, modelName, options: current, models, chapter: target, batch, purpose },
              choices: [['start', deferText(() => batch ? t("加入队列（{v1} 章）", { v1: chapters.length }) : t('开始制作'))], [null, deferText(() => t('取消'))]] })
            if (answer?.revise) {
              reviseOptions(answer.revise)
              current = { ...answer.revise, ...forced }
              continue
            }
            if (answer !== 'start') return { ok: false, reason: 'dismissed' }
          }
          input = { body: { ...intent, action: 'start', bases: plan.rows.map(({ id, rev, rolesRev, editorialResultJob }) => ({ id, rev, rolesRev, editorialResultJob })),
            ...(plan.aiPlan?.confirmation ? { confirmation: plan.aiPlan.confirmation } : {}) }, snapshot: { ids: chapters, saved } }
          break
        }
      }
      try {
        const { result, snapshot } = await operation(key, 'jobs/action', input)
        if (Array.isArray(result)) {
          for (const item of result) forgetPausedJob(typeof item === 'string' ? item : item?.id)
        }
        const first = result[0]
        if (batch) {
          setSelection(items => new Map([...items].filter(([id]) => !snapshot.ids.includes(id))))
          setQueueScope({ book: batchBook }); setPage('queue')
        }
        let refreshFailed = false
        if (!batch && active.current?.view.id === (first?.chapter ?? snapshot.ids[0])) {
          const before = active.current.view.media ?? []
          const hadComplete = before.length > 0 && before.every(part => part.ready)
          const adopt = purpose === 'generate' && (!KEEP_PREVIOUS_AUDIO || listen || !hadComplete)
          const jobId = typeof first === 'string' ? first : first?.id
          await refresh(undefined, adopt ? jobId : null, adopt)
            .catch(() => { refreshFailed = true; flashNotice(deferText(() => t('已加入队列，刷新失败。任务仍可在队列查看。'))) })
        }
        if (!refreshFailed) flashNotice(deferText(() => t('已加入制作队列')))
        changeShelf(n => n + 1)
        return { ok: true, jobs: Array.isArray(result) ? result : [] }
      } catch (error) { if (saved) flashNotice(deferText(() => t('修改已保存。请确认生成请求结果。'))); throw error }
    } catch (error) {
      if (saved && error.message !== 'OPERATION_PENDING') flashNotice(deferText(() => t('修改已保存，生成未开始。')))
      errors(error)
      return { ok: false, reason: 'failed' }
    } finally { if (!dialogRef.current && life.current) setDialog(null); busyRef.current.delete(lock); repaint() }
  }

  async function jobAction(id, action) {
    if (jobRef.current.has(id)) return
    if (action === 'cancel' && !await decide({ title: deferText(() => t('取消这个任务？')), text: deferText(() => t('任务将结束。已经生成的音频仍可播放。')),
      choices: [['cancel', deferText(() => t('取消任务'))], [null, deferText(() => t('保留任务'))]], destructive: true })) return
    jobRef.current.set(id, action); setActions(new Map(jobRef.current))
    try {
      await post('jobs/action', { id, action })
      if (action === 'resume' || action === 'cancel' || action === 'fill-edge') forgetPausedJob(id)
      if (action === 'resume') {
        setResumedAfterKey(current => {
          if (current.has(id)) return current
          const next = new Set(current)
          next.add(id)
          return next
        })
      }
    }
    catch (error) {
      const latest = await get('jobs/item', { id }).catch(() => null)
      const accepted = { pause: ['paused','completed'], resume: ['queued','running','completed'], cancel: ['cancelled','completed'], 'fill-edge': ['queued','running','completed'] }
      if (!accepted[action].includes(latest?.state)) errors(error)
    } finally {
      jobRef.current.delete(id)
      if (life.current) { setActions(new Map(jobRef.current)); changeShelf(n => n + 1) }
      await refresh().catch(errors)
    }
  }

  async function clearAudio(target) {
    const scope = target.chapter ? '本章' : '整本书'
    if (!await decide({ title: deferText(() => t("清理{v1}音频？", { v1: t(scope) })),
      text: deferText(() => t('正文、角色、台词和书签记录会保留。已排队或暂停的相关任务将取消，重新收听需要生成音频。')),
      choices: [['clear', deferText(() => t('清理音频'))], [null, deferText(() => t('返回'))]], destructive: true })) return
    try {
      await post('jobs/action', { action: 'clear-audio', ...target })
      const current = active.current?.view
      if (current && (current.id === target.chapter || current.book === target.book)) {
        player.pause()
        active.current.pin = null
        await refresh(undefined, undefined, true)
      }
      changeShelf(n => n + 1)
      flashNotice(deferText(() => t('音频已清理')))
    } catch (error) { errors(error) }
  }

  function stopExportPoll() {
    if (exportRef.current.timer) { clearTimeout(exportRef.current.timer); exportRef.current.timer = null }
  }

  async function exportBook(book, format = exportFormat, title = '') {
    if (!book) return
    const chosen = format === 'wav' ? 'wav' : 'mp3'
    stopExportPoll()
    const id = crypto.randomUUID()
    setExportFormat(chosen)
    setExportState({ book, id, format: chosen, state: 'running', done: 0, total: 0, bytes: 0, error: '' })
    const base = String(title || 'novel').trim() || 'novel'
    const anchor = document.createElement('a')
    anchor.href = url('media/book', { book, format: chosen, export: id })
    anchor.download = (base + '.' + chosen + '.zip').replace(/[\\/:*?"<>|]/g, '_')
    anchor.hidden = true
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    let attempts = 0
    const tick = async () => {
      if (!life.current) return
      let progress
      try { progress = await get('media/book/progress', { id }) }
      catch (error) {
        if (!life.current) return
        // The download request may reach the host slightly after the first poll.
        if (error?.message === 'EXPORT_NOT_FOUND' && attempts++ < 3) {
          exportRef.current.timer = setTimeout(tick, 1000)
          return
        }
        setExportState(current => current?.id === id ? { ...current, state: 'error', error: deferText(() => explain(error)) } : current)
        flashNotice(deferText(() => t("导出进度读取失败：{v1}", { v1: explain(error) })))
        return
      }
      if (!life.current) return
      const state = progress?.state === 'done' ? 'done' : progress?.state === 'running' ? 'running'
        : progress?.state === 'cancelled' ? 'cancelled' : 'error'
      const error = state === 'error' ? deferText(() => explain({ message: progress?.error ?? 'SERVICE_UNAVAILABLE' })) : ''
      setExportState(current => current?.id === id ? { ...current, ...progress, state, error } : current)
      if (state === 'running') { exportRef.current.timer = setTimeout(tick, 1000); return }
      if (state === 'done') flashNotice(deferText(() => t("导出完成 · {v1}", { v1: formatBytes(progress?.bytes) })))
      else if (state === 'cancelled') flashNotice(deferText(() => t('导出已取消')))
      else flashNotice(deferText(() => t("导出失败：{v1}", { v1: displayText(error) })))
    }
    exportRef.current.timer = setTimeout(tick, 1000)
  }

  async function cancelExport() {
    const current = exportState
    if (!current?.id || current.state !== 'running') return
    try { await post('media/book/cancel', { export: current.id }) }
    catch (error) { flashNotice(deferText(() => explain(error))) }
  }

  async function renameBook(bookId, title) {
    const name = typeof title === 'string' ? title.trim() : ''
    if (!bookId) return false
    if (!name) { flashNotice(deferText(() => t('请输入新的书名'))); return false }
    try {
      await post('library/action', { action: 'rename', book: bookId, title: name })
      changeShelf(n => n + 1)
      if (active.current?.view.book === bookId) await refresh().catch(() => {})
      flashNotice(deferText(() => t('书名已更新')))
      return true
    } catch (error) { errors(error); return false }
  }

  // After books are deleted (from the shelf or the conversation audio list): drop
  // the open chapter, drafts and export state that belonged to them.
  function forgetBooks(bookIds) {
    const gone = new Set(bookIds)
    if (!gone.size) return
    if (gone.has(active.current?.view.book)) {
      active.current = null
      memory.activeId = null
      clearLastChapter()
      setChapter(null); setPage('reader'); setPanel(null)
      setSelection(new Map()); setError(''); setBlocked(null); clearNotice()
      player.update({ id: null, title: '', media: [] }, true)
    }
    for (const [key, value] of [...memory.drafts]) if (gone.has(value?.book)) memory.drafts.delete(key)
    if (gone.has(chapter?.book)) memory.scripts.delete(chapter.id)
    for (const id of gone) memory.roles.delete(id)
    // Only the export of a deleted book stops; another book's export carries on.
    if (exportState && gone.has(exportState.book)) { stopExportPoll(); setExportState(null) }
    changeShelf(n => n + 1)
  }

  async function deleteBook(bookId, meta = {}) {
    if (!bookId) return false
    const title = typeof meta.title === 'string' ? meta.title.trim() : ''
    const chapters = Number(meta.chapters) || 0
    const audioBytes = Number(meta.audioBytes) || 0
    const detail = () => chapters ? t("将删除 {v1} 章", { v1: chapters }) : t('将删除这本书')
    const choice = await decide({
      title: deferText(() => t("删除《{v1}》？", { v1: title || t('这本书') })),
      text: deferText(() => t('{summary}{audio}，以及该书的角色、任务和播放记录。此操作不可恢复。',
        { summary: detail(), audio: audioBytes > 0 ? t('、{v1} 音频', { v1: formatBytes(audioBytes) }) : '' })),
      choices: [['delete', deferText(() => t('删除本书'))], ['keep', deferText(() => t('保留本书'))]],
      destructive: true,
    })
    if (choice !== 'delete' || !life.current) return false
    try {
      const result = await post('library/action', { action: 'delete', book: bookId })
      forgetBooks([bookId])
      const cancelled = Number(result?.cancelled) || 0
      flashNotice(deferText(() => t("已删除《{v1}》", { v1: title || t('这本书') }) + (cancelled ? t("，已中止 {v1} 个任务", { v1: cancelled }) : '')))
      return true
    } catch (error) { errors(error); return false }
  }

  async function compact() {
    try {
      const result = await post('library/compact', {})
      changeShelf(n => n + 1)
      return result
    } catch (error) { errors(error); throw error }
  }

  const modeLabel = { reading: '单人朗读', multi: '多角色演绎' }
  function consumeListen(view = active.current?.view) {
    const intent = pendingListen.current
    if (!intent || view?.id !== intent.chapter) return
    const operation = view.operation
    if (operation && (operation.state === 'cancelled' || (operation.state === 'paused' && operation.error))) {
      pendingListen.current = null
      return
    }
    const parts = view.media ?? []
    const n = parts.findIndex(part => part.end > intent.start)
    if (n < 0 || view.playbackStale || view.playbackJob?.id !== player.getSnapshot().job) return
    const running = operation && ['queued', 'running'].includes(operation.state)
    if (!parts[n].ready && !running) return
    pendingListen.current = null
    player.seek(n, 0)
    player.play()
  }
  async function includeRange(id, start, end) {
    const result = await post('jobs/action', { action: 'include', id, start, end: end ?? start + 1 })
    return Boolean(result?.included)
  }
  async function listenFrom(start, offset = 0) {
    const view = active.current?.view
    if (!view || !Number.isFinite(start)) return
    const runningMode = view.operation && ['queued', 'running', 'paused'].includes(view.operation.state) ? view.operation.mode : null
    const decision = decideListen({ chapter: view, playerJob: player.getSnapshot().job, start, offset, mode: runningMode || options.mode })
    await followListen(decision, view.id, start, offset)
  }
  async function followListen(decision, chapterId, start, offset) {
    if (decision.type === 'play') {
      pendingListen.current = null
      player.seek(decision.n, offset)
      player.play()
      return
    }
    if (decision.type === 'mismatch') {
      flashNotice(deferText(() => t('当前任务是{mode}，先等它结束或停止后，再按现在的模式从这里听', { mode: t(modeLabel[decision.mode] ?? '另一种模式') })))
      return
    }
    if (decision.type === 'start') {
      const result = await generate('generate', false, '', { focusStart: decision.focusStart, listen: true })
      if (!result?.ok) {
        if (result?.reason === 'busy') flashNotice(deferText(() => t('正在处理上一个操作')))
        if (result?.reason === 'pending') flashNotice(deferText(() => t('上一次制作还在确认，请稍候')))
        return
      }
      pendingListen.current = { chapter: chapterId, start }
      consumeListen()
      return
    }
    if (decision.type === 'adopt') {
      await refresh(undefined, decision.id, true).catch(errors)
      const nextView = active.current?.view
      const nextMode = nextView?.operation && ['queued', 'running', 'paused'].includes(nextView.operation.state) ? nextView.operation.mode : options.mode
      const next = decideListen({ chapter: nextView, playerJob: player.getSnapshot().job, start, offset, mode: nextMode || options.mode })
      if (next.type !== 'adopt') await followListen(next, chapterId, start, offset)
      return
    }
    try {
      if (decision.scope === 'range') {
        const included = await includeRange(decision.id, decision.start, decision.end)
        if (!included) {
          const operation = active.current?.view?.operation
          if (!operation || !['queued', 'running', 'paused'].includes(operation.state)) {
            await followListen({ type: 'start', focusStart: start }, chapterId, start, offset)
          }
          return
        }
      }
      if (decision.type === 'resume' || decision.n == null) {
        await post('jobs/action', { id: decision.id, action: 'resume', start: decision.start })
      } else if (decision.scope !== 'range') {
        const { focused } = await post('jobs/action', { action: 'focus', id: decision.id, n: decision.n })
        if (focused) flashNotice(deferText(() => t('已优先合成这里，稍候即可收听')))
        if (!focused) {
          const operation = active.current?.view?.operation
          if (!operation || !['queued', 'running', 'paused'].includes(operation.state)) {
            await followListen({ type: 'start', focusStart: start }, chapterId, start, offset)
          } else pendingListen.current = { chapter: chapterId, start }
          return
        }
      } else if (decision.n != null) {
        await post('jobs/action', { action: 'focus', id: decision.id, n: decision.n }).catch(() => {})
      }
      pendingListen.current = { chapter: chapterId, start }
      await refresh().catch(errors)
      consumeListen()
    } catch (error) { errors(error) }
  }
  function clearListen() { pendingListen.current = null }
  useEffect(() => consumeListen(chapter), [chapter])
  useEffect(() => player.subscribe(() => {
    const snap = player.getSnapshot()
    const part = snap.segments[snap.n]
    const operation = active.current?.view?.operation
    if (snap.phase !== 'buffering' || !part || part.ready || operation?.state !== 'running' || operation.id !== snap.job) return
    if (operation.mode && options.mode && operation.mode !== options.mode) return
    const key = operation.id + ':' + snap.n
    if (steered.current.has(key)) return
    steered.current.add(key)
    const task = operation.scope === 'range'
      ? post('jobs/action', { action: 'include', id: operation.id, start: part.start, end: part.end }).then(result => result?.included ? post('jobs/action', { action: 'focus', id: operation.id, n: snap.n }) : null)
      : post('jobs/action', { action: 'focus', id: operation.id, n: snap.n })
    task.catch(() => steered.current.delete(key))
  }), [player, options.mode])

  return {
    chapter, book, appendBook, creating: Boolean(creation) || !chapter, creationSaved: Boolean(creation?.savedChapter),
    creationPending: memory.operations.has('save:new'), newDraft, editNewDraft,
    draft, scriptDraft, roleDraft, dirty, busy, booting, page, setPage, panel, setPanel,
    options, reviseOptions, models, reloadModels, keyInfo, keySavedAt, resumedAfterKey, reloadKey, settings: memory.settings, saveSetting, chooseOptions,
    error: typeof error === 'string' || isDeferredText(error) ? displayText(error) : explain(error), errorCode: error?.message,
    notice, setNotice, clearNotice, flashNotice, openUsageDayAction, errors, clearError: () => { setError(''); setBlocked(null) }, blocked, decide, dialog, answer, memory, selection, setSelection, shelfVersion,
    selectRows, invertRows, clearSelection, selectBook,
    importEntry, showImport, jobCounts, actions, jobAction, queueScope, setQueueScope,
    navigate, cancelCreation, refresh, listenOlder, reloadChapter, save, generate, listenFrom, clearListen, editDraft, editScript, editRole, saveRoleVoice, saveRoleProfile, upgradeVoiceRule, discardRoles, chooseRoleConflict, clearAudio,
    renameBook, deleteBook, forgetBooks, exportState, exportFormat, setExportFormat, exportBook, cancelExport, compact,
    refreshShelf: () => changeShelf(n => n + 1),
  }
}
