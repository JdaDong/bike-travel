import type { FastifyInstance } from 'fastify'
import { defaultProvider } from '../geo/provider'

export function registerGeocodeRoutes(app: FastifyInstance): void {
  // GET /api/geocode?q=地址  ->  WGS-84 坐标
  app.get('/api/geocode', async (req) => {
    const q = req.query as Record<string, string>
    const address = q.q ?? ''
    if (!address) return { coord: null, provider: 'none' }
    const provider = defaultProvider()
    const coord = await provider.geocode(address)
    return { provider: provider.name, coord }
  })
}
