// 自动签到：每天两次，到点自动领取各渠道的每日积分。
//
// 数据来自 Jet Hub 的 `usage.autoCheckin`（进程内 RPC），插件自己不定时、不调度 ——
// 真正跑签到的是宿主，这里只读写它的配置与状态。
//
// 这一页只留开关：执行时刻属于 Jet Hub 自己的配置，插件不再提供「改时刻」。
//
// ⚠️ 写操作在 Jet Hub 那边是**互斥**的：改开关 / 改时刻 / 关状态文字同时下发
// 会被 bad-request 拒掉。所以每一行只做一件事。

import {
  dismissAutoCheckin,
  readAutoCheckin,
  setAutoCheckinEnabled,
} from '../jet-hub.js'
import { channelRows, runSummary, whenLabel } from '../checkin.js'
import { labelOf } from '../labels.js'
import { briefError, zhOf } from '../util.js'

/** 状态缓存：签到是分钟级的事，10 秒够用。 */
const STATE_CACHE_MS = 10_000

/**
 * 自动签到这一页：状态、动作与数据。
 *
 * 返回的对象被 manage 面板当成一个子页面用（同 host.js 的形态）。
 */
export function createAutoCheckinSection(ctx) {
  let cache = { at: 0, value: undefined }
  let note = ''
  let noteTone = 'info'
  /**
   * 上一轮有没有逐渠道明细。
   *
   * 视图是**同步**的、只能拿快照，而空 list 在 v1 里会画成一个「暂无数据」的框；
   * 这一页永远不该出现那个框，所以用这份快照决定要不要渲染那一行列表。
   * 与 manage 的 `modelRows` 同一思路：数据推上来时顺手记下，视图只读它。
   */
  let lastRunShown = false
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

  const readState = async (force) => {
    if (!force && Date.now() - cache.at < STATE_CACHE_MS && cache.value !== undefined) return cache.value
    const value = await readAutoCheckin(ctx)
    cache = { at: Date.now(), value: value?.autoCheckin }
    return cache.value
  }

  /** 下一页要的字段。`state` 可能是 undefined（读不到）。 */
  const buildFields = (state, zh) => {
    const on = state?.enabled === true
    const times = Array.isArray(state?.times) && state.times.length > 0 ? state.times : []
    const fields = {
      autoEnabledLabel: on ? (zh ? '已开启' : 'On') : (zh ? '已关闭' : 'Off'),
      autoEnabledTone: on ? 'good' : 'muted',
      autoTimesLabel: times.length === 0 ? '—' : times.join(' · '),
    }

    // 状态说明：开启时讲「今天跑没跑、下次几点」，关闭时讲怎么开。
    let status = ''
    let statusTone = 'info'
    // 「下次执行」读数：这里放 Jet Hub 算出来的真实时刻（含补跑 / 退避），
    // 时段本身在下面那张卡片的副标题里，两者不是一回事。
    let nextLabel = '—'
    if (state === undefined) {
      status = zh ? '读不到自动签到的状态。' : 'Automatic check-in state unavailable.'
      statusTone = 'warn'
    } else if (!on) {
      status = zh
        ? '已关闭。打开后，到点会自动领取各渠道的每日积分。'
        : 'Off. Turn it on to claim daily credits automatically.'
    } else {
      const parts = []
      parts.push(state.ranToday === true ? (zh ? '今天已跑过' : 'ran today') : (zh ? '今天还没跑' : 'not run yet today'))
      const next = Number(state.nextRunAt)
      if (Number.isFinite(next) && next > 0) {
        // ⚠️ 「下次」必须带日期：补跑 / 退避重试会让它落在今天之前或之后，
        // 只给 HH:MM 时「下次 01:18」看着像今晚，实际可能是昨天 21:00 那轮的补跑。
        const when = whenLabel(next, Date.now(), zh)
        if (when !== '') {
          nextLabel = when
          parts.push(zh ? `下次 ${when}` : `next ${when}`)
        }
      }
      if (state.running === true) parts.push(zh ? '正在签到' : 'running')
      status = parts.join(' · ')
      statusTone = state.running === true ? 'info' : state.ranToday === true ? 'good' : 'info'
    }

    // 上一轮到底做了什么：这是「签到有没有效果」的唯一答案来源，
    // 宿主的 lastResult / channels 已经写好了，这里只负责摆出来。
    const lastAt = Number(state?.lastAt)
    const lastWhen = whenLabel(lastAt, Date.now(), zh)
    const summary = runSummary(state, zh)
    const rows = channelRows(state?.channels, labelOf, zh)

    fields.autoStatusText = status
    fields.autoStatusTone = statusTone
    fields.autoNextLabel = nextLabel
    fields.autoLastHeadline = zh ? '上次结果' : 'Last run'
    fields.autoLastLabel = lastWhen === '' ? '—' : lastWhen
    fields.autoLastText = lastWhen === '' ? (zh ? '还没有跑过。' : 'Not run yet.') : summary
    fields.autoLastTone = state === undefined
      ? 'warn'
      : state?.running === true
        ? 'info'
        : lastWhen === ''
          ? 'muted'
          : (/出错|失败/.test(summary) ? 'warn' : 'good')
    fields.autoChannelCount = rows.length
    fields.autoChannelRows = rows
    // 视图是同步的，只能拿这份快照决定「要不要画逐渠道列表」。
    // 放在 buildFields 里而不是 data 里：切页走 `peek()` 只调这个函数。
    lastRunShown = rows.length > 0
    fields.autoNote = note !== '' ? note : (zh
      ? '到点自动领取各渠道的每日积分；不用打开 App。'
      : 'Claims daily credits automatically; no need to open the app.')
    fields.autoNoteTone = note !== '' ? noteTone : 'info'

    const items = [
      {
        title: zh ? '自动签到开关' : 'Auto check-in',
        subtitle: fields.autoTimesLabel === '—'
          ? (zh ? '还没有设置执行时刻' : 'no times yet')
          : (zh ? `每天 ${fields.autoTimesLabel}` : `daily ${fields.autoTimesLabel}`),
        trailing: fields.autoEnabledLabel,
        icon: 'alarm',
        action: { id: 'auto-toggle', args: { next: state?.enabled !== true } },
        ...(state?.enabled === true ? { tone: 'good' } : {}),
      },
      // 有遗留的状态文字时才给「关闭」入口：它只是把那行常驻提示收起来，
      // 下一轮签到跑完会自己回来。没有文字时不放这个按钮，免得点了没反应。
      ...(Number(state?.lastAt) > 0 && state?.dismissed !== true
        ? [{
          title: zh ? '收起签到状态提示' : 'Hide status line',
          subtitle: zh ? '下一轮跑完会重新出现' : 'comes back after the next run',
          trailing: zh ? '收起' : 'Hide',
          icon: 'clear',
          action: 'auto-dismiss',
        }]
        : []),
    ]
    fields.autoItems = items
    return fields
  }

  /** 这一页的组件树（不含外层 stack 与返回条）。全部用 v1 原生组件。 */
  const view = (zh) => {
    const children = [
      { type: 'text', text: { $: 'data.autoHeadline' }, tone: 'muted' },
      {
        type: 'row',
        children: [
          { type: 'metric', label: zh ? '自动签到' : 'Auto check-in', value: { $: 'data.autoEnabledLabel' }, tone: { $: 'data.autoEnabledTone' } },
          { type: 'metric', label: zh ? '下次执行' : 'Next run', value: { $: 'data.autoNextLabel' }, caption: zh ? '在 Jet Hub 里改时刻' : 'times set in Jet Hub' },
        ],
      },
      { type: 'callout', text: { $: 'data.autoStatusText' }, tone: { $: 'data.autoStatusTone' } },
      { type: 'list', items: { $: 'data.autoItems' } },
      // 上次结果：逐渠道明细。空列表时不能渲染（v1 会留一个「暂无数据」的框），
      // 所以这一块由 autoDetailVisible 控制 —— 它随 lastAt 一起推上来。
      { type: 'text', text: { $: 'data.autoLastHeadline' }, tone: 'muted' },
      { type: 'callout', text: { $: 'data.autoLastText' }, tone: { $: 'data.autoLastTone' } },
    ]
    if (lastRunShown) children.push({ type: 'list', items: { $: 'data.autoChannelRows' } })
    children.push({ type: 'callout', text: { $: 'data.autoNote' }, tone: { $: 'data.autoNoteTone' } })
    return children
  }

  /** 推数据。`emit` 由 manage 的 data 传进来。 */
  const data = async (emit, zh, force, base) => {
    let state
    try {
      state = await readState(force)
    } catch (error) {
      lastRunShown = false
      emit({
        ...base,
        autoHeadline: zh ? '自动签到' : 'Auto check-in',
        autoItems: [],
        autoStatusText: zh ? `读不到状态：${briefError(error)}` : `State unavailable: ${briefError(error)}`,
        autoStatusTone: 'warn',
        autoEnabledLabel: '—',
        autoEnabledTone: 'muted',
        autoTimesLabel: '—',
        autoNextLabel: '—',
        autoLastHeadline: zh ? '上次结果' : 'Last run',
        autoLastLabel: '—',
        autoLastText: zh ? '读不到状态；先刷新一次。' : 'State unavailable; refresh first.',
        autoLastTone: 'warn',
        autoChannelCount: 0,
        autoChannelRows: [],
        autoNote: '',
        autoNoteTone: 'warn',
      })
      return
    }
    const fields = buildFields(state, zh)
    // 视图是同步的，只能拿这份快照决定「要不要画逐渠道列表」。
    lastRunShown = fields.autoChannelCount > 0
    emit({
      ...base,
      autoHeadline: zh ? '自动签到' : 'Auto check-in',
      ...fields,
    })
  }

  const actions = {
    'auto-toggle': (_scope, event) => {
      const zh = zhOf(event?.locale)
      const wanted = event?.value?.next
      return {
        pending: { label: zh ? '正在切换自动签到' : 'Switching', timeoutMs: 20_000 },
        result: async () => {
          try {
            const next = typeof wanted === 'boolean' ? wanted : (await readState(false))?.enabled !== true
            await setAutoCheckinEnabled(ctx, next)
            invalidate()
            setNote(
              next
                ? (zh ? '已开启；今天还没跑的话会立刻补一次。' : 'On; it will run right away if not yet done today.')
                : (zh ? '已关闭，不再自动签到。' : 'Off; no more automatic check-ins.'),
            )
            kick()
            return { toast: next ? (zh ? '已开启自动签到' : 'Auto check-in on') : (zh ? '已关闭自动签到' : 'Auto check-in off') }
          } catch (error) {
            invalidate()
            setNote(zh ? `切换失败：${briefError(error)}` : `Switch failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '切换失败' : 'Switch failed' }
          }
        },
      }
    },
    'auto-dismiss': (_scope, event) => {
      const zh = zhOf(event?.locale)
      return {
        pending: { label: zh ? '正在收起' : 'Hiding', timeoutMs: 15_000 },
        result: async () => {
          try {
            await dismissAutoCheckin(ctx)
            invalidate()
            kick()
            return { toast: zh ? '已收起' : 'Hidden' }
          } catch (error) {
            invalidate()
            setNote(zh ? `收起失败：${briefError(error)}` : `Failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '收起失败' : 'Failed' }
          }
        },
      }
    },
    'auto-refresh': (_scope, event) => {
      invalidate()
      note = ''
      kick()
      return [{ refresh: 'manage' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
    },
  }

  /** 缓存里现成的字段（切页用，不发 IO）。语言由调用方传入。 */
  const peek = (zh) => (cache.value === undefined ? undefined : buildFields(cache.value, zh))

  return { view, data, peek, actions, kick, kicks, invalidate }
}
