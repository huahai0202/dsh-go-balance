// 新增功能的单测：签到结果展示、状态条文案、备份文件名与内容校验。
//
// 跑法：node --test test/
//
// 这一组都是纯函数 / 只碰临时目录，不依赖宿主；面板级的契约由
// data-contract.test.mjs 覆盖（那里已经把 lock / backup 两页加进去了）。

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { isMomentMs } from '../lib/util.js'
import {
  BACKUP_FORMAT,
  BACKUP_PREFIX,
  BACKUP_VERSION,
  backupFileName,
  fmtBytes,
  isBackupFile,
  parseBackupBytes,
  writeBackup,
} from '../lib/backup.js'

test('backupFileName：文件名带前缀、不带冒号', () => {
  const name = backupFileName(new Date(2026, 10, 9, 10, 34, 52).getTime())
  assert.equal(name.startsWith(BACKUP_PREFIX), true)
  assert.equal(name.endsWith('.json'), true)
  assert.equal(name.includes(':'), false)
  assert.equal(isBackupFile(name), true)
})

test('isBackupFile：拒绝路径穿越与别的文件（导出侧起名用）', () => {
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

test('parseBackupBytes：只认内容，改名 / 换目录照样能用', () => {
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(2026, 10, 9, 10, 0, 0).toISOString(),
    credentials: { r1: { token: 'x' } },
    accounts: [{ id: 'a1', provider: 'trae', credentialRef: 'r1' }],
    disabledModels: {},
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  assert.deepEqual(parseBackupBytes(bytes), payload)
  // 文件名跟校验无关：这不是路径，任何名字都该按内容判定。
  assert.equal(BACKUP_FORMAT, 'dsh-codearts-auth/backup')
})

test('parseBackupBytes：坏文件给出可分辨的原因，别让上游半路拒绝', () => {
  const enc = (v) => new TextEncoder().encode(typeof v === 'string' ? v : JSON.stringify(v))
  const base = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-11-09T10:00:00.000Z',
    credentials: {},
    accounts: [],
  }
  const cases = [
    [enc('not json'), /not-json/],
    [new Uint8Array([0xff, 0xfe, 0x00]), /not-utf8/],
    [enc([]), /not-object/],
    [enc({ ...base, format: 'other/backup' }), /wrong-format/],
    [enc({ ...base, version: 2 }), /wrong-version/],
    [enc({ ...base, exportedAt: undefined }), /no-exported-at/],
    [enc({ ...base, credentials: [] }), /bad-credentials/],
    [enc({ ...base, accounts: {} }), /bad-accounts/],
  ]
  for (const [bytes, pattern] of cases) {
    assert.throws(() => parseBackupBytes(bytes), pattern, `应该拒绝：${String(pattern)}`)
  }
})

test('fmtBytes：三档单位', () => {
  assert.equal(fmtBytes(12), '12 B')
  assert.equal(fmtBytes(2048), '2 KB')
  assert.equal(fmtBytes(2 * 1024 * 1024), '2 MB')
  assert.equal(fmtBytes(-1), '—')
  assert.equal(fmtBytes('abc'), '—')
})

test('导出：写进临时目录，文件名唯一、权限 0600', async (t) => {
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
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-11-09T10:00:00.000Z',
    credentials: {},
    accounts: [],
  }
  const file = await writeBackup(payload, new Date(2026, 10, 9, 10, 0, 0).getTime())
  assert.equal(file.name.startsWith(BACKUP_PREFIX), true)
  // 导出的文件本身也是一份能被自己吃回来的备份。
  assert.deepEqual(parseBackupBytes(new Uint8Array(await readFile(file.path))), payload)
  const mode = (await stat(file.path)).mode & 0o777
  assert.equal(mode, 0o600, '凭据文件只能是本进程可读')

  // 同一秒写两次不能互相覆盖（用户连点）。
  const second = await writeBackup(payload, new Date(2026, 10, 9, 10, 0, 0).getTime())
  assert.notEqual(second.name, file.name)
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

test('恢复：选中文件后校验内容，坏文件给可读提示、不留选中状态', async () => {
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const good = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-11-09T10:00:00.000Z',
    credentials: {},
    accounts: [{ id: 'a1', provider: 'trae' }],
  }
  let bytes = new TextEncoder().encode(JSON.stringify(good))
  let imports = 0
  const ctx = {
    // 桥接的 readPickedFile：只在这次回调里有效，返回一次性字节快照。
    dshGo: { readPickedFile: (handle) => (handle === 'h1' ? bytes : (() => { throw new Error('picked file is no longer readable') })()) },
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          const method = body?.payload?.method
          if (method === 'backup.import') {
            imports += 1
            return { json: async () => ({ result: { ok: true, value: { accountsImported: 1, credentialsImported: 1 } } }) }
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 1, withoutExpiry: 0 } } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const section = createBackupSection(ctx)
  // 先把读数缓存热起来：peek 只在读过一次之后才有内容。
  await section.data(() => {}, true, true, {})
  const pickedEvent = (status = 'selected', name = 'my-backup.json') => ({
    locale: 'zh-CN',
    value: status === 'selected'
      ? { status, files: [{ handle: 'h1', name, bytes: bytes.length, mediaType: 'application/json', access: 'read' }] }
      : { status, files: [] },
  })

  // 坏文件：把字节换掉，提示要说人话，且不能留下「已选」状态。
  const goodBytes = bytes
  bytes = new TextEncoder().encode('{"hello":1}')
  const bad = await section.actions['backup-picked']({}, pickedEvent())
  assert.equal(JSON.stringify(bad).includes('不是'), true, `坏文件要给出可读原因，实际：${JSON.stringify(bad)}`)
  assert.equal(section.peek(true).backupPickedRows.length, 0, '坏文件不该留下选中状态')

  // 好文件：改名也能认（校验只看内容）。
  bytes = goodBytes
  await section.actions['backup-picked']({}, pickedEvent('selected', '换了个名字.json'))
  const rows = section.peek(true).backupPickedRows
  const text = JSON.stringify(rows)
  assert.equal(text.includes('换了个名字.json'), true, `选中行要带上文件名，实际：${text}`)
  assert.equal(text.includes('1 个账号'), true, `要显示文件里的账号数，实际：${text}`)

  // 确认前不能动手：没点确认就调 restore 之外的动作不会导入。
  assert.equal(imports, 0)

  // 取消 = 不导入，并且把选中状态一并作废（否则会留下一个没有确认入口的残局）。
  await section.actions['backup-restore-confirm']({}, { locale: 'zh-CN', value: { confirmed: false } })
  assert.equal(imports, 0, '取消不该触发导入')
  assert.equal(section.peek(true).backupPickedRows.length, 0, '取消后不该还挂着「已选」')

  // 取消之后要重新选一次，才能再次确认。
  await section.actions['backup-picked']({}, pickedEvent('selected', '换了个名字.json'))
  assert.notEqual(section.peek(true).backupPickedRows.length, 0, '重选之后应当又是待确认')

  // 真确认：走 replace 分支也要先切模式。
  await section.actions['backup-mode']({}, { locale: 'zh-CN' })
  const pending = section.actions['backup-restore-confirm']({}, { locale: 'zh-CN', value: { confirmed: true } })
  assert.equal(typeof pending.result, 'function', '确认后应当是延后结果')
  await pending.result()
  assert.equal(imports, 1, '确认后应当导入一次')
})

test('导出连点：同一毫秒写多份也不覆盖、不重名', async (t) => {
  // 背景：用户连点导出是常态。早先用「写失败抛 EEXIST」探测重名，第 n 次要先
  // 失败 n 次，异常一次几毫秒 —— 连点十几次会滚成几十毫秒。现在改成内存记账。
  const home = await mkdtemp(join(tmpdir(), 'dsh-fast-backup-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  t.after(async () => {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  })
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-11-09T10:00:00.000Z',
    credentials: {},
    accounts: [],
  }
  const at = new Date(2026, 10, 9, 10, 0, 0).getTime()
  const names = []
  for (let i = 0; i < 8; i += 1) names.push((await writeBackup(payload, at)).name)
  assert.equal(new Set(names).size, names.length, `连点产生了重名：${names.join(', ')}`)
  // 每一份都真的在盘上、内容都完整。
  for (const name of names) {
    const text = await readFile(join(home, 'backups', name), 'utf8')
    assert.deepEqual(JSON.parse(text), payload)
  }
})

test('选定文件后视图必须同时给出确认框（不能只给模式按钮）', async () => {
  // 真实缺陷：早先选好文件后只渲染「改用整体替换」，而提示条写着「点确认恢复
  // 才会动手」—— 那个按钮根本没画出来，用户必须先点模式切换。这里盯住：
  // 只要有选中文件，视图里就必须同时有 confirm 和模式切换入口，且默认是合并。
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-11-09T10:00:00.000Z',
    credentials: {},
    accounts: [{ id: 'a1', provider: 'trae' }],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const ctx = {
    dshGo: { readPickedFile: () => bytes },
    get: () => ({
      createSharedFetchHandler: () => ({ fetch: async () => ({ json: async () => ({ result: { ok: true, value: { accounts: 1, withoutExpiry: 0 } } }) }) }),
      browserPeer: {},
    }),
  }
  const section = createBackupSection(ctx)
  await section.data(() => {}, true, true, {})

  const flatten = (node, out = []) => {
    if (Array.isArray(node)) { for (const c of node) flatten(c, out); return out }
    if (node && typeof node === 'object') {
      if (typeof node.type === 'string') out.push(node)
      for (const v of Object.values(node)) flatten(v, out)
    }
    return out
  }

  // 选之前：两个入口，没有确认框。
  const before = flatten(section.view(true))
  assert.equal(before.some((n) => n.type === 'confirm'), false, '没选文件时不该有确认框')

  await section.actions['backup-picked']({}, {
    locale: 'zh-CN',
    value: { status: 'selected', files: [{ handle: 'h1', name: 'b.json', bytes: bytes.length, mediaType: 'application/json', access: 'read' }] },
  })

  const after = flatten(section.view(true))
  const confirm = after.find((n) => n.type === 'confirm')
  assert.notEqual(confirm, undefined, '选定文件后必须有确认框')
  assert.equal(confirm.id, 'backup-restore-confirm')
  // 模式切换还在，但现在是单选组件（`options`），不再是「改成另一种」的按钮。
  assert.equal(
    after.some((n) => n.type === 'options' && n.id === 'backup-mode'),
    true,
    '恢复方式的单选要还在',
  )
  // 默认合并：数据里的模式说明要说「只追加新账号」，不能默认替换。
  // 视图里 callout 的 text 现在是绑定（`data.backupModeHint`），所以查数据。
  assert.equal(section.peek(true).backupMode, 'merge', '默认应为合并模式')
  assert.equal(
    section.peek(true).backupModeHint.includes('只追加新账号'),
    true,
    `默认应为合并模式，实际说明：${section.peek(true).backupModeHint}`,
  )
  // 单选的两个选项都要在，且当前值能被标出。
  const opts = after.find((n) => n.type === 'options')
  assert.notEqual(opts, undefined, '要有恢复方式的单选')
  // ⚠️ 这里的 id 必须是注册过的动作名；写错（例如 backup-mode-options）点一下就报错。
  assert.equal(opts.id, 'backup-mode')
  assert.equal(typeof section.actions['backup-mode'], 'function', 'options.id 必须对应一个已注册的动作')
})

test('导出不再挂 pending 白条：同步返回刷新与提示', async () => {
  // 背景：桥接的 pending 收尾只发在原 WebSocket 上，连接一断客户端就永远等不到
  // `done`，白条会挂到本地超时 —— 看起来像「导出卡住了」，其实早完成了。
  // 现在导出直接同步做完；代价是必须在 3 秒内返回（桥接 handlerTimeoutMs）。
  const { createBackupSection } = await import('../lib/panels/backup.js')
  let exported = 0
  const ctx = {
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          const method = body?.payload?.method
          if (method === 'backup.export') {
            exported += 1
            return {
              json: async () => ({
                result: {
                  ok: true,
                  value: {
                    payload: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', credentials: {}, accounts: [] },
                    warnings: [],
                  },
                },
              }),
            }
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 0, withoutExpiry: 0 } } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-export-fast-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  try {
    const section = createBackupSection(ctx)
    const result = await section.actions['backup-export']({}, { locale: 'zh-CN' })
    assert.equal(exported, 1, '应当真的导出一次')
    assert.equal(
      result?.pending,
      undefined,
      `导出不该再返回 pending（会留下收不回的提示条），实际：${JSON.stringify(result)}`,
    )
    const effects = Array.isArray(result) ? result : [result]
    assert.equal(effects.some((e) => e.refresh === 'manage'), true, '成功要刷新面板')
    assert.equal(effects.some((e) => typeof e.toast === 'string'), true, '成功要有提示')
  } finally {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  }
})

test('结果提示会自己消失，且「0 新增」不说成「已恢复」', async (t) => {
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const payload = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '2026-11-09T10:00:00.000Z',
    credentials: {},
    accounts: [{ id: 'a1', provider: 'trae' }],
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const mkCtx = (importResult) => ({
    dshGo: { readPickedFile: () => bytes },
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          if (body?.payload?.method === 'backup.import') {
            return { json: async () => ({ result: { ok: true, value: importResult } }) }
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 1, withoutExpiry: 0 } } }) }
        },
      }),
      browserPeer: {},
    }),
  })

  // 1) 全部已存在（用户实测踩到的情形）：措辞要中性，不能说成「已恢复」。
  const section = createBackupSection(mkCtx({ accountsImported: 0, credentialsImported: 0, accountsSkipped: ['a1'] }))
  await section.data(() => {}, true, true, {})
  await section.actions['backup-picked']({}, {
    locale: 'zh-CN',
    value: { status: 'selected', files: [{ handle: 'h1', name: 'b.json', bytes: bytes.length, mediaType: 'application/json', access: 'read' }] },
  })
  const pending = section.actions['backup-restore-confirm']({}, { locale: 'zh-CN', value: { confirmed: true } })
  await pending.result()
  // 导入后缓存被作废（账号集合变了），得重新读一次才有 peek 内容。
  await section.data(() => {}, true, true, {})
  const fields = section.peek(true)
  assert.notEqual(fields, undefined, '重新读一次之后应当有缓存')
  assert.equal(fields.backupNote.includes('没有改动'), true, `0 新增要说清没改动，实际：${fields.backupNote}`)
  assert.equal(fields.backupNoteTone, 'info', '0 新增不该打绿标')
})

test('结果提示在到期后自动清掉（不用人管）', async (t) => {
  // 用假定时器把 30 秒直接跳过：真等 30 秒会把测试拖垮。
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const ctx = {
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          if (body?.payload?.method === 'backup.export') {
            return { json: async () => ({ result: { ok: true, value: {
              payload: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', credentials: {}, accounts: [] },
              warnings: [],
            } } }) }
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 0, withoutExpiry: 0 } } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-note-ttl-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  try {
    const section = createBackupSection(ctx)
    await section.data(() => {}, true, true, {})
    await section.actions['backup-export']({}, { locale: 'zh-CN' })
    assert.equal(section.peek(true).backupNote.includes('已导出'), true, '导出后应当有结果提示')
    // 跳 31 秒：提示应当自己收走。
    t.mock.timers.tick(31_000)
    const after = section.peek(true).backupNote
    assert.equal(after.includes('已导出'), false, `到期后提示该消失，实际：${after}`)
    assert.equal(after.includes('凭据'), true, '消失后要回到默认说明')
  } finally {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  }
})

test('多选导出：行数不受 8 项限制，选中的 id 原样传给上游', async () => {
  // 用 `options` 组件做不到：它最多 8 项，账号常有十几个。这里用「点行勾选」。
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, provider: 'trae', nickname: `账号${i}`, enabled: i !== 3 }))
  let sentIds
  const ctx = {
    get: () => ({
      createSharedFetchHandler: () => ({
        fetch: async (request) => {
          const body = JSON.parse(await request.text())
          if (body?.payload?.method === 'backup.export') {
            sentIds = body.payload.payload.accountIds
            return { json: async () => ({ result: { ok: true, value: {
              payload: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', credentials: {}, accounts: [] },
              warnings: [],
            } } }) }
          }
          return { json: async () => ({ result: { ok: true, value: { accounts: 12, withoutExpiry: 0, accountList: accounts } } }) }
        },
      }),
      browserPeer: {},
    }),
  }
  const home = await mkdtemp(join(tmpdir(), 'dsh-multi-'))
  const savedDir = process.env.DSH_GO_BACKUP_DIR
  process.env.DSH_GO_BACKUP_DIR = join(home, 'backups')
  try {
    const section = createBackupSection(ctx)
    await section.data(() => {}, true, true, {})
    assert.equal(section.peek(true).backupAccountRows.length, 0, '没进选择模式不该画行')

    await section.actions['backup-select-mode']({}, { locale: 'zh-CN' })
    await section.data(() => {}, true, true, {})
    const rows = section.peek(true).backupAccountRows
    assert.equal(rows.length, 12, '12 个账号都要能列出来（options 组件只能 8 个）')
    // 停用账号也要在列表里，只是副标题标出来。
    assert.equal(rows[3].subtitle.includes('已停用'), true, `停用账号要标注，实际：${rows[3].subtitle}`)

    await section.actions['backup-select-toggle']({}, { locale: 'zh-CN', value: { account: 'a0' } })
    await section.actions['backup-select-toggle']({}, { locale: 'zh-CN', value: { account: 'a5' } })
    await section.data(() => {}, true, true, {})
    assert.equal(section.peek(true).backupExportSelectedLabel.includes('2'), true, '按钮要显示选中数')

    await section.actions['backup-export-selected']({}, { locale: 'zh-CN' })
    assert.deepEqual(sentIds, ['a0', 'a5'], '选中的 id 要原样传给上游')

    // 一个都不选 = 导出全部（传 undefined，不是空数组）。
    await section.actions['backup-select-all']({}, { locale: 'zh-CN' })  // 全选
    await section.actions['backup-select-all']({}, { locale: 'zh-CN' })  // 再点一次清空
    await section.data(() => {}, true, true, {})
    sentIds = 'unset'
    await section.actions['backup-export-selected']({}, { locale: 'zh-CN' })
    assert.equal(sentIds, undefined, `空选应导出全部（accountIds 不传），实际：${JSON.stringify(sentIds)}`)
  } finally {
    if (savedDir === undefined) delete process.env.DSH_GO_BACKUP_DIR
    else process.env.DSH_GO_BACKUP_DIR = savedDir
    await rm(home, { recursive: true, force: true })
  }
})

test('视图引用的每个动作都必须已注册（含 options/confirm 的 id）', async () => {
  // 真实缺陷：`options` 组件的 `id` **就是**点选后调用的动作名。我把组件 id 写成
  // `backup-mode-options`、动作注册成 `backup-mode`，结果点「整体替换」直接报错。
  // 桥接只认 actions[id]，写错不会有编译期提示，只能靠这类断言兜住。
  const { createBackupSection } = await import('../lib/panels/backup.js')
  const payload = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: 'x', credentials: {}, accounts: [{ id: 'a1' }] }
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  const ctx = {
    dshGo: { readPickedFile: () => bytes },
    get: () => ({
      createSharedFetchHandler: () => ({ fetch: async () => ({ json: async () => ({ result: { ok: true, value: { accounts: 9, withoutExpiry: 0, accountList: [{ id: 'a1', provider: 'trae', nickname: 'n' }] } } }) }) }),
      browserPeer: {},
    }),
  }
  const section = createBackupSection(ctx)
  await section.data(() => {}, true, true, {})

  /** 视图里所有会被点到的动作 id。 */
  const refs = (node, out = new Set()) => {
    if (Array.isArray(node)) { for (const n of node) refs(n, out); return out }
    if (node === null || typeof node !== 'object') return out
    // options / confirm 用 id；actions / list 行用 action。
    if ((node.type === 'options' || node.type === 'confirm') && typeof node.id === 'string') out.add(node.id)
    if (typeof node.action === 'string') out.add(node.action)
    if (node.action && typeof node.action === 'object' && typeof node.action.id === 'string') out.add(node.action.id)
    for (const value of Object.values(node)) refs(value, out)
    return out
  }

  const registered = new Set(Object.keys(section.actions))
  const check = (label) => {
    const missing = [...refs(section.view(true))].filter((id) => !registered.has(id))
    assert.deepEqual(missing, [], `${label}：这些动作被视图引用但没有注册 → 点了会报错：${missing.join(', ')}`)
  }

  check('初始视图')
  // 逐个状态都要查一遍：不同状态下渲染的是不同的分支。
  await section.actions['backup-export-menu']({}, { locale: 'zh-CN' })
  check('导出菜单展开')
  await section.actions['backup-select-mode']({}, { locale: 'zh-CN' })
  check('选账号模式')
  await section.actions['backup-pick']({}, { locale: 'zh-CN' })
  await section.actions['backup-picked']({}, {
    locale: 'zh-CN',
    value: { status: 'selected', files: [{ handle: 'h1', name: 'b.json', bytes: bytes.length, mediaType: 'application/json', access: 'read' }] },
  })
  check('选定待确认')
  // 这个状态里必须包含单选的 id，且它指向真实动作。
  const opts = refs(section.view(true))
  assert.equal(opts.has('backup-mode'), true, '恢复方式单选的 id 必须是 backup-mode')
  assert.equal(registered.has('backup-mode'), true)
})
