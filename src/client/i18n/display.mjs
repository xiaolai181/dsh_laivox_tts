import { INSTRUCT_PRESETS, LEGACY_MOODS } from '../../domain/voice-direction.mjs'
import { roleNameKey } from '../../domain/production.mjs'
import { translate } from './locale.mjs'

const directions = new Set([
  ...Object.values(INSTRUCT_PRESETS).flat(),
  ...Object.values(LEGACY_MOODS).map(([text]) => text),
])

export function deliveryLabel(text) {
  return directions.has(text) ? translate(text) : text
}

export function roleDisplayName(role) {
  return role?.id === 'narrator' && role.name === '旁白' ? translate('旁白') : role?.name
}

export function roleMatchesQuery(role, query) {
  return typeof role?.name === 'string' && [role.name, roleDisplayName(role)].some(name => roleNameKey(name).includes(query))
}
