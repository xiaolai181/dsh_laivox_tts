import { createHash, randomUUID } from 'node:crypto'
import { defaultSettings } from '../domain/production.mjs'
import { edgeVoices } from './edge.mjs'
import { laivoxCatalog } from './engines/index.mjs'
import { checkedText } from './input.mjs'
import { receiptBody } from './ai-plan.mjs'

// Exactly the three languages, each with an Edge voice of that language.
export function validSpeechVoices(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prefixes = { 'zh-CN': 'zh-CN-', 'zh-TW': 'zh-TW-', en: 'en-' }
  const keys = Object.keys(value)
  return keys.length === 3 && keys.every(key => Object.hasOwn(prefixes, key) && typeof value[key] === 'string'
    && value[key].startsWith(prefixes[key]) && edgeVoices.some(voice => voice.id === value[key]))
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
  return value
}

export function receiptFor(kind, body) {
  if (typeof body.operationId !== 'string' || !uuid.test(body.operationId)) throw new Error('INVALID_INPUT')
  return { id: body.operationId, kind, digest: createHash('sha256').update(JSON.stringify(ordered(receiptBody(body)))).digest('hex') }
}

function narratorDefaultShape(value) {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === 2 && typeof value.account === 'string' && value.account.length > 0 && value.account.length <= 128
    && typeof value.voiceId === 'string' && value.voiceId.length > 0 && value.voiceId.length <= 128
}

export function createProductionService(library, gatewayFor) {
  async function checkVoices(roles, signal) {
    const catalogs = new Map([['edge', edgeVoices]])
    for (const role of roles) {
      if (!role || typeof role.id !== 'string' || (role.create && !uuid.test(role.id))) throw new Error('INVALID_INPUT')
      if (role.voices === undefined) continue
      if (!role.voices || typeof role.voices !== 'object' || Array.isArray(role.voices)) throw new Error('INVALID_INPUT')
      for (const [engine, voice] of Object.entries(role.voices)) {
        if (!['edge', 'laivox'].includes(engine) || typeof voice !== 'string') throw new Error('INVALID_INPUT')
        if (!voice) continue
        if (!catalogs.has(engine)) catalogs.set(engine, await laivoxCatalog(await gatewayFor(undefined, signal), signal))
        const item = catalogs.get(engine).find(item => item.id === voice)
        if (!item) throw new Error('VOICE_UNAVAILABLE')
        // A voice of the user's own that the current membership cannot use (slot locked).
        if (item.usable === false) throw new Error('LAIVOX_VOICE_UNAVAILABLE')
      }
    }
  }

  async function save(body, signal, legacy = false) {
    const receipt = legacy ? null : receiptFor('save', body)
    if (receipt) {
      const previous = await library.operation(receipt.id, receipt)
      if (previous) return previous
    }
    const { id, book, base, patch } = body
    if ((id != null && typeof id !== 'string') || (book != null && typeof book !== 'string') ||
        !patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('INVALID_INPUT')
    if (patch.bookTitle !== undefined && (id || book || typeof patch.bookTitle !== 'string' ||
      !patch.bookTitle.trim() || patch.bookTitle.trim().length > 180)) throw new Error('INVALID_INPUT')
    if (id && (!Number.isSafeInteger(base?.rev) || !Number.isSafeInteger(base?.rolesRev) ||
      (base.editorialResultJob !== null && typeof base.editorialResultJob !== 'string'))) throw new Error('INVALID_INPUT')
    const roles = patch.roles ?? []
    if (!Array.isArray(roles) || roles.length > 500 || (!id && (roles.length || patch.editorial !== undefined))) throw new Error('INVALID_INPUT')
    await checkVoices(roles, signal)
    signal?.throwIfAborted()
    return library.saveProduction({ id, book, base, patch: {
      ...patch, roles, ...(patch.text === undefined ? {} : { text: checkedText(patch.text) }),
    }, newId: randomUUID(), newBookId: randomUUID(), receipt, legacy })
  }

  function saveSettings({ expectedRevision, changes }) {
    if (!Number.isSafeInteger(expectedRevision) || !changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('INVALID_INPUT')
    for (const [key, value] of Object.entries(changes)) {
      if (!Object.hasOwn(defaultSettings, key)) throw new Error('INVALID_INPUT')
      if ((key === 'theme' && !['system', 'light', 'dark'].includes(value)) ||
          (key === 'skin' && !['paper', 'graphite'].includes(value)) ||
          (key === 'paragraphPause' && typeof value !== 'boolean') ||
          (key === 'mode' && !['reading', 'multi'].includes(value)) ||
          (key === 'engine' && !['edge', 'laivox'].includes(value)) ||
          (key === 'clean' && typeof value !== 'boolean') ||
          (key === 'autoContinue' && typeof value !== 'boolean') ||
          (key === 'chatDock' && !['auto', 'active', 'never'].includes(value)) ||
          (key === 'miniCapsule' && !['auto', 'playing', 'never'].includes(value)) ||
          (key === 'snippetRetention' && !['1d', '7d', '30d', 'never'].includes(value)) ||
          (key === 'speechVoices' && !validSpeechVoices(value)) ||
          (key === 'laivoxNarratorDefault' && !narratorDefaultShape(value)) ||
          (key === 'audioLimit' && (!Number.isSafeInteger(value) || value < 512 * 1024 ** 2 || value > 20 * 1024 ** 3)) ||
          (key === 'selection' && value !== null && (!value ||
            !['provider', 'model'].every(k => typeof value[k] === 'string' && value[k].length <= 256) ||
            Object.keys(value).some(k => !['provider', 'model', 'reasoningEffort'].includes(k)) ||
            (value.reasoningEffort != null && (typeof value.reasoningEffort !== 'string' || value.reasoningEffort.length > 64))))) throw new Error('INVALID_INPUT')
    }
    return library.saveSettings(expectedRevision, changes)
  }

  async function confirmNarratorDefault(value, signal) {
    let session
    try { session = await gatewayFor(undefined, signal) }
    catch { throw new Error('LAIVOX_CATALOG_UNAVAILABLE') }
    if (!session?.account || session.account !== value.account) throw new Error('LAIVOX_DEFAULT_ACCOUNT')
    let catalog
    try { catalog = await laivoxCatalog(session, signal) }
    catch { throw new Error('LAIVOX_CATALOG_UNAVAILABLE') }
    const item = catalog.find(voice => voice.id === value.voiceId)
    if (!item || item.usable === false) throw new Error('LAIVOX_VOICE_UNAVAILABLE')
  }
  return { save, saveSettings, confirmNarratorDefault }
}
