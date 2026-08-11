// 云同步前端封装：账户认证 + 全量拉取/推送 + 本地载荷读写。
//
// 设计取舍：采用「全量同步」而非增量。个人骑行数据量很小（轨迹上限 50 条），
// 全量传输实现简单且天然免疫增量丢失；合并算法复用 shared/sync，与服务端完全一致。

import type { SyncPayload, TripDoc } from '@bike-travel/shared'
import { emptyPayload } from '@bike-travel/shared'
import { KEYS, loadJSON, saveJSON, type AuthState, type SavedTrack, type SyncMeta } from '../storage'

export type CloudPayload = SyncPayload<SavedTrack>

export interface CloudUser {
  id: string
  name: string
  createdAt: number
}

// 统一请求：自动带 Bearer 头，并把服务端 { error } 转成中文 Error
async function req<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`
  let r: Response
  try {
    r = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as object) } })
  } catch {
    // 网络层失败（后端未启动 / 离线）：给出可操作的提示，而不是抛原始 TypeError
    throw new Error('无法连接服务器，请确认后端已启动')
  }
  const text = await r.text()
  const body = text ? (JSON.parse(text) as unknown) : {}
  if (!r.ok) {
    const msg = (body as { error?: string }).error ?? `请求失败（${r.status}）`
    throw new Error(msg)
  }
  return body as T
}

export async function register(name: string, password: string) {
  return req<{ token: string; user: CloudUser }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, password }),
  })
}

export async function login(name: string, password: string) {
  return req<{ token: string; user: CloudUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ name, password }),
  })
}

export async function logout(token: string): Promise<void> {
  try {
    // 必须带 body：请求头声明了 application/json，Fastify 对空 body 会直接 400，
    // 导致服务端 token 实际没被吊销（前端却以为已退出）——这是安全隐患，不能省。
    await req('/api/auth/logout', { method: 'POST', body: '{}' }, token)
  } catch {
    // 退出登录以本地清除为准，服务端吊销失败不阻塞用户
  }
}

export async function me(token: string) {
  return req<{ user: CloudUser }>('/api/auth/me', {}, token)
}

/** 拉取云端全量 */
export async function pull(token: string): Promise<CloudPayload> {
  return req<CloudPayload>('/api/sync', {}, token)
}

/** 推送本地全量，返回服务端合并后的权威版本 */
export async function push(token: string, payload: CloudPayload): Promise<CloudPayload> {
  return req<CloudPayload>('/api/sync', { method: 'POST', body: JSON.stringify(payload) }, token)
}

// —— 本地载荷读写（localStorage 侧） ——

/** 把散落在各 key 的本地数据组装成一份同步载荷 */
export function readLocalPayload(): CloudPayload {
  const tracks = loadJSON<SavedTrack[]>(KEYS.tracks, [])
  const deletedTracks = loadJSON<number[]>(KEYS.deletedTracks, [])
  const meta = loadJSON<SyncMeta>(KEYS.syncMeta, { lastSyncAt: 0, tripUpdatedAt: 0 })
  const rawTrip = loadJSON<{ title?: string; waypoints?: unknown[]; updatedAt?: number } | null>(
    KEYS.trips,
    null,
  )
  const trip: TripDoc | null =
    rawTrip && Array.isArray(rawTrip.waypoints)
      ? {
          title: rawTrip.title ?? '我的骑行旅游行程',
          waypoints: rawTrip.waypoints,
          updatedAt: rawTrip.updatedAt ?? meta.tripUpdatedAt ?? 0,
        }
      : null
  return { ...emptyPayload<SavedTrack>(), tracks, deletedTracks, trip, updatedAt: meta.lastSyncAt }
}

/** 把合并结果写回本地各 key（同步完成后调用） */
export function writeLocalPayload(p: CloudPayload): void {
  saveJSON(KEYS.tracks, p.tracks)
  saveJSON(KEYS.deletedTracks, p.deletedTracks)
  if (p.trip) saveJSON(KEYS.trips, p.trip)
  saveJSON(KEYS.syncMeta, {
    lastSyncAt: Date.now(),
    tripUpdatedAt: p.trip?.updatedAt ?? 0,
  } satisfies SyncMeta)
}

export function readAuth(): AuthState | null {
  return loadJSON<AuthState | null>(KEYS.auth, null)
}

export function writeAuth(a: AuthState | null): void {
  saveJSON(KEYS.auth, a)
}

export function readSyncMeta(): SyncMeta {
  return loadJSON<SyncMeta>(KEYS.syncMeta, { lastSyncAt: 0, tripUpdatedAt: 0 })
}
