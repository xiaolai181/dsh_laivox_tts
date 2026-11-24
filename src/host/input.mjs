export function checkedText(value) {
  if (typeof value !== 'string' || value.length > 4 * 1024 ** 2) throw new Error('TEXT_TOO_LONG')
  const text = value.replace(/\r\n?/gu, '\n').replace(/^\uFEFF/u, '')
  if (!text.trim()) throw new Error('CHAPTER_EMPTY')
  return text
}

export function firstTitle(text) {
  return (text.trim().split('\n')[0].slice(0, 28) || '未命名章节').trim()
}

export function titleOf(value, existing) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 180) : existing
}

// What a handled (confirmed or dismissed) proposal keeps: its summary, not the
// text. The confirmed text already lives in its chapter.
export function proposalSummary(payload) {
  const value = payload && typeof payload === 'object' ? payload : {}
  // A make proposal drops its enqueue input and chapter list.
  if (value.kind === 'make') {
    const { input: _input, chapters: _chapters, ...rest } = value
    return { ...rest, chapters: Array.isArray(value.chapters) ? value.chapters.length : value.chapters ?? 0 }
  }
  const text = typeof value.text === 'string' ? value.text : null
  const { text: _text, ...rest } = value
  return { ...rest, title: text ? firstTitle(text) : value.title ?? '', characters: text ? text.length : value.characters ?? 0 }
}
