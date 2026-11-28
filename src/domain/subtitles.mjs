const pad = (value, width = 2) => String(Math.floor(Math.max(0, value))).padStart(width, '0')

const cleanText = value => String(value ?? '').replace(/\s+/gu, ' ').trim()

function roleNameOf(roles, roleId) {
  if (!roleId || roleId === 'narrator') return ''
  if (roles instanceof Map) return String(roles.get(roleId)?.name ?? roles.get(roleId) ?? '').trim()
  if (roles && typeof roles === 'object') return String(roles[roleId]?.name ?? roles[roleId] ?? '').trim()
  return ''
}

export function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round((Number(seconds) || 0) * 1000))
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  const millis = ms % 1000
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(millis, 3)}`
}

export function lrcTimestamp(seconds) {
  const cs = Math.max(0, Math.round((Number(seconds) || 0) * 100))
  const minutes = Math.floor(cs / 6000)
  const secs = Math.floor((cs % 6000) / 100)
  const hundredths = cs % 100
  return `[${pad(minutes)}:${pad(secs)}.${pad(hundredths)}]`
}

export function buildSubtitleCues(chapters, {
  roles = null,
  includeSpeaker = true,
  includeNarrator = false,
  narratorLabel = '旁白',
  chapterGapSeconds = 1.5,
} = {}) {
  const cues = []
  let cursor = 0
  const list = Array.isArray(chapters) ? chapters : []
  for (let chapterIndex = 0; chapterIndex < list.length; chapterIndex++) {
    const chapter = list[chapterIndex]
    if (chapterIndex > 0 && chapterGapSeconds > 0) cursor += chapterGapSeconds
    const chapterRoles = chapter?.roles ?? roles
    const parts = Array.isArray(chapter?.parts) ? chapter.parts : []
    for (const part of parts) {
      const duration = Number.isFinite(part?.seconds) && part.seconds > 0 ? part.seconds : 0
      const rawText = cleanText(part?.text)
      const speaker = part?.roleId === 'narrator'
        ? (includeNarrator ? narratorLabel : '')
        : (roleNameOf(chapterRoles, part?.roleId) || '')
      if (rawText && duration > 0) {
        const text = includeSpeaker && speaker ? `【${speaker}】${rawText}` : rawText
        cues.push({
          start: cursor,
          end: cursor + duration,
          text,
          rawText,
          speaker,
          chapterTitle: String(chapter?.title ?? ''),
        })
      }
      cursor += duration
    }
  }
  return { cues, totalSeconds: cursor }
}

export function formatSrt(cues) {
  if (!Array.isArray(cues) || !cues.length) return ''
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.start)} --> ${srtTimestamp(cue.end)}\n${cleanText(cue.text)}\n`).join('\n')
}

export function formatLrc(cues, { title = '', author = '' } = {}) {
  const lines = []
  const safeTitle = cleanText(title)
  const safeAuthor = cleanText(author)
  if (safeTitle) lines.push(`[ti:${safeTitle}]`)
  if (safeAuthor) lines.push(`[ar:${safeAuthor}]`)
  for (const cue of Array.isArray(cues) ? cues : []) {
    const text = cleanText(cue?.text)
    if (!text) continue
    lines.push(`${lrcTimestamp(cue.start)}${text}`)
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

export function formatScriptMarkdown(chapters, { bookTitle = '', roles = null, narratorLabel = '旁白' } = {}) {
  const out = []
  if (cleanText(bookTitle)) out.push(`# ${cleanText(bookTitle)}`, '')
  for (const chapter of Array.isArray(chapters) ? chapters : []) {
    if (cleanText(chapter?.title)) out.push(`## ${cleanText(chapter.title)}`, '')
    const chapterRoles = chapter?.roles ?? roles
    for (const part of Array.isArray(chapter?.parts) ? chapter.parts : []) {
      const rawText = cleanText(part?.text)
      if (!rawText) continue
      const speaker = part?.roleId === 'narrator' ? narratorLabel : (roleNameOf(chapterRoles, part?.roleId) || narratorLabel)
      out.push(`- **${speaker}**：${rawText}`)
    }
    out.push('')
  }
  return out.join('\n')
}

function id3TextFrame(frameId, text) {
  const clean = String(text ?? '').trim()
  if (!clean) return null
  const utf16 = Buffer.from(clean, 'utf16le')
  const payload = Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), utf16])
  const header = Buffer.alloc(10)
  header.write(frameId, 0, 4, 'ascii')
  header.writeUInt32BE(payload.length, 4)
  return Buffer.concat([header, payload])
}

export function buildId3v2TitleTag(title, artist = '') {
  const frames = [id3TextFrame('TIT2', title), id3TextFrame('TPE1', artist)].filter(Boolean)
  if (!frames.length) return Buffer.alloc(0)
  const body = Buffer.concat(frames)
  const size = body.length
  const header = Buffer.from([
    0x49, 0x44, 0x33, 0x03, 0x00, 0x00,
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ])
  return Buffer.concat([header, body])
}
