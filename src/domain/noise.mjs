import { sourceLines } from './segment.mjs'

// Cheap local hints that a chapter still carries site boilerplate (links,
// "add to bookshelf" pleas, mirror-site names). They only decide whether to
// suggest an AI clean for this run; the AI decides what is actually removed,
// so a false positive costs one suggestion, never a deleted line.
const LINK = /(https?:\/\/|www\.)\S+/i
const DOMAIN = /(^|[^a-z0-9])[a-z0-9-]{2,}\.(com|net|org|cc|cn|top|xyz|info|me|la|tw|io|vip|biz)(?![a-z])/i
const PHRASES = /最新章节|请收藏|收藏本站|手机阅读|手机版阅读|本章未完|点击下一页|下一页继续|加入书签|求月票|求推荐票|天才一秒记住|一秒记住|笔趣阁|顶点小说|八一中文|无弹窗|全文阅读|章节报错|更新最快|首发网址|广告|免费阅读|百度搜索/
const NOISE_LIMIT = 200

export function detectNoiseLines(text) {
  if (typeof text !== 'string' || !text) return []
  const found = []
  for (const line of sourceLines(text)) {
    const value = line.text.trim()
    if (!value || value.length > 120) continue
    if (LINK.test(value) || DOMAIN.test(value) || PHRASES.test(value)) found.push(line.id)
    if (found.length >= NOISE_LIMIT) break
  }
  return found
}

// Suggest cleaning only when the hints are not a one-off: a single line that
// mentions "广告" in the story is far more likely than real boilerplate.
export const NOISE_SUGGEST_MIN = 2
