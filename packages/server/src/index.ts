import Fastify from 'fastify'
import cors from '@fastify/cors'
import { registerRouteRoutes } from './routes/route'
import { registerPoiRoutes } from './routes/poi'
import { registerGeocodeRoutes } from './routes/geocode'
import { registerWeatherRoutes } from './routes/weather'
import { registerSyncRoutes } from './routes/sync'
import { registerLiveShare } from './ws/liveShare'
import { env } from './env'

const app = Fastify({ logger: true })

await app.register(cors, { origin: true })
registerRouteRoutes(app)
registerPoiRoutes(app)
registerGeocodeRoutes(app)
registerWeatherRoutes(app)
registerSyncRoutes(app)
// 结伴骑行：把 WebSocket 房间服务挂到 Fastify 底层 http.Server（复用同一端口与账户体系）
registerLiveShare(app.server)
app.get('/api/health', async () => ({ ok: true, amap: env.AMAP_KEY ? 'set' : 'unset' }))

const port = env.PORT
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => {
    console.log(`[server] listening on :${port}  (amap key: ${env.AMAP_KEY ? 'set' : 'unset'})`)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
