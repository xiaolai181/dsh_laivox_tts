import { translate as t } from '../i18n/locale.mjs'
import React from 'react'

export function GapNotice({ chapter, part, listenFrom }) {
  if (!part || part.ready) return null
  const operation = chapter?.operation
  const active = operation && ['queued', 'running', 'paused'].includes(operation.state) ? operation : null
  if (active && (active.state === 'running' || active.state === 'queued')) {
    return <span className="lv-gap-notice" role="status"><i className="lv-gap-spin" aria-hidden="true"/>{t("正在合成这一段，好了自动播放")}</span>
  }
  if (active?.state === 'paused') {
    return <button type="button" className="lv-gap-action" onClick={() => listenFrom?.(part.start)}>{t("继续制作并从这里听")}</button>
  }
  return <button type="button" className="lv-gap-action" onClick={() => listenFrom?.(part.start)}>{t("从这里继续合成")}</button>
}
