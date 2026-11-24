// The v12 archive's raw LAME 64 kbps stream, decoded by mpg123, starts
// 1105 samples late at both supported rates. The container has no gapless tag.
export const ARCHIVE_DELAY_FRAMES = 1105

const FRAME_WINDOW = 576
const QUIET_RMS = 64

// Compare the original PCM to decoded float samples at the codec's delay.
// Check every audible window, including the tail, before discarding the WAV.
export function measureTrim(original, decoded) {
  const frames = original.length
  const start = ARCHIVE_DELAY_FRAMES
  if (!frames || decoded.length < start + frames) return null
  for (let offset = 0; offset < frames; offset += FRAME_WINDOW) {
    const end = Math.min(offset + FRAME_WINDOW, frames)
    let sourceEnergy = 0
    let outputEnergy = 0
    let product = 0
    for (let index = offset; index < end; index++) {
      const source = original[index]
      const output = decoded[start + index] * 32768
      sourceEnergy += source * source
      outputEnergy += output * output
      product += source * output
    }
    if (sourceEnergy < (end - offset) * QUIET_RMS ** 2) continue
    if (outputEnergy < sourceEnergy / 8 || outputEnergy > sourceEnergy * 4 ||
        !(product >= 0.65 * Math.sqrt(sourceEnergy * outputEnergy))) return null
  }
  return start
}
