// 账号页与模型页的**纯展示逻辑**：把上游数据摊成面板字段。
//
// 这里没有任何 IO、定时器或模块级可变状态 —— 全部是「输入数据 + 语言 → 字段」。
// 拆出来的两个理由：
// 1. 这些函数被「异步读完后的完整渲染」和「切页时的同步渲染」共用，两处各写
//    一遍必然漂移（历史上漂过：缓存路径少给 detail / form）；
// 2. 纯函数能直接单测。`accountStatus` 的脏值判据（Infinity 被当成「已封禁」）
//    就是靠能直接喂数据才发现的。

import { labelOf } from '../labels.js'
import { MAX_DATE_MS, isMomentMs } from '../util.js'

/**
 * 时刻 → `MM/DD HH:mm`（本地时区）。
 *
 * 读不出（缺字段、`Infinity`、超出 `Date` 范围）时给空串，让调用方决定写
 * 「未知」还是「无」—— 这两者对用户是不同的事实。
 */
export function fmtWhen(ms, locale = 'zh-CN') {
  if (!isMomentMs(ms) || ms > MAX_DATE_MS) return ''
  try {
    return new Date(ms).toLocaleString(locale, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/** 账号显示名：昵称 → 账号名 → id，绝不返回空串。 */
export function nicknameOf(account) {
  if (typeof account?.nickname === 'string' && account.nickname !== '') return account.nickname
  if (typeof account?.accountName === 'string' && account.accountName !== '') return account.accountName
  return typeof account?.id === 'string' ? account.id : ''
}

/** 还没过期的限流时刻（列表用，已过期的标记不算「限流中」）。 */
export function futureLimitsOf(account, now) {
  const limits = account?.modelRateLimits
  if (limits === null || typeof limits !== 'object') return []
  return Object.values(limits).filter((ms) => isMomentMs(ms) && ms > now)
}

/**
 * 账号状态：封禁 > 停用 > 过期 > 限流 > 正常。
 *
 * ⚠️ 判据用 `isMomentMs`，不是 `Number(x) > 0`：后者会让 `Infinity` 通过，
 * 账号就永远显示成「已封禁」或「限流中」。
 */
export function accountStatus(account, now, zh) {
  if (isMomentMs(account?.policyBlockedAtMs)) return { label: zh ? '已封禁' : 'Blocked', tone: 'warn' }
  if (account?.enabled === false) return { label: zh ? '已停用' : 'Disabled', tone: 'muted' }
  const expiresAt = account?.expiresAt
  if (isMomentMs(expiresAt) && expiresAt <= now) return { label: zh ? '已过期' : 'Expired', tone: 'warn' }
  if (futureLimitsOf(account, now).length > 0) return { label: zh ? '限流中' : 'Rate limited', tone: 'warn' }
  return { label: zh ? '正常' : 'OK', tone: 'good' }
}

/** 账号页顶部那排指标：总数 / 启用 / 停用。 */
export function accountCountFields(accounts, zh) {
  const list = Array.isArray(accounts) ? accounts : []
  const enabled = list.filter((account) => account?.enabled !== false).length
  return {
    accountCount: String(list.length),
    accountEnabledCount: String(enabled),
    accountDisabledCount: String(list.length - enabled),
  }
}

/**
 * 账号列表 → list 行。
 *
 * `reorderMode` 为真时是排序页的形态：序号 + 勾选态 + 点行即切换勾选。
 * 勾选集合由调用方传入（本模块不持有状态）。
 */
export function accountRowsOf(accounts, now, zh, reorderMode = false, selected = new Set()) {
  return (Array.isArray(accounts) ? accounts : []).map((account, index) => {
    const id = typeof account?.id === 'string' ? account.id : ''
    const nickname = nicknameOf(account)
    const status = accountStatus(account, now, zh)
    if (reorderMode) {
      const picked = selected.has(id)
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

/**
 * 账号详情：列表只给状态，这里把各项摊开。
 *
 * `position` 是它在列表里的下标（排序页要显示「第 N 位」），省略则不写这一行。
 */
export function buildAccountDetail(account, provider, now, zh, position) {
  const id = typeof account?.id === 'string' ? account.id : ''
  const nickname = nicknameOf(account)
  const status = accountStatus(account, now, zh)
  const expiresAt = account?.expiresAt
  // 「无」与「未知」的区别：
  // - 没有可用的到期时刻（缺字段 / 脏值）→「无」；
  // - ⚠️ 不再区分「有值但格式化不出」：`isMomentMs` 与 `fmtWhen` 的判据是同一套
  //   （有限、>0、不超 `Date` 范围），凡通过前者的值后者一定格式化得出来 ——
  //   那个「未知」分支是**不可达的死代码**，写在那儿只会让人以为存在第三种状态。
  const expiryText = fmtWhen(expiresAt) || (zh ? '无' : 'none')
  const futureLimits = futureLimitsOf(account, now)
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
  if (isMomentMs(account?.policyBlockedAtMs)) {
    const reason = typeof account?.policyBlockedMessage === 'string' && account.policyBlockedMessage !== ''
      ? account.policyBlockedMessage.slice(0, 80)
      : (zh ? '上游标记' : 'upstream flag')
    rows.push([zh ? '封禁原因' : 'Blocked', reason])
  }
  if (futureLimits.length > 0) {
    const nearest = Math.min(...futureLimits)
    rows.push([zh ? '限流' : 'Rate limit', zh
      ? `${futureLimits.length} 个模型，最近 ${fmtWhen(nearest)}`
      : `${futureLimits.length} model(s), until ${fmtWhen(nearest)}`])
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
 * 渠道整体开关的三件套字段。
 *
 * `state` 读不到时按「未知」渲染（`—` + warn），**不要**用「已开启」顶替 ——
 * 那会让用户以为渠道是好的。
 */
export function providerFields(state, zh) {
  const title = zh ? '整条渠道' : 'Whole channel'
  if (state === undefined) {
    return {
      providerTitle: title,
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
    providerTitle: title,
    providerSubtitle: zh
      ? `${off}/${total} 个模型关闭 · ${accountsOn}/${accountsTotal} 个账号启用`
      : `${off}/${total} models off · ${accountsOn}/${accountsTotal} accounts on`,
    providerTrailing: closed ? (zh ? '已关闭' : 'closed') : (zh ? '已开启' : 'on'),
    providerTone: closed ? 'muted' : 'good',
  }
}

/**
 * 模型目录 → 模型页的分组行与计数。
 *
 * 返回 `{ rows: { on, off, dead }, fields }`：`rows` 的三个计数由调用方存进
 * 自己的快照（视图是同步的，要靠它决定「画哪几组」），`fields` 直接进 emit。
 */
export function modelFieldsOf(models, provider, zh, note = '') {
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
    // 模型名和 id 不同时才把 id 附在第二行：同名时再写一遍纯属噪音。
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
  const pageNote = note !== ''
    ? note
    : list.length === 0
      ? (zh ? '这个渠道没有可开关的模型。' : 'No models to switch.')
      : (zh ? '点一行开 / 关模型；标「已失效」的条目只能看。' : 'Tap a row to toggle it; dead models are read-only.')
  return {
    rows: { on: onRows.length, off: offRows.length, dead: deadRows.length },
    fields: {
      modelHeadline: provider === undefined ? '' : `${labelOf(provider)} · ${provider}`,
      // ⚠️ 不再给 `modelStats` / `modelItems`：视图从来没绑过它们（顶部三档指标
      // 读的是 modelOnCount 那三个，列表读的是按组拆开的 modelOnItems）。
      // 留着只是每次渲染多算一遍 `list.map(rowOf)`。
      modelOnCount: String(enabled),
      modelOffCount: String(off),
      modelDeadCount: String(dead),
      // 分组标题带计数：这一页一次只展开一组，标题上没数字就不知道另一组有多少。
      modelGroupOnLabel: zh ? `已开启 ${enabled}` : `On ${enabled}`,
      modelGroupOffLabel: zh ? `已关闭 ${off}` : `Off ${off}`,
      modelGroupDeadLabel: zh ? `已失效 ${dead}` : `Dead ${dead}`,
      modelOnItems: onRows,
      modelOffItems: offRows,
      modelDeadItems: deadRows,
      modelPageText: list.length === 0 ? '' : (zh ? `共 ${list.length} 个模型` : `${list.length} models`),
      modelNote: pageNote,
      modelNoteTone: note === '' ? 'info' : 'warn',
    },
  }
}
