// 智能路线生成：纯函数（无副作用、可单测、端云共用）。
// 思路：给定中心点与目标里程/风格，先生成候选目的地（POI 或环形采样点），
// 再对每条候选「去程+回程」合并成环线，最后按距离匹配/POI 丰富度/新颖度/爬升打分排序。

import type { Coordinate, Route } from './types'

// 骑行风格：影响候选 POI 类型与打分权重
export type RideStyle = 'leisure' | 'scenic' | 'food' | 'explore'

// 在 center 周围以 radiusM 为半径均匀取 count 个候选点（交错偏移增加多样性）
export function ringPoints(center: Coordinate, radiusM: number, count: number): Coordinate[] {
  const pts: Coordinate[] = []
  const dLat = radiusM / 111320
  const dLng = radiusM / (111320 * Math.cos((center.lat * Math.PI) / 180))
  for (let i = 0; i < count; i++) {
    const ang = (2 * Math.PI * i) / count + (i % 2) * 0.35
    pts.push({
      lng: center.lng + dLng * Math.cos(ang),
      lat: center.lat + dLat * Math.sin(ang),
      crs: 'WGS84',
    })
  }
  return pts
}

// 沿折线等距采样 n 个点（取最近索引）
export function sampleAlong(geometry: Coordinate[], n: number): Coordinate[] {
  if (geometry.length <= n) return [...geometry]
  const step = (geometry.length - 1) / (n - 1)
  const out: Coordinate[] = []
  for (let i = 0; i < n; i++) out.push(geometry[Math.round(i * step)])
  return out
}

// 合并去程/回程为一条环线 Route（回程去掉首点避免重复）
export function mergeOutReturn(out: Route, back: Route): Route {
  return {
    id: `smart-${out.id}-${back.id}`,
    geometry: [...out.geometry, ...back.geometry.slice(1)],
    distanceM: out.distanceM + back.distanceM,
    durationS: out.durationS + back.durationS,
    elevationGainM: out.elevationGainM + back.elevationGainM,
    steps: [...out.steps, ...back.steps],
    provider: out.provider,
  }
}

// 原路返回路线：反转去程几何。用于「去程+回程」闭环，避免再打一次路由 API（省配额、防 QPS 限流）
export function reverseRoute(out: Route): Route {
  return {
    id: `rev-${out.id}`,
    geometry: [...out.geometry].reverse(),
    distanceM: out.distanceM,
    durationS: out.durationS,
    elevationGainM: out.elevationGainM,
    steps: [...out.steps].reverse(),
    provider: out.provider,
  }
}

// 直线距离（米）—— 用于候选筛选与新颖度计算
export function distM(a: Coordinate, b: Coordinate): number {
  const dx = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)
  const dy = (a.lat - b.lat) * 111320
  return Math.sqrt(dx * dx + dy * dy)
}

// 点到点集最近距离（米）
export function distToNearest(p: Coordinate, pts: Coordinate[]): number {
  let m = Infinity
  for (const q of pts) {
    const d = distM(p, q)
    if (d < m) m = d
  }
  return m === Infinity ? 0 : m
}

// 从候选 POI 列表中挑出靠近某条路线几何的点（沿途停靠点）
export function pickPoisNearRoute(
  geometry: Coordinate[],
  pois: { id: string; name: string; coord: Coordinate; category: string; tags: Record<string, string> }[],
  maxM: number,
): typeof pois {
  const samples = sampleAlong(geometry, Math.min(12, geometry.length))
  const seen = new Set<string>()
  const out: typeof pois = []
  for (const s of samples) {
    for (const p of pois) {
      if (seen.has(p.id)) continue
      if (distM(s, p.coord) <= maxM) {
        seen.add(p.id)
        out.push(p)
        if (out.length >= 6) return out
      }
    }
  }
  return out
}

// 候选打分（纯函数）。返回 0..~1.3，越大越优。
export function scoreCandidate(opts: {
  distanceM: number
  targetM: number
  poiCount: number
  style: RideStyle
  novelty: number // 0..1，越大越偏离历史常骑区域（仅 explore 使用）
  elevationGainM: number
}): number {
  const { distanceM, targetM, poiCount, style, novelty, elevationGainM } = opts
  const distMatch = 1 - Math.min(1, Math.abs(distanceM - targetM) / targetM)
  let score = 0.5 * distMatch
  // POI 丰富度（按风格加权）：美食/景观最看重沿途配套
  const poiWeight = style === 'food' ? 0.4 : style === 'scenic' ? 0.35 : style === 'leisure' ? 0.2 : 0.15
  score += poiWeight * Math.min(1, poiCount / 6)
  // 探索风格：奖励新颖（远离历史轨迹）
  if (style === 'explore') score += 0.4 * Math.max(0, Math.min(1, novelty))
  // 爬升惩罚：休闲不喜欢大爬升；其余轻微惩罚极端值
  const gainPerKm = elevationGainM / Math.max(1, distanceM / 1000)
  if (style === 'leisure') score -= 0.3 * Math.min(1, gainPerKm / 30)
  else score -= 0.1 * Math.max(0, gainPerKm / 60 - 1)
  return score
}
