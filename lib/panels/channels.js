// 渠道选择面板：从余额面板顶部的「切换」进来。
//
// 列表来自 runtime 的渠道探测缓存（5 分钟），选中的渠道写回 prefs。
//
// ⚠️ 用 list 而不是 options：options 组件最多 8 项，渠道一多（Jet Hub 6 个渠道
// 加 ChatGPT 就是 9 项）排在最后的那几个会被截掉，ChatGPT 永远看不见。
// list 上限 50 行，点一行就切换。

import { ALL } from '../constants.js'
import { labelOf } from '../labels.js'
import { kickAll, zhOf } from '../util.js'

/** list 组件上限 50 行（协议里的 listItemsMax）。 */
const MAX_ROWS = 50

export function registerChannels(ctx, r) {
  ctx.dshGo.panel('channels', {
    view: (_scope, caps) => {
      const zh = zhOf(caps?.locale)
      return {
        type: 'stack',
        title: { $: 'data.panelTitle' },
        children: [
          { type: 'text', text: { $: 'data.note' }, tone: 'muted' },
          { type: 'list', items: { $: 'data.items' } },
          { type: 'actions', items: [{ label: zh ? '刷新' : 'Refresh', action: 'channels-refresh', icon: 'refresh' }] },
        ],
      }
    },
    data: (_scope, emit, caps) => {
      const zh = zhOf(caps?.locale)
      let alive = true
      const render = async () => {
        await r.stateReady
        // 用共享的渠道列表缓存：第一次为空会自己探；之后 5 分钟内直接开窗。
        const probe = await r.readConfiguredProviders(false).catch(() => r.channelsCache)
        if (!alive) return
        const row = (title, value, subtitle) => ({
          title,
          ...(subtitle === undefined ? {} : { subtitle }),
          icon: value === ALL ? 'list' : 'account',
          ...(r.picked === value ? { trailing: zh ? '已选' : 'Selected' } : {}),
          action: { id: 'pick-channel', args: { channel: value } },
        })
        // 前两行是「跟随对话」「全部渠道」，后面才是具体渠道。
        const items = [row(zh ? '跟随当前对话' : 'Follow session', 'current', zh ? '按当前对话用的渠道显示' : 'Uses the session channel')]
        if (probe.value.length > 1) {
          items.push(row(zh ? '全部渠道' : 'All channels', ALL, zh ? `${probe.value.length} 个渠道合计` : `${probe.value.length} channels`))
        }
        let shown = 0
        for (const hit of probe.value) {
          if (items.length >= MAX_ROWS) break
          items.push(row(`${labelOf(hit.provider)}（${hit.count}）`, hit.provider))
          shown += 1
        }
        const left = probe.value.length - shown
        // 只在「真有事要说」时给一行说明：没配渠道、或有渠道没列出。
        // 「点一行就切过去」这种教怎么点的字不再写 —— 行本身已经能点。
        const note = probe.value.length === 0
          ? (zh ? '还没有配置渠道。' : 'No channels configured.')
          : left > 0
            ? (zh ? `另有 ${left} 个渠道没列出。` : `${left} more not listed.`)
            : ''
        emit({
          panelTitle: zh ? '选择渠道' : 'Channels',
          note,
          items,
        })
      }
      void render()
      const kick = () => void render()
      r.channelKicks.add(kick)
      return () => {
        alive = false
        r.channelKicks.delete(kick)
      }
    },
    actions: {
      'pick-channel': (_scope, event) => {
        const zh = zhOf(event?.locale)
        // list 行的参数在 args 里；旧的 options 走 value，两个都认。
        const value = event?.value?.channel ?? event?.value?.value
        if (typeof value !== 'string' || value === '') return [{ toast: zh ? '没认出这个渠道' : 'Unknown channel' }]
        r.picked = value
        r.persist()
        r.resetManageState('models')
        kickAll(r.channelKicks)
        kickAll(r.manageKicks)
        kickAll(r.balanceKicks)
        return [{ refresh: 'balance' }, { refresh: 'channels' }, { toast: zh ? '已切换' : 'Switched' }]
      },
      'channels-refresh': (_scope, event) => {
        r.channelsCache = { at: 0, value: r.channelsCache.value, failed: r.channelsCache.failed }
        kickAll(r.channelKicks)
        return [{ refresh: 'channels' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
      },
    },
  })
}
