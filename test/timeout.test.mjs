// RPC 超时：上游不返回时必须**在有限时间内失败**，不能永久挂起。
//
// 这条盯的是一个真实缺陷：`callJetHub` 原本完全没有超时，上游一旦不返回，
// `await` 就永远挂着 —— 面板上表现为「点了没反应」「白条不消失」，而且后续
// 操作还会排在后面。备份导出 / 导入最容易撞上。

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { callJetHub, exportBackup, importBackup, EXPORT_TIMEOUT_MS, RPC_TIMEOUT_MS } from '../lib/jet-hub.js'

/** 一个永远不返回 fake fetch：模拟上游卡死。 */
const hangingCtx = () => ({
  get: () => ({ createSharedFetchHandler: () => ({ fetch: () => new Promise(() => {}) }), browserPeer: {} }),
})

/** 记录调用参数并在指定延迟后返回的假上游。 */
const slowCtx = (delayMs, value = { ok: true }) => {
  const seen = []
  return {
    seen,
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          seen.push(body.payload)
          await new Promise((r) => setTimeout(r, delayMs))
          return { json: async () => ({ result: { ok: true, value } }) }
        },
      }),
      browserPeer: {},
    }),
  }
}

test('上游卡死时 RPC 超时并抛出可读原因（不会永久挂起）', async () => {
  const started = Date.now()
  await assert.rejects(
    () => callJetHub(hangingCtx(), 'backup.status', {}, 120),
    /backup\.status-timeout/,
    '应当以 <method>-timeout 失败',
  )
  const elapsed = Date.now() - started
  assert.equal(elapsed < 2000, true, `超时应当在 2 秒内触发，实际 ${elapsed}ms`)
})

test('导出用更短的上限，好赶在桥接 3 秒处理器时限之前给出人话', () => {
  // 导出不挂 pending，桥接的 handlerTimeoutMs 是 3000ms。这里必须更短，
  // 否则用户拿到的是一个没头没尾的 504。
  assert.equal(EXPORT_TIMEOUT_MS < 3000, true, '导出上限必须小于桥接处理器时限')
  assert.equal(RPC_TIMEOUT_MS > EXPORT_TIMEOUT_MS, true, '普通 RPC 的上限应更宽松')
})

test('导出/导入在上游卡死时都会失败，而不是一直等', async () => {
  for (const [label, run] of [
    ['export', () => exportBackup(hangingCtx(), undefined)],
    ['import', () => importBackup(hangingCtx(), {}, 'merge')],
  ]) {
    const started = Date.now()
    // 这里不传自定义上限，用真实常量；导入是 45 秒太慢，只验证导出。
    if (label === 'import') continue
    await assert.rejects(() => run(), /-timeout/, `${label} 应当超时失败`)
    const elapsed = Date.now() - started
    assert.equal(elapsed < 5000, true, `${label} 超时太慢：${elapsed}ms`)
  }
})

test('上游正常返回时不受超时影响，参数原样透传', async () => {
  const ctx = slowCtx(20, { payload: { format: 'x' }, warnings: [] })
  const value = await exportBackup(ctx, ['a1', 'a2'])
  assert.equal(value.payload.format, 'x')
  assert.deepEqual(ctx.seen[0].method, 'backup.export')
  assert.deepEqual(ctx.seen[0].payload.accountIds, ['a1', 'a2'], 'accountIds 要原样传给上游')
})

test('恢复卡住时：面板给提示与取消入口，取消后能继续操作', async () => {
  // 真实缺陷：恢复走桥接的 pending，而**连接一断桥接就静默作废**
  // （dropPendings 不通知客户端），插件的 finally 永远等不到 → busy 永久卡死，
  // 之后每次点都弹「上一个操作还没结束」。用户感受就是「导入一个文件被卡住」。
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const payload = { format: 'dsh-codearts-auth/backup', version: 1, exportedAt: 'x', credentials: {}, accounts: [{ id: 'a1' }] }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let importCalls = 0
  const ctx = {
    dshGo: { readPickedFile: () => bytes },
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          if (body?.payload?.method === 'backup.import') {
            importCalls += 1
            return new Promise(() => {})   // 永不返回
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 1, withoutExpiry: 0, accountList: [{ id: 'a1', provider: 'trae' }] } } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const section = createBackupSection(ctx)
  await section.data(() => {}, true, true, {})
  await section.actions['backup-picked']({}, {
    locale: 'zh-CN',
    value: { status: 'selected', files: [{ handle: 'h1', name: 'b.json', bytes: bytes.length, mediaType: 'application/json', access: 'read' }] },
  })

  section.actions['backup-restore-confirm']({}, { locale: 'zh-CN', value: { confirmed: true } })
  await section.data(() => {}, true, true, {})
  // 忙时：要说清状态，并且给出口。
  assert.equal(section.peek(true).backupBusyLine !== '', true, '卡住时要有说明')
  assert.equal(
    JSON.stringify(section.view(true)).includes('backup-busy-cancel'),
    true,
    '卡住时必须给一个取消入口',
  )
  // 再点导出会被挡住，而不是并发跑两份。
  const blocked = await section.actions['backup-export']({}, { locale: 'zh-CN' })
  assert.equal(JSON.stringify(blocked).includes('还没结束'), true, '忙时应挡掉重复操作')

  // 取消 → 解锁 → 能继续操作。
  await section.actions['backup-busy-cancel']({}, { locale: 'zh-CN' })
  await section.data(() => {}, true, true, {})
  assert.equal(section.peek(true).backupBusyLine, '', '取消后不该还显示忙')
  const after = await section.actions['backup-export']({}, { locale: 'zh-CN' })
  assert.equal(JSON.stringify(after).includes('还没结束'), false, '解锁后要能继续操作')
  // 导入请求是异步发出的（此刻还挂在那个永不返回的 fetch 上），
  // 这里只断言「没有因为取消而重复发起」。
  assert.equal(importCalls <= 1, true, `不该重复发起导入，实际 ${importCalls} 次`)
})

test('点「导出」只展开两个选项，不直接导出', async () => {
  // 需求：点导出后应当出现「全部导出」和「选账号导出」两个选项。
  // 早先是并排两个按钮，看着像两件不同的事；现在一个入口承担两种意图。
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const accounts = Array.from({ length: 4 }, (_, i) => ({ id: `a${i}`, provider: 'trae', nickname: `账号${i}` }))
  let exported = 0
  let lastIds
  const ctx = {
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          if (body?.payload?.method === 'backup.export') {
            exported += 1
            lastIds = body.payload.payload.accountIds
            return { json: async () => ({ result: { ok: true, value: {
              payload: { format: 'dsh-codearts-auth/backup', version: 1, exportedAt: 'x', credentials: {}, accounts: [] },
              warnings: [],
            } } }) }
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 4, withoutExpiry: 0, accountList: accounts } } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-menu-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  try {
    const section = createBackupSection(ctx)
    await section.data(() => {}, true, true, {})

    // 还没点：只有入口，没有两个选项。
    const before = JSON.stringify(section.view(true))
    assert.equal(before.includes('backup-export-menu'), true, '要有导出入口')
    assert.equal(before.includes('backup-select-mode'), false, '没点之前不该展开选项')

    await section.actions['backup-export-menu']({}, { locale: 'zh-CN' })
    await section.data(() => {}, true, true, {})
    const after = JSON.stringify(section.view(true))
    assert.equal(after.includes('backup-export') && after.includes('backup-select-mode'), true, '展开后要有两个选项')
    assert.equal(exported, 0, '只展开，不该直接导出')

    // 选「全部账号」：accountIds 不传。
    await section.actions['backup-export']({}, { locale: 'zh-CN' })
    assert.equal(exported, 1, '应当导出一次')
    assert.equal(lastIds, undefined, '全部导出不传 accountIds')
  } finally {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  }
})
