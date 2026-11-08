// 主机级开关：本机 OpenAI 网关、渠道原生搜索、ZCode 会话负载均衡。
//
// 这三样跟具体渠道无关，是 Jet Hub 页头 / 设置卡里的全局开关。它们并入管理面板
// 的「主机设置」子页（见 panels/host.js），不单独占面板入口 ——
// 但那一页不要求先选渠道，没渠道时也照样能进。
//
// 全部走 Jet Hub 的进程内 RPC，插件自己不监听端口、不读密钥文件。

import { callJetHub } from './jet-hub.js'

/** 网关状态：`{ enabled, running, blockedByEnv, allowLan, hostFromEnv, address, lastError, apiKey, modelsSource }`。 */
export const readGateway = (ctx) => callJetHub(ctx, 'gateway.getEnabled', {})

/** 开关网关。返回字段与 {@link readGateway} 一致（会带上最新的 apiKey）。 */
export const setGatewayEnabled = (ctx, enabled) => callJetHub(ctx, 'gateway.setEnabled', { enabled })

/** 允许局域网访问（绑 0.0.0.0）。`DSH_OPENAI_GATEWAY_HOST` 存在时本开关不生效。 */
export const setGatewayAllowLan = (ctx, allowLan) => callJetHub(ctx, 'gateway.setAllowLan', { allowLan })

/** 渠道原生搜索：开 = 有原生搜索的渠道走自己的接口，关 = 一律用官方搜索。 */
export const readNativeSearch = (ctx) => callJetHub(ctx, 'nativeSearch.getEnabled', {})
export const setNativeSearch = (ctx, enabled) => callJetHub(ctx, 'nativeSearch.setEnabled', { enabled })

/** ZCode 多账号按 sessionId 做会话亲和；关 = 回到手动顺序优先选号。 */
export const readSessionBalance = (ctx) => callJetHub(ctx, 'sessionBalance.getEnabled', {})
export const setSessionBalance = (ctx, enabled) => callJetHub(ctx, 'sessionBalance.setEnabled', { enabled })
