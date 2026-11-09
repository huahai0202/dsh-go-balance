// 「锁定永久积分」：锁定后选号只烧会到期的积分，永久积分留着。
//
// 数据来自 Jet Hub 的 `credits.permanentLock`（actor 维度：一个渠道一个开关，
// 不分账号）。插件只读写这张表，不做任何本地推断 —— 「什么算永久」的判据在
// 宿主里（Loomy 看服务端每日池，buddy 系看资源包扣费截止距今的天数）。
//
// ⚠️ 与自动签到页一样：一次请求只改一件事，所以读和写分成两个调用。

import { readPermanentLock, setPermanentLock } from '../jet-hub.js'
import { PERMANENT_LOCK_PROVIDERS, labelOf } from '../labels.js'
import { briefError, zhOf } from '../util.js'

/** 锁定状态缓存：这是低频开关，10 秒内的重复打开直接用缓存。 */
const STATE_CACHE_MS = 10_000

/**
 * 一次读只查**已配置**的渠道，不查整张表。
 *
 * 表里 15 个渠道，用户通常只配了 3–5 个；对没配的渠道读锁定状态既没意义，
 * 也会在它们全部失败时把整页拖成「读不到」。
 */
export function createPermanentLockSection(ctx) {
  /** `{ at, value: { [provider]: { locked, windowDays } } }` */
  let cache = { at: 0, value: undefined }
  let note = ''
  let noteTone = 'info'
  /**
   * 视图是同步的，行里要显示「已锁定 / 未锁定」，只能读快照。
   * `hasRows` 单独记：空 list 在 v1 里会画成一个「暂无数据」的框，
   * 而这一页没渠道时该给的是一句说明，不是那个框。
   */
  let rows = []
  const kicks = new Set()

  const kick = () => {
    for (const fn of kicks) fn()
  }
  const invalidate = () => {
    cache = { at: 0, value: undefined }
  }
  const setNote = (text, tone = 'info') => {
    note = text
    noteTone = tone
  }

  /**
   * 读锁定状态。
   *
   * `providers` 是本次要查的渠道（已配置的那些）；缓存按整个集合命中，
   * 集合变了就重读 —— 否则新配一个渠道后这一页会一直少一行。
   */
  const readState = async (providers, force) => {
    const key = providers.join(',')
    if (!force && cache.at > 0 && Date.now() - cache.at < STATE_CACHE_MS && cache.key === key && cache.value !== undefined) {
      return cache.value
    }
    const values = await Promise.all(providers.map((provider) =>
      readPermanentLock(ctx, provider)
        .then((value) => [provider, value])
        .catch(() => [provider, undefined])))
    const value = Object.fromEntries(values)
    cache = { at: Date.now(), key, value }
    return value
  }

  /** 渠道 → 一行。`state` 里没有这个渠道 = 读失败。 */
  const buildRows = (providers, state, zh) => {
    const out = []
    for (const provider of providers) {
      const hit = state?.[provider]
      const locked = hit?.locked === true
      const windowDays = Number(hit?.windowDays)
      out.push({
        title: `${labelOf(provider)}`,
        subtitle: hit === undefined
          ? (zh ? '读不到状态' : 'state unavailable')
          : locked
            ? (Number.isFinite(windowDays) && windowDays > 0
              ? (zh ? `只烧 ${windowDays} 天内到期的积分` : `only credits expiring within ${windowDays} days`)
              : (zh ? '只用会到期的积分' : 'only expiring credits'))
            : (zh ? '没临时积分时会动用永久积分' : 'permanent credits may be used'),
        trailing: hit === undefined ? '—' : locked ? (zh ? '已锁定' : 'Locked') : (zh ? '未锁定' : 'Off'),
        icon: 'coin',
        ...(locked ? { tone: 'good' } : {}),
        action: { id: 'lock-toggle', args: { provider, next: !locked } },
      })
    }
    return out
  }

  /** 这一页的组件树（不含外层 stack 与返回条）。 */
  const view = (zh) => [
    { type: 'text', text: { $: 'data.lockHeadline' }, tone: 'muted' },
    // 没有行时不渲染列表（否则是一个空的「暂无数据」框），换成底部那句说明。
    ...(rows.length > 0 ? [{ type: 'list', items: { $: 'data.lockItems' } }] : []),
    { type: 'callout', text: { $: 'data.lockNote' }, tone: { $: 'data.lockNoteTone' } },
  ]

  /**
   * 推数据。`providers` 由 manage 传进来（它有渠道探测缓存，这里不再自己探）。
   */
  const data = async (emit, zh, force, providers, base) => {
    // 只留这张表里的渠道：别的渠道调这个接口会被 bad-request 拒掉。
    const list = (Array.isArray(providers) ? providers : [])
      .filter((provider) => PERMANENT_LOCK_PROVIDERS.has(provider))
    let state
    try {
      state = await readState(list, force)
    } catch (error) {
      rows = []
      emit({
        ...base,
        lockHeadline: zh ? '锁定永久积分' : 'Keep permanent credits',
        lockItems: [],
        lockNote: zh ? `读不到状态：${briefError(error)}` : `State unavailable: ${briefError(error)}`,
        lockNoteTone: 'warn',
      })
      return
    }
    rows = buildRows(list, state, zh)
    emit({
      ...base,
      lockHeadline: zh ? '锁定永久积分' : 'Keep permanent credits',
      lockItems: rows,
      lockNote: note !== '' ? note : (list.length === 0
        ? (zh ? '还没有配置支持永久锁定的渠道。' : 'No channel supporting this is configured.')
        : (zh ? '开着会先用会到期的积分；关掉则允许动用永久积分。' : 'On: use expiring credits first. Off: permanent credits may be spent.')),
      lockNoteTone: note !== '' ? noteTone : 'info',
    })
  }

  /**
   * 缓存里现成的字段（切页用，不发 IO）。
   *
   * ⚠️ 必须给全：桥接是整份替换，切页时少一个键那个绑定就退化成「—」。
   */
  const peek = (zh) => {
    if (cache.value === undefined) return undefined
    const list = (cache.key ?? '').split(',').filter((provider) => provider !== '')
    return {
      lockHeadline: zh ? '锁定永久积分' : 'Keep permanent credits',
      lockItems: rows,
      lockNote: note !== '' ? note : (list.length === 0
        ? (zh ? '还没有配置支持永久锁定的渠道。' : 'No channel supporting this is configured.')
        : (zh ? '开着会先用会到期的积分；关掉则允许动用永久积分。' : 'On: use expiring credits first. Off: permanent credits may be spent.')),
      lockNoteTone: note !== '' ? noteTone : 'info',
    }
  }

  const actions = {
    'lock-toggle': (_scope, event) => {
      const zh = zhOf(event?.locale)
      const provider = typeof event?.value?.provider === 'string' ? event.value.provider : ''
      const next = event?.value?.next === true
      if (provider === '' || !PERMANENT_LOCK_PROVIDERS.has(provider)) {
        return [{ toast: zh ? '这个渠道不支持锁定' : 'This channel does not support it' }]
      }
      return {
        pending: { label: zh ? '正在切换锁定' : 'Switching', timeoutMs: 20_000 },
        result: async () => {
          try {
            await setPermanentLock(ctx, provider, next)
            invalidate()
            // 锁定表是备份的一部分（`permanentLocks`），改完要让备份页重新读。
            setNote(
              next
                ? (zh ? `${labelOf(provider)} 已锁定：只用会到期的积分。` : `${labelOf(provider)} locked: expiring credits only.`)
                : (zh ? `${labelOf(provider)} 已解锁：可以动用永久积分。` : `${labelOf(provider)} unlocked.`),
            )
            kick()
            return { toast: next ? (zh ? '已锁定' : 'Locked') : (zh ? '已解锁' : 'Unlocked') }
          } catch (error) {
            invalidate()
            setNote(zh ? `切换失败：${briefError(error)}` : `Switch failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '切换失败' : 'Switch failed' }
          }
        },
      }
    },
    'lock-refresh': (_scope, event) => {
      invalidate()
      note = ''
      kick()
      return [{ refresh: 'manage' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
    },
  }

  return { view, data, peek, actions, kick, kicks, invalidate, rows: () => rows }
}
