export const SAMPLE_PACK_ID = 'builtin-v1'
export const SAMPLE_FORMAT_VERSION = 1
export const SAMPLE_MIGRATION_PREFIX = 'sample-pack:'

export const SAMPLE_BOOKS = [
  {
    slug: 'shexi',
    bookId: 'sample-book-shexi-v1',
    chapterId: 'sample-chapter-shexi-v1',
    jobId: 'sample-job-shexi-v1',
    defaultTitle: '社戏 · 月夜行船 · Edge',
    engine: 'edge',
    mode: 'reading',
  },
  {
    slug: 'oz-tinman',
    bookId: 'sample-book-oz-tinman-v1',
    chapterId: 'sample-chapter-oz-tinman-v1',
    jobId: 'sample-job-oz-tinman-v1',
    defaultTitle: '绿野仙踪 · 营救铁皮人 · LaiVox',
    engine: 'laivox',
    mode: 'multi',
  },
]

export const SAMPLE_BOOK_IDS = SAMPLE_BOOKS.map(item => item.bookId)
