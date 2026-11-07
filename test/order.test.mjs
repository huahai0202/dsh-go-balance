// 账号排序的单测。跑法：node --test test/
//
// 锁的是「提交给 account.reorder 的那份数组必须完整且只动了一条」——
// Jet Hub 会核对集合，少一个 id 就整次失败，所以这里把边界都钉死。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyOrder, moveInOrder, moveSelected, nextOpenGroup, orderedIdsOf } from '../lib/order.js'

const IDS = ['a', 'b', 'c', 'd']

test('一次挪到位：中间跨度也只发一次写请求', () => {
  // 「点选挪到位」就是这条：不是一格一格走，所以 0 → 3 必须一次算成完整顺序。
  assert.deepEqual(moveInOrder(IDS, 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveInOrder(IDS, 2, 0), ['c', 'a', 'b', 'd'])
})

test('上移一位只交换相邻两条', () => {
  assert.deepEqual(moveInOrder(IDS, 1, 0), ['b', 'a', 'c', 'd'])
  assert.deepEqual(moveInOrder(IDS, 2, 1), ['a', 'c', 'b', 'd'])
})

test('下移一位只交换相邻两条', () => {
  assert.deepEqual(moveInOrder(IDS, 1, 2), ['a', 'c', 'b', 'd'])
  assert.deepEqual(moveInOrder(IDS, 0, 1), ['b', 'a', 'c', 'd'])
})

test('挪到首尾', () => {
  assert.deepEqual(moveInOrder(IDS, 3, 0), ['d', 'a', 'b', 'c'])
  assert.deepEqual(moveInOrder(IDS, 0, 3), ['b', 'c', 'd', 'a'])
})

test('原数组不被修改', () => {
  const before = [...IDS]
  moveInOrder(IDS, 0, 3)
  assert.deepEqual(IDS, before)
})

test('越界与原地不动一律返回 null，不发写请求', () => {
  assert.equal(moveInOrder(IDS, 0, 0), null)
  assert.equal(moveInOrder(IDS, -1, 0), null)
  assert.equal(moveInOrder(IDS, 0, 4), null)
  assert.equal(moveInOrder(IDS, 4, 3), null)
  assert.equal(moveInOrder(IDS, 1.5, 2), null)
  assert.equal(moveInOrder([], 0, 1), null)
  assert.equal(moveInOrder(undefined, 0, 1), null)
})

test('单条账号怎么挪都返回 null（没有可挪的位置）', () => {
  assert.equal(moveInOrder(['a'], 0, 0), null)
})

test('orderedIdsOf 取全量 id', () => {
  assert.deepEqual(orderedIdsOf([{ id: 'a' }, { id: 'b' }]), ['a', 'b'])
})

test('orderedIdsOf 遇到缺 id 的条目返回 null，不提交残缺集合', () => {
  assert.equal(orderedIdsOf([{ id: 'a' }, { id: '' }]), null)
  assert.equal(orderedIdsOf([{ id: 'a' }, { nickname: 'no id' }]), null)
  assert.equal(orderedIdsOf([{ id: 42 }]), null)
  assert.equal(orderedIdsOf(undefined), null)
})

test('空列表给空数组（Jet Hub 侧会拒绝，由调用方先判断）', () => {
  assert.deepEqual(orderedIdsOf([]), [])
})

// ── 多选整块移动 ────────────────────────────────────────────────

test('多选上移：整块一起挪一格，块内相对顺序不变', () => {
  // 选中 b、c（连续），整块上移 ⇒ b、c 各上一位
  assert.deepEqual(moveSelected(['a', 'b', 'c', 'd'], ['b', 'c'], 'up'), ['b', 'c', 'a', 'd'])
  // 选中不连续的三条：a、c 一起上移，a 已在顶不动，只有 c 越过 b
  assert.deepEqual(moveSelected(['a', 'b', 'c', 'd'], ['a', 'c'], 'up'), ['a', 'c', 'b', 'd'])
})

test('多选下移：整块一起挪一格', () => {
  assert.deepEqual(moveSelected(['a', 'b', 'c', 'd'], ['b', 'c'], 'down'), ['a', 'd', 'b', 'c'])
  assert.deepEqual(moveSelected(['a', 'b', 'c', 'd'], ['b', 'd'], 'down'), ['a', 'c', 'b', 'd'])
})

test('整块置顶 / 沉底', () => {
  assert.deepEqual(moveSelected(['a', 'b', 'c', 'd', 'e'], ['b', 'd'], 'top'), ['b', 'd', 'a', 'c', 'e'])
  assert.deepEqual(moveSelected(['a', 'b', 'c', 'd', 'e'], ['b', 'd'], 'bottom'), ['a', 'c', 'e', 'b', 'd'])
})

test('多选移动：已经在边上、或者没选中时返回 null（不发多余写请求）', () => {
  assert.equal(moveSelected(['a', 'b'], ['a'], 'up'), null)
  assert.equal(moveSelected(['a', 'b'], ['b'], 'down'), null)
  assert.equal(moveSelected(['a', 'b'], ['a', 'b'], 'up'), null)
  assert.equal(moveSelected(['a', 'b'], [], 'up'), null)
  assert.equal(moveSelected(['a', 'b'], ['x'], 'up'), null)
  assert.equal(moveSelected(['a'], ['a'], 'top'), null)
  assert.equal(moveSelected(undefined, ['a'], 'up'), null)
})

test('多选移动：Set 与数组两种选中形式等价', () => {
  assert.deepEqual(moveSelected(['a', 'b', 'c'], new Set(['b']), 'up'), moveSelected(['a', 'b', 'c'], ['b'], 'up'))
})

test('多选移动不修改原数组', () => {
  const before = ['a', 'b', 'c', 'd']
  moveSelected(before, ['c'], 'up')
  assert.deepEqual(before, ['a', 'b', 'c', 'd'])
})

test('applyOrder 按 id 重排，保持账号对象', () => {
  const accounts = [{ id: 'a', nickname: 'A' }, { id: 'b', nickname: 'B' }]
  assert.deepEqual(applyOrder(accounts, ['b', 'a']), [{ id: 'b', nickname: 'B' }, { id: 'a', nickname: 'A' }])
})

test('applyOrder 丢掉对不上的 id，不产出空条目', () => {
  const accounts = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(applyOrder(accounts, ['b', 'gone', 'a']), [{ id: 'b' }, { id: 'a' }])
  assert.deepEqual(applyOrder(undefined, ['a']), [])
  assert.deepEqual(applyOrder(accounts, undefined), accounts)
})

// ── 模型分组展开 / 收起 ──────────────────────────────────────

test('点已展开的组会收起它（回到空态）', () => {
  // 这是「已开启」那组收不起来的回归用例：早先写成「回落成 on」，
  // 点「已开启」只是把状态重新设成它自己展开的样子。
  assert.equal(nextOpenGroup('on', 'on'), '')
  assert.equal(nextOpenGroup('off', 'off'), '')
  assert.equal(nextOpenGroup('dead', 'dead'), '')
})

test('点别的组会切过去', () => {
  assert.equal(nextOpenGroup('on', 'off'), 'off')
  assert.equal(nextOpenGroup('', 'on'), 'on')
  assert.equal(nextOpenGroup('', 'dead'), 'dead')
})

test('未知组名不改变状态', () => {
  assert.equal(nextOpenGroup('on', 'bogus'), 'on')
})
