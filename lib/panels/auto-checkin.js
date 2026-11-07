// 自动签到：每天两次，到点自动领取各渠道的每日积分。
//
// 数据来自 Jet Hub 的 `usage.autoCheckin`（进程内 RPC），插件自己不定时、不调度 ——
// 真正跑签到的是宿主，这里只读写它的配置与状态。
//
// ⚠️ 三个写操作在 Jet Hub 那边是**互斥**的：改开关 / 改时刻 / 关状态文字同时下发
// 会被 bad-request 拒掉。所以每一行只做一件事。

import {
  dismissAutoCheckin,
  readAutoCheckin,
  setAutoCheckinEnabled,
  setAutoCheckinTimes,
} from '../jet-hub.js'
import { briefError, kickAll, zhOf } from '../util.js'

/** 状态缓存：签到是分钟级的事，10 秒够用。 */
const STATE_CACHE_MS = 10_000

/** 时刻格式校验：HH:MM，24 小时制。Jet Hub 也会校验，这里先挡一下给出更清楚的提示。 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/** 校验并规范化两个时刻；失败返回错误文案。 */
export function validateTimes(a, b) {
  const first = String(a ?? '').trim()
  const second = String(b ?? '').trim()
  if (!TIME_RE.test(first)) return { error: 'time1' }
  if (!TIME_RE.test(second)) return { error: 'time2' }
  if (first === second) return { error: 'same' }
  // Jet Hub 存的顺序是排好序的，这里跟着排，免得每次保存都算出不同的字符串。
  return { times: [first, second].sort() }
}

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
    const jitter = Number(state?.jitterMinutes) || 0
    const fields = {
      autoOn: on,
      autoTime1: times[0] ?? '09:00',
      autoTime2: times[1] ?? '21:00',
      autoJitter: String(jitter),
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
    fields.autoJitterNote = jitter > 0
      ? (zh ? `每个时刻会在 ±${jitter} 分钟内浮动` : `fires within ±${jitter} min`)
      : (zh ? '准点执行' : 'at the exact time')
    fields.autoNote = note !== '' ? note : (zh
      ? '到点自动领取各渠道的每日积分；不用打开 App。'
      : 'Claims daily credits automatically; no need to open the app.')
    fields.autoNoteTone = note !== '' ? noteTone : 'info'
    return fields
  }

  /** 这一页的组件树（不含外层 stack 与返回条）。 */
  const view = (zh, canType = true) => [
    { type: 'text', text: { $: 'data.autoHeadline' }, tone: 'muted' },
    {
      type: 'row',
      children: [
        { type: 'metric', label: zh ? '自动签到' : 'Auto check-in', value: { $: 'data.autoEnabledLabel' }, tone: { $: 'data.autoEnabledTone' } },
        { type: 'metric', label: zh ? '执行时刻' : 'Runs at', value: { $: 'data.autoTimesLabel' } },
      ],
    },
    { type: 'callout', text: { $: 'data.autoStatusText' }, tone: { $: 'data.autoStatusTone' } },
    { type: 'list', items: { $: 'data.autoItems' } },
    // 改时刻：两个输入框 + 保存。Jet Hub 要求恰好两个时刻，这里固定两个字段，
    // 不给「增删」入口 —— 增删要到数量校验这一步才报错，不如一开始就不允许。
    //
    // `form` / `textField` 是 v2 组件：App 不支持时不画这块（上面的读数仍可看）。
    ...(canType
      ? [{
        type: 'form',
        submit: 'auto-save-times',
        submitLabel: zh ? '保存时刻' : 'Save times',
        children: [
          { type: 'text', text: zh ? '每天两次，24 小时制 HH:MM' : 'Twice a day, 24-hour HH:MM', tone: 'muted' },
          { type: 'textField', label: zh ? '第一次' : 'First', bind: 'data.form.time1', maxLength: 5, required: true },
          { type: 'textField', label: zh ? '第二次' : 'Second', bind: 'data.form.time2', maxLength: 5, required: true },
        ],
      }]
      : []),
    { type: 'text', text: { $: 'data.autoJitterNote' }, tone: 'muted' },
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
        autoOn: false,
        autoTime1: '09:00',
        autoTime2: '21:00',
        autoItems: [],
        autoStatusText: zh ? `读不到状态：${briefError(error)}` : `State unavailable: ${briefError(error)}`,
        autoStatusTone: 'warn',
        autoEnabledLabel: '—',
        autoTimesLabel: '—',
        autoJitterNote: '',
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
          action: { id: 'auto-toggle', args: { next: !(state?.enabled === true) } },
          ...(state?.enabled === true ? { tone: 'good' } : {}),
        },
        // 有遗留的状态文字时才给「关闭」入口：它只是把那行常驻提示收起来，
        // 下一轮签到跑完会自己回来。没有文字时不放这个按钮，免得点了没反应。
        // 只在「确实有状态文字可收」时给这一行：跑过至少一轮，且还没被收起。
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

  /** 进这一页时把提示清掉。 */
  const reset = () => {
    note = ''
    noteTone = 'info'
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
    /** 保存两个时刻。校验在本地先做一遍，给出能看懂的错误。 */
    'auto-save-times': (_scope, event) => {
      const zh = zhOf(event?.locale)
      const values = event?.value?.values ?? {}
      const first = values['data.form.time1']
      const second = values['data.form.time2']
      const checked = validateTimes(first, second)
      if (checked.error !== undefined) {
        const text = checked.error === 'same'
          ? (zh ? '两个时刻不能相同。' : 'The two times must differ.')
          : (zh ? '请按 HH:MM 填写（例如 09:00）。' : 'Use HH:MM, e.g. 09:00.')
        setNote(text, 'warn')
        kick()
        return { toast: zh ? '时刻格式不对' : 'Bad time format' }
      }
      return {
        pending: { label: zh ? '正在保存时刻' : 'Saving times', timeoutMs: 20_000 },
        result: async () => {
          try {
            await setAutoCheckinTimes(ctx, checked.times)
            invalidate()
            setNote(zh ? `已保存：每天 ${checked.times.join(' · ')}。` : `Saved: daily ${checked.times.join(' · ')}.`)
            kick()
            return { toast: zh ? '时刻已保存' : 'Times saved' }
          } catch (error) {
            invalidate()
            // Jet Hub 会回「需要恰好两个时刻」「两个时刻不能相同」这类原文，
            // 直接透出去比换成一句「保存失败」有用。
            setNote(zh ? `保存失败：${briefError(error)}` : `Save failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '保存失败' : 'Save failed' }
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

  /**
   * 缓存里现成的字段（切页用，不发 IO）。语言由调用方传入。
   */
  const peek = (zh) => (cache.value === undefined ? undefined : buildFields(cache.value, zh))

  /** 读一次状态并摊成字段（表单初值用；失败时给默认值）。 */
  const read = async (zh, force) => {
    try {
      return buildFields(await readState(force), zh)
    } catch {
      return buildFields(undefined, zh)
    }
  }

  return { view, data, read, peek, actions, kick, kicks, reset, invalidate }
}
