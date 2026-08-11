// 浏览器端持久化：localStorage 封装（项目零依赖）。
// 仅用于 Web 端（浏览器环境），Server 端切勿引用。
// 用途：行程规划途经点、骑行轨迹档案库——刷新页面不丢失，无需引入后端数据库。

import type { Track } from '@bike-travel/shared'

const PREFIX = 'bike-travel:'

export const KEYS = {
  trips: 'trips', // 行程：SavedTrip { title, waypoints: Waypoint[] }（标题 + 按天途经点）
  tracks: 'tracks', // 骑行轨迹档案库：SavedTrack[]
  routesCache: 'routes-cache', // 离线路由缓存：Record<"from->to", Route>
  auth: 'auth', // 云端登录态：{ token, user }
  deletedTracks: 'deleted-tracks', // 删除墓碑：number[]（被删轨迹的 savedAt）
  syncMeta: 'sync-meta', // 同步元信息：{ lastSyncAt, tripUpdatedAt }
  groupRoom: 'group-room', // 结伴骑行：上次加入的房间号
} as const

// 云端登录态（token 存本地，退出登录即清除）
export interface AuthState {
  token: string
  user: { id: string; name: string; createdAt: number }
}

// 同步元信息：lastSyncAt 用于 UI 展示；tripUpdatedAt 参与行程 LWW 比较
export interface SyncMeta {
  lastSyncAt: number
  tripUpdatedAt: number
}

// 骑行档案库条目：在 Track 基础上附带可展示的名称与保存时间
export interface SavedTrack extends Track {
  name: string
  savedAt: number
}

export function loadJSON<T>(key: string, fallback: T): T {
  try {
    if (typeof localStorage === 'undefined') return fallback
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function saveJSON(key: string, value: unknown): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // 配额超限 / 隐私模式：静默失败，不影响主流程
  }
}
