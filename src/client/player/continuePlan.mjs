// Who continues with the next chapter when one ends. Exactly one owner acts:
// the workbench while its panel is open (it owns navigation and drafts), the
// mini capsule otherwise (it keeps playing in place without switching panels).
export function continueDecision({ panelActive, autoContinue, nextId, segments, dirty = false, open = false }) {
  if (open) return { action: 'none' }
  if (!nextId || autoContinue === false) return { action: 'none' }
  // Only a fully made chapter hands over; a gap means the listener stopped early.
  if (!Array.isArray(segments) || !segments.length || !segments.every(part => part.ready)) return { action: 'none' }
  if (!panelActive) return { action: 'capsule', chapter: nextId }
  // Continuing would ask whether to keep unsaved edits; stay instead of interrupting.
  if (dirty) return { action: 'stay', reason: 'dirty' }
  return { action: 'workbench', chapter: nextId }
}
