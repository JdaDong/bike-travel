// 纯几何工具：距离 / 方位角 / 爬升 / 抽稀 / 投影 / 区域判定
import type { BoundingBox, Coordinate } from '../types'

const EARTH_R = 6371000 // m
const toRad = (d: number): number => (d * Math.PI) / 180
const toDeg = (r: number): number => (r * 180) / Math.PI

export function haversine(a: Coordinate, b: Coordinate): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function bearing(a: Coordinate, b: Coordinate): number {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat))
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng))
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}

export interface ElevationSample {
  distM: number
  ele: number
}

export function elevationProfile(points: Coordinate[]): ElevationSample[] {
  const out: ElevationSample[] = []
  let dist = 0
  for (let i = 0; i < points.length; i++) {
    if (i > 0) dist += haversine(points[i - 1], points[i])
    out.push({ distM: dist, ele: points[i].ele ?? 0 })
  }
  return out
}

export function elevationGain(points: Coordinate[]): number {
  let gain = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].ele ?? 0
    const b = points[i].ele ?? 0
    if (b > a) gain += b - a
  }
  return Math.round(gain)
}

// Douglas-Peucker 抽稀
export function simplify(points: Coordinate[], toleranceM = 10): Coordinate[] {
  if (points.length <= 2) return points
  const sqTol = toleranceM * toleranceM
  const sqSegDist = (p: Coordinate, a: Coordinate, b: Coordinate): number => {
    let x = a.lng
    let y = a.lat
    let dx = b.lng - x
    let dy = b.lat - y
    if (dx !== 0 || dy !== 0) {
      const t = ((p.lng - x) * dx + (p.lat - y) * dy) / (dx * dx + dy * dy)
      if (t > 1) {
        x = b.lng
        y = b.lat
      } else if (t > 0) {
        x += dx * t
        y += dy * t
      }
    }
    dx = p.lng - x
    dy = p.lat - y
    return dx * dx + dy * dy
  }
  const out: Coordinate[] = []
  const rdp = (pts: Coordinate[], first: number, last: number): void => {
    let max = 0
    let idx = -1
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(pts[i], pts[first], pts[last])
      if (d > max) {
        max = d
        idx = i
      }
    }
    if (max > sqTol && idx !== -1) {
      rdp(pts, first, idx)
      out.push(pts[idx])
      rdp(pts, idx, last)
    }
  }
  out.push(points[0])
  rdp(points, 0, points.length - 1)
  out.push(points[points.length - 1])
  return out
}

export function isInChina(box: BoundingBox): boolean {
  return box.minLng > 73 && box.maxLng < 136 && box.minLat > 3 && box.maxLat < 54
}

// 点投影到线段，返回最近点与沿线比例 t（导航偏航判定用）
export function nearestOnSegment(
  p: Coordinate,
  a: Coordinate,
  b: Coordinate,
): { point: Coordinate; t: number } {
  const dx = b.lng - a.lng
  const dy = b.lat - a.lat
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return { point: { lng: a.lng + t * dx, lat: a.lat + t * dy }, t }
}

// Valhalla encoded polyline 解码（精度 6，可选内嵌高程）
export function decodeValhallaPolyline(
  str: string,
  precision = 6,
  includeElevation = false,
): Coordinate[] {
  let index = 0
  let lat = 0
  let lng = 0
  let ele = 0
  const coords: Coordinate[] = []
  const factor = 10 ** precision

  const nextVarint = (): number => {
    let result = 1
    let shift = 0
    let byte: number
    do {
      byte = str.charCodeAt(index++) - 63 - 1
      result += byte << shift
      shift += 5
    } while (byte >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }

  while (index < str.length) {
    lat += nextVarint()
    lng += nextVarint()
    const pt: Coordinate = { lng: lng / factor, lat: lat / factor }
    if (includeElevation) {
      ele += nextVarint()
      pt.ele = ele / 100
    }
    coords.push(pt)
  }
  return coords
}
