// Demo Provider：无任何外部服务时合成一条路线，保证应用始终可跑
import type { Coordinate, GeoProvider, POI, Route, RouteRequest } from '@bike-travel/shared'
import { elevationGain, haversine } from '@bike-travel/shared'

const uid = (): string => Math.random().toString(36).slice(2, 10)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

export function createDemoProvider(): GeoProvider {
  return {
    name: 'demo',
    async route(req: RouteRequest): Promise<Route> {
      const { from, to } = req
      const N = 24
      const geometry: Coordinate[] = []
      for (let i = 0; i <= N; i++) {
        const t = i / N
        // 加一点垂直偏移，路线更像真实道路而非直线
        const off = Math.sin(t * Math.PI) * 0.01
        const lat = lerp(from.lat, to.lat, t) + off
        const lng = lerp(from.lng, to.lng, t) + off * 0.8
        const ele = 50 + Math.sin(t * Math.PI * 3) * 20
        geometry.push({ lng, lat, ele })
      }
      const distanceM = geometry.reduce(
        (s, p, i) => (i ? s + haversine(geometry[i - 1], p) : 0),
        0,
      )
      const durationS = distanceM / 4.5 // 假定均速 ~16km/h
      const steps = [
        {
          instruction: '出发',
          geometry: [geometry[0]],
          distanceM: distanceM * 0.5,
          durationS: durationS * 0.5,
          maneuver: 'depart' as const,
        },
        {
          instruction: '到达目的地',
          geometry: [geometry[geometry.length - 1]],
          distanceM: distanceM * 0.5,
          durationS: durationS * 0.5,
          maneuver: 'arrive' as const,
        },
      ]
      return {
        id: uid(),
        geometry,
        distanceM,
        durationS,
        elevationGainM: elevationGain(geometry),
        steps,
        provider: 'demo',
      }
    },
    async searchPOI(q: string, near: Coordinate): Promise<POI[]> {
      return [{ id: uid(), name: `示例 POI: ${q}`, coord: near, category: 'demo', tags: {} }]
    },
    async geocode(addr: string): Promise<Coordinate> {
      // 缺省返回天安门附近（WGS-84）
      return { lng: 116.397, lat: 39.908, crs: 'WGS84' }
    },
  }
}
