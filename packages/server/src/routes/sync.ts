import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SyncPayload } from '@bike-travel/shared'
import { emptyPayload, mergeSync } from '@bike-travel/shared'
import {
  getPayload,
  loginUser,
  registerUser,
  revokeToken,
  setPayload,
  userByToken,
  type PublicUser,
} from '../store/db'

// 账户 + 云同步路由
//
//   POST /api/auth/register  { name, password }        -> { token, user }
//   POST /api/auth/login     { name, password }        -> { token, user }
//   POST /api/auth/logout    (Bearer)                  -> { ok }
//   GET  /api/auth/me        (Bearer)                  -> { user }
//   GET  /api/sync           (Bearer)                  -> SyncPayload（拉取云端全量）
//   POST /api/sync           (Bearer) SyncPayload      -> SyncPayload（服务端合并后回传权威版本）
//
// 同步语义：客户端 push 的是「本地全量」，服务端用与前端**同一份** mergeSync 再合并一次，
// 把结果作为权威版本回传。这样即使两台设备并发推送，最终也会收敛到同一集合
// （轨迹并集 + 墓碑过滤 + 行程 LWW），不会互相覆盖。

function bearer(req: FastifyRequest): string | undefined {
  const h = req.headers.authorization
  if (!h || !h.startsWith('Bearer ')) return undefined
  return h.slice(7).trim()
}

// 鉴权网关：解析不到用户就 401，业务处理器只需关心已登录场景
function auth(req: FastifyRequest, reply: FastifyReply): PublicUser | null {
  const user = userByToken(bearer(req))
  if (!user) {
    void reply.code(401).send({ error: '未登录或登录已失效' })
    return null
  }
  return user
}

// 入参消毒：客户端可能传来任意结构（旧版本 / 手工构造），统一归一化，
// 防止把脏数据写进存储导致后续合并崩溃。
function sanitize(input: unknown): SyncPayload {
  const p = (input ?? {}) as Partial<SyncPayload>
  return {
    tracks: Array.isArray(p.tracks) ? p.tracks.filter((t) => t && typeof t.savedAt === 'number') : [],
    deletedTracks: Array.isArray(p.deletedTracks)
      ? p.deletedTracks.filter((x) => typeof x === 'number')
      : [],
    trip: p.trip && typeof p.trip === 'object' ? p.trip : null,
    updatedAt: typeof p.updatedAt === 'number' ? p.updatedAt : 0,
  }
}

export function registerSyncRoutes(app: FastifyInstance): void {
  app.post('/api/auth/register', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; password?: string }
    const r = registerUser(String(b.name ?? ''), String(b.password ?? ''))
    if (!r.ok) return reply.code(400).send({ error: r.error })
    return { token: r.token, user: r.user }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; password?: string }
    const r = loginUser(String(b.name ?? ''), String(b.password ?? ''))
    if (!r.ok) return reply.code(401).send({ error: r.error })
    return { token: r.token, user: r.user }
  })

  app.post('/api/auth/logout', async (req) => {
    revokeToken(bearer(req))
    return { ok: true }
  })

  app.get('/api/auth/me', async (req, reply) => {
    const user = auth(req, reply)
    if (!user) return
    return { user }
  })

  app.get('/api/sync', async (req, reply) => {
    const user = auth(req, reply)
    if (!user) return
    return getPayload(user.id) ?? emptyPayload()
  })

  app.post('/api/sync', async (req, reply) => {
    const user = auth(req, reply)
    if (!user) return
    const incoming = sanitize(req.body)
    const stored = getPayload(user.id)
    // local=incoming 优先：同一 savedAt 冲突时以客户端提交的版本为准（含重命名等改动）
    const merged = mergeSync(incoming, stored)
    setPayload(user.id, merged)
    return merged
  })
}
