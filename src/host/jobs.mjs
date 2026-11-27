import { createHash, randomUUID } from 'node:crypto'
import { LAIVOX_DEFAULT_NARRATOR, narratorDefaultFor } from '../domain/voice-assignment.mjs'
import { setTimeout as delay } from 'node:timers/promises'
import { edgeVoices } from './edge.mjs'
import { scriptVariant } from './text.mjs'
import { chooseVoices, resolvePluginModel } from './editorial.mjs'
import { allowedRanges, covers, mergeRanges, planComplete, speechParts } from './plan.mjs'
import { coversChapter, keepAccepted, planPrefix } from './cast-pipeline.mjs'
import { synthesizePart } from './synthesis.mjs'
import { prepareStoredAudio } from './stored-audio.mjs'
import { receiptFor } from './production.mjs'
import { AI_PLAN_VERSION, chapterFingerprint, optionSnapshot, samePlan, selectionSnapshot, signAiPlan, verifyAiPlan } from './ai-plan.mjs'
import { CAST_WINDOW, CLEAN_WINDOW } from '../domain/ai.mjs'
import { castSegmentsFor, packEstimateGroups } from '../domain/ai-batch.mjs'
import { assertLaivoxVoices, classifyLaivox, laivoxCatalog, LAIVOX_TRANSIENT_CODES, laivoxPauseInfo } from './engines/index.mjs'

const supported = new Set(['edge', 'laivox'])
const purposeNames = new Set(['generate', 'clean', 'cast'])
const modes = new Set(['reading', 'multi'])
const DETAIL_LIMIT = 600
const CLAIM_RETRY_MIN = 250
const CLAIM_RETRY_MAX = 10_000

// Expected failures carry a short `detail` (for example the edge worker's
// stderr). Keep one line so it can be persisted and shown without layout jumps.
function failureDetail(error) {
  const value = typeof error?.detail === 'string' ? error.detail.replace(/\s+/gu, ' ').trim() : ''
  return value ? value.slice(0, DETAIL_LIMIT) : null
}

// The failing paragraph is independent from the engine's stderr detail.
function failurePart(error) {
  const part = error?.part
  if (!part) return null
  const n = Number.isInteger(part.n) && part.n >= 0 ? part.n : null
  const text = typeof part.text === 'string' ? part.text.replace(/\s+/gu, ' ').trim().slice(0, 80) : ''
  return n === null && !text ? null : { n, text }
}

// Two Edge parts in flight: enough to hide worker start-up and network latency
// while staying gentle with the online service. Set to 1 to go back to serial.
export const EDGE_CONCURRENCY = 2

// A paused Edge job retries itself before asking the user. The waits grow so a
// short outage heals quietly while a long one still ends up paused. Only these
// failures are retried: content and configuration errors never heal by waiting.
export const EDGE_AUTO_RESUME_WAITS = [15_000, 60_000, 300_000]
const EDGE_TRANSIENT = new Set(['EDGE_UNAVAILABLE', 'EDGE_TIMEOUT', 'EDGE_EMPTY_AUDIO', 'EDGE_WORKER_START_FAILED'])

// A LaiVox part that fails transiently (busy, unreachable) after its own retries
// goes back to the queue instead of pausing the chapter, as long as the run made
// progress within this window; past it the job pauses as before.
export const LAIVOX_TRANSIENT_WINDOW = 5 * 60_000
// Taking a requeued part again waits at least this long (or the gateway's Retry-After).
const REQUEUE_COOLDOWN = 3000
// Several task ids learned close together are saved in one checkpoint.
const TASK_SAVE_DELAY = 1000
// LaiVox multi-role production synthesizes each cast batch while the next one is
// written. false goes back to scripting the whole chapter first (rollback).
export const CAST_SYNTHESIS_OVERLAP = true
// false stops a new job from reusing request ids the gateway already accepted
// for this chapter. Default keeps them, so cancelling and starting again does
// not pay twice for the same sentence.
const INHERIT_ACCEPTED = true
// A lower bound on a LaiVox part's stored size. Used only to refuse a submit
// that could not be stored; under-estimating never blocks a part that fits.
const LAIVOX_BYTES_PER_CHAR = 4000

function retakeWriteId(job, part) {
  return createHash('sha256').update(`${job.id}\n${part.key}\n${part.requestId ?? ''}`).digest('hex').slice(0, 32)
}

function retakeStored(row, part) {
  return Boolean(row) && part.retake === true && row.writeId && row.writeId === part.localWriteId
}

export function createJobQueue({ library, editorial, llm, gatewayFor, errorCode, logger, synthesize = synthesizePart, edgeConcurrency = EDGE_CONCURRENCY, autoResumeWaits = EDGE_AUTO_RESUME_WAITS, transientWindow = LAIVOX_TRANSIENT_WINDOW }) {
  let flight
  let dispatcher
  let claiming
  let closed = false
  let wake = false
  let claimRetry
  let claimRetryDelay = CLAIM_RETRY_MIN
  // Automatic retries per job. The attempt count outlives a re-queue so a
  // flapping service cannot loop forever; a user action or a completed run
  // forgets it. Keeping it in memory means a plugin restart simply leaves the
  // job paused for the user instead of resuming with a stale deadline.
  const autoResume = new Map()
  // 'open' while lanes can still claim; 'closed' once this run has left the loop.
  const synthesisByJob = new Map()
  // Where the listener wants synthesis to continue, for the running job only.
  const focusByJob = new Map()

  function clearAutoResumeTimer(record) {
    if (!record?.timer) return
    clearTimeout(record.timer)
    record.timer = undefined
  }

  function forgetAutoResume(id) {
    const record = autoResume.get(id)
    if (!record) return
    clearAutoResumeTimer(record)
    autoResume.delete(id)
  }

  // Decide (and stamp) the schedule before the checkpoint so the queue page can
  // show it, then let the caller arm the timer once the row is really paused.
  function planAutoResume(job, state) {
    const id = job.id
    const record = autoResume.get(id)
    const attempt = record?.attempt ?? 0
    // A model call was dispatched and its batch is not saved. The provider may
    // already have accepted it, so a synthesis retry must not send it again.
    if (state === 'paused' && job.progress?.aiDispatch) {
      forgetAutoResume(id)
      delete job.progress.autoResume
      return null
    }
    // Edge outages and LaiVox busy/unreachable spells heal by waiting; quota, key,
    // membership and content problems never do and wait for the user.
    // A LaiVox job being finished with Edge also heals from Edge outages; neither
    // retry ever calls LaiVox for parts already switched to Edge.
    if (state === 'paused' && job.spec.engine === 'laivox' && job.progress.laivoxPause?.kind === 'held') {
      const until = Number(job.progress.laivoxPause.until) || Date.now()
      const wait = Math.max(0, until + 5000 - Date.now())
      job.progress.autoResume = { attempt: 1, at: Date.now() + wait }
      return { attempt: 1, wait, error: job.progress.error }
    }
    const transient = job.spec.engine === 'edge' ? EDGE_TRANSIENT : job.spec.engine === 'laivox'
      ? (job.progress.fill ? new Set([...LAIVOX_TRANSIENT_CODES, ...EDGE_TRANSIENT]) : LAIVOX_TRANSIENT_CODES) : null
    const resumable = state === 'paused' && Boolean(transient?.has(job.progress.error)) && attempt < autoResumeWaits.length
    if (!resumable) {
      forgetAutoResume(id)
      delete job.progress.autoResume
      return null
    }
    const wait = autoResumeWaits[attempt]
    job.progress.autoResume = { attempt: attempt + 1, at: Date.now() + wait }
    return { attempt: attempt + 1, wait, error: job.progress.error }
  }

  function scheduleAutoResume(job, plan) {
    if (closed) return
    const timer = setTimeout(() => { void resumeQuietly(job.id, plan.error) }, plan.wait)
    timer.unref?.()
    autoResume.set(job.id, { attempt: plan.attempt, error: plan.error, timer })
  }

  async function resumeQuietly(id, error) {
    const record = autoResume.get(id)
    if (record) record.timer = undefined
    if (closed) return
    let row
    try { row = await library.job(id) } catch { return }
    // The user may have paused, cancelled or resumed meanwhile, and a newer run
    // may already have failed with another code.
    if (closed || !row || row.state !== 'paused' || row.progress.error !== error) return
    try {
      // Keep the original priority: an automatic retry must never preempt the
      // job the user started in the meantime.
      await library.transition(id, 'paused', 'queued')
    } catch { return }
    kick()
  }

  async function normalize(input, resolvedSelection) {
    const purpose = input.purpose ?? 'generate'
    const engine = input.engine ?? 'edge'
    if (!supported.has(engine) || !purposeNames.has(purpose)) throw new Error('INVALID_INPUT')
    if (input.mode !== undefined && !modes.has(input.mode)) throw new Error('INVALID_INPUT')
    const clean = purpose === 'clean' || input.clean === true
    const cast = purpose === 'cast' || input.cast === true
    const spec = { engine, purpose, clean, cast, reuse: input.reuse === true, ...(input.mode === undefined ? {} : { mode: input.mode }) }
    if (clean || cast) spec.selection = resolvedSelection ?? await resolvePluginModel(llm, input.selection)
    return spec
  }

  // Rewrites the waiting parts of a LaiVox job as Edge parts. A part LaiVox already
  // accepted (it has a task, so it is paid for) keeps LaiVox while the gateway is
  // reachable. The LaiVox plan stays in `primary`; `key` is always what plays.
  async function fillWithEdge(chapter, progress, gatewayReachable) {
    const ready = new Set((await library.audioKeys(chapter.id)).map(item => item.key))
    const targets = progress.parts.flatMap((part, index) => !ready.has(part.key) && part.engine !== 'edge'
      && (!part.taskId || !gatewayReachable) ? [index] : [])
    if (!targets.length) return
    // One Edge plan for the whole chapter keeps each role on one voice.
    const variant = progress.parts.find(part => part.variant)?.variant ?? scriptVariant(chapter.text)
    const edge = chooseVoices(progress.parts, await library.roles(chapter.book), edgeVoices, 'edge', variant, { version: progress.segmentVersion, rule: chapter.voiceRule })
    for (const index of targets) {
      const part = progress.parts[index]
      part.primary = { engine: 'laivox', voiceId: part.voiceId, key: part.key }
      part.engine = 'edge'
      part.voiceId = edge[index].voiceId
      part.key = edge[index].key
      delete part.requestId; delete part.taskId; delete part.resubmits; delete part.voiceRevision
    }
  }

  async function execute(job, signal) {
    const chapter = await library.chapter(job.chapter)
    const { spec, progress } = job
    if (chapter.rev !== job.rev) throw new Error('VERSION_CONFLICT')
    progress.error = null
    progress.pauseReason = null
    progress.errorDetail = null
    progress.errorPart = null
    delete progress.autoResume
    delete progress.laivoxPause
    const save = () => library.checkpoint(job.id, 'running', progress)
    signal.throwIfAborted()
    let gateway
    if (spec.purpose === 'generate' && spec.engine === 'laivox') {
      try { gateway = await gatewayFor(progress.account ?? spec.laivoxNarratorDefault?.account, signal) }
      catch (error) {
        // Finishing with Edge was chosen because LaiVox is unavailable: go on without it.
        if (!progress.fill || signal.aborted) throw error
        gateway = undefined
      }
    }
    signal.throwIfAborted()
    if (gateway) {
      progress.account = gateway.account
      await save()
    }
    const choice = spec.laivoxNarratorDefault
    const narratorDefault = gateway && (!choice?.account || choice.account === gateway.account) ? choice ?? null : null
    if (CAST_SYNTHESIS_OVERLAP && spec.purpose === 'generate' && spec.cast && spec.engine === 'laivox' && gateway
      && !spec.only && !progress.ranges?.length && !progress.fill && !planComplete(progress)) {
      await overlapCastAndSynthesis({ job, chapter, gateway, narratorDefault, save, signal })
      if ((await library.revision(job.chapter)) !== job.rev) throw new Error('VERSION_CONFLICT')
      return
    }
    if (!planComplete(progress)) {
      const prepared = await editorial.prepare(chapter, job, save, signal, { beforeNext: () => beforeNextModel(job, signal) })
      signal.throwIfAborted()
      if (spec.purpose !== 'generate') return
      // Dividers and parts with nothing to pronounce never reach the engine; Edge
      // answers them with an empty stream, which used to pause the whole chapter.
      // Single-narrator reading ignores the cast, including any voice direction
      // left by an earlier multi-role script. speechParts keeps that order.
      const shaped = speechParts(prepared, spec)
      progress.skipped = shaped.skipped
      if (!shaped.parts.length) throw new Error('CHAPTER_EMPTY')
      const variant = scriptVariant(chapter.text)
      // A LaiVox job finished with Edge before LaiVox ever planned it uses Edge voices throughout.
      const edgePlan = spec.engine === 'edge' || (progress.fill && !gateway)
      const catalog = edgePlan ? edgeVoices : await laivoxCatalog(gateway, signal)
      const ready = new Set((await library.audioKeys(chapter.id)).map(item => item.key))
      // A partial plan from an overlapped run (finished here because the user chose
      // Edge) may hold parts LaiVox already accepted: they keep their ids. A new
      // job also keeps ids the gateway already accepted for this chapter, but
      // only for parts that still have no audio, and never for a retake.
      const inherited = INHERIT_ACCEPTED && !spec.retake && spec.engine === 'laivox'
        ? (await library.acceptedParts(chapter.id, job.id)).filter(part => !ready.has(part.key)) : []
      progress.parts = keepAccepted(chooseVoices(shaped.parts, await library.roles(chapter.book), catalog, edgePlan ? 'edge' : spec.engine, variant,
        { version: progress.segmentVersion, rule: chapter.voiceRule, narratorDefault }), [...inherited, ...(progress.parts ?? [])])
      delete progress.partsOpen
      if (edgePlan && spec.engine !== 'edge') for (const part of progress.parts) part.engine = 'edge'
    }
    if (progress.fill && spec.engine === 'laivox') await fillWithEdge(chapter, progress, Boolean(gateway))
    signal.throwIfAborted()
    progress.stage = 'synthesizing'
    await save()
    const ready = new Set((await library.audioKeys(chapter.id)).map(item => item.key))
    // A retake redoes the parts of its range that have audio too, each once: a
    // resumed retake skips the parts it already replaced. LaiVox is asked for a
    // new take (is_retry) under a new request id, so it is a new synthesis.
    const retaken = new Set(progress.retaken ?? [])
    const pending = progress.parts.flatMap((part, index) => spec.retake
      ? (covers(part, allowedRanges(spec, progress)) && !retaken.has(index) ? [[part, index]] : [])
      : (ready.has(part.key) ? [] : [[part, index]]))
    if (spec.retake) for (const [part] of pending) part.retake = true
    await synthesizeParts({ job, chapter, gateway, save, signal, ready, pending })
    if ((await library.revision(job.chapter)) !== job.rev) throw new Error('VERSION_CONFLICT')
  }

  // Scripting and synthesis together. Each finished cast batch is planned with the
  // roles as they were when this run started (roles found later are appended, which
  // never moves an earlier role's voice), and its parts join the lanes at once. The
  // plan only grows: a resumed run keeps the parts already planned, with their
  // request and task ids. When the cast is complete the plan must cover the chapter.
  async function overlapCastAndSynthesis({ job, chapter, gateway, narratorDefault, save, signal }) {
    const { spec, progress } = job
    const planSpec = { ...spec, laivoxNarratorDefault: narratorDefault }
    const catalog = await laivoxCatalog(gateway, signal)
    const variant = scriptVariant(chapter.text)
    const snapshot = await library.roles(chapter.book)
    const known = new Set(snapshot.map(role => role.id))
    const rolesNow = async () => [...snapshot, ...(await library.roles(chapter.book)).filter(role => !known.has(role.id))]
    progress.parts ??= []
    progress.partsOpen = true
    const ready = new Set((await library.audioKeys(chapter.id)).map(item => item.key))
    const inherited = INHERIT_ACCEPTED ? await library.acceptedParts(chapter.id, job.id) : []
    const pending = progress.parts.flatMap((part, index) => ready.has(part.key) ? [] : [[part, index]])
    const controls = { wake: () => {} }
    const pipeline = new AbortController()
    const scoped = AbortSignal.any([signal, pipeline.signal])
    async function extend(prefix, final) {
      const planned = planPrefix(prefix, final, { spec: planSpec, roles: await rolesNow(), catalog, variant, version: progress.segmentVersion, rule: chapter.voiceRule })
      const mismatch = planned.parts.slice(0, progress.parts.length).findIndex((part, index) => part.key !== progress.parts[index].key)
      if (mismatch >= 0) logger?.warn?.('LaiVox job ' + job.id + ' plan differs from the parts already planned at ' + mismatch + '; keeping those')
      const added = planned.parts.slice(progress.parts.length)
      if (added.length) {
        assertLaivoxVoices(added, catalog)
        keepAccepted(added, inherited.filter(part => !ready.has(part.key)))
        for (const part of added) if (!part.requestId) part.requestId = randomUUID()
        const first = progress.parts.length
        progress.parts.push(...added)
        await save()
        pending.push(...added.map((part, offset) => [part, first + offset]).filter(([part]) => !ready.has(part.key)))
        if (!Number.isInteger(focusByJob.get(job.id))) {
          const origin = Number.isSafeInteger(progress.aim) ? progress.aim : Number.isSafeInteger(spec.focusStart) ? spec.focusStart : null
          const index = origin === null ? -1 : progress.parts.findIndex(part => part.end > origin)
          if (index >= 0) focusByJob.set(job.id, index)
        }
        controls.wake()
      }
      return planned
    }
    const synthesis = synthesizeParts({ job, chapter, gateway, save, signal: scoped, ready, pending, open: () => Boolean(progress.partsOpen), controls })
    // A synthesis failure stops the scripting too; its error is the one reported.
    synthesis.catch(error => pipeline.abort(error))
    let prepared
    try {
      prepared = await editorial.prepare(chapter, job, save, scoped, { onCastBatch: prefix => extend(prefix, false), beforeNext: () => beforeNextModel(job, signal) })
      signal.throwIfAborted()
      const final = await extend(prepared, true)
      if (!progress.parts.length) throw new Error('CHAPTER_EMPTY')
      if (!coversChapter(progress.parts, prepared, spec)) throw new Error('PLAN_MISMATCH')
      progress.skipped = final.skipped
    } catch (error) {
      const cause = pipeline.signal.aborted ? pipeline.signal.reason : error
      pipeline.abort(cause)
      await synthesis.catch(() => {})
      throw cause
    }
    delete progress.partsOpen
    progress.stage = 'synthesizing'
    await save()
    controls.wake()
    await synthesis
  }

  // The synthesis half of a job. pending is a list of [part, index] that may grow
  // while open() is true (scripting still running); controls.wake() tells the
  // lanes about new parts. Edge parts keep the original fixed-lane rounds.
  async function synthesizeParts({ job, chapter, gateway, save, signal, ready, pending, open = () => false, controls = {} }) {
    const { spec, progress } = job
    // Keys stored by a lane in this run. A row that was already on disk is not a new retake.
    const storedThisRun = new Map()
    controls.wake = () => {}
    // Edge overlaps worker start-up and network round trips across a few lanes;
    // LaiVox stays strictly sequential. Lanes claim parts in order, so the first
    // parts start together and playback can begin early. Resume points are the
    // audio rows themselves, so completing out of order is safe.
    // A voice deleted, locked or changed since planning pauses the job and names the role.
    // Parts LaiVox already accepted are left out: their task used the voice the part's
    // key names, so fetching that result stays consistent (and it is already paid for).
    const laivoxPending = pending.map(([part]) => part).filter(part => (part.engine ?? spec.engine) === 'laivox' && !part.taskId)
    if (gateway && laivoxPending.length) assertLaivoxVoices(laivoxPending, await laivoxCatalog(gateway, signal))
    // Edge keeps its fixed lanes. LaiVox follows the lanes the gateway allows, which
    // may change during the chapter (see supervise below); the gateway enforces them.
    const edgeOnly = spec.engine === 'edge' || (pending.length > 0 && pending.every(([part]) => part.engine === 'edge'))
    const lanes = edgeOnly ? Math.max(1, edgeConcurrency) : 0
    // Every LaiVox part still to submit gets its request id in one save, before any
    // submission: an id is always on disk before the gateway sees it.
    let assigned = false
    for (const part of laivoxPending) if (!part.requestId) { part.requestId = randomUUID(); assigned = true }
    if (assigned) await save()
    const local = new AbortController()
    const scoped = AbortSignal.any([signal, local.signal])
    // Every slot before the cursor is claimed. Slots that are not allowed yet stay
    // ahead of it, so a range included later is still reachable in order.
    let cursor = 0
    let claims = 0
    let failure
    const claimed = new Set()
    // One synthesis per audio key. A second lane that draws the same key waits
    // for the first and keeps its result instead of paying again.
    const inflightKeys = new Map()
    // Requeued LaiVox slots and when they may be taken again.
    const cooling = new Map()
    let lastProgress = -Infinity
    const timings = []
    // Task ids are merged into one checkpoint; every other save is written at once
    // and supersedes a pending merge. Closed before the job's final state is written,
    // so a late 'running' checkpoint can never overwrite it.
    let mergeTimer = null
    let mergeWrite = null
    let saverClosed = false
    function saveFor(part) {
      return kind => {
        if (kind !== 'task') {
          clearTimeout(mergeTimer); mergeTimer = null
          return saverClosed ? Promise.resolve() : save()
        }
        lastProgress = Date.now()
        timing(part).accepted = Date.now()
        if (saverClosed || mergeTimer) return Promise.resolve()
        mergeTimer = setTimeout(() => {
          mergeTimer = null
          if (!saverClosed) mergeWrite = save().catch(error => logger?.warn?.('LaiVox job ' + job.id + ' could not save task ids: ' + (error?.message ?? error)))
        }, TASK_SAVE_DELAY)
        mergeTimer.unref?.()
        return Promise.resolve()
      }
    }
    async function closeSaver() {
      saverClosed = true
      clearTimeout(mergeTimer); mergeTimer = null
      await mergeWrite
    }
    const timingOf = new Map()
    const timing = part => { let entry = timingOf.get(part); if (!entry) { entry = {}; timingOf.set(part, entry) } return entry }
    const bounded = Boolean(spec.only) || (progress.ranges?.length > 0)
    if (!Number.isInteger(focusByJob.get(job.id))) {
      const origin = Number.isSafeInteger(progress.aim) ? progress.aim : Number.isSafeInteger(spec.focusStart) ? spec.focusStart : null
      if (origin !== null) {
        const index = progress.parts.findIndex(part => part.end > origin)
        if (index >= 0) focusByJob.set(job.id, index)
      }
    }
    function permitted(part) {
      if (!bounded && !(progress.ranges?.length)) return true
      return covers(part, allowedRanges(spec, progress))
    }
    // Lanes claim synchronously, so two lanes never take the same part. A focus
    // pulls the first allowed unclaimed part at or after it forward. Parts
    // outside an only-range stay unclaimed so a later include can still take them.
    // A requeued slot is skipped while it cools down; it stays ahead of the cursor.
    const coolingNow = slot => cooling.size > 0 && cooling.get(slot) > Date.now()
    function claim() {
      const focus = focusByJob.get(job.id)
      if (Number.isInteger(focus)) {
        const at = pending.findIndex((entry, slot) => !claimed.has(slot) && !coolingNow(slot) && entry[1] >= focus && permitted(entry[0]))
        if (at >= 0) { claimed.add(at); claims++; return [...pending[at], at] }
      }
      for (let slot = cursor; slot < pending.length; slot++) {
        if (claimed.has(slot)) {
          if (slot === cursor) cursor = slot + 1
          continue
        }
        if (coolingNow(slot) || !permitted(pending[slot][0])) continue
        claimed.add(slot)
        claims++
        if (slot === cursor) cursor = slot + 1
        return [...pending[slot], slot]
      }
      return null
    }
    let requeued = () => {}
    // shouldStop: the lane ends before taking another part (the gateway lowered the lanes).
    async function lane(shouldStop = () => false) {
      while (!failure) {
        if (shouldStop()) return
        const next = claim()
        if (!next) return
        const [part, index, slot] = next
        timing(part).claimed = Date.now()
        scoped.throwIfAborted()
        if ((await library.revision(job.chapter)) !== job.rev) throw new Error('VERSION_CONFLICT')
        const engine = part.engine ?? spec.engine
        if (!part.retake && ready.has(part.key)) continue
        if (part.downloaded) {
          const existing = await library.audio(chapter.id, part.key)
          if (existing && (!part.retake || retakeStored(existing, part))) {
            if (part.retake) progress.retaken = [...new Set([...(progress.retaken ?? []), index])]
            ready.add(part.key)
            continue
          }
        }
        const earlier = inflightKeys.get(part.key)
        if (earlier) {
          await earlier.catch(() => {})
          if (part.retake) {
            if (storedThisRun.has(part.key)) {
              progress.retaken = [...new Set([...(progress.retaken ?? []), index])]
              ready.add(part.key)
              continue
            }
          } else if (ready.has(part.key)) continue
        }
        let finishInflight
        const flight = new Promise(resolve => { finishInflight = resolve })
        inflightKeys.set(part.key, flight)
        let pcm
        try {
        const { used, limit } = await library.space()
        scoped.throwIfAborted()
        const prior = part.retake ? await library.audioInfo(chapter.id, part.key) : null
        scoped.throwIfAborted()
        if (!(part.retake && prior?.bytes > 0)) {
          const estimate = engine === 'laivox' && !part.taskId ? LAIVOX_BYTES_PER_CHAR * [...(part.text ?? '')].length : 0
          if ((estimate ? used + estimate > limit : used >= limit)) throw new Error('AUDIO_LIMIT')
        }
        try {
          pcm = await synthesize(engine, part, gateway?.client, saveFor(part), scoped)
        } catch (caught) {
          let error = caught
          // The gateway turns a voice it no longer knows (deleted in the extension
          // while the catalogue was still cached) into a plain 400: look again.
          if (gateway && caught?.message === 'INVALID_INPUT' && caught?.status === 400) {
            try { assertLaivoxVoices([part], await laivoxCatalog(gateway, scoped, { refresh: true })) }
            catch (voice) { if (/^LAIVOX_VOICE_/u.test(voice?.message ?? '')) error = voice }
          }
          // Busy or unreachable even after the part's own retries: while the chapter is
          // moving, put the part back (same request id) and let this lane go, instead of
          // stopping every lane. No progress for a while still pauses the job.
          if (!edgeOnly && (part.engine ?? spec.engine) === 'laivox' && !scoped.aborted && classifyLaivox(error) === 'transient'
            && Date.now() - lastProgress < transientWindow) {
            claimed.delete(slot)
            if (slot < cursor) cursor = slot
            const wait = Math.max(REQUEUE_COOLDOWN, (Number(error?.wait) || 0) * 1000)
            cooling.set(slot, Date.now() + wait)
            logger?.warn?.('LaiVox job ' + job.id + ' requeued part ' + index + ' after ' + (error?.message ?? error))
            requeued(wait)
            return
          }
          // Point at the exact paragraph so the UI can show which sentence failed
          // even when the engine reports no stderr detail (for example a timeout).
          if (!error.part) error.part = { n: index, text: String(part.text ?? '').slice(0, 80) }
          throw error
        }
        scoped.throwIfAborted()
        if (pcm.skipped) progress.skipped = (progress.skipped ?? 0) + 1
        const engineName = part.engine ?? spec.engine
        let stored = pcm
        if (engineName === 'laivox' && pcm.originalWav) {
          part.downloaded = true
          if (part.retake) part.localWriteId = retakeWriteId(job, part)
          await save()
          stored = await prepareStoredAudio(pcm, { originalWav: pcm.originalWav, engine: engineName, signal: scoped })
        }
        timing(part).synthesized = Date.now()
        try {
          await library.putAudio(chapter.id, job.rev, part.key, stored, { replace: part.retake === true, writeId: part.retake ? part.localWriteId : null })
        } catch (error) {
          if (scoped.aborted || error?.message === 'AUDIO_LIMIT' || error?.message === 'VERSION_CONFLICT') throw error
          const existing = await library.audio(chapter.id, part.key)
          const kept = existing && (!part.retake || retakeStored(existing, part))
          if (!kept) throw error
        }
        if (part.retake) {
          const confirmed = !part.localWriteId || retakeStored(await library.audio(chapter.id, part.key), part)
          if (confirmed) progress.retaken = [...new Set([...(progress.retaken ?? []), index])]
        }
        storedThisRun.set(part.key, part.localWriteId ?? true)
        ready.add(part.key)
        lastProgress = Date.now()
        cooling.delete(slot)
        const done = timing(part)
        done.stored = Date.now()
        timings.push(done)
        logger?.debug?.('laivox timing ' + job.id + ' part ' + index + ' ' + JSON.stringify({ engine: part.engine ?? spec.engine,
          accepted: done.accepted ? done.accepted - done.claimed : null, synthesized: done.synthesized - done.claimed, stored: done.stored - done.claimed,
          lanes: gateway?.client?.lanes?.() ?? lanes }))
        } finally {
          finishInflight()
          if (inflightKeys.get(part.key) === flight) inflightKeys.delete(part.key)
        }
      }
    }
    const failWith = error => {
      // The first real error wins; sibling lanes stop on the local abort and
      // their abort errors are ignored.
      if (!failure) { failure = error; local.abort(error) }
    }
    // Edge: a fixed number of lanes, in rounds, exactly as before.
    async function rounds() {
      for (;;) {
        const before = claims
        await Promise.all(Array.from({ length: Math.min(lanes, Math.max(1, pending.length)) }, () => lane().catch(failWith)))
        signal.throwIfAborted()
        if (failure) throw failure
        if (!pending.some((entry, slot) => !claimed.has(slot) && permitted(entry[0]))) break
        // A round that claimed nothing would repeat forever on microtasks alone and
        // freeze the host. Stop instead; the missing parts stay unsynthesized.
        if (claims === before) {
          logger?.warn?.('LaiVox job ' + job.id + ' left allowed parts unclaimed; stopping this run')
          break
        }
      }
    }
    // LaiVox: keeps as many lanes running as the gateway currently allows. A wider
    // credit adds lanes at once; a narrower one lets lanes end after their part.
    async function supervise() {
      const running = new Set()
      let wakeUp = null
      let wakeTimer = null
      let wakeAt = Infinity
      const wake = () => { const resolve = wakeUp; wakeUp = null; resolve?.() }
      controls.wake = wake
      // Wake when the earliest cooling slot may be taken again. A timer may fire a
      // little before Date.now() reaches the deadline, so the loop re-arms it from
      // the slots still cooling before every wait (see below), with a small margin.
      requeued = wait => {
        const at = Date.now() + wait
        if (at >= wakeAt) return
        clearTimeout(wakeTimer)
        wakeAt = at
        wakeTimer = setTimeout(() => { wakeAt = Infinity; wake() }, wait + 5)
        wakeTimer.unref?.()
      }
      const rearm = () => {
        const deadlines = pending.flatMap((entry, slot) => !claimed.has(slot) && cooling.has(slot) && permitted(entry[0]) ? [cooling.get(slot)] : [])
        if (deadlines.length) requeued(Math.max(1, Math.min(...deadlines) - Date.now()))
      }
      // Parts already switched to Edge (finish with Edge) keep Edge's own lane limit.
      const edgeParts = pending.some(([part]) => part.engine === 'edge')
      const target = () => {
        const allowed = Math.max(1, Number(gateway?.client?.lanes?.()) || 1)
        return edgeParts ? Math.min(allowed, Math.max(1, edgeConcurrency)) : allowed
      }
      const unsubscribe = gateway?.client?.onLanesChange?.(wake) ?? (() => {})
      // A stop (pause, cancel, a failed cast) must also end a wait for new parts.
      signal.addEventListener('abort', wake, { once: true })
      const takeable = () => pending.some((entry, slot) => !claimed.has(slot) && !coolingNow(slot) && permitted(entry[0]))
      const cooled = () => pending.some((entry, slot) => !claimed.has(slot) && coolingNow(slot) && permitted(entry[0]))
      try {
        for (;;) {
          if (signal.aborted) break
          while (!failure && running.size < target() && takeable()) {
            const run = lane(() => running.size > target()).catch(failWith).finally(() => { running.delete(run); wake() })
            running.add(run)
          }
          if (failure) break
          // While the chapter is still being scripted, more parts are on their way.
          if (!running.size && !takeable() && !cooled() && !open()) break
          if (!running.size && !takeable()) rearm()
          await new Promise(resolve => { wakeUp = resolve })
        }
        await Promise.allSettled([...running])
      } finally {
        unsubscribe()
        signal.removeEventListener('abort', wake)
        clearTimeout(wakeTimer)
        controls.wake = () => {}
      }
      signal.throwIfAborted()
      if (failure) throw failure
    }
    synthesisByJob.set(job.id, 'open')
    try {
      if (edgeOnly) await rounds()
      else await supervise()
    } finally {
      synthesisByJob.set(job.id, 'closed')
      await closeSaver()
      if (timings.length) {
        const sorted = key => timings.map(entry => entry[key] - entry.claimed).filter(Number.isFinite).sort((a, b) => a - b)
        const pick = (values, q) => values.length ? values[Math.min(values.length - 1, Math.floor(values.length * q))] : null
        const stored = sorted('stored')
        logger?.info?.('laivox timing summary ' + job.id + ' ' + JSON.stringify({ parts: timings.length,
          p50: pick(stored, 0.5), p90: pick(stored, 0.9), lanes: gateway?.client?.lanes?.() ?? lanes }))
      }
    }
  }

  async function finish(active) {
    const { job, controller: { signal } } = active
    let state = 'completed'
    try {
      signal.throwIfAborted()
      await execute(job, signal)
      signal.throwIfAborted()
    } catch (error) {
      job.progress.error = signal.aborted ? null : errorCode(error)
      job.progress.errorDetail = signal.aborted ? null : failureDetail(error)
      job.progress.errorPart = signal.aborted ? null : failurePart(error)
      const retryAfter = Number.isSafeInteger(error?.retryAfter) && error.retryAfter > 0 && error.retryAfter <= 86_400 ? error.retryAfter : null
      if (!signal.aborted && retryAfter) job.progress.retryAfter = retryAfter
      else delete job.progress.retryAfter
      // What a paused LaiVox job lets the user do next (open a usage day, replace the key…).
      const pause = !signal.aborted && job.spec.engine === 'laivox' ? laivoxPauseInfo(error) : null
      if (pause) job.progress.laivoxPause = pause
      else delete job.progress.laivoxPause
      job.progress.pauseReason = signal.reason?.message === 'JOB_SUPERSEDED' ? 'newer-task'
        : signal.reason?.message === 'PLUGIN_STOPPED' ? 'restart' : null
      delete job.progress.yieldWait
      state = signal.reason?.message === 'JOB_CANCELLED' || job.progress.error === 'VERSION_CONFLICT' ? 'cancelled' : 'paused'
      if (job.progress.error) {
        logger?.warn?.('LaiVox job ' + job.id + ' failed: ' + job.progress.error
          + (job.progress.errorDetail ? ' · ' + job.progress.errorDetail : '')
          + (job.progress.errorPart ? ' · part ' + job.progress.errorPart.n + ' len ' + (job.progress.errorPart.text?.length ?? 0) : ''))
      }
    }
    // A focus only steers the run it was given to; a resumed run starts in order.
    focusByJob.delete(job.id)
    synthesisByJob.delete(job.id)
    active.committing = true
    const resume = planAutoResume(job, state)
    const saved = await commit(job, state)
    if (resume && saved === state) scheduleAutoResume(job, resume)
    return { row: { ...job, state: saved } }
  }

  // The final checkpoint is what releases the queue: a row left in `running`
  // blocks every later job and refuses pause and cancel. Retry briefly, then fall
  // back to the smallest possible write (state only) so the queue can move on.
  async function commit(job, state) {
    let failure
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await library.checkpoint(job.id, state, job.progress, { retake: job.spec?.retake === true })
        return state
      } catch (error) {
        failure = error
        if (closed) break
        if (attempt < 2) await delay(250)
      }
    }
    logger?.warn?.('LaiVox job ' + job.id + ' could not save its final state (' + state + '): ' + (failure?.message ?? failure))
    try {
      await library.transition(job.id, 'running', 'paused')
      return 'paused'
    } catch (error) {
      logger?.warn?.('LaiVox job ' + job.id + ' is still marked running: ' + (error?.message ?? error))
      throw failure
    }
  }

  function launch(job) {
    if (!job) return null
    const active = { job, controller: new AbortController(), committing: false }
    flight = active
    // A queued job no longer needs its pending retry, but the attempt count
    // stays so a job that keeps failing cannot retry forever.
    clearAutoResumeTimer(autoResume.get(job.id))
    if (closed) active.controller.abort(new Error('PLUGIN_STOPPED'))
    active.settled = finish(active).catch(error => {
      logger?.warn?.('LaiVox job ' + job.id + ' ended unexpectedly: ' + (error?.message ?? error))
      return { error }
    }).finally(() => {
      flight = undefined
      kick()
    })
    return active
  }

  async function dispatch() {
    do {
      wake = false
      if (closed || flight) return
      claiming = library.next().then(launch)
      try {
        await claiming
        claimRetryDelay = CLAIM_RETRY_MIN
      } finally { claiming = undefined }
    } while (wake && !closed)
  }

  function kick() {
    if (closed) return
    wake = true
    if (dispatcher || claimRetry) return
    dispatcher = dispatch().catch(error => {
      if (closed) return
      if (claimRetryDelay === CLAIM_RETRY_MIN) logger?.warn?.('LaiVox could not claim a queued job: ' + (error?.message ?? error))
      claimRetry = setTimeout(() => {
        claimRetry = undefined
        kick()
      }, claimRetryDelay)
      claimRetry.unref?.()
      claimRetryDelay = Math.min(claimRetryDelay * 2, CLAIM_RETRY_MAX)
    }).finally(() => {
      dispatcher = undefined
      if (wake) kick()
    })
  }

  async function prefer(priority) {
    // A pending claim may already have selected an older job. The dispatcher
    // handles claim failures independently of the submission we just saved.
    const active = flight ?? await claiming?.catch(() => null)
    if (active && active.job.priority < priority && !active.committing && !active.controller.signal.aborted) {
      // An in-flight model batch is a recoverable boundary: remember the waiter
      // and let the current request finish. Synthesis and idle jobs still stop now.
      if (active.job.progress?.aiDispatch) {
        active.yieldRequested = true
        active.job.progress.yieldWait = true
        library.checkpoint(active.job.id, 'running', active.job.progress).catch(() => {})
      } else active.controller.abort(new Error('JOB_SUPERSEDED'))
    }
    kick()
  }

  async function beforeNextModel(job, signal) {
    const active = flight
    if (!active || active.job.id !== job.id || !active.yieldRequested || active.controller.signal.aborted) return
    const higher = Number.isFinite(job.priority) && await library.hasHigherQueued(job.priority)
    if (!higher) {
      active.yieldRequested = false
      delete job.progress.yieldWait
      return
    }
    delete job.progress.yieldWait
    active.controller.abort(new Error('JOB_SUPERSEDED'))
    signal.throwIfAborted()
  }

  async function narratorSnapshot(signal) {
    const choice = (await library.settings())?.values?.laivoxNarratorDefault
    if (!choice?.account) return LAIVOX_DEFAULT_NARRATOR
    try {
      const session = await gatewayFor(undefined, signal)
      if (session?.account !== choice.account) return LAIVOX_DEFAULT_NARRATOR
      const catalog = await laivoxCatalog(session, signal)
      return narratorDefaultFor('laivox', session.account, catalog, choice) ?? LAIVOX_DEFAULT_NARRATOR
    } catch {
      return LAIVOX_DEFAULT_NARRATOR
    }
  }

  function freezeNarrator(spec, snapshot) {
    if (spec?.engine !== 'laivox' || !snapshot || Object.hasOwn(spec, 'laivoxNarratorDefault')) return spec
    return { ...spec, laivoxNarratorDefault: snapshot }
  }

  async function resumeMatchedPaused(jobs, entries, priority) {
    let woke = false
    const out = [...jobs]
    for (let index = 0; index < out.length; index++) {
      const job = out[index]
      if (!job || job.id === entries[index]?.id || job.state !== 'paused') continue
      forgetAutoResume(job.id)
      try {
        out[index] = await library.transition(job.id, 'paused', 'queued', priority)
        woke = true
      } catch (error) {
        if (error?.message !== 'JOB_STATE_CHANGED') throw error
        out[index] = await library.job(job.id) ?? job
      }
    }
    return { jobs: out, woke }
  }

  async function enqueue(chapters, spec, session, priority, signal) {
    const frozen = freezeNarrator(spec, spec?.engine === 'laivox' ? await narratorSnapshot(signal) : null)
    const entries = chapters.map(chapter => ({ id: randomUUID(), chapter: chapter.id, rev: chapter.rev, session, spec: frozen }))
    const inserted = await library.enqueue(entries, priority)
    const { jobs, woke } = await resumeMatchedPaused(inserted, entries, priority)
    if (woke || jobs.some((job, index) => job.id === entries[index].id)) await prefer(priority)
    return jobs
  }

  async function prepare(ids, input, signal, planSubject) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string')) throw new Error('INVALID_INPUT')
    const rows = await library.prepareBatch([...new Set(ids)], input)
    const summarize = list => ({ rows: list, characters: list.reduce((total, row) => total + row.characters, 0),
      clean: list.filter(row => row.spec.clean).length, cast: list.filter(row => row.spec.cast).length,
      needsModel: list.some(row => row.spec.clean || row.spec.cast) })
    if (input?.estimateAi !== true) return summarize(rows)
    signal?.throwIfAborted()
    if (input.retake === true) {
      const plain = rows.map(row => ({ ...row, spec: { ...row.spec, clean: false, cast: false, reuse: true } }))
      return { ...summarize(plain), needsModel: false, aiPlan: { selection: null, requests: 0, clean: 0, cast: 0, provisional: false, confirmation: null } }
    }
    if (!summarize(rows).needsModel) {
      return { ...summarize(rows), aiPlan: { selection: null, requests: 0, clean: 0, cast: 0, provisional: false, confirmation: null } }
    }
    const resolved = await resolvePluginModel(llm, input.selection, signal)
    signal?.throwIfAborted()
    const counted = new Map()
    for (const group of packEstimateGroups(rows)) {
      signal?.throwIfAborted()
      const estimated = await library.estimateGroup(group.map(row => row.id), input, {
        cleanWindow: CLEAN_WINDOW, castWindow: { chars: CAST_WINDOW, segments: castSegmentsFor(resolved) },
      })
      for (const item of estimated) counted.set(item.id, item)
    }
    const merged = rows.map(row => {
      const fresh = counted.get(row.id)
      return fresh ? { ...row, rev: fresh.rev, rolesRev: fresh.rolesRev, editorialResultJob: fresh.editorialResultJob,
        characters: fresh.characters, spec: fresh.spec } : row
    })
    const totals = [...counted.values()].reduce((sum, item) => ({
      requests: sum.requests + item.requests, clean: sum.clean + item.clean, cast: sum.cast + item.cast,
      provisional: sum.provisional || item.provisional,
    }), { requests: 0, clean: 0, cast: 0, provisional: false })
    const snapshot = {
      v: AI_PLAN_VERSION, chapters: chapterFingerprint(merged), options: optionSnapshot(input),
      selection: selectionSnapshot(resolved, input.selection), requests: totals.requests,
      provisional: totals.provisional, text: null,
      ...(planSubject ? { planSubject } : {}),
    }
    return {
      ...summarize(merged),
      aiPlan: {
        selection: { ...snapshot.selection, name: resolved.name ?? resolved.model },
        requests: totals.requests, clean: totals.clean, cast: totals.cast, provisional: totals.provisional,
        confirmation: signAiPlan(snapshot),
      },
    }
  }

  // `options` comes only from a confirmed AI make proposal: priority 0
  // queues behind every reserved priority and never supersedes the running job;
  // session ties the jobs to the conversation. The HTTP route passes neither.
  async function enqueuePrepared(ids, input, signal, options = {}) {
    if (input.confirmation && (input.confirmation.snapshot?.planSubject ?? null) !== (options.planSubject ?? null)) {
      throw new Error('MODEL_PLAN_STALE')
    }
    const receipt = receiptFor('start', input)
    const previous = await library.operation(receipt.id, receipt)
    if (previous) return Promise.all(previous.map(id => library.job(id)))
    const priority = Number.isSafeInteger(options.priority) ? options.priority : await library.reserveJobPriority()
    const { rows } = await prepare(ids, input)
    if (!Array.isArray(input.bases) || input.bases.length !== rows.length) throw new Error('INVALID_INPUT')
    const bases = new Map(input.bases.map(base => [base?.id, base]))
    for (const row of rows) {
      const base = bases.get(row.id)
      if (!base || ['rev', 'rolesRev', 'editorialResultJob'].some(key => row[key] !== base[key])) throw new Error('VERSION_CONFLICT')
    }
    const listen = listenFields(input, rows.length)
    const wantsModel = !listen?.retake && rows.some(row => row.spec.clean || row.spec.cast)
    let selection
    if (input.confirmation) {
      const snapshot = verifyAiPlan(input.confirmation)
      if (!samePlan(snapshot.chapters, chapterFingerprint(rows)) || !samePlan(snapshot.options, optionSnapshot(input))) throw new Error('MODEL_PLAN_STALE')
      if (wantsModel) {
        try { selection = await resolvePluginModel(llm, input.selection, signal) }
        catch (error) {
          if (error?.message === 'MODEL_NOT_CONFIGURED' || error?.message === 'MODEL_REASONING_UNSUPPORTED') throw new Error('MODEL_PLAN_STALE')
          throw error
        }
        if (!samePlan(snapshot.selection, selectionSnapshot(selection, input.selection))) throw new Error('MODEL_PLAN_STALE')
      } else if (snapshot.requests !== 0) throw new Error('MODEL_PLAN_STALE')
    } else if (wantsModel) selection = await resolvePluginModel(llm, input.selection, signal)
    const narrator = rows.some(row => row.spec?.engine === 'laivox') ? await narratorSnapshot(signal) : null
    const entries = rows.map(({ id, rev, rolesRev, editorialResultJob, spec }) => {
      // A retake keeps the saved script as it is: no AI cleaning or scripting.
      const base = listen?.retake ? { ...spec, ...listen, clean: false, cast: false, reuse: true } : listen ? { ...spec, ...listen } : spec
      const frozen = freezeNarrator(base.clean || base.cast ? { ...base, selection } : base, narrator)
      return {
        id: randomUUID(), chapter: id, rev, rolesRev, editorialResultJob, session: options.session ?? null,
        spec: frozen,
      }
    })
    signal?.throwIfAborted()
    const result = await library.enqueue(entries, priority, receipt)
    if (!result.replay) {
      const { jobs, woke } = await resumeMatchedPaused(result.jobs, entries, priority)
      if (woke || jobs.some((job, index) => job.id === entries[index].id)) await prefer(priority)
      return jobs
    }
    return result.jobs
  }

  function listenFields(input, count) {
    const hasFocus = input.focusStart !== undefined
    const hasOnly = input.only !== undefined
    // retake: synthesize the parts of the range again even though they have audio
    // (the user did not like how they sound). Only for one range of one chapter.
    if (input.retake !== undefined && (input.retake !== true || !hasOnly)) throw new Error('INVALID_INPUT')
    if (!hasFocus && !hasOnly) return null
    if (count !== 1) throw new Error('INVALID_INPUT')
    const extra = {}
    if (hasFocus) {
      if (!Number.isSafeInteger(input.focusStart) || input.focusStart < 0) throw new Error('INVALID_INPUT')
      extra.focusStart = input.focusStart
    }
    if (hasOnly) {
      const start = input.only?.start
      const end = input.only?.end
      if (!input.only || typeof input.only !== 'object' || Array.isArray(input.only) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new Error('INVALID_INPUT')
      extra.only = { start, end }
    }
    if (input.retake === true) extra.retake = true
    return extra
  }

  function liveFlight(id) {
    const active = flight?.job.id === id ? flight : null
    return active && !active.committing && !active.controller.signal.aborted ? active : null
  }

  // The claim writes `running` before `flight` exists. A conditional write that
  // loses that race waits for the flight instead of treating the job as idle.
  async function whenRunning(id, apply) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const active = liveFlight(id)
      if (active) return apply(active)
      await delay(25)
    }
    return false
  }

  async function writeAim(id, start) {
    const apply = async active => {
      active.job.progress.aim = start
      const index = (active.job.progress.parts ?? []).findIndex(part => part.end > start)
      if (index >= 0) focusByJob.set(id, index)
      await library.checkpoint(id, 'running', active.job.progress)
      return true
    }
    const active = liveFlight(id)
    if (active) { await apply(active); return }
    const job = await library.job(id)
    if (!job) throw new Error('JOB_NOT_FOUND')
    if (!['queued', 'paused'].includes(job.state)) throw new Error('JOB_STATE_CHANGED')
    job.progress.aim = start
    if (await library.checkpointIf(id, job.state, job.progress)) return
    if (await whenRunning(id, apply)) return
    throw new Error('JOB_STATE_CHANGED')
  }

  // "Finish with Edge": mark the paused LaiVox job, then continue it as usual.
  async function markFillEdge(id) {
    const job = await library.job(id)
    if (!job) throw new Error('JOB_NOT_FOUND')
    if (job.spec?.engine !== 'laivox' || job.spec?.purpose !== 'generate' || job.spec?.retake) throw new Error('INVALID_INPUT')
    if (job.state !== 'paused') throw new Error('JOB_STATE_CHANGED')
    if (!job.progress?.fill) await library.markFill(id, { time: Date.now() })
  }

  async function performAction(id, action, start, batchPriority) {
    if (action === 'fill-edge') {
      if (start !== undefined) throw new Error('INVALID_INPUT')
      await markFillEdge(id)
      action = 'resume'
    }
    if (!['pause', 'cancel', 'resume'].includes(action)) throw new Error('INVALID_INPUT')
    if (start !== undefined && (action !== 'resume' || !Number.isSafeInteger(start) || start < 0)) throw new Error('INVALID_INPUT')
    if (start !== undefined) await writeAim(id, start)
    // A user decision always wins over the automatic schedule.
    forgetAutoResume(id)
    const target = { pause: 'paused', cancel: 'cancelled', resume: 'queued' }[action]
    const priority = action === 'resume' ? batchPriority ?? await library.reserveJobPriority() : null
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await library.job(id)
      if (!job) throw new Error('JOB_NOT_FOUND')
      if (job.state === target || (action === 'resume' && job.state === 'running')) return job
      if (job.state === 'running' && action !== 'resume') {
        const active = flight ?? await claiming
        if (active?.job.id !== id) continue
        if (!active.committing && !active.controller.signal.aborted) {
          active.controller.abort(new Error(action === 'cancel' ? 'JOB_CANCELLED' : 'JOB_PAUSED'))
        }
        const { row, error } = await active.settled
        if (error) throw error
        // Cancel may follow a concurrent pause and can still apply to the paused row.
        if (action === 'cancel' && row.state === 'paused') continue
        return row
      }
      const allowed = (job.state === 'queued' && action !== 'resume') || (job.state === 'paused' && action !== 'pause')
      if (!allowed) throw new Error('JOB_STATE_CHANGED')
      try {
        const row = await library.transition(id, job.state, target, priority)
        if (action === 'resume' && batchPriority === undefined) await prefer(row.priority)
        return row
      } catch (error) {
        if (error.message !== 'JOB_STATE_CHANGED') throw error
      }
    }
    throw new Error('JOB_STATE_CHANGED')
  }

  const bulkStates = { pause: ['queued', 'running'], resume: ['paused'], cancel: ['queued', 'running', 'paused'] }

  async function bulkTargets(mode, scope, ids) {
    if (!Object.hasOwn(bulkStates, mode)) throw new Error('INVALID_INPUT')
    if (scope !== undefined && scope !== null) {
      if (typeof scope !== 'object' || Array.isArray(scope)) throw new Error('INVALID_INPUT')
      if (Object.keys(scope).some(key => !['book', 'chapter', 'state'].includes(key))) throw new Error('INVALID_INPUT')
      if (scope.book != null && (typeof scope.book !== 'string' || !scope.book)) throw new Error('INVALID_INPUT')
      if (scope.chapter != null && (typeof scope.chapter !== 'string' || !scope.chapter)) throw new Error('INVALID_INPUT')
      if (scope.state != null && !['queued', 'paused', 'running'].includes(scope.state)) throw new Error('INVALID_INPUT')
    }
    const states = scope?.state ? bulkStates[mode].filter(state => state === scope.state) : bulkStates[mode]
    return states.length ? library.bulkIds({ book: scope?.book ?? undefined, chapter: scope?.chapter ?? undefined, states, ids }) : []
  }

  async function bulk(mode, scope, confirmed) {
    if (confirmed !== undefined && (!Array.isArray(confirmed) || confirmed.length > 1000 ||
        confirmed.some(id => typeof id !== 'string' || !id) || new Set(confirmed).size !== confirmed.length)) {
      throw new Error('INVALID_INPUT')
    }
    const ids = await bulkTargets(mode, scope, confirmed)
    let priority
    if (mode === 'resume' && ids.length) {
      const { used, limit } = await library.space()
      if (used >= limit) throw new Error('AUDIO_LIMIT')
      priority = await library.reserveJobPriority()
    }
    const errors = {}
    let applied = 0
    let skipped = confirmed ? confirmed.length - ids.length : 0
    let failed = 0
    let resumed = false
    for (const id of ids) {
      try {
        const row = await performAction(id, mode, undefined, priority)
        if (mode === 'resume' && row.state === 'queued' && row.priority === priority) resumed = true
        applied++
      } catch (error) {
        if (['JOB_STATE_CHANGED', 'JOB_NOT_FOUND'].includes(error.message)) { skipped++; continue }
        failed++
        const code = errorCode(error)
        errors[code] = (errors[code] ?? 0) + 1
      }
    }
    // Resume the whole group at one priority. Only preempt after it is queued,
    // so its own jobs never interrupt each other.
    if (resumed) await prefer(priority)
    return { matched: confirmed?.length ?? ids.length, applied, skipped, failed, errors }
  }

  async function cancelForBook(book) {
    if (typeof book !== 'string' || !book) throw new Error('INVALID_INPUT')
    const ids = await library.activeJobsForBook(book)
    let cancelled = 0
    for (const id of ids) {
      try {
        await performAction(id, 'cancel')
        cancelled++
      } catch (error) {
        // The job may have finished or changed state between the scan and the action.
        if (error.message === 'JOB_NOT_FOUND' || error.message === 'JOB_STATE_CHANGED') continue
        throw error
      }
    }
    return cancelled
  }

  return {
    kick,
    prepare,
    enqueuePrepared,
    bulkTargets,
    cancelForBook,
    async enqueue(ids, input, signal) {
      if (input.mode !== undefined || input.operationId !== undefined) return enqueuePrepared(ids, input, signal)
      if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Error('INVALID_INPUT')
      // Model validation can finish out of order across submissions.
      const priority = await library.reserveJobPriority()
      const spec = await normalize(input)
      const chapters = []
      for (const id of new Set(ids)) {
        const chapter = await library.chapterHeader(id)
        if (!chapter) throw new Error('CHAPTER_NOT_FOUND')
        chapters.push(chapter)
      }
      return enqueue(chapters, spec, null, priority, signal)
    },
    async submitText(title, text, input, session, proposal, resolvedSelection) {
      const priority = await library.reserveJobPriority()
      const spec = await normalize(input, resolvedSelection)
      const snapshot = spec.engine === 'laivox' ? await narratorSnapshot() : null
      const job = await library.createChatJob({ proposal, session, title, text, spec: freezeNarrator(spec, snapshot), priority })
      await prefer(job.priority)
      return job
    },
    action: performAction,
    bulk,
    // Synthesize the running job from part n onwards next. Returns false when
    // the job is not the one running, so a stale request never steers a later run.
    focus(id, n) {
      if (!flight || flight.job.id !== id || flight.committing || flight.controller.signal.aborted) return false
      focusByJob.set(id, n)
      return true
    },
    // Fold another source range into the running, queued, or paused only-job.
    // A finished synthesis loop reports false so the caller can start a new job.
    async include(id, start, end) {
      if (typeof id !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) throw new Error('INVALID_INPUT')
      const apply = async active => {
        if (!active.job.spec?.only || synthesisByJob.get(id) === 'closed' || active.committing || active.controller.signal.aborted) return false
        const progress = active.job.progress
        progress.ranges = mergeRanges([...(progress.ranges ?? []), { start, end }])
        progress.aim = start
        const index = (progress.parts ?? []).findIndex(part => part.end > start)
        if (synthesisByJob.get(id) === 'open' && index >= 0) focusByJob.set(id, index)
        await library.checkpoint(id, 'running', progress)
        return true
      }
      const active = liveFlight(id)
      if (active) return apply(active)
      const job = await library.job(id)
      if (!job?.spec?.only || !['queued', 'paused'].includes(job.state)) return false
      job.progress.ranges = mergeRanges([...(job.progress.ranges ?? []), { start, end }])
      job.progress.aim = start
      if (await library.checkpointIf(id, job.state, job.progress)) return true
      const caught = await whenRunning(id, apply)
      return caught === false ? false : caught
    },
    async dispose() {
      closed = true
      clearTimeout(claimRetry)
      for (const record of autoResume.values()) clearAutoResumeTimer(record)
      autoResume.clear()
      flight?.controller.abort(new Error('PLUGIN_STOPPED'))
      await dispatcher
      await flight?.settled
    },
  }
}
