import { translate as t } from '../i18n/locale.mjs'
import React, { useId, useLayoutEffect, useRef } from 'react'
import { Icon } from './Icon.jsx'

const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])'

// A side panel inside the workbench, between the top bar and the transport
// dock. It is not modal: the dock, the chapter and the top bar stay usable, so
// opening settings or the task list never interrupts listening. Destructive
// confirmations still use the modal Decision dialog.
export function Sheet({ title, close, children, className = '' }) {
  const node = useRef(null)
  const closing = useRef(close)
  const label = useId()
  closing.current = close
  useLayoutEffect(() => {
    const sheet = node.current
    const opener = document.activeElement
    const first = sheet.querySelector('[autofocus]') ?? sheet.querySelector('.lv-sheet-body ' + FOCUSABLE.split(',').join(',.lv-sheet-body '))
    ;(first ?? sheet).focus({ preventScroll: true })
    return () => {
      // Only hand focus back when it was still inside the panel; a listener who
      // moved on to the dock keeps their place.
      const current = document.activeElement
      if (opener?.isConnected && (!current || current === document.body || sheet.contains(current))) opener.focus({ preventScroll: true })
    }
  }, [])
  function keyDown(event) {
    if (event.key !== 'Escape' || event.defaultPrevented || event.target.closest?.('[popover]')) return
    event.preventDefault()
    event.stopPropagation()
    closing.current()
  }
  return <aside ref={node} className={'lv-sheet ' + className} role="dialog" aria-modal="false" aria-labelledby={label} tabIndex={-1} onKeyDown={keyDown}>
    <header className="lv-sheet-head"><h2 id={label}>{title}</h2><button type="button" className="lv-icon-button" onClick={close} aria-label={t("关闭")}><Icon name="X"/></button></header>
    <div className="lv-sheet-body">{children}</div>
  </aside>
}
