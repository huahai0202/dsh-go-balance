// 管理面板的数据契约测试。跑法：node --test test/
//
// 桥接是**整份替换**：视图里 `{ $: 'data.x' }` 绑定的键，如果某次 emit 没带上，
// 那个位置就退化成「—」。这类问题肉眼极难发现（要特定页、特定语言、特定失败
// 路径才复现），所以用契约测试锁住：每个页面上，视图绑定的每个 `data.*` 键，
// 都必须由该页的数据给出来。
//
// 这个用例上线时当场抓到一处：自动签到读取失败的分支漏了 `autoEnabledTone`，
// 界面会显示一个没有颜色的「—」。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createTestHost, SKIP_KIT } from './kit.mjs'

/** 起一个宿主：所有 RPC 都失败，用来拿「最坏情况下的骨架数据」。 */
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

/** 从视图里收集所有 `{ $: 'data.a.b' }` 的顶层键。 */
function boundKeys(node, out = new Set()) {
  if (Array.isArray(node)) {
    for (const child of node) boundKeys(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  for (const [key, value] of Object.entries(node)) {
    if (key === '$' && typeof value === 'string' && value.startsWith('data.')) {
      out.add(value.slice('data.'.length).split(/[.[]/)[0])
    } else {
      boundKeys(value, out)
    }
  }
  return out
}

/** 切到某一页，返回该页的视图绑定键与数据键。 */
async function pageKeys(tab, locale) {
  const host = brokenHost()
  const { apply } = await import('../lib/index.js')
  apply(host.ctx)
  // 先订阅一次，让面板把 enterManagePage 这类能力挂到 runtime 上。
  const boot = host.subscribe('manage', { sessionId: 's1' })
  await boot.settled
  await host.invoke('manage', {
    surface: 'panel', action: 'manage-tab', value: { tab }, scope: { sessionId: 's1' }, locale,
  })
  const feed = host.subscribe('manage', { sessionId: 's1' })
  await feed.settled
  // data 是 async：首帧先把骨架推出来就返回了，而这一页真正的内容要等一次
  // 读盘 / RPC（这里全失败，也要等 catch 分支跑完）。等它落到目标页为止。
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && feed.data?.tab !== tab) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  const view = await host.view('manage', { sessionId: 's1' }, { locale })
  const bound = boundKeys(view.view)
  const provided = new Set(Object.keys(feed.data ?? {}))
  boot.stop()
  feed.stop()
  return { bound, provided, errors: feed.errors }
}

const TABS = ['home', 'models', 'accounts', 'auto', 'host']
const LOCALES = ['zh-CN', 'en-US']

test('每个页面上，视图绑定的键都有数据（否则该处显示成「—」）', { skip: SKIP_KIT }, async () => {
  for (const tab of TABS) {
    for (const locale of LOCALES) {
      const { bound, provided, errors } = await pageKeys(tab, locale)
      assert.deepEqual(errors, [], `${tab}/${locale} 的数据函数报错`)
      const missing = [...bound].filter((key) => !provided.has(key))
      assert.deepEqual(missing, [], `${tab}/${locale} 这些绑定没有对应数据：${missing.join(', ')}`)
    }
  }
})

test('切页（走缓存）与首次进页（走 IO）给出的字段一致', { skip: SKIP_KIT }, async () => {
  // 两条路径由 accountPageFields / modelPageFields 共用，但调用方不同：
  // 走缓存的少了字段就是「切回来时数字闪成破折号」。用同一份假数据分别喂两边，
  // 比较键集合 —— 这是唯一能自动盯住「两处各写一遍」的办法。
  const host = brokenHost()
  const { apply } = await import('../lib/index.js')
  apply(host.ctx)
  const boot = host.subscribe('manage', { sessionId: 's1' })
  await boot.settled
  for (const tab of ['models', 'accounts']) {
    const cold = host.subscribe('manage', { sessionId: 's1' })
    await host.invoke('manage', {
      surface: 'panel', action: 'manage-tab', value: { tab }, scope: { sessionId: 's1' }, locale: 'zh-CN',
    })
    await cold.settled
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && cold.data?.tab !== tab) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const warm = host.subscribe('manage', { sessionId: 's1' })
    await warm.settled
    await new Promise((resolve) => setTimeout(resolve, 50))
    const coldKeys = Object.keys(cold.data ?? {}).sort()
    const warmKeys = Object.keys(warm.data ?? {}).sort()
    cold.stop()
    warm.stop()
    // 缓存没热起来时 warm 会回落到同一路径，两边相同也说明没漂移。
    assert.deepEqual(warmKeys, coldKeys, `${tab} 两路径字段不一致`)
  }
  boot.stop()
})
