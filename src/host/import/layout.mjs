import { createHash } from 'node:crypto'
import { modelUsageTotals } from '../model-usage.mjs'
import { materializeChapters, normalizeCuts } from './chapters.mjs'
import { projectReview, reviewBudget, REVIEW_REQUEST_LIMIT, REVIEW_VERSION } from './review.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')

export function createLayout(parsed, fingerprint, filename, session) {
  const { chapters, cuts, structure, ...meta } = parsed
  const text = chapters.map(chapter => chapter.text).join('')
  return { ...meta, fingerprint, filename, lineage: digest([session ?? '', meta.format, filename.normalize('NFKC').toLowerCase()].join('\0')),
    layout: { text, source: digest(text), cuts, structure, manual: {} } }
}

export function normalizeDraft(data, session) {
  if (data.layout) return data
  let offset = 0
  const cuts = data.chapters.map(chapter => {
    const cut = { offset, title: chapter.title, kind: 'local' }
    offset += chapter.text.length
    return cut
  })
  // Earlier EPUB drafts stored each resource independently without a line break between resources.
  const chapters = data.chapters.map((chapter, index) => ({
    ...chapter, text: data.format === 'epub' && index < data.chapters.length - 1 ? chapter.text + '\n' : chapter.text,
  }))
  if (data.format === 'epub') cuts.forEach((cut, index) => { cut.offset += index })
  return createLayout({ ...data, chapters, cuts, structure: {} }, data.fingerprint,
    data.title + '.' + (data.format === 'txt' || data.format === 'pdf' ? data.format : 'epub'), session)
}

export function resolveLayout(data, review) {
  const { text, cuts, manual, candidates } = data.layout
  const selectedCuts = data.layout.structure?.policyVersion ? normalizeCuts(text, cuts) : cuts
  const active = new Map(selectedCuts.map(cut => [cut.offset, cut]))
  const usedReview = review?.state?.version === REVIEW_VERSION ? review.state : null
  const suggestions = []
  if (candidates && usedReview) {
    for (const candidate of projectReview(text, candidates, usedReview)) {
      if (candidate.kind === 'learned') {
        if (active.size < 4999 && !active.has(candidate.offset)) active.set(candidate.offset, candidate)
      } else if (candidate.offset > 0 && !active.has(candidate.offset) && !Object.hasOwn(manual, candidate.offset)) {
        suggestions.push(candidate)
      }
    }
  }
  for (const [key, override] of Object.entries(manual)) {
    const offset = Number(key)
    if (override) active.set(offset, override)
    else active.delete(offset)
  }
  const chapters = materializeChapters(text, [...active.values()], data.title)
  const revision = digest(data.layout.source + JSON.stringify(chapters.map(({ offset, title, kind }) => [offset, title, kind])))
  const requests = review?.state?.requests ?? 0
  const tokens = modelUsageTotals(usedReview?.tokens, requests)
  return { chapters, revision, suggestions, active,
    ai: { budget: reviewBudget(text), spent: review?.state?.spent ?? 0,
      requests, requestLimit: REVIEW_REQUEST_LIMIT, ...(tokens ? { tokens } : {}) } }
}

export function summary(id, data, review) {
  const { chapters, suggestions, revision, ai } = resolveLayout(data, review)
  const sampleStart = data.layout.structure?.sampleOffset
  const sample = sampleStart === undefined ? chapters[0]?.text.slice(0, 450) ?? ''
    : data.layout.text.slice(sampleStart, sampleStart + 450)
  return { id, title: data.title, format: data.format, encoding: data.encoding, split: data.split, revision, suggestions, ai,
    chapters: chapters.map(({ title, text, offset, kind }) => ({ title, count: text.length, offset, kind })),
    splitCount: chapters.filter(chapter => chapter.splitHead).length,
    warnings: data.warnings, sample }
}
