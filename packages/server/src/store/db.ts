// 轻量账户 + 同步数据存储（零外部依赖，仅用 node 内置模块）。
//
// 为什么不引 SQLite/Postgres：本项目定位是「个人骑行工具」，云同步只需要
// 「按用户存一份 JSON」。引数据库会带来原生依赖与部署负担，而 JSON 文件
// 足以支撑单机/小规模自托管，且便于备份与人工检视。
//
// 落盘策略：内存持有全量，写入时 tmp 文件 + rename 原子替换，
// 避免进程在写一半时崩溃导致文件截断（rename 在同一文件系统上是原子的）。
//
// 密码安全：scrypt 加盐哈希（不可逆），校验用 timingSafeEqual 防时序侧信道。
// 明文密码从不落盘、不进日志。

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SyncPayload } from '@bike-travel/shared'
import { emptyPayload } from '@bike-travel/shared'
import { env } from '../env'

export interface UserRow {
  id: string
  name: string
  salt: string
  hash: string
  createdAt: number
}

export interface PublicUser {
  id: string
  name: string
  createdAt: number
}

interface DbShape {
  users: UserRow[]
  tokens: Record<string, string> // token -> userId
  data: Record<string, SyncPayload> // userId -> 同步载荷
}

// 数据目录：默认仓库根 data/，可用 DATA_DIR 覆盖（容器部署时挂卷）
const HERE = dirname(fileURLToPath(import.meta.url))
const DATA_DIR = env.DATA_DIR || resolve(HERE, '../../../../data')
const DB_FILE = resolve(DATA_DIR, 'cloud.json')

function emptyDb(): DbShape {
  return { users: [], tokens: {}, data: {} }
}

function load(): DbShape {
  try {
    if (!existsSync(DB_FILE)) return emptyDb()
    const raw = JSON.parse(readFileSync(DB_FILE, 'utf8')) as Partial<DbShape>
    return {
      users: Array.isArray(raw.users) ? raw.users : [],
      tokens: raw.tokens ?? {},
      data: raw.data ?? {},
    }
  } catch {
    // 文件损坏时不让服务起不来：退回空库（旧文件仍在磁盘上可人工恢复）
    return emptyDb()
  }
}

let db: DbShape = load()

function persist(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const tmp = DB_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(db), 'utf8')
    renameSync(tmp, DB_FILE) // 原子替换
  } catch (e) {
    console.error('[store] persist failed', e)
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function passwordMatches(password: string, row: UserRow): boolean {
  const got = Buffer.from(hashPassword(password, row.salt), 'hex')
  const want = Buffer.from(row.hash, 'hex')
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

function publicUser(u: UserRow): PublicUser {
  return { id: u.id, name: u.name, createdAt: u.createdAt }
}

function issueToken(userId: string): string {
  const token = randomBytes(32).toString('hex')
  db.tokens[token] = userId
  return token
}

/** 注册：用户名唯一（不区分大小写），返回 token + 公开用户信息 */
export function registerUser(
  name: string,
  password: string,
): { ok: true; token: string; user: PublicUser } | { ok: false; error: string } {
  const trimmed = name.trim()
  if (trimmed.length < 2) return { ok: false, error: '用户名至少 2 个字符' }
  if (password.length < 6) return { ok: false, error: '密码至少 6 位' }
  if (db.users.some((u) => u.name.toLowerCase() === trimmed.toLowerCase())) {
    return { ok: false, error: '用户名已被占用' }
  }
  const salt = randomBytes(16).toString('hex')
  const row: UserRow = {
    id: randomBytes(8).toString('hex'),
    name: trimmed,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
  }
  db.users.push(row)
  db.data[row.id] = emptyPayload()
  const token = issueToken(row.id)
  persist()
  return { ok: true, token, user: publicUser(row) }
}

/** 登录：用户名 + 密码，成功后签发新 token（旧 token 仍有效，支持多设备） */
export function loginUser(
  name: string,
  password: string,
): { ok: true; token: string; user: PublicUser } | { ok: false; error: string } {
  const row = db.users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase())
  // 用户不存在与密码错误返回同一文案，避免用户名枚举
  if (!row || !passwordMatches(password, row)) return { ok: false, error: '用户名或密码错误' }
  const token = issueToken(row.id)
  persist()
  return { ok: true, token, user: publicUser(row) }
}

/** 通过 Bearer token 解析用户 */
export function userByToken(token: string | undefined): PublicUser | null {
  if (!token) return null
  const uid = db.tokens[token]
  if (!uid) return null
  const row = db.users.find((u) => u.id === uid)
  return row ? publicUser(row) : null
}

/** 退出登录：吊销当前 token（其他设备不受影响） */
export function revokeToken(token: string | undefined): void {
  if (!token) return
  if (db.tokens[token]) {
    delete db.tokens[token]
    persist()
  }
}

export function getPayload(userId: string): SyncPayload {
  return db.data[userId] ?? emptyPayload()
}

export function setPayload(userId: string, payload: SyncPayload): void {
  db.data[userId] = payload
  persist()
}

/** 仅供测试：重置内存库（不删磁盘文件） */
export function __resetForTest(): void {
  db = emptyDb()
}
