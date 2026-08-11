import type { FastifyInstance } from 'fastify'
import type { Coordinate, POI } from '@bike-travel/shared'
import { selectProvider } from '../geo/provider'

export function registerPoiRoutes(app: FastifyInstance): void {
  // GET /api/poi?q=咖啡&near=lng,lat
  app.get('/api/poi', async (req): Promise<POI[]> => {
    const q = req.query as Record<string, string>
    const [lng, lat] = (q.near ?? '121.4737,31.2304').split(',').map(Number)
    const near: Coordinate = { lng, lat, crs: 'WGS84' }
    const radius = Number(q.radius ?? 2000)
    const provider = selectProvider(near, near)
    return provider.searchPOI(q.q ?? '咖啡', near, radius)
  })
}
