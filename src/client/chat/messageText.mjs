// The prose of one finalized assistant message, by the messageId the
// assistant-actions seat passes. DSH renders that seat from the turn's
// tail node: `data.closing.finalNode.messageId` is the id, and the host's own
// copy button reads the `text` blocks of `data.closing.blocks` — the same text
// is used here. Finalized messages do not change, so a found text is cached.
const found = new Map()
const CACHE_LIMIT = 500

export function messageText(snapshot, messageId) {
  if (!messageId) return ''
  const cached = found.get(messageId)
  if (cached !== undefined) return cached
  let nodes
  try { nodes = snapshot?.nodes?.values?.() ?? [] } catch { return '' }
  for (const node of nodes) {
    if (node?.kind !== 'turn-tail') continue
    const closing = node.data?.closing
    if (closing?.finalNode?.messageId !== messageId) continue
    const text = (Array.isArray(closing.blocks) ? closing.blocks : [])
      .flatMap(block => block?.kind === 'text' && typeof block.text === 'string' ? [block.text] : []).join('')
    // Cached even when empty (a turn that only called tools): the message is
    // final, and walking every node on each chat update adds up in long chats.
    found.set(messageId, text)
    if (found.size > CACHE_LIMIT) found.delete(found.keys().next().value)
    return text
  }
  return ''
}
