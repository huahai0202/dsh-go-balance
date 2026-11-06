// 渠道余额面板 + 一键签到。
//
// 两条数据线：
// - 常规渠道走 Jet Hub 的 `usage.badge`（进程内 RPC，不打网络）；
// - ChatGPT/Codex 用 dsh-go 保存的 OAuth 直连 chatgpt.com（见 codex.js）。
//
// 分档（临期 / 长期 / 永久）是纯函数，在 split.js 里，有单测。

import { randomUUID } from 'node:crypto'

import {
  CODEX_PROVIDER,
  codexErrorNote,
  consumeCodexResetCredit,
  listCodexResetCredits,
  readCodexUsage,
  summarizeCodexUsage,
} from '../codex.js'
import { checkinSummary, claimLine, isUnsupportedCheckin, progressLine } from '../checkin.js'
import { claimDaily, readBadge } from '../jet-hub.js'
import { EXPIRY_WINDOW_PROVIDERS, labelOf } from '../labels.js'
import { expiryNote, fmtAmount, listExpiring, mergeSplits, normalizeWindowDays, splitByExpiry, splitFields } from '../split.js'
import { ALL } from '../constants.js'
import { kickAll, zhOf } from '../util.js'

/** 余额读数的缓存时长。 */
const CACHE_MS = 120_000
/** 重置券缓存：券只在月初发放和兑换时变化，比额度稳得多。 */
const CREDITS_CACHE_MS = 600_000
/** 面板数据的心跳。 */
const TICK_MS = 60_000
/** 签到结果在面板里停留多久；到点后自动收起（不留空闲提示）。 */
const CHECKIN_NOTICE_MS = 6_000



function summarizeBadge(value, provider, zh, now) {
  const accounts = Array.isArray(value?.accounts) ? value.accounts : []
  let total = 0
  let unit = '积分'
  let any = false
  const rows = []
  const expiringItems = []
  // 只有 Jet Hub 标记为按到期分档的渠道、且响应真的给了窗口，才拆三档。
  const windowDays = EXPIRY_WINDOW_PROVIDERS.has(provider) ? normalizeWindowDays(value?.windowDays) : null
  const splits = []
  for (const row of accounts) {
    const balance = row?.balance
    const nickname = String(row?.nickname ?? row?.accountId ?? '账号')
    if (row?.error !== undefined && row.error !== null) {
      rows.push({ label: nickname, value: zh ? '查询失败' : 'failed', tone: 'warn' })
      continue
    }
    if (balance === null || balance === undefined) {
      rows.push({ label: nickname, value: zh ? '没有读数' : 'no reading', tone: 'muted' })
      continue
    }
    const amount = Number(balance.total)
    const packages = Array.isArray(balance.packages) ? balance.packages : []
    const rawUnit = String(packages.find((p) => typeof p?.unit === 'string' && p.unit !== '')?.unit ?? '')
    if (rawUnit.toLowerCase().startsWith('token')) unit = 'tokens'
    if (Number.isFinite(amount)) {
      total += amount
      any = true
    }
    // 按到期分档的渠道也要算一份，给顶部的指标卡和下面的明细用。
    if (windowDays !== null) {
      splits.push(splitByExpiry(packages, windowDays, now))
    }
    // 逐笔到期：几个账号的包合并成一张表，所以带上账号昵称。
    if (windowDays !== null) {
      for (const item of listExpiring(packages, windowDays, now, zh)) {
        expiringItems.push({ ...item, nickname })
      }
    }
    rows.push({
      label: nickname,
      value: Number.isFinite(amount) ? `${Math.round(amount * 100) / 100} ${unit}` : '—',
    })
  }
  const updated = Number(value?.generatedAt)
  const actual = typeof value?.autoActual?.provider === 'string' ? value.autoActual.provider : undefined
  // 每条按到期时刻排，最早的在最上面；同一个时刻的多笔按账号聚在一起。
  expiringItems.sort((a, b) => a.at - b.at)
  return {
    provider,
    label: actual === undefined ? labelOf(provider) : `${labelOf(actual)} · ${zh ? '自动' : 'auto'}`,
    total: any ? total : undefined,
    unit,
    split: windowDays === null ? undefined : mergeSplits(splits),
    expiringItems,
    metricLabel: zh ? '合计余额' : 'Total',
    rows,
    disabled: Number(value?.disabledCount ?? 0),
    updated: Number.isFinite(updated) ? updated : undefined,
  }
}


export function registerBalance(ctx, r) {
  // 渠道切换时由 channels 面板踢这里，让余额立刻重读。
  const kicks = r.balanceKicks
  const stateReady = r.stateReady
  const effectiveProvider = r.effectiveProvider
  const readConfiguredProviders = r.readConfiguredProviders

  /** 余额缓存：key 是渠道 id（或 '__all__'）。 */
  const cache = new Map()
  let forceNext = false
  let creditsCache = { at: 0, value: [] }
  let resetArmed = false
  /**
   * 「逐笔到期」明细是不是展开着。
   *
   * 默认收起：一两笔时合计就够了，只有临期由多笔组成时才值得展开看每笔的日期。
   * 放这里而不是视图函数里，才能扛住刷新的重画。
   */
  let expiryDetailOpen = false

  /**
   * 一键签到的状态。
   *
   * 打开面板时可能还没点过（`at === 0`）；点过之后即使关掉面板任务也会跑完，
   * 结果在 CHECKIN_NOTICE_MS 内打开还能看到，之后自动收起 —— 所以状态放在
   * 这里，不放在视图函数里。
   */
  let checkinState = { running: false, done: 0, total: 0, label: '', text: '', tone: 'info', at: 0 }
  /** 让「签到完成」自动消失的定时器；新一轮签到会先取消旧的。 */
  let checkinNoticeTimer

  const cancelCheckinNotice = () => {
    if (checkinNoticeTimer === undefined) return
    clearTimeout(checkinNoticeTimer)
    checkinNoticeTimer = undefined
  }

  /** 结果只停留一会儿，避免面板上一直挂着昨天/刚才的「签到完成」。 */
  const scheduleCheckinDismiss = () => {
    cancelCheckinNotice()
    checkinNoticeTimer = setTimeout(() => {
      checkinNoticeTimer = undefined
      if (checkinState.running) return
      checkinState.text = ''
      checkinState.tone = 'info'
      kickAll(kicks)
    }, CHECKIN_NOTICE_MS)
    checkinNoticeTimer.unref?.()
  }

  const checkinFields = (zh) => {
    if (checkinState.running) {
      return { checkinText: progressLine(checkinState.done, checkinState.total, checkinState.label, zh) }
    }
    if (checkinState.text === '') return { checkinText: '' }
    // 状态行不再套 callout（空闲时会留一个空框），用符号表达成败。
    const mark = checkinState.tone === 'warn' ? '⚠ ' : checkinState.tone === 'good' ? '✓ ' : ''
    return { checkinText: `${mark}${checkinState.text}` }
  }

  async function readResetCredits(force) {
    if (!force && Date.now() - creditsCache.at < CREDITS_CACHE_MS) return creditsCache.value
    const value = await listCodexResetCredits(ctx).catch(() => creditsCache.value)
    creditsCache = { at: Date.now(), value }
    return value
  }

  /** 读一个渠道的余额（带缓存）。 */
  async function read(provider, force) {
    const hit = cache.get(provider)
    if (!force && hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value
    const value = provider === CODEX_PROVIDER
      ? await readCodexUsage(ctx)
      : await readBadge(ctx, provider, force)
    cache.set(provider, { at: Date.now(), value })
    return value
  }

  /** 「全部渠道」：把每个已配置渠道的合计并成一份。 */
  async function readAll(zh, now) {
    const { value: providers, failed } = await readConfiguredProviders(false)
    const settled = await Promise.all(providers.map(async (hit) => {
      try {
        return { provider: hit.provider, value: await read(hit.provider, false) }
      } catch {
        return { provider: hit.provider, error: true }
      }
    }))
    const rows = []
    let sum = 0
    let unit = '积分'
    let any = false
    for (const item of settled) {
      if (item.error) {
        rows.push({ label: labelOf(item.provider), value: zh ? '查询失败' : 'failed', tone: 'warn' })
        continue
      }
      const s = item.provider === CODEX_PROVIDER
        ? summarizeCodexUsage(item.value, zh, [])
        : summarizeBadge(item.value, item.provider, zh, now)
      if (item.provider === CODEX_PROVIDER) {
        rows.push({ label: labelOf(item.provider), value: s.metricValue ?? '—' })
        continue
      }
      if (s.total === undefined) {
        rows.push({ label: s.label, value: zh ? '没有读数' : 'no reading', tone: 'muted' })
        continue
      }
      unit = s.unit
      sum += s.total
      any = true
      rows.push({ label: s.label, value: `${fmtNumber(s.total)} ${s.unit}` })
    }
    return {
      headline: zh ? '全部渠道' : 'All channels',
      metricLabel: zh ? '合计余额' : 'Total',
      total: any ? `${fmtNumber(sum)} ${unit}` : '—',
      caption: zh ? `${providers.length} 个已配置渠道` : `${providers.length} configured`,
      rows: rows.length > 0 ? rows : [{ label: zh ? '状态' : 'Status', value: zh ? '还没有配置渠道' : 'none configured', tone: 'muted' }],
      note: failed > 0
        ? (zh ? `另有 ${failed} 个渠道这次没查到。` : `${failed} channel(s) could not be read.`)
        : '',
      tone: any ? 'info' : 'warn',
    }
  }

  /**
   * 一键签到：串行跑「有账号的渠道」（并发容易触发上游风控），开头的那个
   * 是当前正在看的渠道。任务在后台跑，面板里那行字跟着进度更新；跑完清掉
   * 余额缓存，让到账后的数字立刻重读。结果只展示 CHECKIN_NOTICE_MS 就收起。
   *
   * ChatGPT 不参与：它没有签到接口（额度是订阅自带的）。
   */
  async function runCheckin(zh, primary) {
    cancelCheckinNotice()
    checkinState = { running: true, done: 0, total: 0, label: '', text: '', tone: 'info', at: Date.now() }
    kickAll(kicks)
    const parts = []
    let unsupported = 0
    let gained = 0
    let failed = 0
    try {
      const probe = await readConfiguredProviders(true)
      const providers = probe.value
        .map((hit) => hit.provider)
        .filter((provider) => provider !== CODEX_PROVIDER)
      if (primary !== undefined && primary !== ALL) {
        const index = providers.indexOf(primary)
        if (index > 0) {
          providers.splice(index, 1)
          providers.unshift(primary)
        }
      }
      checkinState.total = providers.length
      for (const [index, provider] of providers.entries()) {
        checkinState.done = index
        checkinState.label = labelOf(provider)
        kickAll(kicks)
        try {
          const value = await claimDaily(ctx, provider)
          const summary = value?.summary ?? {}
          gained += Number(summary.claimed ?? 0)
          failed += Number(summary.failed ?? 0)
          const line = claimLine(labelOf(provider), value, zh)
          if (line !== '') parts.push(line)
        } catch (error) {
          if (isUnsupportedCheckin(String(error?.message ?? error))) {
            unsupported += 1
          } else {
            failed += 1
            parts.push(zh ? `${labelOf(provider)} 签到失败` : `${labelOf(provider)} failed`)
          }
        }
        checkinState.done = index + 1
        kickAll(kicks)
      }
      checkinState.text = checkinSummary(parts, unsupported, providers.length, zh)
      checkinState.tone = failed > 0 ? 'warn' : gained > 0 ? 'good' : 'info'
    } catch {
      checkinState.text = zh ? '签到失败，请稍后再试。' : 'Check-in failed, try again later.'
      checkinState.tone = 'warn'
    } finally {
      checkinState.running = false
      checkinState.at = Date.now()
      cache.clear()
      forceNext = true
      kickAll(kicks)
      scheduleCheckinDismiss()
    }
  }

  ctx.dshGo.panel('balance', {
    view: async (scope, caps) => {
      await stateReady
      const zh = zhOf(caps?.locale)
      const provider = effectiveProvider(scope, undefined)
      const hasSplit = provider !== undefined && provider !== ALL && EXPIRY_WINDOW_PROVIDERS.has(provider)
      const totalCell = {
        type: 'metric',
        label: { $: 'data.metricLabel' },
        value: { $: 'data.total' },
        caption: { $: 'data.caption' },
      }
      // 渠道入口放最上面一行，右侧「切换」点开独立的选择渠道面板。
      const children = [{
        type: 'list',
        items: [{
          title: { $: 'data.headline' },
          trailing: zh ? '切换' : 'Switch',
          icon: 'list',
          action: 'open-channels',
        }],
      }]
      if (hasSplit) {
        // 合计与临期并排（都是「眼下要注意的钱」），长期与永久第二行。两行各两块。
        children.push({
          type: 'row',
          children: [
            totalCell,
            {
              type: 'metric',
              label: zh ? '临期' : 'Expiring',
              value: { $: 'data.expiring' },
              caption: { $: 'data.expiringCaption' },
              tone: 'warn',
            },
          ],
        })
        children.push({
          type: 'row',
          children: [
            { type: 'metric', label: zh ? '长期' : 'Long term', value: { $: 'data.longTerm' }, caption: { $: 'data.longTermCaption' } },
            {
              type: 'metric',
              label: zh ? '永久' : 'Permanent',
              value: { $: 'data.permanent' },
              caption: { $: 'data.permanentCaption' },
              tone: 'good',
            },
          ],
        })
      } else {
        children.push(totalCell)
      }
      children.push({ type: 'keyValue', items: { $: 'data.rows' } })
      // 逐笔到期明细：默认折叠成一行摘要，点开展开。临期通常是好几笔
      // 分散在几天里到期，只报合计会让人以为是一起作废。
      if (hasSplit) {
        children.push({
          type: 'list',
          items: [
            {
              title: zh ? '逐笔到期' : 'Per-package expiry',
              subtitle: { $: 'data.expiryDetailSummary' },
              trailing: expiryDetailOpen ? (zh ? '收起' : 'Hide') : (zh ? '展开' : 'Show'),
              icon: 'calendar',
              action: 'toggle-expiry-detail',
            },
          ],
        })
        if (expiryDetailOpen) {
          children.push({ type: 'table', columns: zh ? ['到期时间', '积分', '倒计时', '来源'] : ['Expires', 'Credits', 'In', 'Source'], rows: { $: 'data.expiryRows' } })
        }
      }
      children.push({ type: 'callout', text: { $: 'data.note' }, tone: { $: 'data.tone' } })
      // 重置券只有 ChatGPT 有；别的渠道挂这个按钮会让人以为能重置余额。
      if (provider === CODEX_PROVIDER) {
        if (resetArmed) {
          children.push({
            type: 'callout',
            text: zh
              ? '会用掉最早到期的那张券，立即把已用额度清零。券不会退回。'
              : 'Uses your soonest-expiring credit and resets usage. This cannot be undone.',
            tone: 'warn',
          })
          children.push({ type: 'confirm', id: 'reset', confirmLabel: zh ? '确认重置' : 'Confirm', cancelLabel: zh ? '取消' : 'Cancel' })
        } else {
          children.push({
            type: 'actions',
            items: [{ label: zh ? '重置额度' : 'Reset quota', action: 'reset_ask', icon: 'retry' }],
          })
        }
      }
      // 签到放最下面：它是低频动作，不跟余额、渠道列表抢位置。
      // 空闲时是空串（不显示提示），只有进行中 / 刚结束的 6 秒里才有文字。
      children.push({ type: 'text', text: { $: 'data.checkinText' } })
      const canManage = provider !== undefined && provider !== ALL && provider !== CODEX_PROVIDER
      // 渠道入口已经挪到顶部，底部只留三个操作按钮；模型和账号合成一个面板。
      const buttons = [
        { label: zh ? '签到' : 'Check', action: 'checkin', icon: 'check', style: 'primary' },
      ]
      if (canManage) {
        buttons.push({ label: zh ? '模型与账号' : 'Models & accounts', action: 'open-manage', icon: 'settings' })
      }
      buttons.push({ label: zh ? '刷新' : 'Refresh', action: 'refresh', icon: 'refresh' })
      // 每个按钮单独一个 actions，再放进 row。App 的原生 actions 在窄屏
      // 仍是竖排，这里不再为了两列去引入 v2 渲染。
      children.push({
        type: 'row',
        children: buttons.map((item) => ({ type: 'actions', items: [item] })),
      })
      return { type: 'stack', title: zh ? '当前渠道余额' : 'Channel balance', children }
    },
    data: (scope, emit, caps) => {
      const zh = zhOf(caps?.locale)
      let alive = true
      let timer

      const emitPlaceholder = (zh, text, tone = 'info') => {
        emit({
          headline: zh ? '未选择渠道' : 'No channel',
          metricLabel: zh ? '合计余额' : 'Total',
          total: '—',
          rows: [{ label: zh ? '状态' : 'Status', value: text, tone: 'muted' }],
          note: zh ? '先在顶栏选一个模型，或用顶部「切换」挑一个渠道。' : 'Pick a model first, or use Switch above to pick a channel.',
          tone,
          ...expiryDetailFields([], zh),
          ...checkinFields(zh),
        })
      }

      // 换渠道时上一轮请求可能还在飞；用 generation 丢弃旧结果，新请求立刻开始，
      // 不再排在前一个渠道（尤其是 ChatGPT 的两个上游请求）后面等。
      let generation = 0

      const tickOnce = async (forced, runId) => {
        // 先等设置读完，避免首屏用默认渠道闪一下。
        await stateReady
        const stale = () => !alive || runId !== generation
        if (stale()) return
        const force = forced || forceNext
        forceNext = false
        const provider = effectiveProvider(scope, undefined)
        if (provider === undefined) {
          emitPlaceholder(zh, zh ? '未选择渠道' : 'no channel')
          return
        }
        const cached = cache.get(provider)
        const fresh = cached !== undefined && Date.now() - cached.at < CACHE_MS
        if (provider !== ALL && !force && !fresh) {
          // 新渠道没有缓存就先给个立即可见的「正在读取」，别让旧渠道的数字停在那里。
          emit({
            headline: labelOf(provider),
            metricLabel: provider === CODEX_PROVIDER ? (zh ? 'GPT 可用额度' : 'GPT quota') : (zh ? '合计余额' : 'Total'),
            total: '…',
            caption: zh ? '正在读取' : 'Loading',
            ...splitFields(undefined, zh, Date.now()),
            rows: [{ label: zh ? '状态' : 'Status', value: zh ? '正在读取余额…' : 'Reading balance…', tone: 'muted' }],
            note: '',
            tone: 'info',
            ...expiryDetailFields([], zh),
            ...checkinFields(zh),
          })
        }
        try {
          const now = Date.now()
          if (provider === ALL) {
            const all = await readAll(zh, now)
            if (stale()) return
            emit({ ...all, ...checkinFields(zh) })
            return
          }
          // ChatGPT 要打两个上游接口（额度 + 重置券）。它们互不依赖，必须并行：
          // 串行实测 1.6 秒，并行 1.2 秒，切换渠道时这点延迟能明显感觉到。
          const [value, resetCredits] = await Promise.all([
            read(provider, force),
            provider === CODEX_PROVIDER ? readResetCredits(force) : Promise.resolve([]),
          ])
          if (stale()) return
          const s = provider === CODEX_PROVIDER
            ? summarizeCodexUsage(value, zh, resetCredits)
            : summarizeBadge(value, provider, zh, now)
          const when = s.updated === undefined
            ? ''
            : new Date(s.updated).toLocaleTimeString(zh ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' })
          emit({
            headline: labelOf(provider),
            metricLabel: s.metricLabel ?? (zh ? '合计余额' : 'Total'),
            total: s.metricValue ?? (s.total === undefined ? '—' : `${fmtNumber(s.total)} ${s.unit}`),
            caption: s.caption ?? (s.total === undefined
              ? zh ? '这次没拿到余额' : 'No reading this time'
              : when === '' ? undefined : zh ? `更新于 ${when}` : `Updated ${when}`),
            ...splitFields(s.split, zh, now),
            ...expiryDetailFields(s.expiringItems, zh),
            canReset: (s.resetCount ?? 0) > 0,
            rows: s.rows,
            note: s.note ?? expiryNote(s.split, zh) ?? (s.total === undefined
              ? zh
                ? '读不到余额（凭据过期或上游接口没返回）。这不代表额度是 0。'
                : 'Balance unavailable (expired credential or no upstream data). This is not 0.'
              : s.disabled > 0
                ? zh
                  ? `另有 ${s.disabled} 个停用账号未计入。`
                  : `${s.disabled} disabled account(s) not counted.`
                : ''),
            tone: s.tone ?? (s.total === undefined ? 'warn' : 'info'),
            ...checkinFields(zh),
          })
        } catch (error) {
          if (stale()) return
          const message = String(error?.message ?? error)
          const note = provider === CODEX_PROVIDER
            ? codexErrorNote(message, zh)
            : message.includes('unsupported provider')
              ? (zh ? '这个渠道没有余额接口。' : 'This channel has no balance endpoint.')
              : (zh ? '读不到余额：余额服务暂时不可用。' : 'Balance service unavailable.')
          emit({
            headline: labelOf(provider),
            metricLabel: provider === CODEX_PROVIDER ? (zh ? 'GPT 可用额度' : 'GPT quota') : (zh ? '合计余额' : 'Total'),
            total: '—',
            ...splitFields(undefined, zh, Date.now()),
            rows: [{ label: labelOf(provider), value: zh ? '读取失败' : 'failed', tone: 'warn' }],
            note,
            tone: 'warn',
            ...checkinFields(zh),
          })
        }
      }

      const tick = async (forced = false) => {
        const runId = ++generation
        await tickOnce(forced, runId)
      }

      tick()
      timer = setInterval(tick, TICK_MS)
      timer.unref?.()
      const kick = () => void tick(false)
      kicks.add(kick)
      return () => {
        alive = false
        clearInterval(timer)
        kicks.delete(kick)
      }
    },
    actions: {
      /** 展开 / 收起「逐笔到期」明细。 */
      'toggle-expiry-detail': () => {
        expiryDetailOpen = !expiryDetailOpen
        kickAll(kicks)
        return [{ refresh: 'balance' }]
      },
      /** 顶部「切换」打开的独立渠道选择面板。 */
      'open-channels': () => [{ open: 'panel:channels' }],
      /** 模型开关 + 账号管理：同一个面板，默认落在模型页。 */
      'open-manage': () => {
        r.resetManageState()
        return [{ open: 'panel:manage' }]
      },
      /** 一键签到：所有有账号的渠道，先签当前正在看的那个。 */
      checkin: (scope, event) => {
        const zh = zhOf(event?.locale)
        if (checkinState.running) return [{ toast: zh ? '正在签到，稍等' : 'Check-in in progress' }]
        void runCheckin(zh, effectiveProvider(scope, undefined))
        return [{ toast: zh ? '开始签到' : 'Checking in' }]
      },
      refresh: (scope, event) => {
        forceNext = true
        cache.clear()
        creditsCache = { at: 0, value: [] }
        r.channelsCache = { at: 0, value: r.channelsCache.value, failed: r.channelsCache.failed }
        kickAll(kicks)
        return [{ refresh: 'balance' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
      },
      /** 第一下：只把确认框亮出来，不动券。 */
      reset_ask: () => {
        resetArmed = true
        kickAll(kicks)
        return [{ refresh: 'balance' }]
      },
      reset: (scope, event) => {
        const zh = zhOf(event?.locale)
        if (event?.value?.confirmed !== true) {
          resetArmed = false
          kickAll(kicks)
          return [{ refresh: 'balance' }, { toast: zh ? '已取消' : 'Cancelled' }]
        }
        resetArmed = false
        const redeemRequestId = randomUUID()
        return {
          pending: { label: zh ? '正在重置额度' : 'Resetting quota', timeoutMs: 30_000 },
          result: async () => {
            try {
              const credits = await listCodexResetCredits(ctx)
              if (credits.length === 0) return { toast: zh ? '没有可用的重置券' : 'No reset credits available' }
              // 用最早过期的那张：不花就白等它作废。
              const outcome = await consumeCodexResetCredit(ctx, credits[0].id, redeemRequestId)
              const code = typeof outcome?.code === 'string' ? outcome.code : ''
              // 券和额度都变了：两个缓存都得清，否则界面还显示旧券数和旧百分比。
              cache.clear()
              creditsCache = { at: 0, value: [] }
              forceNext = true
              kickAll(kicks)
              if (code === 'reset' || code === 'already_redeemed') {
                resetArmed = false
                return { toast: zh ? '额度已重置' : 'Quota reset' }
              }
              if (code === 'nothing_to_reset') return { toast: zh ? '当前没有用满的窗口，先不用花券' : 'Nothing to reset yet' }
              if (code === 'no_credit') return { toast: zh ? '没有可用的重置券' : 'No reset credits' }
              return { toast: zh ? '重置失败，请稍后再试' : 'Reset failed' }
            } catch {
              return { toast: zh ? '重置失败，请稍后再试' : 'Reset failed' }
            }
          },
        }
      },
    },
  })

}

function fmtNumber(n) {
  if (!Number.isFinite(n)) return '—'
  return String(Math.round(n * 100) / 100)
}

/**
 * 「逐笔到期」那一块的字段。
 *
 * 收起时只给一行摘要（几笔、多少分），展开时才把整张表推过去 ——
 * 表格组件限 50 行，这里也只列前 20 笔，多出来的用行尾「还有 N 笔」说明。
 */
function expiryDetailFields(items, zh) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) {
    return {
      expiryDetailSummary: zh ? '这次没有带到期时间的积分包' : 'No dated packages this time',
      expiryRows: [],
    }
  }
  const dated = list.filter((item) => item.expiring)
  const allAmount = list.reduce((n, item) => n + item.remaining, 0)
  const datedAmount = dated.reduce((n, item) => n + item.remaining, 0)
  // 摘要只说笔数与金额，不写「最早 X 到期」：具体日期展开后逐条都在表里。
  const summary = zh
    ? `${list.length} 笔共 ${fmtAmount(allAmount)}，其中临期 ${dated.length} 笔 ${fmtAmount(datedAmount)}`
    : `${list.length} package(s), ${fmtAmount(allAmount)} total; ${dated.length} expiring (${fmtAmount(datedAmount)})`
  const rows = list.slice(0, 20).map((item) => [
    item.expiry,
    fmtAmount(item.remaining),
    item.days <= 0 ? (zh ? '今天' : 'today') : zh ? `${item.days} 天` : `${item.days}d`,
    item.name + (list.length > 0 && item.nickname !== undefined ? ` · ${item.nickname}` : ''),
  ])
  if (list.length > 20) {
    rows.push([zh ? `还有 ${list.length - 20} 笔` : `${list.length - 20} more`, '', '', ''])
  }
  return { expiryDetailSummary: summary, expiryRows: rows }
}
