// 账号池备份：把 Jet Hub 导出的快照写到用户能拿到的地方，再从那里读回来。
//
// ⚠️ 产物里有**登录凭据原文**，所以：
// - 写到手机内部存储时用 0600（只有本进程能读）；
// - 不进任何日志、提示文案、远端请求；
// - 文件名只由本模块生成，读回时只认这个前缀 + 允许的字符集，避免路径穿越。
//
// 目录选择：手机本机引擎能写 `/sdcard/Download/DSH-Go/`（用户直接能从文件管理器
// 看到）；远程主机没有这个挂载，就落在 `$DSH_HOME/dsh-go/backups/`。

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const BACKUP_PREFIX = 'jet-hub-backup-'
const FILE_RE = /^jet-hub-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{1,3})?\.json$/
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

/** 文件名是否由本模块生成（读回时的唯一白名单）。 */
export const isBackupFile = (name) => FILE_RE.test(String(name ?? ''))

/**
 * 列目录里已有的备份。
 *
 * 只认自己的前缀，按时间倒序；单条损坏（stat 失败）跳过而不是整体失败 ——
 * 用户手动往目录里放过别的东西很常见。
 */
export async function listBackups(limit = 20) {
  const dir = backupDir()
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!isBackupFile(name)) continue
    try {
      const info = await stat(join(dir, name))
      out.push({ name, at: info.mtimeMs, bytes: info.size })
    } catch {}
  }
  out.sort((a, b) => b.at - a.at)
  return out.slice(0, limit)
}

/** 写一份备份，返回文件路径与大小。权限 0600：这份文件里有凭据。 */
export async function writeBackup(payload, now = Date.now()) {
  const dir = backupDir()
  await mkdir(dir, { recursive: true })
  let name = backupFileName(now)
  // 同一秒点两次：加 -1 / -2 后缀，不覆盖上一份。
  let n = 1
  while (existsSync(join(dir, name))) {
    name = backupFileName(now).replace(/.json$/, `-${n}.json`)
    n += 1
    if (n > 20) break
  }
  const path = join(dir, name)
  const text = JSON.stringify(payload, null, 2)
  await writeFile(path, text, { mode: 0o600 })
  return { name, path, bytes: text.length }
}

/** 读回一份备份的原文。名字必须通过白名单，否则拒绝（防路径穿越）。 */
export async function readBackup(name) {
  if (!isBackupFile(name)) throw new Error('bad-backup-name')
  const text = await readFile(join(backupDir(), name), 'utf8')
  return JSON.parse(text)
}

/** 大小 → “12.3 KB”；面板一行放得下。 */
export function fmtBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`
  return `${Math.round(n / 104857.6) / 10} MB`
}
