// 实时导航纯算法：把 GPS 点投影到路线上，计算进度 / 偏航 / 下一步转向。
// 全部是纯函数，不依赖浏览器，便于单元测试与在 MapView / App 间复用。
import type { Coordinate, Maneuver, Route } from '@bike-travel/shared'
import { parseManeuver } from '@bike-travel/shared'

// 平面近似两点距离（米）。中短距离足够精确。
export function distM(a: Coordinate, b: Coordinate): number {
  const dx = (a.lng - b.lng) * 111320 * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180))
  const dy = (a.lat - b.lat) * 111320
  return Math.sqrt(dx * dx + dy * dy)
}

// 点 p 到线段 p0-p1 的投影：返回最近点、参数 t、距离（米）
function projectSegment(p: Coordinate, p0: Coordinate, p1: Coordinate) {
  const latR = (p.lat * Math.PI) / 180
  const ax = (p1.lng - p0.lng) * 111320 * Math.cos(latR)
  const ay = (p1.lat - p0.lat) * 111320
  const bx = (p.lng - p0.lng) * 111320 * Math.cos(latR)
  const by = (p.lat - p0.lat) * 111320
  const len2 = ax * ax + ay * ay || 1e-12
  let t = (bx * ax + by * ay) / len2
  t = Math.max(0, Math.min(1, t))
  const lng = p0.lng + t * (p1.lng - p0.lng)
  const lat = p0.lat + t * (p1.lat - p0.lat)
  const proj: Coordinate = { lng, lat, crs: 'WGS84' }
  return { proj, t, dist: distM(p, proj) }
}

export interface RouteProjection {
  nearest: Coordinate // 路线上离 p 最近的点
  segIndex: number // 所在段（point i -> i+1）
  traveledM: number // 起点到投影点累计距离
  remainingM: number // 投影点到终点距离
  fraction: number // 0..1 行进比例
}

export function projectOnRoute(route: Route, p: Coordinate): RouteProjection {
  const g = route.geometry
  if (!g || g.length < 2) {
    return { nearest: { ...p }, segIndex: 0, traveledM: 0, remainingM: route.distanceM, fraction: 0 }
  }
  let best = Infinity
  let bestSeg = 0
  let bestProj: Coordinate = g[0]
  for (let i = 0; i < g.length - 1; i++) {
    const r = projectSegment(p, g[i], g[i + 1])
    if (r.dist < best) {
      best = r.dist
      bestSeg = i
      bestProj = r.proj
    }
  }
  let traveled = 0
  for (let i = 0; i < bestSeg; i++) traveled += distM(g[i], g[i + 1])
  traveled += distM(g[bestSeg], bestProj)
  // 剩余距离用「投影点 -> 终点」的几何累计，而非 route.distanceM - traveled：
  // 避免服务端 distanceM 与几何累计有偏差时，终点 remaining 不归零导致到达判定永不触发。
  let remainingM = 0
  if (bestSeg + 1 < g.length) {
    remainingM += distM(bestProj, g[bestSeg + 1])
    for (let i = bestSeg + 2; i < g.length; i++) remainingM += distM(g[i - 1], g[i])
  }
  const total = traveled + remainingM
  const fraction = total > 0 ? traveled / total : 0
  return { nearest: bestProj, segIndex: bestSeg, traveledM: traveled, remainingM, fraction }
}

// 每个 step 起点在整条路线中的累计距离（基于 step.geometry 拼接，与 route.geometry 一致）
function stepStartDistances(route: Route): number[] {
  const out: number[] = []
  let acc = 0
  for (const s of route.steps) {
    out.push(acc)
    const geo = s.geometry
    for (let i = 0; i < geo.length - 1; i++) acc += distM(geo[i], geo[i + 1])
  }
  return out
}

const ANNOUNCE = new Set<Maneuver>([
  'turn_left',
  'turn_right',
  'slight_left',
  'slight_right',
  'roundabout',
  'arrive',
])

export interface NavStepInfo {
  maneuver: Maneuver
  instruction: string
  distanceM: number
  index: number
}

export interface NavState {
  offRouteM: number // 偏离路线距离
  traveledM: number
  remainingM: number
  remainingS: number
  fraction: number
  nextManeuver?: NavStepInfo
}

// 计算当前导航状态：进度、剩余、下一步转向。
export function computeNavState(route: Route, p: Coordinate): NavState {
  const pr = projectOnRoute(route, p)
  const offRouteM = distM(p, pr.nearest)
  const starts = stepStartDistances(route)
  let next: NavStepInfo | undefined
  for (let i = 0; i < route.steps.length; i++) {
    const s = route.steps[i]
    if (!ANNOUNCE.has(s.maneuver)) continue
    const d = starts[i] - pr.traveledM
    if (d > 1) {
      next = { maneuver: s.maneuver, instruction: s.instruction, distanceM: d, index: i }
      break
    }
  }
  const remainingS = route.durationS * (1 - pr.fraction)
  return {
    offRouteM,
    traveledM: pr.traveledM,
    remainingM: pr.remainingM,
    remainingS,
    fraction: pr.fraction,
    nextManeuver: next,
  }
}

// 偏航判定：偏离路线超过阈值（默认 40m）即认为需要重算。
export function isOffRoute(route: Route, p: Coordinate, thresholdM = 40): boolean {
  return distM(p, projectOnRoute(route, p).nearest) > thresholdM
}

// 导航图标（emoji 箭头）
export const MANEUVER_ARROW: Record<Maneuver, string> = {
  depart: '🚩',
  arrive: '🏁',
  straight: '⬆️',
  turn_left: '⬅️',
  turn_right: '➡️',
  slight_left: '↖️',
  slight_right: '↗️',
  roundabout: '↻',
}

// 方位角（度，0=正北，顺时针）。用于导航箭头朝向。
export function bearing(a: Coordinate, b: Coordinate): number {
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// 把 instruction 文本解析成 maneuver（与 shared.parseManeuver 语义一致，供需要的地方复用）
export function maneuverOf(text: string): Maneuver {
  return parseManeuver(text)
}
