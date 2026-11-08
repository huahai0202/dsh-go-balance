// 找 dsh-go 插件技能自带的测试宿主（kit）。
//
// kit 跟着技能走，不在这个仓库里：路径随 $DSH_HOME 变，换了机器也可能根本没装。
// 所以这里统一解析一次，两种用法：
//
// - `createTestHost` 拿到了：起假宿主，跑面板级测试
// - 拿不到（`undefined`）：调用方用 `{ skip: SKIP_KIT }` 跳过，纯函数测试照常跑
//
// ⚠️ 别在测试里写死 `/root/.dsh/...`：那只有作者这台机器成立。

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const KIT = 'skills/dsh-go-plugin/kit/lib/testing.js'

const candidates = [
  process.env.DSH_HOME === undefined ? undefined : join(process.env.DSH_HOME, KIT),
  join(homedir(), '.dsh', KIT),
].filter((path) => path !== undefined)

/** kit 提供的 `createTestHost`；没装技能就是 `undefined`。 */
export const createTestHost = await (async () => {
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const mod = await import(pathToFileURL(path).href)
    if (typeof mod.createTestHost === 'function') return mod.createTestHost
  }
  return undefined
})()

/** 给 `test(..., { skip })` 用的跳过原因；能用就是 `false`。 */
export const SKIP_KIT = createTestHost === undefined
  ? '没找到 dsh-go-plugin 技能的 kit（$DSH_HOME/skills/dsh-go-plugin/kit），装上技能再跑'
  : false
