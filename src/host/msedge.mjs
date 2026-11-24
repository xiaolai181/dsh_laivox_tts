// The Edge TTS client for the two Edge workers. The published package ships
// msedge-tts bundled into lib/vendor (scripts/build.mjs): msedge-tts declares an
// install script that DSH refuses to run, so it cannot be a runtime dependency.
// A development checkout that has not been built uses the package directly.
import { existsSync } from 'node:fs'

const bundled = new URL('../../lib/vendor/msedge-tts.cjs', import.meta.url)
const loaded = existsSync(bundled) ? await import(bundled.href) : await import('msedge-tts')
const api = loaded.default ?? loaded

export const { MsEdgeTTS, OUTPUT_FORMAT } = api
export const source = existsSync(bundled) ? 'bundled' : 'package'
