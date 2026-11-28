export const NOTE_QUOTE_LIMIT = 2000
export const NOTE_BODY_LIMIT = 4000
export const NOTE_SPEAKER_LIMIT = 120
export const BOOK_NOTES_LIMIT = 5000

export function formatNotesMarkdown(bookTitle, notes) {
  const title = String(bookTitle || '未命名书籍').trim()
  const lines = [`# ${title} · 听书笔记`, '']
  if (!Array.isArray(notes) || !notes.length) {
    lines.push('暂无批注。', '')
    return lines.join('\n')
  }
  const byChapter = new Map()
  for (const note of notes) {
    const key = note.chapter || ''
    if (!byChapter.has(key)) {
      byChapter.set(key, {
        ordinal: note.ordinal ?? 0,
        chapterTitle: note.chapterTitle || '未命名章节',
        items: [],
      })
    }
    byChapter.get(key).items.push(note)
  }
  const sections = [...byChapter.values()].sort((a, b) => a.ordinal - b.ordinal)
  for (const section of sections) {
    lines.push(`## 第 ${section.ordinal} 章 ${section.chapterTitle}`, '')
    const sorted = [...section.items].sort((a, b) => (a.charOffset - b.charOffset) || (a.created - b.created))
    for (const item of sorted) {
      const stamp = item.created ? new Date(item.created).toISOString().slice(0, 16).replace('T', ' ') : ''
      const meta = [item.speaker ? `**${item.speaker}**` : '', stamp].filter(Boolean).join(' · ')
      if (meta) lines.push(`- ${meta}`)
      const quoted = String(item.quote ?? '').split(/\r?\n/u).map(line => `> ${line}`).join('\n')
      lines.push(quoted, '')
      if (item.body && item.body.trim()) {
        lines.push(item.body.trim(), '')
      }
    }
  }
  return lines.join('\n')
}
