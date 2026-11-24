import { synthesizeEdgePart, synthesizeLaivoxPart } from './engines/index.mjs'
import { edgeProsody, instructFor } from '../domain/voice-direction.mjs'

// Synthesizes one part with the given engine. The signature is the queue's
// injection point (createJobQueue's `synthesize`), so it stays as it was.
export async function synthesizePart(engine, part, gateway, save, signal) {
  // A part's own direction wins; legacy parts send the old phrase for their
  // emotion (empty for neutral or zero intensity), exactly as before.
  const instruct = instructFor(part)
  if (engine === 'edge') return synthesizeEdgePart(part, edgeProsody(part.emotion, part.intensity), signal)
  return synthesizeLaivoxPart(part, instruct, gateway, save, signal)
}
