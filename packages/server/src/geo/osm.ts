// OSM / Valhalla Provider：用公共 OSRM 或自建 Valhalla 骑行路由
import type { Coordinate, GeoProvider, POI, Route, RouteRequest } from '@bike-travel/shared'
import { elevationGain } from '@bike-travel/shared'

export function createOsmProvider(baseUrl: string): GeoProvider {
  return {
    name: 'osm',
    async route(req: RouteRequest): Promise<Route> {
      const coords = `${req.from.lng},${req.from.lat};${req.to.lng},${req.to.lat}`
      const url = `${baseUrl}${coords}?overview=full&geometries=geojson`
      const r = await fetch(url)
      const j = (await r.json()) as any
      const geom: Coordinate[] = j.routes[0].geometry.coordinates.map(
        ([lng, lat]: [number, number]) => ({ lng, lat }),
      )
      const distanceM: number = j.routes[0].distance
      const durationS: number = j.routes[0].duration
      return {
        id: Math.random().toString(36).slice(2, 10),
        geometry: geom,
        distanceM,
        durationS,
        elevationGainM: elevationGain(geom),
        steps: [
          {
            instruction: 'OSM 骑行路线',
            geometry: geom,
            distanceM,
            durationS,
            maneuver: 'straight',
          },
        ],
        provider: 'osm',
      }
    },
    async searchPOI(): Promise<POI[]> {
      return []
    },
    async geocode(): Promise<Coordinate> {
      throw new Error('osm provider: geocode not implemented')
    },
  }
}
