// 一键签到的纯格式化：把 `credits.claimAll` 的结果压成面板里的一两句人话。
//
// 上游的 summary 是按**账号**计数的（一个渠道可能有多个账号），而面板只有一行
// 位置，所以这里合并成「渠道 + 结果」，失败原因只留第一条、且截短。
// 没有网络、没有状态，纯函数 —— 单测覆盖。

/**
 * 渠道明确说自己没有签到能力。
 *
 * 上游有两种措辞：登记了 `claimUnavailableReason` 的（Cline / Raccoon / WorkBuddy
 * 国际版，形如「X 不支持每日签到（…）」）和没登记的（`unsupported provider: X`）。
 * 两者都**不算失败** —— 用户看到「失败」会以为是自己账号坏了。
 */
const UNSUPPORTED_RE = /不支持每日签到|unsupported provider/i

export const isUnsupportedCheckin = (message) => UNSUPPORTED_RE.test(String(message ?? ''))

/** 数字别把浮点噪声摆到界面上。 */
const num = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

const ONE_LINE = /\s+/g

/** 失败原因：取第一条可读消息，压成一行、截短。 */
function failReason(results) {
  for (const item of Array.isArray(results) ? results : []) {
    const outcome = item?.outcome
    if (outcome?.kind !== 'failed') continue
    const message = String(outcome.message ?? '').replace(ONE_LINE, ' ').trim()
    if (message !== '') return message.length > 28 ? `${message.slice(0, 27)}…` : message
  }
  return ''
}

/**
 * 一个渠道的 claimAll 结果 → 一句短话。
 *
 * 没有任何可说的（无账号、全部跳过）时返回空串，调用方不会把它拼进结果。
 */
export function claimLine(label, value, zh) {
  const summary = value?.summary ?? {}
  const claimed = num(summary.claimed)
  const already = num(summary.alreadyClaimed)
  const inactive = num(summary.inactive)
  const failed = num(summary.failed)
  const bits = []
  if (claimed > 0) {
    const byUnit = summary.totalByUnit ?? { credit: summary.totalCredit, token: 0 }
    const credit = num(byUnit?.credit)
    const token = num(byUnit?.token)
    const gains = []
    if (credit > 0) gains.push(`${credit} ${zh ? '积分' : 'credits'}`)
    if (token > 0) gains.push(`${token} tokens`)
    bits.push(gains.length > 0
      ? `${zh ? '领到 ' : '+'}${gains.join(' + ')}`
      : (zh ? `${claimed} 个账号签到成功` : `${claimed} checked in`))
  }
  if (already > 0) bits.push(zh ? '今日已领' : 'already claimed')
  if (inactive > 0) bits.push(zh ? '暂无活动' : 'no campaign')
  if (failed > 0) {
    const reason = failReason(value?.results)
    bits.push(zh
      ? `失败${reason === '' ? '' : `（${reason}）`}`
      : `failed${reason === '' ? '' : ` (${reason})`}`)
  }
  return bits.length === 0 ? '' : `${label} ${bits.join('，')}`
}

/**
 * 整轮签到的一句话。`total` 是尝试过的渠道数；全部不支持时要说清楚，
 * 否则「签到完成」后面空着会让人以为按钮没反应。
 */
export function checkinSummary(parts, unsupported, total, zh) {
  if (parts.length === 0) {
    if (total <= 0) return zh ? '没有可签到的渠道。' : 'No channel to check in.'
    if (unsupported >= total) return zh ? '当前渠道都没有签到功能。' : 'None of these channels supports check-in.'
    return zh ? '签到完成：今天都已经领过了。' : 'Done: everything was already claimed today.'
  }
  const full = `${zh ? '签到完成：' : 'Done: '}${parts.join(zh ? '，' : '; ')}`
  return full.length > 160 ? `${full.slice(0, 159)}…` : full
}

/** 进行中的一行。`done` 是已完成的渠道数，当前正在签的是下一个。 */
export function progressLine(done, total, label, zh) {
  if (total <= 0) return zh ? '正在查找可签到的渠道…' : 'Looking for channels…'
  const current = Math.min(done + 1, total)
  const at = label === '' ? '' : `：${label}`
  return zh ? `正在签到 ${current}/${total}${at}` : `Checking in ${current}/${total}${at}`
}

/**
 * 一个时刻 → 「09:00」或「11-08 21:00」。
 *
 * 同一天只给时刻，隔天才带日期 —— 面板只有一行位置，「今天 09:00」里的
 * 「今天」纯属占位，而跨天的结果不写日期会让人以为是刚才跑的。
 */
export function whenLabel(ms, now) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const when = new Date(n)
  const today = new Date(Number.isFinite(Number(now)) ? Number(now) : Date.now())
  const hh = String(when.getHours()).padStart(2, '0')
  const mm = String(when.getMinutes()).padStart(2, '0')
  const sameDay = when.getFullYear() === today.getFullYear()
    && when.getMonth() === today.getMonth()
    && when.getDate() === today.getDate()
  if (sameDay) return `${hh}:${mm}`
  const mo = String(when.getMonth() + 1).padStart(2, '0')
  const dd = String(when.getDate()).padStart(2, '0')
  // 两种语言都写 `MM-DD HH:MM`（中文里的「11-08 21:00」也是这个写法）。
  return `${mo}-${dd} ${hh}:${mm}`
}

/**
 * 自动签到的逐渠道结果 → list 行。
 *
 * 文案由宿主（Jet Hub 的 `describeChannel`）给，这里**不改写**：那套文案区分
 * 「领到 +200」/「今天已领」/「未开启」/「本轮已处理」，插件再翻译一遍必然
 * 与上游漂移。只补渠道名、按结果给个语气。
 */
export function channelRows(channels, labelOf, zh) {
  const rows = []
  for (const item of Array.isArray(channels) ? channels : []) {
    const provider = typeof item?.provider === 'string' ? item.provider : ''
    const text = typeof item?.text === 'string' ? item.text : ''
    if (provider === '' || text === '') continue
    // 「本轮已处理」是宿主的内部用语，对用户等于「这个渠道这个时段处理过了」。
    const shown = text === '本轮已处理' ? (zh ? '已处理' : 'done') : text
    let tone
    if (text.includes('+')) tone = 'good'
    else if (/出错|失败/.test(text)) tone = 'warn'
    else if (/无签到接口|需手动/.test(text)) tone = 'muted'
    rows.push({
      title: typeof labelOf === 'function' ? labelOf(provider) : provider,
      trailing: shown,
      icon: 'check',
      ...(tone === undefined ? {} : { tone }),
    })
  }
  return rows
}

/**
 * 一句话说清这一轮到底做了什么。
 *
 * 宿主的 `lastResult` 已经是一句人话（「1 个渠道：2 个账号领取成功（+200积分）…」），
 * 直接用它；没有结果时按状态给「还没跑过 / 正在跑」。
 */
export function runSummary(state, zh) {
  if (state === undefined) return zh ? '读不到上次结果。' : 'No result available.'
  if (state?.running === true) return zh ? '正在签到…' : 'Running…'
  const last = typeof state?.lastResult === 'string' ? state.lastResult.trim() : ''
  if (last !== '') return last.length > 120 ? `${last.slice(0, 119)}…` : last
  return state?.ranToday === true
    ? (zh ? '今天已跑过，还没有结果记录。' : 'Ran today; no result recorded.')
    : (zh ? '还没有跑过。' : 'Not run yet.')
}
