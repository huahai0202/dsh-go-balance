// 余额分档：把 Jet Hub `usage.badge` 返回的 `accounts[].balance.packages[]`
// 拆成「临期 / 长期 / 永久 / 已过期 / 独立池」五桶。
//
// 这一层是纯函数：不碰 ctx、不发请求、不读文件，方便单测（见 test/split.test.mjs）。
// 判据与 Jet Hub 客户端的 `splitCreditsByExpiry` 逐条对齐，保证本插件显示的三档
// 和 App 里 Jet Hub 面板说的是同一件事。

import { EXCLUSIVE_POOL_MARK } from './labels.js'

export const DAY_MS = 86_400_000

/** 响应里的临期窗口天数；缺失 / 非法一律返回 null（= 该渠道不分档）。 */
export function normalizeWindowDays(windowDays) {
  if (windowDays === undefined || windowDays === null || windowDays === '') return null
  const parsed = Number(windowDays)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** 单个资源包能扣到的最晚时刻：优先扣费截止，其次 ExpiredTime。取不到返回 null。 */
export function packageExpiryMs(pkg) {
  const raw = pkg?.deductionEndTime
  const deductionEnd = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
  if (Number.isFinite(deductionEnd) && deductionEnd > 0) return deductionEnd
  const expiredTime = typeof pkg?.expiredTime === 'string' ? pkg.expiredTime : ''
  if (expiredTime === '') return null
  const parsed = Date.parse(expiredTime.replace(' ', 'T'))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * 把一组资源包拆成五桶。
 *
 * - 非 `active` 的包跳过（服务端仍会下发失效包的余额，算进去会虚高）；
 * - 到期时间未知的包进永久桶；带 `expiringRemaining` 的按它拆一部分进临期；
 * - 距今 < 窗口天数算临期，≥ 窗口算长期，时刻已过算已过期；
 * - 名字含「独立池」的不进任何一档，单独累计。
 */
export function splitByExpiry(packages, windowDays, now) {
  const windowMs = windowDays * DAY_MS
  const split = {
    windowDays,
    expiring: 0,
    longTerm: 0,
    permanent: 0,
    expired: 0,
    exclusive: 0,
    earliestExpiringAt: undefined,
    earliestExpiringAmount: 0,
  }
  for (const pkg of packages) {
    if (pkg === null || pkg === undefined || pkg.active !== true) continue
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    const poolName = typeof pkg.name === 'string' ? pkg.name : ''
    if (poolName.includes(EXCLUSIVE_POOL_MARK)) {
      split.exclusive += remaining
      continue
    }
    const end = packageExpiryMs(pkg)
    if (end === null) {
      const expiringPart = Number(pkg.expiringRemaining)
      if (Number.isFinite(expiringPart) && expiringPart > 0) {
        const capped = Math.min(expiringPart, remaining)
        split.expiring += capped
        split.permanent += remaining - capped
        // 上游只给了「其中 N 即将到期」的标量、没有逐笔日期 ⇒ 不给倒计时，
        // 否则「最早 X 天后到期」会变成编造出来的数字。
      } else {
        split.permanent += remaining
      }
      continue
    }
    if (end <= now) {
      split.expired += remaining
      continue
    }
    if (end - now < windowMs) {
      split.expiring += remaining
      if (split.earliestExpiringAt === undefined || end < split.earliestExpiringAt) {
        split.earliestExpiringAt = end
        split.earliestExpiringAmount = remaining
      } else if (end === split.earliestExpiringAt) {
        split.earliestExpiringAmount += remaining
      }
    } else {
      split.longTerm += remaining
    }
  }
  return split
}

/** 把多个账号的五桶累加成一份。 */
export function mergeSplits(splits) {
  const total = {
    windowDays: splits[0]?.windowDays,
    expiring: 0,
    longTerm: 0,
    permanent: 0,
    expired: 0,
    exclusive: 0,
    earliestExpiringAt: undefined,
    earliestExpiringAmount: 0,
  }
  for (const split of splits) {
    total.expiring += split.expiring
    total.longTerm += split.longTerm
    total.permanent += split.permanent
    total.expired += split.expired
    total.exclusive += split.exclusive
    const at = split.earliestExpiringAt
    if (at === undefined) continue
    if (total.earliestExpiringAt === undefined || at < total.earliestExpiringAt) {
      total.earliestExpiringAt = at
      total.earliestExpiringAmount = split.earliestExpiringAmount
    } else if (at === total.earliestExpiringAt) {
      total.earliestExpiringAmount += split.earliestExpiringAmount
    }
  }
  return total
}

/** 积分金额：最多两位小数，去掉尾随 0（同一屏并列的几档必须用同一套位数）。 */
export function fmtAmount(n) {
  if (!Number.isFinite(n)) return '—'
  return String(Math.round(n * 100) / 100)
}

/** 到期时刻写成 `MM/DD HH:mm`（本地时区），给面板的逐笔列表用。 */
export function fmtExpiry(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const d = new Date(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 把一组积分包里**每一份**带到期时间的列出来，最早到期的排前面。
 *
 * 面板上的「临期 510」其实是好几笔各自到期的签到包，只报合计会让人以为
 * 一起作废；这里如实给逐笔明细。没有到期时间的包（永久）不进这个列表，
 * 它们由「永久」那一档单独表示。
 *
 * `expiring` 表示是否落在临期窗口内，`days` 是距截止的整天数（floor，
 * 和临期档的定义保持自洽）。
 */
export function listExpiring(packages, windowDays, now, zh) {
  const windowMs = windowDays * DAY_MS
  const out = []
  for (const pkg of Array.isArray(packages) ? packages : []) {
    if (pkg === null || pkg === undefined || pkg.active !== true) continue
    const remaining = Number(pkg.remaining)
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    const at = packageExpiryMs(pkg)
    if (at === null || at <= now) continue
    out.push({
      at,
      remaining,
      name: typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : (zh ? '积分包' : 'credits'),
      expiring: at - now < windowMs,
    })
  }
  out.sort((a, b) => a.at - b.at)
  return out.map((item) => ({
    ...item,
    expiry: fmtExpiry(item.at),
    days: Math.floor((item.at - now) / DAY_MS),
  }))
}

/**
 * 临期里最早到期的那笔什么时候到。
 *
 * ⚠️ 不再用于指标卡的副标题（那里只写「N 天内」）：具体日期由下面可展开的
 * 「逐笔到期」表逐条给出，指标卡上再重复一句最早时刻反而啰嗦。
 */
export function earliestCaption(split, now, zh) {
  const at = split?.earliestExpiringAt
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  const clock = fmtExpiry(at)
  const days = Math.floor((at - now) / DAY_MS)
  if (zh) return days <= 0 ? `最早 ${clock}` : `最早 ${clock}（${days} 天）`
  return days <= 0 ? `earliest ${clock}` : `earliest ${clock} (${days}d)`
}

/** 单个账号的分档摘要：只写非零的档，别用三个 0 把行撑满。 */
export function splitLine(split, zh) {
  const parts = []
  if (split.permanent > 0) parts.push(`${zh ? '永久' : 'perm'} ${fmtAmount(split.permanent)}`)
  if (split.longTerm > 0) parts.push(`${zh ? '长期' : 'long'} ${fmtAmount(split.longTerm)}`)
  if (split.expiring > 0) parts.push(`${zh ? '临期' : 'exp'} ${fmtAmount(split.expiring)}`)
  if (parts.length > 0) return parts.join(' · ')
  if (split.expired > 0) return zh ? '全部已过期' : 'all expired'
  return zh ? '无可用积分' : 'none available'
}

/**
 * 面板顶部三个数字的取值。分档渠道一定有值（没有积分时是 0，不是「—」），
 * 这样布局不会塌。
 */
export function splitFields(split, zh, now) {
  if (split === undefined) {
    return {
      expiring: '—',
      expiringCaption: undefined,
      longTerm: '—',
      longTermCaption: undefined,
      permanent: '—',
      permanentCaption: undefined,
    }
  }
  return {
    expiring: fmtAmount(split.expiring),
    // 副标题只说窗口，不再写「最早 11/08 19:17」——具体日期在「逐笔到期」表里。
    expiringCaption: zh ? `${split.windowDays} 天内` : `within ${split.windowDays}d`,
    longTerm: fmtAmount(split.longTerm),
    longTermCaption: zh ? `${split.windowDays} 天以上` : `${split.windowDays}d+`,
    permanent: fmtAmount(split.permanent),
    permanentCaption: zh ? '无到期' : 'never',
  }
}

/** 底部那句提示：临期要提醒，已过期 / 独立池要单独说明免得以为算漏。 */export function expiryNote(split, zh) {
  if (split === undefined) return undefined
  const aside = []
  if (split.expired > 0) {
    aside.push(zh ? `已过期 ${fmtAmount(split.expired)}` : `${fmtAmount(split.expired)} expired`)
  }
  if (split.exclusive > 0) {
    aside.push(zh ? `独立池 ${fmtAmount(split.exclusive)}` : `${fmtAmount(split.exclusive)} exclusive`)
  }
  const suffix = aside.length > 0 ? (zh ? `（另有${aside.join('、')}，不计入）` : ` (excl. ${aside.join(', ')})`) : ''
  const main = split.expiring > 0
    ? (zh
        ? `${split.windowDays} 天内有 ${fmtAmount(split.expiring)} 会作废，优先用这部分。`
        : `${fmtAmount(split.expiring)} expires within ${split.windowDays} days; spend it first.`)
    : split.permanent > 0 || split.longTerm > 0
      ? (zh ? `${split.windowDays} 天内没有要作废的积分。` : `Nothing expires within ${split.windowDays} days.`)
      : undefined
  if (main === undefined) return suffix === '' ? undefined : suffix
  return `${main}${suffix}`
}

/**
 * 面板顶部那条「临期预警」。
 *
 * 与底部的 `expiryNote` 有分工：`expiryNote` 是**说明性**的文字（顺带解释过期 /
 * 独立池），这里只做**该不该紧张**的判断，给出一个可以直接念出来的句子 + 语气。
 *
 * ⚠️ 只有在真的会作废时才返回内容：
 * - 临期金额为 0（或没有分档数据）⇒ `undefined`，调用方不画这一块；
 * - 临期金额有但还没到「很急」的档（≥ {@link URGENT_DAYS} 天）⇒ `info`；
 * - 最急那笔进入 URGENT_DAYS 天内 ⇒ `warn`，并且把「几天后」写进句子。
 *
 * 不编造日期：上游只给了「其中 N 即将到期」的标量时，`earliestExpiringAt`
 * 是 undefined，此时只说金额、不说到期日（见 `splitByExpiry` 的同名注释）。
 */
export const URGENT_DAYS = 3

export function expiryAlert(split, now, zh) {
  if (split === undefined || split.windowDays === undefined) return undefined
  const amount = split.expiring
  if (!(amount > 0)) return undefined
  const value = fmtAmount(amount)
  const at = split.earliestExpiringAt
  const days = typeof at === 'number' && Number.isFinite(at) ? Math.floor((at - now) / DAY_MS) : undefined
  const urgent = days !== undefined && days <= URGENT_DAYS
  if (zh) {
    const when = days === undefined
      ? `在 ${split.windowDays} 天内`
      : days <= 0
        ? '今天就会作废'
        : `最早 ${days} 天后作废`
    return {
      tone: urgent ? 'warn' : 'info',
      text: `${value} 积分${when}，先花这部分。`,
    }
  }
  const when = days === undefined
    ? `within ${split.windowDays} days`
    : days <= 0
      ? 'expires today'
      : `expires in ${days}d`
  return {
    tone: urgent ? 'warn' : 'info',
    text: `${value} credits ${when}; spend these first.`,
  }
}
