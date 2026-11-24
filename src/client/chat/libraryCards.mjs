import { readResultText } from './proposeCard.mjs'

// laivox_add_chapters: "已添加 <n> 章 · book=<id> · first=<id|-> · 跳过 <m> 章 · 《<title>》"
const added = /^已添加 (\d+) 章 · book=([\w-]+) · first=([\w-]+) · 跳过 (\d+) 章 · 《(.*?)》/u
// laivox_import_file: "已生成导入预览 <uuid> · <n> 章 · <m> 字 · 《<title>》"
const staged = /^已生成导入预览 ([0-9a-f-]{36}) · (\d+) 章 · (\d+) 字 · 《(.*?)》/u

// The tool cards only get the host's phase and the rendered result sentence.
export function addChaptersView({ phase, block } = {}) {
  const stage = phase ?? block?.phase
  if (stage !== 'result') return { kind: 'running' }
  const text = readResultText(block)
  const match = added.exec(text)
  if (!match) return { kind: 'failed', detail: text.trim().slice(0, 200) }
  return { kind: 'added', count: Number(match[1]), book: match[2], first: match[3] === '-' ? null : match[3], skipped: Number(match[4]), title: match[5] }
}

export function importFileView({ phase, block } = {}) {
  const stage = phase ?? block?.phase
  if (stage !== 'result') return { kind: 'running' }
  const text = readResultText(block)
  const match = staged.exec(text)
  if (!match) return { kind: 'failed', detail: text.trim().slice(0, 200) }
  return { kind: 'staged', id: match[1], chapters: Number(match[2]), characters: Number(match[3]), title: match[4] }
}
