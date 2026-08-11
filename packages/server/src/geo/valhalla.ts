// Valhalla Provider：自托管 Valhalla 的 REST /route 接口，原生 bicycle profile
import type { Coordinate, GeoProvider, Maneuver, POI, Route, RouteRequest } from '@bike-travel/shared'
import { decodeValhallaPolyline, elevationGain } from '@bike-travel/shared'

function toManeuver(type: number): Maneuver {
  if (type <= 4) return 'depart'
  if (type <= 7) return 'arrive'
  if ([13, 15, 17, 22, 26, 29].includes(type)) return 'turn_right'
  if ([14, 16, 18, 23, 25, 28].includes(type)) return 'turn_left'
  if (type === 13) return 'slight_right'
  if (type === 14) return 'slight_left'
  if (type === 20) return 'roundabout'
  return 'straight'
}

export function createValhallaProvider(baseUrl: string): GeoProvider {
  const endpoint = baseUrl.replace(/\/$/, '') + '/route'
  return {
    name: 'osm',
    async route(req: RouteRequest): Promise<Route> {
      const body = {
        locations: [
          { lat: req.from.lat, lon: req.from.lng },
          { lat: req.to.lat, lon: req.to.lng },
        ],
        costing: 'bicycle',
        directions_options: { units: 'kilometers', narrative: true },
        elevation: true,
      }
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = (await r.json()) as any
      const leg = j.trip.legs[0]
      const geometry = decodeValhallaPolyline(leg.shape, 6, true)
      const distanceM: number = j.trip.summary.length
      const durationS: number = j.trip.summary.time
      const steps = leg.maneuvers.map((m: any) => ({
        instruction: m.verbal_post_transition_instruction || m.instruction || '',
        geometry: geometry.slice(m.begin_shape_index, m.end_shape_index + 1),
        distanceM: m.length,
        durationS: m.time,
        maneuver: toManeuver(m.type),
      }))
      return {
        id: String(j.trip.legs[0].id ?? Math.random().toString(36).slice(2, 10)),
        geometry,
        distanceM,
        durationS,
        elevationGainM: elevationGain(geometry),
        steps,
        provider: 'osm',
      }
    },
    async searchPOI(): Promise<POI[]> {
      return []
    },
    async geocode(): Promise<Coordinate> {
      throw new Error('valhalla provider: geocode not implemented')
    },
  }
}
