// 途径点骑行导航：把「起点 → 途经点1 → 途经点2 → … → 终点」拆成多段逐段规划，
// 再拼接成一条 Route，从而复用既有的导航核心（进度 / 偏航 / 转向）无需改动。
// 同时保存每段 legs，便于偏航时「重路由到当前目标站」而非跳过途径点直达终点。
import type { Coordinate, Route, RouteStep } from '@bike-travel/shared'

export interface NavStop {
  name?: string
  coord: Coordinate
}

// 把多段路线拼接为一条（去掉相邻段共享的端点以避免几何重叠）。
// 距离 / 时长 / 爬升累加；provider 取首段；steps 几何同样去重首点以保持连续。
export function mergeRoutes(legs: Route[]): Route {
  if (legs.length === 0) throw new Error('mergeRoutes: 空路段')
  if (legs.length === 1) return legs[0]
  const geometry: Coordinate[] = []
  const steps: RouteStep[] = []
  let distanceM = 0
  let durationS = 0
  let elevationGainM = 0
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]
    const geo = leg.geometry
    for (let j = i === 0 ? 0 : 1; j < geo.length; j++) geometry.push(geo[j])
    for (const s of leg.steps) {
      const sg = s.geometry
      steps.push({ ...s, geometry: i === 0 ? sg : sg.slice(1) })
    }
    distanceM += leg.distanceM
    durationS += leg.durationS
    elevationGainM += leg.elevationGainM
  }
  return {
    id: 'merged-' + legs.map((l) => l.id).join('+'),
    geometry,
    distanceM,
    durationS,
    elevationGainM,
    steps,
    provider: legs[0].provider,
  }
}

// 逐段规划：对相邻 stops 调用 planOne（默认 getRouteSmart，含离线程缓存回退）。
// 返回拼接后的整条路线与原始分段，供导航在偏航时重建。
export async function planWaypointRoute(
  stops: NavStop[],
  planOne: (from: Coordinate, to: Coordinate) => Promise<Route>,
): Promise<{ merged: Route; legs: Route[] }> {
  if (stops.length < 2) throw new Error('planWaypointRoute: 至少需要起点与终点')
  const legs: Route[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    legs.push(await planOne(stops[i].coord, stops[i + 1].coord))
  }
  return { merged: mergeRoutes(legs), legs }
}

// 由一条已规划路线派生出单段导航上下文（无途径点时复用同一模型）。
export function singleNavContext(route: Route): { stops: NavStop[]; legs: Route[] } {
  const g = route.geometry
  return {
    stops: [
      { name: '起点', coord: g[0] },
      { name: '终点', coord: g[g.length - 1] },
    ],
    legs: [route],
  }
}
