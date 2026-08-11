// 高德地图 API Provider：国内骑行路线 / POI / 地理编码
// 坐标系：高德使用 GCJ-02（国测局）。输入必须是 GCJ-02，故先把 WGS-84 转 GCJ-02；
// 返回结果也是 GCJ-02，统一在 shared/geo/coord 转回 WGS-84。
import type { Coordinate, GeoProvider, POI, Route, RouteRequest } from '@bike-travel/shared'
import { elevationGain, gcj02ToWgs84, parseManeuver, wgs84ToGcj02 } from '@bike-travel/shared'

// v4 错误字段是 errmsg/errcode，v3 是 info；统一取可读原因
const amapErr = (j: any): string => j?.errmsg || j?.info || String(j?.status ?? 'unknown')

export function createAmapProvider(key: string, host: string): GeoProvider {
  return {
    name: 'amap',
    async route(req: RouteRequest): Promise<Route> {
      // 高德骑行：v4 direction/bicycling，origin/destination 格式为“经度,纬度”（GCJ-02）
      const from = wgs84ToGcj02(req.from.lng, req.from.lat)
      const to = wgs84ToGcj02(req.to.lng, req.to.lat)
      const url =
        `${host}/v4/direction/bicycling?origin=${from.lng},${from.lat}` +
        `&destination=${to.lng},${to.lat}&key=${encodeURIComponent(key)}`
      const r = await fetch(url)
      const j = (await r.json()) as any
      // v4 成功响应：顶层无 status，数据在 data.paths[0]；错误时 errcode != 0 / errmsg 有值
      const path = j?.data?.paths?.[0]
      if (!path) throw new Error(`amap direction: ${amapErr(j)}`)
      const geometry: Coordinate[] = []
      let last: Coordinate | null = null
      const steps = (path.steps as any[]).map((s: any) => {
        const stepGeom: Coordinate[] = []
        for (const seg of (s.polyline as string).split(';')) {
          const [lng, lat] = seg.split(',').map(Number)
          if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue
          const c = gcj02ToWgs84(lng, lat) // GCJ-02 -> WGS-84（内部统一坐标系）
          if (last && last.lng === c.lng && last.lat === c.lat) continue
          geometry.push(c)
          stepGeom.push(c)
          last = c
        }
        return {
          instruction: s.instruction ?? '',
          geometry: stepGeom,
          distanceM: Number(s.distance),
          durationS: Number(s.duration),
          maneuver: parseManeuver(s.instruction ?? ''),
        }
      })
      const distanceM: number = Number(path.distance)
      const durationS: number = Number(path.duration)
      return {
        id: Math.random().toString(36).slice(2, 10),
        geometry,
        distanceM,
        durationS,
        elevationGainM: elevationGain(geometry),
        steps,
        provider: 'amap',
      }
    },
    async searchPOI(q: string, near: Coordinate, radiusM = 2000): Promise<POI[]> {
      // 高德周边搜索：place/around，location 为中心点（GCJ-02）
      const c = wgs84ToGcj02(near.lng, near.lat)
      const url =
        `${host}/v3/place/around?key=${encodeURIComponent(key)}` +
        `&location=${c.lng},${c.lat}&keywords=${encodeURIComponent(q)}&radius=${radiusM}&offset=25`
      const r = await fetch(url)
      const j = (await r.json()) as any
      if (j.status !== '1') throw new Error(`amap poi: ${amapErr(j)}`)
      return (j.pois ?? []).map((p: any) => {
        const [lng, lat] = (p.location as string).split(',').map(Number)
        return {
          id: String(p.id),
          name: p.name,
          coord: gcj02ToWgs84(lng, lat),
          category: (p.type as string) ?? 'poi',
          tags: {},
        }
      })
    },
    async geocode(q: string): Promise<Coordinate> {
      const url = `${host}/v3/geocode/geo?key=${encodeURIComponent(key)}&address=${encodeURIComponent(q)}`
      const r = await fetch(url)
      const j = (await r.json()) as any
      if (j.status !== '1' || !j.geocodes?.length) throw new Error(`amap geocode: ${amapErr(j)}`)
      const [lng, lat] = (j.geocodes[0].location as string).split(',').map(Number)
      return gcj02ToWgs84(lng, lat)
    },
  }
}
