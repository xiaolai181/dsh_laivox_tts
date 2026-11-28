// AI library tools: the model can look up the shelf, add chapters, stage a
// workspace TXT/EPUB for import and propose a production batch. Reading and
// adding chapters (free, removable) happen at once; importing and producing
// wait for the user's click under the reply. Deleting is never offered.
import { randomBytes, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { checkedText, firstTitle } from './input.mjs'
import { fileKind, readWorkspaceFile } from './workspace-file.mjs'
import { planBookExport } from './media.mjs'

export const ADD_TEXT_LIMIT = 20_000
export const PAGE = 30

// The model's standing instructions: short, static, no live state.
export const PROMPT_TEXT = [
  '## 小说配音（LaiVox）',
  '- 书架制作：laivox_library、laivox_add_chapters（≤2万字）、laivox_import_file、laivox_make、laivox_export、laivox_speak。',
  '- 伴读批注：laivox_reading_context（防剧透）、laivox_search_book、laivox_goto、laivox_notes、laivox_add_note。',
  '导入与制作需确认。禁止替用户删除书、章或批注。',
].join('\n')
export const PROMPT_SECTION = { name: 'laivox:library-tools', order: 5100, interpolate: false, text: PROMPT_TEXT }

const sessionOf = agent => agent?.session?.id
const sessionImports = new Map()
const sessionNotes = new Map()
const SESSION_IMPORTS = 10
const SESSION_NOTES = 30
const SESSION_WINDOW = 60 * 60 * 1000
function noteSessionImport(session) {
  const key = session || ''
  const now = Date.now()
  const row = sessionImports.get(key)
  const fresh = row && now - row.at < SESSION_WINDOW ? row : null
  if (fresh && fresh.count >= SESSION_IMPORTS) {
    throw Object.assign(new Error('SESSION_CHAPTER_LIMIT'), { detail: '本会话已多次导入，请改用 /laivox 导入或在工作台操作' })
  }
  sessionImports.set(key, { count: (fresh?.count ?? 0) + 1, at: fresh?.at ?? now })
}
function noteSessionAddNote(session) {
  const key = session || ''
  const now = Date.now()
  const row = sessionNotes.get(key)
  const fresh = row && now - row.at < SESSION_WINDOW ? row : null
  if (fresh && fresh.count >= SESSION_NOTES) {
    throw new Error('NOTES_RATE_LIMIT')
  }
  sessionNotes.set(key, { count: (fresh?.count ?? 0) + 1, at: fresh?.at ?? now })
}
const offsetOf = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0
const queryOf = value => typeof value === 'string' ? value.trim().slice(0, 180) : ''

export function createLibraryTools({ library, jobs, imports, services = {} }) {
  async function shelf(book) {
    if (typeof book !== 'string' || !book) throw new Error('INVALID_INPUT')
    const row = await library.shelfBook(book)
    if (!row) throw new Error('BOOK_NOT_FOUND')
    return row
  }

  const libraryTool = {
    name: 'laivox_library',
    description: '查看 LaiVox 书架（只读）。不传 book：列出书（标题、章数、有音频的章数）。传 book：列出该书章节（音频 none/partial/complete，任务状态）。每页 30 条，可用 q 按标题搜索、offset 翻页。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { book: { type: 'string', maxLength: 64 }, q: { type: 'string', maxLength: 180 }, offset: { type: 'integer', minimum: 0, maximum: 100000 } },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, required: ['total', 'offset'], properties: { total: { type: 'integer' }, offset: { type: 'integer' } } },
      render(_args, result) {
        const lines = result.books
          ? result.books.map(book => '《' + book.title + '》 book=' + book.id + ' · ' + book.chapters + ' 章 · 有音频 ' + book.withAudio + ' 章'
            + (book.currentOrdinal ? ' · 已听第 ' + book.currentOrdinal + ' 章（' + (book.percent ?? 0) + '%）' : ''))
          : result.chapters.map(chapter => chapter.ordinal + '. ' + chapter.title + ' chapter=' + chapter.id + ' · ' + chapter.characters + ' 字 · 音频 ' + chapter.audio
            + (chapter.job ? ' · 任务 ' + chapter.job : ''))
        const head = (result.books ? '书架' : '《' + result.bookTitle + '》的章节') + '：共 ' + result.total + ' 条，本页从第 ' + (result.offset + 1) + ' 条起。'
        return [{ type: 'text', text: [head, ...lines].join('\n') || head }]
      },
    },
    async execute(args, { signal }) {
      signal.throwIfAborted()
      const offset = offsetOf(args?.offset)
      const q = queryOf(args?.q)
      if (args?.book == null) return { ...await library.toolBooks(offset, q), offset }
      const book = await shelf(args.book)
      return { book: book.id, bookTitle: book.title, ...await library.toolChapters(book.id, offset, q), offset }
    },
  }

  const addTool = {
    name: 'laivox_add_chapters',
    description: '向 LaiVox 书架新建一本书（给 bookTitle）或向已有书追加章节（给 book）。一次 1–50 章、正文合计不超过 20,000 字；同名且正文相同的章节会跳过。正文保持原样。更长的文本请写进工作区 .txt 文件后用 laivox_import_file。',
    parameters: {
      type: 'object', required: ['chapters'], additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 }, bookTitle: { type: 'string', minLength: 1, maxLength: 180 },
        chapters: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', required: ['text'], additionalProperties: false,
          properties: { title: { type: 'string', maxLength: 180 }, text: { type: 'string', minLength: 1 } } } },
      },
    },
    output: {
      schema: { type: 'object', required: ['book', 'added', 'skipped'], additionalProperties: false,
        properties: { book: { type: 'string' }, bookTitle: { type: 'string' }, added: { type: 'array', items: { type: 'string' } }, skipped: { type: 'integer' } } },
      // The card reads the book and the first chapter from the start of this sentence.
      render(_args, result) {
        return [{ type: 'text', text: '已添加 ' + result.added.length + ' 章 · book=' + result.book + ' · first=' + (result.added[0] ?? '-') + ' · 跳过 ' + result.skipped
          + ' 章 · 《' + result.bookTitle + '》。告诉用户已加入书架即可；要合成音频可再调用 laivox_make。' }]
      },
    },
    async execute(args, { agent, signal }) {
      signal.throwIfAborted()
      const hasBook = typeof args?.book === 'string' && args.book !== ''
      const hasTitle = typeof args?.bookTitle === 'string' && args.bookTitle.trim() !== ''
      if (hasBook === hasTitle) throw new Error('INVALID_INPUT')
      if (!Array.isArray(args.chapters) || !args.chapters.length || args.chapters.length > 50) throw new Error('INVALID_INPUT')
      // Every chapter is checked before anything is written.
      const chapters = args.chapters.map(chapter => {
        if (!chapter || typeof chapter !== 'object') throw new Error('INVALID_INPUT')
        const text = checkedText(chapter.text)
        if (chapter.title != null && typeof chapter.title !== 'string') throw new Error('INVALID_INPUT')
        const title = (typeof chapter.title === 'string' && chapter.title.trim() ? chapter.title.trim() : firstTitle(text)).slice(0, 180)
        return { title, text }
      })
      if (chapters.reduce((sum, chapter) => sum + chapter.text.length, 0) > ADD_TEXT_LIMIT) throw new Error('ADD_CHAPTERS_TOO_LONG')
      noteSessionImport(sessionOf(agent))
      return library.appendChapters(hasBook ? { book: args.book, chapters } : { bookTitle: args.bookTitle.trim().slice(0, 180), chapters })
    },
  }

  const importTool = {
    name: 'laivox_import_file',
    description: '把当前工作目录里的一个 .txt、.epub、文字型 .pdf、.md、.docx 或 .html 文件生成 LaiVox 导入预览（自动分章）。只暂存不入架：导入按钮显示在你的回答下方，由用户确认。path 可以是相对工作目录的路径；title 可改书名。',
    parameters: {
      type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 }, title: { type: 'string', maxLength: 180 } },
    },
    output: {
      schema: { type: 'object', required: ['importId'], additionalProperties: false,
        properties: { importId: { type: 'string' }, title: { type: 'string' }, chapters: { type: 'integer' }, characters: { type: 'integer' }, source: { type: 'string' } } },
      // The card reads the import id from the start of this sentence.
      render(_args, result) {
        return [{ type: 'text', text: '已生成导入预览 ' + result.importId + ' · ' + result.chapters + ' 章 · ' + result.characters + ' 字 · 《' + result.title
          + '》。导入按钮已显示在你的回答下方，只用一句话请用户确认导入，不要复述章节列表。' }]
      },
    },
    async execute(args, { agent, signal }) {
      signal.throwIfAborted()
      const session = sessionOf(agent)
      if (!session) throw new Error('SESSION_REQUIRED')
      if (typeof args?.path !== 'string' || !args.path.trim() || args.path.length > 1024) throw new Error('INVALID_INPUT')
      const path = args.path.trim()
      const format = extname(path).toLowerCase()
      if (!fileKind(path).importable) throw new Error('IMPORT_TYPE_INVALID')
      const fs = services.fs?.(agent)
      const workingDirectory = services.workingDirectory?.(agent)
      if (!fs || !workingDirectory) throw new Error('FILE_ACCESS_UNAVAILABLE')
      let cwd
      try { cwd = await workingDirectory.ensure(agent, signal) }
      catch (error) { throw error?.name === 'AbortError' ? error : new Error('FILE_ACCESS_UNAVAILABLE') }
      const bytes = await readWorkspaceFile({ fs, cwd, path, signal })
      const title = typeof args.title === 'string' ? args.title.replace(/[\\/:*?"<>|]/gu, ' ').trim().slice(0, 180) : ''
      const file = basename(path.replaceAll('\\', '/'))
      const stem = file.toLowerCase().endsWith(format) ? file.slice(0, file.length - format.length) : file
      const name = (title || stem) + format
      const preview = await imports.stage(name, [bytes], session, signal)
      const chapters = Array.isArray(preview.chapters) ? preview.chapters : []
      return { importId: preview.id, title: preview.title, chapters: chapters.length,
        characters: chapters.reduce((sum, chapter) => sum + (Number(chapter.count) || 0), 0), source: basename(path.replaceAll('\\', '/')) }
    },
  }

  const makeTool = {
    name: 'laivox_make',
    description: '为 LaiVox 书架上的一本书创建待用户确认的制作单（合成音频）。不给 chapters 时取全书，missingOnly 默认只取还没有完整音频的章；一次最多 500 章。mode 为 reading（单人朗读）或 multi（多角色），clean 为 AI 清洗；不传则用用户设置。AI 清洗和多角色会消耗 DSH 模型额度。确认按钮显示在你的回答下方。',
    parameters: {
      type: 'object', required: ['book'], additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 }, chapters: { type: 'array', minItems: 1, maxItems: 500, items: { type: 'string', maxLength: 64 } },
        missingOnly: { type: 'boolean' }, mode: { type: 'string', enum: ['reading', 'multi'] }, clean: { type: 'boolean' },
      },
    },
    output: {
      schema: { type: 'object', required: ['proposalId'], additionalProperties: false,
        properties: { proposalId: { type: 'string' }, chapters: { type: 'integer' }, mode: { type: 'string' }, clean: { type: 'boolean' }, requests: { type: 'integer' }, maximum: { type: 'integer' } } },
      // Same opening as laivox_propose, so the same card reads the id.
      render(_args, result) {
        return [{ type: 'text', text: '已创建待确认提案 ' + result.proposalId + '。制作单 · ' + result.chapters + ' 章 · ' + (result.mode === 'multi' ? '多角色' : '单人朗读')
          + (result.clean ? ' · AI 清洗' : '') + (result.requests ? ' · 预计 ' + result.requests + ' 次 AI 请求' : '')
          + '。确认按钮已显示在你的回答下方，只用一句话请用户确认；不要复述章节。' }]
      },
    },
    async execute(args, { agent, signal }) {
      signal.throwIfAborted()
      const session = sessionOf(agent)
      if (!session) throw new Error('SESSION_REQUIRED')
      const book = await shelf(args?.book)
      if ((await library.proposals(session)).length >= 10) throw new Error('PROPOSAL_LIMIT')
      let ids
      if (args.chapters != null) {
        if (!Array.isArray(args.chapters) || !args.chapters.length || args.chapters.length > 500 || args.chapters.some(id => typeof id !== 'string')) throw new Error('INVALID_INPUT')
        ids = [...new Set(args.chapters)]
        const inBook = await library.chaptersInBook(book.id, ids)
        if (ids.some(id => !inBook.has(id))) throw new Error('CHAPTER_NOT_FOUND')
      } else ids = await library.makeCandidates(book.id, args.missingOnly !== false)
      if (!ids.length) throw new Error('MAKE_NOTHING')
      for (const key of ['clean', 'missingOnly']) if (args[key] != null && typeof args[key] !== 'boolean') throw new Error('INVALID_INPUT')
      if (args.mode != null && !['reading', 'multi'].includes(args.mode)) throw new Error('INVALID_INPUT')
      const values = (await library.settings()).values
      const base = { action: 'start', purpose: 'generate', engine: values.engine, mode: args.mode ?? values.mode, clean: args.clean ?? values.clean === true,
        selection: values.selection ?? null, operationId: randomUUID() }
      const plan = await jobs.prepare(ids, { ...base, estimateAi: true }, signal)
      const input = { ...base, bases: plan.rows.map(({ id, rev, rolesRev, editorialResultJob }) => ({ id, rev, rolesRev, editorialResultJob })) }
      const requests = plan.aiPlan?.requests ?? 0
      const id = randomBytes(6).toString('hex')
      await library.propose(id, session, {
        kind: 'make', book: book.id, bookTitle: book.title, chapters: plan.rows.map(row => row.id),
        titles: plan.rows.slice(0, 10).map(row => row.title), characters: plan.characters, mode: input.mode, clean: input.clean,
        cast: plan.cast, engine: input.engine, requests, maximum: requests, provisional: plan.aiPlan?.provisional === true,
        selection: plan.aiPlan?.selection ?? input.selection, input,
      })
      return { proposalId: id, chapters: plan.rows.length, mode: input.mode, clean: input.clean, requests, maximum: requests }
    },
  }

  // Confirming a make proposal: the same path as the workbench's "start", queued
  // last (priority 0) and tied to the conversation.
  async function confirmMake(proposal, session, signal, confirmation) {
    const { payload } = proposal
    const input = confirmation ? { ...payload.input, confirmation, planSubject: proposal.id } : payload.input
    const queued = await jobs.enqueuePrepared(payload.chapters, input, signal, { priority: 0, session, planSubject: proposal.id })
    const first = queued[0]
    const { input: _input, chapters, ...summary } = payload
    await library.acceptProposal(proposal.id, session, { ...summary, chapters: chapters.length, job: first?.id ?? null, chapter: first?.chapter ?? null })
    return queued
  }

  const exportTool = {
    name: 'laivox_export',
    description: '为 LaiVox 书架中已有音频的书籍（或指定章节范围）生成导出卡片，支持合并单文件 MP3 或分章 ZIP，以及附带说话人角色名的 SRT/LRC 字幕（只读，不消耗模型额度）。',
    parameters: {
      type: 'object',
      required: ['book'],
      additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 },
        from: { type: 'integer', minimum: 1, maximum: 5000 },
        to: { type: 'integer', minimum: 1, maximum: 5000 },
        format: { type: 'string', enum: ['mp3', 'wav'] },
        mode: { type: 'string', enum: ['zip', 'single'] },
        subtitles: { type: 'string', enum: ['none', 'srt', 'lrc', 'both'] },
        speakers: { type: 'boolean' },
      },
    },
    output: {
      schema: {
        type: 'object',
        required: ['book', 'title', 'readyCount', 'totalChapters', 'totalSeconds', 'params'],
        additionalProperties: false,
        properties: {
          book: { type: 'string' }, title: { type: 'string' }, readyCount: { type: 'integer' },
          skippedCount: { type: 'integer' }, skipped: { type: 'array' },
          totalChapters: { type: 'integer' }, totalSeconds: { type: 'integer' }, params: { type: 'string' },
        },
      },
      render(_args, result) {
        const mins = Math.max(1, Math.round((result.totalSeconds || 0) / 60))
        const skipNote = result.skippedCount ? `（已跳过 ${result.skippedCount} 章）` : ''
        return [{ type: 'text', text: `已生成导出单 · book=${result.book} · 《${result.title}》 · ${result.readyCount}/${result.totalChapters} 章 · 约 ${mins} 分钟 · params=${result.params}。${skipNote}下载按钮已显示在卡片中，只用一句话提示用户点击下载即可。` }]
      },
    },
    async execute(args, { signal }) {
      signal.throwIfAborted()
      const book = await shelf(args?.book)
      const from = Number.isSafeInteger(args?.from) ? args.from : null
      const to = Number.isSafeInteger(args?.to) ? args.to : null
      if (from !== null && to !== null && from > to) throw new Error('INVALID_INPUT')
      const format = args?.format === 'wav' ? 'wav' : 'mp3'
      const mode = args?.mode === 'single' ? 'single' : 'zip'
      const subtitles = ['none', 'srt', 'lrc', 'both'].includes(args?.subtitles) ? args.subtitles : 'srt'
      const speakers = args?.speakers !== false
      const plan = await planBookExport(library, book.id, format, signal, { from, to, requireSameFormat: mode === 'single' })
      if (!plan.ready.length) {
        throw Object.assign(new Error('AUDIO_INCOMPLETE'), {
          details: { ready: 0, total: plan.chapters.length, skipped: plan.skipped.slice(0, 10).map(item => ({ ordinal: item.row.ordinal, title: item.row.title, reason: item.reason })) },
        })
      }
      const query = new URLSearchParams({
        format, mode, subtitles, speakers: speakers ? '1' : '0',
        ...(from !== null ? { from: String(from) } : {}),
        ...(to !== null ? { to: String(to) } : {}),
      }).toString()
      return {
        book: book.id,
        title: plan.title,
        readyCount: plan.ready.length,
        skippedCount: plan.skipped.length,
        skipped: plan.skipped.slice(0, 10).map(item => ({ ordinal: item.row.ordinal, title: item.row.title, reason: item.reason })),
        totalChapters: plan.chapters.length,
        totalSeconds: Math.round(plan.totalSeconds),
        params: query,
      }
    },
  }

  const readingContextTool = {
    name: 'laivox_reading_context',
    description: '获取用户最近在听书籍或指定章节的前文与说话人角色上下文（只读）。默认严格防剧透，不返回当前收听进度之后的剧情；仅当用户明确要求剧透时设 allowSpoilers=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 },
        mode: { type: 'string', enum: ['recent', 'chapter'] },
        chapter: { type: 'string', maxLength: 180 },
        allowSpoilers: { type: 'boolean' },
        limit: { type: 'integer', minimum: 200, maximum: 12000 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['spoilerBlocked', 'book', 'bookTitle', 'chapter', 'chapterTitle', 'ordinal'],
        properties: {
          spoilerBlocked: { type: 'boolean' },
          book: { type: 'string' },
          bookTitle: { type: 'string' },
          chapter: { type: 'string' },
          chapterTitle: { type: 'string' },
          ordinal: { type: 'integer' },
        },
      },
      render(_args, result) {
        if (result.spoilerBlocked) {
          return [{ type: 'text', text: `《${result.bookTitle}》第 ${result.ordinal} 章《${result.chapterTitle}》尚未听到（当前在听第 ${result.progressOrdinal} 章，进度 ${result.percent ?? 0}%），已按防剧透模式拦截正文。除非用户明确要求剧透（allowSpoilers=true），请勿剧透后续情节。` }]
        }
        const roleSummary = Array.isArray(result.roles) && result.roles.length
          ? '角色档案：' + result.roles.map(r => `${r.name}${r.gender ? `(${r.gender}${r.age ? '/' + r.age : ''})` : ''}`).join('、')
          : '角色档案：暂无自定义角色'
        const linesSummary = Array.isArray(result.speakerLines) && result.speakerLines.length
          ? '台词标注：\n' + result.speakerLines.slice(-20).map(l => `[${l.speaker}${l.emotion && l.emotion !== 'neutral' ? '/' + l.emotion : ''}] ${l.text}`).join('\n')
          : ''
        const body = [
          `《${result.bookTitle}》第 ${result.ordinal} 章《${result.chapterTitle}》 · 收听进度 ${result.percent ?? 0}%${result.hasStarted ? '' : '（尚未开听，展示开篇节选）'}`,
          roleSummary,
          result.previousExcerpt ? '【上一章末尾】\n' + result.previousExcerpt : '',
          result.excerpt ? '【当前已听前文】\n' + result.excerpt : '【当前章节暂无可展示前文】',
          linesSummary,
        ].filter(Boolean).join('\n\n')
        return [{ type: 'text', text: body }]
      },
    },
    async execute(args, { signal }) {
      signal.throwIfAborted()
      const book = args?.book != null ? (await shelf(args.book)).id : undefined
      return library.chapterReadingContext({
        book,
        mode: args?.mode === 'chapter' ? 'chapter' : 'recent',
        chapter: typeof args?.chapter === 'string' ? args.chapter : undefined,
        allowSpoilers: args?.allowSpoilers === true,
        limit: Number.isSafeInteger(args?.limit) ? args.limit : 3000,
      })
    },
  }

  const searchBookTool = {
    name: 'laivox_search_book',
    description: '在书架书籍中检索关键词、或查找指定说话人角色的所有台词与出场章节（只读）。默认对超过当前收听进度的命中隐藏正文以防剧透，除非 allowSpoilers=true。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 },
        query: { type: 'string', maxLength: 180 },
        role: { type: 'string', maxLength: 64 },
        allowSpoilers: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 40 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['book', 'bookTitle', 'hits'],
        properties: {
          book: { type: 'string' },
          bookTitle: { type: 'string' },
          hits: { type: 'array' },
        },
      },
      render(args, result) {
        if (!result.hits.length) {
          return [{ type: 'text', text: `《${result.bookTitle}》中未检索到匹配内容。` }]
        }
        const allow = args?.allowSpoilers === true
        const rows = result.hits.map(hit => {
          const who = hit.speaker ? `（${hit.speaker}）` : ''
          const snippet = hit.aheadOfProgress && !allow ? '[尚未听到，已防剧透隐藏正文]' : hit.excerpt
          return `第 ${hit.ordinal} 章《${hit.chapterTitle}》${who}：${snippet}`
        })
        return [{ type: 'text', text: `《${result.bookTitle}》检索到 ${result.hits.length} 条命中：\n` + rows.join('\n') }]
      },
    },
    async execute(args, { signal }) {
      signal.throwIfAborted()
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      const roleName = typeof args?.role === 'string' ? args.role.trim() : ''
      if (!query && !roleName) throw new Error('INVALID_INPUT')
      const book = args?.book != null ? (await shelf(args.book)).id : undefined
      return library.searchBookContent({
        book,
        query,
        roleName,
        limit: Number.isSafeInteger(args?.limit) ? args.limit : 40,
        allowSpoilers: args?.allowSpoilers === true,
      })
    },
  }

  const gotoTool = {
    name: 'laivox_goto',
    description: '生成在工作台打开指定章节或句段位置的跳转卡片（纯只读定位，不修改播放进度，未合成音频的章节也可用；支持中文数字章号与关键词匹配）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 },
        chapter: { type: 'string', maxLength: 180 },
        query: { type: 'string', maxLength: 180 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['book', 'bookTitle', 'chapter', 'chapterTitle', 'ordinal', 'start', 'preview'],
        properties: {
          book: { type: 'string' },
          bookTitle: { type: 'string' },
          chapter: { type: 'string' },
          chapterTitle: { type: 'string' },
          ordinal: { type: 'integer' },
          start: { type: 'integer' },
          preview: { type: 'string' },
        },
      },
      render(_args, result) {
        return [{ type: 'text', text: `已定位跳转 · book=${result.book} · chapter=${result.chapter} · start=${result.start} · 第${result.ordinal}章 · 《${result.bookTitle}》 · ${result.chapterTitle} · 预览：${result.preview || '章节开头'}。打开按钮已显示在卡片中，请用一句话引导用户点击打开。` }]
      },
    },
    async execute(args, { signal }) {
      signal.throwIfAborted()
      const book = args?.book != null ? (await shelf(args.book)).id : undefined
      return library.locateChapterPosition({
        book,
        chapter: typeof args?.chapter === 'string' ? args.chapter : undefined,
        query: typeof args?.query === 'string' ? args.query : undefined,
      })
    },
  }

  const notesTool = {
    name: 'laivox_notes',
    description: '读取用户在 LaiVox 书架某本书中的听书批注与收藏金句（只读，绝不删改批注）。可用于总结读后感、复盘人物性格。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 },
        q: { type: 'string', maxLength: 180 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['notes', 'total'],
        properties: { notes: { type: 'array' }, total: { type: 'integer' } },
      },
      render(_args, result) {
        if (!result.notes.length) return [{ type: 'text', text: '这本书目前还没有保存的听书批注。' }]
        const lines = result.notes.map(n => `第 ${n.ordinal} 章《${n.chapterTitle}》${n.speaker ? `（${n.speaker}）` : ''}：> ${n.quote}${n.body ? `\n  笔记：${n.body}` : ''}`)
        return [{ type: 'text', text: `共 ${result.total} 条听书批注（展示 ${result.notes.length} 条）：\n` + lines.join('\n') }]
      },
    },
    async execute(args, { signal }) {
      signal.throwIfAborted()
      let bookId = args?.book ? (await shelf(args.book)).id : undefined
      if (!bookId) {
        const recent = await library.recentListeningBook?.()
        if (!recent) throw new Error('BOOK_NOT_FOUND')
        bookId = recent.id
      }
      return library.listNotes({
        book: bookId,
        q: typeof args?.q === 'string' ? args.q : undefined,
        limit: Number.isSafeInteger(args?.limit) ? args.limit : 30,
      })
    },
  }

  const addNoteTool = {
    name: 'laivox_add_note',
    description: '仅当用户明确要求“把这段记下来 / 记一条批注”时，将原句摘录与思考挂载保存到听书批注表（每会话每小时最多 30 条）。',
    parameters: {
      type: 'object',
      required: ['quote'],
      additionalProperties: false,
      properties: {
        book: { type: 'string', maxLength: 64 },
        chapter: { type: 'string', maxLength: 64 },
        quote: { type: 'string', minLength: 1, maxLength: 2000 },
        body: { type: 'string', maxLength: 4000 },
        speaker: { type: 'string', maxLength: 120 },
        partIndex: { type: 'integer', minimum: 0 },
        charOffset: { type: 'integer', minimum: 0 },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['id', 'book', 'chapter'],
        properties: { id: { type: 'string' }, book: { type: 'string' }, chapter: { type: 'string' } },
      },
      render(_args, result) {
        return [{ type: 'text', text: `已保存批注到《${result.bookTitle ?? ''}》第 ${result.ordinal ?? ''} 章《${result.chapterTitle ?? ''}》：${result.quote}` }]
      },
    },
    async execute(args, { agent, signal }) {
      signal.throwIfAborted()
      const bookId = args?.book ? (await shelf(args.book)).id : undefined
      let chapterId = typeof args?.chapter === 'string' && args.chapter.trim() ? args.chapter.trim() : undefined
      if (!chapterId) {
        const ctx = await library.chapterReadingContext({ book: bookId, allowSpoilers: true, limit: 200 })
        chapterId = ctx.chapter
      }
      noteSessionAddNote(sessionOf(agent))
      return library.saveNote({
        book: bookId,
        chapter: chapterId,
        quote: args?.quote,
        body: typeof args?.body === 'string' ? args.body : '',
        speaker: typeof args?.speaker === 'string' ? args.speaker : '',
        partIndex: Number.isSafeInteger(args?.partIndex) ? args.partIndex : 0,
        charOffset: Number.isSafeInteger(args?.charOffset) ? args.charOffset : 0,
      })
    },
  }

  return { tools: [libraryTool, addTool, importTool, makeTool, exportTool, readingContextTool, searchBookTool, gotoTool, notesTool, addNoteTool], confirmMake }
}
