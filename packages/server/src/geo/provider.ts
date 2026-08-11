// Provider 路由优先级：Valhalla(自托管) > 高德(国内+在线+有key) > OSM/OSRM > Demo
import type { BoundingBox, Coordinate, GeoProvider } from '@bike-travel/shared'
import { isInChina } from '@bike-travel/shared'
import { env } from '../env'
import { createDemoProvider } from './demo'
import { createOsmProvider } from './osm'
import { createAmapProvider } from './amap'
import { createValhallaProvider } from './valhalla'

function bboxOf(a: Coordinate, b: Coordinate): BoundingBox {
  return {
    minLng: Math.min(a.lng, b.lng),
    maxLng: Math.max(a.lng, b.lng),
    minLat: Math.min(a.lat, b.lat),
    maxLat: Math.max(a.lat, b.lat),
  }
}

export function selectProvider(from: Coordinate, to: Coordinate, online = true): GeoProvider {
  const box = bboxOf(from, to)
  if (env.VALHALLA_URL) return createValhallaProvider(env.VALHALLA_URL)
  if (env.AMAP_KEY && isInChina(box) && online) {
    return createAmapProvider(env.AMAP_KEY, env.AMAP_REST_HOST)
  }
  if (env.OSM_ROUTING_URL) return createOsmProvider(env.OSM_ROUTING_URL)
  return createDemoProvider()
}

// 无起终点时（如地理编码）选默认 provider
export function defaultProvider(online = true): GeoProvider {
  if (env.VALHALLA_URL) return createValhallaProvider(env.VALHALLA_URL)
  if (env.AMAP_KEY && online) return createAmapProvider(env.AMAP_KEY, env.AMAP_REST_HOST)
  if (env.OSM_ROUTING_URL) return createOsmProvider(env.OSM_ROUTING_URL)
  return createDemoProvider()
}
