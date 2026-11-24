// Keyboard shortcuts for the novel workbench. Pure mapping so it can be tested
// without a DOM; the shell decides what each action does.
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5]

function editable(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(String(target.tagName ?? '').toUpperCase())
}

// → 'toggle' | 'prev' | 'next' | 'back10' | 'forward10' | 'slower' | 'faster' | 'search' | null
export function shortcutAction(event) {
  if (!event || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || editable(event.target)) return null
  switch (event.key) {
    case ' ':
    case 'Spacebar': return event.shiftKey ? null : 'toggle'
    case 'ArrowLeft': return event.shiftKey ? 'back10' : 'prev'
    case 'ArrowRight': return event.shiftKey ? 'forward10' : 'next'
    case '[': return 'slower'
    case ']': return 'faster'
    case '/': return 'search'
    default: return null
  }
}

// The next listed rate above (direction > 0) or below (direction < 0) the
// current one; stays put at either end. Works for rates that are not listed.
export function stepRate(rate, direction) {
  if (direction > 0) return PLAYBACK_RATES.find(value => value > rate + 1e-9) ?? PLAYBACK_RATES.at(-1)
  return PLAYBACK_RATES.findLast(value => value < rate - 1e-9) ?? PLAYBACK_RATES[0]
}
