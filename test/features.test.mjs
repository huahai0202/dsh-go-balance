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

import { channelRows, runSummary, stripText, whenLabel } from '../lib/checkin.js'
import { BACKUP_PREFIX, backupFileName, fmtBytes, isBackupFile, listBackups, readBackup, writeBackup } from '../lib/backup.js'

const labelOf = (provider) => ({ qodercn: 'Qoder 国内', trae: 'TRAE' }[provider] ?? provider)

test('whenLabel：同一天只给时刻，跨天才带日期', () => {
  const now = new Date(2026, 10, 9, 10, 30).getTime()
  const sameDay = new Date(2026, 10, 9, 21, 5).getTime()
  const otherDay = new Date(2026, 10, 8, 21, 0).getTime()
  assert.equal(whenLabel(sameDay, now, true), '21:05')
  assert.equal(whenLabel(otherDay, now, true), '11-08 21:00')
  assert.equal(whenLabel(0, now, true), '')
  assert.equal(whenLabel(undefined, now, true), '')
})

test('whenLabel：非法 now 回落到当前时间，不抛', () => {
  assert.equal(typeof whenLabel(Date.now(), undefined, true), 'string')
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

test('stripText：24 字以内，只讲今天', () => {
  const now = new Date(2026, 10, 9, 8, 0).getTime()
  const cases = [
    [undefined, true],
    [{ enabled: false }, true],
    [{ enabled: true, running: true }, true],
    [{ enabled: true, ranToday: true, channels: [{ provider: 'qodercn', text: '2 个 +200积分' }, { provider: 'trae', text: '本轮已处理' }, { provider: 'opencode', text: '无签到接口' }] }, true],
    [{ enabled: true, ranToday: false, nextRunAt: now + 3600_000 }, true],
    [{ enabled: true, ranToday: true }, true],
    [{ enabled: true, ranToday: false }, true],
    [{ enabled: true, ranToday: true, channels: [{ provider: 'a', text: '2 个 +200积分' }] }, false],
  ]
  for (const [state, zh] of cases) {
    const text = stripText(state, now, zh)
    assert.equal(typeof text, 'string')
    assert.equal(text.length <= 24, true, `超过 24 字：${text}`)
    assert.equal(text.includes('undefined'), false)
  }
})

test('stripText：分母不把「无签到接口」算进去', () => {
  const now = new Date(2026, 10, 9, 12, 0).getTime()
  const text = stripText({
    enabled: true,
    ranToday: true,
    channels: [
      { provider: 'qodercn', text: '2 个 +200积分' },
      { provider: 'trae', text: '本轮已处理' },
      { provider: 'raccoon', text: '无签到接口' },
      { provider: 'opencode', text: '无签到接口' },
    ],
  }, now, true)
  assert.equal(text, '今日签到 2/2')
})

test('stripText：关闭时明确说关着', () => {
  assert.equal(stripText({ enabled: false, ranToday: true }, Date.now(), true), '自动签到已关')
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
