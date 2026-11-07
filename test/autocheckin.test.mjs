// 自动签到时刻校验的单测。跑法：node --test test/
//
// 锁的是「本地先挡掉非法时刻，别等 Jet Hub 回 bad-request」这件事：
// Jet Hub 要求恰好两个 HH:MM、不能重复，本地先校验能给更清楚的提示。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateTimes } from '../lib/panels/auto-checkin.js'

test('两个合法时刻：排好序返回', () => {
  assert.deepEqual(validateTimes('21:00', '09:00').times, ['09:00', '21:00'])
  assert.deepEqual(validateTimes('09:00', '21:00').times, ['09:00', '21:00'])
})

test('缺前导零一律拒掉（Jet Hub 只收 HH:MM）', () => {
  assert.equal(validateTimes('8:30', '20:30').error, 'time1')
  assert.equal(validateTimes('09:00', '9:00').error, 'time2')
})

test('越界与非数字拒掉', () => {
  assert.equal(validateTimes('24:00', '09:00').error, 'time1')
  assert.equal(validateTimes('09:60', '10:00').error, 'time1')
  assert.equal(validateTimes('ab:cd', '10:00').error, 'time1')
})

test('空值与缺失拒掉', () => {
  assert.equal(validateTimes('', '10:00').error, 'time1')
  assert.equal(validateTimes(undefined, '10:00').error, 'time1')
  assert.equal(validateTimes('09:00', undefined).error, 'time2')
})

test('两个时刻相同拒掉', () => {
  assert.equal(validateTimes('09:00', '09:00').error, 'same')
})

test('前后空格会被去掉后再判', () => {
  assert.deepEqual(validateTimes(' 09:00 ', ' 21:00 ').times, ['09:00', '21:00'])
})

test('午夜与深夜边界都合法', () => {
  assert.deepEqual(validateTimes('00:00', '23:59').times, ['00:00', '23:59'])
})
