import { parentPort, workerData } from 'node:worker_threads'
import { statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { defaultSettings, narrator, roleNameKey, validateProductionPatch } from '../../domain/production.mjs'
import { firstTitle, proposalSummary, titleOf } from '../input.mjs'
import { resolveGenerationOptions } from '../../domain/workflow.mjs'
import { countAiBatches } from '../../domain/ai-batch.mjs'
import { SEGMENT_VERSION } from '../../domain/segment.mjs'
import { retentionCutoff } from '../snippets.mjs'
import { ROLE_AGES, VOICE_RULE_LATEST } from '../../domain/voice-assignment.mjs'
import { SAMPLE_MIGRATION_PREFIX } from '../../domain/samples.mjs'
import { completeAudioJobWhere } from './complete-job-sql.mjs'

const db = new DatabaseSync(workerData)
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4000')
db.exec('BEGIN IMMEDIATE')
const version = db.prepare('PRAGMA user_version').get().user_version
if (version > 12) throw new Error('LIBRARY_VERSION_UNSUPPORTED')
if (!version) db.exec([
  'CREATE TABLE IF NOT EXISTS books(id TEXT PRIMARY KEY,title TEXT NOT NULL,fingerprint TEXT,created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS books_fingerprint ON books(fingerprint)',
  'CREATE TABLE IF NOT EXISTS chapters(id TEXT PRIMARY KEY,book TEXT NOT NULL REFERENCES books ON DELETE CASCADE, ordinal INTEGER NOT NULL,title TEXT NOT NULL,text TEXT NOT NULL,rev INTEGER NOT NULL DEFAULT 1,editorial TEXT,playback TEXT,UNIQUE(book,ordinal))',
  'CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,chapter TEXT NOT NULL REFERENCES chapters ON DELETE CASCADE,rev INTEGER NOT NULL,session TEXT,state TEXT NOT NULL,spec TEXT NOT NULL,progress TEXT NOT NULL DEFAULT \'{}\',created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state,created)',
  'CREATE INDEX IF NOT EXISTS jobs_chapter ON jobs(chapter,created DESC)',
  'CREATE TABLE IF NOT EXISTS audio(chapter TEXT NOT NULL REFERENCES chapters ON DELETE CASCADE,key TEXT NOT NULL,rate INTEGER NOT NULL,channels INTEGER NOT NULL,bytes INTEGER NOT NULL,pcm BLOB NOT NULL,PRIMARY KEY(chapter,key))',
  'CREATE TABLE IF NOT EXISTS roles(book TEXT NOT NULL REFERENCES books ON DELETE CASCADE,id TEXT NOT NULL,name TEXT NOT NULL,gender TEXT NOT NULL,voices TEXT NOT NULL,PRIMARY KEY(book,id))',
  'CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,session TEXT,payload TEXT NOT NULL,created INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY,session TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS proposals_session ON proposals(session,state,created)',
  'CREATE TABLE IF NOT EXISTS migrations(id TEXT PRIMARY KEY)',
  'PRAGMA user_version=1',
].join(';'))

if (version < 2) db.exec([
  'ALTER TABLE chapters ADD COLUMN characters INTEGER NOT NULL DEFAULT 0',
  'UPDATE chapters SET characters=length(text)',
  'CREATE TABLE audio_usage(used INTEGER NOT NULL)',
  'INSERT INTO audio_usage SELECT coalesce(sum(bytes),0) FROM audio',
  'CREATE TRIGGER audio_insert AFTER INSERT ON audio BEGIN UPDATE audio_usage SET used=used+new.bytes; END',
  'CREATE TRIGGER audio_delete AFTER DELETE ON audio BEGIN UPDATE audio_usage SET used=used-old.bytes; END',
  'PRAGMA user_version=2',
].join(';'))

if (version < 3) db.exec('CREATE TABLE published_imports(id TEXT PRIMARY KEY,session TEXT); PRAGMA user_version=3')
if (version < 4) db.exec([
  'CREATE TABLE import_reviews(source TEXT PRIMARY KEY,lineage TEXT NOT NULL,rev INTEGER NOT NULL,updated INTEGER NOT NULL,state TEXT NOT NULL)',
  'CREATE INDEX import_reviews_lineage ON import_reviews(lineage,updated DESC)',
  'PRAGMA user_version=4',
].join(';'))
if (version < 5) db.exec([
  'ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0',
  'DROP INDEX IF EXISTS jobs_queue',
  'CREATE INDEX jobs_queue ON jobs(state,priority DESC,created)',
  'CREATE TABLE job_priorities(value INTEGER NOT NULL)',
  'INSERT INTO job_priorities VALUES(0)',
  'PRAGMA user_version=5',
].join(';'))
if (version < 6) db.exec([
  'ALTER TABLE books ADD COLUMN roles_rev INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE chapters ADD COLUMN playback_rev INTEGER NOT NULL DEFAULT 0',
  'CREATE TABLE settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,value TEXT NOT NULL)',
  'CREATE TABLE operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,result TEXT NOT NULL,created INTEGER NOT NULL)',
  'PRAGMA user_version=6',
].join(';'))
if (version < 7) db.exec([
  'CREATE TABLE IF NOT EXISTS key_meta(id INTEGER PRIMARY KEY CHECK(id=1),account TEXT NOT NULL,updated INTEGER NOT NULL)',
  'PRAGMA user_version=7',
].join(';'))
// v8: per-word timing of synthesized parts, kept apart from `audio` so older
// builds keep reading and writing their audio rows unchanged. The trigger ties
// the timing to its audio row, so every path that deletes audio cleans it up.
if (version < 8) db.exec([
  'CREATE TABLE IF NOT EXISTS audio_marks(chapter TEXT NOT NULL REFERENCES chapters ON DELETE CASCADE,key TEXT NOT NULL,marks TEXT NOT NULL,PRIMARY KEY(chapter,key))',
  'CREATE TRIGGER IF NOT EXISTS audio_marks_cleanup AFTER DELETE ON audio BEGIN DELETE FROM audio_marks WHERE chapter=old.chapter AND key=old.key; END',
  'PRAGMA user_version=8',
].join(';'))
// Conversation readings reuse chapter/audio storage, but are not shelf books.
// Never infer this origin from a title: existing user books keep their identity.
if (version < 9) db.exec([
  'CREATE TABLE IF NOT EXISTS chat_readings(book TEXT PRIMARY KEY REFERENCES books ON DELETE CASCADE,session TEXT NOT NULL)',
  'PRAGMA user_version=9',
].join(';'))
// v10: conversation readings expire after the retention period, counted from the
// last listen. Existing readings start counting now, not from their creation:
// otherwise the first sweep after the upgrade would delete them unannounced.
// Handled proposals keep only their summary (the text lives in the chapter).
if (version < 10) {
  const now = Date.now()
  // The query helpers are declared further down; use the database directly here.
  // A file whose version was lowered by hand (tests, a downgrade and re-upgrade)
  // may already have the column; only add it when missing.
  const columns = db.prepare('PRAGMA table_info(chat_readings)').all().map(column => column.name)
  if (!columns.includes('touched')) db.exec('ALTER TABLE chat_readings ADD COLUMN touched INTEGER NOT NULL DEFAULT 0')
  db.prepare('UPDATE chat_readings SET touched=?').run(now)
  const update = db.prepare('UPDATE proposals SET payload=? WHERE id=?')
  for (const row of db.prepare("SELECT id,payload FROM proposals WHERE state<>'pending'").all()) {
    update.run(JSON.stringify(proposalSummary(JSON.parse(row.payload))), row.id)
  }
  db.exec('PRAGMA user_version=10')
}
// v11: the voice rule a book was created with (1 = by gender only, 2 = gender and
// age) and an age band per role. Every existing book keeps rule 1 so its voices
// and audio keys stay as they are; new books are created with rule 2.
if (version < 11) {
  const has = (table, name) => db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)
  if (!has('books', 'voice_rule')) db.exec('ALTER TABLE books ADD COLUMN voice_rule INTEGER NOT NULL DEFAULT 1')
  if (!has('roles', 'age')) db.exec("ALTER TABLE roles ADD COLUMN age TEXT NOT NULL DEFAULT ''")
  db.exec('PRAGMA user_version=11')
}
// v12: stored audio may be pcm, the original wav, or mp3. Old rows stay pcm and
// keep their bytes; frames and trim are filled only for rows written after this.
if (version < 12) {
  const names = db.prepare('PRAGMA table_info(audio)').all().map(column => column.name)
  if (!names.includes('codec')) db.exec("ALTER TABLE audio ADD COLUMN codec TEXT NOT NULL DEFAULT 'pcm'")
  if (!names.includes('frames')) db.exec('ALTER TABLE audio ADD COLUMN frames INTEGER')
  if (!names.includes('trim_start')) db.exec('ALTER TABLE audio ADD COLUMN trim_start INTEGER')
  if (!names.includes('write_id')) db.exec('ALTER TABLE audio ADD COLUMN write_id TEXT')
  db.exec('PRAGMA user_version=12')
}
db.exec('COMMIT')

let audioLimit = 2 * 1024 ** 3
// false restores the old rule: any role change bumps every chapter. Default is the
// scoped rule (a rename bumps nothing; a voice change bumps only chapters that
// quote that role). Rollback by setting this to false.
const SCOPED_ROLE_REV = true

const get = (query, ...args) => db.prepare(query).get(...args)
const all = (query, ...args) => db.prepare(query).all(...args)
const run = (query, ...args) => db.prepare(query).run(...args)
const json = JSON.stringify
const parse = value => value == null ? null : JSON.parse(value)
const fault = (message, details) => Object.assign(new Error(message), { details })

function operation({ id, kind, digest }) {
  const row = get('SELECT kind,digest,result FROM operations WHERE id=?', id)
  if (!row) return null
  if (kind && (row.kind !== kind || row.digest !== digest)) throw fault('OPERATION_ID_REUSED')
  return parse(row.result)
}

function record(receipt, result) {
  if (receipt) run('INSERT INTO operations VALUES(?,?,?,?,?)', receipt.id, receipt.kind, receipt.digest, json(result), Date.now())
}

function assertIdle(book, chapter) {
  const column = chapter ? 'c.id' : 'c.book'
  const scope = chapter ?? book
  const where = `FROM jobs j JOIN chapters c ON c.id=j.chapter WHERE ${column}=? AND j.state IN ('queued','running','paused')`
  const { total } = get('SELECT count(*) total ' + where, scope)
  if (total) throw fault('TASKS_BLOCK_SAVE', {
    book, chapter, total, jobs: all(`SELECT j.id,j.chapter,j.state,c.title,
      json_extract(j.spec,'$.engine') engine, json_extract(j.spec,'$.mode') mode, json_extract(j.spec,'$.purpose') purpose `
      + where + ' ORDER BY j.created DESC,j.rowid DESC LIMIT 10', scope),
  })
}

function activeJobsForBook(book) {
  if (typeof book !== 'string' || !book) throw fault('INVALID_INPUT')
  return all(`SELECT j.id FROM jobs j JOIN chapters c ON c.id=j.chapter
    WHERE c.book=? AND j.state IN ('running','queued','paused') ORDER BY j.created,j.rowid`, book).map(row => row.id)
}

// Rule changes only go up and only when nothing of the book is being produced:
// planned parts keep the voices they were planned with.
function setVoiceRule({ book, rule, baseRolesRev } = {}) {
  if (typeof book !== 'string' || !book || rule !== VOICE_RULE_LATEST || !Number.isSafeInteger(baseRolesRev)) throw fault('INVALID_INPUT')
  const row = get('SELECT voice_rule,roles_rev FROM books WHERE id=?', book)
  if (!row) throw fault('BOOK_NOT_FOUND')
  if (row.voice_rule >= rule) return { voiceRule: row.voice_rule, rolesRev: row.roles_rev }
  if (row.roles_rev !== baseRolesRev) throw fault('VERSION_CONFLICT')
  if (activeJobsForBook(book).length) throw fault('BOOK_BUSY')
  run('UPDATE books SET voice_rule=?,roles_rev=roles_rev+1 WHERE id=?', rule, book)
  return { voiceRule: rule, rolesRev: row.roles_rev + 1 }
}

function bookStats(book) {
  const row = get(`SELECT (SELECT count(*) FROM chapters WHERE book=?) chapters,
    (SELECT coalesce(sum(a.bytes),0) FROM audio a JOIN chapters c ON c.id=a.chapter WHERE c.book=?) audioBytes`, book, book)
  return { chapters: row?.chapters ?? 0, audioBytes: row?.audioBytes ?? 0 }
}

// Audio that no job of the chapter's current revision refers to (any engine, any
// mode): left over from edits, new voices or a new script. Chapters with an
// active job and books in use (exporting, clearing) are skipped. Without
// `apply` it only measures.
function partKeys(progress) {
  const keys = []
  for (const part of parse(progress)?.parts ?? []) if (typeof part?.key === 'string') keys.push(part.key)
  return keys
}

function staleAudio({ apply = false, skipBooks = [] } = {}) {
  const skip = new Set(Array.isArray(skipBooks) ? skipBooks : [])
  let bytes = 0
  let chapters = 0
  let skipped = 0
  for (const chapter of all('SELECT DISTINCT c.id,c.book,c.rev,c.playback FROM chapters c JOIN audio a ON a.chapter=c.id')) {
    const current = new Set()
    // The revision being produced, the newest finished version at any revision,
    // and the version the listener pinned or bookmarked.
    for (const job of all('SELECT progress FROM jobs WHERE chapter=? AND rev=?', chapter.id, chapter.rev)) {
      for (const key of partKeys(job.progress)) current.add(key)
    }
    const latest = get(`SELECT j.progress progress FROM jobs j WHERE ${completeAudioJobWhere} ORDER BY j.created DESC,j.rowid DESC LIMIT 1`, chapter.id)
    for (const key of partKeys(latest?.progress)) current.add(key)
    const pinned = parse(chapter.playback)?.job
    if (typeof pinned === 'string' && pinned) {
      const job = get('SELECT progress FROM jobs WHERE id=? AND chapter=?', pinned, chapter.id)
      for (const key of partKeys(job?.progress)) current.add(key)
    }
    const stale = all('SELECT key,bytes FROM audio WHERE chapter=?', chapter.id).filter(row => !current.has(row.key))
    if (!stale.length) continue
    if (skip.has(chapter.book) || get("SELECT 1 one FROM jobs WHERE chapter=? AND state IN ('queued','running','paused')", chapter.id)) { skipped++; continue }
    chapters++
    for (const row of stale) {
      bytes += row.bytes
      if (apply) run('DELETE FROM audio WHERE chapter=? AND key=?', chapter.id, row.key)
    }
  }
  return { bytes, chapters, skipped }
}

// Add chapters to a book (or a new one) in one transaction. A chapter
// whose title and text equal one already in the book (or earlier in this call)
// is skipped. The caller validated titles and texts; ordinals follow the last.
function appendChapters({ book, bookTitle, chapters } = {}) {
  let id = book
  let title = bookTitle
  if (id) {
    const row = get('SELECT b.title,EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) snippet FROM books b WHERE b.id=?', id)
    if (!row) throw fault('BOOK_NOT_FOUND')
    if (row.snippet) throw fault('INVALID_INPUT')
    title = row.title
  } else {
    id = randomUUID()
    run('INSERT INTO books(id,title,fingerprint,created,voice_rule) VALUES(?,?,?,?,?)', id, title, null, Date.now(), VOICE_RULE_LATEST)
  }
  const digest = text => createHash('sha256').update(text).digest('hex')
  // Only chapters with the same title and length are read in full.
  const same = db.prepare('SELECT text FROM chapters WHERE book=? AND title=? AND characters=length(?)')
  const insert = db.prepare('INSERT INTO chapters(id,book,ordinal,title,text,characters) VALUES(?,?,coalesce((SELECT max(ordinal) FROM chapters WHERE book=?),0)+1,?,?,length(?))')
  const seen = new Set()
  const added = []
  let skipped = 0
  for (const chapter of chapters) {
    const key = chapter.title + '|' + digest(chapter.text)
    if (seen.has(key) || same.all(id, chapter.title, chapter.text).some(row => row.text === chapter.text)) { skipped++; continue }
    seen.add(key)
    const chapterId = randomUUID()
    insert.run(chapterId, id, id, chapter.title, chapter.text, chapter.text)
    added.push(chapterId)
  }
  return { book: id, bookTitle: title, added, skipped }
}

function renameBook({ book, title } = {}) {
  if (typeof book !== 'string' || !book) throw fault('INVALID_INPUT')
  const value = typeof title === 'string' ? title.trim() : ''
  if (!value || value.length > 180) throw fault('INVALID_INPUT')
  const { changes } = run('UPDATE books SET title=? WHERE id=?', value, book)
  if (!changes) throw fault('BOOK_NOT_FOUND')
  return { id: book, title: value }
}

function deleteBook({ book } = {}) {
  if (typeof book !== 'string' || !book) throw fault('INVALID_INPUT')
  if (!get('SELECT id FROM books WHERE id=?', book)) throw fault('BOOK_NOT_FOUND')
  // The route cancels active jobs first; this guard closes the window between
  // that cancellation and the delete (the command runs in one transaction).
  const active = get("SELECT count(*) total FROM jobs j JOIN chapters c ON c.id=j.chapter WHERE c.book=? AND j.state IN ('running','queued','paused')", book)?.total ?? 0
  if (active) throw fault('JOBS_ACTIVE', { book, total: active })
  const stats = bookStats(book)
  run('DELETE FROM published_imports WHERE id=?', book)
  run('DELETE FROM books WHERE id=?', book)
  return stats
}

function deleteSnippet({ book, now } = {}) {
  const snippet = get('SELECT touched FROM chat_readings WHERE book=?', book)
  if (!snippet) return null
  if (now !== undefined) {
    const before = retentionCutoff(settings().values.snippetRetention, now)
    if (before === null || snippet.touched >= before) return null
  }
  return deleteBook({ book })
}

function configureAudioLimit({ bytes } = {}) {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw fault('INVALID_INPUT')
  audioLimit = bytes
  return { limit: audioLimit }
}

function space() {
  return { used: get('SELECT used FROM audio_usage')?.used ?? 0, limit: audioLimit }
}

function compact() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const before = statSync(workerData).size
  db.exec('VACUUM')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  return { before, after: statSync(workerData).size }
}

// The worker handles one command at a time, so the idle check and the VACUUM
// cannot be split by a job claim.
function compactIfIdle() {
  const active = get("SELECT count(*) total FROM jobs WHERE state IN ('running','queued','paused')")?.total ?? 0
  if (active) throw fault('JOBS_ACTIVE')
  return compact()
}

function keyMeta() {
  return get('SELECT account,updated FROM key_meta WHERE id=1') ?? null
}

function setKeyMeta({ account } = {}) {
  if (typeof account !== 'string' || !account) throw fault('INVALID_INPUT')
  run(`INSERT INTO key_meta(id,account,updated) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET account=excluded.account,updated=excluded.updated`, account, Date.now())
  return keyMeta()
}

function clearKeyMeta() {
  run('DELETE FROM key_meta WHERE id=1')
  return null
}

function sampleSeedState() {
  const seeded = Boolean(get('SELECT 1 hit FROM migrations WHERE id LIKE ? LIMIT 1', SAMPLE_MIGRATION_PREFIX + '%'))
  if (seeded) return { seeded: true, empty: false }
  const hasData = Boolean(get('SELECT 1 hit WHERE EXISTS(SELECT 1 FROM books) OR EXISTS(SELECT 1 FROM imports) OR EXISTS(SELECT 1 FROM published_imports)'))
  return { seeded: false, empty: !hasData }
}

function seedSamples({ packId, markOnly = false, books = [], now = Date.now() } = {}) {
  if (typeof packId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(packId)) throw fault('INVALID_INPUT')
  const state = sampleSeedState()
  if (state.seeded) return { status: 'already_seeded', books: 0 }
  if (!state.empty || markOnly === true) {
    run('INSERT OR IGNORE INTO migrations(id) VALUES(?)', SAMPLE_MIGRATION_PREFIX + packId)
    return { status: 'skipped_existing_library', books: 0 }
  }
  if (!Array.isArray(books) || !books.length || !Number.isSafeInteger(now)) throw fault('INVALID_INPUT')
  let totalBytes = 0
  for (const entry of books) {
    if (!entry?.book?.id || !entry?.chapter?.id || !entry?.job?.id || !Array.isArray(entry.audio) || !entry.audio.length) {
      throw fault('INVALID_INPUT')
    }
    for (const item of entry.audio) {
      const length = item?.payload?.byteLength ?? 0
      if (!length || !Number.isInteger(item.rate) || !Number.isInteger(item.channels)) throw fault('INVALID_INPUT')
      totalBytes += length
    }
  }
  const used = get('SELECT used FROM audio_usage')?.used ?? 0
  if (used + totalBytes > audioLimit) throw fault('AUDIO_LIMIT')

  for (let index = 0; index < books.length; index++) {
    const entry = books[index]
    const created = now - index
    run('INSERT INTO books(id,title,fingerprint,created,roles_rev,voice_rule) VALUES(?,?,NULL,?,?,?)',
      entry.book.id, entry.book.title, created, entry.book.rolesRev ?? 0, entry.book.voiceRule)
    for (const role of entry.roles ?? []) {
      run('INSERT INTO roles(book,id,name,gender,age,voices) VALUES(?,?,?,?,?,?)',
        entry.book.id, role.id, role.name, role.gender ?? '', role.age ?? '', json(role.voices ?? {}))
    }
    run('INSERT INTO chapters(id,book,ordinal,title,text,rev,editorial,playback,characters,playback_rev) VALUES(?,?,1,?,?,1,?,NULL,length(?),0)',
      entry.chapter.id, entry.book.id, entry.chapter.title, entry.chapter.text,
      entry.chapter.editorial ? json(entry.chapter.editorial) : null, entry.chapter.text)
    run("INSERT INTO jobs(id,chapter,rev,session,state,spec,progress,created,priority) VALUES(?,?,1,NULL,'completed',?,?,?,0)",
      entry.job.id, entry.chapter.id, json(entry.job.spec), json(entry.job.progress), created)
    for (const item of entry.audio) {
      const codec = item.codec === 'mp3' || item.codec === 'wav' ? item.codec : 'pcm'
      run('INSERT INTO audio(chapter,key,rate,channels,bytes,pcm,codec,frames,trim_start,write_id) VALUES(?,?,?,?,?,?,?,?,?,NULL)',
        entry.chapter.id, item.key, item.rate, item.channels, item.payload.byteLength, item.payload, codec,
        Number.isInteger(item.frames) ? item.frames : null, Number.isInteger(item.trimStart) ? item.trimStart : null)
      if (Array.isArray(item.marks) && item.marks.length) {
        run('INSERT INTO audio_marks(chapter,key,marks) VALUES(?,?,?)', entry.chapter.id, item.key, json(item.marks))
      }
    }
  }
  run('INSERT INTO migrations(id) VALUES(?)', SAMPLE_MIGRATION_PREFIX + packId)
  return { status: 'seeded', books: books.length, bytes: totalBytes }
}

function applyRoles(book, patches) {
  const roles = new Map(all('SELECT id,name,gender,age,voices FROM roles WHERE book=? ORDER BY rowid', book)
    .map(role => [role.id, { ...role, voices: parse(role.voices) }]))
  const changed = new Map()
  const seen = new Set()
  // 'book' widens every chapter (gender, age, or the narrator, who is in all of
  // them). A set names the roles whose own voice changed or who were just
  // created: only chapters that quote them go stale. A rename is neither.
  let bookWide = false
  const affected = new Set()
  for (const patch of patches) {
    if (seen.has(patch.id)) throw fault('INVALID_INPUT')
    seen.add(patch.id)
    const exists = roles.get(patch.id)
    const original = exists ?? (patch.id === narrator.id ? narrator : null)
    if ((original && patch.create) || (!original && !patch.create)) throw fault('VERSION_CONFLICT')
    if (patch.id === narrator.id && (patch.name !== undefined || patch.gender !== undefined || patch.age !== undefined)) throw fault('INVALID_INPUT')
    const name = patch.name === undefined ? original?.name : typeof patch.name === 'string' && patch.name.normalize('NFKC').trim()
    const gender = patch.gender === undefined ? original?.gender ?? '' : patch.gender
    const age = patch.age === undefined ? original?.age ?? '' : patch.age
    if (!name || name.length > 48 || !['female', 'male', ''].includes(gender) || !['', ...ROLE_AGES].includes(age)) throw fault('INVALID_INPUT')
    const voices = { ...original?.voices }
    for (const [engine, voice] of Object.entries(patch.voices ?? {})) {
      if (voice) voices[engine] = voice
      else delete voices[engine]
    }
    const next = { id: patch.id, name, gender, age, voices }
    // The narrator constant and rows read before v11 have no age: compare as ''.
    const before = original && { id: original.id, name: original.name, gender: original.gender, age: original.age ?? '', voices: original.voices }
    const created = !exists && patch.id !== narrator.id
    if (json(next) !== json(before) || created) {
      changed.set(next.id, next)
      const voicesChanged = json(next.voices) !== json(before?.voices ?? {})
      const profileChanged = Boolean(before) && (next.gender !== before.gender || next.age !== before.age)
      if (patch.id === narrator.id || profileChanged) bookWide = true
      else if (created || voicesChanged) affected.add(patch.id)
    }
    roles.set(next.id, next)
  }
  for (const role of changed.values()) {
    if (role.id !== narrator.id && role.name !== (get('SELECT name FROM roles WHERE book=? AND id=?', book, role.id)?.name)) {
      const key = roleNameKey(role.name)
      if (key === roleNameKey(narrator.name) || [...roles.values()].some(candidate => candidate.id !== role.id && roleNameKey(candidate.name) === key)) {
        throw fault('ROLE_NAME_EXISTS', { role: role.id })
      }
    }
    run(`INSERT INTO roles(book,id,name,gender,age,voices) VALUES(?,?,?,?,?,?)
      ON CONFLICT(book,id) DO UPDATE SET name=excluded.name,gender=excluded.gender,age=excluded.age,voices=excluded.voices`,
    book, role.id, role.name, role.gender, role.age ?? '', json(role.voices))
  }
  const scope = bookWide ? 'book' : affected.size ? { roles: affected } : 'none'
  return { roles: [...roles.values()], changed: changed.size > 0, scope }
}

function saveProduction({ id, book, base, patch, newId, newBookId, legacy }) {
  if (!id) {
    if (typeof patch.text !== 'string') throw fault('INVALID_INPUT')
    const title = titleOf(patch.title, firstTitle(patch.text))
    const bookId = book ?? newBookId
    if (!book) run('INSERT INTO books(id,title,fingerprint,created,voice_rule) VALUES(?,?,NULL,?,?)', bookId, titleOf(patch.bookTitle, title), Date.now(), VOICE_RULE_LATEST)
    else if (!get('SELECT id FROM books WHERE id=?', bookId)) throw fault('BOOK_NOT_FOUND')
    run(`INSERT INTO chapters(id,book,ordinal,title,text,characters)
      VALUES(?,?,(SELECT coalesce(max(ordinal),0)+1 FROM chapters WHERE book=?),?,?,length(?))`,
    newId, bookId, bookId, title, patch.text, patch.text)
    return { id: newId, book: bookId, rev: 1, editorialResultJob: null,
      rolesRev: get('SELECT roles_rev FROM books WHERE id=?', bookId).roles_rev }
  }
  const current = get('SELECT c.*,b.roles_rev rolesRev FROM chapters c JOIN books b ON b.id=c.book WHERE c.id=?', id)
  if (!current) throw fault('CHAPTER_NOT_FOUND')
  current.editorial = parse(current.editorial)
  const editorialResultJob = current.editorial?.resultJob ?? null
  if ((book && current.book !== book) || current.rev !== base.rev || current.rolesRev !== base.rolesRev ||
      editorialResultJob !== base.editorialResultJob) throw fault('VERSION_CONFLICT', { id, rev: current.rev, rolesRev: current.rolesRev, editorialResultJob })
  const voiceEdit = patch.roles.length > 0
  assertIdle(current.book, voiceEdit ? null : id)
  const { roles, changed, scope } = applyRoles(current.book, patch.roles)
  const text = patch.text ?? current.text
  const title = titleOf(patch.title, current.title)
  if (text !== current.text && patch.editorial !== undefined && !legacy) throw fault('SCRIPT_TEXT_CONFLICT')
  const editorial = text !== current.text ? null : patch.editorial === undefined ? current.editorial
    : validateProductionPatch(current, patch.editorial, roles, !legacy)
  const contentChanged = text !== current.text || json(editorial) !== json(current.editorial)
  const chapterChanged = contentChanged || title !== current.title
  if (chapterChanged) run('UPDATE chapters SET title=?,text=?,characters=length(?),editorial=? WHERE id=?',
    title, text, text, editorial === null ? null : json(editorial), id)
  // Audio keys come from the text, the script and the voices, never the title or
  // a role's name, so a rename keeps every revision. A voice change (or a new
  // role, which is appended and cannot move an earlier role's voice) only
  // revises chapters whose script quotes that role. Gender, age and the
  // narrator still revise the whole book.
  if (changed) run('UPDATE books SET roles_rev=roles_rev+1 WHERE id=?', current.book)
  const bookWide = changed && (!SCOPED_ROLE_REV || scope === 'book')
  let bumped = false
  if (bookWide) {
    run('UPDATE chapters SET rev=rev+1 WHERE book=?', current.book)
    bumped = true
  } else if (contentChanged || scope.roles?.size) {
    const needles = scope.roles ? [...scope.roles].map(roleId => '"roleId":' + JSON.stringify(roleId)) : []
    const roleClause = needles.length ? needles.map(() => "instr(ifnull(editorial,''), ?) > 0").join(' OR ') : '0'
    const args = [current.book]
    const self = contentChanged ? 'id=?' : '0'
    if (contentChanged) args.push(id)
    args.push(...needles)
    run(`UPDATE chapters SET rev=rev+1 WHERE book=? AND (${self} OR ${roleClause})`, ...args)
    bumped = contentChanged || Boolean(get('SELECT 1 hit FROM chapters WHERE id=? AND rev=?', id, current.rev + 1))
  }
  return { id, book: current.book, rev: current.rev + Number(bumped),
    rolesRev: current.rolesRev + Number(changed), editorialResultJob: editorial?.resultJob ?? null }
}

function settings() {
  const row = get('SELECT revision,value FROM settings WHERE id=1')
  const values = { ...defaultSettings, ...parse(row?.value) }
  values.laivoxNarratorDefault ??= defaultSettings.laivoxNarratorDefault
  return { revision: row?.revision ?? 0, values }
}

function saveSettings({ expected, changes }) {
  const current = settings()
  if (expected !== current.revision) throw fault('VERSION_CONFLICT', current)
  const result = { revision: current.revision + 1, values: { ...current.values, ...changes } }
  result.values.laivoxNarratorDefault ??= defaultSettings.laivoxNarratorDefault
  run('INSERT INTO settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,value=excluded.value',
    result.revision, json(result.values))
  return result
}

function prepareBatch({ ids, input }) {
  const meta = db.prepare(`SELECT c.id,c.book,c.title,c.characters,c.rev,b.roles_rev rolesRev,
    json_extract(c.editorial,'$.resultJob') editorialResultJob,
    json_extract(c.editorial,'$.cast') cast,c.editorial IS NOT NULL hasEditorial
    FROM chapters c JOIN books b ON b.id=c.book WHERE c.id=?`)
  const bookRoles = new Map()
  return ids.map(id => {
    const row = meta.get(id)
    if (!row) throw fault('CHAPTER_NOT_FOUND')
    let chapter = { editorial: row.hasEditorial ? {} : null }
    let roles = []
    if (input.mode === 'multi' && !input.clean && (input.purpose ?? 'generate') === 'generate' && row.cast) {
      const stored = get('SELECT text,editorial FROM chapters WHERE id=?', id)
      chapter = { text: stored.text, editorial: parse(stored.editorial) }
      if (!bookRoles.has(row.book)) bookRoles.set(row.book, all('SELECT id FROM roles WHERE book=?', row.book))
      roles = bookRoles.get(row.book)
    }
    const { cast, hasEditorial, ...header } = row
    return { ...header, spec: resolveGenerationOptions(input, chapter, roles) }
  })
}

const estimateChapter = db.prepare(`SELECT c.id,c.book,c.text,c.characters,c.rev,c.editorial,b.roles_rev rolesRev
  FROM chapters c JOIN books b ON b.id=c.book WHERE c.id=?`)
const estimateRoles = db.prepare('SELECT id FROM roles WHERE book=?')

function estimateGroup({ ids, input, cleanWindow, castWindow }) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 16) throw fault('INVALID_INPUT')
  const books = new Map()
  const estimated = ids.map(id => {
    const row = estimateChapter.get(id)
    if (!row) throw fault('CHAPTER_NOT_FOUND')
    let roles = books.get(row.book)
    if (!roles) books.set(row.book, roles = estimateRoles.all(row.book))
    const editorial = row.editorial ? parse(row.editorial) : null
    const chapter = { text: row.text, editorial }
    const resolved = resolveGenerationOptions(input, chapter, roles)
    const spec = input?.retake === true ? { ...resolved, clean: false, cast: false, reuse: true } : resolved
    const provisional = spec.clean && spec.cast
    const removed = spec.clean ? [] : (spec.reuse || spec.purpose === 'cast' ? editorial?.removed ?? [] : [])
    const counts = spec.clean || spec.cast
      ? countAiBatches({ text: row.text, removed, clean: spec.clean, cast: spec.cast, cleanWindow, castWindow, version: SEGMENT_VERSION })
      : { clean: 0, cast: 0, requests: 0 }
    return {
      id: row.id, rev: row.rev, rolesRev: row.rolesRev, editorialResultJob: editorial?.resultJob ?? null,
      characters: row.characters, spec, provisional, clean: counts.clean, cast: counts.cast, requests: counts.requests,
    }
  })
  try { db.exec('PRAGMA shrink_memory') } catch { /* the connection stays usable when the pragma is unavailable */ }
  return estimated
}

parentPort.on('message', ({ id, statements, transaction, close, command, args, receipt }) => {
  try {
    if (close) { db.close(); parentPort.postMessage({ id }); parentPort.close(); return }
    if (transaction) db.exec(transaction === 'read' ? 'BEGIN' : 'BEGIN IMMEDIATE')
    const previous = receipt && operation(receipt)
    let value
    if (previous) value = { replay: true, result: previous }
    else if (command === 'saveProduction') value = saveProduction(args)
    else if (command === 'operation') value = operation(args)
    else if (command === 'settings') value = settings()
    else if (command === 'saveSettings') value = saveSettings(args)
    else if (command === 'prepareBatch') value = prepareBatch(args)
    else if (command === 'estimateGroup') value = estimateGroup(args)
    else if (command === 'propose') {
      if (get("SELECT count(*) total FROM proposals WHERE session=? AND state='pending'", args.session).total >= 10) throw fault('PROPOSAL_LIMIT')
      run("INSERT INTO proposals VALUES(?,?,?,'pending',?)", args.id, args.session, json(args.value), Date.now())
    }
    else if (command === 'addRoles') {
      let inserted = 0
      for (const role of args.roles) inserted += run('INSERT INTO roles(book,id,name,gender,age,voices) VALUES(?,?,?,?,?,?) ON CONFLICT(book,id) DO NOTHING',
        args.book, role.id, role.name, role.gender, ROLE_AGES.includes(role.age) ? role.age : '', '{}').changes
      if (inserted) run('UPDATE books SET roles_rev=roles_rev+1 WHERE id=?', args.book)
    }
    else if (command === 'activeJobsForBook') value = activeJobsForBook(args?.book)
    else if (command === 'setVoiceRule') value = setVoiceRule(args)
    else if (command === 'deleteBook') value = deleteBook(args)
    else if (command === 'deleteSnippet') value = deleteSnippet(args)
    else if (command === 'renameBook') value = renameBook(args)
    else if (command === 'appendChapters') value = appendChapters(args)
    else if (command === 'staleAudio') value = staleAudio(args)
    else if (command === 'configureAudioLimit') value = configureAudioLimit(args)
    else if (command === 'space') value = space()
    else if (command === 'compact') value = compact()
    else if (command === 'compactIfIdle') value = compactIfIdle()
    else if (command === 'keyMeta') value = keyMeta()
    else if (command === 'setKeyMeta') value = setKeyMeta(args)
    else if (command === 'clearKeyMeta') value = clearKeyMeta()
    else if (command === 'sampleSeedState') value = sampleSeedState()
    else if (command === 'seedSamples') value = seedSamples(args)
    else value = statements.map(({ sql, args, mode, expect }) => {
      const result = db.prepare(sql)[mode](...args)
      if (expect !== undefined && result.changes !== expect) throw new Error('VERSION_CONFLICT')
      return result
    })
    if (receipt && !previous) {
      const result = command === 'saveProduction' ? value : value.slice(-args.count).map(row => row.id)
      record(receipt, result)
      value = { replay: false, result, value }
    }
    if (transaction) db.exec('COMMIT')
    parentPort.postMessage({ id, value })
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    parentPort.postMessage({ id, error: error.message, details: error.details })
  }
})
parentPort.postMessage({ ready: true })
