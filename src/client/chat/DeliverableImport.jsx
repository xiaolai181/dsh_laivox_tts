import { displayText, deferText, translate as t } from '../i18n/locale.mjs'
import React, { useEffect, useRef, useState } from 'react'
import { explain, get, post } from '../api.mjs'

// One lookup per delivered file and page: a conversation re-renders its file
// cards often, and the answer (name, type) does not change.
const described = new Map()
function describe(actionUrl) {
  if (!described.has(actionUrl)) {
    const pending = get('deliverable/describe', { url: actionUrl }).catch(() => ({ importable: false }))
    described.set(actionUrl, pending)
    if (described.size > 300) described.delete(described.keys().next().value)
  }
  return described.get(actionUrl)
}

// "导入到 LaiVox" next to a delivered TXT/EPUB file. The button appears
// only once the plugin has confirmed the file type; anything it cannot read
// (another file type, a missing service) shows nothing.
export function DeliverableImport({ actionUrl, openImport }) {
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    if (!actionUrl) return undefined
    let current = true
    void describe(actionUrl).then(value => { if (current && alive.current) setFile(value) })
    return () => { current = false }
  }, [actionUrl])
  if (!file?.importable) return null
  async function click() {
    if (busy) return
    setBusy(true); setError('')
    try {
      const staged = await post('deliverable/import', { url: actionUrl })
      openImport(staged.id, staged.session)
    } catch (failure) { if (alive.current) setError(deferText(() => explain(failure))) }
    finally { if (alive.current) setBusy(false) }
  }
  return <span className="lv-host lv-hdeliver">
    <button type="button" className="lv-hbtn" disabled={busy} title={t("把 {v1} 导入 LaiVox 书架", { v1: file.name })} onClick={click}>{busy ? t('正在读取…') : t('导入到 LaiVox')}</button>
    {error && <span className="lv-halert" role="alert">{displayText(error)}</span>}
  </span>
}
