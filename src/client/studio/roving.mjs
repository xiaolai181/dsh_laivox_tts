// The next index for arrow-key focus inside a list. Stays inside the list.
export function rovingIndex(key, index, count) {
  if (count <= 0) return 0
  const current = Math.min(Math.max(0, index), count - 1)
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown' || key === 'ArrowRight') return Math.min(count - 1, current + 1)
  if (key === 'ArrowUp' || key === 'ArrowLeft') return Math.max(0, current - 1)
  return current
}
