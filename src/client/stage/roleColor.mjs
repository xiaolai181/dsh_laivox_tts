export function roleIndex(id) {
  let hash = 2166136261
  for (const char of String(id)) hash = Math.imul(hash ^ char.codePointAt(0), 16777619)
  return (hash >>> 0) % 9
}
export const roleTone = id => !id || id === 'narrator' ? 'narrator' : roleIndex(id)
export const roleColor = id => `var(--lv-role-${roleTone(id)})`
