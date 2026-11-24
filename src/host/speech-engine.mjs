// Parent side of the resident speech worker (speech-worker.mjs). Starts it on
// demand, sends requests over IPC and settles them by id. The worker exits by
// itself after a minute without work; a crash or exit fails what was in flight
// with EDGE_UNAVAILABLE and the next request starts a fresh worker.
import { fork } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const workerFile = fileURLToPath(new URL('./speech-worker.mjs', import.meta.url))
const testsRoot = fileURLToPath(new URL('../../tests/', import.meta.url))

// The test hook only accepts a file under this plugin's tests directory.
// A published package has no tests directory, so the variable does nothing there.
function speechWorkerFile() {
  const override = process.env.LAIVOX_SPEECH_WORKER_FILE
  if (!override) return workerFile
  try {
    const root = realpathSync(testsRoot)
    const target = realpathSync(override)
    if (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep)) return target
  } catch { /* the override or the tests directory is not there */ }
  console.warn('LAIVOX_SPEECH_WORKER_FILE ignored: ' + override)
  return workerFile
}

export function createSpeechEngine({ timeout = 20_000, start } = {}) {
  let child = null
  let counter = 0
  let disposed = false
  const pending = new Map()

  function launch() {
    if (start) return start()
    // Tests point this at a local stand-in so they never reach the online service.
    return fork(speechWorkerFile(), [], {
      execPath: process.execPath, serialization: 'advanced', windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
    })
  }

  function worker() {
    if (disposed) throw new Error('PLUGIN_STOPPED')
    if (child) return child
    const current = launch()
    child = current
    let stderr = ''
    current.stderr?.on('data', chunk => { if (stderr.length < 4096) stderr += chunk.toString('utf8') })
    current.on('message', message => {
      const request = pending.get(message?.id)
      if (!request) return
      if (message.type === 'audio') {
        const data = message.data
        request.resolve(Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength))
      } else if (message.type === 'error') {
        request.reject(Object.assign(new Error(message.code || 'EDGE_UNAVAILABLE'), { detail: message.detail || null }))
      }
    })
    const gone = () => {
      if (child === current) child = null
      for (const request of [...pending.values()]) {
        if (request.child === current) request.reject(Object.assign(new Error('EDGE_UNAVAILABLE'), { detail: stderr.trim().slice(-600) || null }))
      }
    }
    current.on('exit', gone)
    current.on('error', error => {
      for (const request of [...pending.values()]) {
        if (request.child === current) request.reject(Object.assign(new Error('EDGE_WORKER_START_FAILED'), { detail: String(error?.message ?? error) }))
      }
      gone()
    })
    return current
  }

  function send(target, message) {
    try { target.send(message, error => { if (error) target.kill() }) }
    catch { target.kill() }
  }

  // MP3 bytes of one part. Aborting cancels it in the worker; a timeout restarts
  // the worker (its connection may be stuck), which also fails anything else.
  function synthesize({ text, voiceId, prosody }, signal) {
    signal?.throwIfAborted()
    const target = worker()
    const id = ++counter
    return new Promise((resolve, reject) => {
      const request = { child: target, resolve: value => finish(() => resolve(value)), reject: error => finish(() => reject(error)) }
      const timer = setTimeout(() => { request.reject(new Error('EDGE_TIMEOUT')); target.kill() }, timeout)
      const abort = () => { send(target, { type: 'cancel', id }); request.reject(signal.reason) }
      function finish(settle) {
        if (!pending.has(id)) return
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        settle()
      }
      pending.set(id, request)
      signal?.addEventListener('abort', abort, { once: true })
      send(target, { type: 'synthesize', id, text, voiceId, prosody })
    })
  }

  return {
    synthesize,
    // Open the voice's connection ahead of the first request (button hover).
    warm(voiceId) {
      if (disposed) return
      try { send(worker(), { type: 'warm', voiceId }) } catch { /* starts on the next request */ }
    },
    get running() { return Boolean(child) },
    dispose() {
      disposed = true
      const current = child
      child = null
      for (const request of [...pending.values()]) request.reject(new Error('PLUGIN_STOPPED'))
      current?.kill()
    },
  }
}
