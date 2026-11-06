// 三个面板都会用到的小工具。

/** 中文界面？locale 以 en 开头就当英文。 */
export const zhOf = (locale) => !String(locale ?? '').startsWith('en')

/** 上游错误压成一行，别把整段堆栈塞进 note。 */
export const briefError = (error) => String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 120)

/** 面板状态变了：把注册过的 kick 都跑一遍。 */
export const kickAll = (set) => {
  for (const kick of set) kick()
}
