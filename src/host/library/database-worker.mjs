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
import { buildPreviewExcerpt, computeProgressPercent, extractSpeakerLines, matchChapterByQuery, matchRoleIds, resolvePlaybackCutoff } from '../../domain/companion.mjs'
import { BOOK_NOTES_LIMIT, NOTE_BODY_LIMIT, NOTE_QUOTE_LIMIT, NOTE_SPEAKER_LIMIT } from '../../domain/notes.mjs'

const db = new DatabaseSync(workerData)
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=4000')
db.exec('BEGIN IMMEDIATE')
const version = db.prepare('PRAGMA user_version').get().user_version
if (version > 13) throw new Error('LIBRARY_VERSION_UNSUPPORTED')
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
// v13: listening notes & highlighted quotes, cascaded with books/chapters
// without pinning stale audio.
if (version < 13) {
  db.exec([
    `CREATE TABLE IF NOT EXISTS notes(
      id TEXT PRIMARY KEY,
      book TEXT NOT NULL REFERENCES books ON DELETE CASCADE,
      chapter TEXT NOT NULL REFERENCES chapters ON DELETE CASCADE,
      part_index INTEGER NOT NULL DEFAULT 0,
      char_offset INTEGER NOT NULL DEFAULT 0,
      quote TEXT NOT NULL,
      speaker TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL
    )`,
    'CREATE INDEX IF NOT EXISTS notes_book ON notes(book, created DESC)',
    'CREATE INDEX IF NOT EXISTS notes_chapter ON notes(chapter, char_offset)',
    'PRAGMA user_version=13',
  ].join(';'))
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
  // Same book-wide revision as a gender or age change, so existing audio reads as
  // out of date. Chapters whose voices did not move still reuse their audio.
  run('UPDATE chapters SET rev=rev+1 WHERE book=?', book)
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
    const playback = parse(chapter.playback)
    const pinnedJobs = [...new Set([playback?.job, playback?.bookmark?.job].filter(id => typeof id === 'string' && id))]
    for (const pinned of pinnedJobs) {
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
  run("DELETE FROM operations WHERE kind='import-append' AND json_extract(result,'$.book')=?", book)
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

function progressStateForBook(bookId) {
  const chapters = all('SELECT id,ordinal,title,characters FROM chapters WHERE book=? ORDER BY ordinal', bookId)
  const latest = get(`SELECT c.id,c.ordinal,c.title,c.text,c.editorial,c.playback
    FROM chapters c WHERE c.book=? AND c.playback IS NOT NULL
    ORDER BY coalesce(json_extract(c.playback,'$.at'),0) DESC, c.ordinal DESC LIMIT 1`, bookId)
  if (!latest) return { chapters, progressRow: null, progressOrdinal: 0, cutoff: 0, percent: 0 }
  const playback = parse(latest.playback)
  let jobParts = null
  if (typeof playback?.job === 'string' && playback.job) {
    const jobRow = get('SELECT progress FROM jobs WHERE id=? AND chapter=?', playback.job, latest.id)
    jobParts = parse(jobRow?.progress)?.parts ?? null
  }
  const cutoff = resolvePlaybackCutoff(latest.text, playback, parse(latest.editorial), jobParts)
  const percent = computeProgressPercent(chapters, latest.ordinal, cutoff, latest.text.length)
  return { chapters, progressRow: latest, progressOrdinal: latest.ordinal, cutoff, percent, jobParts }
}

function recentListeningBook() {
  const row = get(`SELECT b.id,b.title,c.id currentChapterId,c.title currentChapterTitle,c.ordinal currentOrdinal
    FROM chapters c JOIN books b ON b.id=c.book
    WHERE c.playback IS NOT NULL AND NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)
    ORDER BY coalesce(json_extract(c.playback,'$.at'),0) DESC, b.created DESC, c.ordinal DESC LIMIT 1`)
  if (row) {
    const { percent } = progressStateForBook(row.id)
    return { ...row, percent }
  }
  const fallback = get(`SELECT b.id,b.title FROM books b
    WHERE NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)
    ORDER BY b.created DESC, b.id LIMIT 1`)
  return fallback ? { ...fallback, currentChapterId: null, currentChapterTitle: null, currentOrdinal: null, percent: 0 } : null
}

function resolveBookTarget(bookId) {
  const id = typeof bookId === 'string' && bookId.trim() ? bookId.trim() : recentListeningBook()?.id
  if (!id) throw fault('BOOK_NOT_FOUND')
  const book = get('SELECT id,title FROM books b WHERE id=? AND NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)', id)
  if (!book) throw fault('BOOK_NOT_FOUND')
  return book
}

function rolesForBook(bookId) {
  return all('SELECT id,name,gender,age FROM roles WHERE book=? ORDER BY rowid', bookId)
}

function chapterReadingContext({ book, chapter, mode = 'recent', limit = 3000, allowSpoilers = false } = {}) {
  const targetBook = resolveBookTarget(book)
  const cap = Math.min(12000, Math.max(200, Number.isSafeInteger(limit) ? limit : 3000))
  const state = progressStateForBook(targetBook.id)
  if (!state.chapters.length) throw fault('CHAPTER_NOT_FOUND')
  const roles = rolesForBook(targetBook.id)
  const roleMap = new Map(roles.map(role => [role.id, role]))
  const hasExplicitChapter = typeof chapter === 'string' && chapter.trim() !== ''
  const useChapter = hasExplicitChapter ? matchChapterByQuery(state.chapters, chapter) : null
  if (hasExplicitChapter && !useChapter) throw fault('CHAPTER_NOT_FOUND')
  const targetMeta = (mode === 'chapter' || hasExplicitChapter) && useChapter
    ? useChapter
    : state.chapters.find(row => row.ordinal === state.progressOrdinal) ?? state.chapters[0]
  const target = get('SELECT id,ordinal,title,text,editorial,playback FROM chapters WHERE id=?', targetMeta.id)
  if (!target) throw fault('CHAPTER_NOT_FOUND')
  const spoilerAhead = !allowSpoilers && (
    (state.progressOrdinal > 0 && target.ordinal > state.progressOrdinal) ||
    (state.progressOrdinal === 0 && target.ordinal > 1)
  )
  if (spoilerAhead) {
    return {
      spoilerBlocked: true,
      book: targetBook.id,
      bookTitle: targetBook.title,
      chapter: target.id,
      chapterTitle: target.title,
      ordinal: target.ordinal,
      progressOrdinal: state.progressOrdinal,
      progressTitle: state.progressRow?.title ?? null,
      percent: state.percent,
      roles,
    }
  }
  const editorial = parse(target.editorial)
  let maxEnd = target.text.length
  if (!allowSpoilers) {
    if (state.progressOrdinal > 0 && target.ordinal === state.progressOrdinal) maxEnd = state.cutoff
    else if (state.progressOrdinal === 0 && target.ordinal === 1) maxEnd = Math.min(target.text.length, Math.min(cap, 400))
  }
  const within = target.text.slice(0, maxEnd)
  const excerpt = within.length > cap ? within.slice(within.length - cap) : within
  let previousExcerpt = ''
  if (excerpt.length < cap && target.ordinal > 1) {
    const prevMeta = state.chapters.find(row => row.ordinal === target.ordinal - 1)
    if (prevMeta) {
      const prevRow = get('SELECT title,text FROM chapters WHERE id=?', prevMeta.id)
      const remain = cap - excerpt.length
      if (prevRow?.text) previousExcerpt = prevRow.text.slice(Math.max(0, prevRow.text.length - remain))
    }
  }
  let speakerLines = []
  if (maxEnd > 0) {
    if (editorial) {
      speakerLines = extractSpeakerLines(target.text, editorial, roleMap, maxEnd, 80)
    } else {
      const jobRow = get(`SELECT j.progress FROM jobs j WHERE ${completeAudioJobWhere} ORDER BY j.created DESC,j.rowid DESC LIMIT 1`, target.id)
      const parts = parse(jobRow?.progress)?.parts ?? []
      speakerLines = parts.filter(p => Number.isFinite(p.start) && p.start < maxEnd).slice(0, 80).flatMap(p => {
        const end = Number.isFinite(p.end) ? Math.min(p.end, maxEnd) : maxEnd
        const maxLen = Math.max(0, end - p.start)
        const slice = end > p.start ? target.text.slice(p.start, end).trim() : ''
        const text = slice || String(p.text ?? '').slice(0, maxLen).trim()
        if (!text) return []
        return [{
          id: p.id, start: p.start, end,
          roleId: p.roleId ?? 'narrator',
          speaker: roleMap.get(p.roleId)?.name ?? (p.roleId === 'narrator' || !p.roleId ? '旁白' : p.roleId),
          emotion: p.emotion ?? 'neutral',
          text,
        }]
      })
    }
  }
  return {
    spoilerBlocked: false,
    book: targetBook.id,
    bookTitle: targetBook.title,
    chapter: target.id,
    chapterTitle: target.title,
    ordinal: target.ordinal,
    progressOrdinal: state.progressOrdinal,
    progressTitle: state.progressRow?.title ?? null,
    percent: state.percent,
    hasStarted: state.progressOrdinal > 0,
    truncatedToOffset: maxEnd,
    excerpt,
    previousExcerpt,
    speakerLines,
    roles,
  }
}

function searchBookContent({ book, query = '', roleName = '', limit = 40, allowSpoilers = false } = {}) {
  const targetBook = resolveBookTarget(book)
  const cleanQuery = typeof query === 'string' ? query.trim() : ''
  const cleanRole = typeof roleName === 'string' ? roleName.trim() : ''
  if (!cleanQuery && !cleanRole) throw fault('INVALID_INPUT')
  const capLimit = Math.min(40, Math.max(1, Number.isSafeInteger(limit) ? limit : 40))
  const state = progressStateForBook(targetBook.id)
  const roles = rolesForBook(targetBook.id)
  const roleMap = new Map(roles.map(role => [role.id, role]))
  const matchedRoles = cleanRole ? matchRoleIds(roles, cleanRole) : null
  const roleNeedles = matchedRoles ? [...matchedRoles].map(id => `"roleId":${JSON.stringify(id)}`) : []
  const needleLower = cleanQuery.toLowerCase()
  const hits = []
  let totalChars = 0
  const stmt = db.prepare('SELECT id,ordinal,title,text,editorial FROM chapters WHERE book=? ORDER BY ordinal')
  for (const row of stmt.iterate(targetBook.id)) {
    if (hits.length >= capLimit || totalChars >= 12000) break
    const isAhead = offset => state.progressOrdinal === 0 ? row.ordinal > 1
      : (row.ordinal > state.progressOrdinal || (row.ordinal === state.progressOrdinal && offset >= state.cutoff))
    if (cleanRole) {
      let matchedAnySpeaker = false
      if (row.editorial && roleNeedles.some(needle => row.editorial.includes(needle))) {
        matchedAnySpeaker = true
        const editorial = parse(row.editorial)
        const lines = extractSpeakerLines(row.text, editorial, roleMap, row.text.length, 500)
        for (const line of lines) {
          if (!matchedRoles.has(line.roleId)) continue
          if (cleanQuery && !line.text.toLowerCase().includes(needleLower)) continue
          const ahead = isAhead(line.start)
          const excerpt = !allowSpoilers && ahead ? '' : line.text.slice(0, 200)
          hits.push({ chapterId: row.id, ordinal: row.ordinal, chapterTitle: row.title, start: line.start, speaker: line.speaker, excerpt, aheadOfProgress: ahead })
          totalChars += excerpt.length
          if (hits.length >= capLimit || totalChars >= 12000) break
        }
      }
      if (!matchedAnySpeaker && !cleanQuery && row.text.includes(cleanRole)) {
        const idx = row.text.indexOf(cleanRole)
        const ahead = isAhead(idx)
        const excerpt = !allowSpoilers && ahead ? '' : buildPreviewExcerpt(row.text, idx, 60)
        hits.push({ chapterId: row.id, ordinal: row.ordinal, chapterTitle: row.title, start: idx, speaker: cleanRole, excerpt, aheadOfProgress: ahead })
        totalChars += excerpt.length
      }
      continue
    }
    const lowerText = row.text.toLowerCase()
    const idx = lowerText.indexOf(needleLower)
    if (idx < 0) continue
    let speaker = null
    if (row.editorial) {
      const editorial = parse(row.editorial)
      const lines = extractSpeakerLines(row.text, editorial, roleMap, row.text.length, 500)
      const hitLine = lines.find(line => idx >= line.start && idx < line.end)
      if (hitLine) speaker = hitLine.speaker
    }
    const ahead = isAhead(idx)
    const excerpt = !allowSpoilers && ahead ? '' : buildPreviewExcerpt(row.text, idx, 60)
    hits.push({ chapterId: row.id, ordinal: row.ordinal, chapterTitle: row.title, start: idx, speaker, excerpt, aheadOfProgress: ahead })
    totalChars += excerpt.length
  }
  return { book: targetBook.id, bookTitle: targetBook.title, progressOrdinal: state.progressOrdinal, percent: state.percent, hits, totalHits: hits.length }
}

function locateChapterPosition({ book, chapter, query } = {}) {
  const targetBook = resolveBookTarget(book)
  const chapters = all('SELECT id,ordinal,title FROM chapters WHERE book=? ORDER BY ordinal', targetBook.id)
  if (!chapters.length) throw fault('CHAPTER_NOT_FOUND')
  const cleanChapter = typeof chapter === 'string' ? chapter.trim() : ''
  const cleanQuery = typeof query === 'string' ? query.trim() : ''
  let targetMeta = cleanChapter ? matchChapterByQuery(chapters, cleanChapter) : null
  if (cleanChapter && !targetMeta) throw fault('CHAPTER_NOT_FOUND')
  let start = 0
  let preview = ''
  if (targetMeta) {
    const row = get('SELECT id,ordinal,title,text FROM chapters WHERE id=?', targetMeta.id)
    if (cleanQuery) {
      const idx = row.text.toLowerCase().indexOf(cleanQuery.toLowerCase())
      if (idx >= 0) start = idx
    }
    preview = buildPreviewExcerpt(row.text, start, 60)
    return { book: targetBook.id, bookTitle: targetBook.title, chapter: row.id, chapterTitle: row.title, ordinal: row.ordinal, start, preview }
  }
  if (cleanQuery) {
    const needle = cleanQuery.toLowerCase()
    const stmt = db.prepare('SELECT id,ordinal,title,text FROM chapters WHERE book=? ORDER BY ordinal')
    for (const row of stmt.iterate(targetBook.id)) {
      const idx = row.text.toLowerCase().indexOf(needle)
      if (idx >= 0) {
        return { book: targetBook.id, bookTitle: targetBook.title, chapter: row.id, chapterTitle: row.title, ordinal: row.ordinal, start: idx, preview: buildPreviewExcerpt(row.text, idx, 60) }
      }
    }
    throw fault('CHAPTER_NOT_FOUND')
  }
  const state = progressStateForBook(targetBook.id)
  const currentMeta = state.chapters.find(row => row.ordinal === state.progressOrdinal) ?? chapters[0]
  const row = get('SELECT id,ordinal,title,text FROM chapters WHERE id=?', currentMeta.id)
  return { book: targetBook.id, bookTitle: targetBook.title, chapter: row.id, chapterTitle: row.title, ordinal: row.ordinal, start: 0, preview: buildPreviewExcerpt(row.text, 0, 60) }
}

const normImportKey = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, '').toLowerCase()
const textDigest = value => createHash('sha256').update(String(value ?? '').trimEnd()).digest('hex')

function findRelatedBook({ fingerprint, title, chapters } = {}) {
  if (fingerprint && get('SELECT id FROM books WHERE fingerprint=? LIMIT 1', fingerprint)) return null
  if (!Array.isArray(chapters) || !chapters.length) return null
  const sample = chapters.slice(0, 3).map(ch => ({
    title: normImportKey(ch.title),
    lead: normImportKey(String(ch.text ?? '').slice(0, 80)),
  }))
  const targetTitle = normImportKey(title)
  const candidates = all(`SELECT id,title FROM books b
    WHERE NOT EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id)
    ORDER BY created DESC, id LIMIT 200`)
  for (const cand of candidates) {
    const firstRows = all('SELECT title,text FROM chapters WHERE book=? ORDER BY ordinal LIMIT 3', cand.id)
    if (!firstRows.length) continue
    let headMatches = 0
    for (let i = 0; i < Math.min(firstRows.length, sample.length); i++) {
      const a = normImportKey(firstRows[i].title)
      const b = sample[i].title
      const leadA = normImportKey(String(firstRows[i].text ?? '').slice(0, 80))
      const leadB = sample[i].lead
      if (a && a === b && (!leadA || !leadB || leadA.slice(0, 40) === leadB.slice(0, 40))) headMatches++
    }
    const candTitle = normImportKey(cand.title)
    const titleRelated = Boolean(targetTitle && candTitle && (candTitle === targetTitle || candTitle.includes(targetTitle) || targetTitle.includes(candTitle)))
    const requiredHeads = Math.min(firstRows.length, sample.length, 2)
    if (headMatches < requiredHeads && !(titleRelated && headMatches >= 1)) continue
    const existingRows = all('SELECT title,text FROM chapters WHERE book=?', cand.id)
    const existingKeys = new Set(existingRows.map(r => r.title + '|' + textDigest(r.text)))
    const seen = new Set()
    let newCount = 0
    for (const ch of chapters) {
      const k = ch.title + '|' + textDigest(ch.text)
      if (!existingKeys.has(k) && !seen.has(k)) {
        seen.add(k)
        newCount++
      }
    }
    if (newCount > 0) {
      return { id: cand.id, title: cand.title, existingChapters: existingRows.length, newChaptersCount: newCount }
    }
  }
  return null
}

function mergeBookChapters({ id, session, targetBook, chapters } = {}) {
  if (typeof id !== 'string' || !id || typeof targetBook !== 'string' || !targetBook || !Array.isArray(chapters)) throw fault('INVALID_INPUT')
  const draft = get('SELECT session FROM imports WHERE id=?', id)
  if (!draft || draft.session !== (session ?? null)) throw fault('IMPORT_NOT_FOUND')
  const book = get('SELECT id,title,EXISTS(SELECT 1 FROM chat_readings WHERE book=b.id) snippet FROM books b WHERE id=?', targetBook)
  if (!book) throw fault('BOOK_NOT_FOUND')
  if (book.snippet) throw fault('INVALID_INPUT')
  const existingRows = all('SELECT title,text FROM chapters WHERE book=?', targetBook)
  const existingKeys = new Set(existingRows.map(r => r.title + '|' + textDigest(r.text)))
  const seen = new Set()
  const toAdd = []
  for (const ch of chapters) {
    const k = ch.title + '|' + textDigest(ch.text)
    if (existingKeys.has(k) || seen.has(k)) continue
    seen.add(k)
    toAdd.push(ch)
  }
  if (existingRows.length + toAdd.length > 5000) throw fault('IMPORT_TOO_MANY_CHAPTERS')
  const appended = toAdd.length ? appendChapters({ book: targetBook, chapters: toAdd }) : { added: [], skipped: 0 }
  run('DELETE FROM imports WHERE id=?', id)
  run('INSERT INTO published_imports VALUES(?,?)', id, session ?? null)
  run('INSERT OR REPLACE INTO operations(id,kind,digest,result,created) VALUES(?,?,?,?,?)',
    'import-target:' + id, 'import-append', session ?? '', json({ book: targetBook }), Date.now())
  return { id: targetBook, added: appended.added.length, skipped: chapters.length - toAdd.length, appended: true }
}

const noteProjection = `SELECT n.id,n.book,n.chapter,n.part_index partIndex,n.char_offset charOffset,n.quote,n.speaker,n.body,n.created,n.updated,
  c.title chapterTitle,c.ordinal,b.title bookTitle
  FROM notes n JOIN chapters c ON c.id=n.chapter JOIN books b ON b.id=n.book`

function listNotes({ book, chapter, q = '', limit = 100, offset = 0 } = {}) {
  const scope = []
  const args = []
  if (typeof book === 'string' && book.trim()) { scope.push('n.book=?'); args.push(book.trim()) }
  if (typeof chapter === 'string' && chapter.trim()) { scope.push('n.chapter=?'); args.push(chapter.trim()) }
  const cleanQ = typeof q === 'string' ? q.trim() : ''
  if (cleanQ) {
    const pattern = '%' + cleanQ.replace(/[\\%_]/gu, '\\$&') + '%'
    scope.push("(n.quote LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.speaker LIKE ? ESCAPE '\\')")
    args.push(pattern, pattern, pattern)
  }
  const where = scope.length ? ' WHERE ' + scope.join(' AND ') : ''
  const cap = Math.min(500, Math.max(1, Number.isSafeInteger(limit) ? limit : 100))
  const off = Math.max(0, Number.isSafeInteger(offset) ? offset : 0)
  const notes = all(noteProjection + where + ' ORDER BY n.created DESC, n.id LIMIT ? OFFSET ?', ...args, cap, off)
  const total = get('SELECT count(*) total FROM notes n' + where, ...args)?.total ?? 0
  return { notes, total }
}

function saveNote({ id, book, chapter, partIndex = 0, charOffset = 0, quote, speaker = '', body = '' } = {}) {
  const now = Date.now()
  if (typeof id === 'string' && id.trim()) {
    const noteId = id.trim()
    const existing = get('SELECT * FROM notes WHERE id=?', noteId)
    if (!existing) throw fault('NOTE_NOT_FOUND')
    const nextQuote = quote !== undefined ? String(quote ?? '').trim() : existing.quote
    const nextBody = body !== undefined ? String(body ?? '').trim() : existing.body
    const nextSpeaker = speaker !== undefined ? String(speaker ?? '').trim() : existing.speaker
    if (!nextQuote || [...nextQuote].length > NOTE_QUOTE_LIMIT || [...nextBody].length > NOTE_BODY_LIMIT || [...nextSpeaker].length > NOTE_SPEAKER_LIMIT) {
      throw fault('INVALID_INPUT')
    }
    run('UPDATE notes SET quote=?,speaker=?,body=?,updated=? WHERE id=?', nextQuote, nextSpeaker, nextBody, now, noteId)
    return get(noteProjection + ' WHERE n.id=?', noteId)
  }
  if (typeof chapter !== 'string' || !chapter.trim()) throw fault('INVALID_INPUT')
  const chapRow = get(`SELECT c.id,c.book,EXISTS(SELECT 1 FROM chat_readings WHERE book=c.book) snippet
    FROM chapters c WHERE c.id=?`, chapter.trim())
  if (!chapRow) throw fault('CHAPTER_NOT_FOUND')
  if (chapRow.snippet) throw fault('INVALID_INPUT')
  if (typeof book === 'string' && book.trim() && book.trim() !== chapRow.book) throw fault('BOOK_NOT_FOUND')
  const cleanQuote = typeof quote === 'string' ? quote.trim() : ''
  const cleanBody = typeof body === 'string' ? body.trim() : ''
  const cleanSpeaker = typeof speaker === 'string' ? speaker.trim() : ''
  if (!cleanQuote || [...cleanQuote].length > NOTE_QUOTE_LIMIT || [...cleanBody].length > NOTE_BODY_LIMIT || [...cleanSpeaker].length > NOTE_SPEAKER_LIMIT) {
    throw fault('INVALID_INPUT')
  }
  const part = Number.isSafeInteger(partIndex) && partIndex >= 0 ? partIndex : 0
  const offset = Number.isSafeInteger(charOffset) && charOffset >= 0 ? charOffset : 0
  const count = get('SELECT count(*) total FROM notes WHERE book=?', chapRow.book)?.total ?? 0
  if (count >= BOOK_NOTES_LIMIT) throw fault('NOTES_LIMIT')
  const noteId = randomUUID()
  run('INSERT INTO notes(id,book,chapter,part_index,char_offset,quote,speaker,body,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)',
    noteId, chapRow.book, chapRow.id, part, offset, cleanQuote, cleanSpeaker, cleanBody, now, now)
  return get(noteProjection + ' WHERE n.id=?', noteId)
}

function deleteNote({ id } = {}) {
  if (typeof id !== 'string' || !id.trim()) throw fault('INVALID_INPUT')
  const noteId = id.trim()
  const { changes } = run('DELETE FROM notes WHERE id=?', noteId)
  if (!changes) throw fault('NOTE_NOT_FOUND')
  return { id: noteId, deleted: true }
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
    else if (command === 'recentListeningBook') value = recentListeningBook()
    else if (command === 'chapterReadingContext') value = chapterReadingContext(args)
    else if (command === 'searchBookContent') value = searchBookContent(args)
    else if (command === 'locateChapterPosition') value = locateChapterPosition(args)
    else if (command === 'findRelatedBook') value = findRelatedBook(args)
    else if (command === 'mergeBookChapters') value = mergeBookChapters(args)
    else if (command === 'listNotes') value = listNotes(args)
    else if (command === 'saveNote') value = saveNote(args)
    else if (command === 'deleteNote') value = deleteNote(args)
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
