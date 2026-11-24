import { createHash } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SAMPLE_FORMAT_VERSION, SAMPLE_PACK_ID } from '../domain/samples.mjs'

export const DEFAULT_SAMPLES_DIR = fileURLToPath(new URL('../../assets/samples/', import.meta.url))

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u

function safeRelPath(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9/_.-]*$/u.test(value) && !value.includes('..') && !value.startsWith('/')
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export async function loadSamplePack(samplesDir = DEFAULT_SAMPLES_DIR) {
  const manifestPath = join(samplesDir, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest?.formatVersion !== SAMPLE_FORMAT_VERSION) throw new Error('SAMPLE_VERSION_UNSUPPORTED')
  if (typeof manifest.packId !== 'string' || !PACK_ID_PATTERN.test(manifest.packId)) throw new Error('SAMPLE_MANIFEST_INVALID')
  if (!Array.isArray(manifest.books) || !manifest.books.length) throw new Error('SAMPLE_MANIFEST_INVALID')

  const books = []
  for (const bookRef of manifest.books) {
    if (!safeRelPath(bookRef?.file) || !SHA256_PATTERN.test(bookRef?.sha256 ?? '')) throw new Error('SAMPLE_MANIFEST_INVALID')
    const rawBook = await readFile(join(samplesDir, bookRef.file))
    if (sha256Hex(rawBook) !== bookRef.sha256) throw new Error('SAMPLE_CHECKSUM_MISMATCH')
    const data = JSON.parse(rawBook.toString('utf8'))
    const { book, roles, chapter, job, audio } = data ?? {}
    if (typeof book?.id !== 'string' || !book.id || typeof book?.title !== 'string' || !book.title || !Number.isInteger(book?.voiceRule)) {
      throw new Error('SAMPLE_BOOK_INVALID')
    }
    if (!Array.isArray(roles)) throw new Error('SAMPLE_BOOK_INVALID')
    if (typeof chapter?.id !== 'string' || !chapter.id || typeof chapter?.title !== 'string' || typeof chapter?.text !== 'string' || !chapter.text.length) {
      throw new Error('SAMPLE_BOOK_INVALID')
    }
    if (typeof job?.id !== 'string' || !job.id || job.spec?.purpose !== 'generate' || !['edge', 'laivox'].includes(job.spec?.engine) ||
        !['reading', 'multi'].includes(job.spec?.mode) || job.progress?.partsOpen || !Array.isArray(job.progress?.parts) || !job.progress.parts.length) {
      throw new Error('SAMPLE_BOOK_INVALID')
    }
    if (!Array.isArray(audio) || !audio.length) throw new Error('SAMPLE_AUDIO_INCOMPLETE')

    const audioRows = []
    const audioKeys = new Set()
    for (const item of audio) {
      if (typeof item?.key !== 'string' || !item.key || !safeRelPath(item.file) || !SHA256_PATTERN.test(item.sha256 ?? '')) {
        throw new Error('SAMPLE_AUDIO_INVALID')
      }
      if (!['mp3', 'wav', 'pcm'].includes(item.codec) || !Number.isInteger(item.rate) || item.rate <= 0 || ![1, 2].includes(item.channels)) {
        throw new Error('SAMPLE_AUDIO_INVALID')
      }
      if (item.codec === 'mp3' && (!Number.isInteger(item.frames) || item.frames <= 0 || !Number.isInteger(item.trimStart) || item.trimStart < 0)) {
        throw new Error('SAMPLE_AUDIO_INVALID')
      }
      const payload = await readFile(join(samplesDir, item.file))
      if (Number.isInteger(item.bytes) && payload.byteLength !== item.bytes) throw new Error('SAMPLE_CHECKSUM_MISMATCH')
      if (sha256Hex(payload) !== item.sha256) throw new Error('SAMPLE_CHECKSUM_MISMATCH')
      audioKeys.add(item.key)
      audioRows.push({
        key: item.key,
        codec: item.codec,
        rate: item.rate,
        channels: item.channels,
        frames: item.frames ?? null,
        trimStart: item.trimStart ?? null,
        marks: Array.isArray(item.marks) && item.marks.length ? item.marks : null,
        payload,
      })
    }
    if (!job.progress.parts.every(part => typeof part?.key === 'string' && audioKeys.has(part.key))) {
      throw new Error('SAMPLE_AUDIO_INCOMPLETE')
    }
    books.push({ book, roles, chapter, job, audio: audioRows })
  }
  return { packId: manifest.packId, books }
}

export async function seedBuiltinSamples(library, { samplesDir = DEFAULT_SAMPLES_DIR } = {}) {
  if (samplesDir === null) return { status: 'disabled', books: 0 }
  const state = await library.sampleSeedState()
  if (state.seeded) return { status: 'already_seeded', books: 0 }
  if (!state.empty) return library.seedSamples({ packId: SAMPLE_PACK_ID, markOnly: true })
  try {
    await access(join(samplesDir, 'manifest.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'missing', books: 0 }
    throw error
  }
  const pack = await loadSamplePack(samplesDir)
  return library.seedSamples(pack)
}
