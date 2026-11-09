// 三个面板都会用到的小工具。

/** 中文界面？locale 以 en 开头就当英文。 */
export const zhOf = (locale) => !String(locale ?? '').startsWith('en')

/** 上游错误压成一行，别把整段堆栈塞进 note。 */
export const briefError = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 120)

/** 面板状态变了：把注册过的 kick 都跑一遍。 */
export const kickAll = (set) => {
  for (const kick of set) kick()
}

/** `Date` 可表示的最大毫秒值（±8.64e15）。超出它的值会让 `new Date(v)` 抛错。 */
export const MAX_DATE_MS = 8_640_000_000_000_000

/**
 * 一个「时刻」字段是否是真实可用的毫秒值。
 *
 * 判据与 Jet Hub 内部的 `isValidResetAtMs` 保持一致：必须是有限数字、
 * 大于 0、且不超过 `Date` 的取值范围。
 *
 * ⚠️ 不能用 `Number(v) > 0` 代替：`Infinity` 会通过（界面上就成了
 * 「永远限流 / 永久封禁」），超出 Date 范围的值会通过但在格式化时抛 RangeError。
 * 这类字段来自上游 JSON，脏值是现实存在的。
 */
export const isMomentMs = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_DATE_MS
