// The engines the plugin can synthesize with. Edge is the default and needs no
// account; LaiVox is an optional paid service whose protocol lives entirely in
// ./laivox/. Other modules import from here only.
import { laivoxErrorCode } from './laivox/index.mjs'

export const engineIds = Object.freeze(['edge', 'laivox'])

export { synthesizeEdgePart } from './edge.mjs'
export { createLaivoxSession, synthesizeLaivoxPart, laivoxBundledPreview, laivoxPauseInfo, LAIVOX_TRANSIENT_CODES, GatewayError, KEY_PAGE, PACK_PAGE, START_PAGE, classifyLaivox,
  laivoxAuthorize, laivoxHandoff, laivoxPackCatalog, laivoxStatusView, laivoxUsage, assertLaivoxVoices, laivoxCatalog, laivoxPreview } from './laivox/index.mjs'

// An engine-specific code for a failure, or undefined to use the generic rule.
export function engineErrorCode(error) {
  return laivoxErrorCode(error)
}
