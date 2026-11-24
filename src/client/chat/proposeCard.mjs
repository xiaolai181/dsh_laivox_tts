import { estimateAiCalls } from '../../domain/ai.mjs'
import { firstTitle } from '../../host/input.mjs'

const proposalText = /^已创建待确认提案 ([0-9a-f]{12})。([\s\S]*)$/u
const proposalDetail = /《(.+?)》· (\d+) 字 · 预计 (\d+) 次请求 · (Edge|LaiVox)/u

export function readToolArgs(block) {
  if (!block || (!('kind' in block) && block.phase === 'preparing')) return null
  const raw = typeof block.argsRaw === 'string' ? block.argsRaw : block.call?.argsRaw
  if (typeof raw !== 'string' || !raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch { return null }
}

export function readResultText(block) {
  if (!Array.isArray(block?.content)) return ''
  return block.content.filter(item => item?.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n')
}

function summaryFromText(text, clean, cast) {
  const { requests } = estimateAiCalls({
    cleanCharacters: clean ? text.length : 0,
    castCharacters: cast ? text.length : 0,
  })
  return { title: firstTitle(text), characters: text.length, requests, clean: clean === true, cast: cast === true }
}

function summaryFromResult(text) {
  const head = proposalText.exec(text)
  if (!head) return null
  const detail = proposalDetail.exec(head[2])
  if (!detail) return { id: head[1] }
  return {
    id: head[1], title: detail[1], characters: Number(detail[2]), requests: Number(detail[3]),
    engine: detail[4] === 'LaiVox' ? 'laivox' : 'edge',
    ...(/ · (?:AI 清洗|AI 编剧|单人朗读)/u.test(text) ? { clean: text.includes(' · AI 清洗'), cast: text.includes(' · AI 编剧') } : {}),
  }
}

// The tool card only receives the host's phase, arguments and rendered result.
// Older results contain just the proposal id, so the card still has a sentence.
export function proposeView({ phase, block } = {}) {
  const stage = phase ?? block?.phase
  if (stage === 'preparing' || (!block && stage !== 'result' && stage !== 'start')) return { kind: 'preparing' }
  const args = readToolArgs(block)
  const fromArgs = args && typeof args.text === 'string' ? summaryFromText(args.text, args.clean, args.cast) : null
  const fromResult = summaryFromResult(readResultText(block))
  if (stage === 'result' && !fromResult) return { kind: 'unavailable' }
  if (fromResult?.title || fromArgs) {
    return { kind: 'summary', ...fromArgs, ...fromResult,
      clean: fromResult?.clean ?? fromArgs?.clean === true, cast: fromResult?.cast ?? fromArgs?.cast === true }
  }
  if (fromResult?.id) return { kind: 'id', id: fromResult.id }
  return stage === 'result' ? { kind: 'id', id: '' } : { kind: 'preparing' }
}
