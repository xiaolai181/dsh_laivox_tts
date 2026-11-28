import { segmentChapter, segmentVersion } from './segment.mjs'
import { roleNameKey } from './production.mjs'

const DIGITS = { '零': 0, '〇': 0, '一': 1, '壹': 1, '二': 2, '贰': 2, '两': 2, '三': 3, '叁': 3, '四': 4, '肆': 4, '五': 5, '伍': 5, '六': 6, '陆': 6, '七': 7, '柒': 7, '八': 8, '捌': 8, '九': 9, '玖': 9 }
const UNITS = { '十': 10, '拾': 10, '百': 100, '佰': 100, '千': 1000, '仟': 1000 }

export function parseChineseNumeral(raw) {
  const text = String(raw ?? '').normalize('NFKC').trim()
  if (!text) return null
  if (/^\d{1,5}$/u.test(text)) {
    const num = Number(text)
    return num > 0 && num <= 20000 ? num : null
  }
  let total = 0
  let section = 0
  let current = 0
  let seen = false
  for (const ch of text) {
    if (Object.hasOwn(DIGITS, ch)) {
      current = DIGITS[ch]
      seen = true
    } else if (Object.hasOwn(UNITS, ch)) {
      const unit = UNITS[ch]
      seen = true
      if (unit >= 1000 && ch === '万') {
        total += (section + current) * 10000
        section = 0
        current = 0
      } else {
        section += (current === 0 && unit === 10 && section === 0 ? 1 : current) * unit
        current = 0
      }
    } else if (ch === '万' || ch === '萬') {
      seen = true
      total += (section + current) * 10000
      section = 0
      current = 0
    } else {
      return null
    }
  }
  if (!seen) return null
  const result = total + section + current
  return result > 0 && result <= 20000 ? result : null
}

export function extractChapterOrdinal(query) {
  const clean = String(query ?? '').normalize('NFKC').trim()
  if (!clean) return null
  if (/^\d{1,5}$/u.test(clean)) return parseChineseNumeral(clean)
  const bracketed = /^(?:第\s*)?([零〇一壹二贰两三叁四肆五伍六陆七柒八捌九玖十拾百佰千仟\d]+)\s*(?:章|回|节|集|话|卷)?$/u.exec(clean)
  if (bracketed) return parseChineseNumeral(bracketed[1])
  return null
}

export function matchChapterByQuery(chapters, query) {
  if (!Array.isArray(chapters) || !chapters.length) return null
  const clean = String(query ?? '').normalize('NFKC').trim()
  if (!clean) return null
  const byId = chapters.find(row => row.id === clean)
  if (byId) return byId
  const normalized = clean.toLowerCase()
  const exactTitle = chapters.find(row => String(row.title ?? '').normalize('NFKC').trim().toLowerCase() === normalized)
  if (exactTitle) return exactTitle
  const ordinal = extractChapterOrdinal(clean)
  if (ordinal !== null) {
    const byOrdinal = chapters.find(row => row.ordinal === ordinal)
    if (byOrdinal) return byOrdinal
  }
  const fuzzy = chapters.find(row => String(row.title ?? '').normalize('NFKC').trim().toLowerCase().includes(normalized))
  if (fuzzy) return fuzzy
  if (/^(?:序章?|楔子|引子|前言)$/u.test(clean)) {
    return chapters.find(row => /(?:序|楔|引|前)/u.test(String(row.title ?? ''))) ?? chapters[0]
  }
  return null
}

export function computeProgressPercent(chapters, progressOrdinal, currentCutoff, currentLength) {
  if (!Array.isArray(chapters) || !chapters.length || !progressOrdinal) return 0
  let totalChars = 0
  let heardChars = 0
  for (const row of chapters) {
    const chars = Math.max(1, Number(row.characters) || 0)
    totalChars += chars
    if (row.ordinal < progressOrdinal) heardChars += chars
    else if (row.ordinal === progressOrdinal) {
      if (Number.isFinite(currentCutoff) && Number.isFinite(currentLength) && currentLength > 0) {
        heardChars += Math.min(chars, Math.max(0, Math.round((currentCutoff / currentLength) * chars)))
      }
    }
  }
  if (!totalChars) return 0
  return Math.max(0, Math.min(100, Math.round((heardChars / totalChars) * 100)))
}

export function resolvePlaybackCutoff(text, playback, editorial, jobParts) {
  const length = typeof text === 'string' ? text.length : 0
  if (!playback || typeof playback !== 'object') return 0
  if (Number.isSafeInteger(playback.start) && playback.start >= 0) {
    return Math.min(length, playback.start)
  }
  const n = Number.isInteger(playback.n) && playback.n >= 0 ? playback.n : null
  if (n !== null && Array.isArray(jobParts) && jobParts[n]) {
    const end = Number(jobParts[n].end)
    if (Number.isFinite(end) && end >= 0) return Math.min(length, end)
  }
  if (n !== null && typeof text === 'string') {
    const segments = segmentChapter(text, editorial?.removed ?? [], segmentVersion(editorial))
    if (segments[n]) return Math.min(length, segments[n].end)
  }
  return 0
}

export function extractSpeakerLines(text, editorial, roleMap, maxEnd = text.length, limit = 80) {
  if (!text || maxEnd <= 0) return []
  const segments = segmentChapter(text, editorial?.removed ?? [], segmentVersion(editorial))
  const annotations = editorial?.annotations ?? {}
  const lines = []
  for (const seg of segments) {
    if (seg.start >= maxEnd) break
    const ann = annotations[seg.id]
    const roleId = ann?.roleId ?? 'narrator'
    const role = roleMap.get(roleId)
    const speaker = role?.name ?? (roleId === 'narrator' ? '旁白' : roleId)
    const sliceEnd = Math.min(seg.end, maxEnd)
    const spoken = text.slice(seg.start, sliceEnd).trim()
    if (!spoken) continue
    lines.push({
      id: seg.id,
      start: seg.start,
      end: sliceEnd,
      roleId,
      speaker,
      emotion: ann?.emotion ?? 'neutral',
      text: spoken,
    })
    if (lines.length >= limit) break
  }
  return lines
}

export function buildPreviewExcerpt(text, index = 0, radius = 48) {
  if (!text) return ''
  const pos = Math.max(0, Math.min(text.length, index))
  const start = Math.max(0, pos - 12)
  const end = Math.min(text.length, pos + radius)
  return text.slice(start, end).replace(/\s+/gu, ' ').trim()
}

export function matchRoleIds(roles, roleName) {
  const key = roleNameKey(String(roleName ?? ''))
  if (!key) return new Set()
  const ids = new Set()
  for (const role of roles) {
    const rk = roleNameKey(role.name ?? '')
    if (rk === key || rk.includes(key) || key.includes(rk)) ids.add(role.id)
  }
  if (key === '旁白') ids.add('narrator')
  return ids
}
