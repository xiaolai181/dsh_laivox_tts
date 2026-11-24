import { MsEdgeTTS, OUTPUT_FORMAT } from './msedge.mjs'
import { writeSync } from 'node:fs'
import { text } from 'node:stream/consumers'
import { escapeSSML } from './text.mjs'

// The parent process turns this line into the failure detail shown in the
// workbench. Keep it to one JSON line so a stack trace above it stays readable.
function report(error) {
  try {
    process.stderr.write(JSON.stringify({
      error: error?.name ?? 'Error',
      message: String(error?.message ?? error ?? 'unknown error'),
      code: error?.code ?? null,
    }) + '\n')
  } catch { /* stderr is best effort */ }
}

const input = JSON.parse(await text(process.stdin))
const engine = new MsEdgeTTS()
try {
  await engine.setMetadata(input.voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { voiceLocale: input.voiceId.slice(0, 5), wordBoundaryEnabled: true })
  const { audioStream, metadataStream } = engine.toStream(escapeSSML(input.text), input.prosody)
  // Word timing for read-along highlighting. Offsets arrive in 100 ns ticks.
  const words = []
  metadataStream?.on('data', chunk => {
    try {
      for (const item of JSON.parse(chunk.toString('utf8')).Metadata ?? []) {
        if (item.Type !== 'WordBoundary' || !item.Data?.text?.Text) continue
        words.push({ o: Math.round(item.Data.Offset / 10_000), d: Math.round(item.Data.Duration / 10_000), t: item.Data.text.Text })
      }
    } catch { /* a malformed metadata frame only costs highlighting */ }
  })
  metadataStream?.on('error', () => {})
  let bytes = 0
  for await (const chunk of audioStream) {
    bytes += chunk.length
    if (!process.stdout.write(chunk)) await new Promise(resolve => process.stdout.once('drain', resolve))
  }
  // A closed connection can end the stream without an error; report the empty
  // result so the parent can show a useful reason instead of "unavailable".
  // The code lets the parent tell "nothing to pronounce" apart from an outage.
  if (!bytes) throw Object.assign(new Error('Edge returned no audio chunks'), { code: 'EDGE_EMPTY_AUDIO' })
  // fd 3 carries the timing as one JSON line. A parent without that pipe simply
  // gets no timing; synchronous so it is flushed before the process exits.
  try { writeSync(3, JSON.stringify(words) + '\n') } catch { /* no timing channel */ }
} catch (error) {
  report(error)
  process.exitCode = 1
} finally {
  try { engine.close() } catch { /* already closed */ }
}
