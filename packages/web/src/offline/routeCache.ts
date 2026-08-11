// 离线路由缓存：把每段规划结果按起终点签名缓存到 localStorage，
// 弱网 / 无网（请求失败）时回退到缓存几何，导航与行程可继续工作。
// 与 offline/offline.ts（离线瓦片）互补：瓦片管「底图」，这里管「路线」。
import type { Coordinate, Route } from '@bike-travel/shared'
import { getRoute } from '../api'
import { loadJSON, saveJSON, KEYS } from '../storage'

type RouteCache = Record<string, Route>

// 起终点四舍五入 4 位（~11m），避免浮点抖动导致缓存不命中
function routeKey(from: Coordinate, to: Coordinate): string {
  const f = `${from.lng.toFixed(4)},${from.lat.toFixed(4)}`
  const t = `${to.lng.toFixed(4)},${to.lat.toFixed(4)}`
  return `${f}->${t}`
}

function readAll(): RouteCache {
  return loadJSON<RouteCache>(KEYS.routesCache, {})
}

export function getCachedRoute(from: Coordinate, to: Coordinate): Route | null {
  return readAll()[routeKey(from, to)] ?? null
}

export function cacheRoute(from: Coordinate, to: Coordinate, route: Route): void {
  const all = readAll()
  all[routeKey(from, to)] = route
  // 限制缓存规模，避免 localStorage 膨胀
  const keys = Object.keys(all)
  if (keys.length > 200) {
    for (const k of keys.slice(0, keys.length - 200)) delete all[k]
  }
  saveJSON(KEYS.routesCache, all)
}

// 智能取路：优先联网获取最新路线并写缓存；失败时回退缓存；缓存也没有则抛出。
export async function getRouteSmart(
  from: Coordinate,
  to: Coordinate,
  pref = 'fastest',
): Promise<Route> {
  try {
    const r = await getRoute(from, to, pref)
    cacheRoute(from, to, r)
    return r
  } catch (e) {
    const cached = getCachedRoute(from, to)
    if (cached) {
      cached.cached = true // 标记离线回退，上层可提示
      return cached
    }
    throw e
  }
}
