import { readFile } from 'node:fs/promises'

// Preset voice samples shipped with the plugin (assets/voice-previews/).
const assets = new URL('../../../../assets/voice-previews/', import.meta.url)
let manifest

export async function laivoxBundledPreview(voice, signal) {
  manifest ??= readFile(new URL('manifest.json', assets), 'utf8').then(text => JSON.parse(text.replace(/^﻿/u, '')))
    .catch(error => { manifest = undefined; throw error })
  const item = (await manifest).voices.find(item => item.id === voice)
  if (!item) throw new Error('VOICE_PREVIEW_NOT_FOUND')
  return readFile(new URL(item.file, assets), { signal })
}

// The voice catalogue per account, kept as long as the account check. "My voices"
// (uploaded in the browser extension) are asked for only when the gateway offers
// them, and never take part in automatic assignment: only the presets do, so the
// voices and audio keys of existing books stay as they were.
export const CATALOG_TTL_MS = 10 * 60_000
const catalogs = new Map()

function shape(list) {
  return (Array.isArray(list) ? list : []).filter(item => item && typeof item.id === 'string').map(item => {
    const mine = item.owner === 'mine'
    return { ...item, owner: mine ? 'mine' : 'system', ...(mine ? { auto: false } : {}), usable: item.usable !== false }
  })
}

export async function laivoxCatalog(gateway, signal, { refresh = false, now = Date.now } = {}) {
  const includeMine = gateway?.status?.features?.own_voices === true
  const cacheKey = (gateway?.account ?? '') + (includeMine ? ':mine' : '')
  const cached = catalogs.get(cacheKey)
  if (!refresh && cached && now() - cached.at < CATALOG_TTL_MS) return cached.voices
  const voices = shape(await gateway.client.voices(signal, { includeMine }))
  catalogs.set(cacheKey, { at: now(), voices })
  return voices
}

export function forgetCatalogs() { catalogs.clear() }

// Previews from the gateway (presets and the user's own voices), cached by voice
// and revision so a changed reference voice is heard as it now sounds.
const PREVIEW_BYTES = 8 * 1024 ** 2
const previews = new Map()
let previewBytes = 0

function remember(key, wav) {
  if (wav.length > PREVIEW_BYTES) return
  while (previewBytes + wav.length > PREVIEW_BYTES && previews.size) {
    const [oldest, value] = previews.entries().next().value
    previews.delete(oldest)
    previewBytes -= value.length
  }
  previews.set(key, wav)
  previewBytes += wav.length
}

// The gateway's sample when it offers previews, otherwise (or when it fails) the
// sample shipped with the plugin.
export async function laivoxPreview(voice, signal, { gatewayFor } = {}) {
  let gateway = null
  try { gateway = gatewayFor ? await gatewayFor(undefined, signal) : null }
  catch (error) { if (error?.message !== 'LAIVOX_KEY_REQUIRED') throw error }
  if (!gateway || gateway.status?.features?.preview !== true) return laivoxBundledPreview(voice, signal)
  const catalog = await laivoxCatalog(gateway, signal).catch(() => [])
  const revision = catalog.find(item => item.id === voice)?.revision ?? ''
  const key = voice + '\u0000' + revision
  if (previews.has(key)) return previews.get(key)
  try {
    const wav = await gateway.client.preview(voice, signal)
    remember(key, wav)
    return wav
  } catch (error) {
    signal?.throwIfAborted()
    return laivoxBundledPreview(voice, signal).catch(() => { throw error })
  }
}

// Before synthesizing, every LaiVox part still waiting must use a voice that
// exists, can be used, and has not changed since the part was planned (its
// reference audio changed in the extension). The role is named for the pause.
export function assertLaivoxVoices(parts, catalog) {
  const byId = new Map(catalog.map(item => [item.id, item]))
  for (const part of parts) {
    const item = byId.get(part.voiceId)
    if (!item || item.usable === false) throw Object.assign(new Error('LAIVOX_VOICE_UNAVAILABLE'), { roleId: part.roleId })
    if (part.voiceRevision && item.revision && item.revision !== part.voiceRevision) {
      throw Object.assign(new Error('LAIVOX_VOICE_CHANGED'), { roleId: part.roleId })
    }
  }
}
