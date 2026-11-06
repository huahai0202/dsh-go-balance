// ChatGPT / Codex 账号的额度查询与重置券兑换。
//
// 这条线和别的渠道完全不同：它不经过 Jet Hub（那群渠道的余额在 Jet Hub 的账号池里），
// 而是用 dsh-go 自己保存的 OAuth 登录直连 chatgpt.com 的 backend-api。
// 用到的两个端点是 Codex 官方客户端在用的，不是公开 API，随时可能变。

export const CODEX_CREDENTIAL_KEY = 'llm-pi-ai/openai-codex'
export const CODEX_PROVIDER = 'openai-codex'

const BASE = 'https://chatgpt.com/backend-api'
const USAGE_URL = `${BASE}/wham/usage`
const RESET_CREDITS_URL = `${BASE}/wham/rate-limit-reset-credits`
const CONSUME_URL = `${BASE}/wham/rate-limit-reset-credits/consume`
const AUTH_CLAIM = 'https://api.openai.com/auth'

/** 官方客户端带的两个头；缺了有时会被拒。 */
const CODEX_HEADERS = Object.freeze({
  accept: 'application/json',
  'openai-beta': 'codex-1',
  originator: 'Codex Desktop',
})

/** 取出访问令牌与账号 id；缺一样就抛可读原因（调用方转成用户能懂的话）。 */
export async function codexAuth(ctx) {
  const credentials = ctx.get('credentials')
  if (typeof credentials?.readRecord !== 'function') throw new Error('gpt-login-missing')
  const record = await credentials.readRecord(CODEX_CREDENTIAL_KEY)
  const grant = record?.kind === 'grant' ? record.payload : undefined
  const access = typeof grant?.access === 'string' ? grant.access : ''
  if (access === '') throw new Error('gpt-login-missing')

  let accountId = typeof grant?.accountId === 'string' ? grant.accountId : ''
  if (accountId === '') {
    try {
      const part = access.split('.')[1]
      const claims = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
      accountId = claims?.[AUTH_CLAIM]?.chatgpt_account_id ?? ''
    } catch {}
  }
  if (typeof accountId !== 'string' || accountId === '') throw new Error('gpt-account-missing')
  return { access, accountId }
}

/** 有没有已保存的登录。只读凭据记录，不发请求。 */
export async function hasCodexLogin(ctx) {
  try {
    const record = await ctx.get('credentials')?.readRecord?.(CODEX_CREDENTIAL_KEY)
    const grant = record?.kind === 'grant' ? record.payload : undefined
    return typeof grant?.access === 'string' && grant.access !== ''
  } catch {
    return false
  }
}

function authHeaders({ access, accountId }) {
  return { ...CODEX_HEADERS, authorization: `Bearer ${access}`, 'chatgpt-account-id': accountId }
}

/** 用量窗口。`rate_limit` 里 primary/secondary 不一定都有（Go 套餐只有一个）。 */
export async function readCodexUsage(ctx) {
  const auth = await codexAuth(ctx)
  const response = await fetch(USAGE_URL, { headers: authHeaders(auth), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`gpt-usage-${response.status}`)
  return response.json()
}

/**
 * 已存下的额度重置券，按最早过期排。
 *
 * 只认两件事：`status === 'available'` **且还没过期**。第二条是防御——上游偶尔会
 * 在券刚过期时仍报 available，那种券点了兑换必然失败，不如一开始就不列出来。
 */
export async function listCodexResetCredits(ctx, now = Date.now()) {
  const auth = await codexAuth(ctx)
  const response = await fetch(RESET_CREDITS_URL, { headers: authHeaders(auth), signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`gpt-reset-${response.status}`)
  const body = await response.json()
  const credits = Array.isArray(body?.credits) ? body.credits : []
  return credits
    .filter((credit) => credit?.status === 'available' && typeof credit?.id === 'string')
    .map((credit) => ({
      id: credit.id,
      title: typeof credit.title === 'string' ? credit.title : '',
      expiresAt: typeof credit.expires_at === 'string' ? Date.parse(credit.expires_at) : Number.NaN,
    }))
    // 到期时间已知且已过的，丢掉。未知的留着（宁可多列一张，也别藏掉真能用的）。
    .filter((credit) => !(Number.isFinite(credit.expiresAt) && credit.expiresAt <= now))
    .sort((a, b) => (Number.isFinite(a.expiresAt) ? a.expiresAt : Infinity) - (Number.isFinite(b.expiresAt) ? b.expiresAt : Infinity))
}

/**
 * 用掉一张重置券。
 *
 * `redeemRequestId` 是幂等键：同一张券的同一笔兑换重试时必须复用同一个 id，
 * 否则服务端会当成两次请求（第一次已经成功的情况会白报错）。
 */
export async function consumeCodexResetCredit(ctx, creditId, redeemRequestId) {
  const auth = await codexAuth(ctx)
  const response = await fetch(CONSUME_URL, {
    method: 'POST',
    headers: { ...authHeaders(auth), 'content-type': 'application/json' },
    body: JSON.stringify({ credit_id: creditId, redeem_request_id: redeemRequestId }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`gpt-consume-${response.status}`)
  return response.json()
}

function remainingPercent(window) {
  const used = Number(window?.used_percent)
  return Number.isFinite(used) ? Math.round(Math.max(0, Math.min(100, 100 - used))) : undefined
}

function windowLabel(window, index, zh) {
  const seconds = Number(window?.limit_window_seconds)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return zh ? (index === 0 ? '主窗口' : '次窗口') : (index === 0 ? 'Primary' : 'Secondary')
  }
  return seconds < 86_400
    ? (zh ? `${Math.round(seconds / 3600)} 小时` : `${Math.round(seconds / 3600)}h`)
    : (zh ? `${Math.round(seconds / 86_400)} 天` : `${Math.round(seconds / 86_400)}d`)
}

function resetLabel(window, zh) {
  const rawReset = Number(window?.reset_at)
  if (!Number.isFinite(rawReset) || rawReset <= 0) return ''
  const resetMs = rawReset < 1e12 ? rawReset * 1000 : rawReset
  const reset = new Date(resetMs).toLocaleString(zh ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  return zh ? `重置 ${reset}` : `Resets ${reset}`
}

/**
 * 把一次 usage 读数 + 券列表折成面板要的形状。
 *
 * 注意「额度」是订阅窗口的剩余百分比，不是余额。窗口数量随套餐变（Go 只有一个
 * 长窗口，Plus/Pro 是 5 小时 + 每周），所以文案里不写死个数。
 */
export function summarizeCodexUsage(value, zh, resetCredits = []) {
  const rate = value?.rate_limit
  const windows = [rate?.primary_window, rate?.secondary_window]
  const primaryWindow = windows[0]
  const primary = remainingPercent(primaryWindow)
  const rows = []
  const plan = String(value?.plan_type ?? '').trim()
  const planName = ({ go: 'Go', plus: 'Plus', pro: 'Pro', free: 'Free' })[plan.toLowerCase()] ?? plan
  if (planName !== '') rows.push({ label: zh ? '套餐' : 'Plan', value: planName })

  let windowCount = 0
  windows.forEach((window, index) => {
    const remaining = remainingPercent(window)
    if (remaining === undefined) return
    windowCount += 1
    rows.push({
      label: `${windowLabel(window, index, zh)}${zh ? '额度' : ' quota'}`,
      value: zh ? `剩余 ${remaining}%` : `${remaining}% remaining`,
      ...(remaining <= 10 ? { tone: 'warn' } : {}),
    })
  })

  const credits = value?.credits
  if (credits?.unlimited === true) {
    rows.push({ label: zh ? '额外额度' : 'Additional credits', value: zh ? '无限' : 'Unlimited' })
  } else if (credits?.has_credits === true && credits.balance !== undefined && credits.balance !== null) {
    rows.push({ label: zh ? '额外额度' : 'Additional credits', value: String(credits.balance) })
  }

  // 每张券一行、写明各自的到期日：券按月发放、到期作废，只看「最早那张」会漏掉
  // 后面几张什么时候过期。日期按本地时区显示（券是给我看的，不是给机器比较的）。
  resetCredits.forEach((credit, index) => {
    const expiry = Number.isFinite(credit.expiresAt)
      ? new Date(credit.expiresAt).toLocaleDateString(zh ? 'zh-CN' : 'en-US', {
          year: 'numeric', month: '2-digit', day: '2-digit',
        })
      : ''
    const which = resetCredits.length > 1 ? ` ${index + 1}` : ''
    rows.push({
      label: `${zh ? '重置券' : 'Reset credit'}${which}`,
      value: expiry === '' ? (zh ? '到期时间未知' : 'expiry unknown') : zh ? `${expiry} 到期` : `expires ${expiry}`,
      tone: 'good',
    })
  })

  const reached = rate?.limit_reached === true
  return {
    label: 'ChatGPT',
    resetCount: resetCredits.length,
    metricLabel: primary === undefined ? (zh ? '可用额度' : 'Available quota') : (zh ? '主窗口剩余' : 'Primary window remaining'),
    metricValue: primary === undefined ? '—' : `${primary}%`,
    caption: resetLabel(primaryWindow, zh) || (zh ? 'ChatGPT 账号使用窗口' : 'ChatGPT account usage windows'),
    rows,
    note: windowCount === 0
      ? (zh ? 'GPT 账号没有返回配额窗口；这不是余额为 0。' : 'No quota windows were returned; this does not mean the balance is 0.')
      : reached
        ? (zh ? '已达到当前使用上限；重置时间见上方窗口。' : 'The current usage limit is reached; see the reset time above.')
        : (zh ? '额度已更新。' : 'Quota updated.'),
    tone: reached || windowCount === 0 ? 'warn' : 'info',
  }
}

/** 把上游错误翻成用户能懂的一句话。 */
export function codexErrorNote(message, zh) {
  if (message === 'gpt-login-missing') {
    return zh ? '没有找到 GPT 登录凭据，请重新登录 ChatGPT。' : 'No GPT login was found; sign in to ChatGPT again.'
  }
  if (message === 'gpt-account-missing') {
    return zh ? '无法识别 GPT 账号，请重新登录后再试。' : 'Could not identify the GPT account; sign in again and retry.'
  }
  if (message === 'gpt-usage-401' || message === 'gpt-usage-403') {
    return zh ? 'GPT 登录已失效或无权查询，请重新登录。' : 'GPT login expired or usage access was denied; sign in again.'
  }
  return zh ? 'GPT 额度服务暂时不可用，请稍后刷新。' : 'GPT quota service is temporarily unavailable; refresh later.'
}
