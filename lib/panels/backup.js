// 备份与恢复：导出账号池快照、从已有文件恢复。
//
// 两个方向都经由 Jet Hub：导出是 `backup.export`（宿主读凭据拼快照），
// 导入是 `backup.import`（宿主校验格式并落盘）。插件只负责**文件**这一半：
// 写到用户能看见的目录、读回来、把结果说清楚。
//
// ⚠️ 导入是**破坏性**的（`replace` 会整份替换账号池与模型黑名单），
// 所以永远走「先亮确认 → 再动手」，且默认只提供 `merge`。

import {
  exportBackup,
  importBackup,
  readBackupStatus,
} from '../jet-hub.js'
import { fmtBytes, isBackupFile, isPhoneDir, listBackups, readBackup, writeBackup, backupDir } from '../backup.js'
import { labelOf } from '../labels.js'
import { briefError, zhOf } from '../util.js'

/** 目录列表缓存：读写之后主动失效。 */
const STATE_CACHE_MS = 15_000

export function createBackupSection(ctx) {
  /** `{ at, accounts, withoutExpiry, files }` */
  let cache = { at: 0, value: undefined }
  let note = ''
  let noteTone = 'info'
  /** 恢复的二次确认：亮着时 confirm 组件才渲染。 */
  let restoreArm = { name: '', mode: 'merge' }
  /** 视图是同步的：文件行数决定要不要渲染那个列表（空 list 会画成「暂无数据」）。 */
  let fileCount = 0
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
    const [status, files] = await Promise.all([
      readBackupStatus(ctx).catch(() => undefined),
      listBackups(),
    ])
    const value = {
      accounts: Number(status?.accounts) || 0,
      withoutExpiry: Number(status?.withoutExpiry) || 0,
      accountList: Array.isArray(status?.accountList) ? status.accountList : [],
      files,
    }
    cache = { at: Date.now(), value }
    return value
  }

  /** 文件名 → 一行。`name` 直接进 args（读回时还会再校验一次白名单）。 */
  const fileRows = (files, zh) => (Array.isArray(files) ? files : []).map((file) => ({
    title: file.name.replace(/^jet-hub-backup-/, '').replace(/\.json$/, ''),
    subtitle: `${fmtBytes(file.bytes)}`,
    trailing: zh ? '恢复' : 'Restore',
    icon: 'archive',
    action: { id: 'backup-restore-ask', args: { name: file.name } },
  }))

  const view = (zh) => {
    const children = [
      { type: 'text', text: { $: 'data.backupHeadline' }, tone: 'muted' },
      { type: 'callout', text: { $: 'data.backupNote' }, tone: { $: 'data.backupNoteTone' } },
      { type: 'actions', items: [{ label: { $: 'data.backupExportLabel' }, action: 'backup-export', icon: 'download', style: 'primary' }] },
      { type: 'text', text: { $: 'data.backupFilesHeadline' }, tone: 'muted' },
      // 空 list 会画成「暂无数据」框；没文件时标题已经说了「还没有备份文件」。
      ...(fileCount > 0 ? [{ type: 'list', items: { $: 'data.backupFiles' } }] : []),
    ]
    if (restoreArm.name !== '') {
      children.push({
        type: 'callout',
        text: zh
          ? `${restoreArm.mode === 'merge' ? '合并' : '整体替换'}恢复：${restoreArm.mode === 'merge' ? '只追加新账号，已有的不动。' : '会覆盖现有账号、模型黑名单和永久锁定表，无法撤销。'}`
          : `${restoreArm.mode === 'merge' ? 'Merge' : 'Replace'}: ${restoreArm.mode === 'merge' ? 'only adds new accounts.' : 'overwrites the pool. Cannot be undone.'}`,
        tone: restoreArm.mode === 'merge' ? 'info' : 'warn',
      })
      children.push({ type: 'confirm', id: 'backup-restore-confirm', confirmLabel: zh ? '确认恢复' : 'Restore', cancelLabel: zh ? '取消' : 'Cancel' })
    }
    return children
  }

  const data = async (emit, zh, force, base) => {
    let state
    try {
      state = await readState(force)
    } catch (error) {
      emit({
        ...base,
        backupHeadline: zh ? '备份与恢复' : 'Backup & restore',
        backupNote: zh ? `读不到备份状态：${briefError(error)}` : `Cannot read backup state: ${briefError(error)}`,
        backupNoteTone: 'warn',
        backupExportLabel: zh ? '导出备份' : 'Export',
        backupFilesHeadline: zh ? '已有备份' : 'Saved files',
        backupFiles: [],
      })
      return
    }
    const files = fileRows(state.files, zh)
    fileCount = files.length
    const where = isPhoneDir()
      ? (zh ? 'Download/DSH-Go/' : 'Download/DSH-Go/')
      : backupDir()
    emit({
      ...base,
      backupHeadline: zh
        ? `账号池 ${state.accounts} 个${state.withoutExpiry > 0 ? `（${state.withoutExpiry} 个没记到期时间）` : ''}`
        : `${state.accounts} account(s)${state.withoutExpiry > 0 ? ` (${state.withoutExpiry} without expiry)` : ''}`,
      backupNote: note !== '' ? note : (zh
        ? `导出到 ${where}；文件里有登录凭据，别分享出去。`
        : `Saved to ${where}; the file contains credentials, do not share it.`),
      backupNoteTone: note !== '' ? noteTone : 'info',
      backupExportLabel: zh ? '导出备份' : 'Export',
      backupFilesHeadline: files.length === 0
        ? (zh ? '还没有备份文件' : 'No backup file yet')
        : (zh ? '已有备份（点一行恢复）' : 'Saved files (tap to restore)'),
      backupFiles: files,
      // 账号列表只用于导出时给一句读数，不参与交互。
      backupAccountCount: state.accounts,
    })
  }

  const peek = (zh) => {
    if (cache.value === undefined) return undefined
    const files = fileRows(cache.value.files, zh)
    fileCount = files.length
    return {
      backupHeadline: zh
        ? `账号池 ${cache.value.accounts} 个${cache.value.withoutExpiry > 0 ? `（${cache.value.withoutExpiry} 个没记到期时间）` : ''}`
        : `${cache.value.accounts} account(s)`,
      backupNote: note !== '' ? note : (zh ? '导出的文件里有登录凭据，别分享出去。' : 'The file contains credentials; do not share it.'),
      backupNoteTone: note !== '' ? noteTone : 'info',
      backupExportLabel: zh ? '导出备份' : 'Export',
      backupFilesHeadline: files.length === 0
        ? (zh ? '还没有备份文件' : 'No backup file yet')
        : (zh ? '已有备份（点一行恢复）' : 'Saved files (tap to restore)'),
      backupFiles: files,
      backupAccountCount: cache.value.accounts,
    }
  }

  const actions = {
    'backup-export': (_scope, event) => {
      const zh = zhOf(event?.locale)
      return {
        pending: { label: zh ? '正在导出' : 'Exporting', timeoutMs: 60_000 },
        result: async () => {
          try {
            const value = await exportBackup(ctx, undefined)
            const payload = value?.payload
            if (payload === undefined) throw new Error('empty-backup')
            const file = await writeBackup(payload)
            const warnings = Array.isArray(value?.warnings) ? value.warnings.length : 0
            invalidate()
            setNote(
              zh
                ? `已导出 ${file.name}（${fmtBytes(file.bytes)}）${warnings > 0 ? `；${warnings} 个账号的凭据没读到` : ''}`
                : `Saved ${file.name} (${fmtBytes(file.bytes)})${warnings > 0 ? `; ${warnings} credential(s) unreadable` : ''}`,
              warnings > 0 ? 'warn' : 'good',
            )
            kick()
            return { toast: zh ? '已导出备份' : 'Backup saved' }
          } catch (error) {
            invalidate()
            setNote(zh ? `导出失败：${briefError(error)}` : `Export failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '导出失败' : 'Export failed' }
          }
        },
      }
    },
    /**
     * 点一行 → 亮确认。**必须同步返回 refresh**：
     * 确认框是视图渲染的，包在 pending 里的话 refresh 会被丢掉，点了没反应。
     */
    'backup-restore-ask': (_scope, event) => {
      const zh = zhOf(event?.locale)
      const name = typeof event?.value?.name === 'string' ? event.value.name : ''
      if (!isBackupFile(name)) return [{ toast: zh ? '没认出这个备份文件' : 'Unknown backup file' }]
      restoreArm = { name, mode: 'merge' }
      kick()
      return [{ refresh: 'manage' }, { toast: zh ? '请确认后再恢复' : 'Confirm to restore' }]
    },
    /** 切成「整体替换」：更重，单独一个动作，避免误点。 */
    'backup-restore-replace': (_scope, event) => {
      const zh = zhOf(event?.locale)
      if (restoreArm.name === '') return [{ toast: zh ? '先点一个备份文件' : 'Pick a file first' }]
      restoreArm = { ...restoreArm, mode: 'replace' }
      kick()
      return [{ refresh: 'manage' }, { toast: zh ? '将整体替换，请确认' : 'Replace mode; confirm' }]
    },
    'backup-restore-confirm': (_scope, event) => {
      const zh = zhOf(event?.locale)
      const armed = restoreArm
      restoreArm = { name: '', mode: 'merge' }
      if (event?.value?.confirmed !== true || armed.name === '') {
        kick()
        return [{ refresh: 'manage' }, { toast: zh ? '已取消' : 'Cancelled' }]
      }
      return {
        pending: { label: zh ? '正在恢复' : 'Restoring', timeoutMs: 120_000 },
        result: async () => {
          try {
            const payload = await readBackup(armed.name)
            const value = await importBackup(ctx, payload, armed.mode)
            // 账号集合变了：模型 / 账号缓存、渠道列表全部作废。
            restoreArm = { name: '', mode: 'merge' }
            invalidate()
            setNote(
              zh
                ? `已恢复：导入 ${Number(value?.accountsImported) || 0} 个账号${armed.mode === 'merge' ? `，跳过 ${Number(value?.accountsSkipped?.length ?? 0) || 0} 个已存在` : ''}`
                : `Restored: ${Number(value?.accountsImported) || 0} account(s) imported`,
              'good',
            )
            kick()
            return { toast: zh ? '已恢复' : 'Restored' }
          } catch (error) {
            restoreArm = { name: '', mode: 'merge' }
            invalidate()
            setNote(zh ? `恢复失败：${briefError(error)}` : `Restore failed: ${briefError(error)}`, 'warn')
            kick()
            return { toast: zh ? '恢复失败' : 'Restore failed' }
          }
        },
      }
    },
    'backup-refresh': (_scope, event) => {
      invalidate()
      note = ''
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
    /** 有没有亮着恢复确认（manage 的视图分支要用它，但只用它的 view 就够了）。 */
    arms: () => restoreArm,
  }
}

/** 有一份备份可以被恢复？给 manage 的「备份」入口显示徽标用。 */
export async function hasBackup() {
  const files = await listBackups(1)
  return files.length > 0
}
