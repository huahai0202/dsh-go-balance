// 渠道 id → 展示名，以及「这个渠道的余额是否按到期时间分档」。
//
// ⚠️ 这两张表是从 dsh-providers-hub 抄来的（`PROVIDER_REGISTRY` 的 label 与
// `usesExpiryWindow`）。上游改名或新增渠道时这里会漂移，所以：
// - 查不到名字就回退成 id 本身（不要显示空白或 undefined）；
// - 分档判据以响应里的 `windowDays` 为准（见 jet-hub.js），这张表只是白名单，
//   表里没有的渠道即使给了 windowDays 也不拆档，避免口径突然变化。

export const LABELS = Object.freeze({
  trae: 'TRAE',
  lobsterai: 'LobsterAI',
  buddy: 'CodeBuddy',
  workbuddy: 'WorkBuddy',
  qoder: 'Qoder',
  qodercn: 'Qoder 国内',
  cline: 'Cline',
  loomy: 'Loomy',
  raccoon: 'Raccoon',
  minimax: 'MiniMax',
  minimaxintl: 'MiniMax 国际',
  zcode: 'Z.ai',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  'openai-codex': 'ChatGPT',
  officeace: 'OfficeAce',
  accio: 'Accio',
  astudio: 'AStudio',
  autoclaw: 'AutoClaw',
  modelscope: 'ModelScope',
  qiniu: '七牛',
  codely: 'Codely',
  monkeycode: 'MonkeyCode',
  baizhi: '百智云',
  magicrew: 'Magicrew',
  magicrewintl: 'Magicrew 国际',
  autoclawintl: 'AutoClaw 国际',
  monkeycodeintl: 'MonkeyCode 国际',
  codearts: 'CodeArts',
  'jet-hub-auto': '自动选号',
  aggregate: '聚合',
})

/** 渠道展示名。未知渠道回退成 id，绝不返回空串。 */
export const labelOf = (provider) => LABELS[provider] ?? String(provider ?? '')

/**
 * 余额按到期时间分档的渠道（Jet Hub 的 `usesExpiryWindow`）。
 * 只有这些渠道的 `usage.badge` 响应才带 `windowDays`。
 */
export const EXPIRY_WINDOW_PROVIDERS = Object.freeze(new Set([
  'codearts',
  'buddy',
  'workbuddy',
  'lobsterai',
  'qodercn',
  'trae',
  'raccoon',
  'minimax',
  'minimaxintl',
  'officeace',
  'autoclaw',
  'autoclawintl',
  'magicrew',
  'magicrewintl',
]))

/** 独立池不参与主池合计，也不进任何一档（与 Jet Hub 客户端 isExclusivePool 同判据）。 */
export const EXCLUSIVE_POOL_MARK = '独立池'
