// 账号排序的纯函数。
//
// Jet Hub 的 `account.reorder` 要求传**该渠道全部账号**的新顺序（它核对集合，
// 多一个少一个都报错），所以「把第 i 个挪到第 j 个」必须落成一个完整数组，
// 而不是只传动过的那一条。这块有单测（test/order.test.mjs）。

/**
 * 把 `from` 位置上的元素挪到 `to` 位置，返回新数组。
 *
 * 越界或原地不动时返回 `null` —— 让调用方据此跳过请求与提示，不要发一个
 * 「顺序没变」的写请求（Jet Hub 那边会照写一次文档、白广播一次）。
 *
 * @param {readonly string[]} ids 当前顺序
 * @param {number} from 起点下标
 * @param {number} to 终点下标
 * @returns {string[] | null}
 */
export function moveInOrder(ids, from, to) {
  if (!Array.isArray(ids) || ids.length === 0) return null
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return null
  if (from === to) return null
  const next = [...ids]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * 账号列表 → 可提交给 `account.reorder` 的 id 数组。
 *
 * 有任何一条缺 id（脏数据 / 版本不匹配）就返回 `null`：带着残缺集合去提交，
 * Jet Hub 会直接报「集合不一致」，而用户看不出是哪一条出了问题。
 */
export function orderedIdsOf(accounts) {
  if (!Array.isArray(accounts)) return null
  const ids = []
  for (const account of accounts) {
    const id = typeof account?.id === 'string' ? account.id : ''
    if (id === '') return null
    ids.push(id)
  }
  return ids
}

/**
 * 把选中的一组账号整体移动，返回新顺序；没有变化时返回 null。
 *
 * 支持「多个账号一起调」：选中的账号保持彼此相对顺序，整块上移 / 下移一格，
 * 或者整块挪到最前 / 最后。这样一次点按就能挪一批，不用逐条来。
 *
 * @param {readonly string[]} ids 当前顺序
 * @param {ReadonlySet<string> | readonly string[]} selected 选中的 id
 * @param {'up'|'down'|'top'|'bottom'} direction
 * @returns {string[] | null}
 */
export function moveSelected(ids, selected, direction) {
  if (!Array.isArray(ids) || ids.length === 0) return null
  const picked = selected instanceof Set ? selected : new Set(Array.isArray(selected) ? selected : [])
  if (picked.size === 0) return null
  const isPicked = (id) => picked.has(id)
  const next = [...ids]

  if (direction === 'top' || direction === 'bottom') {
    const chosen = next.filter((id) => isPicked(id))
    const rest = next.filter((id) => !isPicked(id))
    if (chosen.length === 0) return null
    const ordered = direction === 'top' ? [...chosen, ...rest] : [...rest, ...chosen]
    return sameOrder(ordered, ids) ? null : ordered
  }

  if (direction === 'up') {
    // 从上往下扫：选中的行只要上面那行没选中，就换上去。整块因此一起上移一格。
    for (let i = 1; i < next.length; i += 1) {
      if (isPicked(next[i]) && !isPicked(next[i - 1])) {
        const tmp = next[i - 1]
        next[i - 1] = next[i]
        next[i] = tmp
      }
    }
  } else if (direction === 'down') {
    for (let i = next.length - 2; i >= 0; i -= 1) {
      if (isPicked(next[i]) && !isPicked(next[i + 1])) {
        const tmp = next[i + 1]
        next[i + 1] = next[i]
        next[i] = tmp
      }
    }
  } else {
    return null
  }
  return sameOrder(next, ids) ? null : next
}

/** 两个顺序是否完全一样（用来判断「点了但没动」）。 */
function sameOrder(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * 按给定顺序把账号列表重排；id 对不上的条目丢掉（防止列表里混进别处的脏数据）。
 */
export function applyOrder(accounts, ids) {
  if (!Array.isArray(accounts)) return []
  if (!Array.isArray(ids)) return accounts
  const byId = new Map()
  for (const account of accounts) {
    const id = typeof account?.id === 'string' ? account.id : ''
    if (id !== '') byId.set(id, account)
  }
  const out = []
  for (const id of ids) {
    const hit = byId.get(id)
    if (hit !== undefined) out.push(hit)
  }
  return out
}

/**
 * 模型分组「点标题」的下一个展开状态。
 *
 * `''` 表示**全部收起**。必须有这个独立取值：若「再点一次回落成 'on'」，
 * 「已开启」那一组就永远收不起来（点它只是把状态重新设成它自己的展开态）。
 *
 * @param {string} current 当前展开的组（'on' / 'off' / 'dead' / ''）
 * @param {'on'|'off'|'dead'} tapped 被点的组
 * @returns {string}
 */
export function nextOpenGroup(current, tapped) {
  if (tapped !== 'on' && tapped !== 'off' && tapped !== 'dead') return current
  return current === tapped ? '' : tapped
}
