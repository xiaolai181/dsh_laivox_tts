// LaiVox usage: read the state, and (for accounts still on usage days) open the
// next day after the user confirmed it. Opening a day can use up a membership day,
// so the plugin never does it on its own. The target, window and idempotency key
// are fixed when the dialog opens and reused on retries: a retry after a lost
// response then repeats the same request instead of opening one more day.
// Pool accounts and pack keys have no days to open: the allowance is granted up
// front and lasts until it runs out or expires.
import { PACK_PAGE } from './client.mjs'

const featureOn = status => status?.features?.usage === true

const minutes = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const safeNonNegInt = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
const text = value => typeof value === 'string' ? value : null
const ledgerOf = value => value === 'pack' ? 'pack' : 'membership'

function amountsFrom(granted, billed, reserved, remaining) {
  const g = safeNonNegInt(granted)
  const b = safeNonNegInt(billed)
  const rsv = safeNonNegInt(reserved)
  const rem = safeNonNegInt(remaining)
  if (!g || b === null || rsv === null || rem === null) return null
  return { granted: g, billed: b, reserved: rsv, remaining: rem }
}

function poolAmounts(data, tts) {
  const poolTts = data?.pool?.tts
  return amountsFrom(poolTts?.granted, poolTts?.billed, poolTts?.reserved, poolTts?.remaining)
    ?? amountsFrom(tts.nominal_per_day, tts.billed, tts.reserved, tts.remaining)
}

function dayAmounts(tts, state, daysAuthorized) {
  if (state !== 'active' && state !== 'provisional') return null
  if (!Number.isSafeInteger(daysAuthorized) || daysAuthorized <= 0) return null
  const nominal = safeNonNegInt(tts.nominal_per_day)
  if (!nominal) return null
  const granted = nominal * daysAuthorized
  if (!Number.isSafeInteger(granted) || granted <= 0) return null
  return amountsFrom(granted, tts.billed, tts.reserved, tts.remaining)
}

// The pool block of the gateway's usage answer (pool accounts and pack keys).
function poolView(pool) {
  if (!pool || typeof pool !== 'object') return null
  return {
    kind: typeof pool.kind === 'string' ? pool.kind : '',
    endsAt: text(pool.ends_at),
    usedPct: minutes(pool.used_pct) ?? 0,
    renewAllowed: pool.renew_allowed === true,
    thresholdPct: minutes(pool.renew_threshold_pct) || 90,
  }
}

// The part of the gateway's usage status the interface shows.
export function usageView(data) {
  const tts = data?.tts ?? {}
  const window = data?.window ?? null
  const authorize = data?.authorize ?? {}
  const model = data?.model === 'pool' ? 'pool' : 'day'
  const state = typeof data?.state === 'string' ? data.state : 'none'
  const unlimited = tts.unlimited === true
  const daysAuthorized = Number.isInteger(window?.days_authorized) ? window.days_authorized : 0
  const nominalPerDay = !unlimited && safeNonNegInt(tts.nominal_per_day) > 0 ? tts.nominal_per_day : null
  const amounts = unlimited || state === 'hold' ? null
    : model === 'pool' ? poolAmounts(data, tts) : dayAmounts(tts, state, daysAuthorized)
  return {
    model,
    ledger: ledgerOf(data?.ledger),
    pool: model === 'pool' ? poolView(data?.pool) : null,
    state,
    plan: typeof data?.plan === 'string' ? data.plan : 'none',
    unlimited,
    minutesLeft: minutes(tts.minutes_left),
    remainingPct: minutes(tts.remaining_pct),
    usedUp: !unlimited && minutes(tts.remaining) !== null && minutes(tts.remaining) <= 0,
    amounts,
    nominalPerDay,
    windowId: typeof window?.id === 'string' ? window.id : '',
    daysAuthorized,
    dayIndex: Number.isInteger(window?.current_day_index) ? window.current_day_index : 0,
    endsAt: typeof window?.effective_ends_at === 'string' ? window.effective_ends_at : (typeof window?.ends_at === 'string' ? window.ends_at : null),
    daysAvailable: Number.isInteger(data?.balance?.days_available) ? data.balance.days_available : null,
    canAuthorize: data?.model !== 'pool' && authorize.can_authorize === true,
    maxTarget: Number.isInteger(authorize.max_target) ? authorize.max_target : 0,
    nextExtraAt: typeof authorize.next_extra_at === 'string' ? authorize.next_extra_at : null,
    blockReason: typeof authorize.block_reason === 'string' ? authorize.block_reason : '',
  }
}

export async function laivoxUsage(gatewayFor, signal, expectedAccount) {
  const { client, status } = await gatewayFor(expectedAccount, signal)
  if (!featureOn(status)) return { status: 'unsupported' }
  return { status: 'ok', usage: usageView(await client.usage(signal)) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export async function laivoxAuthorize(gatewayFor, body, signal) {
  const target = body?.target
  const windowId = typeof body?.windowId === 'string' ? body.windowId : ''
  const operationId = typeof body?.operationId === 'string' ? body.operationId : ''
  if (!Number.isInteger(target) || target < 1 || target > 32 || windowId.length > 64 || !UUID.test(operationId)) throw new Error('INVALID_INPUT')
  const { client, status } = await gatewayFor(undefined, signal)
  if (!featureOn(status)) return { status: 'unsupported' }
  return { status: 'ok', usage: usageView(await client.authorize({ target, windowId, operationId }, signal)) }
}

// The pack summary in the key status (shown in settings whatever the key's ledger).
function packView(pack) {
  if (!pack || typeof pack !== 'object') return null
  return {
    active: pack.active === true,
    held: pack.held === true,
    minutesLeft: typeof pack.remaining === 'number' && Number.isFinite(pack.remaining) ? Math.max(0, Math.floor(pack.remaining / 6000)) : null,
    usedPct: minutes(pack.used_pct) ?? 0,
    endsAt: text(pack.ends_at),
    renewAllowed: pack.renew_allowed === true,
  }
}

// Account and membership as the settings card shows them. Features missing from
// an older gateway count as off, so their entry points stay hidden.
export function laivoxStatusView({ account, status }) {
  const features = status?.features ?? {}
  return {
    account,
    expiresAt: typeof status?.key_expires_at === 'string' ? status.key_expires_at : null,
    synthesisAllowed: status?.synthesis_allowed !== false,
    denyCode: typeof status?.deny_code === 'string' ? status.deny_code : null,
    features: { ownVoices: features.own_voices === true, usage: features.usage === true, preview: features.preview === true, pack: features.pack === true },
    minVersion: typeof status?.client?.min_version === 'string' ? status.client.min_version : '',
    outdated: status?.client?.outdated === true,
    // Older gateways send none of these: the key then counts as a membership key.
    ledger: ledgerOf(status?.ledger),
    membershipAvailable: status?.membership_available === true,
    packAvailable: status?.pack_available === true,
    pack: packView(status?.pack),
  }
}

// The pack's price list, kept for five minutes (the gateway caches it as long).
const CATALOG_TTL_MS = 5 * 60_000
let catalogCache = null

export function forgetPackCatalog() { catalogCache = null }

export function packCatalogView(data) {
  const cents = Number(data?.amount_cents)
  if (data?.available !== true || data?.currency !== 'CNY' || !Number.isSafeInteger(cents) || cents <= 0) return { available: false }
  return {
    available: true,
    currency: 'CNY',
    amountCents: cents,
    hours: Number(data.tts_hours) > 0 ? Number(data.tts_hours) : Math.round((Number(data.tts_seconds) || 0) / 3600),
    windowDays: Number(data.window_days) > 0 ? Number(data.window_days) : 60,
    thresholdPct: Number(data.renew_threshold_pct) > 0 ? Number(data.renew_threshold_pct) : 90,
  }
}

export async function laivoxHandoff(gatewayFor, signal, now = Date.now()) {
  const { client } = await gatewayFor(undefined, signal)
  const minted = await client.handoff(signal)
  if (typeof minted?.code !== 'string' || !/^[0-9a-f]{64}$/u.test(minted.code)) throw new Error('LAIVOX_REQUEST_FAILED')
  const ttl = Math.min(600, Math.max(1, Math.floor(minted.expiresIn)))
  return { url: PACK_PAGE + '#h=' + minted.code, expiresAt: now + ttl * 1000 }
}

export async function laivoxPackCatalog(gatewayFor, signal, now = Date.now()) {
  const { client } = await gatewayFor(undefined, signal)
  if (catalogCache && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
  const value = { status: 'ok', catalog: packCatalogView(await client.catalog(signal)) }
  catalogCache = { at: now, value }
  return value
}
