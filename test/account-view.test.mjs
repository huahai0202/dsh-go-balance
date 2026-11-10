// 账号 / 模型页的纯展示逻辑。跑法：node --test test/
//
// 这些函数是从 manage.js 的闭包里拆出来的：拆之前它们依赖模块级状态，
// 只能靠「起整个面板」间接测；拆出来后可以直接喂数据。
// 这一组里最重要的是脏值判据 —— `Infinity` 曾被当成「已封禁」。

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  accountCountFields,
  accountRowsOf,
  accountStatus,
  buildAccountDetail,
  fmtWhen,
  modelFieldsOf,
  nicknameOf,
  providerFields,
} from '../lib/panels/account-view.js'

const NOW = new Date(2026, 10, 9, 12, 0).getTime()

test('accountStatus：封禁 > 停用 > 过期 > 限流 > 正常', () => {
  assert.equal(accountStatus({ policyBlockedAtMs: NOW - 1000 }, NOW, true).label, '已封禁')
  assert.equal(accountStatus({ enabled: false }, NOW, true).label, '已停用')
  assert.equal(accountStatus({ expiresAt: NOW - 1000 }, NOW, true).label, '已过期')
  assert.equal(accountStatus({ modelRateLimits: { m1: NOW + 60_000 } }, NOW, true).label, '限流中')
  assert.equal(accountStatus({}, NOW, true).label, '正常')
})

test('accountStatus：Infinity / 超范围值不算封禁或限流', () => {
  // 真实脏值：上游 JSON 里出现 Infinity 时，旧判据 `Number(x) > 0` 会放行。
  const status = accountStatus({ policyBlockedAtMs: Infinity }, NOW, true)
  assert.equal(status.label, '正常', 'Infinity 不该被判成已封禁')
  const limited = accountStatus({ modelRateLimits: { m1: Infinity } }, NOW, true)
  assert.equal(limited.label, '正常', 'Infinity 不该被判成限流中')
  const expired = accountStatus({ expiresAt: 1e16 }, NOW, true)
  assert.equal(expired.label, '正常', '超范围值不该被判成已过期')
})

test('accountStatus：已过期的限流标记不算限流中', () => {
  const status = accountStatus({ modelRateLimits: { m1: NOW - 1 } }, NOW, true)
  assert.equal(status.label, '正常')
})

test('accountStatus：英文标签', () => {
  assert.equal(accountStatus({ enabled: false }, NOW, false).label, 'Disabled')
  assert.equal(accountStatus({}, NOW, false).label, 'OK')
})

test('nicknameOf：昵称 → 账号名 → id，绝不返回空串', () => {
  assert.equal(nicknameOf({ nickname: 'A', accountName: 'B', id: 'C' }), 'A')
  assert.equal(nicknameOf({ accountName: 'B', id: 'C' }), 'B')
  assert.equal(nicknameOf({ id: 'C' }), 'C')
  assert.equal(nicknameOf({}), '')
  assert.equal(nicknameOf(undefined), '')
})

test('fmtWhen：无效时刻给空串，不让调用方拿到 Invalid Date', () => {
  assert.equal(fmtWhen(undefined), '')
  assert.equal(fmtWhen(Infinity), '')
  assert.equal(fmtWhen(0), '')
  assert.equal(fmtWhen(NaN), '')
  assert.equal(typeof fmtWhen(Date.now()), 'string')
})

test('accountCountFields：总数 / 启用 / 停用三者自洽', () => {
  const fields = accountCountFields([{ enabled: true }, { enabled: false }, {}], true)
  assert.deepEqual(fields, { accountCount: '3', accountEnabledCount: '2', accountDisabledCount: '1' })
  assert.deepEqual(accountCountFields(undefined, true), { accountCount: '0', accountEnabledCount: '0', accountDisabledCount: '0' })
})

test('accountRowsOf：普通模式挂打开动作，排序模式挂勾选动作', () => {
  const accounts = [{ id: 'a1', nickname: '一号' }, { id: 'a2', nickname: '二号' }]
  const normal = accountRowsOf(accounts, NOW, true)
  assert.equal(normal[0].action.id, 'account-open')
  assert.deepEqual(normal[0].action.args, { account: 'a1' })

  const reorder = accountRowsOf(accounts, NOW, true, true, new Set(['a2']))
  assert.equal(reorder[0].title, '1. 一号', '排序页带序号')
  assert.equal(reorder[0].action.id, 'reorder-toggle')
  assert.equal(reorder[0].trailing, '未选中')
  assert.equal(reorder[1].trailing, '已选中')
  assert.equal(reorder[1].tone, 'good')
})

test('accountRowsOf：没有 id 的账号不给动作（点了也没反应）', () => {
  const rows = accountRowsOf([{ nickname: 'x' }], NOW, true)
  assert.equal(rows[0].action, undefined)
})

test('buildAccountDetail：没有可用的到期时刻写「无」', () => {
  const rowOf = (detail) => detail.rows.find((row) => row[0] === '到期')?.[1]
  assert.equal(rowOf(buildAccountDetail({ id: 'a' }, 'trae', NOW, true)), '无')
  assert.equal(rowOf(buildAccountDetail({ id: 'a', expiresAt: 1e16 }, 'trae', NOW, true)), '无', '超范围脏值同样按「无」')
  assert.equal(rowOf(buildAccountDetail({ id: 'a', expiresAt: Infinity }, 'trae', NOW, true)), '无')
  // 有效时刻才给日期。
  assert.match(rowOf(buildAccountDetail({ id: 'a', expiresAt: NOW + 86_400_000 }, 'trae', NOW, true)), /\d{2}\/\d{2}/)
})

test('buildAccountDetail：只在该出现时补附加行', () => {
  const base = buildAccountDetail({ id: 'a', nickname: 'n' }, 'trae', NOW, true)
  assert.equal(base.rows.some((row) => row[0] === '选号顺序'), false, '没给 position 就不写顺序')
  assert.equal(base.rows.some((row) => row[0] === '封禁原因'), false)

  const full = buildAccountDetail({
    id: 'a',
    nickname: 'n',
    policyBlockedAtMs: NOW - 1,
    policyBlockedMessage: '异常行为',
    modelRateLimits: { m1: NOW + 600_000 },
    phone: '13800000000',
    accountName: '账号名',
  }, 'trae', NOW, true, 2)
  assert.equal(full.rows.find((row) => row[0] === '选号顺序')[1], '第 3 位')
  assert.equal(full.rows.find((row) => row[0] === '封禁原因')[1], '异常行为')
  assert.equal(full.rows.some((row) => row[0] === '限流'), true)
  assert.equal(full.rows.some((row) => row[0] === '手机号'), true)
  assert.equal(full.headline, 'TRAE · n')
})

test('buildAccountDetail：停用账号的按钮是「启用」', () => {
  assert.equal(buildAccountDetail({ id: 'a', enabled: false }, 'trae', NOW, true).toggleLabel, '启用账号')
  assert.equal(buildAccountDetail({ id: 'a' }, 'trae', NOW, true).toggleLabel, '停用账号')
})

test('providerFields：读不到状态时按未知渲染，不冒充「已开启」', () => {
  const unknown = providerFields(undefined, true)
  assert.equal(unknown.providerTrailing, '—')
  assert.equal(unknown.providerTone, 'warn')
  assert.equal(unknown.providerSubtitle, '读不到状态')
})

test('providerFields：关闭与开启的语气不同', () => {
  const closed = providerFields({ closed: true, models: { total: 3, disabled: 3 }, accounts: { total: 2, enabled: 0 } }, true)
  assert.equal(closed.providerTrailing, '已关闭')
  assert.equal(closed.providerTone, 'muted')
  assert.equal(closed.providerSubtitle, '3/3 个模型关闭 · 0/2 个账号启用')

  const open = providerFields({ closed: false, models: { total: 3, disabled: 1 }, accounts: { total: 2, enabled: 2 } }, true)
  assert.equal(open.providerTrailing, '已开启')
  assert.equal(open.providerTone, 'good')
})

test('modelFieldsOf：三个分组的计数与字段一致', () => {
  const models = [
    { id: 'm1', name: 'M1' },
    { id: 'm2', name: 'M2', disabled: true },
    { id: 'm3', name: 'M3', dead: true },
  ]
  const { rows, fields } = modelFieldsOf(models, 'trae', true)
  assert.deepEqual(rows, { on: 1, off: 1, dead: 1 })
  assert.equal(fields.modelOnCount, '1')
  assert.equal(fields.modelOffCount, '1')
  assert.equal(fields.modelDeadCount, '1')
  assert.equal(fields.modelOnItems.length, 1)
  assert.equal(fields.modelGroupOnLabel, '已开启 1')
})

test('modelFieldsOf：已失效的模型不给开关动作', () => {
  const { fields } = modelFieldsOf([{ id: 'm1', dead: true }], 'trae', true)
  assert.equal(fields.modelDeadItems[0].action, undefined, '失效条目只能看')
  const onRow = modelFieldsOf([{ id: 'm2' }], 'trae', true).fields.modelOnItems[0]
  assert.deepEqual(onRow.action, { id: 'model-toggle', args: { model: 'm2', next: true } })
})

test('modelFieldsOf：模型名与 id 不同时才补第二行', () => {
  const same = modelFieldsOf([{ id: 'm1', name: 'm1' }], 'trae', true).fields.modelOnItems[0]
  assert.equal(same.subtitle, undefined)
  const diff = modelFieldsOf([{ id: 'm1', name: 'DeepSeek' }], 'trae', true).fields.modelOnItems[0]
  assert.equal(diff.subtitle, 'm1')
})

test('modelFieldsOf：空目录给一句说明而不是空白', () => {
  const { fields } = modelFieldsOf([], 'trae', true)
  assert.equal(fields.modelPageText, '')
  assert.equal(fields.modelNote, '这个渠道没有可开关的模型。')
})

test('modelFieldsOf：外部 note 优先，且标成 warn', () => {
  const { fields } = modelFieldsOf([{ id: 'm1' }], 'trae', true, '写入有警告')
  assert.equal(fields.modelNote, '写入有警告')
  assert.equal(fields.modelNoteTone, 'warn')
})

test('详情页状态行：停用不能盖掉「已过期 / 已封禁」', () => {
  // 真实缺陷：`accountStatus` 在停用时会提前返回「已停用」，于是「停用 + 已过期」
  // 的账号在详情页只显示「已停用」，过期信息整个丢了 —— 用户排查「这个号为什么
  // 用不了」时看到「已停用」，自然会以为是没启用，而不是凭据过期。
  // 停用只是开关态，和过期 / 封禁是两回事，必须并列显示。
  const now = Date.now()
  const statusOf = (account) => buildAccountDetail(account, 'trae', now, true)
    .rows.find((row) => row[0] === '状态')?.[1]

  assert.equal(statusOf({ id: 'a', nickname: '甲', enabled: true, expiresAt: now + 86_400_000 }), '正常')
  assert.equal(statusOf({ id: 'b', nickname: '乙', enabled: false, expiresAt: now + 86_400_000 }), '已停用')
  assert.equal(statusOf({ id: 'c', nickname: '丙', enabled: false, expiresAt: now - 1000 }), '已停用 · 已过期')
  assert.equal(statusOf({ id: 'd', nickname: '丁', enabled: false, policyBlockedAtMs: now - 1000 }), '已停用 · 已封禁')
  // 启用但过期：照旧只报过期。
  assert.equal(statusOf({ id: 'e', nickname: '戊', enabled: true, expiresAt: now - 1000 }), '已过期')
})
