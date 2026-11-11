// 渠道余额插件入口：把三个面板挂到 dsh-go。
//
// - panels/balance.js  余额 + 一键签到
// - panels/manage.js   管理（模型开关 / 账号管理 / 锁定永久积分 /
//                      主机设置 / 备份与恢复）
// - panels/channels.js 渠道选择
//
// manage 的子页各自一个文件（panels/host.js、panels/permanent-lock.js、
// panels/backup.js），由 manage 当成子页面挂进去，
// 不单独注册成面板。
//
// 三个面板共享的状态在 runtime.js，Jet Hub / Codex 的调用分别在 jet-hub.js、codex.js，
// 备份落盘在 backup.js。

import { createRuntime } from './runtime.js'
import { registerBalance } from './panels/balance.js'
import { registerManage } from './panels/manage.js'
import { registerChannels } from './panels/channels.js'

export const name = 'local-balance'

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const r = createRuntime(ctx)
    registerBalance(ctx, r)
    registerManage(ctx, r)
    registerChannels(ctx, r)
  })
}
