import { join } from 'node:path'
import { PLUGIN_ID } from '../domain/plugin.mjs'
import { openLibrary } from './library/repository.mjs'
import { migrateLegacy } from './library/migrate-v1.mjs'
import { createStreamGate } from './model-stream.mjs'
import { createImportService } from './import/index.mjs'
import { createLaivoxSession } from './engines/index.mjs'
import { createEditorialService } from './editorial.mjs'
import { createJobQueue } from './jobs.mjs'
import { registerChat } from './chat.mjs'
import { errorCode, registerAPI } from './api.mjs'
import { createVoicePreviewService } from './voice-preview.mjs'
import { createMp3Encoder } from './mp3.mjs'
import { disposeArchiveEncoder } from './stored-audio.mjs'
import { createSnippetService, SWEEP_INTERVAL } from './snippets.mjs'
import { createSpeechEngine } from './speech-engine.mjs'
import { createSpeechService } from './speech.mjs'
import { createDeliverableImports } from './deliverables.mjs'
import { seedBuiltinSamples } from './samples.mjs'

export const name = PLUGIN_ID
// Only what the plugin cannot run without. Commands, tools and attachments are
// optional and picked up in chat.mjs when present (a missing required service
// would keep the whole plugin from loading).
export const inject = ['connection', 'llm', 'credentials', 'profileContext']

function unavailableLibrary(error) {
  const fail = () => { throw error }
  return new Proxy({}, { get: () => fail })
}

export async function start(ctx, { samplesDir } = {}) {
  const root = join(ctx.profileContext.dir, PLUGIN_ID)
  let library
  try { library = await openLibrary(root) }
  catch (error) {
    if (error?.message !== 'LIBRARY_VERSION_UNSUPPORTED') throw error
    const dead = unavailableLibrary(error)
    registerAPI(ctx, { library: dead, jobs: dead, imports: dead, chat: { proposals: async () => [] },
      gatewayFor: async () => { throw error }, keyStatus: async () => { throw error }, setKey: async () => { throw error },
      clearKey: async () => { throw error }, migrationWarning: false, voicePreview: dead, mp3: dead, snippets: dead,
      speech: dead, deliverables: dead })
    ctx.logger?.warn('LaiVox library cannot open: ' + error.message)
    return
  }
  try { await library.configureAudioLimit((await library.settings()).values.audioLimit) }
  catch (error) { ctx.logger?.warn('LaiVox audio limit setting ignored: ' + (error?.message ?? error)) }
  const gate = createStreamGate()
  const editorial = createEditorialService(ctx.llm, library, { gate })
  const imports = createImportService(library, root, ctx.llm, { gate })

  // LaiVox key and account: only used when the user picks LaiVox or saves a key.
  const { gatewayFor, keyStatus, setKey, clearKey } = createLaivoxSession({ credentials: ctx.credentials })

  const jobs = createJobQueue({ library, editorial, llm: ctx.llm, gatewayFor, errorCode, logger: ctx.logger })
  const voicePreview = createVoicePreviewService({ gatewayFor })
  // One encoder per activation: disposing it on shutdown must not break MP3 export
  // when the same process activates the plugin again.
  const mp3 = createMp3Encoder()
  const snippets = createSnippetService({ library, imports, logger: ctx.logger })
  // Instant speech: a resident Edge worker apart from the job queue.
  const speechEngine = createSpeechEngine()
  const speech = createSpeechService({ synthesize: speechEngine.synthesize, warm: speechEngine.warm,
    voices: async () => (await library.settings()).values.speechVoices })
  let sweepTimer
  ctx.effect(() => async () => {
    clearInterval(sweepTimer)
    speech.dispose()
    speechEngine.dispose()
    await Promise.all([voicePreview.dispose(), jobs.dispose(), mp3.dispose(), imports.dispose(), snippets.dispose(), disposeArchiveEncoder()])
    await library.close()
  })
  let migrationWarning = false
  try { await migrateLegacy(root, library) }
  catch { migrationWarning = true; ctx.logger?.warn('LaiVox legacy migration did not complete') }
  await library.requeueInterrupted()
  try { await seedBuiltinSamples(library, { samplesDir }) }
  catch (error) { ctx.logger?.warn('LaiVox sample seed skipped: ' + (error?.message ?? error)) }
  // Delivered files: optional host services, looked up when used.
  // ctx.get for services not in `inject` (reading ctx[name] would warn); plain objects in tests.
  const optional = name => () => (typeof ctx.get === 'function' ? ctx.get(name) : ctx[name])
  const deliverables = createDeliverableImports({ imports, services: { sessionQuery: optional('sessionQuery'), fs: optional('fs'),
    workspaceRoot: () => optional('sandboxPolicy')()?.workspaceRoot } })
  const chat = registerChat(ctx, { library, jobs, imports, errorCode, speech })
  registerAPI(ctx, { library, jobs, imports, chat, gatewayFor, keyStatus, setKey, clearKey, migrationWarning, voicePreview, mp3, snippets, speech, deliverables })
  // Expired conversation readings and old import drafts: once now, then hourly.
  void snippets.sweep()
  sweepTimer = setInterval(() => { void snippets.sweep() }, SWEEP_INTERVAL)
  sweepTimer.unref?.()
  jobs.kick()
}

export async function apply(ctx) {
  return start(ctx)
}
