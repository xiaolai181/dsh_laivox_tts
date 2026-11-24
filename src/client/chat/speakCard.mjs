import { readResultText, readToolArgs } from './proposeCard.mjs'

// The laivox_speak result sentence starts "已开始朗读 <id> · <n> 段 · <m> 字".
const started = /^已开始朗读 ([A-Za-z0-9_-]{6,64}) · (\d+) 段 · (\d+) 字/u

// What the laivox_speak tool card knows: the host's phase, the arguments (the
// text, for "read again") and the rendered result (the reading's id).
export function speakView({ phase, block } = {}) {
  const stage = phase ?? block?.phase
  const args = readToolArgs(block)
  const text = typeof args?.text === 'string' ? args.text : ''
  if (stage !== 'result') return { kind: 'running', text }
  const result = readResultText(block)
  const match = started.exec(result)
  if (!match) return { kind: 'failed', text, detail: result.trim().slice(0, 200) }
  return { kind: 'started', text, speechId: match[1], parts: Number(match[2]), characters: Number(match[3]) }
}
