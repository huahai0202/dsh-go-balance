// 管理首页的单测。跑法：node --test test/
//
// 锁的是「首页不依赖数据推送」：早先它用 { $: 'data.homeItems' } 绑定，
// data 没推上来时整页就成了「暂无数据」+「—」的空壳，点也点不动
// （用户报障：点管理会卡住）。首页内容本来就是静态的，写死在视图里最稳。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTestHost, SKIP_KIT } from './kit.mjs'

/** 起一个「所有 RPC 都失败」的宿主，模拟数据推不上来的情形。 */
function brokenHost() {
  return createTestHost({
    dir: new URL('..', import.meta.url).pathname,
    services: {
      connection: {
        createSharedFetchHandler: () => ({ fetch: async () => { throw new Error('rpc down') } }),
        browserPeer: {},
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'trae' }) },
    },
  })
}

test('首页完全不依赖数据绑定（RPC 全挂、data 未起也能用）', { skip: SKIP_KIT }, async () => {
  const host = brokenHost()
  const { apply } = await import('../lib/index.js')
  apply(host.ctx)
  const v = await host.view('manage', { sessionId: 's1' })
  const text = JSON.stringify(v.view)
  assert.equal(text.includes('"$"'), false, '首页不应出现任何数据绑定')
})

test('首页的每个入口都指向正确的页面', { skip: SKIP_KIT }, async () => {
  const host = brokenHost()
  const { apply } = await import('../lib/index.js')
  apply(host.ctx)
  const v = await host.view('manage', { sessionId: 's1' })
  const list = v.view.children.find((c) => c.type === 'list')
  const tabs = list.items.map((i) => i.action?.args?.tab)
  assert.deepEqual(tabs, ['models', 'accounts', 'auto', 'lock', 'host', 'backup'])
  // 每个入口都得有标题与说明，不能只剩一个动作。
  for (const item of list.items) {
    assert.equal(typeof item.title, 'string', '入口缺标题')
    assert.equal(typeof item.subtitle, 'string', '入口缺说明')
  }
})
