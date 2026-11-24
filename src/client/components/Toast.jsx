import { displayText } from '../i18n/locale.mjs'
import React from 'react'
export function ToastRegion({ message }) {
  const action = typeof message?.run === 'function' ? message : null
  const text = action ? action.text : message
  return <div className="lv-toast-region" role="status" aria-live="polite">{text && <div className="lv-toast">{displayText(text)}{action?.label && <button type="button" onClick={() => action.run?.()}>{displayText(action.label)}</button>}</div>}</div>
}
