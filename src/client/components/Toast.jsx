import { displayText, isDeferredText, translate as t } from '../i18n/locale.mjs'
import React from 'react'

export function ToastRegion({ message, onDismiss }) {
  const structured = message && typeof message === 'object' && !isDeferredText(message) ? message : null
  const text = structured ? structured.text : message
  const hasAction = Boolean(structured?.label && (typeof structured.run === 'function' || typeof structured.href === 'string'))
  const dismissible = Boolean(onDismiss && (structured?.dismissible || hasAction))
  return <div className="lv-toast-region" role="status" aria-live="polite">{text && <div className="lv-toast">
    <span>{displayText(text)}</span>
    {hasAction && typeof structured.href === 'string' && <a href={structured.href} target="_blank" rel="noopener noreferrer" onClick={() => onDismiss?.()}>{displayText(structured.label)}</a>}
    {hasAction && typeof structured.run === 'function' && <button type="button" onClick={() => { onDismiss?.(); structured.run?.() }}>{displayText(structured.label)}</button>}
    {dismissible && <button type="button" className="lv-toast-close" aria-label={t('关闭提示')} onClick={() => onDismiss?.()}>×</button>}
  </div>}</div>
}
