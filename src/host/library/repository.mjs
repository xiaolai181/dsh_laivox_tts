import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { proposalSummary } from '../input.mjs'
import { VOICE_RULE_LATEST } from '../../domain/voice-assignment.mjs'
import { latestCompleteAudioJobSQL } from './complete-job-sql.mjs'
import { MAX_RESUBMITS } from '../../domain/production.mjs'

const parse = value => value ? JSON.parse(value) : null
const json = value => value == null ? null : JSON.stringify(value)
const sql = (sql, args = [], mode = 'run', expect) => ({ sql, args, mode, expect })
// Every new book uses the latest voice rule; only migrated legacy work keeps rule 1.
const newBook = (id, title, fingerprint, rule = VOICE_RULE_LATEST) => sql('INSERT INTO books(id,title,fingerprint,created,voice_rule) VALUES(?,?,?,?,?)', [id, title, fingerprint, Date.now(), rule])
const newChapter = (id, book, n, title, text) => sql('INSERT INTO chapters(id,book,ordinal,title,text,characters) VALUES(?,?,?,?,?,length(?))', [id, book, n, title, text, text])
const unpack = row => row && ({ ...row, spec: parse(row.spec), progress: parse(row.progress) })
export const AUDIO_LIMIT = 2 * 1024 ** 3
const titlePattern = value => '%' + value.replace(/[\\%_]/gu, '\\$&') + '%'
const jobProjection = `SELECT j.id,j.chapter,j.rev,j.session,j.state,j.created,c.title,b.title bookTitle,
  EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) isSnippet,
  json_object('engine',json_extract(j.spec,'$.engine'),'purpose',json_extract(j.spec,'$.purpose'),'mode',json_extract(j.spec,'$.mode')) spec,
  json_object('stage',json_extract(j.progress,'$.stage'),'error',json_extract(j.progress,'$.error'),
    'pauseReason',json_extract(j.progress,'$.pauseReason'),
    'yieldWait',json_extract(j.progress,'$.yieldWait'),'retryAfter',json_extract(j.progress,'$.retryAfter'),
    'total',coalesce(json_array_length(j.progress,'$.parts'),0),
    'cleanTotal',json_extract(j.progress,'$.cleanTotal'),'cleanDone',json_array_length(j.progress,'$.clean'),
    'castTotal',json_extract(j.progress,'$.castTotal'),'castDone',json_array_length(j.progress,'$.cast'),
    'autoResume',json_extract(j.progress,'$.autoResume'),'aiRequests',json_extract(j.progress,'$.aiRequests'),'aiChars',json_extract(j.progress,'$.aiChars'),
    'aiTokens',json_extract(j.progress,'$.aiTokens'),
    'synthesisDone',CASE WHEN json_extract(j.progress,'$.stage')='synthesizing' AND j.state IN ('running','paused','queued') THEN
      (SELECT count(*) FROM json_each(j.progress,'$.parts') part
      JOIN audio a ON a.chapter=j.chapter AND a.key=json_extract(part.value,'$.key')) END) progress
  FROM jobs j JOIN chapters c ON c.id=j.chapter JOIN books b ON b.id=c.book`
const sessionJobProjection = jobProjection.replace(
  "'error',json_extract(j.progress,'$.error'),",
  "'error',json_extract(j.progress,'$.error'),'errorDetail',substr(json_extract(j.progress,'$.errorDetail'),1,600),",
).replace(
  ' FROM jobs j ',
  ", (SELECT id FROM chapters WHERE book=c.book AND ordinal>c.ordinal ORDER BY ordinal LIMIT 1) nextId FROM jobs j ",
)
const jobsOrder = `ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'paused' THEN 1 WHEN 'queued' THEN 2 ELSE 3 END,
  CASE WHEN j.state='queued' THEN j.priority END DESC,
  CASE WHEN j.state='queued' THEN j.created END, CASE WHEN j.state='queued' THEN j.rowid END,
  j.created DESC,j.rowid DESC`
const header = `SELECT c.id,c.book,c.rev,c.title,c.playback,c.playback_rev playbackRev,b.roles_rev rolesRev,b.voice_rule voiceRule,b.title bookTitle,
  EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) isSnippet,
  json_extract(c.editorial,'$.resultJob') editorialResultJob,
  (SELECT id FROM chapters WHERE book=c.book AND ordinal>c.ordinal ORDER BY ordinal LIMIT 1) nextId
  FROM chapters c JOIN books b ON b.id=c.book`

export async function openLibrary(root, { audioLimit: initialAudioLimit = AUDIO_LIMIT } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  let audioLimit = initialAudioLimit
  const worker = new Worker(new URL('./database-worker.mjs', import.meta.url), {
    workerData: join(root, 'library.sqlite'),
    env: {},
    // Batch estimates create short-lived V8 and ICU objects for many chapters.
    // Collect them sooner without limiting the worker's long-lived data.
    resourceLimits: { maxYoungGenerationSizeMb: 16 },
  })
  const pending = new Map()
  let sequence = 0
  let failure
  const stop = error => {
    failure = error
    for (const item of pending.values()) item.reject(error)
    pending.clear()
  }
  worker.on('error', stop)
  worker.on('exit', () => stop(new Error('LIBRARY_CLOSED')))
  await new Promise((resolve, reject) => {
    worker.once('error', reject)
    worker.once('message', resolve)
  })
  worker.on('message', ({ id, value, error, details }) => {
    const item = pending.get(id)
    pending.delete(id)
    if (error) item?.reject(Object.assign(new Error(error), { details }))
    else item?.resolve(value)
  })
  function execute(statements, transaction = false, close = false, extra = {}) {
    if (failure) return Promise.reject(failure)
    return new Promise((resolve, reject) => {
      const id = sequence++
      pending.set(id, { resolve, reject })
      worker.postMessage({ id, statements, transaction, close, ...extra })
    })
  }
  const query = async (mode, text, args) => (await execute([sql(text, args, mode)]))[0]
  const get = (text, ...args) => query('get', text, args)
  const all = (text, ...args) => query('all', text, args)
  const run = (text, ...args) => query('run', text, args)
  const tx = commands => execute(commands, true)
  const command = (command, args, transaction = false, receipt) => execute([], transaction, false, { command, args, receipt })

  await execute([], false, false, { command: 'configureAudioLimit', args: { bytes: audioLimit } })

  return {
    close: () => execute([], false, true),
    books: (offset = 0, q = '') => all(`SELECT b.id,b.title,
      (SELECT count(*) FROM chapters WHERE book=b.id) chapters,
      (SELECT coalesce(sum(a.bytes),0) FROM audio a JOIN chapters c ON c.id=a.chapter WHERE c.book=b.id) audioBytes
      FROM books b WHERE NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)
      AND b.title LIKE ? ESCAPE '\\' ORDER BY created DESC,id LIMIT 40 OFFSET ?`, titlePattern(q), offset),
    chapters: (book, offset = 0, q = '') => all(`SELECT id,ordinal,title,rev,characters,
      EXISTS(SELECT 1 FROM audio WHERE chapter=chapters.id) hasAudio,
      (SELECT j.state FROM jobs j WHERE j.chapter=chapters.id AND j.rev=chapters.rev
        ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
          CASE WHEN j.state='queued' THEN j.priority END DESC, j.created DESC,j.rowid DESC LIMIT 1) jobState,
      (SELECT json_extract(j.progress,'$.error') FROM jobs j WHERE j.chapter=chapters.id AND j.rev=chapters.rev
        ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
          CASE WHEN j.state='queued' THEN j.priority END DESC, j.created DESC,j.rowid DESC LIMIT 1) jobError,
      (SELECT json_extract(j.progress,'$.laivoxPause') FROM jobs j WHERE j.chapter=chapters.id AND j.rev=chapters.rev
        ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
          CASE WHEN j.state='queued' THEN j.priority END DESC, j.created DESC,j.rowid DESC LIMIT 1) jobPause,
      (SELECT json_extract(j.progress,'$.autoResume') FROM jobs j WHERE j.chapter=chapters.id AND j.rev=chapters.rev
        ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
          CASE WHEN j.state='queued' THEN j.priority END DESC, j.created DESC,j.rowid DESC LIMIT 1) jobAutoResume
      FROM chapters WHERE book=? AND title LIKE ? ESCAPE '\\' ORDER BY ordinal LIMIT 80 OFFSET ?`, book, titlePattern(q), offset),
    async chapterIds(book) {
      if (typeof book !== 'string' || !book) throw new Error('INVALID_INPUT')
      const [rows, total] = await execute([
        sql('SELECT id FROM chapters WHERE book=? ORDER BY ordinal LIMIT 500', [book], 'all'),
        sql('SELECT count(*) total FROM chapters WHERE book=?', [book], 'get'),
      ], 'read')
      return { ids: rows.map(row => row.id), total: total?.total ?? 0 }
    },
    async bulkIds({ book, chapter, states, ids } = {}) {
      const allowed = new Set(['queued', 'paused', 'running'])
      if (!Array.isArray(states) || !states.length || states.some(state => !allowed.has(state))) throw new Error('INVALID_INPUT')
      if (chapter != null && (typeof chapter !== 'string' || !chapter)) throw new Error('INVALID_INPUT')
      if (book != null && (typeof book !== 'string' || !book)) throw new Error('INVALID_INPUT')
      const scope = ['state IN (' + states.map(() => '?').join(',') + ')']
      const args = [...states]
      if (chapter) { scope.push('chapter=?'); args.push(chapter) }
      if (book) { scope.push('chapter IN (SELECT id FROM chapters WHERE book=?)'); args.push(book) }
      if (ids) {
        if (!ids.length) return []
        scope.push('id IN (' + ids.map(() => '?').join(',') + ')')
        args.push(...ids)
      }
      return (await all(`SELECT id FROM jobs WHERE ${scope.join(' AND ')} ORDER BY created,rowid LIMIT 1000`, ...args))
        .map(row => row.id)
    },
    async bulkJobFacts(ids) {
      if (!Array.isArray(ids) || !ids.length) return []
      const list = ids.filter(id => typeof id === 'string' && id).slice(0, 1000)
      if (!list.length) return []
      return all(`SELECT id, chapter, json_extract(spec,'$.engine') engine, json_extract(spec,'$.mode') mode,
        json_extract(spec,'$.purpose') purpose FROM jobs WHERE id IN (${list.map(() => '?').join(',')})`, ...list)
    },
    chapterHeader: id => get(header + ' WHERE c.id=?', id),
    operation: (id, receipt) => command('operation', receipt ?? { id }),
    settings: () => command('settings'),
    saveSettings: (expected, changes) => command('saveSettings', { expected, changes }, true),
    prepareBatch: (ids, input) => command('prepareBatch', { ids, input }, 'read'),
    estimateGroup: (ids, input, windows) => command('estimateGroup', { ids, input, cleanWindow: windows.cleanWindow, castWindow: windows.castWindow }, 'read'),
    async saveProduction(args) {
      const result = await command('saveProduction', args, true, args.receipt)
      return args.receipt ? result.result : result
    },
    revision: async id => (await get('SELECT rev FROM chapters WHERE id=?', id))?.rev,
    async chapter(id) {
      const row = await get('SELECT c.*,b.title bookTitle,b.roles_rev rolesRev,b.voice_rule voiceRule,c.playback_rev playbackRev,EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) isSnippet FROM chapters c JOIN books b ON b.id=c.book WHERE c.id=?', id)
      if (!row) throw new Error('CHAPTER_NOT_FOUND')
      return { ...row, editorial: parse(row.editorial), playback: parse(row.playback) }
    },
    async chapterDetail(id) {
      const [row, roles] = await execute([
        sql(`SELECT c.*,b.title bookTitle,b.roles_rev rolesRev,b.voice_rule voiceRule,c.playback_rev playbackRev,
          EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) isSnippet,
          (SELECT id FROM chapters WHERE book=c.book AND ordinal<c.ordinal ORDER BY ordinal DESC LIMIT 1) previousId,
          (SELECT id FROM chapters WHERE book=c.book AND ordinal>c.ordinal ORDER BY ordinal LIMIT 1) nextId
          FROM chapters c JOIN books b ON b.id=c.book WHERE c.id=?`, [id], 'get'),
        sql('SELECT id,name,gender,age,voices FROM roles WHERE book=(SELECT book FROM chapters WHERE id=?) ORDER BY rowid', [id], 'all'),
      ], 'read')
      if (!row) throw new Error('CHAPTER_NOT_FOUND')
      return { ...row, editorial: parse(row.editorial), playback: parse(row.playback),
        roles: roles.map(role => ({ ...role, voices: parse(role.voices) })) }
    },
    async manual(title, text, bookId) {
      const id = randomUUID()
      const book = bookId ?? randomUUID()
      if (bookId && !await get('SELECT id FROM books WHERE id=?', bookId)) throw new Error('BOOK_NOT_FOUND')
      if (bookId && await get('SELECT 1 FROM chat_readings WHERE book=?', bookId)) throw new Error('INVALID_INPUT')
      if (bookId) await run('INSERT INTO chapters(id,book,ordinal,title,text,characters) VALUES(?,?,coalesce((SELECT max(ordinal) FROM chapters WHERE book=?),0)+1,?,?,length(?))', id, book, book, title, text, text)
      else await tx([newBook(book, title, null), newChapter(id, book, 1, title, text)])
      return this.chapter(id)
    },
    async saveChapter(id, expected, { title, text, editorial, baseEditorialResultJob }) {
      const guard = baseEditorialResultJob === undefined ? '' : " AND json_extract(editorial,'$.resultJob') IS ?"
      const args = [title, text, text, json(editorial), id, expected]
      if (guard) args.push(baseEditorialResultJob)
      await tx([sql('UPDATE chapters SET rev=rev+1,title=?,text=?,characters=length(?),editorial=? WHERE id=? AND rev=?' + guard, args, 'run', 1)])
      return this.chapter(id)
    },
    async publishEditorial(id, rev, editorial) {
      const { changes } = await run('UPDATE chapters SET editorial=? WHERE id=? AND rev=?', json(editorial), id, rev)
      if (!changes) throw new Error('VERSION_CONFLICT')
    },
    async roles(book) {
      return (await all('SELECT id,name,gender,age,voices FROM roles WHERE book=? ORDER BY rowid', book)).map(role => ({ ...role, voices: parse(role.voices) }))
    },
    // The voice rule the book was created with (see domain/voice-assignment.mjs).
    async voiceRule(book) {
      const row = await get('SELECT voice_rule FROM books WHERE id=?', book)
      if (!row) throw new Error('BOOK_NOT_FOUND')
      return row.voice_rule
    },
    // Moves a book to the latest rule (only ever up). Refused while the book has
    // work in progress, so one job never mixes old and new voices.
    setVoiceRule: (book, rule, baseRolesRev) => command('setVoiceRule', { book, rule, baseRolesRev }, true),
    async addRoles(book, roles) {
      if (!roles.length) return
      await command('addRoles', { book, roles }, true)
    },
    async job(id) { return unpack(await get('SELECT * FROM jobs WHERE id=?', id)) },
    async jobs(session) {
      return (session ? await all(jobProjection + ' WHERE session=? ORDER BY j.created DESC LIMIT 60', session)
        : await all(jobProjection + ' ' + jobsOrder + ' LIMIT 100')).map(unpack)
    },
    async sessionBoard(session) {
      const [jobs, count, latest] = await execute([
        sql(sessionJobProjection + " WHERE j.session=? AND j.state IN ('queued','running','paused') ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, j.created DESC LIMIT 12", [session], 'all'),
        sql("SELECT count(*) total FROM jobs WHERE session=? AND state IN ('queued','running','paused')", [session], 'get'),
        sql(sessionJobProjection + " WHERE j.session=? AND j.state IN ('completed','cancelled') ORDER BY j.created DESC, j.rowid DESC LIMIT 1", [session], 'get'),
      ], 'read')
      const total = count?.total ?? 0
      return { jobs: jobs.map(unpack), overflow: Math.max(0, total - jobs.length), latest: unpack(latest) }
    },
    async chapterResume(id) {
      if (typeof id !== 'string' || !id) return null
      const row = await get(`SELECT c.id,c.title,b.title bookTitle,c.playback,
        EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) isSnippet,
        (SELECT id FROM chapters WHERE book=c.book AND ordinal>c.ordinal ORDER BY ordinal LIMIT 1) nextId
        FROM chapters c JOIN books b ON b.id=c.book WHERE c.id=?`, id)
      if (!row) return null
      const playback = parse(row.playback)
      return {
        id: row.id, title: row.title, bookTitle: row.bookTitle, isSnippet: Boolean(row.isSnippet), nextId: row.nextId ?? null,
        n: Number.isInteger(playback?.n) && playback.n >= 0 ? playback.n : null,
        offset: Number.isFinite(playback?.offset) && playback.offset >= 0 ? playback.offset : null,
        job: typeof playback?.job === 'string' ? playback.job : null,
      }
    },
    async jobsPage({ book, chapter, state, offset = 0, limit = 30 }) {
      const scope = [book && 'c.book=?', chapter && 'c.id=?'].filter(Boolean)
      const values = [book, chapter].filter(Boolean)
      const where = list => list.length ? ' WHERE ' + list.join(' AND ') : ''
      const filtered = where(state ? [...scope, 'j.state=?'] : scope)
      const [rows, counts] = await execute([
        sql(jobProjection + filtered + ' ' + jobsOrder + ' LIMIT ? OFFSET ?',
          [...values, ...(state ? [state] : []), limit, offset], 'all'),
        sql('SELECT j.state,count(*) count FROM jobs j JOIN chapters c ON c.id=j.chapter' + where(scope) + ' GROUP BY j.state', values, 'all'),
      ], 'read')
      const breakdown = Object.fromEntries(counts.map(row => [row.state, row.count]))
      return { jobs: rows.map(unpack), counts: breakdown, total: state ? breakdown[state] ?? 0 : counts.reduce((n, row) => n + row.count, 0) }
    },
    async historicalAudioJob(chapter) {
      return unpack(await get(`SELECT j.* FROM jobs j WHERE j.chapter=? AND json_extract(j.spec,'$.purpose')='generate'
        AND EXISTS (SELECT 1 FROM audio WHERE chapter=j.chapter)
        AND EXISTS (SELECT 1 FROM json_each(j.progress,'$.parts') p
          JOIN audio a ON a.chapter=j.chapter AND a.key=json_extract(p.value,'$.key'))
        ORDER BY j.created DESC,j.rowid DESC LIMIT 1`, chapter))
    },
    // Newest generate job whose plan is finished and whose every part has audio,
    // at any revision. Ordered so the first match is the one to keep playing.
    async latestCompleteAudioJob(chapter) {
      return unpack(await get(latestCompleteAudioJobSQL, chapter))
    },
    // Parts the gateway already accepted for this chapter, oldest job first so a
    // newer acceptance wins. Parts that have used up their resubmits are left
    // out: a new job must be able to start those again.
    async acceptedParts(chapter, exclude = '') {
      const rows = await all(`SELECT progress FROM jobs WHERE chapter=? AND id<>?
        AND json_extract(spec,'$.engine')='laivox' ORDER BY created DESC,rowid DESC LIMIT 12`, chapter, exclude)
      const parts = []
      for (const row of rows.reverse()) {
        for (const part of parse(row.progress)?.parts ?? []) {
          if (!part?.requestId && !part?.taskId) continue
          if (Number.isInteger(part.resubmits) && part.resubmits >= MAX_RESUBMITS) continue
          parts.push(part)
        }
      }
      return parts
    },
    async chapterJobs(chapter, rev) {
      return (await all('SELECT * FROM jobs WHERE chapter=? AND rev=? ORDER BY created DESC,rowid DESC LIMIT 12', chapter, rev)).map(unpack)
    },
    async chapterOperation(chapter, rev) {
      return unpack(await get(`SELECT * FROM jobs WHERE chapter=? AND rev=?
        ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END,
          CASE WHEN state='queued' THEN priority END DESC, created DESC,rowid DESC LIMIT 1`, chapter, rev))
    },
    reserveJobPriority: async () => (await get('UPDATE job_priorities SET value=value+1 RETURNING value')).value,
    async enqueue(entries, priority = 0, receipt = null) {
      if (!entries.length) return []
      const created = Date.now()
      const commands = entries.map(entry => sql(
        "INSERT INTO jobs(id,chapter,rev,session,state,spec,created,priority) SELECT ?,id,rev,?,'queued',?,?,? FROM chapters WHERE id=? AND rev=? AND NOT EXISTS (SELECT 1 FROM jobs WHERE chapter=? AND rev=? AND session IS ? AND spec=? AND state IN ('queued','running','paused'))",
        [entry.id, entry.session, json(entry.spec), created, priority, entry.chapter, entry.rev, entry.chapter, entry.rev, entry.session, json(entry.spec)]))
      const guards = entries.map(entry => entry.rolesRev === undefined
        ? sql('UPDATE chapters SET rev=rev WHERE id=? AND rev=?', [entry.chapter, entry.rev], 'run', 1)
        : sql(`UPDATE chapters SET rev=rev WHERE id=? AND rev=? AND json_extract(editorial,'$.resultJob') IS ?
          AND (SELECT roles_rev FROM books WHERE id=chapters.book)=?`,
        [entry.chapter, entry.rev, entry.editorialResultJob, entry.rolesRev], 'run', 1))
      const reads = entries.map(entry => sql("SELECT * FROM jobs WHERE chapter=? AND rev=? AND session IS ? AND spec=? AND state IN ('queued','running','paused') ORDER BY rowid DESC LIMIT 1",
        [entry.chapter, entry.rev, entry.session, json(entry.spec)], 'get'))
      const statements = [...guards, ...commands, ...reads]
      const result = receipt ? await execute(statements, true, false, { receipt, args: { count: reads.length } }) : await tx(statements)
      if (result.replay) return { replay: true, jobs: await Promise.all(result.result.map(id => this.job(id))) }
      const jobs = (receipt ? result.value : result).slice(-reads.length).map(row => {
        if (!row) throw new Error('VERSION_CONFLICT')
        return unpack(row)
      })
      return receipt ? { replay: false, jobs } : jobs
    },
    async createChatJob({ proposal, session, title, text, spec, priority }) {
      const book = randomUUID(), chapter = randomUUID(), id = randomUUID()
      const result = await tx([
        // The accepted proposal remembers its job so the tool card can open it.
        // Only the summary stays (the text is now the chapter), plus the job so the
        // tool card and the reply line can open it.
        ...(proposal ? [sql("UPDATE proposals SET state='accepted',payload=? WHERE id=? AND session=? AND state='pending'",
          [json({ ...proposalSummary(proposal.payload), job: id, chapter }), proposal.id, session], 'run', 1)] : []),
        newBook(book, '对话朗读', null),
        sql('INSERT INTO chat_readings(book,session,touched) VALUES(?,?,?)', [book, session, Date.now()]),
        newChapter(chapter, book, 1, title, text),
        sql("INSERT INTO jobs(id,chapter,rev,session,state,spec,created,priority) VALUES(?,?,1,?,'queued',?,?,?) RETURNING *",
          [id, chapter, session, json(spec), Date.now(), priority], 'get'),
      ])
      return unpack(result.at(-1))
    },
    async next() {
      return unpack(await get(`
        UPDATE jobs SET state='running'
        WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE state='running') AND id=(
          SELECT id FROM jobs WHERE state='queued' ORDER BY priority DESC,created,rowid LIMIT 1
        ) RETURNING *`))
    },
    hasHigherQueued: async priority => Boolean(await get('SELECT 1 AS hit FROM jobs WHERE state=? AND priority>? LIMIT 1', 'queued', priority)),
    async previousCast(book, ordinal) {
      if (typeof book !== 'string' || !Number.isInteger(ordinal)) return null
      const rows = await all('SELECT id,ordinal,rev,editorial FROM chapters WHERE book=? AND ordinal<? ORDER BY ordinal DESC LIMIT 8', book, ordinal)
      for (const row of rows) {
        const editorial = parse(row.editorial)
        if (!editorial?.cast || !editorial.annotations) continue
        return { id: row.id, ordinal: row.ordinal, rev: row.rev, annotations: editorial.annotations }
      }
      return null
    },
    // A job still marked running at start-up was cut off by a restart or crash;
    // clear any scheduled auto-resume timer across paused jobs too.
    async requeueInterrupted() {
      await run("UPDATE jobs SET state=CASE WHEN state='running' THEN 'paused' ELSE state END, progress=CASE WHEN state='running' THEN json_remove(json_set(progress,'$.pauseReason','restart'),'$.autoResume') ELSE json_remove(progress,'$.autoResume') END WHERE state='running' OR (state='paused' AND json_extract(progress,'$.autoResume') IS NOT NULL)")
    },
    async checkpoint(id, state, progress, { retake = false } = {}) {
      const update = 'UPDATE jobs SET state=?,progress=? WHERE id=?'
      const params = [state, json(progress), id]
      if (state === 'paused' && progress.error === 'AUDIO_LIMIT' && !retake) {
        await tx([sql(update, params),
          sql("UPDATE jobs SET state='paused',progress=json_set(progress,'$.error',?) WHERE state='queued' AND json_extract(spec,'$.purpose')='generate'", [progress.error])])
      } else await run(update, ...params)
    },
    // Writes progress only while the job is still in the state the caller read.
    // A claim that landed in between leaves the row untouched.
    async checkpointIf(id, state, progress) {
      const result = await run('UPDATE jobs SET progress=? WHERE id=? AND state=?', json(progress), id, state)
      return result.changes === 1
    },
    // The user chose to finish a paused LaiVox job with Edge voices (only while paused).
    async markFill(id, fill) {
      const job = await get("UPDATE jobs SET progress=json_set(progress,'$.fill',json(?)) WHERE id=? AND state='paused' RETURNING *", json(fill), id)
      if (!job) throw new Error('JOB_STATE_CHANGED')
      return unpack(job)
    },
    async transition(id, from, to, priority = null) {
      const job = await get('UPDATE jobs SET state=?,priority=coalesce(?,priority) WHERE id=? AND state=? RETURNING *', to, priority, id, from)
      if (!job) throw new Error('JOB_STATE_CHANGED')
      return unpack(job)
    },
    audio: (chapter, key) => get('SELECT rate,channels,bytes,pcm,codec,frames,trim_start AS trimStart,write_id AS writeId FROM audio WHERE chapter=? AND key=?', chapter, key),
    audioInfo: (chapter, key) => get('SELECT rate,channels,bytes,codec,frames,write_id AS writeId FROM audio WHERE chapter=? AND key=?', chapter, key),
    audioKeys: chapter => all('SELECT key,rate,channels,bytes,codec,frames FROM audio WHERE chapter=?', chapter),
    marks: async (chapter, key) => {
      const row = await get('SELECT marks FROM audio_marks WHERE chapter=? AND key=?', chapter, key)
      return row ? parse(row.marks) : null
    },
    // replace: a retake of a part that already has audio (same key). The old row is
    // removed only when the new one fits the budget and the chapter is unchanged,
    // in the same transaction, so a refused retake keeps the audio the user had.
    // The usage triggers only count inserts and deletes, hence delete + insert.
    async putAudio(chapter, rev, key, audio, { replace = false, writeId = null } = {}) {
      const codec = audio.codec === 'mp3' || audio.codec === 'wav' ? audio.codec : 'pcm'
      const payload = codec === 'pcm' ? audio.data : (audio.payload ?? audio.data)
      if (!payload?.length || !Number.isInteger(audio.rate) || !Number.isInteger(audio.channels)) throw new Error('INVALID_INPUT')
      const frames = Number.isInteger(audio.frames) ? audio.frames : null
      const trimStart = Number.isInteger(audio.trimStart) ? audio.trimStart : null
      const statements = []
      if (replace) statements.push(sql(`DELETE FROM audio WHERE chapter=? AND key=? AND EXISTS (SELECT 1 FROM chapters WHERE id=? AND rev=?)
        AND (SELECT used FROM audio_usage) - bytes + ? <= ?`, [chapter, key, chapter, rev, payload.length, audioLimit]))
      statements.push(sql(`INSERT INTO audio(chapter,key,rate,channels,bytes,pcm,codec,frames,trim_start,write_id)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM chapters WHERE id=? AND rev=?) AND (SELECT used FROM audio_usage)+? <= ? ON CONFLICT DO NOTHING`,
        [chapter, key, audio.rate, audio.channels, payload.length, payload, codec, frames, trimStart, writeId, chapter, rev, payload.length, audioLimit]))
      // changes() is the audio INSERT immediately above, not the usage trigger. A refused
      // write leaves the previous recording, so it must not gain this take's timings.
      if (Array.isArray(audio.marks) && audio.marks.length) statements.push(sql('INSERT OR IGNORE INTO audio_marks SELECT ?,?,? WHERE changes() > 0',
        [chapter, key, JSON.stringify(audio.marks)]))
      const results = statements.length > 1 ? await tx(statements) : await execute(statements)
      const { changes } = results[replace ? 1 : 0]
      if (replace && !changes) {
        if ((await this.chapter(chapter)).rev !== rev) throw new Error('VERSION_CONFLICT')
        throw new Error('AUDIO_LIMIT')
      }
      if (!changes && !(await this.audioInfo(chapter, key))) {
        if ((await this.chapter(chapter)).rev !== rev) throw new Error('VERSION_CONFLICT')
        throw new Error('AUDIO_LIMIT')
      }
    },
    async space() { return command('space') },
    async configureAudioLimit(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('INVALID_INPUT')
      audioLimit = bytes
      return command('configureAudioLimit', { bytes })
    },
    activeJobsForBook: book => command('activeJobsForBook', { book }),
    async activeJobCount() {
      return (await get("SELECT count(*) total FROM jobs WHERE state IN ('running','queued','paused')"))?.total ?? 0
    },
    deleteBook: book => command('deleteBook', { book }, true),
    deleteSnippet: (book, now) => command('deleteSnippet', { book, now }, true),
    renameBook: (book, title) => command('renameBook', { book, title }, true),
    async compact() {
      return command('compactIfIdle')
    },
    keyMeta: () => command('keyMeta'),
    setKeyMeta: account => command('setKeyMeta', { account }, true),
    clearKeyMeta: () => command('clearKeyMeta', {}, true),
    async clearAudio({ chapter, book }) {
      const selector = chapter ? 'id=?' : 'book=?'
      const id = chapter ?? book
      await tx([
        sql('UPDATE jobs SET state=\'cancelled\' WHERE chapter IN (SELECT id FROM chapters WHERE ' + selector + ') AND state IN (\'queued\',\'paused\')', [id]),
        sql('UPDATE chapters SET rev=rev+1 WHERE ' + selector, [id]),
        sql('DELETE FROM audio WHERE chapter IN (SELECT id FROM chapters WHERE ' + selector + ')', [id]),
      ])
    },
    async playback(id, value, expected) {
      if (expected === undefined) return run("UPDATE chapters SET playback=json_patch(coalesce(playback,'{}'),?),playback_rev=playback_rev+1 WHERE id=?", json(value), id)
      const row = await get(`UPDATE chapters SET playback=json_patch(coalesce(playback,'{}'),?),playback_rev=playback_rev+1
        WHERE id=? AND playback_rev=? RETURNING playback_rev revision`, json(value), id, expected)
      if (!row) throw new Error('PLAYBACK_CONFLICT')
      return row
    },
    async importReview(source) {
      const row = await get('SELECT rev,state FROM import_reviews WHERE source=?', source)
      return row && { rev: row.rev, state: parse(row.state) }
    },
    async relatedImportReview(lineage, source) {
      const row = await get('SELECT state FROM import_reviews WHERE lineage=? AND source<>? ORDER BY updated DESC LIMIT 1', lineage, source)
      return row && parse(row.state)
    },
    async saveImportReview(source, lineage, expected, state) {
      const { changes } = await run('INSERT INTO import_reviews VALUES(?,?,1,?,?) ON CONFLICT(source) DO UPDATE SET rev=rev+1,updated=excluded.updated,state=excluded.state WHERE rev=? AND ?>0',
        source, lineage, Date.now(), json(state), expected, expected)
      if (!changes) throw new Error('VERSION_CONFLICT')
      return expected + 1
    },
    async saveImport(id, session, payload) {
      const { changes } = await run('INSERT INTO imports VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE imports.session IS excluded.session', id, session, json(payload), Date.now())
      if (!changes) throw new Error('IMPORT_NOT_FOUND')
    },
    async import(id) {
      const row = await get('SELECT * FROM imports WHERE id=?', id)
      return row && { ...row, payload: parse(row.payload) }
    },
    imports: (session = null) => all("SELECT id,json_extract(payload,'$.title') title FROM imports WHERE session IS ? ORDER BY created DESC LIMIT 20", session),
    async publishedImport(id, session) {
      const row = await get('SELECT id FROM published_imports WHERE id=? AND session IS ?', id, session)
      if (!row) return null
      const mapped = await get("SELECT json_extract(result,'$.book') book FROM operations WHERE id=? AND kind='import-append'", 'import-target:' + id)
      return { id: row.id, book: mapped?.book || row.id }
    },
    findRelatedBook: args => command('findRelatedBook', args, 'read'),
    mergeBookChapters: args => command('mergeBookChapters', args, true),
    listNotes: args => command('listNotes', args, 'read'),
    saveNote: args => command('saveNote', args, true),
    deleteNote: args => command('deleteNote', args, true),
    discardImport: id => run('DELETE FROM imports WHERE id=?', id),
    async publishImport(id, session, data, ordinals, duplicate) {
      if (await get('SELECT id FROM books WHERE id=?', id)) return { id }
      const previous = await get('SELECT id FROM books WHERE fingerprint=? ORDER BY created LIMIT 1', data.fingerprint)
      if (previous && !duplicate) return { duplicate: previous.id }
      await tx([
        sql('DELETE FROM imports WHERE id=?', [id], 'run', 1),
        newBook(id, data.title, data.fingerprint),
        sql('INSERT INTO published_imports VALUES(?,?)', [id, session]),
        ...ordinals.map((index, n) => newChapter(randomUUID(), id, n + 1, data.chapters[index].title, data.chapters[index].text)),
      ])
      return { id }
    },
    // ── AI library tools ─────────────────────────────────────────────
    // A shelf book (not a conversation reading), or null.
    shelfBook: id => get('SELECT id,title FROM books b WHERE id=? AND NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)', id),
    async toolBooks(offset = 0, q = '') {
      const [books, total] = await execute([
        sql(`SELECT b.id,b.title,(SELECT count(*) FROM chapters WHERE book=b.id) chapters,
          (SELECT count(DISTINCT a.chapter) FROM audio a JOIN chapters c ON c.id=a.chapter WHERE c.book=b.id) withAudio,
          (SELECT coalesce(sum(characters),0) FROM chapters WHERE book=b.id) totalChars,
          (SELECT c.id FROM chapters c WHERE c.book=b.id AND c.playback IS NOT NULL
            ORDER BY coalesce(json_extract(c.playback,'$.at'),0) DESC, c.ordinal DESC LIMIT 1) currentChapterId,
          (SELECT c.title FROM chapters c WHERE c.book=b.id AND c.playback IS NOT NULL
            ORDER BY coalesce(json_extract(c.playback,'$.at'),0) DESC, c.ordinal DESC LIMIT 1) currentChapterTitle,
          (SELECT c.ordinal FROM chapters c WHERE c.book=b.id AND c.playback IS NOT NULL
            ORDER BY coalesce(json_extract(c.playback,'$.at'),0) DESC, c.ordinal DESC LIMIT 1) currentOrdinal
          FROM books b WHERE NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)
          AND b.title LIKE ? ESCAPE '\\' ORDER BY created DESC,id LIMIT 30 OFFSET ?`, [titlePattern(q), offset], 'all'),
        sql(`SELECT count(*) total FROM books b WHERE NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) AND b.title LIKE ? ESCAPE '\\'`, [titlePattern(q)], 'get'),
      ], 'read')
      for (const row of books) {
        if (row.currentOrdinal && row.chapters > 0) {
          const prior = await get('SELECT coalesce(sum(characters),0) chars FROM chapters WHERE book=? AND ordinal<?', row.id, row.currentOrdinal)
          row.percent = row.totalChars > 0 ? Math.min(100, Math.round(((prior?.chars ?? 0) / row.totalChars) * 100)) : Math.round(((row.currentOrdinal - 1) / row.chapters) * 100)
        } else {
          row.percent = 0
        }
        row.currentChapterId = row.currentChapterId ?? null
        row.currentChapterTitle = row.currentChapterTitle ?? null
        row.currentOrdinal = row.currentOrdinal ?? null
        delete row.totalChars
      }
      return { books, total: total?.total ?? 0 }
    },
    recentListeningBook: () => command('recentListeningBook', {}, 'read'),
    chapterReadingContext: args => command('chapterReadingContext', args, 'read'),
    searchBookContent: args => command('searchBookContent', args, 'read'),
    locateChapterPosition: args => command('locateChapterPosition', args, 'read'),
    // Chapters of one book with their audio: complete = a finished generate job
    // for the current text; partial = some audio; none.
    async toolChapters(book, offset = 0, q = '') {
      const [chapters, total] = await execute([
        sql(`SELECT c.id,c.ordinal,c.title,c.characters,
          CASE WHEN EXISTS(SELECT 1 FROM jobs j WHERE j.chapter=c.id AND j.rev=c.rev AND j.state='completed' AND json_extract(j.spec,'$.purpose')='generate') THEN 'complete'
            WHEN EXISTS(SELECT 1 FROM audio WHERE chapter=c.id) THEN 'partial' ELSE 'none' END audio,
          (SELECT j.state FROM jobs j WHERE j.chapter=c.id AND j.state IN ('running','queued','paused')
            ORDER BY CASE j.state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END LIMIT 1) job
          FROM chapters c WHERE c.book=? AND c.title LIKE ? ESCAPE '\\' ORDER BY c.ordinal LIMIT 30 OFFSET ?`, [book, titlePattern(q), offset], 'all'),
        sql(`SELECT count(*) total FROM chapters WHERE book=? AND title LIKE ? ESCAPE '\\'`, [book, titlePattern(q)], 'get'),
      ], 'read')
      return { chapters: chapters.map(row => ({ ...row, job: row.job ?? null })), total: total?.total ?? 0 }
    },
    // Chapters a make proposal covers when the AI names none: the first 500 in
    // order that are not queued or being made already, and without complete
    // audio when missingOnly.
    async makeCandidates(book, missingOnly = true) {
      const filter = missingOnly ? `AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.chapter=c.id AND j.rev=c.rev AND j.state='completed' AND json_extract(j.spec,'$.purpose')='generate')` : ''
      return (await all(`SELECT c.id FROM chapters c WHERE c.book=? ${filter}
        AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.chapter=c.id AND j.state IN ('queued','running','paused'))
        ORDER BY c.ordinal LIMIT 500`, book)).map(row => row.id)
    },
    // Which of these chapter ids belong to the book.
    async chaptersInBook(book, ids) {
      const rows = await all(`SELECT id FROM chapters WHERE book=? AND id IN (${ids.map(() => '?').join(',')})`, book, ...ids)
      return new Set(rows.map(row => row.id))
    },
    appendChapters: input => command('appendChapters', input, true),
    // A confirmed make proposal keeps only its summary; a second confirmation
    // (another window) finds it handled.
    acceptProposal: (id, session, payload) => run("UPDATE proposals SET state='accepted',payload=? WHERE id=? AND session=? AND state='pending'", json(payload), id, session),
    async proposal(id, session) {
      const row = await get("SELECT * FROM proposals WHERE id=? AND session=? AND state='pending'", id, session)
      return row && { ...row, payload: parse(row.payload) }
    },
    // Any state, for the tool card that created it (same session only).
    async proposalState(id, session) {
      const row = await get('SELECT id,state,payload FROM proposals WHERE id=? AND session=?', id, session)
      return row && { ...row, payload: parse(row.payload) }
    },
    propose: (id, session, value) => command('propose', { id, session, value }, true),
    async proposals(session) {
      return (await all("SELECT id,payload FROM proposals WHERE session=? AND state='pending' ORDER BY created DESC LIMIT 10", session))
        .map(row => ({ id: row.id, ...parse(row.payload) }))
    },
    // Conversation readings ("对话音频"): one chapter in its own hidden book.
    async snippets({ offset = 0 } = {}) {
      const [rows, totals] = await execute([
        sql(`WITH listed AS (
          SELECT b.id book, cr.session, cr.touched, b.created, c.id chapter, c.title, c.characters,
            (SELECT coalesce(sum(a.bytes),0) FROM audio a WHERE a.chapter=c.id) audioBytes,
            EXISTS(SELECT 1 FROM jobs j WHERE j.chapter=c.id AND j.state IN ('queued','running','paused')) active
          FROM chat_readings cr JOIN books b ON b.id=cr.book JOIN chapters c ON c.book=b.id
          ORDER BY cr.touched DESC, b.created DESC, b.id LIMIT 30 OFFSET ?
        ), ranked AS (
          SELECT j.chapter, j.id, count(a.key)=count(*) complete,
            sum(coalesce(a.frames, a.bytes * 1.0 / (a.channels * 2)) / a.rate) seconds,
            row_number() OVER (PARTITION BY j.chapter ORDER BY count(a.key)=count(*) DESC, j.created DESC, j.rowid DESC) rank
          FROM listed l JOIN jobs j ON j.chapter=l.chapter
          JOIN json_each(j.progress,'$.parts') part
          LEFT JOIN audio a ON a.chapter=j.chapter AND a.key=json_extract(part.value,'$.key')
          WHERE l.audioBytes>0 AND json_extract(j.spec,'$.purpose')='generate'
            AND json_extract(j.progress,'$.partsOpen') IS NOT 1
          GROUP BY j.id HAVING count(a.key)>0
        )
        SELECT l.*, r.id job, coalesce(r.seconds,0) seconds, coalesce(r.complete,0) exportable
        FROM listed l LEFT JOIN ranked r ON r.chapter=l.chapter AND r.rank=1
        ORDER BY l.touched DESC, l.created DESC, l.book`, [offset], 'all'),
        sql(`SELECT count(*) total, coalesce(sum((SELECT coalesce(sum(a.bytes),0) FROM audio a JOIN chapters c ON c.id=a.chapter WHERE c.book=cr.book)),0) audioBytes
          FROM chat_readings cr`, [], 'get'),
      ], 'read')
      return { items: rows.map(row => ({ ...row, active: Boolean(row.active), exportable: Boolean(row.exportable) })),
        total: totals?.total ?? 0, audioBytes: totals?.audioBytes ?? 0 }
    },
    // Listening keeps a reading alive: the retention counts from the last listen.
    touchSnippet: (chapter, now = Date.now()) => run('UPDATE chat_readings SET touched=? WHERE book=(SELECT book FROM chapters WHERE id=?)', now, chapter),
    async renameSnippet(book, title) {
      const { changes } = await run('UPDATE chapters SET title=? WHERE book=? AND EXISTS(SELECT 1 FROM chat_readings WHERE book=?)', title, book, book)
      if (!changes) throw new Error('SNIPPET_NOT_FOUND')
      return { book, title }
    },
    // "Save to the shelf": the reading becomes an ordinary book with its audio,
    // roles and playback as they are.
    async adoptSnippet(book, title) {
      await tx([
        sql('DELETE FROM chat_readings WHERE book=?', [book], 'run', 1),
        sql('UPDATE books SET title=? WHERE id=?', [title, book], 'run', 1),
      ])
      return { book, title }
    },
    // Readings not listened to since `before` and not being made right now.
    expiredSnippets: before => all(`SELECT cr.book FROM chat_readings cr WHERE cr.touched<?
      AND NOT EXISTS(SELECT 1 FROM jobs j JOIN chapters c ON c.id=j.chapter WHERE c.book=cr.book AND j.state IN ('queued','running','paused'))`, before),
    async expiringSnippets(before) {
      const row = await get(`SELECT count(*) count, coalesce(sum((SELECT coalesce(sum(a.bytes),0) FROM audio a JOIN chapters c ON c.id=a.chapter WHERE c.book=cr.book)),0) audioBytes
        FROM chat_readings cr WHERE cr.touched<?
        AND NOT EXISTS(SELECT 1 FROM jobs j JOIN chapters c ON c.id=j.chapter WHERE c.book=cr.book AND j.state IN ('queued','running','paused'))`, before)
      return { count: row?.count ?? 0, audioBytes: row?.audioBytes ?? 0 }
    },
    allSnippets: () => all('SELECT book FROM chat_readings'),
    isSnippet: async book => Boolean(await get('SELECT 1 one FROM chat_readings WHERE book=?', book)),
    // Import drafts left neither published nor discarded.
    staleImports: before => all('SELECT id FROM imports WHERE created<?', before),
    staleAudio: (apply = false, skipBooks = []) => command('staleAudio', { apply, skipBooks }, apply),
    // A dismissed proposal keeps its summary only: the user did not want the text kept.
    async dismissProposal(id, session) {
      const row = await get("SELECT payload FROM proposals WHERE id=? AND session=? AND state='pending'", id, session)
      if (!row) return { changes: 0 }
      return run("UPDATE proposals SET state='dismissed',payload=? WHERE id=? AND session=? AND state='pending'", json(proposalSummary(parse(row.payload))), id, session)
    },
    migrated: id => get('SELECT id FROM migrations WHERE id=?', id),
    sampleSeedState: () => command('sampleSeedState'),
    seedSamples: args => command('seedSamples', args, true),
    async publishLegacy(old, parts) {
      const id = old.id
      const book = 'legacy-' + id
      const progress = { parts: parts.map(({ pcm, ...part }) => part), stage: 'synthesizing', account: old.account }
      await tx([
        sql('INSERT INTO migrations VALUES(?)', [id]),
        newBook(book, '旧版作品', null, 1), newChapter(id, book, 1, '旧版章节', old.text),
        sql('INSERT INTO jobs(id,chapter,rev,session,state,spec,progress,created) VALUES(?,?,1,NULL,?,?,?,?)', [id, id, old.stage === 'completed' && parts.length && parts.every(part => part.pcm) ? 'completed' : 'paused',
          json({ engine: old.engine, clean: false, cast: false, purpose: 'generate' }), json(progress), Date.now()]),
        ...parts.filter(part => part.pcm).map(part => sql('INSERT INTO audio(chapter,key,rate,channels,bytes,pcm,codec) VALUES(?,?,?,?,?,?,?)',
          [id, part.key, part.pcm.rate, part.pcm.channels, part.pcm.data.length, part.pcm.data, 'pcm'])),
      ])
    },
  }
}
