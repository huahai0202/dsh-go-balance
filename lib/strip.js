// 输入框上方的状态条：一行「今天签到到哪一步了」。
//
// 数据来自 Jet Hub 的 `usage.autoCheckin`，10 秒缓存 —— 这个条只在 App 前台显示，
// 而签到是分钟级的事，没必要每次刷新都打一次 RPC。
//
// ⚠️ 状态条只能点开**已有的**面板（`panel:manage` 的自动签到页没有独立面板 id），
// 所以这里点它直接打开渠道余额面板，而不是新造一个入口。

import { readAutoCheckin } from './jet-hub.js'
import { stripText } from './checkin.js'
import { zhOf } from './util.js'

/** 状态条自己的缓存：10 秒内重复渲染直接用上一次的结果。 */
const STRIP_CACHE_MS = 10_000

export function registerStrip(ctx) {
  /** `{ at, value }` —— `value` 是 `readAutoCheckin` 解出来的 autoCheckin。 */
  let cache = { at: 0, value: undefined }
  let inflight

  const readState = async () => {
    if (Date.now() - cache.at < STRIP_CACHE_MS && cache.value !== undefined) return cache.value
    if (inflight !== undefined) return inflight
    inflight = readAutoCheckin(ctx)
      .then((value) => {
        cache = { at: Date.now(), value: value?.autoCheckin }
        return cache.value
      })
      .catch(() => undefined)
      .finally(() => {
        inflight = undefined
      })
    return inflight
  }

  ctx.dshGo.strip('checkin', (scope, emit, caps) => {
    const zh = zhOf(caps?.locale)
    let alive = true
    let timer

    const push = async () => {
      // 先把缓存里的给出去：冷启动第一帧不该是空白。
      if (cache.value !== undefined) emit(stripOf(cache.value, zh))
      const value = await readState()
      if (!alive) return
      emit(stripOf(value, zh))
    }

    void push()
    // 每 30 秒自己看一次：签到是到点触发的，App 开着的时候大致能跟上状态。
    timer = setInterval(() => void push(), 30_000)
    return () => {
      alive = false
      if (timer !== undefined) clearInterval(timer)
    }
  })

  /** 手动刷新（面板里「刷新」之后调）：让状态条立刻重读一次。 */
  const invalidate = () => {
    cache = { at: 0, value: undefined }
  }
  return { invalidate }
}

/** 状态条要的三个字段：文字、图标、语气。 */
function stripOf(state, zh) {
  const text = stripText(state, Date.now(), zh).slice(0, 24)
  const tone = state === undefined
    ? 'warn'
    : state.running === true
      ? 'info'
      : state.enabled !== true
        ? 'muted'
        : state.ranToday === true
          ? 'good'
          : 'info'
  return { text, icon: 'alarm', tone }
}
