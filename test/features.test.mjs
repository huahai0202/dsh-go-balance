// 新增功能的单测：签到结果展示、状态条文案、备份文件名白名单。
//
// 跑法：node --test test/
//
// 这一组都是纯函数 / 只碰临时目录，不依赖宿主；面板级的契约由
// data-contract.test.mjs 覆盖（那里已经把 lock / backup 两页加进去了）。

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { channelRows, runSummary, whenLabel } from '../lib/checkin.js'
import { isMomentMs } from '../lib/util.js'
import { BACKUP_PREFIX, backupFileName, fmtBytes, isBackupFile, listBackups, readBackup, writeBackup } from '../lib/backup.js'

const labelOf = (provider) => ({ qodercn: 'Qoder 国内', trae: 'TRAE' }[provider] ?? provider)

test('whenLabel：同一天只给时刻，跨天才带日期', () => {
  const now = new Date(2026, 10, 9, 10, 30).getTime()
  const sameDay = new Date(2026, 10, 9, 21, 5).getTime()
  const otherDay = new Date(2026, 10, 8, 21, 0).getTime()
  assert.equal(whenLabel(sameDay, now), '21:05')
  assert.equal(whenLabel(otherDay, now), '11-08 21:00')
  assert.equal(whenLabel(0, now), '')
  assert.equal(whenLabel(undefined, now), '')
})

test('whenLabel：非法 now 回落到当前时间，不抛', () => {
  assert.equal(typeof whenLabel(Date.now(), undefined), 'string')
})

test('channelRows：用宿主原文，只把「本轮已处理」翻成人话', () => {
  const rows = channelRows([
    { provider: 'qodercn', text: '2 个 +200积分' },
    { provider: 'trae', text: '本轮已处理' },
    { provider: 'opencode', text: '无签到接口' },
    { provider: 'lobsterai', text: '1 个失败' },
    { provider: '', text: '脏数据' },
    { provider: 'astudio', text: '' },
  ], labelOf, true)
  assert.equal(rows.length, 4, '缺 provider 或 text 的条目要丢掉')
  assert.equal(rows[0].title, 'Qoder 国内')
  assert.equal(rows[0].trailing, '2 个 +200积分')
  assert.equal(rows[0].tone, 'good')
  assert.equal(rows[1].trailing, '已处理')
  assert.equal(rows[2].tone, 'muted')
  assert.equal(rows[3].tone, 'warn')
})

test('channelRows：非数组给空数组，不抛', () => {
  assert.deepEqual(channelRows(undefined, labelOf, true), [])
  assert.deepEqual(channelRows(null, labelOf, true), [])
})

test('runSummary：优先用宿主 lastResult，超长截断', () => {
  assert.equal(runSummary({ lastResult: '1 个渠道：2 个账号领取成功' }, true), '1 个渠道：2 个账号领取成功')
  assert.equal(runSummary({ running: true, lastResult: '旧结果' }, true), '正在签到…')
  assert.equal(runSummary({ ranToday: true }, true), '今天已跑过，还没有结果记录。')
  assert.equal(runSummary({}, true), '还没有跑过。')
  assert.equal(runSummary(undefined, true), '读不到上次结果。')
  const long = runSummary({ lastResult: 'x'.repeat(200) }, true)
  assert.equal(long.length, 120, '截断到 120 字以内')
})

test('backupFileName：文件名带前缀、不带冒号', () => {
  const name = backupFileName(new Date(2026, 10, 9, 10, 34, 52).getTime())
  assert.equal(name.startsWith(BACKUP_PREFIX), true)
  assert.equal(name.endsWith('.json'), true)
  assert.equal(name.includes(':'), false)
  assert.equal(isBackupFile(name), true)
})

test('isBackupFile：拒绝路径穿越与别的文件', () => {
  for (const bad of [
    '../jet-hub-backup-2026-11-09T10-00-00.json',
    '/etc/passwd',
    'jet-hub-backup-2026-11-09T10-00-00.json.tmp',
    'other.json',
    '',
    undefined,
  ]) {
    assert.equal(isBackupFile(bad), false, `不该接受：${String(bad)}`)
  }
})

test('fmtBytes：三档单位', () => {
  assert.equal(fmtBytes(12), '12 B')
  assert.equal(fmtBytes(2048), '2 KB')
  assert.equal(fmtBytes(2 * 1024 * 1024), '2 MB')
  assert.equal(fmtBytes(-1), '—')
  assert.equal(fmtBytes('abc'), '—')
})

test('备份读写：写进临时 DSH_HOME，读回来内容一致，权限收紧', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-backup-test-'))
  const saved = process.env.DSH_HOME
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_HOME = home
  // ⚠️ 手机上 /sdcard 恒存在，只改 DSH_HOME 仍会写进用户的 Download；
  // 这里显式把目录钉到临时目录里。
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  t.after(async () => {
    process.env.DSH_HOME = saved
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  })
  const payload = { format: 'dsh-codearts-auth/backup/v1', version: 1, accounts: [] }
  const file = await writeBackup(payload, new Date(2026, 10, 9, 10, 0, 0).getTime())
  assert.equal(file.name.startsWith(BACKUP_PREFIX), true)
  assert.deepEqual(await readBackup(file.name), payload)

  const listed = await listBackups()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].name, file.name)

  // 同一秒写两次不能互相覆盖（用户连点）。
  const second = await writeBackup(payload, new Date(2026, 10, 9, 10, 0, 0).getTime())
  assert.notEqual(second.name, file.name)
  assert.equal((await listBackups()).length, 2)

  // 白名单之外的路径一律拒绝。
  await assert.rejects(() => readBackup('../passwd'), /bad-backup-name/)
})

test('子页的两条渲染路径（data / peek）必须给出同一批字段', async (t) => {
  // 背景：这类页有两条渲染路径 —— `data` 走一次 IO，`peek` 在切页时用缓存。
  // 早先两处各写一遍字段构建，结果文案漂了（缓存路径的副标题丢了「N 个没记到
  // 期时间」），切页回来会闪一下再变回去。现在两处共用一个 buildFields，
  // 这个用例盯住「有人又把它拆成两份」。
  const home = await mkdtemp(join(tmpdir(), 'dsh-peek-test-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  t.after(async () => {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  })

  const { createBackupSection } = await import('../lib/panels/backup.js')
  const { createPermanentLockSection } = await import('../lib/panels/permanent-lock.js')

  // 用「读取成功」的 ctx：失败路径刻意不写缓存（peek 返回 undefined 是对的），
  // 那一路由下面「读失败要带原因」那个用例盯。
  const okCtx = {
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          const method = body?.payload?.method
          const value = method === 'backup.status'
            ? { accounts: 2, withoutExpiry: 0, accountList: [] }
            : { provider: 'trae', locked: false }
          return { json: async () => ({ result: { ok: true, value } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const sections = [
    ['backup', createBackupSection(okCtx), (s, emit) => s.data(emit, true, true, {})],
    ['lock', createPermanentLockSection(okCtx), (s, emit) => s.data(emit, true, true, {})],
  ]
  for (const [name, section, run] of sections) {
    let cold
    await run(section, (patch) => { cold = patch })
    assert.equal(typeof cold, 'object', `${name} 的 data 没推字段`)
    const warm = section.peek(true)
    assert.notEqual(warm, undefined, `${name} 的 peek 没有缓存`)
    assert.deepEqual(
      Object.keys(warm).sort(),
      Object.keys(cold).sort(),
      `${name} 的 data / peek 字段不一致（切页会闪）`,
    )
  }
})

test('子页读失败时把原因带给用户，不留一个干巴巴的「读不到」', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-fail-test-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  t.after(async () => {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  })

  const { createBackupSection } = await import('../lib/panels/backup.js')
  // RPC 全挂的 ctx：backup.status 一行都读不回来。
  const brokenCtx = {
    get: () => ({ createSharedFetchHandler: () => ({ fetch: async () => { throw new Error('rpc down') } }), browserPeer: {} }),
  }
  const section = createBackupSection(brokenCtx)
  let fields
  await section.data((patch) => { fields = patch }, true, true, {})
  assert.equal(fields.backupNoteTone, 'warn', '失败要标成警告')
  // ⚠️ 不能只匹配「读不到…：任意字符」—— 没有原因时文案会退化成
  // 「未知原因」，那种正则照样通过，等于一个恒真的假测试。
  assert.equal(
    fields.backupNote.includes('rpc down'),
    true,
    `失败说明里要带上真实原因，实际是：${fields.backupNote}`,
  )
  assert.equal(fields.backupNote.includes('未知原因'), false, '不该退化成「未知原因」')
})

test('时刻判据不把 Infinity / 超范围值当成有效时刻', () => {
  // 上游 JSON 里出现 `Infinity` 或超范围的值是现实存在的脏数据。用 `Number(v) > 0`
  // 判会让它们通过 —— 界面上就成了「永久限流 / 已封禁」，而格式化还会抛 RangeError。
  // 判据与 Jet Hub 内部的 `isValidResetAtMs` 一致。
  assert.equal(isMomentMs(Infinity), false)
  assert.equal(isMomentMs(9e15), false)
  assert.equal(isMomentMs(1e16), false)
  assert.equal(isMomentMs(NaN), false)
  assert.equal(isMomentMs(-1), false)
  assert.equal(isMomentMs(0), false)
  assert.equal(isMomentMs('1234'), false)
  assert.equal(isMomentMs(null), false)
  assert.equal(isMomentMs(undefined), false)
  // 正常值要照常通过。
  assert.equal(isMomentMs(1), true)
  assert.equal(isMomentMs(Date.now()), true)
})
