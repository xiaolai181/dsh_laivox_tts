import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

const DEFAULT_PACKAGE = 'dsh-laivox-tts'
const REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com']
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const PROFILE_RE = /^[A-Za-z0-9._-]+$/u

export function compareVersions(a, b) {
  const parse = value => {
    const [core, pre = ''] = String(value ?? '').replace(/^v/u, '').split('-', 2)
    return { nums: core.split('.').map(part => Number.parseInt(part, 10) || 0), pre }
  }
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < 3; index++) {
    const diff = (left.nums[index] || 0) - (right.nums[index] || 0)
    if (diff) return diff
  }
  if (left.pre === right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1
  return left.pre < right.pre ? -1 : 1
}

function managerCode(result) {
  if (!result || (result.application !== 'failed' && result.application !== 'cancelled' && !result.error)) return ''
  return result.error?.code || result.application || 'failed'
}

export function createUpdateChecker({
  pkgRoot,
  profileDir = '',
  pluginManager = () => null,
  fetchImpl = globalThis.fetch,
  ttlMs = 10 * 60 * 1000,
  timeoutMs = 6000,
} = {}) {
  let cache = null
  let inflight = null

  async function readLocalPackage() {
    if (!pkgRoot) return {}
    try { return JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8')) }
    catch { return {} }
  }

  function installCommand(pkgName, tag) {
    const profile = basename(String(profileDir || '').replaceAll('\\', '/'))
    const target = `${pkgName}@${tag || 'latest'}`
    return PROFILE_RE.test(profile) && profile !== '.' && profile !== '..'
      ? `dsh plugin --profile ${profile} add ${target}`
      : `dsh plugin add ${target}`
  }

  async function fetchLatest(pkgName, force) {
    if (!force && cache && cache.pkg === pkgName && Date.now() - cache.at < ttlMs) {
      return { latest: cache.version, source: cache.source, error: '' }
    }
    if (inflight && !force) return inflight
    const task = (async () => {
      if (typeof fetchImpl !== 'function') return { latest: '', source: '', error: 'UPDATE_CHECK_FAILED' }
      for (const registry of REGISTRIES) {
        try {
          const response = await fetchImpl(`${registry}/${encodeURIComponent(pkgName)}/latest`, {
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (!response?.ok) continue
          const data = await response.json()
          const version = String(data?.version ?? '').trim()
          if (VERSION_RE.test(version)) {
            cache = { pkg: pkgName, version, source: registry, at: Date.now() }
            return { latest: version, source: registry, error: '' }
          }
        } catch {
          // Try the fallback mirror when the primary registry times out or fails.
        }
      }
      return { latest: '', source: '', error: 'UPDATE_CHECK_FAILED' }
    })()
    inflight = task
    try { return await task }
    finally { if (inflight === task) inflight = null }
  }

  async function info({ check = false, force = false } = {}) {
    const pkg = await readLocalPackage()
    const pkgName = typeof pkg.name === 'string' && pkg.name ? pkg.name : DEFAULT_PACKAGE
    const running = typeof pkg.version === 'string' && VERSION_RE.test(pkg.version) ? pkg.version : ''
    let manager = null
    try { manager = pluginManager?.() } catch { manager = null }
    const canAutoUpdate = Boolean(manager && typeof manager.installBundle === 'function')
    if (!check) {
      const cached = cache && cache.pkg === pkgName && Date.now() - cache.at < ttlMs ? cache : null
      const latest = cached?.version ?? ''
      const available = Boolean(latest && running && compareVersions(latest, running) > 0)
      return {
        package: pkgName,
        running,
        latest,
        available,
        checked: Boolean(cached),
        checkedAt: cached?.at ?? null,
        source: cached?.source ?? '',
        error: '',
        canAutoUpdate,
        command: installCommand(pkgName, available ? latest : 'latest'),
      }
    }
    const remote = await fetchLatest(pkgName, force)
    const available = Boolean(remote.latest && running && compareVersions(remote.latest, running) > 0)
    return {
      package: pkgName,
      running,
      latest: remote.latest,
      available,
      checked: !remote.error,
      checkedAt: remote.error ? null : Date.now(),
      source: remote.source,
      error: remote.error,
      canAutoUpdate,
      command: installCommand(pkgName, available ? remote.latest : 'latest'),
    }
  }

  async function applyUpdate() {
    const status = await info({ check: true, force: true })
    if (status.error || !status.latest) {
      return { ok: false, error: 'UPDATE_CHECK_FAILED', command: status.command }
    }
    if (!status.available) {
      return { ok: true, updated: false, running: status.running, latest: status.latest, command: status.command }
    }
    let manager = null
    try { manager = pluginManager?.() } catch { manager = null }
    if (!manager || typeof manager.installBundle !== 'function') {
      return { ok: false, error: 'UPDATE_MANUAL_REQUIRED', command: status.command }
    }
    try {
      const result = await manager.installBundle(`${status.package}@${status.latest}`, { enabled: true })
      const code = managerCode(result)
      if (code) return { ok: false, error: 'UPDATE_MANUAL_REQUIRED', detail: code, command: status.command }
      return { ok: true, updated: true, running: status.running, latest: status.latest, restartRequired: true, command: status.command }
    } catch (error) {
      return { ok: false, error: 'UPDATE_MANUAL_REQUIRED', detail: error?.code || error?.message || '', command: status.command }
    }
  }

  return { info, applyUpdate }
}
