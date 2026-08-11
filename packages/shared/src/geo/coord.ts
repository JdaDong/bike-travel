// 坐标系互转：BD-09 / GCJ-02 / WGS-84
// 内部一律以 WGS-84 为准。高德用 GCJ-02：输入前 wgs84ToGcj02，返回后 gcj02ToWgs84。
// BD-09 函数保留备用（如需接百度）。
import type { Coordinate } from '../types'

const PI = Math.PI
const R = 6378245.0

const outChina = (lng: number, lat: number): boolean =>
  !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55)

const tLat = (x: number, y: number): number =>
  -100 +
  2 * x +
  3 * y +
  0.2 * y * y +
  0.1 * x * y +
  0.2 * Math.sqrt(Math.abs(x)) +
  ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) / 3 +
    (20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) / 3 +
    (160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) / 3)

const tLng = (x: number, y: number): number =>
  300 +
  2 * x +
  3 * y +
  0.2 * x * x +
  0.1 * x * y +
  0.2 * Math.sqrt(Math.abs(x)) +
  ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) / 3 +
    (20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) / 3 +
    (150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) / 3)

const delta = (lng: number, lat: number) => {
  const dLat = tLat(lng - 105, lat - 35)
  const dLng = tLng(lng - 105, lat - 35)
  const rLat = (lat / 180) * PI
  return {
    dLat: dLat + (dLat * Math.sin(rLat) * PI) / 180,
    dLng: dLng + (dLng * Math.cos(rLat) * PI) / 180,
  }
}

export function wgs84ToGcj02(lng: number, lat: number): Coordinate {
  if (outChina(lng, lat)) return { lng, lat, crs: 'WGS84' }
  const d = delta(lng, lat)
  return { lng: lng + (d.dLng * 180) / R, lat: lat + (d.dLat * 180) / R, crs: 'GCJ02' }
}

export function gcj02ToWgs84(lng: number, lat: number): Coordinate {
  if (outChina(lng, lat)) return { lng, lat, crs: 'WGS84' }
  const d = delta(lng, lat)
  return { lng: lng - (d.dLng * 180) / R, lat: lat - (d.dLat * 180) / R, crs: 'WGS84' }
}

export function gcj02ToBd09(lng: number, lat: number): Coordinate {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * PI)
  const t = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * PI)
  return { lng: z * Math.cos(t) + 0.0065, lat: z * Math.sin(t) + 0.006, crs: 'BD09' }
}

export function bd09ToGcj02(lng: number, lat: number): Coordinate {
  const x = lng - 0.0065
  const y = lat - 0.006
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * PI)
  const t = Math.atan2(y, x) - 0.000003 * Math.cos(x * PI)
  return { lng: z * Math.cos(t), lat: z * Math.sin(t), crs: 'GCJ02' }
}

export function wgs84ToBd09(lng: number, lat: number): Coordinate {
  const g = wgs84ToGcj02(lng, lat)
  return gcj02ToBd09(g.lng, g.lat)
}

export function bd09ToWgs84(lng: number, lat: number): Coordinate {
  const g = bd09ToGcj02(lng, lat)
  return gcj02ToWgs84(g.lng, g.lat)
}
