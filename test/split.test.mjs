// 分档逻辑的单测。跑法：node --test test/
//
// 这些用例锁的是「和 Jet Hub 面板口径一致」这件事：同一份 packages[]，本插件
// 算出来的三档必须和 Jet Hub 客户端 `splitCreditsByExpiry` 的结果一致。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DAY_MS,
  earliestCaption,
  expiryAlert,
  expiryNote,
  fmtAmount,
  mergeSplits,
  normalizeWindowDays,
  packageExpiryMs,
  splitByExpiry,
  splitFields,
  splitLine,
} from '../lib/split.js'

const NOW = Date.parse('2025-01-15T02:00:00+08:00')
const D = DAY_MS
const pkg = (over) => ({ active: true, unit: '积分', ...over })

test('窗口天数：缺失 / 非法一律 null，0 是合法值', () => {
  assert.equal(normalizeWindowDays(undefined), null)
  assert.equal(normalizeWindowDays(null), null)
  assert.equal(normalizeWindowDays(''), null)
  assert.equal(normalizeWindowDays('abc'), null)
  assert.equal(normalizeWindowDays(-1), null)
  assert.equal(normalizeWindowDays(0), 0)
  assert.equal(normalizeWindowDays('15'), 15)
})

test('到期时刻优先取 deductionEndTime，其次 expiredTime', () => {
  assert.equal(packageExpiryMs({ deductionEndTime: 123456 }), 123456)
  assert.equal(packageExpiryMs({ deductionEndTime: '123456' }), 123456)
  assert.equal(packageExpiryMs({ expiredTime: '2025-01-30 10:00:00' }), Date.parse('2025-01-30T10:00:00'))
  // 扣费截止无效时回落到 ExpiredTime
  assert.equal(packageExpiryMs({ deductionEndTime: 0, expiredTime: '2025-01-30 10:00:00' }), Date.parse('2025-01-30T10:00:00'))
  assert.equal(packageExpiryMs({}), null)
})

test('三档边界：14.9 天算临期，正好 15 天算长期', () => {
  const split = splitByExpiry([
    pkg({ remaining: 10, deductionEndTime: NOW + 14.9 * D }),
    pkg({ remaining: 20, deductionEndTime: NOW + 15 * D }),
    pkg({ remaining: 30, deductionEndTime: NOW + 15.1 * D }),
  ], 15, NOW)
  assert.equal(split.expiring, 10)
  assert.equal(split.longTerm, 50)
  assert.equal(split.permanent, 0)
})

test('没有到期时间的进永久桶', () => {
  const split = splitByExpiry([pkg({ remaining: 42 })], 15, NOW)
  assert.equal(split.permanent, 42)
  assert.equal(split.expiring, 0)
})

test('失效包与零余额包都不计入', () => {
  const split = splitByExpiry([
    pkg({ remaining: 999, active: false }),
    pkg({ remaining: 0 }),
    pkg({ remaining: 5 }),
  ], 15, NOW)
  assert.equal(split.permanent, 5)
})

test('已过期的进 expired 而不是任何一档', () => {
  const split = splitByExpiry([
    pkg({ remaining: 30, deductionEndTime: NOW - 3 * D }),
    pkg({ remaining: 10 }),
  ], 15, NOW)
  assert.equal(split.expired, 30)
  assert.equal(split.permanent, 10)
})

test('独立池不进任何一档，单独累计', () => {
  const split = splitByExpiry([
    pkg({ name: '星火独立池', remaining: 777 }),
    pkg({ remaining: 10 }),
  ], 15, NOW)
  assert.equal(split.exclusive, 777)
  assert.equal(split.permanent, 10)
  // 独立池不能被算进可用合计
  assert.notEqual(split.permanent, 787)
})

test('expiringRemaining 拆包：不给倒计时（上游没有逐笔日期）', () => {
  const split = splitByExpiry([pkg({ remaining: 1000, expiringRemaining: 200 })], 15, NOW)
  assert.equal(split.expiring, 200)
  assert.equal(split.permanent, 800)
  assert.equal(split.earliestExpiringAt, undefined, '没有日期就不该编造倒计时')
})

test('expiringRemaining 超过 remaining 时按 remaining 封顶', () => {
  const split = splitByExpiry([pkg({ remaining: 50, expiringRemaining: 999 })], 15, NOW)
  assert.equal(split.expiring, 50)
  assert.equal(split.permanent, 0)
})

test('最早到期：取最早那笔，同刻的累加', () => {
  const at = NOW + 3 * D
  const split = splitByExpiry([
    pkg({ remaining: 10, deductionEndTime: NOW + 8 * D }),
    pkg({ remaining: 20, deductionEndTime: at }),
    pkg({ remaining: 5, deductionEndTime: at }),
  ], 15, NOW)
  assert.equal(split.earliestExpiringAt, at)
  assert.equal(split.earliestExpiringAmount, 25)
})

test('mergeSplits 累加各桶并保留最早到期', () => {
  const a = splitByExpiry([pkg({ remaining: 10, deductionEndTime: NOW + 5 * D })], 15, NOW)
  const b = splitByExpiry([pkg({ remaining: 20, deductionEndTime: NOW + 2 * D })], 15, NOW)
  const merged = mergeSplits([a, b])
  assert.equal(merged.expiring, 30)
  assert.equal(merged.earliestExpiringAt, NOW + 2 * D)
  assert.equal(merged.earliestExpiringAmount, 20)
})

test('mergeSplits 空数组不炸', () => {
  const merged = mergeSplits([])
  assert.equal(merged.expiring, 0)
  assert.equal(merged.earliestExpiringAt, undefined)
})

test('最早到期给具体日期；天数是 floor，14.9 天不能说成 15 天', () => {
  const split = splitByExpiry([pkg({ remaining: 1, deductionEndTime: NOW + 14.9 * D })], 15, NOW)
  assert.equal(earliestCaption(split, NOW, true), '最早 01/29 23:36（14 天）')
})

test('最早到期不到一天时给时刻，不说「今天到期」', () => {
  const split = splitByExpiry([pkg({ remaining: 1, deductionEndTime: NOW + 0.08 * D })], 15, NOW)
  assert.equal(earliestCaption(split, NOW, true), '最早 01/15 03:55')
})

test('fmtAmount 两位小数、去掉尾随 0', () => {
  assert.equal(fmtAmount(250), '250')
  assert.equal(fmtAmount(250.5), '250.5')
  assert.equal(fmtAmount(250.456), '250.46')
  assert.equal(fmtAmount(0), '0')
  assert.equal(fmtAmount(Number.NaN), '—')
})

test('splitLine 只写非零的档', () => {
  const split = { expiring: 250, longTerm: 100, permanent: 0, expired: 0, exclusive: 0 }
  assert.equal(splitLine(split, true), '长期 100 · 临期 250')
  assert.equal(splitLine({ ...split, expiring: 0, longTerm: 0, permanent: 50 }, true), '永久 50')
})

test('splitFields 没有积分时给 0 而不是破折号（布局不塌）', () => {
  const split = splitByExpiry([], 15, NOW)
  const fields = splitFields(split, true, NOW)
  assert.equal(fields.expiring, '0')
  assert.equal(fields.longTerm, '0')
  assert.equal(fields.permanent, '0')
})

test('splitFields 不传 split 时全给破折号', () => {
  const fields = splitFields(undefined, true, NOW)
  assert.equal(fields.expiring, '—')
  assert.equal(fields.permanent, '—')
})

test('expiryNote：有临期时提醒优先用', () => {
  const split = splitByExpiry([pkg({ remaining: 250, deductionEndTime: NOW + 8 * D })], 15, NOW)
  assert.match(expiryNote(split, true), /会作废，优先用这部分/)
})

test('expiryNote：已过期与独立池单独说明', () => {
  const split = splitByExpiry([
    pkg({ remaining: 30, deductionEndTime: NOW - 3 * D }),
    pkg({ name: '独立池', remaining: 777 }),
  ], 15, NOW)
  const note = expiryNote(split, true)
  assert.match(note, /已过期 30/)
  assert.match(note, /独立池 777/)
  assert.match(note, /不计入/)
})

// ── 临期预警（expiryAlert）────────────────────────────────────────────
//
// 面板顶部那一行只在「真会作废」时出现。这里钉住三个边界：
// 金额为 0 不出现、最急那笔进入 3 天内升级成 warn、没有逐笔日期时不编造日期。

test('expiryAlert：临期金额为 0 时不出现', () => {
  assert.equal(expiryAlert({ windowDays: 7, expiring: 0 }, NOW, true), undefined)
  assert.equal(expiryAlert(undefined, NOW, true), undefined)
  // 没有窗口天数（不分档渠道）也不该出现。
  assert.equal(expiryAlert({ expiring: 100 }, NOW, true), undefined)
})

test('expiryAlert：3 天内作废升级成 warn，并写明天数', () => {
  const split = { windowDays: 7, expiring: 120, earliestExpiringAt: NOW + DAY_MS * 2 }
  const alert = expiryAlert(split, NOW, true)
  assert.equal(alert.tone, 'warn')
  assert.match(alert.text, /2 天后作废/)
  assert.match(alert.text, /120/)
})

test('expiryAlert：还早时只是 info，同样写明天数', () => {
  const split = { windowDays: 7, expiring: 120, earliestExpiringAt: NOW + DAY_MS * 6 }
  const alert = expiryAlert(split, NOW, true)
  assert.equal(alert.tone, 'info')
  assert.match(alert.text, /6 天后作废/)
})

test('expiryAlert：今天到期时说「今天」', () => {
  const split = { windowDays: 7, expiring: 50, earliestExpiringAt: NOW + 60_000 }
  const alert = expiryAlert(split, NOW, true)
  assert.equal(alert.tone, 'warn')
  assert.match(alert.text, /今天就会作废/)
})

test('expiryAlert：上游只给「其中 N 即将到期」时不说具体日期', () => {
  // earliestExpiringAt 缺失 = 没有逐笔日期，只能说窗口，不能编造「几天后」。
  const alert = expiryAlert({ windowDays: 7, expiring: 120 }, NOW, true)
  assert.equal(alert.tone, 'info')
  assert.match(alert.text, /7 天内/)
  assert.doesNotMatch(alert.text, /天后/)
})
