// 模型开关 + 账号管理：一个面板，顶部两个选项当标签页。
//
// 两边共用「当前渠道」这一个前提，拆成两个面板只会多一个按钮。只读当前标签页的
// 数据；缓存各自独立（模型 30 秒、账号 15 秒），切标签不再发请求。
//
// 模型目录来自 Jet Hub 的 `model.list`，账号列表来自 `account.list`；
// 添加账号走 Jet Hub 的两步式登录：`account.create` 给登录页，`login.poll` 收尾。

import {
  createAccount,
  deleteAccount,
  pollLogin,
  refreshAccount,
  resetAccount,
  setAllModelsDisabled,
  setModelDisabled,
  testAccount,
  updateAccount,
} from '../jet-hub.js'
import { labelOf } from '../labels.js'
import { briefError, kickAll, zhOf } from '../util.js'

/** 浏览器登录最多等 5 分钟（与 Jet Hub 自己的轮询上限一致）。 */
const LOGIN_TIMEOUT_MS = 300_000


export function registerManage(ctx, r) {
  /** 批量开关进行中，避免连点两次互相覆盖。 */
  let modelsBulkBusy = false

  /**
   * 模型三组各有多少行、目录是否读到过。
   *
   * 视图是同步的，拿不到请求结果，所以每次都用这份快照决定「哪些组要显示」；
   * 行本身走数据绑定（`modelOnItems` 等），切换模型后不用重取整棵视图。
   */
  const modelRows = { on: 0, off: 0, dead: 0, loaded: false }

  /**
   * 浏览器登录的中间态。
   *
   * Jet Hub 的登录是两步式：`account.create` 先登记占位账号并返回登录地址，
   * 用户在浏览器授权后由 `login.poll` 收尾。这里只保留「正要打开 / 正在等」，
   * 面板关掉也不停轮询（与一键签到同一个思路）。
   */
  let loginState = { phase: 'idle', provider: '', accountId: '', url: '', opened: false, error: '' }
  /** 轮询句柄与代号：重开一轮登录时旧定时器/旧响应必须作废。 */
  let loginTimer
  let loginNoticeTimer
  let loginSeq = 0

  const stopLoginPoll = () => {
    loginSeq += 1
    if (loginTimer !== undefined) {
      clearTimeout(loginTimer)
      loginTimer = undefined
    }
  }

  const kickAccounts = () => kickAll(r.accountKicks)

  const loginErrorText = (error, zh) => {
    const message = briefError(error)
    if (message.includes('unknown provider')) {
      return zh ? '这个渠道不能在面板里登录，请到 Jet Hub 里添加账号。' : 'This channel has to be added in Jet Hub.'
    }
    if (message.includes('account-create-timeout')) {
      return zh ? '准备登录页超时，请重试（可能是网络慢）。' : 'Preparing the sign-in page timed out; try again.'
    }
    return message
  }

  /**
   * 账号页上的登录状态：note 写进 callout，label 是「添加账号」按钮的文案。
   *
   * 两者都走数据绑定（而不是在视图里按状态拼结构）：宿主只在 refresh 时重取
   * 视图，后台轮询完成时没有 refresh 可发，只有绑定会跟着数据更新。
   */
  const loginSnapshot = (zh) => {
    const state = loginState
    if (state.phase === 'idle') {
      return { note: '', tone: 'info', label: zh ? '添加账号' : 'Add account' }
    }
    if (state.phase === 'preparing') {
      return { note: zh ? '正在准备登录页…' : 'Preparing the sign-in page…', tone: 'info', label: zh ? '准备登录…' : 'Preparing…' }
    }
    if (state.phase === 'waiting') {
      if (state.url === '') {
        return { note: zh ? '账号已登记，等待浏览器授权…' : 'Waiting for authorization in the browser…', tone: 'info', label: zh ? '等待授权' : 'Waiting…' }
      }
      return {
        note: state.opened
          ? (zh ? '在浏览器完成登录，账号会自动出现（最长等 5 分钟）。' : 'Finish signing in in the browser; the account appears here automatically (up to 5 minutes).')
          : (zh ? '登录页已准备好，再点下方按钮打开登录页。' : 'Sign-in page ready; tap the button below to open it.'),
        tone: 'info',
        label: zh ? '打开登录页' : 'Open sign-in page',
      }
    }
    if (state.phase === 'done') {
      return { note: zh ? '登录成功，账号已添加。' : 'Signed in; account added.', tone: 'info', label: zh ? '再添加一个' : 'Add another' }
    }
    if (state.phase === 'failed') {
      return {
        note: zh ? `登录失败：${state.error || '没有返回原因'}` : `Sign-in failed: ${state.error || 'no reason'}`,
        tone: 'warn',
        label: zh ? '重试登录' : 'Retry',
      }
    }
    return {
      note: zh
        ? '登录超时或未完成（已等 5 分钟）；可能是授权没完成、授权被拒，或账号条目已被删除。'
        : 'Sign-in timed out after 5 minutes; the authorization may be unfinished or rejected, or the account was removed.',
      tone: 'warn',
      label: zh ? '重试登录' : 'Retry',
    }
  }

  /** 登录成功后过一会儿收起提示，免得「登录成功」一直挂在面板上。 */
  const scheduleLoginNoticeClear = (seq) => {
    if (loginNoticeTimer !== undefined) clearTimeout(loginNoticeTimer)
    loginNoticeTimer = setTimeout(() => {
      if (seq !== loginSeq || loginState.phase !== 'done') return
      loginState = { ...loginState, phase: 'idle' }
      kickAccounts()
    }, 8_000)
    loginNoticeTimer.unref?.()
  }

  const startLoginPoll = (provider, accountId, zh, seq) => {
    const deadline = Date.now() + LOGIN_TIMEOUT_MS
    const tick = async () => {
      if (seq !== loginSeq) return
      if (Date.now() > deadline) {
        loginState = { ...loginState, phase: 'timeout', url: '', opened: false }
        kickAccounts()
        return
      }
      let result
      try {
        result = await pollLogin(ctx, accountId, provider)
      } catch {
        // 瞬时失败不结束本轮，下一拍再试；到时间上限会给出「超时」。
      }
      if (seq !== loginSeq) return
      if (result?.success === false) {
        r.accountsCache.delete(provider)
        loginState = {
          ...loginState,
          phase: 'failed',
          url: '',
          opened: false,
          error: typeof result.error === 'string' ? result.error : '',
        }
        kickAccounts()
        return
      }
      if (result?.done === true) {
        r.accountsCache.delete(provider)
        loginState = { ...loginState, phase: 'done', url: '', opened: false, error: '' }
        kickAccounts()
        scheduleLoginNoticeClear(seq)
        return
      }
      loginTimer = setTimeout(tick, 1_000)
      loginTimer.unref?.()
    }
    loginTimer = setTimeout(tick, 1_000)
    loginTimer.unref?.()
  }

  const beginLogin = async (provider, zh) => {
    stopLoginPoll()
    const seq = loginSeq
    loginState = { phase: 'preparing', provider, accountId: '', url: '', opened: false, error: '' }
    kickAccounts()
    let created
    try {
      // account.create 可能卡在获取授权地址的网络请求上；超时后放行重试，
      // 否则 loginState 永远停在 preparing，按钮就被自己锁死了。
      created = await Promise.race([
        createAccount(ctx, provider),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('account-create-timeout')), 20_000)
          timer.unref?.()
        }),
      ])
    } catch (error) {
      if (seq !== loginSeq) return
      loginState = { phase: 'failed', provider, accountId: '', url: '', opened: false, error: loginErrorText(error, zh) }
      kickAccounts()
      return
    }
    if (seq !== loginSeq) return
    const accountId = typeof created?.accountId === 'string' ? created.accountId : ''
    const url = typeof created?.loginUrl === 'string' ? created.loginUrl : ''
    if (created?.reused === true) {
      r.accountsCache.delete(provider)
      loginState = { phase: 'done', provider, accountId, url: '', opened: false, error: '' }
      kickAccounts()
      scheduleLoginNoticeClear(seq)
      return
    }
    r.accountsCache.delete(provider)
    loginState = { phase: 'waiting', provider, accountId, url, opened: false, error: '' }
    kickAccounts()
    if (accountId !== '') startLoginPoll(provider, accountId, zh, seq)
  }

  /** 账号状态：封禁 > 过期 > 停用 > 限流 > 正常（详情里会把各项分开写）。 */
  function accountStatus(account, now) {
    if (Number(account?.policyBlockedAtMs) > 0) return { label: '已封禁', tone: 'warn' }
    if (account?.enabled === false) return { label: '已停用', tone: 'muted' }
    const expiresAt = Number(account?.expiresAt)
    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) return { label: '已过期', tone: 'warn' }
    const limits = account?.modelRateLimits
    if (limits !== null && typeof limits === 'object') {
      const future = Object.values(limits).filter((ms) => Number(ms) > now)
      if (future.length > 0) return { label: '限流中', tone: 'warn' }
    }
    return { label: '正常', tone: 'good' }
  }

  const fmtAccountWhen = (ms) => {
    if (!Number.isFinite(ms) || ms <= 0 || ms > 8.64e15) return ''
    try {
      return new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    } catch {
      return ''
    }
  }
  /** 账号详情：列表只给状态，这里把各项摊开。 */
  function buildAccountDetail(account, provider, now, zh) {
    const id = typeof account?.id === 'string' ? account.id : ''
    const nickname = typeof account?.nickname === 'string' && account.nickname !== ''
      ? account.nickname
      : (typeof account?.accountName === 'string' && account.accountName !== '' ? account.accountName : id)
    const status = accountStatus(account, now)
    const expiresAt = Number(account?.expiresAt)
    const expiryText = fmtAccountWhen(expiresAt)
      || (Number.isFinite(expiresAt) && expiresAt > 0 ? (zh ? '未知' : 'unknown') : (zh ? '无' : 'none'))
    const limits = account?.modelRateLimits
    const futureLimits = limits !== null && typeof limits === 'object'
      ? Object.values(limits).map(Number).filter((ms) => Number.isFinite(ms) && ms > now)
      : []
    const rows = [
      [zh ? '昵称' : 'Nickname', nickname],
      [zh ? '账号 ID' : 'Account ID', id],
      [zh ? '状态' : 'Status', status.label],
      [zh ? '启用' : 'Enabled', account?.enabled === false ? (zh ? '已停用' : 'off') : (zh ? '已启用' : 'on')],
      [zh ? '到期' : 'Expires', expiryText],
      [zh ? '自动续期' : 'Refreshable', account?.refreshable === true ? (zh ? '支持' : 'yes') : (zh ? '不支持' : 'no')],
    ]
    if (Number(account?.policyBlockedAtMs) > 0) {
      const reason = typeof account?.policyBlockedMessage === 'string' && account.policyBlockedMessage !== ''
        ? account.policyBlockedMessage.slice(0, 80)
        : (zh ? '上游标记' : 'upstream flag')
      rows.push([zh ? '封禁原因' : 'Blocked', reason])
    }
    if (futureLimits.length > 0) {
      const nearest = Math.min(...futureLimits)
      rows.push([zh ? '限流' : 'Rate limit', zh
        ? `${futureLimits.length} 个模型，最近 ${fmtAccountWhen(nearest)}`
        : `${futureLimits.length} model(s), until ${fmtAccountWhen(nearest)}`])
    }
    if (typeof account?.phone === 'string' && account.phone !== '') rows.push([zh ? '手机号' : 'Phone', account.phone])
    if (typeof account?.accountName === 'string' && account.accountName !== '' && account.accountName !== nickname) {
      rows.push([zh ? '账号名' : 'Account name', account.accountName])
    }
    return {
      id,
      nickname,
      headline: `${labelOf(provider)} · ${nickname}`,
      rows,
      toggleLabel: account?.enabled === false ? (zh ? '启用账号' : 'Enable') : (zh ? '停用账号' : 'Disable'),
    }
  }

  /**
   * 批量开关全部模型。
   *
   * 不在 `pending` 里跑：确认框要立刻消失（延后结果不能带 refresh），所以先
   * refresh 一版，再把写入放后台；进度和结果都写进面板顶部的 note。
   */
  async function runBulkModels(provider, zh, disabled) {
    try {
      const value = await setAllModelsDisabled(ctx, provider, disabled)
      r.modelsCache.delete(provider)
      const warnings = Array.isArray(value?.warnings)
        ? value.warnings.filter((w) => typeof w === 'string' && w !== '')
        : []
      r.modelsNote = warnings.length > 0
        ? warnings[0].slice(0, 120)
        : (disabled ? (zh ? '已关闭全部模型。' : 'All models are off.') : (zh ? '已打开全部模型。' : 'All models are on.'))
    } catch (error) {
      const message = briefError(error)
      r.modelsNote = zh ? `批量操作失败：${message}` : `Bulk action failed: ${message}`
    }
    kickAll(r.modelKicks)
  }

  /** 动作拿不到会话（scope 里没有 sessionId）时，退回面板最后一次显示过的渠道。 */
  const currentProviderForAction = (scope) => r.activeProvider(scope) ?? r.manageProvider

  function startBulkModels(scope, event, disabled) {
    const zh = zhOf(event?.locale)
    const provider = currentProviderForAction(scope)
    if (provider === undefined) return [{ toast: zh ? '没认出这个渠道' : 'Unknown channel' }]
    if (modelsBulkBusy) return [{ toast: zh ? '批量操作还没结束，稍等' : 'Bulk action still running' }]
    modelsBulkBusy = true
    r.modelsNote = disabled
      ? (zh ? '正在关闭全部模型…' : 'Closing all models…')
      : (zh ? '正在打开全部模型…' : 'Opening all models…')
    kickAll(r.modelKicks)
    void runBulkModels(provider, zh, disabled).finally(() => {
      modelsBulkBusy = false
      kickAll(r.modelKicks)
    })
    return [
      { refresh: 'manage' },
      { toast: disabled ? (zh ? '正在关闭全部模型' : 'Closing all') : (zh ? '正在打开全部模型' : 'Opening all') },
    ]
  }

  ctx.dshGo.panel('manage', {
    view: (scope, caps) => {
      const zh = zhOf(caps?.locale)
      const components = Array.isArray(caps?.components) ? caps.components : []
      const canType = ['form', 'textField'].every((name) => components.includes(name))
      const title = { $: 'data.panelTitle' }
      // 两个入口一左一右并排：点哪个切到哪个，当前页那侧用主色。
      const tabButton = (value, label, active) => ({
        type: 'actions',
        items: [{
          label,
          action: { id: 'manage-tab', args: { tab: value } },
          ...(active ? { style: 'primary' } : {}),
        }],
      })
      const activeTab = r.manageTab === 'accounts' ? 'accounts' : 'models'
      const tabs = {
        type: 'row',
        children: [
          tabButton('models', { $: 'data.modelsTabLabel' }, activeTab === 'models'),
          tabButton('accounts', { $: 'data.accountsTabLabel' }, activeTab === 'accounts'),
        ],
      }
      const provider = r.activeProvider(scope)
      if (provider === undefined) {
        return {
          type: 'stack',
          title,
          children: [{ type: 'text', text: { $: 'data.note' }, tone: 'muted' }],
        }
      }
      if (r.manageTab === 'accounts') {
        if (r.accountRename && r.accountDetail !== undefined && canType) {
          return {
            v: 2,
            type: 'stack',
            title,
            children: [
              tabs,
              { type: 'text', text: { $: 'data.detail.headline' }, tone: 'muted' },
              { type: 'keyValue', items: { $: 'data.detailRows' } },
              {
                type: 'form',
                submit: 'account-rename-submit',
                submitLabel: zh ? '保存昵称' : 'Save',
                children: [
                  { type: 'textField', label: zh ? '昵称' : 'Nickname', bind: 'data.form.nickname', maxLength: 40, required: true },
                ],
              },
              { type: 'actions', items: [{ label: zh ? '返回' : 'Back', action: 'account-rename-back', icon: 'collapse' }] },
              { type: 'callout', text: { $: 'data.accountNote' }, tone: { $: 'data.accountNoteTone' } },
            ],
          }
        }
        if (r.accountDetail !== undefined) {
          const children = [
            tabs,
            { type: 'text', text: { $: 'data.detail.headline' }, tone: 'muted' },
            { type: 'keyValue', items: { $: 'data.detailRows' } },
            { type: 'callout', text: { $: 'data.accountNote' }, tone: { $: 'data.accountNoteTone' } },
          ]
          if (r.accountDeleteArm) {
            children.push({
              type: 'callout',
              text: zh
                ? '会删除这个账号和它的凭据，无法撤销。'
                : 'Deletes this account and its credentials. This cannot be undone.',
              tone: 'warn',
            })
            children.push({
              type: 'confirm',
              id: 'account-delete-confirm',
              confirmLabel: zh ? '确认删除' : 'Delete',
              cancelLabel: zh ? '取消' : 'Cancel',
            })
          }
          // 常用操作两两并排（row 在窄屏会自己折行），危险动作单独一行，
          // 不跟日常操作挤在一起。
          children.push({
            type: 'row',
            children: [
              { type: 'actions', items: [{ label: { $: 'data.detail.toggleLabel' }, action: 'account-toggle', icon: 'power' }] },
              { type: 'actions', items: [{ label: zh ? '刷新凭据' : 'Refresh', action: 'account-refresh', icon: 'refresh' }] },
            ],
          })
          children.push({
            type: 'row',
            children: [
              { type: 'actions', items: [{ label: zh ? '测试账号' : 'Test', action: 'account-test', icon: 'check' }] },
              { type: 'actions', items: [{ label: zh ? '重置限流' : 'Reset', action: 'account-reset', icon: 'retry' }] },
            ],
          })
          children.push({
            type: 'row',
            children: [
              ...(canType ? [{ type: 'actions', items: [{ label: zh ? '改昵称' : 'Rename', action: 'account-rename', icon: 'edit' }] }] : []),
              { type: 'actions', items: [{ label: zh ? '删除账号' : 'Delete', action: 'account-delete-ask', icon: 'delete' }] },
              { type: 'actions', items: [{ label: zh ? '返回列表' : 'Back', action: 'account-back', icon: 'collapse' }] },
            ],
          })
          return { type: 'stack', title, children }
        }
        return {
          type: 'stack',
          title,
          children: [
            tabs,
            { type: 'text', text: { $: 'data.accountHeadline' }, tone: 'muted' },
            { type: 'list', items: { $: 'data.accountItems' } },
            { type: 'actions', items: [
              { label: zh ? '刷新列表' : 'Refresh', action: 'accounts-refresh', icon: 'refresh' },
              { label: { $: 'data.loginActionLabel' }, action: 'account-add', icon: 'add' },
            ] },
            { type: 'callout', text: { $: 'data.accountNote' }, tone: { $: 'data.accountNoteTone' } },
          ],
        }
      }
      // 分组用的折叠状态：哪一组展开着（默认只展开「已开启」）。
      const groups = [
        { label: { $: 'data.modelGroupOnLabel' }, key: 'on', itemsKey: 'modelOnItems', count: modelRows.on, expanded: r.modelsOpenGroup === 'on' },
        { label: { $: 'data.modelGroupOffLabel' }, key: 'off', itemsKey: 'modelOffItems', count: modelRows.off, expanded: r.modelsOpenGroup === 'off' },
        { label: { $: 'data.modelGroupDeadLabel' }, key: 'dead', itemsKey: 'modelDeadItems', count: modelRows.dead, expanded: r.modelsOpenGroup === 'dead' },
      ].filter((g) => g.count > 0)
      const bulk = [
        { type: 'actions', items: [{ label: zh ? '全部打开' : 'All on', action: 'models-all-on', icon: 'check' }] },
        { type: 'actions', items: [{ label: zh ? '全部关闭' : 'All off', action: 'models-all-off', icon: 'remove' }] },
      ]
      return {
        type: 'stack',
        title,
        children: [
          tabs,
          { type: 'text', text: { $: 'data.modelHeadline' }, tone: 'muted' },
          // 三档数字并排：和余额面板顶部同一套写法，比四行 keyValue 好扫。
          {
            type: 'row',
            children: [
              { type: 'metric', label: zh ? '已开启' : 'On', value: { $: 'data.modelOnCount' }, tone: 'good' },
              { type: 'metric', label: zh ? '已关闭' : 'Off', value: { $: 'data.modelOffCount' } },
              { type: 'metric', label: zh ? '已失效' : 'Dead', value: { $: 'data.modelDeadCount' }, tone: 'muted' },
            ],
          },
          // 每个组标题下面紧跟它自己的行（展开时），而不是先列完所有标题。
          ...groups.flatMap((g) => [
            {
              type: 'list',
              items: [{
                title: g.label,
                trailing: g.expanded ? (zh ? '收起' : 'Hide') : (zh ? '展开' : 'Show'),
                icon: g.key === 'on' ? 'check' : g.key === 'off' ? 'remove' : 'warning',
                action: { id: 'models-group', args: { group: g.key } },
              }],
            },
            // 只有该组确实有行才渲染列表，否则空的 list 会显示「暂无数据」。
            ...(g.expanded ? [{ type: 'list', items: { $: `data.${g.itemsKey}` } }] : []),
          ]),
          // 没有模型时至少给一句说明，v1 没有空态组件。
          ...(modelRows.loaded && modelRows.on + modelRows.off + modelRows.dead === 0
            ? [{ type: 'text', text: zh ? '这个渠道没有可开关的模型。' : 'No models to switch.', tone: 'muted' }]
            : []),
          { type: 'text', text: { $: 'data.modelPageText' }, tone: 'muted' },
          // 批量开关并排：row 窄屏自动折行，按钮仍是原生 actions。
          { type: 'row', children: bulk },
          ...(r.modelsBulkArm ? [
            {
              type: 'callout',
              text: zh
                ? '会把当前渠道的全部模型从对话的模型选择里移除（不会关闭渠道本身）。'
                : 'Removes every model of this channel from the model picker (does not close the channel).',
              tone: 'warn',
            },
            { type: 'confirm', id: 'models-all-confirm', confirmLabel: zh ? '确认关闭' : 'Confirm', cancelLabel: zh ? '取消' : 'Cancel' },
          ] : []),
          { type: 'actions', items: [{ label: zh ? '刷新' : 'Refresh', action: 'models-refresh', icon: 'refresh' }] },
          { type: 'callout', text: { $: 'data.modelNote' }, tone: { $: 'data.modelNoteTone' } },
        ],
      }
    },
    data: (scope, emit, caps) => {
      const zh = zhOf(caps?.locale)
      let alive = true
      const render = async (force = false) => {
        await r.stateReady
        const provider = r.activeProvider(scope)
        if (provider === undefined) {
          emit({
            panelTitle: zh ? '模型与账号' : 'Models & accounts',
            tab: r.manageTab,
            note: zh
              ? '先在渠道余额面板选一个具体渠道，再点「模型与账号」。'
              : 'Pick a channel in Channel balance, then tap Models & accounts.',
          })
          return
        }
        r.manageProvider = provider
        // 换了渠道，上一家的数量就不作数了。
        if (r.manageCountProvider !== provider) {
          r.manageCountProvider = provider
          r.manageModelCount = null
          r.manageAccountCount = null
        }
        const tab = r.manageTab === 'accounts' ? 'accounts' : 'models'
        // 按钮上只写名字，不带数量：数字在下面三档指标和列表标题里都有。
        const modelsTabLabel = zh ? '模型开关' : 'Models'
        const accountsTabLabel = zh ? '账号管理' : 'Accounts'
        const base = {
          panelTitle: `${labelOf(provider)} · ${zh ? '模型与账号' : 'Models & accounts'}`,
          tab,
          modelsTabLabel,
          accountsTabLabel,
        }

        if (tab === 'accounts') {
          // 冷启动先给一行「正在读取」，别让空列表停在那里。
          if (!force && r.accountsCache.get(provider) === undefined) {
            const login = loginSnapshot(zh)
            emit({
              ...base,
              accountHeadline: `${labelOf(provider)} · ${zh ? '账号管理' : 'Accounts'}`,
              accountItems: [],
              accountNote: login.note !== '' ? login.note : (zh ? '正在读取账号…' : 'Reading accounts…'),
              accountNoteTone: login.note !== '' ? login.tone : 'info',
              loginActionLabel: login.label,
            })
          }
          let value
          try {
            value = await r.readAccountsOf(provider, force)
          } catch {
            if (!alive) return
            r.manageAccountCount = null
            const login = loginSnapshot(zh)
            emit({
              ...base,
              accountHeadline: `${labelOf(provider)} · ${zh ? '账号管理' : 'Accounts'}`,
              accountItems: [],
              accountNote: login.note !== '' ? login.note : (zh ? '读不到账号列表；这个渠道可能没有账号池。' : 'Cannot read the account list.'),
              accountNoteTone: login.note !== '' ? login.tone : 'warn',
              loginActionLabel: login.label,
            })
            return
          }
          if (!alive) return
          const accounts = Array.isArray(value?.accounts) ? value.accounts : []
          r.manageAccountCount = accounts.length
          const now = Date.now()
          const accountItems = accounts.map((account) => {
            const id = typeof account?.id === 'string' ? account.id : ''
            const nickname = typeof account?.nickname === 'string' && account.nickname !== ''
              ? account.nickname
              : (typeof account?.accountName === 'string' && account.accountName !== '' ? account.accountName : id)
            const status = accountStatus(account, now)
            const row = { title: nickname, icon: 'account', trailing: status.label }
            if (status.tone !== 'good') row.tone = status.tone
            const subtitle = typeof account?.phone === 'string' && account.phone !== '' ? account.phone : id
            if (subtitle !== '') row.subtitle = subtitle
            if (id !== '') row.action = { id: 'account-open', args: { account: id } }
            return row
          })
          const current = r.accountDetail === undefined
            ? undefined
            : accounts.find((account) => account?.id === r.accountDetail)
          if (r.accountDetail !== undefined && current === undefined) {
            r.accountDetail = undefined
            r.accountRename = false
            r.accountDeleteArm = false
          }
          const detail = current === undefined ? undefined : buildAccountDetail(current, provider, now, zh)
          const defaultNote = detail === undefined
            ? (zh ? '点账号查看详情；停用只影响自动选号，不影响手动测试。' : 'Tap an account for details. Disabling only affects automatic selection.')
            : (zh ? '停用只影响自动选号；测试会发一次真实请求。' : 'Disabling only affects automatic selection; Test sends one real request.')
          const login = loginSnapshot(zh)
          const accountNote = login.note !== '' ? login.note : (r.accountsNote !== '' ? r.accountsNote : defaultNote)
          emit({
            ...base,
            accountHeadline: `${labelOf(provider)} · ${zh ? `共 ${accounts.length} 个账号` : `${accounts.length} account(s)`}`,
            accountItems,
            detail,
            detailRows: detail?.rows ?? [],
            form: { nickname: detail?.nickname ?? '' },
            accountNote,
            accountNoteTone: login.note !== '' ? login.tone : (r.accountsNote !== '' ? r.accountsNoteTone : 'info'),
            loginActionLabel: login.label,
          })
          return
        }

        if (!force && r.modelsCache.get(provider) === undefined) {
          emit({
            ...base,
            modelHeadline: `${labelOf(provider)} · ${provider}`,
            modelStats: [],
            modelItems: [],
            modelPageText: '',
            modelNote: zh ? '正在读取模型…' : 'Reading models…',
            modelNoteTone: 'info',
            loginActionLabel: loginSnapshot(zh).label,
          })
        }
        let value
        try {
          value = await r.readModelsOf(provider, force)
        } catch {
          if (!alive) return
          r.manageModelCount = null
          emit({
            ...base,
            modelHeadline: `${labelOf(provider)} · ${provider}`,
            modelStats: [],
            modelItems: [],
            modelPageText: '',
            modelNote: zh
              ? '读不到模型列表；这个渠道可能没有可切换的模型目录。'
              : 'Cannot read the model list; this channel may have no catalog.',
            modelNoteTone: 'warn',
            loginActionLabel: loginSnapshot(zh).label,
          })
          return
        }
        if (!alive) return
        const models = Array.isArray(value?.models) ? value.models : []
        let enabled = 0
        let off = 0
        let dead = 0
        for (const model of models) {
          if (model?.dead === true) dead += 1
          else if (model?.disabled === true) off += 1
          else enabled += 1
        }
        r.manageModelCount = { enabled, total: models.length }
        const rowOf = (model) => {
          const id = typeof model?.id === 'string' ? model.id : ''
          const name = typeof model?.name === 'string' && model.name !== '' ? model.name : id
          const isDead = model?.dead === true
          const isOff = model?.disabled === true
          const row = {
            title: name,
            trailing: isDead ? (zh ? '已失效' : 'dead') : isOff ? (zh ? '已关闭' : 'off') : (zh ? '已开启' : 'on'),
            icon: 'model',
          }
          if (name !== id) row.subtitle = id
          if (isDead || isOff) row.tone = 'muted'
          if (!isDead && id !== '') row.action = { id: 'model-toggle', args: { model: id, next: !isOff } }
          return row
        }
        const onRows = []
        const offRows = []
        const deadRows = []
        for (const model of models) {
          if (model?.dead === true) deadRows.push(rowOf(model))
          else if (model?.disabled === true) offRows.push(rowOf(model))
          else onRows.push(rowOf(model))
        }
        modelRows.on = onRows.length
        modelRows.off = offRows.length
        modelRows.dead = deadRows.length
        modelRows.loaded = true
        // 分组视图直接列出全部，不再分页。
        const modelItems = models.map(rowOf)
        const note = r.modelsNote !== ''
          ? r.modelsNote
          : models.length === 0
            ? (zh ? '这个渠道没有可开关的模型。' : 'No models to switch.')
            : (zh ? '点一行开 / 关模型；标「已失效」的条目只能看。' : 'Tap a row to toggle it; dead models are read-only.')
        emit({
          ...base,
          modelHeadline: `${labelOf(provider)} · ${provider}`,
          modelStats: [
            [zh ? '已开启' : 'On', String(enabled)],
            [zh ? '已关闭' : 'Off', String(off)],
            [zh ? '已失效' : 'Dead', String(dead)],
            [zh ? '总数' : 'Total', String(models.length)],
          ],
          modelItems,
          modelOnCount: String(enabled),
          modelOffCount: String(off),
          modelDeadCount: String(dead),
          modelGroupOnLabel: zh ? `已开启 ${enabled}` : `On ${enabled}`,
          modelGroupOffLabel: zh ? `已关闭 ${off}` : `Off ${off}`,
          modelGroupDeadLabel: zh ? `已失效 ${dead}` : `Dead ${dead}`,
          modelOnItems: onRows,
          modelOffItems: offRows,
          modelDeadItems: deadRows,
          modelPageText: models.length === 0 ? '' : (zh ? `共 ${models.length} 个模型` : `${models.length} models`),
          modelNote: note,
          modelNoteTone: r.modelsNote === '' ? 'info' : 'warn',
          loginActionLabel: loginSnapshot(zh).label,
        })
      }
      void render()
      // 切标签只重画当前页；两个强制 kick 只在对应标签页上才真的重读，
      // 免得模型面板刷一下顺手把账号列表也拉一遍。
      const kick = () => void render(false)
      const modelsKick = () => {
        if (r.manageTab === 'models') void render(true)
      }
      const accountsKick = () => {
        if (r.manageTab === 'accounts') void render(true)
      }
      r.manageKicks.add(kick)
      r.modelKicks.add(modelsKick)
      r.accountKicks.add(accountsKick)
      return () => {
        alive = false
        r.manageKicks.delete(kick)
        r.modelKicks.delete(modelsKick)
        r.accountKicks.delete(accountsKick)
      }
    },
    actions: {
      'manage-tab': (scope, event) => {
        // 列表行 / 动作按钮把参数放在 event.value 顶层（args 里的键直接展开），
        // 选项式控件则放在 value.value 里。
        const value = event?.value?.tab ?? event?.value?.value
        if (value !== 'models' && value !== 'accounts') return []
        if (value === r.manageTab) return []
        r.manageTab = value
        r.accountDetail = undefined
        r.accountRename = false
        r.accountDeleteArm = false
        r.modelsBulkArm = false
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      /** 全部打开：不弹确认，直接恢复。 */
      'models-all-on': (scope, event) => startBulkModels(scope, event, false),
      /** 全部关闭：先亮出确认，真的动手交给 models-all-confirm。 */
      'models-all-off': () => {
        r.modelsBulkArm = true
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'models-all-confirm': (scope, event) => {
        const zh = zhOf(event?.locale)
        r.modelsBulkArm = false
        if (event?.value?.confirmed !== true) {
          kickAll(r.manageKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '已取消' : 'Cancelled' }]
        }
        return startBulkModels(scope, event, true)
      },
      /** 点组标题：展开这一组，收起其它组。 */
      'models-group': (scope, event) => {
        const group = event?.value?.group
        if (group !== 'on' && group !== 'off' && group !== 'dead') return []
        r.modelsOpenGroup = r.modelsOpenGroup === group ? 'on' : group
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'models-refresh': (scope, event) => {
        r.modelsCache.clear()
        r.modelsNote = ''
        kickAll(r.modelKicks)
        return [{ refresh: 'manage' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
      },
      'model-toggle': (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        const model = typeof event?.value?.model === 'string' ? event.value.model : ''
        const next = event?.value?.next === true
        if (provider === undefined || model === '') return [{ toast: zh ? '没认出这个模型' : 'Unknown model' }]
        return {
          pending: {
            label: next ? (zh ? '正在关闭模型' : 'Disabling') : (zh ? '正在开启模型' : 'Enabling'),
            timeoutMs: 20_000,
          },
          result: async () => {
            try {
              const value = await setModelDisabled(ctx, provider, model, next)
              r.modelsCache.delete(provider)
              const warnings = Array.isArray(value?.warnings) ? value.warnings.filter((w) => typeof w === 'string' && w !== '') : []
              r.modelsNote = warnings.length > 0 ? warnings[0].slice(0, 120) : ''
              kickAll(r.modelKicks)
              return { toast: next ? (zh ? '已关闭模型' : 'Model off') : (zh ? '已开启模型' : 'Model on') }
            } catch {
              r.modelsNote = zh ? '切换失败，请稍后再试。' : 'Switch failed; try again.'
              kickAll(r.modelKicks)
              return { toast: zh ? '切换失败' : 'Switch failed' }
            }
          },
        }
      },
      'account-open': (scope, event) => {
        const id = typeof event?.value?.account === 'string' ? event.value.account : ''
        if (id === '') return [{ toast: zhOf(event?.locale) ? '没认出这个账号' : 'Unknown account' }]
        r.accountDetail = id
        r.accountRename = false
        r.accountDeleteArm = false
        r.accountsNote = ''
        r.accountsNoteTone = 'info'
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'account-back': () => {
        r.accountDetail = undefined
        r.accountRename = false
        r.accountDeleteArm = false
        r.accountsNote = ''
        r.accountsNoteTone = 'info'
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'accounts-refresh': (scope, event) => {
        r.accountsCache.clear()
        r.accountsNote = ''
        r.accountsNoteTone = 'info'
        kickAll(r.accountKicks)
        return [{ refresh: 'manage' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
      },
      /**
       * 「添加账号 / 打开登录页」共用一个按钮：按钮文案由数据绑定决定，
       * 点按行为按当前登录阶段分派。这样后台轮询完成时不需要重取视图，
       * 绑定会跟着数据变。
       */
      'account-add': (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        if (provider === undefined) return [{ toast: zh ? '先选一个渠道' : 'Pick a channel first' }, { refresh: 'manage' }]
        if (loginState.provider === provider) {
          if (loginState.phase === 'preparing') {
            return [{ toast: zh ? '正在准备登录页，稍等' : 'Preparing the sign-in page' }]
          }
          if (loginState.phase === 'waiting') {
            if (loginState.url === '') {
              return [{ toast: zh ? '账号已登记，等待浏览器授权' : 'Waiting for authorization' }]
            }
            loginState = { ...loginState, opened: true }
            const effects = loginState.url.startsWith('https://')
              ? [{ link: loginState.url }]
              : [
                { copy: loginState.url },
                { toast: zh ? '登录页地址已复制，请在浏览器打开' : 'Sign-in link copied' },
              ]
            return [...effects, { refresh: 'manage' }]
          }
        }
        // 空态、失败、超时，或上一次登录是另一个渠道：重新起一轮。
        void beginLogin(provider, zh)
        return [{ refresh: 'manage' }, { toast: zh ? '正在准备登录页' : 'Preparing the sign-in page' }]
      },
      'account-toggle': async (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        const id = r.accountDetail
        const entry = provider === undefined || r.accountsCache.get(provider)?.value?.accounts === undefined
          ? undefined
          : r.accountsCache.get(provider).value.accounts.find((account) => account?.id === id)
        if (provider === undefined || id === undefined || entry === undefined) {
          return [{ toast: zh ? '没认出这个账号' : 'Unknown account' }]
        }
        const next = entry.enabled === false
        try {
          await updateAccount(ctx, id, { enabled: next })
          r.accountsCache.delete(provider)
          r.accountsNote = next ? (zh ? '账号已启用。' : 'Account enabled.') : (zh ? '账号已停用。' : 'Account disabled.')
          r.accountsNoteTone = 'info'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: next ? (zh ? '已启用' : 'Enabled') : (zh ? '已停用' : 'Disabled') }]
        } catch (error) {
          const message = briefError(error)
          r.accountsNote = zh ? `操作失败：${message}` : `Failed: ${message}`
          r.accountsNoteTone = 'warn'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '操作失败' : 'Failed' }]
        }
      },
      'account-refresh': (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        const id = r.accountDetail
        if (provider === undefined || id === undefined) return [{ toast: zh ? '没认出这个账号' : 'Unknown account' }]
        return {
          pending: { label: zh ? '正在刷新凭据' : 'Refreshing', timeoutMs: 20_000 },
          result: async () => {
            try {
              const value = await refreshAccount(ctx, id)
              if (value?.success === false) {
                throw new Error(String(value?.error ?? (zh ? '上游没有返回成功' : 'upstream did not succeed')))
              }
              r.accountsCache.delete(provider)
              r.accountsNote = zh ? '凭据已刷新。' : 'Credential refreshed.'
              r.accountsNoteTone = 'info'
              kickAll(r.accountKicks)
              return { toast: zh ? '凭据已刷新' : 'Credential refreshed' }
            } catch (error) {
              const message = briefError(error)
              r.accountsNote = zh ? `刷新失败：${message}` : `Refresh failed: ${message}`
              r.accountsNoteTone = 'warn'
              kickAll(r.accountKicks)
              return { toast: zh ? '刷新失败' : 'Refresh failed' }
            }
          },
        }
      },
      'account-test': (scope, event) => {
        const zh = zhOf(event?.locale)
        const id = r.accountDetail
        if (id === undefined) return [{ toast: zh ? '没认出这个账号' : 'Unknown account' }]
        return {
          pending: { label: zh ? '正在测试账号' : 'Testing', timeoutMs: 30_000 },
          result: async () => {
            try {
              const value = await testAccount(ctx, id)
              const ok = value?.ok === true
              const model = typeof value?.modelId === 'string' && value.modelId !== '' ? `（${value.modelId}）` : ''
              r.accountsNote = ok
                ? (zh ? `测试通过${model}。` : `Test passed${model}.`)
                : (zh ? `测试失败：${String(value?.message ?? '没有返回原因').slice(0, 120)}` : `Test failed: ${String(value?.message ?? 'no reason').slice(0, 120)}`)
              r.accountsNoteTone = ok ? 'info' : 'warn'
              kickAll(r.accountKicks)
              return { toast: ok ? (zh ? '测试通过' : 'Test passed') : (zh ? '测试失败' : 'Test failed') }
            } catch (error) {
              const message = briefError(error)
              r.accountsNote = zh ? `测试失败：${message}` : `Test failed: ${message}`
              r.accountsNoteTone = 'warn'
              kickAll(r.accountKicks)
              return { toast: zh ? '测试失败' : 'Test failed' }
            }
          },
        }
      },
      'account-reset': async (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        const id = r.accountDetail
        if (provider === undefined || id === undefined) return [{ toast: zh ? '没认出这个账号' : 'Unknown account' }]
        try {
          const value = await resetAccount(ctx, id)
          r.accountsCache.delete(provider)
          const count = Number.isFinite(Number(value?.clearedCount)) ? Number(value.clearedCount) : 0
          const touched = Number(value?.accountCount) > 0
          r.accountsNote = count > 0
            ? (zh ? `已清除 ${count} 条限流标记。` : `Cleared ${count} rate-limit marker(s).`)
            : touched
              ? (zh ? '已清除账号的封禁标记。' : 'Cleared the account flag.')
              : (zh ? '没有需要清除的标记。' : 'Nothing to clear.')
          r.accountsNoteTone = 'info'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '限流已重置' : 'Limits reset' }]
        } catch (error) {
          const message = briefError(error)
          r.accountsNote = zh ? `重置失败：${message}` : `Reset failed: ${message}`
          r.accountsNoteTone = 'warn'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '重置失败' : 'Reset failed' }]
        }
      },
      'account-rename': () => {
        r.accountDeleteArm = false
        r.accountRename = true
        r.accountsNote = ''
        r.accountsNoteTone = 'info'
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'account-rename-back': () => {
        r.accountRename = false
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'account-rename-submit': async (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        const id = r.accountDetail
        const raw = event?.value?.values?.['data.form.nickname']
        const nickname = typeof raw === 'string' ? raw.trim() : ''
        if (provider === undefined || id === undefined) return [{ toast: zh ? '没认出这个账号' : 'Unknown account' }]
        if (nickname === '') return [{ toast: zh ? '昵称不能为空' : 'Nickname is empty' }]
        try {
          await updateAccount(ctx, id, { nickname })
          r.accountsCache.delete(provider)
          r.accountRename = false
          r.accountsNote = zh ? '昵称已更新。' : 'Nickname updated.'
          r.accountsNoteTone = 'info'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '昵称已更新' : 'Nickname updated' }]
        } catch (error) {
          const message = briefError(error)
          r.accountsNote = zh ? `改名失败：${message}` : `Rename failed: ${message}`
          r.accountsNoteTone = 'warn'
          kickAll(r.accountKicks)
          return [{ toast: zh ? '改名失败' : 'Rename failed' }]
        }
      },
      'account-delete-ask': () => {
        r.accountDeleteArm = true
        r.accountRename = false
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'account-delete-confirm': async (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        const id = r.accountDetail
        r.accountDeleteArm = false
        if (event?.value?.confirmed !== true) {
          kickAll(r.manageKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '已取消' : 'Cancelled' }]
        }
        if (provider === undefined || id === undefined) return [{ toast: zh ? '没认出这个账号' : 'Unknown account' }]
        try {
          await deleteAccount(ctx, id)
          r.accountsCache.delete(provider)
          r.accountDetail = undefined
          r.accountRename = false
          r.accountsNote = zh ? '账号已删除。' : 'Account deleted.'
          r.accountsNoteTone = 'info'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '已删除' : 'Deleted' }]
        } catch (error) {
          const message = briefError(error)
          r.accountsNote = zh ? `删除失败：${message}` : `Delete failed: ${message}`
          r.accountsNoteTone = 'warn'
          kickAll(r.accountKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '删除失败' : 'Delete failed' }]
        }
      },
    },
  })

  // 与 Jet Hub 面板共用同一份模型黑名单：那边开关模型会广播这个事件，
  // 这里清掉 30 秒目录缓存，让打开着的模型面板立刻重读（双向同步）。
  ctx.on('llm/adapters-updated', () => {
    r.modelsCache.clear()
    kickAll(r.modelKicks)
  })
}
