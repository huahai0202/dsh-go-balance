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
