import { useEffect, useState } from 'react'

const MINT_COOLDOWN_MS = 3000
const EXPIRY_LEAD_MS = 30_000
const RETURN_MS = 30 * 60 * 1000
let cached = null
let flight = null
let flightIdentity = null
let openedAt = 0
let lastMintAt = 0
let lastIdentity = ''
let expiryTimer = null
const listeners = new Set()

function notify() { for (const listener of listeners) listener() }

function clearExpiryTimer() {
  if (!expiryTimer) return
  clearTimeout(expiryTimer)
  expiryTimer = null
}

function clearCached(shouldNotify = true) {
  clearExpiryTimer()
  cached = null
  if (shouldNotify) notify()
}

function scheduleExpiry(expiresAt, now = Date.now()) {
  clearExpiryTimer()
  const delay = Math.max(0, expiresAt - EXPIRY_LEAD_MS - now)
  expiryTimer = setTimeout(() => {
    cached = null
    expiryTimer = null
    notify()
  }, delay)
  expiryTimer.unref?.()
}

function resetForIdentityChange(identity) {
  if (lastIdentity === identity) return
  clearCached(false)
  lastMintAt = 0
  lastIdentity = identity
}

export function subscribePackLink(listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Consuming a one-time handoff link invalidates the client cache at once so the
// same #h= code is never opened multiple times against the gateway's 5-use limit.
export function notePackOpened(now = Date.now()) {
  openedAt = now
  clearCached(true)
}

export function takePackReturn(now = Date.now()) {
  if (!openedAt || now - openedAt > RETURN_MS) return false
  openedAt = 0
  return true
}

export function resetPackLinkForTest() {
  clearExpiryTimer()
  cached = null
  flight = null
  flightIdentity = null
  openedAt = 0
  lastMintAt = 0
  lastIdentity = ''
  listeners.clear()
}

// The link belongs to the key that minted it. A replaced or cleared key drops it at once.
export function packLinkFor(identity, now = Date.now()) {
  return cached && cached.identity === identity && cached.expiresAt > now ? cached.url : ''
}

export async function loadPackLink(request, identity, now = Date.now()) {
  if (!identity || typeof request !== 'function') return null
  resetForIdentityChange(identity)
  if (cached && cached.identity === identity && cached.expiresAt > now + EXPIRY_LEAD_MS) return cached
  if (!flight || flightIdentity !== identity) {
    flightIdentity = identity
    lastMintAt = now
    const current = Promise.resolve()
      .then(() => request())
      .then(value => {
        if (flightIdentity !== identity) return
        if (value && typeof value.url === 'string' && value.url.includes('#h=') && Number(value.expiresAt) > now) {
          cached = { url: value.url, expiresAt: Number(value.expiresAt), identity }
          scheduleExpiry(cached.expiresAt, now)
        }
      })
      .catch(() => {})
      .finally(() => { if (flight === current) flight = null; notify() })
    flight = current
  }
  await flight
  return cached
}

export async function ensurePackLink(request, identity, now = Date.now()) {
  if (!identity || typeof request !== 'function') return ''
  resetForIdentityChange(identity)
  const existing = packLinkFor(identity, now)
  if (existing) return existing
  if (flight && flightIdentity === identity) {
    await flight
    return packLinkFor(identity, now)
  }
  if (lastMintAt && now - lastMintAt < MINT_COOLDOWN_MS) return ''
  await loadPackLink(request, identity, now)
  return packLinkFor(identity, now)
}

export function usePackLink(fallback, active, request, identity) {
  const [, setTick] = useState(0)
  useEffect(() => subscribePackLink(() => setTick(value => value + 1)), [])
  useEffect(() => {
    if (!identity) {
      resetForIdentityChange('')
      return undefined
    }
    resetForIdentityChange(identity)
    if (!active || typeof request !== 'function') return undefined
    void ensurePackLink(request, identity)
    return undefined
  }, [active, request, identity])
  if (!active || !identity) return fallback || ''
  return packLinkFor(identity) || fallback || ''
}
