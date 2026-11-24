import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { hasSpeakable } from '../domain/segment.mjs'

// Order matters: chooseVoices hands out the first unused voice of a matching
// gender, so new voices are only ever appended. Appending leaves every role that
// already had its own voice untouched. auto: false voices (regional accents)
// are offered in the picker but never assigned automatically.
// Added after 10/10 real synthesis runs each (5 simplified, 5
// traditional); zh-TW-YunJheNeural failed 4/10 with truncated streams and is excluded.
// Later voices are appended. Chinese automatic assignment still walks the
// original zh-CN / zh-TW entries first, so roles that already had a voice keep it.
export const edgeVoices = [
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', age: 'adult', auto: true },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', age: 'adult', auto: true },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', age: 'adult', auto: true },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'male', age: 'child', auto: true },
  { id: 'zh-CN-XiaohanNeural', name: '晓涵', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-CN-XiaoxuanNeural', name: '晓萱', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-CN-XiaoruiNeural', name: '晓睿', gender: 'female', age: 'adult', auto: true },
  { id: 'zh-CN-XiaoshuangNeural', name: '晓双', gender: 'female', age: 'child', auto: true },
  { id: 'zh-CN-YunfengNeural', name: '云枫', gender: 'male', age: 'adult', auto: true },
  { id: 'zh-CN-YunhaoNeural', name: '云皓', gender: 'male', age: 'adult', auto: true },
  { id: 'zh-CN-YunyeNeural', name: '云野', gender: 'male', age: 'adult', auto: true },
  { id: 'zh-CN-YunzeNeural', name: '云泽', gender: 'male', age: 'adult', auto: true },
  { id: 'en-US-AriaNeural', name: 'Aria（美式英语）', gender: 'female', age: 'adult', auto: true },
  { id: 'en-US-JennyNeural', name: 'Jenny（美式英语）', gender: 'female', age: 'adult', auto: true },
  { id: 'en-US-GuyNeural', name: 'Guy（美式英语）', gender: 'male', age: 'adult', auto: true },
  { id: 'en-US-DavisNeural', name: 'Davis（美式英语）', gender: 'male', age: 'adult', auto: true },
  { id: 'en-GB-SoniaNeural', name: 'Sonia（英式英语）', gender: 'female', age: 'adult', auto: true },
  { id: 'en-GB-RyanNeural', name: 'Ryan（英式英语）', gender: 'male', age: 'adult', auto: true },
  { id: 'en-US-AnaNeural', name: 'Ana（美式英语）', gender: 'female', age: 'child', auto: true },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北口音）', gender: 'female', age: 'adult', auto: false },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西口音）', gender: 'female', age: 'adult', auto: false },
]

const workerFile = fileURLToPath(new URL('./edge-worker.mjs', import.meta.url))
const DETAIL_LIMIT = 600
const STDERR_LIMIT = 8 * 1024

// Pauses between attempts. Three attempts in total ride out short network
// blips before the job pauses with the last error.
export const EDGE_RETRY_WAITS = [800, 2500]

export async function retryEdge(once, signal, waits = EDGE_RETRY_WAITS, wait = delay) {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try {
      return await once()
    } catch (error) {
      signal.throwIfAborted()
      if (attempt >= waits.length) throw error
      await wait(waits[attempt], undefined, { signal })
    }
  }
}

export async function synthesizeEdge(input, signal, options = {}) {
  if (!edgeVoices.some(voice => voice.id === input.voiceId)) throw new Error('EDGE_INVALID_VOICE')
  if (![...input.text].length || [...input.text].length > 500) throw new Error('EDGE_INVALID_TEXT')
  return retryEdge(() => synthesizeOnce(input, signal, options), signal, edgeRetryWaits(input.text))
}

// Text with nothing to pronounce comes back empty on every attempt, so a second
// try only costs another connection and another few seconds of the job.
export function edgeRetryWaits(text) {
  return hasSpeakable(text) ? EDGE_RETRY_WAITS : []
}

const strip = value => String(value ?? '').replace(/\u001b\[[0-9;]*m/gu, '').replace(/\r/gu, '').trim()

// Turn the child's stderr into one short line. The worker writes a JSON error
// line for expected msedge-tts failures; crashes fall back to the last lines.
// The reported code lets the parent pick a concrete error instead of always
// calling it an outage.
function edgeFailure(stderr) {
  const raw = strip(stderr)
  if (!raw) return { detail: '', code: null }
  const lines = raw.split('\n').map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index--) {
    if (!lines[index].startsWith('{')) continue
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value.message === 'string' && value.message) {
        const name = typeof value.error === 'string' && value.error ? value.error + ': ' : ''
        const code = value.code ? ' (' + value.code + ')' : ''
        return {
          detail: (name + value.message + code).slice(0, DETAIL_LIMIT),
          code: typeof value.code === 'string' && value.code ? value.code : null,
        }
      }
    } catch { /* not the structured line */ }
  }
  return { detail: lines.slice(-4).join(' | ').slice(0, DETAIL_LIMIT), code: null }
}

export function edgeFailureDetail(stderr) {
  return edgeFailure(stderr).detail
}

const TIMING_LIMIT = 512 * 1024

// Words as { o: start ms, d: duration ms, t: text } in speaking order; anything unreadable yields none.
export function parseTiming(raw) {
  const line = String(raw ?? '').trim().split('\n').at(-1)
  if (!line) return []
  try {
    const words = JSON.parse(line)
    return Array.isArray(words) ? words.filter(word => Number.isFinite(word?.o) && Number.isFinite(word?.d) && typeof word?.t === 'string' && word.t) : []
  } catch { return [] }
}

export function synthesizeOnce(input, signal, { timeout = 23_000, command = process.execPath, args = [workerFile] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      // fd 3 carries word timing from the worker (one JSON line).
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
    })
    const chunks = []
    let size = 0
    let stderr = ''
    let timing = ''
    let failure
    function terminate(error) {
      failure ??= error
      child.kill()
    }
    const abort = () => terminate(signal.reason)
    const timer = setTimeout(() => terminate(new Error('EDGE_TIMEOUT')), timeout)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    child.stdout.on('data', chunk => {
      size += chunk.length
      if (size <= 8 * 1024 * 1024) chunks.push(chunk)
      else terminate(new Error('EDGE_AUDIO_TOO_LARGE'))
    })
    child.stderr.on('data', chunk => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk.toString('utf8')
    })
    child.stdio[3]?.on('data', chunk => { if (timing.length < TIMING_LIMIT) timing += chunk.toString('utf8') })
    child.stdio[3]?.on('error', () => {})
    child.stdin.on('error', () => {})
    child.on('error', error => {
      failure ??= Object.assign(new Error('EDGE_WORKER_START_FAILED'), { detail: strip(error?.message ?? error) || null })
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (!failure && code === 0 && size > 0) {
        // The audio stays a Buffer for every caller; timing rides along as a property.
        const audio = Buffer.concat(chunks)
        audio.marks = parseTiming(timing)
        resolve(audio)
        return
      }
      const { detail, code: reported } = edgeFailure(stderr)
      // An empty turn is its own failure: it is a content result, not an outage.
      const error = failure ?? (reported === 'EDGE_EMPTY_AUDIO' ? new Error('EDGE_EMPTY_AUDIO') : new Error('EDGE_UNAVAILABLE'))
      if (detail && !error.detail) error.detail = detail
      reject(error)
    })
    child.stdin.end(JSON.stringify(input))
  })
}
