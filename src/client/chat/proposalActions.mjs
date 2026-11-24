import { confirmOutcome } from './proposalConfirm.mjs'

// Confirm and dismiss for every surface that shows a proposal (tool card, dock).
// The in-flight lock is per page and per proposal, so the two surfaces cannot
// submit the same proposal twice; the server's transaction covers other windows.
export function createProposalActions({ get, post, feed }) {
  const inFlight = new Set()
  async function refresh(session) {
    try { feed.replace(session, await get('session', { id: session })) } catch { /* the next poll catches up */ }
  }
  async function run(session, id, action, options) {
    const key = session + '\n' + id
    if (inFlight.has(key)) return { phase: 'busy' }
    inFlight.add(key)
    feed.beginAction(session)
    try {
      await post('proposal/action', { id, session, action, ...(options ? { options } : {}) })
      return { phase: 'done' }
    } catch (error) {
      const outcome = confirmOutcome(error)
      if (outcome.phase === 'failed') throw error
      return outcome
    } finally {
      inFlight.delete(key)
      await refresh(session)
      feed.endAction(session)
    }
  }
  return {
    confirm: (session, id, options) => run(session, id, 'confirm', options),
    preview: (session, id, options, signal) => post('proposal/action', { id, session, action: 'preview', ...(options ? { options } : {}) }, false, signal),
    dismiss: (session, id) => run(session, id, 'dismiss'),
    state: (session, id, signal) => get('proposal/state', { id, session }, signal),
    busy: (session, id) => inFlight.has(session + '\n' + id),
  }
}
