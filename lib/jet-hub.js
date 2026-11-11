// 与 Jet Hub 的进程内 RPC 通道，以及「这个渠道有没有配账号」的探测。
//
// 走 `ctx.get('connection')` 的共享 fetch handler，相当于以 App 自己的身份打
// `/api/jet-hub`，不需要知道引擎的登录令牌。

import { LABELS } from './labels.js'

/**
 * RPC 序号。
 *
 * ⚠️ 不能只用 `Date.now()`：同一毫秒里并发发几个请求（「全部渠道」就是一次
 * 并发 N 个）会撞号。Jet Hub 只是把 rpcId 原样回显、不做去重，所以撞号本身
 * 不会串响应；但日志与排查时同一批请求长得一模一样，出事就分不清是哪一条。
 */
let rpcSeq = 0

/**
 * 单次 RPC 的默认上限。
 *
 * ⚠️ **必须要有**：这个通道是进程内的共享 fetch handler，上游不返回时它既不
 * 拒绝也不报错，`await` 会一直挂着 —— 面板上就是「点了没反应 / 白条不消失」，
 * 而且下一次操作还会排在后面。备份导出 / 导入最容易撞上，它们要读凭据、写账号池。
 * 超时不等于上游真的停了，只是不再干等：抛出可读原因，让界面回到可操作状态。
 */
export const RPC_TIMEOUT_MS = 15_000

/**
 * 带超时的 Promise；超时抛 `message`。
 *
 * ⚠️ **不要对这里的计时器 `unref()`**（实测踩过）：unref 的计时器不参与「维持
 * 事件循环」。当它和那个挂住的上游 Promise 是仅有的两个句柄时，进程会直接
 * 判定无事可做并退出 —— 超时回调根本没机会跑，看起来就像超时机制不存在。
 * 结算时会 `clearTimeout`，所以它不会多留。
 */
function withTimeout(promise, ms, message) {
  if (!(ms > 0)) return promise
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** 调一次 Jet Hub RPC；失败抛可读原因。`timeoutMs <= 0` 表示不设上限。 */
export async function callJetHub(ctx, method, payload, timeoutMs = RPC_TIMEOUT_MS) {
  const connection = ctx.get('connection')
  if (connection === undefined) throw new Error('no-connection')
  const handler = connection.createSharedFetchHandler?.('/api')
  if (handler === undefined) throw new Error('no-api-handler')
  const body = {
    type: 'client-request',
    rpcId: `local-balance-${Date.now().toString(36)}-${(rpcSeq += 1).toString(36)}`,
    method: 'jet-hub',
    payload: { method, payload },
  }
  const call = (async () => {
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
  })()
  // ⚠️ 超时之后上游仍可能完成，那个迟到的结果没人要；挂个空 catch，
  // 免得变成一个未处理的 rejection。
  call.catch(() => {})
  return withTimeout(call, timeoutMs, `${method}-timeout`)
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
 * ## 从 29 个 RPC 收敛到 2 个
 *
 * 老写法是「`provider.getOrder` + 逐渠道 `account.list`」，三十来个渠道就是三十多次
 * 进程内 RPC（没有网络，但每次都要过一次 fetch 构造与 JSON 编解码）。改用
 * `provider.status` 一次问全部渠道：它返回每个渠道的 `models.total` 和
 * `accounts.{total,enabled}`，正是这里需要的那两个数字。
 *
 * ⚠️ 判据必须与老写法保持一致：**「有账号」且**其中至少一个 `enabled !== false`
 * （老写法是 `accounts.filter(a => a.enabled !== false).length > 0`，这里用
 * `accounts.enabled > 0`）。Jet Hub 那边 `enabled` 就是按 `enabled !== false`
 * 数出来的（同名判据），所以两者等价。
 *
 * ⚠️ `provider.status` 只在**可能已关闭**的渠道上才会去核实目录（常见路径零网络），
 * 但它对已关闭渠道会串行读一次目录（每次上限 2 秒）。这条路径只在我们探测时走，
 * 且绝大多数渠道是「未关闭」，所以最坏情况只在用户确实关过渠道时出现。
 *
 * 失败的不进列表（否则整体故障时会冒出三十多项），但**会计数**：`failed` 让界面
 * 能说一句「有 N 个渠道这次没查到」，而不是让它们无声消失。
 */
export async function probeConfiguredProviders(ctx) {
  const order = await callJetHub(ctx, 'provider.getOrder', {}).catch(() => ({ order: [] }))
  const known = Array.isArray(order?.order) ? order.order.filter((id) => typeof id === 'string' && id !== '') : []
  // providerOrder 只记用户拖过的顺序，可能是空的；用它排序、再用固定表补齐。
  const candidates = known.length > 0 ? known : Object.keys(LABELS)
  const value = await callJetHub(ctx, 'provider.status', { providers: candidates })
  const statuses = value?.statuses ?? {}
  // 一个都没回来：这不是「用户把账号删光了」，而是这个调用整个没成 —— 抛出去，
  // 让调用方走「保留旧列表」那条路（见 runtime.refreshChannels）。
  if (Object.keys(statuses).length === 0 && candidates.length > 0) throw new Error('no-statuses')
  const hits = []
  let failed = 0
  for (const provider of candidates) {
    const status = statuses[provider]
    // 没有这一项 = 这个渠道 Jet Hub 不认（也许已下线）：算失败，不算「没有账号」。
    if (status === undefined) {
      failed += 1
      continue
    }
    const enabled = Number(status?.accounts?.enabled)
    if (Number.isFinite(enabled) && enabled > 0) hits.push({ provider, count: enabled })
  }
  return { providers: hits, failed, probed: candidates.length }
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

/**
 * 重测该渠道的**全部**账号（含已停用：停用只影响自动选号，不影响排查）。
 *
 * 返回 `{ accounts: [{ accountId, cleared, stillLimited, tested }], clearedCount }`。
 * Jet Hub 内部是**顺序**跑每个账号（并发探测会触发它自己想去验证的那个限流），
 * 所以这一步慢是正常的 —— 调用方必须用 `pending`（上限 60 秒）而不是同步等待。
 */
export const retestAllAccounts = (ctx, provider) =>
  callJetHub(ctx, 'account.retestAll', { provider })

/**
 * 清掉该渠道**全部**账号的限流 / 封禁标记（不验证，用户主动重置）。
 *
 * 返回 `{ clearedCount, accountCount }`：`clearedCount` 是清掉的标记条数，
 * `accountCount` 是被动到的账号数 —— 两者都为 0 就是「本来就没有标记」。
 */
export const resetAllAccounts = (ctx, provider) =>
  callJetHub(ctx, 'account.resetAll', { provider })

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


/**
 * 「锁定永久积分」开关（**provider 维度**）。
 *
 * 锁定后选号只允许消耗**会到期**的积分，永久积分不参与 —— 只剩永久积分的账号
 * 在锁定期间等同于不可用。`locked` 省略 = 只读。
 *
 * 返回 `{ provider, locked, windowDays? }`；`windowDays` 只有按到期分档的渠道才有，
 * 是「多少天算临期」的当前窗口（可被 `DSH_BUDDY_EXPIRING_WINDOW_DAYS` 覆盖）。
 */
export const readPermanentLock = (ctx, provider) =>
  callJetHub(ctx, 'credits.permanentLock', { provider })

export const setPermanentLock = (ctx, provider, locked) =>
  callJetHub(ctx, 'credits.permanentLock', { provider, locked })

/**
 * 账号池备份：统计、导出、导入。
 *
 * - `backup.status` → `{ accounts, withoutExpiry, accountList }`（只给展示字段）；
 * - `backup.export` → `{ payload, warnings }`，`payload` 是自包含快照（**含凭据原文**）；
 * - `backup.import` → 计数（`mode` 为 `replace` 整体替换，`merge` 只追加新账号）。
 *
 * ⚠️ 备份产物里有登录凭据，只能写到用户自己的存储里，不进任何日志或提示文案。
 */
export const readBackupStatus = (ctx) => callJetHub(ctx, 'backup.status', {})

/**
 * 导出的上限刻意压到 2.5 秒。
 *
 * ⚠️ 导出不挂 pending（见 panels/backup.js 的说明），处理器必须在桥接的
 * **3 秒**（`handlerTimeoutMs`）内返回。让这里先超时，用户看到的是
 * 「导出超时」这句人话，而不是一个 504；两者都会失败，但前者可排查。
 */
export const EXPORT_TIMEOUT_MS = 2_500

export const exportBackup = (ctx, accountIds) =>
  callJetHub(ctx, 'backup.export', accountIds === undefined ? {} : { accountIds }, EXPORT_TIMEOUT_MS)

/**
 * 导入要写账号池，比普通 RPC 慢，但它在 pending 里跑（上限 60 秒），
 * 给它留足余量；超时后白条会正常收掉并显示原因。
 */
export const IMPORT_TIMEOUT_MS = 45_000

export const importBackup = (ctx, payload, mode) =>
  callJetHub(ctx, 'backup.import', { payload, mode }, IMPORT_TIMEOUT_MS)
