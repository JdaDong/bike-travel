import type { FastifyInstance } from 'fastify'
import type { BikePreference, Coordinate, RouteRequest } from '@bike-travel/shared'
import { selectProvider } from '../geo/provider'

export function registerRouteRoutes(app: FastifyInstance): void {
  // GET /api/route?from=lng,lat&to=lng,lat&pref=fastest
  app.get('/api/route', async (req) => {
    const q = req.query as Record<string, string>
    const [flng, flat] = (q.from ?? '116.397,39.908').split(',').map(Number)
    const [tlng, tlat] = (q.to ?? '116.45,39.95').split(',').map(Number)
    const from: Coordinate = { lng: flng, lat: flat, crs: 'WGS84' }
    const to: Coordinate = { lng: tlng, lat: tlat, crs: 'WGS84' }
    const preference = (q.pref as BikePreference) ?? 'fastest'
    const provider = selectProvider(from, to)
    const route = await provider.route({ from, to, preference } as RouteRequest)
    return route
  })
}
