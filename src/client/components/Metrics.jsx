import React from 'react'
import { translate as t } from '../i18n/locale.mjs'
import { formatBytes } from '../api.mjs'
import { Icon } from './Icon.jsx'

export function LevelBar({ label, value, max = 100, valueText, progress = false, busy = false, tone = 'accent' }) {
  const known = Number.isFinite(value) && Number.isFinite(max) && max > 0
  if (!known && (!progress || !busy)) return null
  const limited = known ? Math.min(max, Math.max(0, value)) : undefined
  return <div className="lv-level" role={progress ? 'progressbar' : 'meter'} aria-label={label}
    aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? max : undefined} aria-valuenow={limited}
    aria-valuetext={known ? valueText : undefined} data-tone={tone} data-indeterminate={!known || undefined}
    style={known ? { '--lv-level': limited / max } : undefined}>
    <span aria-hidden="true"/>
  </div>
}

export function ActivityMark({ state, stage, error, pending }) {
  const running = state === 'running' && !pending
  const name = error ? 'CircleAlert' : running ? (stage === 'synthesizing' ? 'AudioLines' : 'LoaderCircle')
    : state === 'paused' ? 'Pause' : state === 'completed' ? 'Check' : state === 'cancelled' ? 'Square' : 'Clock3'
  return <span className="lv-activity-mark" aria-hidden="true" data-mark={name}><Icon name={name} size={14}/></span>
}

export function StorageUsage({ space, compact = false }) {
  const { used, limit } = space ?? {}
  const known = Number.isFinite(used) && used >= 0 && Number.isFinite(limit) && limit > 0
  const amount = known ? formatBytes(used) + ' / ' + formatBytes(limit) : '—'
  const label = compact ? t('音频存储 ·') : t('音频已用')
  const tone = used >= limit ? 'danger' : used >= limit * 0.9 ? 'warn' : 'accent'
  return <div className="lv-storage-metric" data-compact={compact || undefined}>
    <small className="lv-metric-caption" data-tone={known ? tone : undefined}><Icon name="HardDrive" size={15}/><span>{label + ' ' + amount}</span></small>
    {known && <LevelBar label={t('音频已用')} value={used} max={limit} valueText={amount} tone={tone}/>}
  </div>
}
