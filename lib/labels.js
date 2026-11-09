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
  'qoder',
  'qodercn',
  'trae',
  'minimax',
  'minimaxintl',
  'officeace',
  'astudio',
  'autoclaw',
  'autoclawintl',
  'magicrew',
  'magicrewintl',
]))

/**
 * 明确没有签到端点的渠道（Jet Hub registry 里 `credits.dailyCheckin` 为 false
 * 或**刻意不登记**的那些）。
 *
 * ⚠️ Raccoon 在这里不是遗漏：它的每日 300 由服务端按日自动发放
 * （账单 `biz_type: 'daily_grant'`），没有可调用端点；桌面端 3000 是
 * 一次性 `onboardingTasks`。给它签到按钮必然空转，用户会以为签到坏了。
 */
export const NO_CHECKIN_PROVIDERS = Object.freeze(new Set([
  'raccoon',
  'workbuddy',
  'cline',
  'opencode',
  'gemini',
  'officeace',
  'accio',
  'modelscope',
  'qiniu',
]))

/** 独立池不参与主池合计，也不进任何一档（与 Jet Hub 客户端 isExclusivePool 同判据）。 */
export const EXCLUSIVE_POOL_MARK = '独立池'

/**
 * 支持「锁定永久积分」的渠道（Jet Hub registry 的 `permanentLock: true`）。
 *
 * 锁定后选号只允许烧**会到期**的积分，永久积分不参与；只剩永久积分的账号
 * 在锁定期间等同于不可用。表里没有的渠道调这个接口会被 bad-request 拒掉，
 * 所以页面只给这些渠道出行。
 */
export const PERMANENT_LOCK_PROVIDERS = Object.freeze(new Set([
  'buddy',
  'workbuddy',
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'loomy',
  'minimax',
  'minimaxintl',
  'officeace',
  'astudio',
  'autoclaw',
  'autoclawintl',
  'magicrew',
  'magicrewintl',
]))
