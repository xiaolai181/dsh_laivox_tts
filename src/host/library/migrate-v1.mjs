import { createStore } from '../store.mjs'
import { readWav } from '../wav.mjs'
import { scriptVariant } from '../text.mjs'

function inspect(bytes) {
  try { return bytes && readWav(bytes) } catch { return undefined }
}

export async function migrateLegacy(root, library) {
  const store = await createStore(root)
  const job = await store.current()
  if (!job || await library.migrated(job.id)) return
  const variant = job.variant ?? scriptVariant(job.text)
  const parts = []
  for (const [index, part] of (job.parts ?? []).entries()) {
    parts.push({ ...part, id: index, key: 'legacy-' + index, variant, pcm: inspect(await store.readPart(job.id, index)) })
  }
  if (job.stage === 'completed' && (!parts.length || parts.some(part => !part.pcm))) {
    const wav = inspect(await store.audio(job.id))
    if (wav) parts.splice(0, parts.length, { id: 0, text: job.text, key: 'legacy-chapter', variant, pcm: wav })
  }
  await library.publishLegacy(job, parts)
}
