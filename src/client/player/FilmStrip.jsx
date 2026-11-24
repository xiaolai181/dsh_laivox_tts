import { roleDisplayName } from '../i18n/display.mjs'
import { translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Tooltip } from '../components/Popover.jsx'
// Keep aligned with the default EDGE_CONCURRENCY in host/jobs.mjs.
const EDGE_CONCURRENCY = 2
export function FilmStrip({ player, chapter, listenFrom }) {
  const s = useSyncExternalStore(player.subscribe, player.getSnapshot)
  const root = useRef(null)
  const id=useId()
  const dragging=useRef(null)
  const dragged=useRef(false)
  const manual = useRef(0)
  // Scrolls the strip makes itself must not count as the user browsing.
  const autoScroll = useRef(false)
  // While dragging, only this preview moves; the player seeks once on release.
  const [preview, setPreview] = useState(null)
  const [view, setView] = useState({left:0,width:800})
  const [focus, setFocus] = useState(0)
  // Natural widths follow each part's length; when the whole chapter fits,
  // the strip is stretched to fill the row in proportion to duration, so a
  // short chapter reads as a timeline instead of a few dots.
  const layout = useMemo(()=>{
    const GAP=3
    const weight=part=>Math.max(.3,part.ready&&part.seconds?part.seconds:(part.end-part.start)*.22)
    const natural=s.segments.map(part=>Math.max(6,Math.min(72,weight(part)*3)))
    const naturalTotal=natural.reduce((sum,width)=>sum+width+GAP,0)
    const room=view.width-GAP*s.segments.length
    const fill=s.segments.length>0 && naturalTotal<=view.width && room>0
    const sum=s.segments.reduce((total,part)=>total+weight(part),0)
    let total=0
    const positions=s.segments.map((part,index)=>{const start=total;const width=fill?Math.max(4,room*weight(part)/sum):natural[index];total+=width+GAP;return {start,width}})
    return {positions,total}
  },[s.segments,view.width])
  useEffect(()=>{
    const element=root.current
    const observer=new ResizeObserver(()=>setView({left:element.scrollLeft,width:element.clientWidth}))
    observer.observe(element)
    return ()=>observer.disconnect()
  },[])
  useEffect(()=>{
    const at=layout.positions[s.n]
    if (at && Date.now()-manual.current>1500) { autoScroll.current=true; root.current.scrollTo({left:at.start-root.current.clientWidth/2,behavior:'instant'}) }
  },[s.n,layout.positions])
  let from=0, to=s.segments.length
  if (to>200) {
    from=Math.max(0,layout.positions.findIndex(part=>part.start+part.width>=view.left)-40)
    const right=layout.positions.findIndex(part=>part.start>view.left+view.width)
    to=right<0?to:Math.min(to,right+40)
  }
  const pending=s.segments.findIndex(part=>!part.ready)
  const all=s.segments.length>0 && s.segments.every(part=>part.ready)
  const duration=s.segments.reduce((sum,part)=>sum+(part.seconds||0),0)
  function dragTo(event) {
    const pointer=dragging.current
    if(!pointer || Math.abs(event.clientX-pointer.x)<4 && !dragged.current)return
    if(!dragged.current)event.currentTarget.setPointerCapture(event.pointerId)
    dragged.current=true
    const position=event.clientX-root.current.getBoundingClientRect().left+root.current.scrollLeft
    let n=layout.positions.findIndex(part=>part.start+part.width>=position)
    if(n<0)n=s.segments.length-1
    const part=layout.positions[n]
    const target={n,offset:Math.max(0,Math.min(1,(position-part.start)/part.width))*s.segments[n].seconds}
    pointer.target=target
    setPreview(target)
  }
  function endDrag(commit) {
    const target=dragging.current?.target
    dragging.current=null
    setPreview(null)
    if(commit && target)player.seek(target.n,target.offset)
  }
  function seek(n, fraction=0) {
    const part=s.segments[n]
    if(!part)return
    if(!part.ready){if(listenFrom)void listenFrom(part.start);return}
    player.seek(n,fraction>0&&part.seconds?Math.min(part.seconds-.05,fraction*part.seconds):0)
  }
  const shown=preview ?? {n:s.n,offset:s.offset}
  const at=layout.positions[shown.n]
  const played=at?at.start+at.width*Math.max(0,Math.min(1,s.segments[shown.n]?.seconds?shown.offset/s.segments[shown.n].seconds:0)):0
  return <div className="lv-film-area" data-engine={chapter?.playbackJob?.engine ?? 'edge'} data-stale={Boolean(s.stale)}>
    <div ref={root} className="lv-film-scroll" role="listbox" aria-label={t("音频段落")} tabIndex={0} aria-activedescendant={focus>=from && focus<to?id+'-'+focus:undefined} onFocus={()=>setFocus(s.n)}
      onWheel={()=>{manual.current=Date.now()}} onPointerDown={event=>{
        manual.current=Date.now();dragged.current=false
        if(all && event.button===0){dragging.current={x:event.clientX}}
      }}
      onPointerMove={dragTo} onPointerUp={()=>endDrag(true)} onPointerCancel={()=>endDrag(false)}
      onClickCapture={event=>{if(dragged.current){event.preventDefault();event.stopPropagation();dragged.current=false}}}
      onScroll={e=>{if(autoScroll.current)autoScroll.current=false;else manual.current=Date.now();setView({left:e.currentTarget.scrollLeft,width:e.currentTarget.clientWidth})}}
      onKeyDown={event=>{
        if(!['ArrowLeft','ArrowRight','Enter'].includes(event.key))return
        event.preventDefault();event.stopPropagation()
        if(event.key==='Enter'){seek(focus);return}
        const n=Math.max(0,Math.min(s.segments.length-1,focus+(event.key==='ArrowRight'?1:-1)))
        setFocus(n);manual.current=Date.now();root.current.scrollLeft=(layout.positions[n]?.start??0)-root.current.clientWidth/2
      }}>
      <div className="lv-film-track" style={{width:Math.max(layout.total,view.width)}}>
        <i className="lv-film-progress" aria-hidden="true" style={{width:played}}/>
        {s.segments.slice(from,to).map((part,index)=>{
          const n=from+index
          const error=chapter?.operation?.errorPart?.n===n
          const generating=chapter?.playbackJob?.state==='running' && n>=pending && n<pending+EDGE_CONCURRENCY
          const state=error?'err':n===s.n?'cur':part.ready?'done':generating?'gen':'q'
          const role=roleDisplayName(chapter?.roles?.find(role=>role.id===part.roleId)) ?? t('旁白')
          return <span className="lv-film-position" key={n} style={{left:layout.positions[n].start,width:layout.positions[n].width}}><Tooltip text={'#'+(n+1)+' · '+role+' · '+({err:t('失败'),cur:t('当前段'),done:t('可收听'),gen:t('合成中'),q:t('未生成')}[state])}>
            <button className="lv-film-segment" id={id+'-'+n} role="option" tabIndex={-1} aria-selected={n===s.n} aria-label={t("第 {v1} 段", { v1: n+1 })} data-state={state} data-focus={n===focus} onClick={event=>{const box=event.currentTarget.getBoundingClientRect();setFocus(n);seek(n,box.width?(event.clientX-box.left)/box.width:0)}}/>
          </Tooltip></span>
        })}
      </div>
    </div>
    {all && <input className="lv-film-time" type="range" aria-label={t("跳转音频时间")} min="0" max={duration} step=".1" value={s.segments.slice(0,s.n).reduce((sum,part)=>sum+part.seconds,0)+s.offset} onChange={event=>player.seekTime(Number(event.target.value))}/>}
  </div>
}
