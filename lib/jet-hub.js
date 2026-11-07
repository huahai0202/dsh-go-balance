// 与 Jet Hub 的进程内 RPC 通道，以及「这个渠道有没有配账号」的探测。
//
// 走 `ctx.get('connection')` 的共享 fetch handler，相当于以 App 自己的身份打
// `/api/jet-hub`，不需要知道引擎的登录令牌。

import { LABELS } from './labels.js'

/** 调一次 Jet Hub RPC；失败抛可读原因。 */
export async function callJetHub(ctx, method, payload) {
  const connection = ctx.get('connection')
  if (connection === undefined) throw new Error('no-connection')
  const handler = connection.createSharedFetchHandler?.('/api')
  if (handler === undefined) throw new Error('no-api-handler')
  const body = {
    type: 'client-request',
    rpcId: `local-balance-${Date.now().toString(36)}`,
    method: 'jet-hub',
    payload: { method, payload },
  }
  const response = await handler.fetch(
    new Request('http://127.0.0.1/api/jet-hub', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    connection.browserPeer,
  )
  if (typeof response?.json !== 'function') throw new Error('no-response')
  const envelope = await response.json()
  const result = envelope?.result
  if (result?.ok !== true) throw new Error(result?.error?.message ?? 'rpc-failed')
  return result.value
}

/** 余额读数。`force` 让 Jet Hub 绕过它自己的缓存。 */
export const readBadge = (ctx, provider, force) =>
  callJetHub(ctx, 'usage.badge', { provider, ...(force ? { force: true } : {}) })

/**
 * 每日签到 / 领取积分。
 *
 * 返回 `{ results: [{ nickname, outcome }], summary }`；没有签到能力的渠道会抛
 * 「不支持每日签到」或 `unsupported provider`，调用方按「跳过」处理（见 checkin.js）。
 * 不传 `runTasks`：成长中心任务一轮要几分钟，签到不该顺带拖上它。
 */
export const claimDaily = (ctx, provider) =>
  callJetHub(ctx, 'credits.claimAll', { provider })


/**
 * 已配置（有账号且启用）的渠道，按 Jet Hub 的展示顺序。
 *
 * ⚠️ `account.list` 的 provider 是必填的（传 undefined 会被过滤成空），只能逐渠道
 * 问一遍。渠道一共三十来个，这就是三十多个 RPC —— 虽然都在进程内存里没有网络，
 * 但每秒刷一次也不该反复跑，所以把结果缓存在调用方（见 index.js 的
 * `readConfiguredProviders`）。
 *
 * 失败的不进列表（否则整体故障时会冒出三十多项），但**会计数**：`failed` 让界面
 * 能说一句「有 N 个渠道这次没查到」，而不是让它们无声消失。
 */
export async function probeConfiguredProviders(ctx) {
  const order = await callJetHub(ctx, 'provider.getOrder', {}).catch(() => ({ order: [] }))
  const known = Array.isArray(order?.order) ? order.order.filter((id) => typeof id === 'string' && id !== '') : []
  // providerOrder 只记用户拖过的顺序，可能是空的；用它排序、再用固定表补齐。
  const candidates = known.length > 0 ? known : Object.keys(LABELS)
  let failed = 0
  const hits = await Promise.all(candidates.map(async (provider) => {
    try {
      const value = await callJetHub(ctx, 'account.list', { provider })
      const accounts = Array.isArray(value?.accounts) ? value.accounts : []
      const enabled = accounts.filter((account) => account?.enabled !== false)
      return enabled.length > 0 ? { provider, count: enabled.length } : null
    } catch {
      failed += 1
      return null
    }
  }))
  return { providers: hits.filter((hit) => hit !== null), failed, probed: candidates.length }
}


/**
 * 某个渠道的模型目录（含已关闭的条目，供面板回显开关状态）。
 *
 * 返回 `{ models: [{ id, name, disabled, dead, isFree? }] }`；`model.setDisabled`
 * 写的是账号池里的黑名单，下一次 `model.list` 就会反映新状态。
 */
export const readModels = (ctx, provider) =>
  callJetHub(ctx, 'model.list', { provider })

/** 打开 / 关闭一个模型。`disabled: true` 是关闭。 */
export const setModelDisabled = (ctx, provider, modelId, disabled) =>
  callJetHub(ctx, 'model.setDisabled', { provider, modelId, disabled })

/**
 * 批量开关某渠道的全部模型。
 *
 * `closeProvider: false` 与 Jet Hub 的「模型列表」屏一致：只改黑名单，不落
 * 「关闭整个供应商」的意图 —— 否则「全部关闭」会连渠道一起关掉。
 */
export const setAllModelsDisabled = (ctx, provider, disabled) =>
  callJetHub(ctx, 'model.setAllDisabled', { provider, disabled, closeProvider: false })

/** 某渠道的账号列表（含停用账号与限流/封禁标记）。 */
export const listAccounts = (ctx, provider) =>
  callJetHub(ctx, 'account.list', { provider })

/** 改昵称 / 启停账号。`patch` 只放 nickname、enabled 等白名单字段。 */
export const updateAccount = (ctx, accountId, patch) =>
  callJetHub(ctx, 'account.update', { accountId, patch })

/** 刷新一个账号的凭据（失败会抛可读原因）。 */
export const refreshAccount = (ctx, accountId) =>
  callJetHub(ctx, 'account.refresh', { accountId })

/** 发一次真实请求测试账号；返回 { ok, message?, modelId }。 */
export const testAccount = (ctx, accountId) =>
  callJetHub(ctx, 'account.test', { accountId })

/** 清掉账号的限流标记与封禁标记（不验证，用户主动重置）。 */
export const resetAccount = (ctx, accountId) =>
  callJetHub(ctx, 'account.reset', { accountId })

/** 删除账号及其凭据。不可撤销。 */
export const deleteAccount = (ctx, accountId) =>
  callJetHub(ctx, 'account.delete', { accountId })

/**
 * 新建账号：Jet Hub 先登记一个占位条目，再返回浏览器登录地址。
 *
 * 返回 `{ accountId, loginUrl, reused? }`；`reused` 为真时没有新账号要登录。
 * 之后用 {@link pollLogin} 等浏览器里的授权完成。
 */
export const createAccount = (ctx, provider) =>
  callJetHub(ctx, 'account.create', { provider })

/** 登录轮询：`{ done, success?, error? }`，未完成时 `done` 为假。 */
export const pollLogin = (ctx, accountId, provider) =>
  callJetHub(ctx, 'login.poll', { accountId, provider })

/**
 * 重写某个渠道的账号顺序。
 *
 * `orderedIds` 必须是**该渠道全部账号**的 id（Jet Hub 会核对集合，多一个少一个
 * 都直接报错），所以调用方要在自己的缓存快照上算出完整的新顺序，不能只传动过的那条。
 * 顺序就是自动选号的优先级，不是纯 UI 排序。
 */
export const reorderAccounts = (ctx, provider, orderedIds) =>
  callJetHub(ctx, 'account.reorder', { provider, orderedIds })

/** 恢复被标记「已失效」的模型；`modelId` 省略 = 全部恢复。 */
export const clearDeadModel = (ctx, provider, modelId) =>
  callJetHub(ctx, 'model.clearDead', { provider, ...(modelId === undefined ? {} : { modelId }) })

/**
 * 渠道整体的开关状态：`{ statuses: { [provider]: { models:{total,disabled}, accounts:{total,enabled}, closed } } }`。
 *
 * 只用内存副本，不打上游；`closed` 是「全部模型都关了」（含「关闭整个渠道」的意图）。
 */
export const readProviderStatus = (ctx, providers) =>
  callJetHub(ctx, 'provider.status', { providers })

/**
 * 整体打开 / 关闭一个渠道。
 *
 * `enabled: false` = 关闭它的全部模型 + 停用它的全部账号；`true` = 清空模型黑名单
 * + 启用全部账号。关闭方向要先拿到模型目录，读不到就整体失败（不落盘）。
 */
export const setProviderEnabled = (ctx, provider, enabled) =>
  callJetHub(ctx, 'provider.setEnabled', { provider, enabled })

