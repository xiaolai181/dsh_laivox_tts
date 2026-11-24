import english from './en.json' with { type: 'json' }
import traditional from './zh-hant.json' with { type: 'json' }

const baseLanguage = 'zh-CN'
const listeners = new Set()
let language = baseLanguage

export function normalizeLanguage(value) {
  const tag = typeof value === 'string' ? value.toLowerCase() : ''
  if (/^zh(?:-[a-z]{3})?-(?:hant|tw|hk|mo)(?:-|$)/u.test(tag)) return 'zh-Hant'
  if (tag === 'zh' || tag.startsWith('zh-') || !tag) return baseLanguage
  return 'en'
}

export const getLanguage = () => language
export function subscribeLanguage(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function updateLanguage(value) {
  const next = normalizeLanguage(value)
  if (next === language) return
  language = next
  for (const listener of [...listeners]) listener()
}

// DSH owns the persisted preference. Older hosts can still drive the UI
// through the document language without adding a hard service dependency.
export function followHostLanguage(locale, root = globalThis.document?.documentElement) {
  const sync = () => updateLanguage(locale?.getSnapshot?.()?.active ?? root?.lang)
  sync()
  if (typeof locale?.subscribe === 'function') return locale.subscribe(sync)
  if (!root || typeof MutationObserver !== 'function') return () => {}
  const observer = new MutationObserver(sync)
  observer.observe(root, { attributes: true, attributeFilter: ['lang'] })
  return () => observer.disconnect()
}

export function registerTraditionalChinese(locale) {
  if (typeof locale?.addLanguage !== 'function') return
  if (locale.getSnapshot?.()?.locales?.some(item => item.id.toLowerCase() === 'zh-hant')) return
  return locale.addLanguage({ id: 'zh-hant', label: '繁體中文', fallback: 'zh' })
}

// Simplified Chinese is the source text. Only the template is translated.
// Interpolated titles, names, novel text and technical details stay verbatim.
export function translate(source, values, locale = language) {
  const dictionary = locale === 'en' ? english : locale === 'zh-Hant' ? traditional : null
  const template = dictionary && Object.hasOwn(dictionary, source) ? dictionary[source] : source
  return values ? template.replace(/\{(\w+)\}/gu, (token, key) =>
    Object.hasOwn(values, key) ? String(values[key]) : token) : template
}

// Keep transient UI messages in state and translate them on each render.
// The wrapper distinguishes them from raw strings and React state updaters.
const deferredText = Symbol('deferred text')
export const deferText = render => ({ [deferredText]: render })
export const isDeferredText = value => typeof value?.[deferredText] === 'function'
export const displayText = value => isDeferredText(value) ? value[deferredText]() : value
