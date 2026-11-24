import { MAX_RESUBMITS } from '../../../domain/production.mjs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { readWav } from '../../wav.mjs'
import { GatewayError } from './client.mjs'
import { classifyLaivox } from './errors.mjs'

// Submitting again under a new request id is only allowed when the gateway said
// the old task will never produce audio, and at most this many times per part
// (the count is saved with the part, so restarts and "continue" do not reset it).
export { MAX_RESUBMITS }
// Busy or unreachable while submitting: same request id, waiting as told.
const SUBMIT_RETRIES = 6
const SUBMITTING_POLLS = 5

const clamp = (value, low, high) => Math.min(high, Math.max(low, value))

async function submitOnce(part, instruct, gateway, signal, wait) {
  for (let attempt = 0; ; attempt++) {
    await gateway.pace?.(signal)
    try {
      return await gateway.submit({ ...part, instruct }, part.requestId, part.variant, signal)
    } catch (error) {
      signal.throwIfAborted()
      // A busy answer narrows the lanes as the gateway says (or by one when it says nothing).
      if (error instanceof GatewayError && error.status === 429 && classifyLaivox(error) === 'transient') gateway.busy?.(error.details?.concurrency)
      if (classifyLaivox(error) !== 'transient' || attempt >= SUBMIT_RETRIES) throw error
      const seconds = error instanceof GatewayError && error.wait ? clamp(error.wait, 3, 60) : 5
      await wait(seconds * 1000, signal)
    }
  }
}

const CAPACITY_CODES = new Set(['NO_WORKER_SLOT', 'USAGE_LEDGER_UNAVAILABLE'])
const CAPACITY_LIMIT = 20

// A pure capacity failure gets a new request id without spending a resubmit,
// up to CAPACITY_LIMIT times. After that it falls through to the normal resubmit.
async function capacityRetry(part, save, error, wait, signal) {
  if (!CAPACITY_CODES.has(error?.taskCode)) return false
  const count = Number.isInteger(part.capacityRetries) ? part.capacityRetries : 0
  if (count >= CAPACITY_LIMIT) return false
  part.capacityRetries = count + 1
  part.taskId = undefined
  part.requestId = randomUUID()
  await save()
  await wait(Math.min(60, 5 * 2 ** Math.min(count, 4)) * 1000, signal)
  return true
}

async function newRequest(part, save, error) {
  const count = Number.isInteger(part.resubmits) ? part.resubmits : 0
  if (count >= MAX_RESUBMITS) throw error
  part.resubmits = count + 1
  part.taskId = undefined
  part.requestId = randomUUID()
  await save()
}

// One LaiVox part: the request id is saved before submitting and the task id as
// soon as it is known, so a restart resumes the same task instead of paying twice.
// wait is injectable for tests; the default sleeps.
export async function synthesizeLaivoxPart(part, instruct, gateway, save, signal, { wait = (ms, s) => delay(ms, undefined, { signal: s }) } = {}) {
  for (;;) {
    if (!part.requestId) {
      part.requestId = randomUUID()
      await save()
    }
    if (!part.taskId) {
      let submitted
      try {
        for (let attempt = 0; attempt < SUBMITTING_POLLS; attempt++) {
          submitted = await submitOnce(part, instruct, gateway, signal, wait)
          if (submitted.status !== 'submitting') break
          await wait(3000, signal)
        }
      } catch (error) {
        // The same request id points at a claim the gateway confirms is dead.
        if (classifyLaivox(error) === 'gone') {
          if (await capacityRetry(part, save, error, wait, signal)) continue
          await newRequest(part, save, error); continue
        }
        throw error
      }
      if (submitted?.status === 'submitting') throw new Error('LAIVOX_SUBMIT_PENDING')
      if (typeof submitted?.task_id !== 'string' || !submitted.task_id) throw new Error('LAIVOX_INVALID_TASK')
      part.taskId = submitted.task_id
      // 'task': the queue may merge this write with others. Losing it is safe: the
      // same request id gets the same task id back from the gateway.
      await save('task')
    }
    try {
      const bytes = await gateway.audio(part.taskId, signal)
      const wav = readWav(bytes)
      return { ...wav, originalWav: bytes }
    }
    catch (error) {
      if (classifyLaivox(error) === 'gone') {
        // The bytes were already downloaded. A later local failure must not pay
        // for a new request while that task id is still the one we stored.
        if (part.downloaded) throw new Error('LAIVOX_LOCAL_LOST')
        if (await capacityRetry(part, save, error, wait, signal)) continue
        await newRequest(part, save, error); continue
      }
      throw error
    }
  }
}
