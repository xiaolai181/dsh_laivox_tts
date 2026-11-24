import { translate as t } from '../i18n/locale.mjs'

// A calm, transparent description of LaiVox: recommended for natural
// expressive reading, and clearly noted as a paid value-added engine.
export function laivoxCapability(mode) {
  return mode === 'multi'
    ? t('推荐使用 LaiVox（增值付费）：按每句语气拟人演绎，也可使用自己的音色。')
    : t('推荐使用 LaiVox（增值付费）：拟人自然朗读，也可使用自己的音色。')
}

// Shown beside Edge when this mode writes delivery notes. Empty otherwise.
export function edgeDeliveryNote(mode) {
  return mode === 'multi'
    ? t('Edge 暂不支持逐句语气演绎；语气笔记会保留，推荐改用 LaiVox（增值付费）以发挥效果。')
    : ''
}

// One synthesis line for the plan sheet. It does not end with a period, so the
// existing reuse suffix can supply the punctuation.
export function planSynthesisDetail(engine, mode) {
  if (engine === 'laivox' && mode === 'multi') return t('LaiVox（推荐 · 增值付费），按每句语气拟人演绎，使用当前 Key 的朗读额度')
  if (engine === 'laivox') return t('LaiVox（推荐 · 增值付费），可用自己的音色，使用当前 Key 的朗读额度')
  return t('Edge 在线语音（无需账号），正文会发送到微软 Edge 在线语音服务')
}

// The sentence under the engine switch in settings.
export function engineSettingNote(engine, mode) {
  if (engine === 'laivox' && mode === 'multi') return t('推荐使用 LaiVox 引擎（增值付费）：按每句语气拟人演绎，也可使用自己的音色。需配置 API Key，使用当前 Key 的朗读额度（会员额度或朗读时长包）。')
  if (engine === 'laivox') return t('推荐使用 LaiVox 引擎（增值付费）：拟人自然朗读，也可使用自己的音色。需配置 API Key，使用当前 Key 的朗读额度（会员额度或朗读时长包）。')
  if (mode === 'multi') return t('Edge 为内置在线语音，无需账号，正文会发送到微软 Edge 在线语音服务。Edge 暂不支持逐句语气演绎，推荐切换到 LaiVox（增值付费）获得完整表现力。')
  return t('Edge 为内置在线语音，无需账号，正文会发送到微软 Edge 在线语音服务。想要拟人情感朗读或使用自有音色，推荐切换到 LaiVox（增值付费）。')
}
