// 「全部渠道」边读边画的单测：纯函数 + 面板级（有 kit 才跑）。
//
// 锁两件事：
// 1. 还没回来的渠道要占一行「读取中」，合计只算已到的；
// 2. 面板真的会先发一帧部分结果，而不是等所有渠道都回来才画。

import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

// 同 runtime.test.mjs：本机真实状态会让「冷启动」不冷。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'balance-progress-test-'))

import { summarizeAll } from '../lib/panels/balance.js'
import { createTestHost, SKIP_KIT } from './kit.mjs'

const badge = (total) => ({ accounts: [{ nickname: 'a', balance: { total, packages: [{ unit: '积分', amount: total }] } }] })

const PROVIDERS = [{ provider: 'qodercn' }, { provider: 'trae' }]

test('summarizeAll：还没回来的渠道占一行，合计只算已到的', () => {
  const partial = summarizeAll([{ provider: 'qodercn', value: badge(1000) }, undefined], PROVIDERS, 0, true, Date.now())
  assert.equal(partial.total, '1000 积分')
  assert.equal(partial.rows.length, 2)
  assert.equal(partial.rows[1].value, '读取中…')
  assert.equal(partial.caption, '读取中 1/2')
})

test('summarizeAll：到齐后合计与标题回到完整口径', () => {
  const value = summarizeAll([
    { provider: 'qodercn', value: badge(1000) },
    { provider: 'trae', value: badge(500) },
  ], PROVIDERS, 0, true, Date.now())
  assert.equal(value.total, '1500 积分')
  assert.equal(value.rows.length, 2)
  assert.equal(value.rows[1].value, '500 积分')
  assert.equal(value.caption, '2 个已配置渠道')
})

test('summarizeAll：失败行给醒目语气，不影响其它渠道合计', () => {
  const value = summarizeAll([
    { provider: 'qodercn', value: badge(1000) },
    { provider: 'trae', error: true },
  ], PROVIDERS, 0, true, Date.now())
  assert.equal(value.total, '1000 积分')
  assert.equal(value.rows[1].tone, 'warn')
})

/** 假 Jet Hub：两个渠道，qodercn 先回、trae 晚 120ms。 */
function fakeHost() {
  return createTestHost({
    dir: new URL('..', import.meta.url).pathname,
    services: {
      connection: {
        browserPeer: {},
        createSharedFetchHandler: () => ({
          fetch: async (request) => {
            const body = await request.json()
            const method = body?.payload?.method
            const respond = (value) => ({ json: async () => ({ result: { ok: true, value } }) })
            if (method === 'provider.getOrder') return respond({ order: ['qodercn', 'trae'] })
            if (method === 'provider.status') {
              return respond({ statuses: { qodercn: { accounts: { enabled: 1 } }, trae: { accounts: { enabled: 1 } } } })
            }
            if (method === 'usage.badge') {
              const provider = body?.payload?.payload?.provider
              await new Promise((resolve) => setTimeout(resolve, provider === 'trae' ? 120 : 5))
              return respond({ ...badge(provider === 'trae' ? 500 : 1000), provider, generatedAt: Date.now() })
            }
            return respond({})
          },
        }),
      },
      agentDefaultModel: { currentSelection: () => ({ provider: 'qodercn' }) },
    },
  })
}

test('余额面板「全部渠道」先发部分结果，最后才是完整结果', { skip: SKIP_KIT }, async () => {
  const host = fakeHost()
  const { apply } = await import('../lib/index.js')
  apply(host.ctx)
  const boot = host.subscribe('channels', { sessionId: 's1' })
  await boot.settled
  await host.invoke('channels', {
    surface: 'panel', action: 'pick-channel', value: { channel: '__all__' }, scope: { sessionId: 's1' },
  })
  const feed = host.subscribe('balance', { sessionId: 's1' })
  const deadline = Date.now() + 3_000
  let sawPartial = false
  while (Date.now() < deadline) {
    if (feed.history.some((frame) => /\d\/2$/.test(String(frame?.caption ?? '')))) sawPartial = true
    const last = feed.history.at(-1)
    if (last?.caption === '2 个已配置渠道') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const last = feed.history.at(-1)
  assert.equal(sawPartial, true, '中途应有一帧「读取中 1/2」')
  assert.equal(last.caption, '2 个已配置渠道')
  assert.equal(last.total, '1500 积分')
  feed.stop()
  boot.stop()
  host.dispose?.()
})
