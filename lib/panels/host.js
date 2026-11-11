// 主机设置：本机 OpenAI 网关。
//
// 这是 Jet Hub 设置页里的全局开关，跟「当前选了哪个渠道」无关，但也不值得
// 单独占一个面板入口 —— 它和「模型 / 账号」同属「在主机上怎么配」
// 这一类，所以放进管理面板的「主机设置」子页（见 panels/manage.js）。
//
// 全部只读 Jet Hub 的进程内状态，插件自己不监听端口、不碰密钥。

import { readGateway, setGatewayEnabled } from '../host.js'
import { briefError, zhOf } from '../util.js'

/** 网关状态缓存：开关动作之后主动失效，平时 10 秒内直接开窗。 */
const STATE_CACHE_MS = 10_000

/**
 * 网关地址 → 一行可读的 URL。
 *
 * Jet Hub 的 `gatewayAddress()` 返回 `{ host, port }` 对象（不是字符串），
 * 直接 String() 会显示成 `[object Object]`；另外 host 可能是 `0.0.0.0`
 * （允许局域网时），那不是能直接连的地址，要换成本机回环并说明。
 */
function formatAddress(raw) {
  if (raw === null || raw === undefined) return ''
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text === '' ? '' : text
  }
  if (typeof raw !== 'object') return ''
  const host = typeof raw.host === 'string' ? raw.host.trim() : ''
  const port = Number(raw.port)
  const portText = Number.isFinite(port) && port > 0 ? String(port) : ''
  if (host === '' && portText === '') return ''
  // 0.0.0.0 / :: 是「监听全部网卡」，本机自己连要用回环地址。
  const wildcard = host === '0.0.0.0' || host === '::' || host === '[::]'
  const shownHost = wildcard ? '127.0.0.1' : host
  const url = `http://${shownHost}${portText === '' ? '' : `:${portText}`}`
  return wildcard ? `${url}（本机；局域网用本机 IP）` : url
}

export function createHostSection(ctx) {
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

  /** 读网关状态；失败就整页降级成「读不到」，不发半份状态。 */
  const readState = async (force) => {
    if (!force && Date.now() - cache.at < STATE_CACHE_MS && cache.value !== undefined) return cache.value
    const gateway = await readGateway(ctx).catch(() => undefined)
    const value = { gateway }
    if (gateway !== undefined) cache = { at: Date.now(), value }
    return value
  }

  /** 这一页的组件树（不含外层 stack / 标签按钮，那些由 manage 提供）。 */
  const view = (zh) => {
    // 每行就是一个开关：标题 + 说明 + 右侧状态，点行即切换。
    //
    // 之前用 actions 按钮，窄屏 / 大字号时每个按钮都被撑成整行，五个开关加复制、
    // 刷新一共七行按钮，半屏都是按钮。list 行既有原生观感，又能把「名称、说明、
    // 当前状态」放在同一行，纵向占用只有原来的几分之一。
    const children = [
      { type: 'text', text: { $: 'data.hostHeadline' }, tone: 'muted' },
      // 和模型 / 账号两页一样先放一张指标卡：三页的「固定骨架」对齐后，
      // 切换时 sheet 高度变化小，不会跟着内容多少上下跳。
      {
        type: 'row',
        children: [
          {
            type: 'metric',
            label: zh ? '本机网关' : 'Gateway',
            value: { $: 'data.gatewayValue' },
            caption: { $: 'data.gatewayCaption' },
            tone: { $: 'data.gatewayTone' },
          },
        ],
      },
      { type: 'list', items: { $: 'data.hostItems' } },
      { type: 'callout', text: { $: 'data.hostNote' }, tone: { $: 'data.hostNoteTone' } },
    ]
    return children
  }

  /**
   * 缓存里现成的主机页字段（切页用，不发 IO）。没有缓存就返回 undefined。
   *
   * 语言由调用方传入（不用缓存里记 locale：`cache` 会被 readState 整体替换）。
   */
  const peek = (zh) => (cache.value === undefined ? undefined : buildFields(cache.value, zh))

  /** 把一组主机状态摊成这一页要的字段。`data` 与 `peek` 共用这一份。 */
  const buildFields = (state, zh) => {
    const gateway = state.gateway
    const gOn = gateway?.enabled === true
    const gRunning = gateway?.running === true
    const addressText = formatAddress(gateway?.address)

    // 网关这一行的状态：三种情况分开说。开关开着但没在监听（端口被占 / 被 env
    // 停用）是常态，合成一句「已开启」会让人以为能连。
    let gatewayState = zh ? '未开启' : 'Off'
    let gatewayTone = 'muted'
    let gatewaySubtitle = ''
    if (gateway === undefined) {
      gatewayState = '—'
      gatewayTone = 'warn'
      gatewaySubtitle = zh ? '读不到状态' : 'State unavailable'
    } else if (gateway.blockedByEnv === true) {
      gatewayState = zh ? '被环境变量停用' : 'Blocked by env'
      gatewayTone = 'warn'
      gatewaySubtitle = 'DSH_OPENAI_GATEWAY_ENABLED'
    } else if (gOn && gRunning) {
      gatewayState = zh ? '运行中' : 'Running'
      gatewayTone = 'good'
      gatewaySubtitle = addressText || (zh ? '已监听' : 'Listening')
    } else if (gOn) {
      gatewayState = zh ? '未监听' : 'Not listening'
      gatewayTone = 'warn'
      gatewaySubtitle = gateway.lastError
        ? String(gateway.lastError).slice(0, 60)
        : (zh ? '开关已开，但没起来' : 'Switch on, not listening')
    } else {
      // 关着时不给副标题：右侧「未开启」已经说清楚了，再写「点这一行打开」
      // 是在教怎么点，而这一行本来就是开关。
      gatewaySubtitle = ''
    }

    // 每一行 = 一个开关。`action` 带上意图（当前是开还是关），动作里直接按它走，
    // 不再额外读一次状态再取反（那会在连点时算错方向）。
    const items = [
      {
        title: zh ? '本机网关' : 'Gateway',
        subtitle: gatewaySubtitle,
        trailing: gatewayState,
        icon: 'power',
        action: { id: 'gateway-toggle', args: { next: !(gOn && !gateway?.blockedByEnv) } },
        ...(gatewayTone === 'good' ? { tone: 'good' } : gatewayTone === 'warn' ? { tone: 'warn' } : {}),
      },
    ]

    // 密钥只用于复制，不进任何说明文字。
    if (gateway?.apiKey?.value) {
      items.push({
        title: zh ? '复制网关 Key' : 'Copy gateway key',
        subtitle: `${String(gateway.apiKey.value).slice(0, 8)}…`,
        trailing: zh ? '复制' : 'Copy',
        icon: 'copy',
        action: 'copy-key',
      })
    }

    // 「点一行即切换」这种教怎么点的文案不再兜底：行本身就能点，说了反而占一行。
    return {
      // 顶部标题与指标卡：和模型 / 账号两页保持同一套「固定骨架」。
      hostHeadline: zh ? '主机设置' : 'Host settings',
      gatewayValue: gatewayState,
      gatewayCaption: gatewayTone === 'good' ? (addressText || (zh ? '已监听' : 'Listening')) : '',
      gatewayTone,
      hostItems: items,
      hostNote: note,
      hostNoteTone: note !== '' ? noteTone : 'info',
    }
  }

  /**
   * 推这一页的数据。
   *
   * `base` 是 manage 铺好的公共字段（panelTitle / tab / 骨架），这里整份并上去 ——
   * 四个子页统一这个签名，manage 那边就不用为每一页写一套合并逻辑。
   */
  const data = async (emit, zh, force, base = {}) => {
    let state
    try {
      state = await readState(force)
    } catch (error) {
      emit({
        ...base,
        hostHeadline: zh ? '主机设置' : 'Host settings',
        gatewayValue: '—',
        gatewayCaption: '',
        gatewayTone: 'warn',
        hostItems: [],
        hostNote: zh ? `读不到主机状态：${briefError(error)}` : `Cannot read host state: ${briefError(error)}`,
        hostNoteTone: 'warn',
      })
      return
    }
    emit({ ...base, ...buildFields(state, zh) })
  }

  const actions = {
    /** 网关开关。开的时候如果被 env 停用，Jet Hub 会照常落盘但不监听。 */
    'gateway-toggle': (scope, event) => {
      const zh = zhOf(event?.locale)
      return {
        pending: { label: zh ? '正在切换网关' : 'Switching gateway', timeoutMs: 30_000 },
        result: async () => {
          try {
            // 行里已经带了意图（点的时候状态是什么就取反），不再读一次再取反：
            // 连点时会读到「上一次还没落盘」的旧状态，把方向算错。
            const wanted = event?.value?.next
            const next = typeof wanted === 'boolean' ? wanted : (await readGateway(ctx))?.enabled !== true
            const value = await setGatewayEnabled(ctx, next)
            invalidate()
            setNote(
              next
                ? (value?.running === true
                  ? (zh ? '网关已启动。' : 'Gateway started.')
                  : (zh ? '网关开关已打开，但当前没在监听（端口被占或被环境变量停用）。' : 'Switch is on but the gateway is not listening (port taken or blocked by env).'))
                : (zh ? '网关已关闭。' : 'Gateway stopped.'),
              next && value?.running !== true ? 'warn' : 'info',
            )
            kick()
            return { toast: next ? (zh ? '已打开网关' : 'Gateway on') : (zh ? '已关闭网关' : 'Gateway off') }
          } catch (error) {
            invalidate()
            setNote(zh ? `切换失败：${briefError(error)}` : `Switch failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '切换失败' : 'Switch failed' }
          }
        },
      }
    },
    'host-refresh': (scope, event) => {
      const zh = zhOf(event?.locale)
      invalidate()
      note = ''
      kick()
      return [{ refresh: 'host' }, { toast: zh ? '正在刷新' : 'Refreshing' }]
    },
    /**
     * 复制网关 API Key。key 只从内存缓存里取（读状态时 Jet Hub 已经回传过），
     * 不打印、不写进任何说明文字；复制后只给一句「已复制」。
     */
    'copy-key': (scope, event) => {
      const zh = zhOf(event?.locale)
      const key = cache.value?.gateway?.apiKey?.value
      if (typeof key !== 'string' || key === '') {
        return { toast: zh ? '还没有 Key，先打开网关' : 'No key yet; turn the gateway on first' }
      }
      return { copy: key, toast: zh ? '已复制 API Key' : 'API key copied' }
    },
  }
  return { view, data, peek, actions, kick, kicks, invalidate }
}
