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

const STATE_PATH = join(
  process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  'dsh-go',
  'local-balance.json',
)

const DEFAULTS = Object.freeze({ picked: 'current' })

/** 读状态。任何异常都回落到默认值。 */
export async function readState() {
  try {
    const raw = JSON.parse(await readFile(STATE_PATH, 'utf8'))
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
    await mkdir(dirname(STATE_PATH), { recursive: true })
    await writeFile(STATE_PATH, JSON.stringify({
      picked: typeof state.picked === 'string' && state.picked !== '' ? state.picked : DEFAULTS.picked,
    }, null, 2))
  } catch {}
}

export { STATE_PATH }
