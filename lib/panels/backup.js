// 备份与恢复：导出账号池快照、从用户选中的文件恢复。
//
// 两个方向都经由 Jet Hub：导出是 `backup.export`（宿主读凭据拼快照），
// 导入是 `backup.import`（宿主校验格式并落盘）。插件只负责**文件**这一半。
//
// 导出：写到用户能看见的目录，并在提示里写清楚写到了哪。
// 导入：v1.3 的 `files` 能力 —— 用户点「从文件恢复」，App 弹系统文件选择器，
//       桥接把选中的字节作为一次性快照交回（`readPickedFile`），插件校验内容后
//       交给 Jet Hub。**不再扫描目录、也不再按文件名猜**：换机、改名、从聊天
//       软件另存出来的备份都能用。
//
// ⚠️ 导入是**破坏性**的（`replace` 会整份替换账号池与模型黑名单），
// 所以永远走「先亮确认 → 再动手」，且默认只提供 `merge`。

import {
  EXPORT_TIMEOUT_MS,
  IMPORT_TIMEOUT_MS,
  exportBackup,
  importBackup,
  readBackupStatus,
} from '../jet-hub.js'
import { fmtBytes, isPhoneDir, parseBackupBytes, writeBackup, backupDir } from '../backup.js'
import { briefError, zhOf } from '../util.js'

/** 账号池读数缓存：导出前大概知道有多少个号。 */
const STATE_CACHE_MS = 15_000
/** 选中的文件在这张面板里留多久；超过就要求重选，免得「确认」到一份看不见的文件。 */
const PICKED_TTL_MS = 10 * 60_000
/** 操作结果提示（已导出 / 已恢复 / 失败原因）挂多久；到点自己收走，不用人管。 */
const NOTE_TTL_MS = 30_000

export function createBackupSection(ctx) {
  /** `{ at, accounts, withoutExpiry }` */
  let cache = { at: 0, value: undefined }
  let note = ''
  let noteTone = 'info'
  /**
   * 提示的到期定时器。
   *
   * ⚠️ 必须有：导出 / 恢复的结果是挂在本页上的一句说明，不会自己走。早先它一直
   * 留在那儿（「已导出 …」「已从 … 恢复：导入 0 个」），用户下次进这一页还以为
   * 是刚才发生的。到点清掉并 `kick()` 一次，让视图换回默认说明。
   * 每次 `setNote` 都重置定时器，连续操作不会互相顶掉。
   */
  let noteTimer
  /**
   * 刚选中、等着确认的那份备份。
   *
   * `payload` 是校验过的备份本体（一次性快照解出来的对象，已复制出字节之外），
   * `name` / `bytes` 只用于显示 —— 文件名来自用户设备，是不可信的展示信息。
   */
  let picked = undefined
  /** 恢复方式：`merge` 只追加，`replace` 整份替换。 */
  let pickedMode = 'merge'
  /**
   * 导出多选：是否进入选择模式，以及选中的账号 id。
   *
   * Jet Hub 的 `backup.export` 接受 `accountIds`（只作用于 accounts / credentials，
   * 黑名单与锁定表仍是全量）。这里不传 = 导出全部，传了 = 只导出选中的。
   * 选项组件最多 8 项（账号常有十几个），所以复用账号页那套「点行勾选」。
   */
  /** 「导出备份」按下去之后展开二选一（全部 / 选账号）。 */
  let exportMenu = false
  let selectMode = false
  let selected = new Set()
  /** 视图是同步的：空 list 会画成「暂无数据」，得知道有没有行可画。 */
  let selectRowCount = 0
  /**
   * 正在恢复 / 导出中。
   *
   * ⚠️ 防连点：恢复要写账号池，同一份文件连点两次会真的导两遍（merge 下第二遍
   * 全跳过、replace 下白写一次）。这里挡掉重复触发，并在结果回来或超时后复位。
   */
  let busy = ''
  /**
   * 解锁兜底计时器。
   *
   * ⚠️ 必须有：`busy` 原本只在结果回来时（`finally`）复位。但恢复走的是桥接的
   * pending 通道，而**连接一断桥接就静默作废**（`dropPendings` 不通知客户端），
   * 那个 `finally` 永远等不到 —— 面板从此锁死，之后每次点都弹「上一个操作还没
   * 结束」。这正是「导一个文件容易被卡住」的来源。
   * 现在给每次操作挂一个到期解锁：到点无论如何放行，用户重试即可。
   */
  let busyTimer
  /** 最近一次读取失败的原因；为空表示没失败过。 */
  let error = ''
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
    clearTimeout(noteTimer)
    if (text === '') {
      noteTimer = undefined
      return
    }
    noteTimer = setTimeout(() => {
      noteTimer = undefined
      note = ''
      noteTone = 'info'
      // 面板还开着才需要重画；关着时下次进来读的就是空提示。
      kick()
    }, NOTE_TTL_MS)
    noteTimer.unref?.()
  }
  /**
   * 占用锁；`ms` 后无论如何解锁。
   *
   * 用「到期自动放行」而不是「等 promise 结束」：上游可能根本不回来。
   * 到期之后迟到的结果仍会照常走完自己的分支（它只是写状态、不再占锁）。
   */
  const lock = (name, ms) => {
    busy = name
    clearTimeout(busyTimer)
    busyTimer = setTimeout(() => {
      busyTimer = undefined
      busy = ''
      // 面板还开着才需要重画；关着时下次进来锁本来就是空的。
      kick()
    }, ms)
    busyTimer.unref?.()
  }
  const unlock = () => {
    clearTimeout(busyTimer)
    busyTimer = undefined
    busy = ''
  }

  /** 选中状态作废：丢掉载荷，确认框随之消失（视图只看 `picked`）。 */
  const clearPicked = () => {
    picked = undefined
    pickedMode = 'merge'
  }
  const pickedFresh = () => picked !== undefined && Date.now() - picked.at < PICKED_TTL_MS

  const readState = async (force) => {
    if (!force && Date.now() - cache.at < STATE_CACHE_MS && cache.value !== undefined) return cache.value
    // ⚠️ 账号池读数读不到时**必须上抛**，不能 `catch` 成 undefined：
    // 那样 `accounts` 会变成 0，界面显示「账号池 0 个」——一个看起来正常的
    // 假事实，比「读不到」有害得多（用户会以为账号没了）。
    const status = await readBackupStatus(ctx)
    const accountList = Array.isArray(status?.accountList) ? status.accountList : []
    // 池子里已经没有的账号，不能被继续选中（否则导出会带上一个不存在的 id）。
    const ids = new Set(accountList.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')))
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id)
    const value = {
      accounts: Number(status?.accounts) || 0,
      withoutExpiry: Number(status?.withoutExpiry) || 0,
      accountList,
    }
    cache = { at: Date.now(), value }
    return value
  }

  const view = (zh) => {
    const children = [
      { type: 'text', text: { $: 'data.backupHeadline' }, tone: 'muted' },
      { type: 'callout', text: { $: 'data.backupNote' }, tone: { $: 'data.backupNoteTone' } },
      {
        type: 'actions',
        items: [
          // 点它**不直接导出**，而是展开下面的两个选项：全部 / 选账号。
          { label: { $: 'data.backupExportLabel' }, action: 'backup-export-menu', icon: 'download', style: 'primary' },
          // 恢复入口：点它 → App 弹系统文件选择器（v1.3 files）。
          { label: { $: 'data.backupPickLabel' }, action: 'backup-pick', icon: 'folder-open' },
        ],
      },
    ]
    // 点了「导出备份」之后才展开这条二选一：一个按钮承担两种意图，比并排三个
    // 按钮清楚（并排时「导出备份」和「选择账号导出」看着像两件事）。
    if (exportMenu) {
      children.push({ type: 'text', text: { $: 'data.backupExportMenuHint' }, tone: 'muted' })
      children.push({
        type: 'actions',
        items: [
          { label: { $: 'data.backupExportAllLabel' }, action: 'backup-export', icon: 'archive', style: 'primary' },
          { label: { $: 'data.backupSelectLabel' }, action: 'backup-select-mode', icon: 'check' },
        ],
      })
    }
    // 忙的时候必须留一个出口：恢复可能永远等不到结果（桥接断连静默作废），
    // 没有这个按钮就只能干等兜底计时器到期。
    if (busy !== '') {
      children.push({ type: 'text', text: { $: 'data.backupBusyLine' }, tone: 'muted' })
      children.push({ type: 'actions', items: [{ label: { $: 'data.backupBusyCancelLabel' }, action: 'backup-busy-cancel', icon: 'stop' }] })
    }
    if (selectMode) {
      children.push({ type: 'text', text: { $: 'data.backupSelectHint' }, tone: 'muted' })
      children.push({
        type: 'actions',
        items: [
          { label: { $: 'data.backupPickAllLabel' }, action: 'backup-select-all', icon: 'check' },
          { label: { $: 'data.backupExportSelectedLabel' }, action: 'backup-export-selected', icon: 'download', style: 'primary' },
        ],
      })
      // 空列表会画成「暂无数据」；没账号时上面那句提示已经说清了。
      if (selectRowCount > 0) children.push({ type: 'list', items: { $: 'data.backupAccountRows' } })
    }
    // 选好文件之后才画这一块：确认框是视图渲染的，状态在插件里。
    //
    // ⚠️ 选完文件就**直接进入待确认**（视图只认 `picked`，选上就有确认框）。早先这里是
    // 「先只给一个模式切换按钮，点了它才出确认框」，结果是提示写着「点确认恢复
    // 才会动手」、界面上却根本没有那个按钮 —— 用户必须先点一次模式切换，
    // 语义完全反了。现在默认合并模式直接亮确认，模式按钮退居「要改方式」。
    if (picked !== undefined) {
      // 文件信息做成一行行的卡片，比一整句「已选：xxx（28.7 KB，8 个账号）」
      // 好扫：文件名太长时那句话会折成三行，数字埋在中间。
      children.push({ type: 'list', items: { $: 'data.backupPickedRows' } })
      // 恢复方式用单选，而不是「改成另一种」的切换按钮：切换按钮永远只显示
      // 「另一个」选项，当前是什么得从别处找；单选把两个选项和当前状态摆在一起。
      // ⚠️ `options` 的 `id` **就是**被调用的动作名（不是任意的视图元素 id）：
      // 点选后 App 拿这个 id 去找 `actions[id]`。写成 `backup-mode-options` 而动作
      // 注册成 `backup-mode` 时，点一下就报错 —— 实测踩到过。
      children.push({
        type: 'options',
        id: 'backup-mode',
        options: { $: 'data.backupModeOptions' },
        // 绑定而不是直接写值：视图函数是同步的，写死会让单选停在旧值上。
        selected: { $: 'data.backupMode' },
      })
      // 选中方式后紧跟它的后果说明，不再重复一遍「已选好文件」。
      children.push({ type: 'callout', text: { $: 'data.backupModeHint' }, tone: { $: 'data.backupModeTone' } })
      children.push({ type: 'confirm', id: 'backup-restore-confirm', confirmLabel: zh ? '确认恢复' : 'Restore', cancelLabel: zh ? '取消' : 'Cancel' })
    }
    return children
  }

  /**
   * 导出多选的行：一行一个账号，点一下切换选中。
   *
   * 不用 `options` 组件：它最多 8 项，而账号常有十几个。点行勾选是这套界面里
   * 已有做法（账号排序页就是这么做的），没有数量上限。
   * 昵称可能为空，退回 id，免得出现一行空白无从辨认。
   */
  const selectRows = (accountList, zh) => (Array.isArray(accountList) ? accountList : [])
    .filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
    .map((entry) => {
      const on = selected.has(entry.id)
      const name = typeof entry.nickname === 'string' && entry.nickname !== '' ? entry.nickname : entry.id
      const provider = typeof entry.provider === 'string' ? entry.provider : ''
      // 停用的账号也允许导出：它仍是备份的一部分，只是平时不参与选号。
      const off = entry.enabled === false
      const row = {
        title: name,
        icon: on ? 'check' : 'account',
        trailing: on ? (zh ? '已选中' : 'Selected') : (zh ? '点按选中' : 'Tap to select'),
        action: { id: 'backup-select-toggle', args: { account: entry.id } },
      }
      if (on) row.tone = 'good'
      const bits = [provider, off ? (zh ? '已停用' : 'disabled') : ''].filter((x) => x !== '')
      if (bits.length > 0) row.subtitle = bits.join(' · ')
      return row
    })

  /**
   * 把一份快照摊成这一页要的字段。
   *
   * ⚠️ **两条渲染路径共用这一个函数**：`data`（走 IO 读一次）和 `peek`
   * （切页时用缓存，不发 IO）。之前两处各写一遍，文案已经漂了。
   * `state` 为 `undefined` 表示读失败 —— 此时**导出照样能用**（导出的结果
   * 取决于 Jet Hub 自己读到的账号池，跟这里的读数无关），只是数量显示不出来。
   */
  const buildFields = (state, zh) => {
    const poolCount = state === undefined ? undefined : state.accounts
    const where = isPhoneDir() ? 'Download/DSH-Go/' : backupDir()
    const base = {
      backupHeadline: zh ? '备份与恢复' : 'Backup & restore',
      backupExportLabel: zh ? '导出备份' : 'Export',
      backupPickLabel: zh ? '从文件恢复' : 'Restore from file',
      /** 当前选中的恢复方式；视图里的单选读它。 */
      backupMode: pickedMode,
      /** 当前模式的两个选项；`selected` 由视图上的 options 组件标出当前值。 */
      backupModeOptions: [
        { label: zh ? '合并（推荐）' : 'Merge (recommended)', value: 'merge' },
        { label: zh ? '整体替换' : 'Replace', value: 'replace' },
      ],
      backupModeHint: pickedMode === 'merge'
        ? (zh ? '只追加新账号，已有的不动。' : 'Only adds new accounts; existing ones are untouched.')
        : (zh ? '会覆盖现有账号、模型黑名单和永久锁定表，无法撤销。' : 'Overwrites accounts, the model blacklist and permanent locks. Cannot be undone.'),
      backupModeTone: pickedMode === 'merge' ? 'info' : 'warn',
      accountPoolCount: poolCount,
      // 文件与目标池摆成两行：文件名很长时整句会折三行，数字埋中间看不清。
      // `poolCount` 是这一份快照里的池子规模（读不到时为 0，显示成「—」）。
      backupPickedRows: picked === undefined ? [] : (zh
        ? [
          { title: picked.name, icon: 'archive', subtitle: `${fmtBytes(picked.bytes)} · 文件里有 ${picked.accounts} 个账号` },
          {
            title: poolCount === undefined ? '当前账号池 —' : `当前账号池 ${poolCount} 个`,
            icon: 'account',
            subtitle: poolCount === undefined ? '读不到当前池子，恢复仍可进行' : '恢复只影响这个池子',
          },
        ]
        : [
          { title: picked.name, icon: 'archive', subtitle: `${fmtBytes(picked.bytes)} · ${picked.accounts} account(s) in file` },
          {
            title: poolCount === undefined ? 'Current pool —' : `${poolCount} account(s) currently`,
            icon: 'account',
            subtitle: poolCount === undefined ? 'Cannot read the pool; restore still works' : 'Restore affects this pool only',
          },
        ]),
      backupAccountCount: 0,
      // 二选一：全部导出 / 选账号导出。
      backupExportMenuHint: zh
        ? '要导出哪一份？'
        : 'What to export?',
      backupExportAllLabel: zh ? '导出全部账号' : 'Export all accounts',
      // 多选：进入选择模式后列表变成可勾选的行，按钮文案跟着选中数走。
      backupSelectLabel: selectMode
        ? (zh ? '退出选择' : 'Done selecting')
        : (zh ? '选账号导出' : 'Pick accounts'),
      backupPickAllLabel: zh ? '全选' : 'Select all',
      backupExportSelectedLabel: selected.size > 0
        ? (zh ? `导出选中的 ${selected.size} 个` : `Export ${selected.size} selected`)
        : (zh ? '导出选中的账号' : 'Export selected'),
      backupSelectHint: selectMode
        ? (zh ? '点一行切换选中；不选任何账号时导出的是全部。' : 'Tap a row to toggle; exporting with none picked exports all.')
        : '',
      backupAccountRows: [],
      backupBusyLine: busy === 'restore'
        ? (zh ? '正在恢复…如果一直没结果，可以点下面取消，然后重试。' : 'Restoring… if it never finishes, cancel below and retry.')
        : busy === 'export'
          ? (zh ? '正在导出…' : 'Exporting…')
          : '',
      backupBusyCancelLabel: zh ? '取消这个操作' : 'Cancel operation',
    }
    if (state === undefined) {
      return {
        ...base,
        backupNote: zh ? `读不到账号池：${error === '' ? '未知原因' : error}` : `Cannot read the account pool: ${error === '' ? 'unknown' : error}`,
        backupNoteTone: 'warn',
      }
    }
    return {
      ...base,
      backupHeadline: zh
        ? `账号池 ${state.accounts} 个${state.withoutExpiry > 0 ? `（${state.withoutExpiry} 个没记到期时间）` : ''}`
        : `${state.accounts} account(s)${state.withoutExpiry > 0 ? ` (${state.withoutExpiry} without expiry)` : ''}`,
      backupNote: note !== '' ? note : (zh
        ? `导出到 ${where}；文件里有登录凭据，别分享出去。恢复时用「从文件恢复」自己挑文件。`
        : `Saved to ${where}; the file contains credentials, do not share it. Use “Restore from file” to pick one.`),
      backupNoteTone: note !== '' ? noteTone : 'info',
      backupAccountCount: state.accounts,
      backupAccountRows: (() => {
        const rows = selectMode ? selectRows(state.accountList, zh) : []
        selectRowCount = rows.length
        return rows
      })(),
    }
  }

  const data = async (emit, zh, force, base) => {
    let state
    try {
      state = await readState(force)
    } catch (cause) {
      // 读失败也要让视图换成「读不到」，不然会一直停在上一份数据上。
      // 原因带回去：只说「读不到」时用户和排查的人都无从下手。
      error = briefError(cause)
      emit({ ...base, ...buildFields(undefined, zh) })
      return
    }
    error = ''
    emit({ ...base, ...buildFields(state, zh) })
  }

  const peek = (zh) => (cache.value === undefined ? undefined : buildFields(cache.value, zh))

  /** 校验失败 → 一句人话。别把 `not-json` 这种东西甩给用户。 */
  const pickError = (zh, error) => {
    const code = String(error?.message ?? error)
    const text = {
      'not-utf8': zh ? '这个文件不是文本，可能选错了' : 'Not a text file',
      'not-json': zh ? '这个文件不是 JSON，不是备份' : 'Not JSON; not a backup',
      'not-object': zh ? '这个文件的内容不像备份' : 'Not a backup payload',
      'wrong-format': zh ? '不是本插件的备份文件' : 'Not a backup of this plugin',
      'wrong-version': zh ? '备份版本不受支持' : 'Unsupported backup version',
      'no-exported-at': zh ? '备份缺少导出时间' : 'Backup has no exportedAt',
      'bad-credentials': zh ? '备份的凭据字段无效' : 'Invalid credentials field',
      'bad-accounts': zh ? '备份的账号字段无效' : 'Invalid accounts field',
      'too-large': zh ? '文件超过 8 MB' : 'File exceeds 8 MB',
    }[code]
    if (text !== undefined) return text
    return zh ? `读取失败：${briefError(error)}` : `Cannot read it: ${briefError(error)}`
  }

  /**
   * 真正做导出。`accountIds` 为 undefined 时导出全部。
   *
   * ⚠️ 传了 `accountIds`，上游**仍会**导出全量的模型黑名单与永久锁定表
   * （见 Jet Hub 的 `backup.export`），所以产物始终是可整体还原的自包含快照，
   * 不会因为「只选了 2 个账号」就变成一份残缺文件。
   *
   * ⚠️ 同步做完，**不挂「正在导出」的白条**。桥接的 pending 收尾只发在原
   * WebSocket 上，连接一断（App 切后台、重连）客户端就永远等不到 `done`，
   * 白条会一直挂到本地超时 —— 实测就是「导出早好了，提示不消失」。
   * 代价：必须在 3 秒内返回（桥接 `handlerTimeoutMs`），否则被 504 打死；
   * 10 个账号实测几十毫秒，够用。失败要说清楚，不能让人以为是数据问题。
   */
  const exportNow = async (event, accountIds) => {
    const zh = zhOf(event?.locale)
    // 防连点：连点会写出多份内容相同的备份，还会让上游排队。
    if (busy !== '') return [{ toast: zh ? '上一个操作还没结束' : 'Still working' }]
    // 导出自己有 2.5 秒超时，再留一点余量；即便超时机制失效也不会锁死。
    lock('export', EXPORT_TIMEOUT_MS + 3_000)
    try {
      const value = await exportBackup(ctx, accountIds)
      const payload = value?.payload
      if (payload === undefined) throw new Error('empty-backup')
      const file = await writeBackup(payload)
      const warnings = Array.isArray(value?.warnings) ? value.warnings.length : 0
      // ⚠️ 这里**不** invalidate：导出是只读的，账号池一个都没变，
      // 作废缓存只会让面板再打一次 `backup.status`（多一次 RPC 往返）。
      const scopeNote = accountIds === undefined ? '' : (zh ? `（${accountIds.length} 个账号）` : ` (${accountIds.length} account(s))`)
      setNote(
        zh
          ? `已导出 ${file.name}（${fmtBytes(file.bytes)}）${scopeNote}${warnings > 0 ? `；${warnings} 个账号的凭据没读到` : ''}`
          : `Saved ${file.name} (${fmtBytes(file.bytes)})${scopeNote}${warnings > 0 ? `; ${warnings} credential(s) unreadable` : ''}`,
        warnings > 0 ? 'warn' : 'good',
      )
      kick()
      return [{ refresh: 'manage' }, { toast: zh ? '已导出备份' : 'Backup saved' }]
    } catch (error) {
      // 3 秒超时在桥接那边表现为请求失败，插件这侧看不到具体 code；
      // 文案只承诺「没写成」，并把原因带上，避免用户以为账号丢了。
      const timedOut = /timeout/.test(String(error?.message ?? ''))
      setNote(
        timedOut
          ? (zh ? '导出超时：上游没有及时返回。稍后再试，账号池没有被改动。' : 'Export timed out; the pool was not modified. Try again later.')
          : (zh ? `导出失败：${briefError(error)}` : `Export failed: ${briefError(error)}`),
        'warn',
      )
      kick()
      return [{ refresh: 'manage' }, { toast: zh ? '导出失败' : 'Export failed' }]
    } finally {
      // 正常路径也走 unlock：清掉兜底计时器，别让它到时候再触发一次重画。
      unlock()
    }
  }

  const actions = {
    /** 点「导出备份」：只展开二选一，不直接导出（避免误点就写出一份全量文件）。 */
    'backup-export-menu': () => {
      exportMenu = !exportMenu
      if (!exportMenu) selectMode = false
      kick()
      return [{ refresh: 'manage' }]
    },
    'backup-export': (_scope, event) => {
      // 退出二选一：选完了，菜单该收起来。
      exportMenu = false
      return exportNow(event, undefined)
    },
    /** 导出选中的账号；一个都没选中时按「全部」处理，与按钮文案一致。 */
    'backup-export-selected': (_scope, event) => {
      exportMenu = false
      return exportNow(event, selected.size > 0 ? [...selected] : undefined)
    },
    /** 进入 / 退出选择模式。退出时清空选中，避免留下看不见的选择。 */
    'backup-select-mode': () => {
      selectMode = !selectMode
      if (selectMode) exportMenu = true
      if (!selectMode) {
        selected.clear()
        exportMenu = false
      }
      kick()
      return [{ refresh: 'manage' }]
    },
    /** 点一行切换选中。 */
    'backup-select-toggle': (_scope, event) => {
      const id = typeof event?.value?.account === 'string' ? event.value.account : ''
      if (id === '') return [{ refresh: 'manage' }]
      if (selected.has(id)) selected.delete(id)
      else selected.add(id)
      kick()
      return [{ refresh: 'manage' }]
    },
    /** 全选 / 全不选：已全选时再点一次就清空，免得还得一个个取消。 */
    'backup-select-all': () => {
      const all = cache.value?.accountList ?? []
      const ids = all.map((entry) => (typeof entry?.id === 'string' ? entry.id : '')).filter((x) => x !== '')
      if (ids.length > 0 && ids.every((id) => selected.has(id))) selected.clear()
      else for (const id of ids) selected.add(id)
      kick()
      return [{ refresh: 'manage' }]
    },
    /**
     * 点「从文件恢复」→ 直接返回 `pickFile` 效果，App 立刻弹系统文件选择器。
     *
     * ⚠️ 这个动作**必须同步**返回 picker：v1.3 里文件选择只允许出现在「用户亲手
     * 点按」的立即结果中，包在 `pending` 里会被桥接直接丢掉。回调 id 指向
     * `backup-picked`，选完由它接手。
     */
    'backup-pick': () => [{ type: 'pickFile', action: 'backup-picked', maxFiles: 1 }],
    /**
     * 文件选择器的回调：`event.value` 是 `{ status, files }`。
     *
     * 字节要在这里同步读完 —— `readPickedFile` 只在等待这个回调期间有效。
     * 解析出的对象复制到 `picked`，之后就与那份一次性快照无关了。
     */
    'backup-picked': (scope, event) => {
      const zh = zhOf(event?.locale)
      const value = event?.value
      const file = Array.isArray(value?.files) ? value.files[0] : undefined
      if (value?.status !== 'selected' || file === undefined) {
        clearPicked()
        kick()
        return [{ refresh: 'manage' }, { toast: value?.status === 'cancelled' ? (zh ? '已取消' : 'Cancelled') : (zh ? '没选中文件' : 'No file picked') }]
      }
      try {
        const bytes = ctx.dshGo.readPickedFile(file.handle)
        const payload = parseBackupBytes(bytes)
        picked = {
          at: Date.now(),
          // 文件名是展示信息，不是路径；只留一份短字符串。
          name: String(file.name ?? '').slice(0, 120),
          bytes: Number(file.bytes) || bytes.length,
          accounts: payload.accounts.length,
          payload,
        }
        pickedMode = 'merge'
        setNote(zh ? '已选好备份文件，点「确认恢复」才会动手。' : 'File checked; tap Restore to apply it.', 'info')
        kick()
        return [{ refresh: 'manage' }, { toast: zh ? '已选好文件' : 'File ready' }]
      } catch (error) {
        clearPicked()
        const reason = pickError(zh, error)
        setNote(reason, 'warn')
        kick()
        // 提示条只说一句；上限 40 字，超了桥接会截断。
        return [{ refresh: 'manage' }, { toast: reason }]
      }
    },
    /** 合并 ↔ 整体替换。切到 replace 时先亮确认框，避免一键就把池子换掉。 */
    /**
     * 恢复方式单选：`options` 组件的回传是 `{ value }`。
     *
     * ⚠️ 按值设置而不是翻转：翻转语义在「点了当前项」时会切到另一半，而单选
     * 点当前项本该是空操作。值不认识就保持原状，别把用户的确认意图改掉。
     */
    'backup-mode': (_scope, event) => {
      const zh = zhOf(event?.locale)
      if (!pickedFresh()) {
        clearPicked()
        kick()
        return [{ refresh: 'manage' }, { toast: zh ? '文件已过期，请重选' : 'Selection expired; pick again' }]
      }
      const value = event?.value?.value
      if (value === 'merge' || value === 'replace') pickedMode = value
      kick()
      return [{ refresh: 'manage' }]
    },
    'backup-restore-confirm': (_scope, event) => {
      const zh = zhOf(event?.locale)
      if (event?.value?.confirmed !== true) {
        // 取消 = 这次恢复作废：文件留着不给「确认」入口就会变成残局。
        clearPicked()
        kick()
        return [{ refresh: 'manage' }, { toast: zh ? '已取消' : 'Cancelled' }]
      }
      if (!pickedFresh()) {
        clearPicked()
        kick()
        return [{ refresh: 'manage' }, { toast: zh ? '文件已过期，请重选' : 'Selection expired; pick again' }]
      }
      if (busy !== '') {
        kick()
        return [{ refresh: 'manage' }, { toast: zh ? '上一个操作还没结束' : 'Still working' }]
      }
      // 先把要用的东西取出来，再清状态：导入期间视图不该还挂着确认框。
      const { payload, name } = picked
      const mode = pickedMode
      clearPicked()
      // 恢复在 pending 里跑，但**不按 45 秒的 RPC 上限设锁**：桥接断连会静默作废
      // 整个请求，用户那边根本等不到结果。留 20 秒让人能重试，比锁 55 秒强得多。
      // 真在写账号池时，导入本身通常几秒内结束；20 秒没回来，重试也是合理的。
      lock('restore', 20_000)
      return {
        // ⚠️ 上限是 60 秒（桥接的 `pendingMaxMs`）。之前这里写 120_000，被静默
        // 截成 60 秒 —— 看起来有更长时间，实际没有。导入本身通常几秒内完成。
        pending: { label: zh ? '正在恢复' : 'Restoring', timeoutMs: 60_000 },
        result: async () => {
          try {
            const value = await importBackup(ctx, payload, mode)
            // 账号集合变了：模型 / 账号缓存、渠道列表全部作废。
            invalidate()
            const imported = Number(value?.accountsImported) || 0
            const skipped = mode === 'merge' ? (Number(value?.accountsSkipped?.length ?? 0) || 0) : 0
            // ⚠️ 语气要跟着**结果**走，不能一律打绿标：合并导入完全没新增（全都
            // 已存在）时，写「已恢复」会让人以为账号被重写了。那种情况是中性的
            // 提醒 —— 什么都没变，本来就不需要做任何事。
            const noop = imported === 0 && skipped > 0
            const text = zh
              ? noop
                ? `导入 0 个：文件里的 ${skipped} 个账号都已存在，没有改动。要覆盖它们请改用「整体替换」。`
                : `已从 ${name} 恢复：导入 ${imported} 个账号${skipped > 0 ? `，跳过 ${skipped} 个已存在` : ''}`
              : noop
                ? `Imported 0: all ${skipped} account(s) already exist; nothing changed. Use Replace to overwrite them.`
                : `Restored from ${name}: ${imported} account(s) imported${skipped > 0 ? `, ${skipped} already existed` : ''}`
            setNote(text, noop ? 'info' : 'good')
            kick()
            return { toast: noop ? (zh ? '没有新增账号' : 'Nothing imported') : (zh ? '已恢复' : 'Restored') }
          } catch (error) {
            invalidate()
            // 超时是最常见的失败：说清「可能已经写进去了」，让用户先去账号列表核对，
            // 而不是立刻再点一次（replace 下重复导入是有代价的）。
            const timedOut = /timeout/.test(String(error?.message ?? ''))
            setNote(
              timedOut
                ? (zh
                  ? '恢复超时：上游没有及时返回，可能已经写入了一部分。先关掉面板再打开，看账号数对不对，别急着重复导入。'
                  : 'Restore timed out; part of it may have been written. Reopen the panel and check the account count before retrying.')
                : (zh ? `恢复失败：${briefError(error)}` : `Restore failed: ${briefError(error)}`),
              'warn',
            )
            kick()
            return { toast: zh ? '恢复失败' : 'Restore failed' }
          } finally {
            unlock()
          }
        },
      }
    },
    /**
     * 手动解除占用。
     *
     * ⚠️ 只解锁，**不**去中断上游（插件侧没有取消 RPC 的通道）。所以文案必须说清：
     * 上游可能仍在写账号池，别立刻重复导入，先看账号数。
     */
    'backup-busy-cancel': (_scope, event) => {
      const zh = zhOf(event?.locale)
      const was = busy
      unlock()
      kick()
      return [{
        refresh: 'manage',
        toast: was === 'restore'
          ? (zh ? '已解锁；先确认账号数再重试' : 'Unlocked; check the account count first')
          : (zh ? '已解锁' : 'Unlocked'),
      }]
    },
    'backup-refresh': (_scope, event) => {
      invalidate()
      // 走 setNote('') 而不是直接赋值：否则残留的定时器还会再触发一次。
      setNote('')
      kick()
      return [{ refresh: 'manage' }, { toast: zhOf(event?.locale) ? '正在刷新' : 'Refreshing' }]
    },
  }

  return {
    view,
    data,
    peek,
    actions,
    kick,
    kicks,
    invalidate,
  }
}
