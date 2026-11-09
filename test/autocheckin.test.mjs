// 自动签到页的单测。跑法：node --test test/
//
// 锁的是「这一页只有开关」：执行时刻属于 Jet Hub 自己的配置，插件不再提供
// 「改执行时刻」入口（早先有一版做成了原生 list 选时刻，用户不要这个功能）。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAutoCheckinSection } from '../lib/panels/auto-checkin.js'

/** 不连宿主：这一页的 view 是纯函数，直接看组件树。 */
const section = () => createAutoCheckinSection({})

test('自动签到页没有「改执行时刻」入口', () => {
  const text = JSON.stringify(section().view(true))
  assert.equal(text.includes('auto-edit-times'), false, '不该再有改时刻的动作')
  assert.equal(text.includes('auto-pick'), false, '不该再有选时刻的动作')
  assert.equal(text.includes('autoTimeItems'), false, '不该再有候选时刻列表')
})

test('自动签到页的动作只剩开关、收起、刷新', () => {
  const actions = Object.keys(section().actions)
  assert.deepEqual(actions.sort(), ['auto-dismiss', 'auto-refresh', 'auto-toggle'])
})

test('这一页保留开关行，并且时刻只作为读数', () => {
  const view = section().view(true)
  const text = JSON.stringify(view)
  assert.equal(text.includes('autoItems'), true, '开关行还在')
  // 两个时刻在开关行的副标题里（「每天 09:00 · 21:00」），
  // 顶部那张卡改成 Jet Hub 算出的真实下次时刻，两者不重复。
  assert.equal(text.includes('下次执行'), true, '顶部给下次执行时刻')
  assert.equal(text.includes('data.autoLastText'), true, '上次结果要摆出来')
})
