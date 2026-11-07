// 模型开关 + 账号管理：一个面板，顶部两个选项当标签页。
//
// 两边共用「当前渠道」这一个前提，拆成两个面板只会多一个按钮。只读当前标签页的
// 数据；缓存各自独立（模型 30 秒、账号 15 秒），切标签不再发请求。
//
// 模型目录来自 Jet Hub 的 `model.list`，账号列表来自 `account.list`；
// 添加账号走 Jet Hub 的两步式登录：`account.create` 给登录页，`login.poll` 收尾。

import {
  clearDeadModel,
  createAccount,
  deleteAccount,
  pollLogin,
  readProviderStatus,
  refreshAccount,
  reorderAccounts,
  resetAccount,
  setAllModelsDisabled,
  setModelDisabled,
  setProviderEnabled,
  testAccount,
  updateAccount,
} from '../jet-hub.js'
import { labelOf } from '../labels.js'
import { createAutoCheckinSection } from './auto-checkin.js'
import { createHostSection } from './host.js'
import { applyOrder, moveSelected, nextOpenGroup, orderedIdsOf } from '../order.js'
import { briefError, kickAll, zhOf } from '../util.js'

/** 浏览器登录最多等 5 分钟（与 Jet Hub 自己的轮询上限一致）。 */
const LOGIN_TIMEOUT_MS = 300_000


export function registerManage(ctx, r) {
  /** 批量开关进行中，避免连点两次互相覆盖。 */
  let modelsBulkBusy = false

  /** 「主机设置」这一页的内容（放在管理面板内，不单独占面板入口）。 */
  const hostSection = createHostSection(ctx)

  /** 「自动签到」这一页。 */
  const autoSection = createAutoCheckinSection(ctx)

  /**
   * 渠道整体开关的二次确认状态。
   *
   * 「关闭整条渠道」会同时关掉全部模型和停用全部账号，比「全部关闭模型」更重，
   * 所以走自己的确认，不复用 modelsBulkArm（那个的文案说的是「不关闭渠道本身」）。
   */
  let providerArm = false
  /** 渠道开关状态：`{ total, disabled, closed, accountsTotal, accountsEnabled }`。 */
  let providerState = undefined
  /** 账号排序进行中，避免连点两次算出同一个顺序。 */
  let reorderBusy = false
  /**
   * 连点合并：本地先按新顺序摆好，稳定 400ms 后才把最终顺序写回 Jet Hub。
   *
   * 「上移」连点三次就是三次写盘 + 三次广播（Jet Hub 那边每次都整份文档重写），
   * 而用户要的只是最后那个位置。合并之后中途的顺序只在本机生效，最终状态一致。
   */
  const REORDER_FLUSH_MS = 400
  let reorderFlushTimer
  /**
   * 排序模式开关。`false` = 普通浏览，`true` = 排序页（列表变勾选 + 底部一排移动按钮）。
   *
   * 为什么是「多选 + 底部按钮」而不是每行两个箭头：原生 list 一行只能挂一个
   * action，放不下「上移 / 下移」两个；而用 row + actions 自己拼行就等于自造
   * 列表，那是不能引入的非原生 UI。多选还有个额外好处：一批账号能整块一起挪，
   * 不用一条一条来。
   */
  let reorderMode = false
  /** 排序页里勾选中的账号 id。 */
  let reorderSelected = new Set()

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
  function buildAccountDetail(account, provider, now, zh, position, lastIndex) {
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
    if (position !== undefined) {
      rows.push([zh ? '选号顺序' : 'Pick order', zh ? `第 ${position + 1} 位` : `#${position + 1}`])
    }
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
      // 详情页只保留「排第几」这个事实；真正挪位置在列表的排序模式里做。
      positionLabel: position === undefined ? '' : zh ? `第 ${position + 1} 位` : `#${position + 1}`,
    }
  }

  /**
   * 渠道整体开关在界面上的三件套。
   *
   * `providerState` 可能读不到（Jet Hub 没装 / 这个 id 不认识），此时按「未知」渲染，
   * 不要用「已开启」顶替 —— 那会让用户以为渠道是好的。
   */
  function providerFields(zh) {
    const state = providerState
    if (state === undefined) {
      return {
        providerTitle: zh ? '整条渠道' : 'Whole channel',
        providerSubtitle: zh ? '读不到状态' : 'State unavailable',
        providerTrailing: '—',
        providerTone: 'warn',
      }
    }
    const closed = state?.closed === true
    const total = Number(state?.models?.total) || 0
    const off = Number(state?.models?.disabled) || 0
    const accountsTotal = Number(state?.accounts?.total) || 0
    const accountsOn = Number(state?.accounts?.enabled) || 0
    return {
      providerTitle: zh ? '整条渠道' : 'Whole channel',
      providerSubtitle: zh
        ? `${off}/${total} 个模型关闭 · ${accountsOn}/${accountsTotal} 个账号启用`
        : `${off}/${total} models off · ${accountsOn}/${accountsTotal} accounts on`,
      providerTrailing: closed ? (zh ? '已关闭' : 'closed') : (zh ? '已开启' : 'on'),
      providerTone: closed ? 'muted' : 'good',
    }
  }

  /**
   * 账号列表 → list 行。
   *
   * 抽出来是因为「切换标签时的同步渲染」和「异步读取后的完整渲染」都要用它，
   * 两处各写一遍必然漂移（光标顺序、选中态、状态 tone 会不一致）。
   */
  /**
   * 账号页顶部那一排指标。
   *
   * 同步渲染与异步渲染都用它，避免两处口径不同（一处算启用、一处算停用）。
   */
  function accountCountFields(accounts, zh) {
    const list = Array.isArray(accounts) ? accounts : []
    const enabled = list.filter((account) => account?.enabled !== false).length
    return {
      accountCount: String(list.length),
      accountEnabledCount: String(enabled),
      accountDisabledCount: String(list.length - enabled),
    }
  }

  function accountRowsOf(accounts, now, zh) {
    return (Array.isArray(accounts) ? accounts : []).map((account, index) => {
      const id = typeof account?.id === 'string' ? account.id : ''
      const nickname = typeof account?.nickname === 'string' && account.nickname !== ''
        ? account.nickname
        : (typeof account?.accountName === 'string' && account.accountName !== '' ? account.accountName : id)
      const status = accountStatus(account, now)
      if (reorderMode) {
        const picked = reorderSelected.has(id)
        const row = {
          title: `${index + 1}. ${nickname}`,
          icon: picked ? 'check' : 'account',
          trailing: picked ? (zh ? '已选中' : 'Selected') : (zh ? '未选中' : 'Tap to select'),
        }
        if (picked) row.tone = 'good'
        if (id !== '') row.action = { id: 'reorder-toggle', args: { account: id } }
        return row
      }
      const row = { title: nickname, icon: 'account', trailing: status.label }
      if (status.tone !== 'good') row.tone = status.tone
      const subtitle = typeof account?.phone === 'string' && account.phone !== '' ? account.phone : id
      if (subtitle !== '') row.subtitle = subtitle
      if (id !== '') row.action = { id: 'account-open', args: { account: id } }
      return row
    })
  }

  /** 模型目录 → 模型页要的那一整组字段。同上，两处渲染共用一份。 */
  function modelFieldsOf(models, provider, zh) {
    const list = Array.isArray(models) ? models : []
    let enabled = 0
    let off = 0
    let dead = 0
    for (const model of list) {
      if (model?.dead === true) dead += 1
      else if (model?.disabled === true) off += 1
      else enabled += 1
    }
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
    for (const model of list) {
      if (model?.dead === true) deadRows.push(rowOf(model))
      else if (model?.disabled === true) offRows.push(rowOf(model))
      else onRows.push(rowOf(model))
    }
    modelRows.on = onRows.length
    modelRows.off = offRows.length
    modelRows.dead = deadRows.length
    modelRows.loaded = true
    const note = r.modelsNote !== ''
      ? r.modelsNote
      : list.length === 0
        ? (zh ? '这个渠道没有可开关的模型。' : 'No models to switch.')
        : (zh ? '点一行开 / 关模型；标「已失效」的条目只能看。' : 'Tap a row to toggle it; dead models are read-only.')
    return {
      modelHeadline: `${labelOf(provider)} · ${provider}`,
      modelStats: [
        [zh ? '已开启' : 'On', String(enabled)],
        [zh ? '已关闭' : 'Off', String(off)],
        [zh ? '已失效' : 'Dead', String(dead)],
        [zh ? '总数' : 'Total', String(list.length)],
      ],
      modelItems: list.map(rowOf),
      modelOnCount: String(enabled),
      modelOffCount: String(off),
      modelDeadCount: String(dead),
      modelGroupOnLabel: zh ? `已开启 ${enabled}` : `On ${enabled}`,
      modelGroupOffLabel: zh ? `已关闭 ${off}` : `Off ${off}`,
      modelGroupDeadLabel: zh ? `已失效 ${dead}` : `Dead ${dead}`,
      modelOnItems: onRows,
      modelOffItems: offRows,
      modelDeadItems: deadRows,
      modelPageText: list.length === 0 ? '' : (zh ? `共 ${list.length} 个模型` : `${list.length} models`),
      modelNote: note,
      modelNoteTone: r.modelsNote === '' ? 'info' : 'warn',
      loginActionLabel: loginSnapshot(zh).label,
      ...providerFields(zh),
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

  /**
   * 把勾选的一组账号整块上移 / 下移 / 置顶 / 沉底。
   *
   * 顺序是自动选号优先级，不是纯 UI 排序，所以每次都要走 Jet Hub 的
   * `account.reorder`；它还要求传**全量 id**，少一个就整次失败。
   *
   * ⚠️ 不做乐观缓存：账号页的刷新是强制重读（绕过缓存），先改缓存只会让界面先跳到
   * 新顺序、随即被服务端那份旧顺序顶回去，看起来像点坏了。本地顺序在写成功后由
   * 重读带回来，所以这里只负责「算新顺序 + 提交」。
   */
  function moveSelectedBlock(scope, event, direction) {
    const zh = zhOf(event?.locale)
    const provider = currentProviderForAction(scope)
    if (provider === undefined) return [{ toast: zh ? '没认出这个渠道' : 'Unknown channel' }]
    if (reorderSelected.size === 0) {
      return [{ toast: zh ? '先勾选账号' : 'Select accounts first' }]
    }
    // 不因「正在落盘」而拒绝：本地顺序是即时生效的，落盘由 flushReorder 排队，
    // 拒绝只会让用户连点时手感变卡。
    const cached = r.accountsCache.get(provider)?.value?.accounts
    const accounts = Array.isArray(cached) ? cached : []
    const ids = orderedIdsOf(accounts)
    if (ids === null) return [{ toast: zh ? '账号列表不完整，先刷新' : 'Refresh the list first' }]
    const next = moveSelected(ids, reorderSelected, direction)
    if (next === null) {
      return [{ toast: direction === 'up' || direction === 'top'
        ? (zh ? '已经到顶了' : 'Already at the top')
        : (zh ? '已经到底了' : 'Already at the bottom') }]
    }
    const count = reorderSelected.size
    // 本地先按新顺序摆好，界面立刻动；落盘合并到 400ms 后的一次。
    const hit = r.accountsCache.get(provider)
    if (hit !== undefined) {
      r.accountsCache.set(provider, {
        at: Date.now(),
        value: { ...hit.value, accounts: applyOrder(accounts, next) },
      })
    }
    kickAll(r.manageKicks)
    scheduleReorderFlush(provider, zh)
    return [{ refresh: 'manage' }, { toast: zh ? `已调整 ${count} 个账号` : `Moved ${count}` }]
  }

  /** 把当前缓存里的顺序写回 Jet Hub（连点合并后只跑最后一次）。 */
  function scheduleReorderFlush(provider, zh) {
    if (reorderFlushTimer !== undefined) clearTimeout(reorderFlushTimer)
    reorderFlushTimer = setTimeout(() => {
      reorderFlushTimer = undefined
      void flushReorder(provider, zh)
    }, REORDER_FLUSH_MS)
    reorderFlushTimer.unref?.()
  }

  async function flushReorder(provider, zh) {
    if (reorderBusy) {
      // 上一轮还在飞：再等一轮，别把两次写入挤在一起。
      scheduleReorderFlush(provider, zh)
      return
    }
    const accounts = r.accountsCache.get(provider)?.value?.accounts
    const ids = orderedIdsOf(Array.isArray(accounts) ? accounts : [])
    if (ids === null || ids.length === 0) return
    reorderBusy = true
    try {
      await reorderAccounts(ctx, provider, ids)
    } catch (error) {
      // 失败就丢掉缓存，强制重读会拿回服务端那份真实顺序。
      r.accountsCache.delete(provider)
      r.accountsNote = zh ? `保存顺序失败：${briefError(error)}` : `Order failed: ${briefError(error)}`
      r.accountsNoteTone = 'warn'
    } finally {
      reorderBusy = false
      kickAll(r.manageKicks)
    }
  }

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
      // 页面层级：首页（四选一）→ 内容页。内容页顶部只有一条「返回管理」，
      // 不再并排三个标签：标签会让弹层随内容高度伸缩，页面之间切换时跳。
      //
      // 箭头只由 `icon` 画：动作标签本身带 `‹` 会和图标叠成两个箭头。
      const backBar = r.manageTab === 'home'
        ? undefined
        : { type: 'actions', items: [{ label: zh ? '返回管理' : 'Back', action: 'manage-home', icon: 'collapse' }] }

      const provider = r.activeProvider(scope)

      // 自动签到页：跟渠道无关，不读列表数据。
      if (r.manageTab === 'auto') {
        return {
          type: 'stack',
          title: zh ? '自动签到' : 'Auto check-in',
          children: [
            ...(backBar === undefined ? [] : [backBar]),
            ...autoSection.view(zh),
          ],
        }
      }

      // 主机页：跟渠道无关，不读列表数据。
      if (r.manageTab === 'host') {
        return {
          type: 'stack',
          title: zh ? '主机设置' : 'Host settings',
          children: [
            ...(backBar === undefined ? [] : [backBar]),
            ...hostSection.view(zh),
          ],
        }
      }

      /**
       * 首页：四个选项。
       *
       * ⚠️ 选项内容**直接写在视图里**，不用 `{ $: 'data.homeItems' }` 绑定：
       * 绑定要靠 data 推送，一旦推送没到（插件刚重载、桥接抖动、面板复用时
       * data 还没起），首页就成了一个整页「暂无数据」+「—」的空壳，而且用户
       * 点不动 —— 那正是「点管理会卡住、只有渠道余额标题」的成因。
       * 这一页本来就没有任何动态内容，静态写死反而最稳。
       */
      if (r.manageTab === 'home') {
        return {
          type: 'stack',
          title: zh ? '管理' : 'Manage',
          children: [
            {
              type: 'list',
              items: [
                {
                  title: zh ? '模型开关' : 'Models',
                  subtitle: zh ? '逐个开关模型，控制它出不出现在选择器里' : 'Turn individual models on or off',
                  icon: 'model',
                  action: { id: 'manage-tab', args: { tab: 'models' } },
                },
                {
                  title: zh ? '账号管理' : 'Accounts',
                  subtitle: zh ? '添加、启停、改名、测试、排序、删除' : 'Add, enable, rename, test, reorder, delete',
                  icon: 'account',
                  action: { id: 'manage-tab', args: { tab: 'accounts' } },
                },
                {
                  title: zh ? '自动签到' : 'Auto check-in',
                  subtitle: zh ? '每天两次，到点自动领取各渠道积分' : 'Claims daily credits twice a day',
                  icon: 'alarm',
                  action: { id: 'manage-tab', args: { tab: 'auto' } },
                },
                {
                  title: zh ? '主机设置' : 'Host settings',
                  subtitle: zh ? '本机网关、渠道原生搜索、ZCode 会话分流' : 'Gateway, native search, session balance',
                  icon: 'server',
                  action: { id: 'manage-tab', args: { tab: 'host' } },
                },
              ],
            },
            {
              type: 'callout',
              text: zh ? '点一项进入；返回这里随时可以换另一项。' : 'Tap one to open it; come back here to switch.',
              tone: 'info',
            },
          ],
        }
      }

      if (provider === undefined) {
        return {
          type: 'stack',
          title,
          children: [
            ...(backBar === undefined ? [] : [backBar]),
            { type: 'text', text: { $: 'data.note' }, tone: 'muted' },
          ],
        }
      }
      if (r.manageTab === 'accounts') {
        if (r.accountRename && r.accountDetail !== undefined && canType) {
          return {
            v: 2,
            type: 'stack',
            title,
            children: [
              ...(backBar === undefined ? [] : [backBar]),
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
            ...(backBar === undefined ? [] : [backBar]),
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
          // 排序入口只在列表页的排序模式里给一处：详情页再放一套「置顶 / 沉底」，
          // 会和列表页的说法打架（用户不知道哪个才算「顺序」）。
          children.push({
            type: 'actions',
            items: [{ label: zh ? '调整顺序' : 'Reorder', action: 'reorder-enter', icon: 'list' }],
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
        // 排序页：勾选若干账号 → 底部一排按钮整块上移 / 下移 / 置顶 / 沉底。
        // 放在列表页而不是详情页，因为顺序要同时看到全部账号才决策得动。
        if (reorderMode) {
          // 四个按钮分两行：窄屏一行放四个会被挤成很窄的条，两行两列更好按。
          const moveRow = {
            type: 'row',
            children: [
              { type: 'actions', items: [{ label: zh ? '上移' : 'Up', action: 'reorder-up', icon: 'expand' }] },
              { type: 'actions', items: [{ label: zh ? '下移' : 'Down', action: 'reorder-down', icon: 'collapse' }] },
            ],
          }
          const jumpRow = {
            type: 'row',
            children: [
              { type: 'actions', items: [{ label: zh ? '移到最前' : 'To top', action: 'reorder-top', icon: 'collapse' }] },
              { type: 'actions', items: [{ label: zh ? '移到最后' : 'To bottom', action: 'reorder-bottom', icon: 'expand' }] },
            ],
          }
          return {
            type: 'stack',
            title: zh ? '调整账号顺序' : 'Account order',
            children: [
              { type: 'callout', text: { $: 'data.reorderHint' }, tone: 'info' },
              { type: 'list', items: { $: 'data.accountItems' } },
              moveRow,
              jumpRow,
              {
                type: 'row',
                children: [
                  { type: 'actions', items: [{ label: zh ? '全选' : 'All', action: 'reorder-all', icon: 'check' }] },
                  { type: 'actions', items: [{ label: zh ? '清除' : 'Clear', action: 'reorder-clear-picks', icon: 'clear' }] },
                  { type: 'actions', items: [{ label: zh ? '完成' : 'Done', action: 'reorder-exit', icon: 'done', style: 'primary' }] },
                ],
              },
            ],
          }
        }
        return {
          type: 'stack',
          title,
          children: [
            ...(backBar === undefined ? [] : [backBar]),
            { type: 'text', text: { $: 'data.accountHeadline' }, tone: 'muted' },
            // 和模型页一样先放一排指标：三页的「固定骨架」对齐后，
            // 切换时 sheet 高度变化小，视觉上就不会跟着内容多少上下跳。
            {
              type: 'row',
              children: [
                { type: 'metric', label: zh ? '账号' : 'Accounts', value: { $: 'data.accountCount' }, tone: 'good' },
                { type: 'metric', label: zh ? '已启用' : 'Enabled', value: { $: 'data.accountEnabledCount' } },
                { type: 'metric', label: zh ? '已停用' : 'Disabled', value: { $: 'data.accountDisabledCount' }, tone: 'muted' },
              ],
            },
            { type: 'list', items: { $: 'data.accountItems' } },
            { type: 'text', text: { $: 'data.reorderNote' }, tone: 'muted' },
            { type: 'actions', items: [
              { label: zh ? '刷新列表' : 'Refresh', action: 'accounts-refresh', icon: 'refresh' },
              { label: { $: 'data.loginActionLabel' }, action: 'account-add', icon: 'add' },
            ] },
            { type: 'actions', items: [{ label: { $: 'data.reorderEnterLabel' }, action: 'reorder-enter', icon: 'list' }] },
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
          ...(backBar === undefined ? [] : [backBar]),
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
            // 已失效的条目只能看，所以给一个恢复入口：Jet Hub 的 model.clearDead
            // 会把它们从失效表里摘掉，重新出现在目录里（不算「打开」）。
            ...(g.key === 'dead' && g.expanded
              ? [{ type: 'actions', items: [{ label: zh ? '恢复全部失效模型' : 'Restore dead models', action: 'models-clear-dead', icon: 'retry', style: 'plain' }] }]
              : []),
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
          // 渠道整体开关：影响比「全部关闭模型」更大（还会停用账号），所以单独一行
          // 并带自己的确认，不和批量模型开关混在一起。
          {
            type: 'list',
            items: [{
              title: { $: 'data.providerTitle' },
              subtitle: { $: 'data.providerSubtitle' },
              trailing: { $: 'data.providerTrailing' },
              tone: { $: 'data.providerTone' },
              icon: 'plugin',
              action: 'provider-toggle-ask',
            }],
          },
          ...(providerArm ? [
            {
              type: 'callout',
              text: zh
                ? '关闭会把这条渠道的全部模型关掉、全部账号停用；打开则相反。会改变对话里能选的模型。'
                : 'Closing turns off all its models and disables all its accounts; opening reverses that. Changes what the picker offers.',
              tone: 'warn',
            },
            { type: 'confirm', id: 'provider-toggle-confirm', confirmLabel: zh ? '确认切换' : 'Confirm', cancelLabel: zh ? '取消' : 'Cancel' },
          ] : []),
          { type: 'actions', items: [{ label: zh ? '刷新' : 'Refresh', action: 'models-refresh', icon: 'refresh' }] },
          { type: 'callout', text: { $: 'data.modelNote' }, tone: { $: 'data.modelNoteTone' } },
        ],
      }
    },
    data: (scope, emit, caps) => {
      const zh = zhOf(caps?.locale)
      let alive = true

      /**
       * 「还在读取」/ 单页操作的共用字段。
       *
       * ⚠️ **必须每次都带全**：桥接是**整份替换**（不是增量合并），少一个键，
       * 那个绑定就退化成「—」。缺字段会写出两种症状：首次打开时「要等一会儿
       * 才出现」（首屏占位刚填好，中途那份「正在读取」又把它清空），以及来回
       * 切标签时数字闪成破折号再恢复。
       */
      const loadingFields = (provider) => ({
        note: '',
        modelHeadline: provider === undefined ? '' : `${labelOf(provider)} · ${provider}`,
        modelStats: [],
        modelItems: [],
        modelOnItems: [],
        modelOffItems: [],
        modelDeadItems: [],
        modelPageText: '',
        modelOnCount: '—',
        modelOffCount: '—',
        modelDeadCount: '—',
        modelGroupOnLabel: zh ? '已开启' : 'On',
        modelGroupOffLabel: zh ? '已关闭' : 'Off',
        modelGroupDeadLabel: zh ? '已失效' : 'Dead',
        modelNote: zh ? '正在读取模型…' : 'Reading models…',
        modelNoteTone: 'info',
        accountHeadline: provider === undefined ? '' : `${labelOf(provider)} · ${zh ? '账号管理' : 'Accounts'}`,
        accountCount: '—',
        accountEnabledCount: '—',
        accountDisabledCount: '—',
        accountItems: [],
        accountNote: zh ? '正在读取账号…' : 'Reading accounts…',
        accountNoteTone: 'info',
        detail: undefined,
        detailRows: [],
        // 表单初值（账号页的昵称）。
        form: { nickname: '' },
        loginActionLabel: zh ? '添加账号' : 'Add account',
        reorderHint: '',
        reorderNote: '',
        reorderEnterLabel: zh ? '调整顺序' : 'Reorder',
        // 自动签到页的字段：桥接是整份替换，不带就会被清成「—」。
        autoHeadline: zh ? '自动签到' : 'Auto check-in',
        autoItems: [],
        autoStatusText: '',
        autoStatusTone: 'info',
        autoEnabledLabel: '—',
        autoTimesLabel: '—',
        autoNote: '',
        autoNoteTone: 'info',
        ...providerFields(zh),
      })

      /**
       * 账号页的整组字段。
       *
       * `render()`（异步读完列表）和 `renderFromCache()`（切页时同步给）必须给
       * 一模一样的键：桥接是整份替换，两边各写一份必然漂移 —— 之前就出现过
       * 「缓存路径少给 detail / form，切回账号页时昵称和详情比破折号还空」。
       *
       * 顺带在这里清掉已经不存在的账号详情与幽灵勾选：两个路径都需要这个清理，
       * 而清理跟着数据走，不跟着「哪条路径先跑」走。
       */
      const accountPageFields = (accounts, provider, zh, now) => {
        const list = Array.isArray(accounts) ? accounts : []
        const ids = list.map((account) => (typeof account?.id === 'string' ? account.id : ''))
        for (const id of [...reorderSelected]) {
          if (!ids.includes(id)) reorderSelected.delete(id)
        }
        const current = r.accountDetail === undefined
          ? undefined
          : list.find((account) => account?.id === r.accountDetail)
        if (r.accountDetail !== undefined && current === undefined) {
          r.accountDetail = undefined
          r.accountRename = false
          r.accountDeleteArm = false
        }
        // 顺序即自动选号优先级，详情里的上移 / 下移要知道自己在第几位。
        const detailIndex = current === undefined ? -1 : list.indexOf(current)
        const detail = current === undefined
          ? undefined
          : buildAccountDetail(current, provider, now, zh, detailIndex === -1 ? undefined : detailIndex, list.length - 1)
        const login = loginSnapshot(zh)
        const defaultNote = detail === undefined
          ? (zh ? '点账号查看详情；停用只影响自动选号，不影响手动测试。' : 'Tap an account for details. Disabling only affects automatic selection.')
          : (zh ? '停用只影响自动选号；测试会发一次真实请求。' : 'Disabling only affects automatic selection; Test sends one real request.')
        const pickedCount = reorderSelected.size
        return {
          ...loadingFields(provider),
          ...accountCountFields(list, zh),
          accountHeadline: `${labelOf(provider)} · ${zh ? `共 ${list.length} 个账号` : `${list.length} account(s)`}`,
          accountItems: accountRowsOf(list, now, zh),
          detail,
          detailRows: detail?.rows ?? [],
          form: { nickname: detail?.nickname ?? '' },
          accountNote: login.note !== '' ? login.note : (r.accountsNote !== '' ? r.accountsNote : defaultNote),
          accountNoteTone: login.note !== '' ? login.tone : (r.accountsNote !== '' ? r.accountsNoteTone : 'info'),
          loginActionLabel: login.label,
          reorderHint: pickedCount === 0
            ? (zh
              ? '点账号勾选（可以选多个），再按下面的按钮整块挪。'
              : 'Tap accounts to select (multiple allowed), then move them as a block.')
            : (zh
              ? `已选 ${pickedCount} 个：按「上移 / 下移」一格一格挪，或一步置顶、沉底。`
              : `${pickedCount} selected: move a step up/down, or jump to top/bottom.`),
          reorderNote: list.length < 2
            ? (zh ? '只有一个账号，不用排序。' : 'Only one account; nothing to reorder.')
            : (zh ? '列表顺序就是自动选号的优先级。' : 'List order is the auto-pick priority.'),
          reorderEnterLabel: list.length < 2
            ? (zh ? '只有一个账号' : 'Only one account')
            : (zh ? '调整顺序' : 'Reorder'),
        }
      }

      /** 模型页的整组字段：底板 + 目录行，两条渲染路径共用。 */
      const modelPageFields = (models, provider, zh) =>
        ({ ...loadingFields(provider), ...modelFieldsOf(models, provider, zh) })

      const emitSkeleton = () => {
        const provider = r.activeProvider(scope)
        const tab = r.manageTab === 'accounts' ? 'accounts' : 'models'
        emit({
          panelTitle: provider === undefined
            ? (zh ? '模型与账号' : 'Models & accounts')
            : `${labelOf(provider)} · ${zh ? '模型与账号' : 'Models & accounts'}`,
          tab,
          ...loadingFields(provider),
        })
      }

      /**
       * 首页的四个入口。
       *
       * 这里只给 `panelTitle` 与 `tab`：选项本身写死在视图里（见上面 home 分支的
       * 说明），再往 data 里推一份 `homeItems` 没有任何绑定会读，纯属重复。
       */
      const homeFields = (zh) => ({
        panelTitle: zh ? '管理' : 'Manage',
        tab: 'home',
      })

      /**
       * 切标签专用的**同步**渲染：只用已经缓存的列表，不发任何 IO。
       *
       * 为什么需要它：`render()` 是 async 的（要读盘、要打 Jet Hub），从「点了
       * 按钮」到「新数据推上去」之间隔着好几次 await，这段时间画面还是旧页，
       * 等数据到了再整页换掉 —— 观感就是「切换时闪一下、不跟手」。
       * 有缓存时直接同步推一份，界面立刻就是新页；没缓存才退回异步读取。
       */
      const renderFromCache = () => {
        if (r.manageTab === 'auto') {
          const cached = autoSection.peek(zh)
          if (cached === undefined) return false
          emit({ panelTitle: zh ? '自动签到' : 'Auto check-in', tab: 'auto', ...loadingFields(undefined), ...cached, autoItems: cached.autoItems ?? [] })
          return true
        }
        if (r.manageTab === 'host') {
          const cached = hostSection.peek(zh)
          if (cached === undefined) return false
          emit({ panelTitle: zh ? '主机设置' : 'Host settings', tab: 'host', ...loadingFields(undefined), ...cached })
          return true
        }
        if (r.manageTab === 'home') {
          emit({ ...homeFields(zh), ...loadingFields(undefined) })
          return true
        }
        const provider = r.activeProvider(scope)
        const tab = r.manageTab === 'accounts' ? 'accounts' : 'models'
        const shared = {
          panelTitle: provider === undefined
            ? (zh ? '模型与账号' : 'Models & accounts')
            : `${labelOf(provider)} · ${zh ? '模型与账号' : 'Models & accounts'}`,
          tab,
        }
        if (provider === undefined) {
          // 两个页面的构建器各自会铺 loadingFields，这个兜底分支要自己铺。
          emit({ ...shared, ...loadingFields(undefined), note: zh ? '先在渠道余额面板选一个具体渠道，再点「管理」。' : 'Pick a channel first.' })
          return true
        }
        if (tab === 'accounts') {
          const hit = r.accountsCache.get(provider)
          if (hit === undefined) return false
          emit({ ...shared, ...accountPageFields(hit.value?.accounts, provider, zh, Date.now()) })
          return true
        }
        const hit = r.modelsCache.get(provider)
        if (hit === undefined) return false
        emit({ ...shared, ...modelFieldsOf(hit.value?.models, provider, zh) })
        return true
      }

      const render = async (force = false) => {
        // 自动签到页：状态在内存里现成。
        if (r.manageTab === 'auto') {
          const autoBase = { panelTitle: zh ? '自动签到' : 'Auto check-in', tab: 'auto', ...loadingFields(undefined) }
          await autoSection.data(emit, zh, force, autoBase)
          return
        }
        // 主机页：状态在内存里现成，同步给。
        if (r.manageTab === 'host') {
          const hostBase = { panelTitle: zh ? '主机设置' : 'Host settings', tab: 'host', ...loadingFields(undefined) }
          const cached = hostSection.peek(zh)
          if (cached !== undefined) emit({ ...hostBase, ...cached })
          await hostSection.data((patch) => emit({ ...hostBase, ...patch }), zh, force)
          return
        }
        // 首页：只有三个选项，不读任何数据，直接同步给。
        if (r.manageTab === 'home') {
          emit({ ...homeFields(zh), ...loadingFields(undefined) })
          return
        }
        // 读盘只影响「默认选哪个渠道」；已经读过就不要再等它，否则每次切页
        // 都要多一次异步跳跃，画面会先停在旧数据上闪一下。
        await r.stateReady
        const provider = r.activeProvider(scope)
        if (provider === undefined) {
          emit({
            panelTitle: zh ? '模型与账号' : 'Models & accounts',
            tab: r.manageTab,
            note: zh
              ? '先在渠道余额面板选一个具体渠道，再点「管理」。'
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
          // 渠道开关的确认框和读数都跟着渠道走：不在这里清，换渠道后点「确认」
          // 会把上一个渠道的意图作用到新渠道上。
          providerArm = false
          providerState = undefined
          reorderMode = false
          reorderSelected = new Set()
        }
        const tab = r.manageTab === 'accounts' ? 'accounts' : 'models'
        const base = {
          panelTitle: `${labelOf(provider)} · ${zh ? '模型与账号' : 'Models & accounts'}`,
          tab,
        }

        if (tab === 'accounts') {
          // 冷启动时不再先发一帧「正在读取」：那会让画面出现
          // 「旧页 → 空列表 → 真实列表」的三帧跳变（切出主机页时最明显）。
          // 现在等列表到手后一次发全；这段等待由 App 的加载指示覆盖。
          let value
          try {
            value = await r.readAccountsOf(provider, force)
          } catch {
            if (!alive) return
            r.manageAccountCount = null
            const login = loginSnapshot(zh)
            emit({
              ...base,
              ...loadingFields(provider),
              accountNote: login.note !== '' ? login.note : (zh ? '读不到账号列表；这个渠道可能没有账号池。' : 'Cannot read the account list.'),
              accountNoteTone: login.note !== '' ? login.tone : 'warn',
              loginActionLabel: login.label,
            })
            return
          }
          if (!alive) return
          r.manageAccountCount = Array.isArray(value?.accounts) ? value.accounts.length : 0
          emit({ ...base, ...accountPageFields(value?.accounts, provider, zh, Date.now()) })
          return
        }

        let value
        try {
          value = await r.readModelsOf(provider, force)
        } catch {
          if (!alive) return
          r.manageModelCount = null
          emit({
            ...base,
            ...loadingFields(provider),
            modelNote: zh
              ? '读不到模型列表；这个渠道可能没有可切换的模型目录。'
              : 'Cannot read the model list; this channel may have no catalog.',
            modelNoteTone: 'warn',
          })
          return
        }
        if (!alive) return
        const models = Array.isArray(value?.models) ? value.models : []
        r.manageModelCount = { enabled: models.filter((m) => m?.dead !== true && m?.disabled !== true).length, total: models.length }
        // 渠道整体状态单独读一次：provider.status 只用内存副本，代价可忽略，
        // 但它和 model.list 的口径不同（含「关闭整个渠道」的意图），不能拿模型计数顶替。
        providerState = await readProviderStatus(ctx, [provider])
          .then((value) => value?.statuses?.[provider])
          .catch(() => undefined)
        // 行与字段的构建与「切换标签的同步渲染」共用一份（见 modelPageFields）。
        emit({ ...base, ...modelPageFields(models, provider, zh) })
      }
      // 切页时 actions 需要「改状态 + 同步重画」，而这两样都在 data 的闭包里：
      // 通过 runtime 上这两个槽位把能力接出去，注销时清掉。
      r.renderManageFromCache = renderFromCache
      r.enterManagePage = (value) => {
        if (!['home', 'models', 'accounts', 'host', 'auto'].includes(value)) return false
        if (value === r.manageTab) return true
        r.manageTab = value
        r.accountDetail = undefined
        r.accountRename = false
        r.accountDeleteArm = false
        r.modelsBulkArm = false
        providerArm = false
        reorderMode = false
        reorderSelected = new Set()
        // 有缓存就同步推新页，一帧到位；没缓存才退回异步读取。
        if (!renderFromCache()) kickAll(r.manageKicks)
        return true
      }

      // 有缓存就直接同步推真实数据，一帧到位。
      //
      // 没缓存时才需要一份骨架（App 只等 1 秒就要首屏数据）。但骨架**只在这次
      // 订阅的第一帧发**：中途切页（tab 从别处切过来）不该再冒出一帧空的 ——
      // 那正是「从主机切到另两页会闪一下」的来源（列表页要先读一次才有数据）。
      let skeletonSent = false
      const firstPaint = () => {
        if (renderFromCache()) return
        if (!skeletonSent) {
          skeletonSent = true
          emitSkeleton()
        }
        void render()
      }
      firstPaint()
      // 切标签只重画当前页；两个强制 kick 只在对应标签页上才真的重读，
      // 免得模型面板刷一下顺手把账号列表也拉一遍。
      const kick = () => void render(false)
      const modelsKick = () => {
        if (r.manageTab === 'models') void render(true)
      }
      const accountsKick = () => {
        if (r.manageTab === 'accounts') void render(true)
      }
      const hostKick = () => {
        if (r.manageTab === 'host') void render(true)
      }
      hostSection.kicks.add(hostKick)
      const autoKick = () => {
        if (r.manageTab === 'auto') void render(true)
      }
      autoSection.kicks.add(autoKick)
      r.manageKicks.add(kick)
      r.modelKicks.add(modelsKick)
      r.accountKicks.add(accountsKick)
      return () => {
        alive = false
        // 面板关掉时把页面层级复位：下次打开从首页开始。
        //
        // 不复位的话，上次停在「模型开关」那一页，重开时视图走内容页分支、
        // 而 data 又要等一次读取才给值，中间那段就是空屏（看起来像「只能打开
        // 一次，之后就一直打不开」）。
        r.manageTab = 'home'
        if (r.renderManageFromCache === renderFromCache) r.renderManageFromCache = undefined
        r.enterManagePage = undefined
        r.manageKicks.delete(kick)
        r.modelKicks.delete(modelsKick)
        r.accountKicks.delete(accountsKick)
        hostSection.kicks.delete(hostKick)
        autoSection.kicks.delete(autoKick)
      }
    },
    actions: {
      // 主机那一页的开关动作（只改全局开关，跟渠道无关）。
      ...hostSection.actions,
      ...autoSection.actions,
      /** 内容页 → 首页。 */
      'manage-home': () => {
        if (r.enterManagePage?.('home') !== true) kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      /** 首页 → 某一项（模型 / 账号）。 */
      'manage-tab': (_scope, event) => {
        const value = event?.value?.tab ?? event?.value?.value
        if (r.enterManagePage?.(value) !== true) kickAll(r.manageKicks)
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
        r.modelsOpenGroup = nextOpenGroup(r.modelsOpenGroup, group)
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      /** 渠道整体开关：先亮确认（会连带停用账号，比模型批量开关更重）。 */
      'provider-toggle-ask': () => {
        providerArm = true
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'provider-toggle-confirm': (scope, event) => {
        const zh = zhOf(event?.locale)
        providerArm = false
        if (event?.value?.confirmed !== true) {
          kickAll(r.manageKicks)
          return [{ refresh: 'manage' }, { toast: zh ? '已取消' : 'Cancelled' }]
        }
        const provider = currentProviderForAction(scope)
        if (provider === undefined) return [{ toast: zh ? '没认出这个渠道' : 'Unknown channel' }]
        // 当前是「已关闭」就打开，否则关闭。状态读不到时按「打开」走：
        // 打开方向不读目录、不会失败，而误关整条渠道的代价大得多。
        const next = providerState?.closed === true
        return {
          pending: {
            label: next ? (zh ? '正在打开渠道' : 'Opening channel') : (zh ? '正在关闭渠道' : 'Closing channel'),
            timeoutMs: 60_000,
          },
          result: async () => {
            try {
              // Jet Hub 回的是 { provider, enabled, models, accounts }：后两个是
              // 实际动到的条数，拿来说清楚「关了/开了多少」，比一句「已切换」有用。
              const value = await setProviderEnabled(ctx, provider, next)
              const modelsTouched = Number(value?.models) || 0
              const accountsTouched = Number(value?.accounts) || 0
              // 模型黑名单和账号启停都变了：两种缓存都要清，界面不能停在旧状态。
              r.modelsCache.delete(provider)
              r.accountsCache.delete(provider)
              r.accountDetail = undefined
              providerState = undefined
              r.accountsNote = next
                ? (zh ? `渠道已整体打开：${modelsTouched} 个模型、${accountsTouched} 个账号已启用。`
                  : `Channel opened: ${modelsTouched} models and ${accountsTouched} accounts enabled.`)
                : (zh ? `渠道已整体关闭：${modelsTouched} 个模型关闭、${accountsTouched} 个账号停用。`
                  : `Channel closed: ${modelsTouched} models off, ${accountsTouched} accounts disabled.`)
              r.accountsNoteTone = 'info'
              r.modelsNote = ''
              kickAll(r.modelKicks)
              kickAll(r.accountKicks)
              kickAll(r.manageKicks)
              return { toast: next ? (zh ? '渠道已打开' : 'Channel opened') : (zh ? '渠道已关闭' : 'Channel closed') }
            } catch (error) {
              // 关闭方向要先读模型目录，读不到就整体失败 —— 这时什么都没写。
              r.modelsNote = zh ? `渠道开关失败：${briefError(error)}` : `Channel switch failed: ${briefError(error)}`
              kickAll(r.modelKicks)
              kickAll(r.manageKicks)
              return { toast: zh ? '渠道开关失败' : 'Channel switch failed' }
            }
          },
        }
      },
      /**
       * 恢复全部「已失效」模型。
       *
       * 这些条目是 Jet Hub 从上游目录里摘掉的（不是用户关的），不恢复就永远
       * 不会再出现在列表里，用户也没有别的入口能救回来。
       */
      'models-clear-dead': (scope, event) => {
        const zh = zhOf(event?.locale)
        const provider = currentProviderForAction(scope)
        if (provider === undefined) return [{ toast: zh ? '没认出这个渠道' : 'Unknown channel' }]
        return {
          pending: { label: zh ? '正在恢复' : 'Restoring', timeoutMs: 20_000 },
          result: async () => {
            try {
              const value = await clearDeadModel(ctx, provider)
              r.modelsCache.delete(provider)
              const left = Array.isArray(value?.deadModels) ? value.deadModels.length : 0
              r.modelsNote = left > 0
                ? (zh ? `还有 ${left} 个模型没恢复，点一次刷新再试。` : `${left} model(s) still dead; refresh and retry.`)
                : (zh ? '已恢复全部失效模型。' : 'All dead models restored.')
            } catch (error) {
              r.modelsNote = zh ? `恢复失败：${briefError(error)}` : `Restore failed: ${briefError(error)}`
            }
            kickAll(r.modelKicks)
            return { toast: zh ? '已恢复' : 'Restored' }
          },
        }
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
      /**
       * 进排序页。列表页和详情页共用这一个入口（两个视图里的按钮都指向它）。
       *
       * 必须顺带关掉详情页：详情分支排在排序页之前，不关的话点了「调整顺序」
       * 界面不会变，用户会以为按钮坏了。
       */
      'reorder-enter': () => {
        r.accountDetail = undefined
        r.accountRename = false
        r.accountDeleteArm = false
        reorderMode = true
        reorderSelected = new Set()
        r.accountsNote = ''
        r.accountsNoteTone = 'info'
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'reorder-exit': () => {
        reorderMode = false
        reorderSelected = new Set()
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      /**
       * 点一行 = 勾选 / 取消勾选。可以连着点好几行，一次挪一批。
       *
       * ⚠️ 必须同时 kick 数据推送（不只是 refresh 视图）：勾选态、序号、提示文案
       * 都是 data emit 出来的绑定值，光重取视图会拿到上一份数据，界面看起来没反应。
       * kick 走的是 render(false)（读缓存），不会因此打一次账号列表。
       */
      'reorder-toggle': (_scope, event) => {
        const id = typeof event?.value?.account === 'string' ? event.value.account : ''
        if (id === '') return []
        if (reorderSelected.has(id)) reorderSelected.delete(id)
        else reorderSelected.add(id)
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'reorder-all': (scope) => {
        const provider = currentProviderForAction(scope)
        const accounts = provider === undefined ? undefined : r.accountsCache.get(provider)?.value?.accounts
        if (!Array.isArray(accounts)) return []
        reorderSelected = new Set(accounts.map((account) => account?.id).filter((id) => typeof id === 'string' && id !== ''))
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'reorder-clear-picks': () => {
        reorderSelected = new Set()
        kickAll(r.manageKicks)
        return [{ refresh: 'manage' }]
      },
      'reorder-up': (scope, event) => moveSelectedBlock(scope, event, 'up'),
      'reorder-down': (scope, event) => moveSelectedBlock(scope, event, 'down'),
      'reorder-top': (scope, event) => moveSelectedBlock(scope, event, 'top'),
      'reorder-bottom': (scope, event) => moveSelectedBlock(scope, event, 'bottom'),
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
