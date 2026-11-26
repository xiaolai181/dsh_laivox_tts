import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState } from 'react'

// In full text the chapter title and the view switch live in the scrolling
// column. Scrolling down tucks them away; scrolling up brings them back
// without returning to the top of the chapter.
export function ProseChrome({ enabled, forceOpen = false, children }) {
  const anchor = useRef(null)
  const rail = useRef(null)
  const [open, setOpen] = useState(true)
  const [progress, setProgress] = useState(null)
  const prevForce = useRef(forceOpen)

  useEffect(() => {
    if (forceOpen && !prevForce.current) setOpen(true)
    prevForce.current = forceOpen
  }, [forceOpen])

  useEffect(() => {
    if (!enabled) return
    const room = anchor.current?.closest('.lv-scene-room')
    if (!room) return
    let last = room.scrollTop
    let acc = 0
    let frame = 0
    const measure = () => {
      frame = 0
      const max = room.scrollHeight - room.clientHeight
      setProgress(max > 32 ? room.scrollTop / max : null)
    }
    const onScroll = () => {
      const y = room.scrollTop
      acc += y - last
      last = y
      if (y < 40) { acc = 0; setOpen(true) }
      else if (acc <= -18) { acc = 0; setOpen(true) }
      else if (acc >= 18) { acc = 0; setOpen(false) }
      if (!frame) frame = requestAnimationFrame(measure)
    }
    room.addEventListener('scroll', onScroll, { passive: true })
    measure()
    const observer = new ResizeObserver(() => { if (!frame) frame = requestAnimationFrame(measure) })
    observer.observe(room)
    return () => {
      room.removeEventListener('scroll', onScroll)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [enabled])

  function jump(clientY) {
    const room = anchor.current?.closest('.lv-scene-room')
    const track = rail.current?.querySelector('.lv-read-rail-track')
    const box = track?.getBoundingClientRect()
    if (!room || !box?.height) return
    const ratio = Math.min(1, Math.max(0, (clientY - box.top) / box.height))
    room.scrollTop = ratio * Math.max(0, room.scrollHeight - room.clientHeight)
  }

  if (!enabled) return children
  const percent = progress == null ? 0 : Math.round(progress * 100)
  return <>
    <div ref={anchor} className="lv-stage-chrome" data-open={open}>
      <div className="lv-stage-chrome-bar">{children}</div>
    </div>
    {progress != null && <div className="lv-read-rail-slot">
      <div ref={rail} className="lv-read-rail" role="slider" aria-label={t("全文阅读进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={t("已读 {v1}%", { v1: percent })} tabIndex={0}
        onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); jump(event.clientY) }}
        onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) jump(event.clientY) }}
        onKeyDown={event => {
          const room = anchor.current?.closest('.lv-scene-room')
          if (!room) return
          const max = room.scrollHeight - room.clientHeight
          if (max <= 0) return
          const current = room.scrollTop / max
          const next = event.key === 'ArrowDown' ? current + .05 : event.key === 'ArrowUp' ? current - .05
            : event.key === 'PageDown' ? current + .15 : event.key === 'PageUp' ? current - .15
            : event.key === 'Home' ? 0 : event.key === 'End' ? 1 : null
          if (next == null) return
          event.preventDefault()
          room.scrollTop = Math.min(1, Math.max(0, next)) * max
        }}>
        <i className="lv-read-rail-track" aria-hidden="true">
          <i style={{ height: percent + '%' }}/>
          {[25, 50, 75].map(tick => <i key={tick} className="lv-read-rail-tick" style={{ top: tick + '%' }}/>)}
        </i>
        <b className="lv-read-rail-mark" style={{ top: `calc(8px + (100% - 16px) * ${progress})` }}><small>{percent}</small></b>
      </div>
    </div>}
  </>
}
