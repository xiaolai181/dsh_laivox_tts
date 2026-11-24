import { synthesizeEdge } from '../edge.mjs'
import { decodeEdgeWav, readWav } from '../wav.mjs'
import { hasSpeakable, isSeparator } from '../../domain/segment.mjs'
import { alignMarks } from '../../domain/marks.mjs'

// One Edge part. Older jobs can already contain a divider or a part with nothing
// to pronounce: keep its playback index and resume locally instead of asking Edge
// for audio it will never return.
export async function synthesizeEdgePart(part, prosody, signal) {
  if (isSeparator(part.text) || !hasSpeakable(part.text)) {
    signal.throwIfAborted()
    const rate = 24000
    return { rate, channels: 1, data: Buffer.alloc(rate / 10 * 2), skipped: true }
  }
  const audio = await synthesizeEdge({ ...part, prosody }, signal)
  const pcm = readWav(await decodeEdgeWav(audio))
  // Word timing aligned to this part's text, stored next to the audio for read-along.
  pcm.marks = alignMarks(part.text, audio.marks ?? [])
  return pcm
}
