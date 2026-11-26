import { createHash } from 'node:crypto'
import { createGateway } from './client.mjs'
import { forgetPackCatalog } from './usage.mjs'
import { forgetCatalogs } from './voices.mjs'

// The DSH credential service is the only persistent source of truth for a Key.
const keyRef = 'LAIVOX_NOVEL_AUDIO_API_KEY'
// A verified key is trusted for this long before /status is asked again. The
// gateway still checks the key on every request; this only saves round trips.
export const ACCOUNT_CHECK_TTL_MS = 10 * 60_000

const digestOf = key => createHash('sha256').update(key).digest('hex').slice(0, 16)

export function createLaivoxSession({ credentials, now = Date.now }) {
  // One entry for the current key: { digest, account, status, checkedAt, hints }.
  // Only a digest of the key is kept here, never the key itself.
  let cached = null
  let inflight = null
  let keyChanges = Promise.resolve()
  let keyGeneration = 0

  function forget() { cached = null; forgetCatalogs(); forgetPackCatalog() }
  function inKeyOrder(action) {
    const result = keyChanges.then(action)
    keyChanges = result.catch(() => {})
    return result
  }

  function waitFor(promise, signal) {
    if (!signal) return promise
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }

  function clientFor(key, entry) {
    return createGateway(key, { hints: entry.hints, onAuthFailure: () => { if (cached === entry) forget() } })
  }

  // The shared check runs on its own signal (the client still times out after 45 s),
  // so one caller giving up does not fail the others waiting on it.
  async function check(key, digest, remember = true) {
    const generation = keyGeneration
    const entry = { digest, hints: cached?.digest === digest ? cached.hints : {} }
    const client = clientFor(key, entry)
    const status = await client.status(new AbortController().signal)
    const account = status?.account_id
    if (typeof account !== 'string' || !account) throw new Error('LAIVOX_INVALID_ACCOUNT')
    Object.assign(entry, { account, status, checkedAt: now() })
    if (remember && generation === keyGeneration) cached = entry
    return entry
  }

  // Verified session for a key: cached for ACCOUNT_CHECK_TTL_MS; concurrent callers
  // share one /status request.
  async function sessionFor(key, signal, fresh = false) {
    const digest = digestOf(key)
    if (!fresh && cached?.digest === digest && now() - cached.checkedAt < ACCOUNT_CHECK_TTL_MS) return cached
    if (inflight?.digest !== digest) {
      const promise = check(key, digest).finally(() => { if (inflight?.promise === promise) inflight = null })
      inflight = { digest, promise }
    }
    return waitFor(inflight.promise, signal)
  }

  async function verify(key, expected, signal, fresh = false) {
    const entry = await sessionFor(key, signal, fresh)
    if (expected && entry.account !== expected) throw new Error('LAIVOX_ACCOUNT_CHANGED')
    return { client: clientFor(key, entry), account: entry.account, status: entry.status }
  }

  // fresh skips the cached check (the settings card's Refresh).
  async function gatewayFor(expected, signal, fresh = false) {
    const resolved = await credentials.resolve(keyRef)
    if (!resolved) throw new Error('LAIVOX_KEY_REQUIRED')
    return verify(resolved.value, expected, signal, fresh)
  }

  async function readKeyStatus() {
    const { configured, masked, source } = await credentials.describe(keyRef)
    const keySource = typeof source === 'string' ? source : null
    if (!configured) return { configured, masked, source: keySource, account: null }
    const credential = await credentials.resolve(keyRef)
    const digest = credential ? digestOf(credential.value) : null
    return { configured, masked, source: keySource, account: digest && cached?.digest === digest ? cached.account : null }
  }

  const keyStatus = () => inKeyOrder(readKeyStatus)

  async function setKey(input, signal) {
    const key = typeof input === 'string' ? input.trim() : ''
    if (!/^lvtts_[\w-]{43}$/u.test(key)) throw new Error('INVALID_API_KEY')
    return inKeyOrder(async () => {
      signal?.throwIfAborted()
      const entry = await waitFor(check(key, digestOf(key), false), signal)
      signal?.throwIfAborted()
      await credentials.set(keyRef, key)
      keyGeneration++
      inflight = null
      forgetCatalogs()
      forgetPackCatalog()
      cached = entry
      return readKeyStatus()
    })
  }

  async function clearKey() {
    const remove = typeof credentials.unset === 'function'
      ? () => credentials.unset(keyRef)
      : typeof credentials.delete === 'function'
        ? () => credentials.delete(keyRef)
        : null
    if (!remove) throw new Error('KEY_CLEAR_UNSUPPORTED')
    return inKeyOrder(async () => {
      await remove()
      keyGeneration++
      inflight = null
      forget()
      return readKeyStatus()
    })
  }

  return { gatewayFor, keyStatus, setKey, clearKey, forget }
}
