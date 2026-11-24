// Voice direction shared by the host and the client bundle. Keep this file free
// of node: imports. The instruct text follows the LaiVox scriptwriter contract
// (natural-language delivery notes, no gender or age words). Clients only do
// surface normalization; consistency comes from the prompt, never from merging
// similar texts after the fact.

export const INSTRUCT_MAX = 60

export const BANNED_INSTRUCT_TERMS = [
  '男', '女', '老人', '老者', '老头', '老太', '老年', '中年', '青年', '少年', '少女', '幼年',
  '孩子', '小孩', '孩童', '儿童', '童声', '婴儿', '大叔', '大婶', '大妈', '大爷', '姑娘', '小伙',
]

const wrappers = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"'], ["'", "'"], ['(', ')'], ['（', '）'], ['【', '】']]
const stops = new Set(['。', '！', '？', '；', '，'])

export function normalizeInstruct(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  for (const [open, close] of wrappers) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim()
      break
    }
  }
  const chars = Array.from(text)
  if (chars.length > INSTRUCT_MAX) {
    let cut = -1
    for (let index = INSTRUCT_MAX - 1; index >= 0; index--) {
      if (stops.has(chars[index])) { cut = index + 1; break }
    }
    text = chars.slice(0, cut > 0 ? cut : INSTRUCT_MAX).join('')
  }
  if (BANNED_INSTRUCT_TERMS.some(term => text.includes(term))) return ''
  return text
}

// Copied verbatim from the original synthesis table. Changing a phrase or a
// number changes what older annotations send to LaiVox and how Edge sounds.
export const LEGACY_MOODS = {
  happy: ['轻快，带笑意', 5, 3], sad: ['低沉，略慢', -5, -4],
  angry: ['有力度，情绪克制', 4, 1], afraid: ['紧张，声音略轻', 4, 3],
  tense: ['紧张，节奏略快', 4, 1], gentle: ['温和，语速舒缓', -4, 1],
}

export function legacyInstruct(emotion, intensity) {
  const mood = Object.hasOwn(LEGACY_MOODS, emotion) ? LEGACY_MOODS[emotion] : undefined
  return mood && intensity ? mood[0] : ''
}

export function instructFor(part) {
  return normalizeInstruct(part?.instruct) || legacyInstruct(part?.emotion, part?.intensity || 0)
}

const signed = (num, suffix) => (num >= 0 ? '+' : '') + num + suffix

export function edgeProsody(emotion, intensity) {
  const mood = Object.hasOwn(LEGACY_MOODS, emotion) ? LEGACY_MOODS[emotion] : undefined
  const level = intensity || 0
  return mood
    ? { rate: signed(mood[1] * level, '%'), pitch: signed(mood[2] * level, 'Hz') }
    : { rate: '+0%', pitch: '+0Hz' }
}

export const INSTRUCT_PRESETS = {
  neutral: ['客观叙述，语气平稳。', '自然交谈，语速适中。', '平静地陈述，不带起伏。'],
  happy: ['语气轻快，带着笑意。', '难掩欣喜，语速稍快。', '兴奋地高声说，笑意满满。'],
  sad: ['声音低沉，语速放缓。', '带着失落，轻声叹息。', '强忍悲痛，声音哽咽，语速缓慢。'],
  angry: ['语气生硬，透着不满。', '压着怒火，字字加重。', '用强烈愤怒的语气斥责。'],
  afraid: ['声音发紧，带着不安。', '压低声音，气息发颤。', '惊恐地急促喊出，声音发抖。'],
  tense: ['语速稍快，透着紧张。', '屏住气息，低声急促。', '节奏急迫，声音绷紧。'],
  gentle: ['语气温和，轻声细语。', '柔声安抚，语速舒缓。', '满怀温柔，声音轻软。'],
}

export function presetIntensity(emotion, index) {
  return emotion === 'neutral' ? 0 : [1, 1, 2][index] ?? 1
}
