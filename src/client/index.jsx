import React, { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { get, post, url } from './api.mjs'
import { nextPollDelay } from './workbench/polling.mjs'
import { Icon } from './components/Icon.jsx'
import { Shell } from './shell/Shell.jsx'
import { createWorkbenchMemory, lastChapterKey } from './workbench/state.mjs'
import { MiniCapsule } from './player/MiniCapsule.jsx'
import { createCapsuleState } from './player/capsuleState.mjs'
import { createPlayerController } from './player/controller.mjs'
import { bindPreviewChannel, bindSpeechStop } from './player/previewChannel.mjs'
import { NovelDock } from './chat/NovelDock.jsx'
import { ProposeCard } from './chat/ProposeCard.jsx'
import { ProposalConfirm } from './chat/ProposalConfirm.jsx'
import { OutcomeLine } from './chat/OutcomeLine.jsx'
import { createSessionFeed } from './chat/sessionFeed.mjs'
import { createProposalActions } from './chat/proposalActions.mjs'
import { createChatPlayback } from './chat/playback.mjs'
import { continueDecision } from './player/continuePlan.mjs'
import { isLastTurn } from './chat/dockModel.mjs'
import { createSpeechPlayer } from './speech/speechPlayer.mjs'
import { SpeakAction } from './chat/SpeakAction.jsx'
import { SpeakCard } from './chat/SpeakCard.jsx'
import { AddChaptersCard, ImportCard, ImportConfirm } from './chat/LibraryCards.jsx'
import { DeliverableImport } from './chat/DeliverableImport.jsx'
import { PLUGIN_ID } from '../domain/plugin.mjs'
import { deferText, followHostLanguage, getLanguage, normalizeLanguage, registerTraditionalChinese, subscribeLanguage, translate as t } from './i18n/locale.mjs'
import tokens from './styles/tokens.css'
import base from './styles/base.css'
import shell from './styles/shell.css'
import stage from './styles/stage.css'
import studio from './styles/studio.css'
import library from './styles/library.css'
import sheets from './styles/sheets.css'
import player from './styles/player.css'
import live from './styles/live.css'
import metrics from './styles/metrics.css'
import polish from './styles/polish.css'
import host from './styles/host.css'
const css=[tokens,base,shell,stage,studio,library,sheets,player,live,metrics,polish,host].join('\n')

const PANEL = PLUGIN_ID

export const name = PANEL
export const inject = ['slots', 'layout']

// Re-render mounted slots when the host changes language, without remounting
// their workbench, playback or conversation state.
function withLanguage(Component) {
  return function LocalizedSlot(props) {
    useSyncExternalStore(subscribeLanguage, getLanguage)
    return <Component {...props}/>
  }
}

export function apply(ctx) {
  let hostLocale
  const label = source => t(source, undefined, normalizeLanguage(hostLocale?.getSnapshot?.()?.active ?? getLanguage()))
  ctx.effect(() => followHostLanguage())
  function connectLocale(sub) {
    const locale = sub.locale
    hostLocale = locale
    sub.effect(() => registerTraditionalChinese(locale))
    sub.effect(() => {
      const stop = followHostLanguage(locale)
      return () => {
        stop()
        if (hostLocale === locale) hostLocale = undefined
      }
    })
  }
  if (typeof ctx.inject === 'function') ctx.inject(['locale'], connectLocale)

  const memory = createWorkbenchMemory()
  const feed = createSessionFeed(get)
  const proposals = createProposalActions({ get, post, feed })
  const player = createPlayerController({ getPreferences: () => ({ paragraphPause: memory.settings.values.paragraphPause !== false }) })
  bindPreviewChannel(player)
  const playback = createChatPlayback({ get, player, remember(id) {
    try { localStorage.setItem(lastChapterKey, id) } catch {}
  } })
  // Instant speech: one reading at a time, never together with the novel.
  const speech = createSpeechPlayer({ post, player, partUrl: (id, n) => url('speech/part', { id, n }) })
  bindSpeechStop(() => speech.stop())
  let pending = null
  const listeners = new Set()
  const navigation = {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSnapshot: () => pending,
    consume(value) { if (pending === value) { pending = null; for (const item of listeners) item() } },
  }
  function navigate(target) {
    playback.cancel()
    pending = target
    ctx.layout.selectPanel(PANEL)
    for (const item of listeners) item()
  }
  const isPanelActive = () => ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL

  // When the dock and mini capsule show (settings) and what the user closed with × per session.
  // Closing hides exactly what was on the bar; anything new brings it back.
  let chatDock = memory.settings?.values?.chatDock ?? 'auto'
  let miniCapsule = memory.settings?.values?.miniCapsule ?? 'auto'
  const prefListeners = new Set()
  const dockPrefs = {
    subscribe(listener) { prefListeners.add(listener); return () => prefListeners.delete(listener) },
    getSnapshot: () => chatDock,
  }
  const capsulePrefs = {
    subscribe(listener) { prefListeners.add(listener); return () => prefListeners.delete(listener) },
    getSnapshot: () => miniCapsule,
  }
  function readPrefs(values) {
    const nextDock = values?.chatDock ?? 'auto'
    const nextCapsule = values?.miniCapsule ?? 'auto'
    if (nextDock === chatDock && nextCapsule === miniCapsule) return
    chatDock = nextDock
    miniCapsule = nextCapsule
    for (const item of prefListeners) item()
  }
  const dismissed = new Map()
  const dismissals = {
    get: session => dismissed.get(session) ?? null,
    set(session, keys) { dismissed.set(session, new Set(keys)) },
  }

  // A short message shown in the mini capsule instead of the current sentence,
  // plus session dismissal (woken again on active playback, resume, or notice).
  const capsule = createCapsuleState()

  // With the workbench closed, the capsule continues with the next chapter in
  // place (no panel switch). The workbench handles its own case (Shell.jsx).
  ctx.effect(() => {
    const off = player.onEnded(async ({ nextId }) => {
      if (isPanelActive() || !nextId) return
      // Read the saved setting: without the workbench open this session, the
      // in-memory settings are only defaults.
      let autoContinue = memory.settings?.values?.autoContinue
      try { autoContinue = (await get('settings')).values?.autoContinue } catch {}
      const decision = continueDecision({ panelActive: isPanelActive(), autoContinue, nextId, segments: player.getSnapshot().segments, open: player.getSnapshot().growing === true })
      if (decision.action !== 'capsule') return
      try { await playback.listen(decision.chapter) }
      catch { capsule.show(deferText(() => t('下一章还没有音频'))) }
    })
    return () => off()
  })

  // The dock may show before the workbench was ever opened: read the saved
  // setting once, then follow the workbench's changes.
  ctx.effect(() => {
    const controller = new AbortController()
    get('settings', {}, controller.signal).then(value => readPrefs(value?.values)).catch(() => {})
    const follow = () => readPrefs(memory.settings?.values)
    window.addEventListener('lv-settings-change', follow)
    return () => { controller.abort(); window.removeEventListener('lv-settings-change', follow) }
  })

  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.append(style)
    const shutdown = new AbortController()
    let busy = false
    let timer
    const hiddenNow = () => typeof document !== 'undefined' && document.hidden
    async function tick() {
      if (shutdown.signal.aborted) return
      const hidden = hiddenNow()
      let fast = false
      let keepAlive = false
      try {
        const { chapter, job, settled, phase, autoResuming } = player.getSnapshot()
        fast = Boolean(chapter && job && (!settled || autoResuming))
        keepAlive = fast && (['playing', 'buffering'].includes(phase) || autoResuming)
        if ((!hidden || keepAlive) && fast && !busy) {
          busy = true
          try {
            if (ctx.layout.panelInfo.getSnapshot().activePanelId === PANEL) return
            const value = await get('chapter/progress', { id: chapter, job }, shutdown.signal)
            const now = player.getSnapshot()
            if (!shutdown.signal.aborted && ctx.layout.panelInfo.getSnapshot().activePanelId !== PANEL &&
                now.chapter === chapter && now.job === job) player.update(value)
          } catch {}
          finally { busy = false }
        }
      } finally {
        if (!shutdown.signal.aborted) timer = setTimeout(tick, nextPollDelay({ hidden, fast, fastMs: 1500, idleMs: 10_000, keepAlive, keepAliveMs: 8000 }))
      }
    }
    const wake = () => {
      if (hiddenNow() || shutdown.signal.aborted) return
      clearTimeout(timer)
      if (!busy) void tick()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake)
    void tick()
    const flush = () => player.flush()
    window.addEventListener('pagehide', flush)
    let lastPhase = player.getSnapshot().phase
    const offPlayer = player.subscribe(() => {
      const phase = player.getSnapshot().phase
      if (phase === lastPhase) return
      lastPhase = phase
      if (phase === 'playing' || phase === 'buffering') capsule.wake()
    })
    let lastResume = speech.getSnapshot().resume
    const offSpeech = speech.subscribe(() => {
      const resume = speech.getSnapshot().resume
      if (resume === lastResume) return
      lastResume = resume
      if (resume) capsule.wake()
    })
    return () => {
      clearTimeout(timer)
      shutdown.abort()
      offPlayer()
      offSpeech()
      capsule.dispose()
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('pagehide', flush)
      style.remove()
      playback.cancel()
      speech.dispose()
      player.dispose()
    }
  })

  // Everything rendered inside the conversation follows DSH's look (.lv-host and
  // the host's --dsw-* tokens). The workbench keeps its own paper and graphite skins.
  const openChapter = (chapter, job) => navigate({ chapter, job })
  const openWorkbench = () => { playback.cancel(); ctx.layout.selectPanel(PANEL) }
  ctx.effect(() => {
    const open = () => { openWorkbench(); window.dispatchEvent(new Event('laivox-open-settings')) }
    window.addEventListener('laivox-request-settings', open)
    return () => window.removeEventListener('laivox-request-settings', open)
  })
  const openSnippets = () => navigate({ snippets: true })

  function MiniPlayer() {
    const layout = useSyncExternalStore(ctx.layout.panelInfo.subscribe.bind(ctx.layout.panelInfo), ctx.layout.panelInfo.getSnapshot.bind(ctx.layout.panelInfo))
    const capsuleState = useSyncExternalStore(capsule.subscribe, capsule.getSnapshot)
    const capsuleMode = useSyncExternalStore(capsulePrefs.subscribe, capsulePrefs.getSnapshot)
    return layout.activePanelId === PANEL ? null
      : <div className="lv-host lv-mini-anchor"><MiniCapsule player={player} notice={capsuleState.notice} dismissed={capsuleState.dismissed} dismiss={capsule.dismiss} mode={capsuleMode} open={openChapter} speech={speech}/></div>
  }

  function DockSlot({ sessionKey, sessionId }) {
    const session = sessionKey ?? sessionId
    useAnnouncedSpeech(session)
    const mode = useSyncExternalStore(dockPrefs.subscribe, dockPrefs.getSnapshot)
    return <NovelDock key={session} session={session} player={player} feed={feed} actions={proposals} listen={playback.listen}
      mode={mode} dismissals={dismissals}
      open={openChapter} openWorkbench={openWorkbench} manage={openSnippets} preview={(id, owner) => navigate({ import: id, session: owner })}/>
  }

  // A reading the AI started (laivox_speak) whose tool card this page did not see
  // arrive (folded, or rendered later): play it once if it started after this
  // conversation was opened and the page is visible. The card itself is faster.
  function useAnnouncedSpeech(session) {
    const opened = useRef(Date.now())
    const subscribe = useCallback(listener => feed.subscribe(session, listener), [session])
    const snapshotOf = useCallback(() => feed.getSnapshot(session), [session])
    const announced = useSyncExternalStore(subscribe, snapshotOf)?.speech
    useEffect(() => {
      if (!announced?.id || speech.hasPlayed(announced.id) || !(announced.created >= opened.current)) return
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      // Older than half a minute: the moment has passed; the card offers a replay.
      if (Date.now() - announced.created > 30_000) return
      void speech.play({ speechId: announced.id, parts: announced.parts, source: 'tool:' + announced.id })
    }, [announced?.id])
  }

  function SpeakTool(props) {
    return <SpeakCard {...props} speech={speech}/>
  }

  function MessageSpeak(props) {
    return <SpeakAction {...props} speech={speech}/>
  }

  function ToolCard(props) {
    return <ProposeCard {...props} feed={feed} actions={proposals} open={openChapter}/>
  }
  // Library tools. A production batch is a proposal like a text reading.
  const openBook = book => navigate({ book })
  const previewImport = (id, owner) => navigate({ import: id, session: owner })
  function MakeToolCard(props) {
    return <ProposeCard {...props} feed={feed} actions={proposals} open={openChapter} noun={t('制作单')}/>
  }
  function AddChaptersTool(props) {
    return <AddChaptersCard {...props} open={openChapter}/>
  }
  function ImportTool(props) {
    return <ImportCard {...props} feed={feed} openBook={openBook} preview={previewImport}/>
  }
  // A delivered TXT/EPUB opens straight in the workbench import preview.
  function DeliverableAction(props) {
    return <DeliverableImport actionUrl={props.actionUrl} openImport={previewImport}/>
  }

  function OutcomeTail({ turn, useChat, sessionId }) {
    const subscribe = useCallback(listener => feed.subscribe(sessionId, listener), [sessionId])
    const snapshotOf = useCallback(() => feed.getSnapshot(sessionId), [sessionId])
    const last = useChat(snapshot => isLastTurn(turn, snapshot))
    const board = useSyncExternalStore(subscribe, snapshotOf)
    if (!last) return null
    // A proposal waiting for confirmation goes right under the reply: the tool
    // card sits inside the turn's process rows, which DSH folds once the turn
    // completes. While one is waiting, the older result line is not repeated here.
    // Import previews from this conversation (laivox_import_file, /laivox with a
    // file) wait here too, for the same reason.
    const pending = Array.isArray(board?.proposals) ? board.proposals : []
    const drafts = Array.isArray(board?.imports) ? board.imports : []
    if (pending.length || drafts.length) return <div className="lv-host lv-hresult" aria-label={t('待确认')}>
      {pending.slice(0, 3).map(proposal => <ProposalConfirm key={proposal.id} proposal={proposal} session={sessionId} actions={proposals}/>)}
      {drafts.slice(0, 3).map(item => <ImportConfirm key={item.id} id={item.id} session={sessionId} title={item.title} feed={feed} openBook={openBook} preview={previewImport}/>)}
      {(pending.length > 3 || drafts.length > 3) && <div className="lv-hline"><span className="lv-hmeta">{t('还有更多待确认，可在输入框上方的 LaiVox 栏查看')}</span></div>}
    </div>
    if (!board?.latest) return null
    return <div className="lv-host lv-hresult">
      <OutcomeLine job={board.latest} player={player} listen={playback.listen} open={openChapter} manage={openSnippets}/>
    </div>
  }

  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, withLanguage(props => <Shell {...{ player, navigation, memory, isPanelActive }} useSessions={props?.useSessions}/>)))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 10, label: () => label('小说配音（LaiVox）') }, () => <Icon name="AudioLines" size={18}/>))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: PANEL, order: 10 }, withLanguage(MiniPlayer)))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: PANEL, order: 30, inject: session => ({ sessionKey: session }),
  }, withLanguage(DockSlot)))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'laivox_propose' }, withLanguage(ToolCard)))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'laivox_speak' }, withLanguage(SpeakTool)))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'laivox_make' }, withLanguage(MakeToolCard)))
  ctx.slots.inject('deliverables.file.actions', () => ctx.slots.register(
    { name: 'deliverables.file.actions', id: PANEL, order: 50 }, withLanguage(DeliverableAction)))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'laivox_add_chapters' }, withLanguage(AddChaptersTool)))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'laivox_import_file' }, withLanguage(ImportTool)))
  // After the host's own copy and feedback buttons.
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
    { name: 'conversation.chat.assistant-actions', id: PANEL, order: 50, label: () => label('朗读') }, withLanguage(MessageSpeak)))
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    { name: 'conversation.chat.turnTail', id: PANEL, order: 40, label: () => label('朗读结果') }, withLanguage(OutcomeTail)))
}
