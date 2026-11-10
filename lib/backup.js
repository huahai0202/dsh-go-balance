// 账号池备份：把 Jet Hub 导出的快照写到用户能拿到的地方，校验用户选中的文件。
//
// ⚠️ 产物里有**登录凭据原文**，所以：
// - 写到手机内部存储时用 0600（只有本进程能读）；
// - 不进任何日志、提示文案、远端请求。
//
// 两个方向的分工：
// - 导出：本模块决定目录与文件名（`backupDir()` / `backupFileName()`）。
// - 导入：不再按目录 + 文件名猜，而是走 App 的文件选择器（v1.3 `files`），
//   拿到的是用户亲手选中的那份字节；校验只看内容（格式 + 版本 + 关键字段），
//   不看文件名 —— 换机、改名、从聊天软件里另存出来的备份都能用。
//
// 目录选择：手机本机引擎能写 `/sdcard/Download/DSH-Go/`（用户直接能从文件管理器
// 看到）；远程主机没有这个挂载，就落在 `$DSH_HOME/dsh-go/backups/`。

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BACKUP_PREFIX = 'jet-hub-backup-'
/** 导出侧的文件名形状（不含冒号：手机文件管理器不认）。导入不看文件名。 */
const FILE_RE = /^jet-hub-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,3})?\.json$/
/** Jet Hub 的备份格式标识与版本；导入前按这两项严格校验。 */
export const BACKUP_FORMAT = 'dsh-codearts-auth/backup'
export const BACKUP_VERSION = 1
/** 手机存储挂载点；不存在就回落到 DSH home。 */
const PHONE_ROOT = '/sdcard/Download'

/**
 * 备份目录。
 *
 * 优先 `DSH_GO_BACKUP_DIR`（测试与自定义位置用），其次手机存储，最后 DSH home。
 * ⚠️ 判据**必须**先看覆盖：手机上 `/sdcard` 恒存在，只看它会让测试也写进用户
 * 的 Download 里（实测踩过一次）。
 */
export function backupDir() {
  const override = process.env.DSH_GO_BACKUP_DIR
  if (typeof override === 'string' && override !== '') return override
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  if (existsSync(PHONE_ROOT)) return join(PHONE_ROOT, 'DSH-Go')
  return join(home, 'dsh-go', 'backups')
}

/** 目录是不是「用户可见的那个手机目录」——视图里据此写一句提示。 */
export function isPhoneDir() {
  const override = process.env.DSH_GO_BACKUP_DIR
  if (typeof override === 'string' && override !== '') return false
  return existsSync(PHONE_ROOT)
}

/** `YYYY-MM-DDTHH-MM-SS` 形式的文件名（不带冒号：手机文件管理器不认）。 */
export function backupFileName(now = Date.now()) {
  const d = new Date(now)
  const p = (value) => String(value).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  const time = `${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  return `${BACKUP_PREFIX}${date}T${time}.json`
}

/** 文件名是否由本模块生成。导出侧用它给新文件起名，与导入校验**无关**。 */
export const isBackupFile = (name) => FILE_RE.test(String(name ?? ''))

/**
 * 把文件选择器交回来的字节解析成备份载荷。
 *
 * 只认内容，不认文件名：用户从聊天软件另存、改过名、换过机的备份都该能用。
 * 校验与 Jet Hub 的 `assertBackupPayload` 对齐（格式、版本、导出时间、凭据表、
 * 账号数组），提前在这里拦掉，用户看到的是「这个文件不是备份」，而不是导入到
 * 一半才被上游拒绝。
 *
 * ⚠️ `bytes` 是 Uint8Array / Buffer，来自桥接的一次性快照；不能存起来复用。
 */
export function parseBackupBytes(bytes) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('not-utf8')
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('not-json')
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('not-object')
  if (payload.format !== BACKUP_FORMAT) throw new Error('wrong-format')
  if (payload.version !== BACKUP_VERSION) throw new Error('wrong-version')
  if (typeof payload.exportedAt !== 'string') throw new Error('no-exported-at')
  if (typeof payload.credentials !== 'object' || payload.credentials === null || Array.isArray(payload.credentials)) throw new Error('bad-credentials')
  if (!Array.isArray(payload.accounts)) throw new Error('bad-accounts')
  return payload
}

/** 已经确认存在的目录；`/sdcard` 上一次 mkdir 要 1~2ms，导出常连着点。 */
const readyDirs = new Set()
/** 本进程写过的文件名 → 时间戳。同一秒连点靠它跳号，不靠 EEXIST 抛异常探测。 */
const written = new Map()
/** 已写记录留一份就够：同秒连点只看最近这一批。 */
const WRITTEN_KEEP = 200

/**
 * 写一份备份，返回文件路径与大小。权限 0600：这份文件里有凭据。
 *
 * 三个地方是特意为速度写的：
 * - 目录只建一次（`readyDirs`），被外部删掉时靠 ENOENT 兜一次重试；
 * - 用 `wx`（独占创建）代替「先 existsSync 再写」：省掉一次 stat，顺带消掉
 *   「查完到写之间被别人建了同名文件」的窗口；
 * - 同一秒连点的跳号先查内存（`written`），**不靠写失败抛 EEXIST 来探测**：
 *   异常一次几毫秒，连点十几次会滚成几十毫秒。`wx` 仍是最终保险 ——
 *   别的进程或上一次运行留下的同名文件由它兜住。
 */
export async function writeBackup(payload, now = Date.now()) {
  const dir = backupDir()
  // 序列化在写之前一次做完：失败时不用重算。
  const text = JSON.stringify(payload, null, 2)
  const base = backupFileName(now)
  const take = () => {
    // 同秒连点：从内存里找第一个没被本进程占用的后缀。
    for (let n = 0; n <= 20; n += 1) {
      const name = n === 0 ? base : base.replace(/.json$/, `-${n}.json`)
      const path = join(dir, name)
      if (!written.has(path)) return { name, path }
    }
    return undefined
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!readyDirs.has(dir)) {
      await mkdir(dir, { recursive: true })
      readyDirs.add(dir)
    }
    const slot = take()
    if (slot === undefined) throw new Error('too-many-backups')
    try {
      await writeFile(slot.path, text, { mode: 0o600, flag: 'wx' })
      written.set(slot.path, now)
      if (written.size > WRITTEN_KEEP) {
        for (const key of written.keys()) {
          written.delete(key)
          if (written.size <= WRITTEN_KEEP / 2) break
        }
      }
      return { ...slot, bytes: Buffer.byteLength(text) }
    } catch (error) {
      // 目录被删了（用户清理过 Download）：补建再试一次，别直接失败。
      if (error?.code === 'ENOENT' && readyDirs.has(dir)) {
        readyDirs.delete(dir)
        continue
      }
      // 被本进程之外的来源占了名（上一次运行的残留）：记下来，下次跳号。
      if (error?.code === 'EEXIST') {
        written.set(slot.path, now)
        continue
      }
      throw error
    }
  }
  throw new Error('too-many-backups')
}

/** 大小 → “12.3 KB”；面板一行放得下。 */
export function fmtBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`
  return `${Math.round(n / 104857.6) / 10} MB`
}
