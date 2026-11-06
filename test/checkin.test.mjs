// 一键签到格式化的单测。跑法：node --test test/
//
// 这些用例锁的是「面板上那行字」：结果要短、要说得清哪个渠道、失败原因不能
// 整段上游报错直接糊上去；上游说「没有签到」的渠道必须走「跳过」而不是「失败」。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  checkinSummary,
  claimLine,
  isUnsupportedCheckin,
  progressLine,
} from '../lib/checkin.js'

const summary = (over) => ({
  claimed: 0,
  totalCredit: 0,
  alreadyClaimed: 0,
  inactive: 0,
  failed: 0,
  coversToday: 0,
  totalByUnit: { token: 0, credit: 0 },
  ...over,
})

test('claimLine：领到积分 + 今日已领合并成一句', () => {
  const value = {
    summary: summary({ claimed: 2, alreadyClaimed: 1, totalCredit: 100.5, totalByUnit: { credit: 100.5, token: 0 } }),
    results: [],
  }
  assert.equal(claimLine('CodeArts', value, true), 'CodeArts 领到 100.5 积分，今日已领')
})

test('claimLine：只有 token 的渠道按 token 报', () => {
  const value = { summary: summary({ claimed: 1, totalByUnit: { credit: 0, token: 3000 } }), results: [] }
  assert.equal(claimLine('Z.ai', value, true), 'Z.ai 领到 3000 tokens')
  assert.equal(claimLine('Z.ai', value, false), 'Z.ai +3000 tokens')
})

test('claimLine：暂无活动与失败分开说', () => {
  const value = {
    summary: summary({ inactive: 1, failed: 2 }),
    results: [{ outcome: { kind: 'failed', message: ' 凭据已过期\n请重新登录 ' } }],
  }
  assert.equal(claimLine('Qoder', value, true), 'Qoder 暂无活动，失败（凭据已过期 请重新登录）')
})

test('claimLine：失败原因只取第一条、截短到一行', () => {
  const long = '上游返回了一大段根本不适合直接摆在手机面板上的错误信息'.repeat(3)
  const value = {
    summary: summary({ failed: 2 }),
    results: [
      { outcome: { kind: 'failed', message: long } },
      { outcome: { kind: 'failed', message: '第二条不该出现' } },
    ],
  }
  const line = claimLine('TRAE', value, true)
  assert.ok(line.startsWith('TRAE 失败（'))
  assert.ok(line.includes('…'))
  assert.ok(!line.includes('第二条不该出现'))
  assert.ok(line.length < 60)
})

test('claimLine：没有任何计数时回空串', () => {
  assert.equal(claimLine('TRAE', { summary: summary({}) }, true), '')
  assert.equal(claimLine('TRAE', undefined, true), '')
})

test('isUnsupportedCheckin：两种措辞都算跳过', () => {
  assert.equal(isUnsupportedCheckin('Cline 不支持每日签到（其后端没有签到接口）'), true)
  assert.equal(isUnsupportedCheckin('unsupported provider: cline'), true)
  assert.equal(isUnsupportedCheckin('凭据已过期'), false)
  assert.equal(isUnsupportedCheckin(''), false)
})

test('checkinSummary：空结果要说清楚原因', () => {
  assert.equal(checkinSummary([], 0, 0, true), '没有可签到的渠道。')
  assert.equal(checkinSummary([], 3, 3, true), '当前渠道都没有签到功能。')
  assert.equal(
    checkinSummary(['CodeArts 领到 100 积分', 'TRAE 今日已领'], 0, 2, true),
    '签到完成：CodeArts 领到 100 积分，TRAE 今日已领',
  )
})

test('checkinSummary：太长时截断，不撑破面板', () => {
  const text = checkinSummary(Array.from({ length: 20 }, (_, i) => `渠道${i} 领到 100 积分`), 0, 20, true)
  assert.ok(text.length <= 160)
  assert.ok(text.endsWith('…'))
})

test('progressLine：进行中的第几个渠道', () => {
  assert.equal(progressLine(0, 3, 'CodeArts', true), '正在签到 1/3：CodeArts')
  assert.equal(progressLine(2, 3, 'TRAE', true), '正在签到 3/3：TRAE')
  assert.equal(progressLine(3, 3, 'TRAE', true), '正在签到 3/3：TRAE')
  assert.equal(progressLine(0, 0, '', true), '正在查找可签到的渠道…')
})

