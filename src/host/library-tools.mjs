// AI library tools: the model can look up the shelf, add chapters, stage a
// workspace TXT/EPUB for import and propose a production batch. Reading and
// adding chapters (free, removable) happen at once; importing and producing
// wait for the user's click under the reply. Deleting is never offered.
import { randomBytes, randomUUID } from 'node:crypto'
import { basename, extname } from 'node:path'
import { checkedText, firstTitle } from './input.mjs'
import { fileKind, readWorkspaceFile } from './workspace-file.mjs'

export const ADD_TEXT_LIMIT = 20_000
export const PAGE = 30

// The model's standing instructions: short, static, no live state.
export const PROMPT_TEXT = [
  '## 小说配音（LaiVox）',
  '可把文字做成有声书：',
  '- laivox_library：查书架、章节与音频状态（只读）。',
  '- laivox_add_chapters：新建书或追加章节，一次最多 50 章、合计 2 万字。',
  '- 更长的文本（如爬取的整本小说）先写成工作区 .txt 文件，再用 laivox_import_file 导入。',
  '- laivox_make：为一本书生成制作单；AI 清洗或多角色会消耗 DSH 模型额度。',
  '- laivox_speak：用户要你"读给我听"时朗读。',
  '导入和制作要用户在你的回答下方点确认，你只需一句话提醒。不要替用户删除书或章节。',
].join('\n')
export const PROMPT_SECTION = { name: 'laivox:library-tools', order: 5100, interpolate: false, text: PROMPT_TEXT }

const sessionOf = agent => agent?.session?.id
const sessionImports = new Map()
const SESSION_IMPORTS = 10
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
          ? result.books.map(book => '《' + book.title + '》 book=' + book.id + ' · ' + book.chapters + ' 章 · 有音频 ' + book.withAudio + ' 章')
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
    description: '把当前工作目录里的一个 .txt、.epub 或文字型 .pdf 文件生成 LaiVox 导入预览（自动分章）。只暂存不入架：导入按钮显示在你的回答下方，由用户确认。path 可以是相对工作目录的路径；title 可改书名。',
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

  return { tools: [libraryTool, addTool, importTool, makeTool], confirmMake }
}
