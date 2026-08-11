import type { Coordinate, POI, Route } from '@bike-travel/shared'

export async function getRoute(
  from: Coordinate,
  to: Coordinate,
  pref = 'fastest',
): Promise<Route> {
  const fromQ = `${from.lng},${from.lat}`
  const toQ = `${to.lng},${to.lat}`
  const r = await fetch(`/api/route?from=${fromQ}&to=${toQ}&pref=${pref}`)
  if (!r.ok) throw new Error('route failed')
  return (await r.json()) as Route
}

export async function searchPOI(q: string, near: Coordinate, radiusM?: number): Promise<POI[]> {
  const url =
    `/api/poi?q=${encodeURIComponent(q)}&near=${near.lng},${near.lat}` +
    (radiusM ? `&radius=${radiusM}` : '')
  const r = await fetch(url)
  if (!r.ok) throw new Error('poi failed')
  return (await r.json()) as POI[]
}

// 地理编码搜索：输入地址/地名 -> WGS-84 坐标（后端走高德）
export async function searchPlace(q: string): Promise<{ provider: string; coord: Coordinate | null }> {
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`)
  if (!r.ok) throw new Error('geocode failed')
  return (await r.json()) as { provider: string; coord: Coordinate | null }
}

// 天气 / 空气质量
export interface WeatherNow {
  tempC: number
  humidity: number
  precipMm: number
  windKmh: number
  windDeg: number
  code: number
  aqi: number
  pm25: number
  pm10: number
  label: string
}

export interface WeatherCell {
  lng: number
  lat: number
  tempC: number
  aqi: number
  precipMm: number
  windKmh: number
}

export type WeatherMetric = 'temp' | 'aqi' | 'precip'

// 单点实时天气 + 空气
export async function getWeather(lng: number, lat: number): Promise<WeatherNow> {
  const r = await fetch(`/api/weather?lng=${lng}&lat=${lat}`)
  if (!r.ok) throw new Error('weather failed')
  return (await r.json()) as WeatherNow
}

// bbox 网格天气场（供地图环境图层渲染），n 为每边采样数
export async function getWeatherField(
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number },
  n = 7,
): Promise<WeatherCell[]> {
  const p = `minLng=${bbox.minLng}&minLat=${bbox.minLat}&maxLng=${bbox.maxLng}&maxLat=${bbox.maxLat}&n=${n}`
  const r = await fetch(`/api/weather/field?${p}`)
  if (!r.ok) throw new Error('weather field failed')
  const j = (await r.json()) as { cells: WeatherCell[] }
  return j.cells
}
