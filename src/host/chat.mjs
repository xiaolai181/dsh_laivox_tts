import { createHash, randomBytes } from 'node:crypto'
import { CAST_WINDOW } from '../domain/ai.mjs'
import { castSegmentsFor, countAiBatches } from '../domain/ai-batch.mjs'
import { messageFor } from '../domain/messages.mjs'
import { AI_PLAN_VERSION, aiPlanCode, chapterFingerprint, optionSnapshot, samePlan, selectionSnapshot, signAiPlan, verifyAiPlan } from './ai-plan.mjs'
import { resolvePluginModel } from './editorial.mjs'
import { createLibraryTools, PROMPT_SECTION } from './library-tools.mjs'
import { checkedText, firstTitle } from './input.mjs'

// Text that goes through AI review is shown and edited in a card, so it keeps the
// tool's limit; longer material belongs in an attachment import.
export const PROPOSAL_TEXT_LIMIT = 20_000

function proposalSummary(text, { clean, cast, engine }) {
  const requests = countAiBatches({ text, clean: clean === true, cast: cast === true }).requests
  return { title: firstTitle(text), characters: text.length, requests, engine, clean: clean === true, cast: cast === true }
}

// What the conversation shows for a proposal. The text itself is only sent when
// asked for (the card's "adjust" panel), so session polls stay small.
export function proposalView({ id, state = 'pending', payload }, withText = false) {
  // A production batch (laivox_make): the book, how many chapters, how it is made.
  if (payload?.kind === 'make') {
    const chapters = Array.isArray(payload.chapters) ? payload.chapters.length : Number(payload.chapters) || 0
    return {
      id, state, kind: 'make', title: payload.bookTitle ?? '', book: payload.book ?? null, chapters,
      titles: Array.isArray(payload.titles) ? payload.titles.slice(0, 10) : [], characters: payload.characters ?? 0,
      mode: payload.mode ?? 'reading', clean: payload.clean === true, cast: Number(payload.cast) || 0, engine: payload.engine,
      requests: payload.requests ?? 0, maximum: payload.maximum ?? 0, selection: payload.selection ?? null,
      ...(typeof payload.job === 'string' ? { job: payload.job, chapter: payload.chapter ?? null } : {}),
    }
  }
  const text = typeof payload?.text === 'string' ? payload.text : ''
  const summary = text ? proposalSummary(text, payload) : {
    title: payload?.title ?? '', characters: payload?.characters ?? 0, requests: payload?.requests ?? 0,
    engine: payload?.engine, clean: payload?.clean === true, cast: payload?.cast === true,
  }
  return {
    id, state, ...summary, mode: payload?.mode ?? (summary.cast ? 'multi' : 'reading'), selection: payload?.selection ?? null,
    ...(withText && state === 'pending' ? { text } : {}),
    ...(typeof payload?.job === 'string' ? { job: payload.job, chapter: payload.chapter ?? null } : {}),
  }
}

function checkSelection(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['provider', 'model'].every(key => typeof value[key] === 'string' && value[key].length <= 256) ||
      Object.keys(value).some(key => !['provider', 'model', 'reasoningEffort'].includes(key)) ||
      (value.reasoningEffort != null && (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.length > 64))) throw new Error('INVALID_INPUT')
  return value
}

const sessionId = agent => agent?.session?.id
const SUBCOMMAND = /^(status|confirm)(?=\s|$|[。.,，!！?？])/iu

export function registerChat(ctx, { library, jobs, imports, errorCode, speech }) {
  // Filesystem and working directory are per-session providers: read them from
  // the agent's context first, then the plugin's (both optional).
  const service = name => agent => agent?.ctx?.get?.(name) ?? (typeof ctx.get === 'function' ? ctx.get(name) : undefined)
  const libraryTools = createLibraryTools({ library, jobs, imports, services: { fs: service('fs'), workingDirectory: service('workingDirectory') } })
  async function textPlan(payload, text, selection, signal, subject) {
    const clean = payload.clean === true
    const cast = payload.cast === true
    if (!clean && !cast) return { requests: 0, provisional: false, selection: null, confirmation: null, code: '' }
    const resolved = await resolvePluginModel(ctx.llm, selection, signal)
    const counts = countAiBatches({
      text, clean, cast, removed: [],
      castWindow: { chars: CAST_WINDOW, segments: castSegmentsFor(resolved) },
    })
    const snapshot = {
      v: AI_PLAN_VERSION, subject, chapters: [],
      options: optionSnapshot({ engine: payload.engine, mode: cast ? 'multi' : 'reading', purpose: 'generate', clean }),
      selection: selectionSnapshot(resolved, selection),
      requests: counts.requests, provisional: clean && cast,
      text: createHash('sha256').update(text).digest('hex'),
    }
    const confirmation = signAiPlan(snapshot)
    return {
      ...counts, provisional: clean && cast,
      selection: { ...snapshot.selection, name: resolved.name ?? resolved.model },
      confirmation, code: aiPlanCode(confirmation.proof),
    }
  }
  function planEcho(id, plan) {
    const selection = plan?.selection
    const effort = selection?.reasoningEffort
    const name = [selection?.name ?? selection?.model ?? '当前模型', selection?.provider,
      effort === 'off' ? '关闭思考' : effort ?? '跟随模型默认'].filter(Boolean).join(' · ')
    return '模型 ' + name + '，预计 ' + (plan?.requests ?? 0) + ' 次常规请求。请在输入框上方确认，或发送 /laivox confirm ' + id + ' ' + (plan?.code ?? '')
  }
  async function preview(id, session, options = {}, signal) {
    const proposal = await library.proposal(id, session)
    if (!proposal) throw new Error('PROPOSAL_NOT_FOUND')
    if (proposal.payload?.kind === 'make') {
      const plan = await jobs.prepare(proposal.payload.chapters, { ...proposal.payload.input, estimateAi: true }, signal, id)
      const bases = proposal.payload.input.bases
      if (!Array.isArray(bases) || !samePlan(chapterFingerprint(plan.rows), chapterFingerprint(bases))) {
        throw new Error('VERSION_CONFLICT')
      }
      const confirmation = plan.aiPlan?.confirmation ?? null
      return { kind: 'make', requests: plan.aiPlan?.requests ?? 0, provisional: plan.aiPlan?.provisional === true,
        selection: plan.aiPlan?.selection ?? null, confirmation, code: aiPlanCode(confirmation?.proof) }
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('INVALID_INPUT')
    const payload = proposal.payload
    const selection = options.selection === undefined ? payload.selection : checkSelection(options.selection)
    const text = checkedText(options.text ?? payload.text)
    const clean = options.clean ?? payload.clean === true
    const cast = options.cast ?? payload.cast === true
    return { kind: 'text', ...await textPlan({ ...payload, clean, cast }, text, selection, signal, id) }
  }
  // Only the reviewable fields can change at confirmation; engine and purpose
  // stay what the proposal was created with.
  async function confirm(id, session, options = {}) {
    const proposal = await library.proposal(id, session)
    if (!proposal) throw new Error('PROPOSAL_NOT_FOUND')
    // A production batch from laivox_make; older rows have no kind.
    if (proposal.payload?.kind === 'make') {
      try {
        let confirmation = options?.confirmation
        if (typeof options?.proofCode === 'string') {
          const plan = await preview(id, session, {}, undefined)
          if (plan.code !== options.proofCode.toLowerCase()) throw new Error('MODEL_PLAN_STALE')
          confirmation = plan.confirmation
        }
        return (await libraryTools.confirmMake(proposal, session, undefined, confirmation))[0]
      }
      catch (error) {
        if (error?.message === 'VERSION_CONFLICT' && !await library.proposal(id, session)) throw new Error('PROPOSAL_NOT_FOUND')
        throw error
      }
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) throw new Error('INVALID_INPUT')
    const payload = proposal.payload
    if (options.text !== undefined && typeof options.text !== 'string') throw new Error('INVALID_INPUT')
    for (const key of ['clean', 'cast']) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error('INVALID_INPUT')
    const selection = options.selection === undefined ? payload.selection : checkSelection(options.selection)
    const text = checkedText(options.text ?? payload.text)
    if (text.length > PROPOSAL_TEXT_LIMIT) throw new Error('PROPOSAL_TEXT_TOO_LONG')
    const clean = options.clean ?? payload.clean === true
    const cast = options.cast ?? payload.cast === true
    if ((clean || cast) && typeof options.proofCode === 'string') {
      const plan = await textPlan({ ...payload, clean, cast }, text, selection, undefined, id)
      if (plan.code !== options.proofCode.toLowerCase()) throw new Error('MODEL_PLAN_STALE')
      options = { ...options, confirmation: plan.confirmation }
    }
    let resolvedSelection
    if ((clean || cast) && options.confirmation) {
      const snapshot = verifyAiPlan(options.confirmation)
      if (snapshot.subject !== id) throw new Error('MODEL_PLAN_STALE')
      if (snapshot.text !== createHash('sha256').update(text).digest('hex')) throw new Error('MODEL_PLAN_STALE')
      let resolved
      try { resolved = await resolvePluginModel(ctx.llm, selection, undefined) }
      catch (error) {
        if (error?.message === 'MODEL_NOT_CONFIGURED' || error?.message === 'MODEL_REASONING_UNSUPPORTED') throw new Error('MODEL_PLAN_STALE')
        throw error
      }
      if (!samePlan(snapshot.selection, selectionSnapshot(resolved, selection))) throw new Error('MODEL_PLAN_STALE')
      if (!samePlan(snapshot.options, optionSnapshot({
        engine: payload.engine, mode: cast ? 'multi' : 'reading', purpose: 'generate', clean,
      }))) throw new Error('MODEL_PLAN_STALE')
      resolvedSelection = resolved
    }
    try {
      return await jobs.submitText(firstTitle(text), text,
        { engine: payload.engine, purpose: 'generate', clean, cast, mode: cast ? 'multi' : 'reading', selection }, session, proposal, resolvedSelection)
    } catch (error) {
      // Two confirmations raced (card and dock, or two windows): the loser's
      // transaction fails its row check. Report it as already handled.
      if (error?.message === 'VERSION_CONFLICT' && !await library.proposal(id, session)) throw new Error('PROPOSAL_NOT_FOUND')
      throw error
    }
  }

  // Commands, tools and attachments are optional services: a profile without one
  // must still load the plugin. ctx.inject registers once the service exists and
  // withdraws the registration if it goes away; attachments are looked up per call.
  const attachmentService = () => (typeof ctx.get === 'function' ? ctx.get('attachments') : undefined) ?? ctx.attachments
  function withService(name, register) {
    if (typeof ctx.inject === 'function') ctx.inject([name], register)
    else if (ctx[name]) register(ctx)
  }

  withService('commands', sub => sub.commands.register({
    name: 'laivox',
    description: '小说配音（LaiVox）。粘贴正文朗读、导入 TXT/EPUB/PDF，或查看当前会话的进度。',
    input: { hint: '[--reading|--clean|--cast] 正文，或 status，或添加 TXT/EPUB/PDF 附件', attachments: true },
    recordInput: false,
    async handler({ rawInput, attachments = [], agent, signal }) {
      const session = sessionId(agent)
      try {
        if (!session) throw new Error('SESSION_REQUIRED')
        const input = String(rawInput ?? '').trim()
        const subcommand = !attachments.length && SUBCOMMAND.exec(input)
        if (subcommand) {
          // A mistyped subcommand must not be read aloud (and preempt running work).
          const word = subcommand[1].toLowerCase()
          const rest = input.slice(subcommand[0].length).trim().replace(/[。.,，!！?？]+$/u, '').trim()
          if (word === 'status') {
            if (rest) throw new Error('COMMAND_USAGE')
            const recent = (await library.jobs(session)).slice(0, 3)
            return { kind: 'success', text: recent.length ? recent.map(job => job.title + ' · ' + ({
              completed: '已完成', running: '生成中', queued: '排队中', paused: '已暂停', cancelled: '已取消',
            }[job.state] ?? job.state)).join('\n') : '当前会话还没有小说配音（LaiVox）任务。' }
          }
          const pieces = rest.toLowerCase().split(/\s+/u).filter(Boolean)
          const id = pieces[0]
          const code = pieces[1]
          if (!/^[0-9a-f]{12}$/u.test(id ?? '') || (code && !/^[0-9a-f]{12}$/u.test(code))) throw new Error('COMMAND_USAGE')
          const proposal = await library.proposal(id, session)
          if (!proposal) throw new Error('PROPOSAL_NOT_FOUND')
          const payload = proposal.payload ?? {}
          const usesModel = payload.kind === 'make' ? payload.clean === true || Number(payload.cast) > 0 : payload.clean === true || payload.cast === true
          if (usesModel && !code) return { kind: 'success', text: planEcho(id, await preview(id, session, {}, signal)) }
          try { await confirm(id, session, code ? { proofCode: code } : undefined) }
          catch (error) {
            if (error?.message !== 'MODEL_PLAN_STALE') throw error
            return { kind: 'success', text: planEcho(id, await preview(id, session, {}, signal)) }
          }
          return { kind: 'success', text: '已加入小说配音（LaiVox）队列。在输入框上方查看进度。' }
        }
        if (attachments.length) {
          if (attachments.length !== 1 || attachments[0]?.type !== 'file') throw new Error('IMPORT_ONE_FILE')
          if (input) throw new Error('IMPORT_WITH_TEXT')
          const ref = attachments[0].attachment
          const service = attachmentService()
          if (!service?.readFileStream) throw new Error('ATTACHMENTS_UNAVAILABLE')
          const preview = await imports.stage(ref.name ?? ref.filename ?? '', service.readFileStream(ref, signal), session, signal)
          return { kind: 'success', text: '已读取《' + preview.title + '》。在输入框上方打开预览后导入。' }
        }
        let content = input
        const values = (await library.settings()).values
        const options = { engine: values.engine, clean: values.clean, cast: values.mode === 'multi', selection: values.selection }
        let reading = false
        let cast = false
        for (let flag; (flag = /^--(clean|cast|reading)(?:\s+|$)/u.exec(content));) {
          if (flag[1] === 'clean') options.clean = true
          if (flag[1] === 'cast') cast = true
          if (flag[1] === 'reading') reading = true
          content = content.slice(flag[0].length)
        }
        if (reading && cast) throw new Error('COMMAND_FLAGS_CONFLICT')
        if (reading) options.cast = false
        if (cast) options.cast = true
        if (!content.trim()) throw new Error('COMMAND_USAGE')
        const text = checkedText(content)
        options.mode = options.cast ? 'multi' : 'reading'
        if (options.clean || options.cast) {
          // The command cannot open a modal, so AI work goes through a proposal
          // that is confirmed in the dock before anything is sent to the model.
          if (text.length > PROPOSAL_TEXT_LIMIT) throw new Error('PROPOSAL_TEXT_TOO_LONG')
          const id = randomBytes(6).toString('hex')
          if ((await library.proposals(session)).length >= 10) throw new Error('PROPOSAL_LIMIT')
          await library.propose(id, session, { text, clean: options.clean, cast: options.cast === true, engine: options.engine, mode: options.mode, selection: options.selection })
          const plan = await textPlan({ clean: options.clean, cast: options.cast === true, engine: options.engine }, text, options.selection, signal, id)
          return { kind: 'success', text: '已创建待确认任务 ' + id + '。' + planEcho(id, plan) }
        }
        await jobs.submitText(firstTitle(text), text, options, session)
        return { kind: 'success', text: '已加入小说配音（LaiVox）队列。在输入框上方查看进度。' }
      } catch (error) {
        const code = errorCode(error)
        return { kind: 'error', text: 'LaiVox · ' + (messageFor(code) ?? code) }
      }
    },
  }))

  withService('tools', sub => sub.tools.register({
    name: 'laivox_propose',
    description: '仅在用户明确要求朗读或生成小说配音（LaiVox）时，创建一个待用户审核的 LaiVox 提案。传入用户指定的原文，保持原样，不要改写。创建提案不会开始合成；摘要和确认按钮会显示在你的回答下方，成功后只用一句话告诉用户去确认。一次只创建一个提案。对长文或附件提示用户用 /laivox。',
    parameters: {
      type: 'object', required: ['text'], additionalProperties: false,
      properties: { text: { type: 'string', maxLength: PROPOSAL_TEXT_LIMIT }, clean: { type: 'boolean' }, cast: { type: 'boolean' } },
    },
    output: {
      schema: {
        type: 'object', required: ['id'], additionalProperties: false,
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, characters: { type: 'integer' }, requests: { type: 'integer' },
          engine: { type: 'string' }, clean: { type: 'boolean' }, cast: { type: 'boolean' }, state: { type: 'string' },
        },
      },
      render(_args, result) {
        // The card parses the start of this sentence (older cards depend on it), so
        // only the closing instruction may change.
        const engine = result.engine === 'laivox' ? 'LaiVox' : 'Edge'
        const detail = result.title ? '《' + result.title + '》· ' + result.characters + ' 字 · 预计 ' + result.requests + ' 次请求 · ' + engine
          + (result.clean ? ' · AI 清洗' : '') + (result.cast ? ' · AI 编剧' : ' · 单人朗读') + '。' : ''
        // The user already sees all of this (and the buttons) right under the reply,
        // so the model is asked for one sentence, not a recap.
        return [{ type: 'text', text: '已创建待确认提案 ' + result.id + '。' + detail
          + '以上信息和确认按钮已显示在你的回答下方。回复用户时只用一句话说明已建好、请在下方确认；不要复述编号、字数、请求数或命令，也不要附加使用提醒。' }]
      },
    },
    async execute(args, { agent, signal }) {
      signal.throwIfAborted()
      const session = sessionId(agent)
      if (!session) throw new Error('SESSION_REQUIRED')
      if ((await library.proposals(session)).length >= 10) throw new Error('PROPOSAL_LIMIT')
      if (typeof args?.text !== 'string' || args.text.length > PROPOSAL_TEXT_LIMIT) throw new Error('TEXT_TOO_LONG')
      const values = (await library.settings()).values
      const text = checkedText(args.text)
      const clean = args.clean ?? values.clean
      const cast = args.cast ?? (values.mode === 'multi')
      const id = randomBytes(6).toString('hex')
      await library.propose(id, session, {
        text, clean, cast, engine: values.engine, mode: cast ? 'multi' : 'reading', selection: values.selection,
      })
      return { id, state: 'pending', ...proposalSummary(text, { clean, cast, engine: values.engine }) }
    },
  }))
  // Library tools and their standing instructions. Without the prompt
  // service the tools still work; the instructions are simply absent.
  withService('tools', sub => { for (const tool of libraryTools.tools) sub.tools.register(tool) })
  withService('systemPrompt', sub => sub.systemPrompt.section(PROMPT_SECTION))

  // Instant speech: read a text aloud in the user's chat page with Edge.
  // It returns as soon as the speech channel accepts the text; the page plays it.
  if (speech) withService('tools', sub => sub.tools.register({
    name: 'laivox_speak',
    description: '仅在用户要求"读给我听""用语音回答""朗读这段"时调用：用 Edge 在线语音在用户界面里朗读一段文字。传入要读的文字（可以是你的回答正文）。成功即已开始朗读，不要再把全文写一遍，只用一句话告诉用户正在朗读。voice 只在用户点名音色时传。',
    parameters: {
      type: 'object', required: ['text'], additionalProperties: false,
      properties: { text: { type: 'string', minLength: 1, maxLength: 20000 }, voice: { type: 'string', maxLength: 64 } },
    },
    output: {
      schema: {
        type: 'object', required: ['speechId'], additionalProperties: false,
        properties: { speechId: { type: 'string' }, parts: { type: 'integer' }, characters: { type: 'integer' }, voice: { type: 'string' }, truncated: { type: 'boolean' } },
      },
      render(_args, result) {
        // The tool card reads the id and the part count from the start of this sentence.
        return [{ type: 'text', text: '已开始朗读 ' + result.speechId + ' · ' + result.parts + ' 段 · ' + result.characters + ' 字'
          + (result.truncated ? ' · 只读前 20,000 字' : '') + '。朗读在用户界面进行。回复用户时只用一句话说明正在朗读，不要再写出朗读的全文。' }]
      },
    },
    async execute(args, { agent, signal }) {
      signal.throwIfAborted()
      const session = sessionId(agent)
      if (!session) throw new Error('SESSION_REQUIRED')
      if (typeof args?.text !== 'string' || !args.text.trim() || args.text.length > 20000) throw new Error('INVALID_INPUT')
      if (args.voice != null && typeof args.voice !== 'string') throw new Error('INVALID_INPUT')
      return speech.start({ text: args.text, voice: args.voice ?? undefined, session, announce: true }).then(({ speechId, parts, characters, voice, truncated }) =>
        ({ speechId, parts, characters, voice, truncated }))
    },
  }))
  return { confirm, preview }
}
