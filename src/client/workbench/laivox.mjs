import { deferText, translate as t } from '../i18n/locale.mjs'
import { get, post } from '../api.mjs'

const PLAN_NAMES = { trial: '试用', basic: '基础版', pro: '进阶版', admin: '管理员', pack: '朗读时长包', none: '未开通' }

function shortTime(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  const pad = number => String(number).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

export function shortDate(value) {
  const date = value ? new Date(value) : null
  if (!date || Number.isNaN(date.getTime())) return ''
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

// Read-aloud time left in a pool: hours (down to 0.1) from 2 hours up, minutes below.
function poolTimeLeft(minutesLeft) {
  if (typeof minutesLeft !== 'number' || !Number.isFinite(minutesLeft)) return t('朗读剩余未知')
  const m = Math.max(0, Math.floor(minutesLeft))
  if (m < 1) return t('朗读不足 1 分钟')
  if (m < 120) return t("朗读约剩 {v1} 分钟", { v1: m })
  return t("朗读约剩 {v1} 小时", { v1: Math.floor(m / 6) / 10 })
}

// One line of usage for the LaiVox card, in the same terms as the extension.
export function usageLine(usage, { includePoolExpiry = true } = {}) {
  if (!usage) return ''
  const plan = t(PLAN_NAMES[usage.plan] ?? PLAN_NAMES.none)
  if (usage.state === 'hold') return t("{v1} · 退款审核中，云端已暂停", { v1: plan })
  if (usage.unlimited) return t("{v1} · 朗读不限量", { v1: plan })
  // Pool accounts and pack keys: a total that lasts until it runs out or expires; no days.
  if (usage.model === 'pool') {
    if (usage.state === 'inactive') return t("{v1} · 未开通或已到期", { v1: plan })
    const parts = [plan, usage.usedUp ? t('朗读额度已用完') : poolTimeLeft(usage.minutesLeft)]
    const until = shortDate(usage.pool?.endsAt)
    if (until && includePoolExpiry) parts.push(t("{v1} 到期", { v1: until }))
    return parts.join(' · ')
  }
  if (usage.state === 'none') return t("{v1} · 首次使用时开始本轮（24 小时）", { v1: plan })
  const parts = [plan]
  if (usage.usedUp) parts.push(t('本轮已用完'))
  else if (typeof usage.minutesLeft === 'number') parts.push(usage.minutesLeft < 1 ? t('今日朗读不足 1 分钟') : t("今日朗读约剩 {v1} 分钟", { v1: usage.minutesLeft }))
  else parts.push(t('朗读剩余未知'))
  if (usage.dayIndex > 0) parts.push(t("本轮第 {v1} 个使用日", { v1: usage.dayIndex }))
  const until = shortTime(usage.endsAt)
  if (until && !usage.usedUp) parts.push(t("至 {v1}", { v1: until }))
  return parts.join(' · ')
}

function durationLabel(cs) {
  if (!Number.isSafeInteger(cs) || cs < 0) return ''
  if (cs === 0) return t('0 分钟')
  const minutes = Math.floor(cs / 6000)
  if (minutes < 1) return t('不足 1 分钟')
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours > 0 && rest === 0) return t('{v1} 小时', { v1: hours })
  if (hours > 0) return t('{v1} 小时 {v2} 分钟', { v1: hours, v2: rest })
  return t('{v1} 分钟', { v1: minutes })
}

// Secondary breakdown line under the usage summary (used, total, in-flight, remaining).
export function usageBreakdown(usage) {
  if (!usage || usage.unlimited || usage.state === 'hold') return ''
  if (usage.model === 'day' && usage.state === 'none') {
    if (!Number.isInteger(usage.daysAvailable)) return ''
    return Number.isSafeInteger(usage.nominalPerDay) && usage.nominalPerDay > 0
      ? t('剩余 {v1} 个使用日 · 每日约 {v2}', { v1: usage.daysAvailable, v2: durationLabel(usage.nominalPerDay) })
      : t('剩余 {v1} 个使用日', { v1: usage.daysAvailable })
  }
  if (!usage.amounts) return ''
  const { granted, billed, reserved, remaining } = usage.amounts
  const parts = [
    usage.model === 'day'
      ? t('本轮已用 {v1} / 共 {v2}', { v1: durationLabel(billed), v2: durationLabel(granted) })
      : t('已用 {v1} / 共 {v2}', { v1: durationLabel(billed), v2: durationLabel(granted) }),
  ]
  if (reserved > 0) parts.push(t('处理中 {v1}', { v1: durationLabel(reserved) }))
  parts.push(t('剩余 {v1}', { v1: durationLabel(remaining) }))
  return parts.join(' · ')
}

// Why a usage day cannot be opened right now, or '' when it can.
export function usageBlock(usage) {
  if (!usage || usage.canAuthorize) return ''
  if (usage.model === 'pool') return t('朗读额度按总额计算，不需要开启使用日。')
  // block_reason values come from the gateway's usage-day admission.
  if (usage.daysAvailable === 0 || usage.blockReason === 'no_days') return t('使用日已用完，续费后可继续使用 LaiVox。')
  if (usage.blockReason === 'window_limit') return t('本轮可额外开启的使用日已用完。')
  if (usage.blockReason === 'calendar') return t('当前按自然日计算，不能提前开启下一天。')
  const next = shortTime(usage.nextExtraAt)
  if (usage.blockReason === '24h_limit' || next) return t('24 小时内可开启的使用日已用完') + (next ? t("，{v1} 后可再开。", { v1: next }) : '。')
  return t('现在不能开启新的使用日。')
}

// The pack's price sentence for the settings card; no numbers when the price could not be read.
export function packPriceLine(catalog) {
  if (!catalog?.available) return t('时长包价格暂时无法读取。')
  return t("时长包 {v1}，{v2} 小时朗读，购买后 {v3} 天内有效。用到 {v4}% 后可再买。", {
    v1: '¥' + (catalog.amountCents / 100).toFixed(2), v2: catalog.hours, v3: catalog.windowDays, v4: catalog.thresholdPct,
  })
}

// Which allowance the saved key draws on, with what is left of the pack.
export function ledgerLine(status) {
  if (!status) return ''
  if (status.ledger !== 'pack') return t('当前 Key 使用会员的朗读额度（不占 AI 整理额度）。')
  const pack = status.pack
  if (!pack?.active) return t('当前 Key 使用朗读时长包。')
  const until = shortDate(pack.endsAt)
  return t("当前 Key 使用朗读时长包：{v1}", { v1: poolTimeLeft(pack.minutesLeft) }) + (until ? t("，{v1} 到期", { v1: until }) : '') + t('。')
}

// Why the key cannot synthesize, by the ledger it draws on, and what else would work.
export function deniedLine(status) {
  if (!status || status.synthesisAllowed !== false) return ''
  const refund = status.denyCode === 'REFUND_PENDING'
  if (status.ledger === 'pack') {
    const head = refund ? t('时长包退款审核中，LaiVox 暂不可用；可以继续用 Edge。') : t('时长包未开通或已到期，LaiVox 暂不可用；可以继续用 Edge。')
    return status.membershipAvailable ? head + t('你的会员有效，可以在官网把这把 Key 改回使用会员额度。') : head
  }
  const head = refund ? t('退款审核中，LaiVox 暂不可用；可以继续用 Edge。') : t('会员已到期，LaiVox 暂不可用；可以继续用 Edge。')
  return status.packAvailable ? head + t('你有可用的朗读时长包，可以在官网把这把 Key 改为使用时长包。') : head
}

// Opens the next usage day after the user confirms. The target and window come
// from the state shown in the dialog and the operation id is fixed per dialog,
// so a retry of the same request cannot open one more day.
export async function openUsageDay(decide) {
  const read = await get('laivox/usage')
  if (read?.status !== 'ok') return { opened: false, message: deferText(() => t('用量暂时无法读取，请稍后重试。')) }
  const usage = read.usage
  if (usageBlock(usage)) return { opened: false, usage, message: deferText(() => usageBlock(usage)) }
  const target = usage.daysAuthorized + 1
  const left = () => Number.isInteger(usage.daysAvailable) ? t("，剩余 {v1} 个", { v1: usage.daysAvailable }) : ''
  const choice = await decide({ title: deferText(() => t('开启下一个使用日')),
    text: deferText(() => t("本轮已开启 {v1} 个使用日{v2}。开启后用到才扣，今天没用完不会扣。", { v1: usage.daysAuthorized, v2: left() })),
    choices: [['open', deferText(() => t('开启'))], [null, deferText(() => t('取消'))]] })
  if (choice !== 'open') return { opened: false, usage }
  const operationId = globalThis.crypto.randomUUID()
  const done = await post('laivox/usage/authorize', { target, windowId: usage.windowId, operationId })
  return { opened: true, usage: done?.usage ?? usage }
}
