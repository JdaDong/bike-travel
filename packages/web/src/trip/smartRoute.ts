// 智能路线推荐编排：把「纯函数打分」与「真实地图服务」接起来。
// 给定中心 + 目标里程 + 风格，返回按分数排序的若干条候选环线（含沿途停靠 POI）。
import type { Coordinate, POI, Route } from '@bike-travel/shared'
import {
  ringPoints,
  mergeOutReturn,
  reverseRoute,
  distToNearest,
  pickPoisNearRoute,
  scoreCandidate,
  type RideStyle,
} from '@bike-travel/shared'
import { getRouteSmart } from '../offline/routeCache'
import { searchPOI } from '../api'

export interface SmartRecommendation {
  route: Route
  pois: POI[] // 沿途推荐停靠点
  destName: string
  distanceM: number
  durationS: number
  elevationGainM: number
  score: number
}

export interface SmartOptions {
  center: Coordinate
  targetKm: number
  style: RideStyle
  heatPoints?: Coordinate[] // 历史骑行轨迹点（用于「探索」风格的新颖度打分）
}

// 风格 → 用于检索候选目的地的 POI 分类
const STYLE_CAT: Record<RideStyle, string> = {
  leisure: '公园',
  scenic: '景点',
  food: '美食',
  explore: '景点',
}

export async function recommendRoutes(opts: SmartOptions): Promise<SmartRecommendation[]> {
  const { center, targetKm, style, heatPoints = [] } = opts
  const targetM = targetKm * 1000
  // 环线半径 ≈ 目标里程的一半（含绕路系数 1.3）
  const ringR = targetM / 2 / 1.3
  const searchR = Math.min(8000, Math.max(2000, ringR * 1.6))

  // 1) 候选目的地：优先风格 POI，不足用环形采样点补充
  let allPois: POI[] = []
  try {
    allPois = await searchPOI(STYLE_CAT[style], center, searchR)
  } catch {
    allPois = []
  }
  const dests: { coord: Coordinate; name: string; isPoi: boolean }[] = allPois
    .slice(0, 10)
    .map((p) => ({ coord: p.coord, name: p.name, isPoi: true }))
  if (dests.length < 4) {
    const ring = ringPoints(center, ringR, 6).map((c, i) => ({
      coord: c,
      name: `环线点${i + 1}`,
      isPoi: false,
    }))
    dests.push(...ring)
  }
  const candidates = dests.slice(0, 4)

  // 2) 逐候选：去程 +（反转去程作回程）→ 合并环线 → 沿途挑 POI → 打分
  // 注：回程用 reverseRoute 合成，避免再打一次高德路由 API（省配额、防 QPS 限流）。
  const recs: SmartRecommendation[] = []
  for (const d of candidates) {
    try {
      const out = await getRouteSmart(center, d.coord)
      if (out.distanceM < targetM * 0.4) continue // 太短（多半是直线兜底失败）跳过
      const route = mergeOutReturn(out, reverseRoute(out))

      const nearPois = pickPoisNearRoute(route.geometry, allPois, 600)
      const poiCount = nearPois.length + (d.isPoi ? 1 : 0)
      // 新颖度：路线中点到历史轨迹点的最近距离，越远越新颖（0..1）
      const mid = route.geometry[Math.floor(route.geometry.length / 2)]
      const novelty = heatPoints.length ? Math.min(1, distToNearest(mid, heatPoints) / 3000) : 0.5
      const score = scoreCandidate({
        distanceM: route.distanceM,
        targetM,
        poiCount,
        style,
        novelty,
        elevationGainM: route.elevationGainM,
      })
      // 合并目的地 POI 与沿途 POI，按 id 去重（避免 React key 重复 / 重复停靠点）
      const destPoi = d.isPoi ? allPois.find((p) => p.coord === d.coord) : undefined
      const seen = new Set<string>()
      const pois = (destPoi ? [destPoi, ...nearPois] : nearPois).filter((p) => {
        if (seen.has(p.id)) return false
        seen.add(p.id)
        return true
      })
      recs.push({
        route,
        pois,
        destName: d.name,
        distanceM: route.distanceM,
        durationS: route.durationS,
        elevationGainM: route.elevationGainM,
        score,
      })
    } catch {
      // 单候选失败跳过
    }
    // 尊重高德 QPS 限制：每条候选之间留间隔
    await new Promise((r) => setTimeout(r, 300))
  }

  // 3) 过滤接近目标里程的，按分数排序取前 3
  const filtered = recs.filter((c) => Math.abs(c.distanceM - targetM) <= targetM * 0.4)
  filtered.sort((a, b) => b.score - a.score)
  return filtered.slice(0, 3)
}
