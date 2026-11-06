// 渠道选择面板：从余额面板顶部的「切换」进来。
//
// 选项列表来自 runtime 的渠道探测缓存（5 分钟），选中的渠道写回 prefs。

import { ALL } from '../constants.js'
import { labelOf } from '../labels.js'
import { kickAll, zhOf } from '../util.js'

/** 面板里「切换渠道」的选项上限（App 的 options 组件最多 8 项，留一个给「全部渠道」）。 */
const MAX_CHANNEL_OPTIONS = 8

export function registerChannels(ctx, r) {
  ctx.dshGo.panel('channels', {
    view: (_scope, caps) => {
      const zh = zhOf(caps?.locale)
      return {
        type: 'stack',
        title: { $: 'data.panelTitle' },
        children: [
          { type: 'text', text: { $: 'data.note' }, tone: 'muted' },
          { type: 'options', id: 'pick-channel', options: { $: 'data.options' }, selected: { $: 'data.selected' } },
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
        const options = [{ label: zh ? '跟随当前对话' : 'Follow session', value: 'current' }]
        if (probe.value.length > 1) options.push({ label: zh ? '全部渠道' : 'All channels', value: ALL })
        for (const hit of probe.value) {
          if (options.length >= MAX_CHANNEL_OPTIONS) break
          options.push({ label: `${labelOf(hit.provider)}（${hit.count}）`, value: hit.provider })
        }
        emit({
          panelTitle: zh ? '选择渠道' : 'Channels',
          note: probe.value.length === 0
            ? (zh ? '还没有配置渠道。' : 'No channels configured.')
            : (zh ? '选一个渠道，余额面板会跟着换。' : 'Pick a channel; the balance panel follows.'),
          options,
          selected: r.picked,
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
        const value = event?.value?.value
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
