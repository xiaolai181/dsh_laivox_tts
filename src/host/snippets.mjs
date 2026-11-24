// Conversation readings ("对话音频"): kept like chapters, listed apart from the
// shelf, deleted by the user or after the retention period. Deletion always
// skips a reading that is being made; the sweep never cancels work.
const DAY = 86_400_000
export const RETENTION_DAYS = { '1d': 1, '7d': 7, '30d': 30, never: null }
export const IMPORT_DRAFT_DAYS = 30
export const SWEEP_INTERVAL = 60 * 60 * 1000

export function retentionCutoff(retention, now = Date.now()) {
  // `never` maps to null on purpose, so `??` must not be used to pick the default.
  const days = Object.hasOwn(RETENTION_DAYS, retention) ? RETENTION_DAYS[retention] : RETENTION_DAYS['7d']
  return days === null ? null : now - days * DAY
}

function cleanTitle(value) {
  const title = typeof value === 'string' ? value.trim() : ''
  if (!title || title.length > 180) throw new Error('INVALID_INPUT')
  return title
}

export function createSnippetService({ library, imports, logger }) {
  let sweeping = null
  async function retention() {
    return (await library.settings()).values.snippetRetention ?? '7d'
  }
  async function snippet(book) {
    if (typeof book !== 'string' || !book || !await library.isSnippet(book)) throw new Error('SNIPPET_NOT_FOUND')
  }
  return {
    // Let a running sweep finish before the library closes.
    async dispose() { await sweeping },
    async list(offset = 0) {
      return { ...await library.snippets({ offset }), retention: await retention() }
    },
    async rename(book, title) {
      await snippet(book)
      return library.renameSnippet(book, cleanTitle(title))
    },
    async adopt(book, title) {
      await snippet(book)
      return library.adoptSnippet(book, cleanTitle(title))
    },
    async remove(book) {
      if (typeof book !== 'string' || !book) throw new Error('SNIPPET_NOT_FOUND')
      const result = await library.deleteSnippet(book)
      if (!result) throw new Error('SNIPPET_NOT_FOUND')
      return { ...result, cancelled: 0 }
    },
    // "Delete all" leaves readings that are being made.
    async removeAll() {
      const books = []
      let skipped = 0
      for (const { book } of await library.allSnippets()) {
        try { if (await library.deleteSnippet(book)) books.push(book) }
        catch (error) { if (error?.message === 'JOBS_ACTIVE') skipped++; else throw error }
      }
      return { deleted: books.length, skipped, books }
    },
    async expiring(value) {
      if (!Object.hasOwn(RETENTION_DAYS, value)) throw new Error('INVALID_INPUT')
      const before = retentionCutoff(value)
      return before === null ? { count: 0, audioBytes: 0 } : library.expiringSnippets(before)
    },
    // Runs at start-up and every hour; one at a time. Errors are logged and the
    // next run tries again.
    sweep(now = Date.now()) {
      sweeping ??= (async () => {
        const result = { snippets: 0, imports: 0 }
        try {
          const before = retentionCutoff(await retention(), now)
          if (before !== null) {
            for (const { book } of await library.expiredSnippets(before)) {
              try { if (await library.deleteSnippet(book, now)) result.snippets++ }
              catch (error) { if (error?.message !== 'JOBS_ACTIVE') throw error }
            }
          }
          // A book being parsed holds the import lock: try the drafts next hour.
          try { result.imports = await imports.expire(now - IMPORT_DRAFT_DAYS * DAY) }
          catch (error) { if (error?.message !== 'IMPORT_RUNNING') throw error }
        } catch (error) {
          logger?.warn?.('LaiVox cleanup did not finish: ' + (error?.message ?? error))
        }
        return result
      })().finally(() => { sweeping = null })
      return sweeping
    },
  }
}
