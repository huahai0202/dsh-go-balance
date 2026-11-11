// 插件自己的小状态：上次选中的渠道（渠道选择器已改成独立面板）。
//
// ⚠️ 不放在插件目录里：那个目录是以 link 方式装进 profile 的，卸载 / 重装 / 换
// profile 时会被当成包的一部分处理，状态会跟着走丢。放在 `$DSH_HOME/dsh-go/`
// 下，和插件本体的生命周期分开。
//
// 写失败一律吞掉：这只是「下次打开时记得住」的便利，不该让面板报错。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 状态目录按调用时解析：测试可以改 `DSH_HOME` 后再起 runtime，不必重载模块。 */
const stateDir = () => join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-go')
const statePath = () => join(stateDir(), 'local-balance.json')

const DEFAULTS = Object.freeze({ picked: 'current' })

/**
 * 渠道列表的快照。
 *
 * 探测一次要发 `provider.getOrder` + `provider.status`（冷目录最长 2s），而引擎
 * 每次重启缓存就没了 —— 用户每次重开 App 第一次点「渠道」都得干等。快照存在这
 * 里，启动后先拿它开窗，再后台探一遍覆盖（stale-while-revalidate）。
 */
const channelsPath = () => join(stateDir(), 'local-balance-channels.json')

/** 快照最多留 7 天：更旧的渠道列表只当没有，免得删掉的渠道一直挂在选择器里。 */
const CHANNELS_MAX_AGE_MS = 7 * 24 * 3_600_000

/** 读状态。任何异常都回落到默认值。 */
export async function readState() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'))
    return {
      picked: typeof raw?.picked === 'string' && raw.picked !== '' ? raw.picked : DEFAULTS.picked,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** 写状态。失败不影响本次会话里的选择。 */
export async function writeState(state) {
  try {
    await mkdir(dirname(statePath()), { recursive: true })
    await writeFile(statePath(), JSON.stringify({
      picked: typeof state.picked === 'string' && state.picked !== '' ? state.picked : DEFAULTS.picked,
    }, null, 2))
  } catch {}
}

/**
 * 读渠道快照。只认能用的结构：`{ at: 毫秒, value: [{ provider, count }] }`。
 * 读不到、解析失败、过期都返回 undefined（调用方按「没有缓存」走）。
 */
export async function readChannelsCache(now = Date.now()) {
  try {
    const raw = JSON.parse(await readFile(channelsPath(), 'utf8'))
    const at = Number(raw?.at)
    if (!Number.isFinite(at) || at <= 0 || now - at > CHANNELS_MAX_AGE_MS) return undefined
    if (!Array.isArray(raw?.value)) return undefined
    const value = raw.value.filter((hit) => typeof hit?.provider === 'string' && hit.provider !== '')
      .map((hit) => ({ provider: hit.provider, count: Number.isFinite(Number(hit.count)) ? Number(hit.count) : 0 }))
    if (value.length === 0) return undefined
    return { at, value, failed: 0 }
  } catch {
    return undefined
  }
}

/** 写渠道快照。写失败吞掉：它只是让下次开窗更快，不该影响面板。 */
export async function writeChannelsCache(cache) {
  try {
    await mkdir(dirname(channelsPath()), { recursive: true })
    await writeFile(channelsPath(), JSON.stringify({
      at: Number.isFinite(Number(cache?.at)) ? Number(cache.at) : Date.now(),
      value: Array.isArray(cache?.value)
        ? cache.value
          .filter((hit) => typeof hit?.provider === 'string' && hit.provider !== '')
          .map((hit) => ({ provider: hit.provider, count: Number.isFinite(Number(hit.count)) ? Number(hit.count) : 0 }))
        : [],
    }))
  } catch {}
}

