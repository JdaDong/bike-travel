import type { FastifyInstance } from 'fastify'

// 天气 / 空气质量图层后端
// 数据源：Open-Meteo（https://open-meteo.com + https://air-quality-api.open-meteo.com）
// 免费、免 API key、支持 CORS。可一次请求多坐标（逗号分隔）返回数组，
// 因此「网格 field」仅 2 次请求即可覆盖整片区域。
//
// 接口：
//   GET /api/weather?lng=&lat=          单点：温度/湿度/降水/风/天气代码 + 空气质量(AQI/PM2.5)
//   GET /api/weather/field?minLng=&minLat=&maxLng=&maxLat=&n=7
//                                        bbox 网格采样（n×n），供地图热力图层渲染

interface WeatherNow {
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

interface WeatherCell {
  lng: number
  lat: number
  tempC: number
  aqi: number
  precipMm: number
  windKmh: number
}

// WMO 天气代码 → 中文简述
function wmoLabel(code: number): string {
  const m: Record<number, string> = {
    0: '晴', 1: '大致晴朗', 2: '局部多云', 3: '阴',
    45: '雾', 48: '雾凇',
    51: '小毛雨', 53: '毛雨', 55: '大毛雨',
    61: '小雨', 63: '中雨', 65: '大雨',
    71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
    80: '阵雨', 81: '强阵雨', 82: '暴雨',
    85: '阵雪', 86: '强阵雪',
    95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴冰雹',
  }
  return m[code] ?? '未知'
}

// 单元格缓存：key=四舍五入 0.05° 网格 + 类型，10 分钟有效期，避免重复打外部 API
const cache = new Map<string, { t: number; v: WeatherNow | WeatherCell }>()
const TTL = 10 * 60 * 1000
function cacheKey(lat: number, lng: number, kind: 'now' | 'cell'): string {
  const r = (x: number) => Math.round(x / 0.05)
  return `${kind}:${r(lat)}:${r(lng)}`
}
function cached<T>(k: string): T | null {
  const hit = cache.get(k)
  if (hit && Date.now() - hit.t < TTL) return hit.v as T
  return null
}

async function fetchWeather(lat: number, lng: number) {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m`
  const r = await fetch(url)
  if (!r.ok) throw new Error('weather upstream ' + r.status)
  return (await r.json()) as any
}
async function fetchAir(lat: number, lng: number) {
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
    `&current=us_aqi,pm2_5,pm10`
  const r = await fetch(url)
  if (!r.ok) throw new Error('air upstream ' + r.status)
  return (await r.json()) as any
}

function pickWeather(cur: any, air: any): WeatherNow {
  const w = cur?.current ?? {}
  const a = air?.current ?? {}
  const tempC = typeof w.temperature_2m === 'number' ? w.temperature_2m : NaN
  const aqi = typeof a.us_aqi === 'number' ? a.us_aqi : NaN
  return {
    tempC: Math.round(tempC * 10) / 10,
    humidity: typeof w.relative_humidity_2m === 'number' ? w.relative_humidity_2m : NaN,
    precipMm: typeof w.precipitation === 'number' ? w.precipitation : 0,
    windKmh: typeof w.wind_speed_10m === 'number' ? w.wind_speed_10m : NaN,
    windDeg: typeof w.wind_direction_10m === 'number' ? w.wind_direction_10m : NaN,
    code: typeof w.weather_code === 'number' ? w.weather_code : 0,
    aqi: Math.round(aqi),
    pm25: typeof a.pm2_5 === 'number' ? Math.round(a.pm2_5) : NaN,
    pm10: typeof a.pm10 === 'number' ? Math.round(a.pm10) : NaN,
    label: wmoLabel(typeof w.weather_code === 'number' ? w.weather_code : 0),
  }
}

export function registerWeatherRoutes(app: FastifyInstance): void {
  // 单点天气 + 空气
  app.get('/api/weather', async (req): Promise<WeatherNow> => {
    const q = req.query as Record<string, string>
    const lng = Number(q.lng ?? '121.4737')
    const lat = Number(q.lat ?? '31.2304')
    const k = cacheKey(lat, lng, 'now')
    const hit = cached<WeatherNow>(k)
    if (hit) return hit
    const [w, a] = await Promise.all([fetchWeather(lat, lng), fetchAir(lat, lng)])
    const now = pickWeather(w, a)
    cache.set(k, { t: Date.now(), v: now })
    return now
  })

  // bbox 网格：一次请求拉全部坐标，返回 n×n 单元格
  app.get('/api/weather/field', async (req): Promise<{ cells: WeatherCell[] }> => {
    const q = req.query as Record<string, string>
    const minLng = Number(q.minLng ?? '121.3')
    const minLat = Number(q.minLat ?? '31.1')
    const maxLng = Number(q.maxLng ?? '121.7')
    const maxLat = Number(q.maxLat ?? '31.4')
    const n = Math.min(Math.max(Number(q.n ?? 7), 3), 12) // 3..12，避免过大

    const lats: number[] = []
    const lngs: number[] = []
    for (let i = 0; i < n; i++) {
      const f = n === 1 ? 0.5 : i / (n - 1)
      lats.push(minLat + f * (maxLat - minLat))
      lngs.push(minLng + f * (maxLng - minLng))
    }
    // 笛卡尔积展开为坐标列表
    const coords: { lat: number; lng: number }[] = []
    for (const lat of lats) for (const lng of lngs) coords.push({ lat, lng })

    // 单元格级缓存：尽量复用，未命中的批量补取
    const cells: WeatherCell[] = []
    const missIdx: number[] = []
    coords.forEach((c, i) => {
      const k = cacheKey(c.lat, c.lng, 'cell')
      const hit = cached<WeatherCell>(k)
      if (hit && 'tempC' in hit) {
        cells[i] = { lng: c.lng, lat: c.lat, tempC: hit.tempC!, aqi: hit.aqi!, precipMm: hit.precipMm!, windKmh: hit.windKmh! }
      } else {
        missIdx.push(i)
      }
    })

    if (missIdx.length) {
      const missCoords = missIdx.map((i) => coords[i])
      const [wJson, aJson] = await Promise.all([
        fetchWeatherMulti(missCoords),
        fetchAirMulti(missCoords),
      ])
      const wArr = Array.isArray(wJson) ? wJson : [wJson]
      const aArr = Array.isArray(aJson) ? aJson : [aJson]
      missIdx.forEach((i, j) => {
        const cur = wArr[j]?.current ?? {}
        const acur = aArr[j]?.current ?? {}
        const cell: WeatherCell = {
          lng: coords[i].lng,
          lat: coords[i].lat,
          tempC: typeof cur.temperature_2m === 'number' ? cur.temperature_2m : NaN,
          aqi: typeof acur.us_aqi === 'number' ? acur.us_aqi : NaN,
          precipMm: typeof cur.precipitation === 'number' ? cur.precipitation : 0,
          windKmh: typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m : NaN,
        }
        cells[i] = cell
        cache.set(cacheKey(coords[i].lat, coords[i].lng, 'cell'), { t: Date.now(), v: cell })
      })
    }

    return { cells: cells.filter(Boolean) }
  })
}

// Open-Meteo 多坐标请求：逗号分隔，返回数组
async function fetchWeatherMulti(coords: { lat: number; lng: number }[]) {
  const lat = coords.map((c) => c.lat).join(',')
  const lng = coords.map((c) => c.lng).join(',')
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&current=temperature_2m,precipitation,wind_speed_10m`
  const r = await fetch(url)
  if (!r.ok) throw new Error('weather upstream ' + r.status)
  return (await r.json()) as any
}
async function fetchAirMulti(coords: { lat: number; lng: number }[]) {
  const lat = coords.map((c) => c.lat).join(',')
  const lng = coords.map((c) => c.lng).join(',')
  const url =
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lng}` +
    `&current=us_aqi`
  const r = await fetch(url)
  if (!r.ok) throw new Error('air upstream ' + r.status)
  return (await r.json()) as any
}
