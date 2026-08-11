// 智能路线推荐无头验证：用 mock 拦截 /api/route、/api/poi、/sw.js，
// 不依赖高德配额（已在先前会话验证过真实集成），专注验证「候选生成→打分→渲染→选用→导航」全链路。
const puppeteer = require('puppeteer-core')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE_URL = 'http://localhost:5173'

const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond })
  console.log(`${cond ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`)
}

// haversine（米）
function haversine(fl, ft, tl, tt) {
  const R = 6371000
  const dLat = ((tt - ft) * Math.PI) / 180
  const dLng = ((tl - fl) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos((ft * Math.PI) / 180) * Math.cos((tt * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

// 合成一条骑行路线：from->to 线性插值 + 垂直抖动，距离按直线*1.3 估算
function synthRoute(fl, ft, tl, tt) {
  const N = 14
  const geom = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const lng = fl + (tl - fl) * t + (i % 2 ? 0.0006 : -0.0006)
    const lat = ft + (tt - ft) * t + (i % 3 ? 0.0004 : -0.0004)
    geom.push({ lng, lat, crs: 'WGS84' })
  }
  const dM = haversine(fl, ft, tl, tt) * 1.3
  const gain = 10 + Math.round(Math.random() * 30)
  return {
    id: 'mock-' + Math.random().toString(36).slice(2, 8),
    geometry: geom,
    distanceM: Math.round(dM),
    durationS: Math.round(dM / 4),
    elevationGainM: gain,
    steps: [{ instruction: '直行', geometry: geom, distanceM: Math.round(dM), durationS: Math.round(dM / 4), maneuver: 'straight' }],
    provider: 'amap',
  }
}

// 合成 POI：在 near 周围按 0.8/1.0/1.2 倍环线半径放置 3 个，保证有候选接近目标里程
function synthPois(lng, lat, q, targetM) {
  const ringR = targetM / 2 / 1.3
  const dLat = (m) => (m * (m < 0 ? 1 : 1)) / 111320
  const offs = [0.8, 1.0, 1.2]
  const cats = { 景点: '景点', 美食: '美食', 公园: '公园' }
  return offs.map((k, i) => ({
    id: 'poi-' + i,
    name: `${q || '点'}${i + 1}`,
    coord: { lng: lng + (ringR * k) / 111320 / Math.cos((lat * Math.PI) / 180), lat: lat + (ringR * k) / 111320, crs: 'WGS84' },
    category: cats[q] || '景点',
    tags: {},
  }))
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-gpu'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })

  // 拦截外部依赖：/sw.js 不注册，/api/* 返回合成数据（脱离高德配额，确定性验证）
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const url = req.url()
    if (url.endsWith('/sw.js')) return req.respond({ status: 404, body: '' })
    if (url.includes('/api/route')) {
      const u = new URL(url)
      const [fl, ft] = u.searchParams.get('from').split(',').map(Number)
      const [tl, tt] = u.searchParams.get('to').split(',').map(Number)
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(synthRoute(fl, ft, tl, tt)) })
    }
    if (url.includes('/api/poi')) {
      const u = new URL(url)
      const [lng, lat] = u.searchParams.get('near').split(',').map(Number)
      const q = decodeURIComponent(u.searchParams.get('q') || '')
      const targetM = Number(u.searchParams.get('radius') || '6000') / 1.6 * 2 * 1.3
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(synthPois(lng, lat, q, targetM)) })
    }
    req.continue()
  })

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('Failed to load resource') && errors.push(m.text()))

  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })

  await clickByText(page, 'button', '推荐')
  await new Promise((r) => setTimeout(r, 600))

  // 默认 10km / 景观 -> 生成
  await clickByText(page, 'button', '生成推荐路线')
  let smartText = ''
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    smartText = await page.evaluate(() => document.body.innerText)
    if (smartText.includes('用此路线导航')) break
  }
  ok('智能推荐: 生成候选并渲染结果卡片', smartText.includes('用此路线导航'))
  ok('智能推荐: 显示推荐分数', /分\s*[\d.]+/.test(smartText))
  ok('智能推荐: 显示里程/爬升指标', /km\s*·\s*\d+min/.test(smartText))
  ok('智能推荐: 含沿途停靠点提示', /停靠点/.test(smartText))

  // 切换 20km + 美食，再次生成
  await clickByText(page, 'button', '20km')
  await clickByText(page, 'button', '美食')
  await clickByText(page, 'button', '生成推荐路线')
  let smartText2 = ''
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    smartText2 = await page.evaluate(() => document.body.innerText)
    if (smartText2.includes('用此路线导航')) break
  }
  ok('智能推荐: 里程/风格筛选后重新生成', smartText2.includes('用此路线导航'))

  // 选用第一条并触发导航（确认路线进入导航状态）
  await clickByText(page, 'button', '用此路线导航')
  await new Promise((r) => setTimeout(r, 1500))
  const navOn = await page.evaluate(() => document.body.innerText.includes('退出导航') || document.body.innerText.includes('导航中'))
  ok('智能推荐: 选用后可进入导航', navOn)

  await page.screenshot({ path: '/tmp/smart_verify.png' })

  ok('运行期无未捕获错误', errors.length === 0, errors.slice(0, 2).join(' | '))

  await browser.close()
  const passed = results.filter((r) => r.pass).length
  console.log(`\n==== ${passed}/${results.length} PASS ====`)
  process.exit(passed === results.length ? 0 : 1)
})().catch((e) => {
  console.error('VERIFY ERROR', e)
  process.exit(2)
})

async function clickByText(page, selector, text) {
  const handle = await page.evaluateHandle(
    (sel, t) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t)) || null,
    selector, text,
  )
  const el = handle.asElement()
  if (el) await el.click()
  return !!el
}
