import { translate as t } from '../i18n/locale.mjs'
import React, { useMemo, useState } from 'react'
import { segmentChapter, segmentVersion, sourceLines } from '../../domain/segment.mjs'

// Shared by the text and script steps: restoring a line preserves annotations
// by source range because restoring content can change segment ids.
export function RemovedLines({ chapter, state, setDraft, readOnly }) {
  const [page, setPage] = useState(0)
  const removed = useMemo(() => {
    const hidden = new Set(state.removed)
    return chapter.text.split('\n').flatMap((text,line) => hidden.has(line) ? [{line,text}] : [])
  },[chapter.text,state.removed])
  const shown = Math.min(page,Math.max(0,Math.ceil(removed.length/50)-1))
  function restore(line) {
    const version = segmentVersion(chapter.editorial)
    const segments = segmentChapter(chapter.text,state.removed,version)
    const next = state.removed.filter(id => id!==line)
    const ranges = new Map(segments.map(part => [part.start+':'+part.end,state.annotations[part.id]]))
    const annotations = Object.fromEntries(segmentChapter(chapter.text,next,version).flatMap(part => {
      const prior = ranges.get(part.start+':'+part.end)
      return prior ? [[part.id,{...prior,id:part.id}]] : []
    }))
    setDraft({...state,version,removed:next,annotations})
  }
  const kept = useMemo(() => sourceLines(chapter.text).filter(line => line.text.trim() && line.text.length > 1400).length, [chapter.text])
  const keptHint = kept > 0 ? <small>{t('超过 1,400 字的 {count} 行保留原文，未送 AI 清洗。', { count: kept })}</small> : null
  if (!removed.length) return <>
    {keptHint}
    {state.cleaned ? <small>{t("清洗完成 · 移除 0 行")}</small> : null}
  </>
  return <details className="lv-removed-lines"><summary>{t("清洗移除") + " "}{removed.length}{" " + t("行")}</summary>
    {keptHint}
    {removed.slice(shown*50,(shown+1)*50).map(item => <div className="lv-inline" key={item.line}><del>{item.text}</del><button disabled={readOnly} onClick={()=>restore(item.line)}>{t("恢复此行")}</button></div>)}
    {removed.length>50 && <div className="lv-inline"><button disabled={!shown} onClick={()=>setPage(shown-1)}>{t("上一组移除行")}</button><button disabled={(shown+1)*50>=removed.length} onClick={()=>setPage(shown+1)}>{t("下一组移除行")}</button></div>}
  </details>
}
