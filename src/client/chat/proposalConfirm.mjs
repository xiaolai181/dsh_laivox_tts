import { translate as t } from '../i18n/locale.mjs'
import { estimateAiCalls } from '../../domain/ai.mjs'

// One summary line for a proposal, shared by the tool card and the dock. It says
// first whether confirming spends DSH model quota.
export function proposalSummary(proposal, edits = {}) {
  const characters = typeof edits.text === 'string' ? edits.text.length : Number(proposal?.characters) || 0
  const clean = edits.clean ?? proposal?.clean === true
  const cast = edits.cast ?? proposal?.cast === true
  const { requests, maximum } = estimateAiCalls({ cleanCharacters: clean ? characters : 0, castCharacters: cast ? characters : 0 })
  const engine = proposal?.engine === 'laivox' ? 'LaiVox' : 'Edge'
  const ai = clean || cast
  const steps = [clean ? t('AI 清洗') : '', cast ? t('AI 编剧') : ''].filter(Boolean).join(' + ')
  return {
    title: proposal?.title || t('待确认朗读'),
    characters,
    usesAi: ai,
    requests,
    maximum,
    mode: ai ? steps : (cast ? t('多角色演绎') : t('单人朗读')),
  }
}

// A production batch from laivox_make: its book, size and how it is made.
export function makeSummary(proposal) {
  const chapters = Number(proposal?.chapters) || 0
  const requests = Number(proposal?.requests) || 0
  const usesAi = proposal?.clean === true || (Number(proposal?.cast) || 0) > 0
  const steps = [proposal?.mode === 'multi' ? t('多角色') : t('单人朗读'), proposal?.clean ? t('AI 清洗') : ''].filter(Boolean).join(' · ')
  return {
    title: proposal?.title ? '《' + proposal.title + '》' : t('制作单'), chapters, usesAi, requests, maximum: Number(proposal?.maximum) || requests,
    engine: proposal?.engine === 'laivox' ? 'LaiVox' : 'Edge', characters: Number(proposal?.characters) || 0,
    titles: Array.isArray(proposal?.titles) ? proposal.titles : [],
    mode: steps,
  }
}

// Confirming is a single request; the card keeps edits on failure and treats
// "already handled" (PROPOSAL_NOT_FOUND) as a final state rather than an error.
export function confirmOutcome(error) {
  if (!error) return { phase: 'done' }
  if (error?.message === 'PROPOSAL_NOT_FOUND') return { phase: 'handled' }
  return { phase: 'failed' }
}

// What a tool card shows for a proposal id: live (still pending in the session
// feed), or a final line read from proposal/state.
export function finalLine(state) {
  if (!state) return null
  if (state.state === 'accepted') return { label: t('已加入队列'), title: state.title, chapter: state.chapter ?? null, job: state.job ?? null }
  if (state.state === 'dismissed') return { label: t('已忽略'), title: state.title }
  return null
}
