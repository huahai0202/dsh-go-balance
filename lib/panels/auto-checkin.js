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
        const when = new Date(next)
        const hh = String(when.getHours()).padStart(2, '0')
        const mm = String(when.getMinutes()).padStart(2, '0')
        parts.push(zh ? `下次 ${hh}:${mm}` : `next ${hh}:${mm}`)
      }
      if (state.running === true) parts.push(zh ? '正在签到' : 'running')
      const last = state.lastResult
      if (typeof last?.summary === 'string' && last.summary !== '') {
        parts.push(last.summary.slice(0, 80))
      }
      status = parts.join(' · ')
      statusTone = state.running === true ? 'info' : state.ranToday === true ? 'good' : 'info'
    }

    fields.autoStatusText = status
    fields.autoStatusTone = statusTone
    fields.autoNote = note !== '' ? note : (zh
      ? '到点自动领取各渠道的每日积分；不用打开 App。'
      : 'Claims daily credits automatically; no need to open the app.')
    fields.autoNoteTone = note !== '' ? noteTone : 'info'
    return fields
  }

  /** 这一页的组件树（不含外层 stack 与返回条）。全部用 v1 原生组件。 */
  const view = (zh) => [
    { type: 'text', text: { $: 'data.autoHeadline' }, tone: 'muted' },
    {
      type: 'row',
      children: [
        { type: 'metric', label: zh ? '自动签到' : 'Auto check-in', value: { $: 'data.autoEnabledLabel' }, tone: { $: 'data.autoEnabledTone' } },
        { type: 'metric', label: zh ? '执行时刻' : 'Runs at', value: { $: 'data.autoTimesLabel' }, caption: zh ? '在 Jet Hub 里改' : 'set in Jet Hub' },
      ],
    },
    { type: 'callout', text: { $: 'data.autoStatusText' }, tone: { $: 'data.autoStatusTone' } },
    { type: 'list', items: { $: 'data.autoItems' } },
    { type: 'callout', text: { $: 'data.autoNote' }, tone: { $: 'data.autoNoteTone' } },
  ]

  /** 推数据。`emit` 由 manage 的 data 传进来。 */
  const data = async (emit, zh, force, base) => {
    let state
    try {
      state = await readState(force)
    } catch (error) {
      emit({
        ...base,
        autoHeadline: zh ? '自动签到' : 'Auto check-in',
        autoItems: [],
        autoStatusText: zh ? `读不到状态：${briefError(error)}` : `State unavailable: ${briefError(error)}`,
        autoStatusTone: 'warn',
        autoEnabledLabel: '—',
        autoEnabledTone: 'muted',
        autoTimesLabel: '—',
        autoNote: '',
        autoNoteTone: 'warn',
      })
      return
    }
    const fields = buildFields(state, zh)
    emit({
      ...base,
      autoHeadline: zh ? '自动签到' : 'Auto check-in',
      ...fields,
      autoItems: [
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
      ],
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
