import { displayText, translate as t } from '../i18n/locale.mjs'
import { Icon } from './Icon.jsx'
import { workbenchFrame } from './frame.mjs'
import React, { useLayoutEffect, useId, useRef } from 'react'

export function Overlay({ title, close, children, variant = 'drawer', theme, skin }) {
  const node = useRef(null)
  const closing = useRef(close)
  const label = useId()
  closing.current = close
  useLayoutEffect(() => {
    const dialog = node.current
    const opener = document.activeElement
    const { workbench } = workbenchFrame(dialog)
    dialog.dataset.skin = skin ?? workbench?.dataset.skin ?? 'paper'
    dialog.dataset.theme = theme ?? workbench?.dataset.theme ?? 'system'
    const position = () => {
      const { area, scale } = workbenchFrame(dialog)
      const top = Math.max(0, area?.top ?? 0)
      const left = Math.max(0, area?.left ?? 0)
      const right = Math.min(window.innerWidth, area?.right ?? window.innerWidth)
      const bottom = Math.min(window.innerHeight, area?.bottom ?? window.innerHeight)
      for (const [key, value] of Object.entries({ top, left, right: window.innerWidth - right,
        bottom: window.innerHeight - bottom, width: Math.max(0, right - left), height: Math.max(0, bottom - top) })) {
        dialog.style.setProperty('--lv-overlay-' + key, value / scale + 'px')
      }
    }
    position()
    dialog.showModal()
    const observer = new ResizeObserver(position)
    if (workbench) observer.observe(workbench)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  return <dialog ref={node} className={'lv-ui lv-overlay lv-overlay-' + variant} data-skin={skin} data-theme={theme} aria-labelledby={label}
    onCancel={event => { event.preventDefault(); closing.current() }}
    onClick={event => { if (event.target === event.currentTarget) closing.current() }}>
    <section className="lv-overlay-body">
      <header className="lv-heading"><h2 id={label}>{title}</h2><button type="button" onClick={close} aria-label={t("关闭")}><Icon name="X"/></button></header>
      {children}
    </section>
  </dialog>
}

// Modal confirmation for choices that cannot wait (destructive or blocking).
// The production plan is not one of them: Shell shows it in a Sheet.
export function Decision({ dialog, answer, theme, skin }) {
  return <Overlay title={displayText(dialog.title)} close={() => answer(null)} variant="confirm" theme={theme} skin={skin}>
    <p>{displayText(dialog.text)}</p>
    <div className="lv-inline lv-dialog-actions">{dialog.choices.map(([value, label], index) =>
      <button type="button" key={index} className={index === 0 ? (dialog.destructive ? 'lv-destructive' : 'lv-primary') : ''}
        autoFocus={value === null} onClick={() => answer(value)}>{displayText(label)}</button>)}</div>
  </Overlay>
}
