// runtime.readConfiguredProviders 的 stale-while-revalidate 行为。
//
// 冷启动的一次探测是 29 个进程内 RPC，所以这里盯三件事：
// 1. 缓存过期后旧列表要立刻返回（不能等探测）；
// 2. 后台补完要踢一次，让面板自己换新列表；
// 3. 并发调用只探一轮。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRuntime } from '../lib/runtime.js'

const TTL = 300_000

/** 假 connection：按方法计数，可让每个 RPC 延迟完成，用来观察「有没有等」。 */
function fakeCtx({ rpcDelayMs = 0, order = ['trae', 'buddy'], failProbe = false, failAccounts = false, emptyAccounts = false } = {}) {
  const calls = []
  const connection = {
    browserPeer: {},
    createSharedFetchHandler: () => ({
      fetch: async (request) => {
        const { payload } = await request.json()
        calls.push(payload.method)
        if (rpcDelayMs > 0) await new Promise((r) => setTimeout(r, rpcDelayMs))
        if (failProbe && payload.method === 'provider.getOrder') throw new Error('no-connection')
        if (failAccounts && payload.method === 'account.list') {
          return { json: async () => ({ result: { ok: false, error: { message: 'jet-hub down' } } }) }
        }
        const value = payload.method === 'provider.getOrder'
          ? { order }
          : payload.method === 'account.list'
            ? { accounts: emptyAccounts ? [] : [{ id: `${payload.payload.provider}-1`, enabled: true }] }
            : {}
        return { json: async () => ({ result: { ok: true, value } }) }
      },
    }),
  }
  const services = { connection }
  return { ctx: { get: (name) => services[name] }, calls }
}

const staleCache = () => ({ at: Date.now() - TTL - 1, value: [{ provider: 'old', count: 1 }], failed: 0 })

test('缓存过期时先给旧列表，后台补完再踢一次', async () => {
  const { ctx, calls } = fakeCtx()
  const r = createRuntime(ctx)
  await r.stateReady
  r.channelsCache = staleCache()
  let kicked = 0
  r.channelKicks.add(() => { kicked += 1 })

  const returned = await r.readConfiguredProviders(false)
  // 立刻拿到的是旧列表，而且一个 RPC 都还没发（探测在后台）。
  assert.deepEqual(returned.value, [{ provider: 'old', count: 1 }])
  assert.deepEqual(calls, [])

  await r.refreshChannels(false).catch(() => {})
  assert.ok(calls.includes('provider.getOrder'))
  assert.deepEqual(r.channelsCache.value.map((x) => x.provider), ['trae', 'buddy'])
})

test('缓存新鲜时连探测都不发', async () => {
  const { ctx, calls } = fakeCtx()
  const r = createRuntime(ctx)
  await r.stateReady
  r.channelsCache = { at: Date.now(), value: [{ provider: 'old', count: 1 }], failed: 0 }
  await r.readConfiguredProviders(false)
  assert.deepEqual(calls, [])
})

test('冷启动（没有旧列表）必须等一次探测', async () => {
  const { ctx, calls } = fakeCtx({ order: ['trae'] })
  const r = createRuntime(ctx)
  await r.stateReady
  const cache = await r.readConfiguredProviders(false)
  assert.deepEqual(cache.value.map((x) => x.provider), ['trae'])
  assert.equal(calls.filter((m) => m === 'account.list').length, 1)
})

test('force 会等探测完成，不拿旧列表糊弄', async () => {
  const { ctx } = fakeCtx({ rpcDelayMs: 5, order: ['trae'] })
  const r = createRuntime(ctx)
  await r.stateReady
  r.channelsCache = staleCache()
  const cache = await r.readConfiguredProviders(true)
  assert.deepEqual(cache.value.map((x) => x.provider), ['trae'])
})

test('并发只探一轮', async () => {
  const { ctx, calls } = fakeCtx({ rpcDelayMs: 5, order: ['trae'] })
  const r = createRuntime(ctx)
  await r.stateReady
  const [a, b] = await Promise.all([r.readConfiguredProviders(false), r.readConfiguredProviders(false)])
  assert.equal(a, b)
  assert.equal(calls.filter((m) => m === 'provider.getOrder').length, 1)
})

test('探不到任何渠道且带失败数时保留旧列表', async () => {
  const { ctx } = fakeCtx({ order: ['trae', 'buddy'], failAccounts: true })
  const r = createRuntime(ctx)
  await r.stateReady
  r.channelsCache = staleCache()
  await r.refreshChannels(true)
  assert.deepEqual(r.channelsCache.value, [{ provider: 'old', count: 1 }])
  assert.equal(r.channelsCache.failed, 2)
})

test('确实一个账号都没有（没有失败）时接受空列表', async () => {
  const { ctx } = fakeCtx({ order: ['trae'], emptyAccounts: true })
  const r = createRuntime(ctx)
  await r.stateReady
  r.channelsCache = staleCache()
  await r.refreshChannels(true)
  assert.deepEqual(r.channelsCache.value, [])
  assert.equal(r.channelsCache.failed, 0)
})