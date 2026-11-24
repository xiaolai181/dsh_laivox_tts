import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { autoUpdate, computePosition, flip, offset, platform, shift, size } from '@floating-ui/dom'
import { workbenchFrame } from './frame.mjs'

export function usePopover(anchorRef, floatingRef, { placement = 'top', open } = {}) {
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const floating = floatingRef.current
    if (!open || !anchor || !floating) return
    let alive = true
    const stop = autoUpdate(anchor, floating, () => {
      // The plugin area, not the whole window, is the boundary: the host shows
      // other panels around it.
      const { workbench, scale } = workbenchFrame(anchor)
      const boundary = workbench ?? 'clippingAncestors'
      // floating-ui measures the anchor on screen but the popover in its own
      // layout pixels; under zoom those differ, so the popover size is scaled
      // to screen pixels too and the result converted back below.
      const scaled = scale === 1 ? platform : { ...platform, getDimensions: element => {
        if (element !== floating) return platform.getDimensions(element)
        const { width, height } = floating.getBoundingClientRect()
        return { width, height }
      } }
      void computePosition(anchor, floating, { placement, strategy: 'fixed', platform: scaled, middleware: [offset(8), flip({ boundary, padding: 8 }), shift({ boundary, padding: 8 }),
        size({ boundary, padding: 8, apply({ availableHeight }) { floating.style.maxHeight = `${Math.max(120, availableHeight) / scale}px` } })] })
        .then(({ x, y }) => {
          if (!alive) return
          // The popover lives in the top layer but still inherits the host's
          // zoom, so viewport coordinates are converted back to its own pixels.
          Object.assign(floating.style, { left: `${x / scale}px`, top: `${y / scale}px` })
        })
    })
    return () => { alive = false; stop() }
  }, [open, placement, anchorRef, floatingRef])
}

export function Popover({ label, trigger, children, placement = 'top', className = '' }) {
  const anchor = useRef(null)
  const floating = useRef(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [appearance, setAppearance] = useState({ skin: 'paper', theme: 'system' })
  usePopover(anchor, floating, { placement, open })
  // The DSH host's React only registers `toggle` on <details>. A native listener
  // still runs for the Popover API, which is what actually opens this layer.
  useEffect(() => {
    const layer = floating.current
    if (!layer) return
    function onToggle(event) {
      const opened = typeof event.newState === 'string' ? event.newState === 'open' : event.oldState === 'closed'
      setOpen(opened)
    }
    layer.addEventListener('toggle', onToggle)
    return () => layer.removeEventListener('toggle', onToggle)
  }, [])
  // Pressing the trigger of an open popover first light-dismisses it; the click
  // that follows would reopen it. Remember the state at pointerdown so a second
  // press closes it. Keyboard activation has no pointerdown and simply toggles.
  const wasOpen = useRef(false)
  function remember() {
    try { wasOpen.current = floating.current?.matches(':popover-open') ?? false } catch { wasOpen.current = false }
  }
  function show() {
    if (wasOpen.current) { wasOpen.current = false; return }
    const root = anchor.current.closest('.lv-ui')
    setAppearance({ skin: root?.dataset.skin ?? 'paper', theme: root?.dataset.theme ?? 'system' })
    floating.current.togglePopover()
  }
  return <>
    <button ref={anchor} className={className} type="button" aria-label={label} aria-expanded={open} aria-controls={id} onPointerDown={remember} onClick={show}>{trigger ?? label}</button>
    <div ref={floating} id={id} popover="auto" className="lv-ui lv-popover" data-skin={appearance.skin} data-theme={appearance.theme}>
      {typeof children === 'function' ? children(() => { floating.current.hidePopover(); anchor.current.focus() }) : children}
    </div>
  </>
}

export function Tooltip({ text, children }) {
  const anchor = useRef(null)
  const floating = useRef(null)
  const id = useId()
  const [open, setOpen] = useState(false)
  const [appearance, setAppearance] = useState({})
  usePopover(anchor, floating, { open })
  function show() {
    const root = anchor.current.closest('.lv-ui')
    setAppearance({ skin: root?.dataset.skin ?? 'paper', theme: root?.dataset.theme ?? 'system' })
    floating.current.showPopover()
    setOpen(true)
  }
  function hide() { floating.current.hidePopover(); setOpen(false) }
  return <span ref={anchor} className="lv-tooltip-anchor" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide} aria-describedby={id}>
    {children}<span ref={floating} id={id} role="tooltip" popover="manual" className="lv-ui lv-tooltip" data-skin={appearance.skin} data-theme={appearance.theme}>{text}</span>
  </span>
}
