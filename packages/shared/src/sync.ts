// 云同步的合并算法（纯函数、零依赖）。
//
// 为什么放在 shared：前端 push 前要先本地合并，服务端收到 push 后也要再合并一次，
// 两侧必须使用**完全相同**的策略，否则会出现「A 设备看到 5 条、B 设备看到 4 条」的漂移。
// 把算法收敛到这里，两端都 import 同一份实现。
//
// 合并策略：
//   1) 轨迹（tracks）—— 集合并集 + 墓碑过滤。
//      轨迹是「只增不改」的记录，天然适合并集：两台设备各自新增的都要保留。
//      用 savedAt（毫秒时间戳）作为唯一 id 去重。
//   2) 删除（deletedTracks）—— 墓碑（tombstone）。
//      若只做并集，本地删除的条目会被云端「回灌」复活。故删除动作单独记为墓碑列表，
//      合并时统一过滤，保证删除能跨设备生效。
//   3) 行程（trip）—— Last-Write-Wins。
//      行程是「单文档、会被反复编辑」的对象，无法逐字段合并，按 updatedAt 取最新一版。

/** 可参与并集去重的记录：以 savedAt 毫秒时间戳作为唯一 id */
export interface Identified {
  savedAt: number
}

/** 行程文档：单文档 LWW，updatedAt 决定胜负 */
export interface TripDoc {
  title: string
  waypoints: unknown[]
  updatedAt: number
}

/** 一次同步传输的完整载荷 */
export interface SyncPayload<T extends Identified = Identified> {
  tracks: T[]
  deletedTracks: number[]
  trip: TripDoc | null
  updatedAt: number
}

/** 档案库上限，与前端 localStorage 侧保持一致，避免同步后又被本地截断造成反复 */
export const TRACK_LIMIT = 50
/** 墓碑保留上限：只保留最近的删除记录，防止无限增长 */
export const TOMBSTONE_LIMIT = 500

/**
 * 轨迹并集合并：去重（savedAt）→ 过滤墓碑 → 按时间倒序 → 截断上限。
 * 同一 savedAt 出现在两侧时保留 a 侧（调用方把「更可信的一侧」放前面）。
 */
export function mergeTracks<T extends Identified>(
  a: T[],
  b: T[],
  deleted: number[] = [],
  limit = TRACK_LIMIT,
): T[] {
  const tomb = new Set(deleted)
  const byId = new Map<number, T>()
  for (const t of [...a, ...b]) {
    if (!t || typeof t.savedAt !== 'number') continue
    if (tomb.has(t.savedAt)) continue // 已删除：不复活
    if (!byId.has(t.savedAt)) byId.set(t.savedAt, t)
  }
  return [...byId.values()].sort((x, y) => y.savedAt - x.savedAt).slice(0, limit)
}

/** 墓碑合并：去重 + 倒序 + 截断（只保留最近的删除记录） */
export function mergeTombstones(a: number[] = [], b: number[] = [], limit = TOMBSTONE_LIMIT): number[] {
  const s = new Set<number>()
  for (const x of [...a, ...b]) if (typeof x === 'number') s.add(x)
  return [...s].sort((x, y) => y - x).slice(0, limit)
}

/** 行程 LWW：取 updatedAt 更大的一方；一方为空则取另一方 */
export function pickNewerTrip(a: TripDoc | null, b: TripDoc | null): TripDoc | null {
  if (!a) return b ?? null
  if (!b) return a
  return (b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a
}

/**
 * 合并两份完整载荷。local 优先（同 id 冲突时保留 local 版本），
 * 返回的 updatedAt 取两侧最大值，供下次增量判断。
 */
export function mergeSync<T extends Identified>(
  local: SyncPayload<T>,
  remote: SyncPayload<T>,
): SyncPayload<T> {
  const deletedTracks = mergeTombstones(local.deletedTracks, remote.deletedTracks)
  return {
    tracks: mergeTracks(local.tracks, remote.tracks, deletedTracks),
    deletedTracks,
    trip: pickNewerTrip(local.trip, remote.trip),
    updatedAt: Math.max(local.updatedAt ?? 0, remote.updatedAt ?? 0, Date.now()),
  }
}

/** 空载荷（首次同步 / 未登录时的兜底） */
export function emptyPayload<T extends Identified>(): SyncPayload<T> {
  return { tracks: [], deletedTracks: [], trip: null, updatedAt: 0 }
}
