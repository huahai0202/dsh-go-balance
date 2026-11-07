// 渠道余额插件入口：把三个面板挂到 dsh-go。
//
// - panels/balance.js  余额 + 一键签到
// - panels/manage.js   模型开关 + 账号管理（顶部标签页）
// - panels/channels.js 渠道选择
// - panels/host.js     主机设置（网关 / 原生搜索 / 会话分流）

//
// 三个面板共享的状态在 runtime.js，Jet Hub / Codex 的调用分别在 jet-hub.js、codex.js。

import { createRuntime } from './runtime.js'
import { registerBalance } from './panels/balance.js'
import { registerManage } from './panels/manage.js'
import { registerChannels } from './panels/channels.js'
import { registerHostPanel } from './panels/host.js'

export const name = 'local-balance'

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    const r = createRuntime(ctx)
    registerBalance(ctx, r)
    registerManage(ctx, r)
    registerChannels(ctx, r)
    registerHostPanel(ctx, r)
  })
}
