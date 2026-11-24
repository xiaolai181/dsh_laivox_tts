import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function createStore(root) {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const current = join(root, 'current.json')
  async function replace(path, data) {
    const temp = path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temp, data, { mode: 0o600, flag: 'wx' })
      await rename(temp, path)
    } finally {
      await rm(temp, { force: true })
    }
  }
  async function optional(path) {
    try { return await readFile(path) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  function dir(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('JOB_ID_INVALID')
    return join(root, id)
  }

  return {
    async current() {
      const data = await optional(current)
      return data ? JSON.parse(data) : null
    },
    async create(job) {
      await mkdir(dir(job.id), { mode: 0o700 })
      await this.save(job)
    },
    save: job => replace(current, JSON.stringify(job)),
    readPart: (id, index) => optional(join(dir(id), index + '.wav')),
    writePart: (id, index, bytes) => replace(join(dir(id), index + '.wav'), bytes),
    writeAudio: (id, bytes) => replace(join(dir(id), 'chapter.wav'), bytes),
    audio: id => optional(join(dir(id), 'chapter.wav')),
    async recordRequest(id, request) {
      await replace(join(dir(id), 'model-' + randomUUID() + '.json'), JSON.stringify(request))
    },
    async clear(id) {
      await rm(current, { force: true })
      await rm(dir(id), { recursive: true, force: true })
    },
    async discard(id) {
      await rm(dir(id), { recursive: true, force: true })
    },
  }
}
