// 三个面板共享的状态：当前渠道、渠道列表缓存、模型/账号列表缓存与管理面板当前页。
//
// 这些状态原先都挤在 index.js 的 inject 闭包里。拆出来以后，面板文件只拿自己
// 需要的部分，渠道切换时由 channels 面板调用 resetManageState() 统一复位。

import { CODEX_PROVIDER, hasCodexLogin } from './codex.js'
import { listAccounts, probeConfiguredProviders, readModels } from './jet-hub.js'
import { readState, writeState } from './prefs.js'
import { ALL } from './constants.js'
import { kickAll } from './util.js'

/** 渠道列表缓存：账号的增删改远比余额少；面板打开时会强制探一次。 */
const CHANNELS_CACHE_MS = 300_000
/** 模型目录缓存：开关后主动失效，平时半分钟够。 */
const MODELS_CACHE_MS = 30_000
/** 账号列表缓存：启停/改名会主动失效，平时 15 秒够。 */
const ACCOUNTS_CACHE_MS = 15_000

/** 当前对话用的渠道：优先会话请求头，其次待选模型，最后 agent 默认模型。 */
function currentProvider(ctx, scope) {
  try {
    const session = scope.sessionId === undefined ? undefined : ctx.get('sessions')?.get(scope.sessionId)
    if (session !== undefined) {
      const header = session.requestHeader?.()
      const provider = header?.config?.provider
      if (typeof provider === 'string' && provider !== '') return provider
      const picked = ctx.get('sessionProjections')?.stateOf(session, 'modelSelection')?.pending?.provider
      if (typeof picked === 'string' && picked !== '') return picked
    }
  } catch {}
  try {
    const current = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (typeof current?.provider === 'string' && current.provider !== '') return current.provider
  } catch {}
  return undefined
}

export function createRuntime(ctx) {
  const r = {
    /** 渠道选择：「current」跟随对话，`ALL` 全部渠道，其余是具体渠道 id。 */
    picked: 'current',
    /** 渠道列表缓存 + 失败计数。 */
    channelsCache: { at: 0, value: [], failed: 0 },

    /** 模型部分：目录缓存、结果提示与当前展开的分组。 */
    modelsCache: new Map(),
    modelsNote: '',
    /** 「全部关闭」的二次确认是否亮着。 */
    modelsBulkArm: false,
    /**
     * 模型分组当前展开的是哪一组（v1 没有折叠组件，靠列表行手动切换）。
     *
     * `''` = 全部收起。必须是独立取值，不能「再点一次就回落成 on」——
     * 那样「已开启」这一组永远收不起来（点它等于回到它自己展开的状态）。
     */
    modelsOpenGroup: 'on',

    /** 账号部分：列表缓存、当前打开的账号、改名 / 删除确认、提示。 */
    accountsCache: new Map(),
    accountDetail: undefined,
    accountRename: false,
    accountDeleteArm: false,
    accountsNote: '',
    accountsNoteTone: 'info',

    /**
     * 管理面板当前打开的页面：
     * - `'home'`：四个选项的列表（模型开关 / 账号管理 / 自动签到 / 主机设置）
     * - `'models'` / `'accounts'` / `'auto'` / `'host'`：进了某一项之后的内容页
     *
     * 不用并排标签：并排会让底部弹层随内容高度伸缩（内容高的页和矮的页
     * 之间切换会跳）。改成「首页列表 → 进一个 → 返回」，一次只画一页。
     */
    manageTab: 'home',
    /** 面板最后一次显示的渠道：动作的 scope 里没有 sessionId 时用它兜底。 */
    manageProvider: undefined,
    manageModelCount: null,
    manageAccountCount: null,
    manageCountProvider: undefined,

    /** 谁的状态变了，就把对应的 kick 跑一遍。 */
    balanceKicks: new Set(),
    channelKicks: new Set(),
    manageKicks: new Set(),
    modelKicks: new Set(),
    accountKicks: new Set(),
  }

  // 状态读到之前视图会用默认值（跟随当前对话），会闪一下。记下这个 promise，
  // 让 view 先等它，避免「重启后第一次打开面板显示错渠道、几百毫秒后才跳」。
  r.stateReady = readState().then((state) => {
    r.picked = state.picked
  })
  r.persist = () => void writeState({ picked: r.picked })

  // 与余额面板同一个来源：具体渠道就用 picked，跟随对话就用当前会话的渠道。
  // 不再在打开时快照一个渠道，否则从插件详情直接打开会停在旧渠道。
  r.activeProvider = (scope) => {
    if (r.picked !== ALL && r.picked !== 'current' && r.picked !== CODEX_PROVIDER) return r.picked
    const current = currentProvider(ctx, scope)
    return current !== undefined && current !== ALL && current !== CODEX_PROVIDER ? current : undefined
  }

  /** 面板实际要显示的渠道。选中的渠道可能已被停用/删掉，那就回落。 */
  r.effectiveProvider = (scope, channels) => {
    if (r.picked === ALL) return ALL
    if (r.picked !== 'current') {
      if (!Array.isArray(channels) || channels.some((hit) => hit.provider === r.picked)) return r.picked
      r.picked = 'current'
      r.persist()
    }
    return currentProvider(ctx, scope)
  }

  /**
   * 重新探一遍渠道列表。
   *
   * 冷启动时一次探测要 29 个进程内 RPC（`provider.getOrder` + 每渠道一次
   * `account.list`），所以并发调用只跑一份：后台补新的和用户点「刷新」撞在一起时，
   * 不会真的探两遍。`force` 允许插队（用户主动刷新时不该等上一轮旧结果）。
   */
  let refreshing
  r.refreshChannels = (force) => {
    if (refreshing !== undefined && !force) return refreshing
    const previous = r.channelsCache
    refreshing = (async () => {
      let probe
      try {
        probe = await probeConfiguredProviders(ctx)
      } catch {
        // 整体失败（比如 connection 还没起来）：保留上一次的列表，只把失败数记上。
        r.channelsCache = { at: Date.now(), value: previous.value, failed: previous.failed + 1 }
        return r.channelsCache
      }
      const providers = [...probe.providers]
      // 一个都没探到、而且还带着失败计数：多半是 Jet Hub 整个没起来，不是用户把
      // 账号删光了。这时保留旧列表，别让界面从「6 个渠道」突然变成「还没有配置渠道」。
      if (providers.length === 0 && probe.failed > 0 && previous.value.length > 0) {
        r.channelsCache = { at: Date.now(), value: previous.value, failed: probe.failed }
        return r.channelsCache
      }
      // ChatGPT 不在 Jet Hub 的账号池里（凭据在 dsh-go 的凭据库），单独问一次。
      if (await hasCodexLogin(ctx)) providers.push({ provider: CODEX_PROVIDER, count: 1 })
      r.channelsCache = { at: Date.now(), value: providers, failed: probe.failed }
      return r.channelsCache
    })().finally(() => {
      refreshing = undefined
    })
    return refreshing
  }

  /**
   * 读渠道列表（stale-while-revalidate）。
   *
   * - 缓存新鲜：直接给；
   * - 缓存过期但手里有旧列表：**先把旧的给出去**，后台补新的，补完踢一次让界面自己换。
   *   打开面板因此不用等 29 个 RPC；
   * - 从来没有过（冷启动）：只能等着探一次；
   * - `force`（用户点刷新、签到前确认渠道）：等真的探完。
   */
  r.readConfiguredProviders = async (force) => {
    const cache = r.channelsCache
    if (!force && cache.at > 0 && Date.now() - cache.at < CHANNELS_CACHE_MS) return cache
    if (force || cache.value.length === 0) return r.refreshChannels(force)
    // 后台补新的。放在下一个宏任务里启动：探测的第一件事是构造 Request，Node 第一次
    // 干这事要上百毫秒（fetch 懒初始化），当场启动会把这笔开销算在「打开面板」上。
    const timer = setTimeout(() => {
      void r.refreshChannels(false).then(
        () => kickAll(r.channelKicks),
        () => {},
      )
    }, 0)
    timer?.unref?.()
    return cache
  }

  r.readModelsOf = async (provider, force) => {
    const hit = r.modelsCache.get(provider)
    if (!force && hit !== undefined && Date.now() - hit.at < MODELS_CACHE_MS) return hit.value
    const value = await readModels(ctx, provider)
    r.modelsCache.set(provider, { at: Date.now(), value })
    return value
  }

  r.readAccountsOf = async (provider, force) => {
    const hit = r.accountsCache.get(provider)
    if (!force && hit !== undefined && Date.now() - hit.at < ACCOUNTS_CACHE_MS) return hit.value
    const value = await listAccounts(ctx, provider)
    r.accountsCache.set(provider, { at: Date.now(), value })
    return value
  }

  /** 打开模型与账号面板、或换渠道时，把列表相关的临时状态清干净。 */
  r.resetManageState = (tab = 'home') => {
    r.manageTab = tab
    r.modelsNote = ''
    r.modelsBulkArm = false
    r.modelsOpenGroup = 'on'
    r.accountDetail = undefined
    r.accountRename = false
    r.accountDeleteArm = false
    r.accountsNote = ''
    r.accountsNoteTone = 'info'
  }

  return r
}
