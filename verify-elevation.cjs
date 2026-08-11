const puppeteer = require('puppeteer-core')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = 'http://localhost:5173'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ✅ ${name}`)
    pass++
  } else {
    console.log(`  ❌ ${name}`, extra !== undefined ? extra : '')
    fail++
  }
}

// —— 构造一条含明确爬坡的轨迹（上海，经度东移产生真实几何距离）——
// 剖面：平(0-500m,20m) → 爬坡(500-2500m,20→220m,均10%) → 下坡(2500-4500m,220→20m) → 平(4500-5000m,20m)
// 期望：总距离≈5000m，总爬升≈200m，1 个爬坡段（≈2000m/200m/10% → score≈20000 → C3 级），最陡≈10%
const BASE_LNG = 121.47
const BASE_LAT = 31.23
const STEP_M = 50
const DEG_PER_STEP = STEP_M / (111320 * Math.cos((BASE_LAT * Math.PI) / 180))
const TOTAL_M = 5000
const N = TOTAL_M / STEP_M // 100 段 → 101 点
const SPEED_KMH = 20
const DT_MS = ((TOTAL_M / (SPEED_KMH / 3.6)) / N) * 1000

function eleAt(d) {
  if (d <= 500) return 20
  if (d <= 2500) return 20 + ((d - 500) / 2000) * 200 // 爬坡 +200m
  if (d <= 4500) return 220 - ((d - 2500) / 2000) * 200 // 下坡 -200m
  return 20
}

const startMs = new Date(2026, 6, 20, 8, 0, 0).getTime()
const points = []
for (let i = 0; i <= N; i++) {
  const d = i * STEP_M
  points.push({
    lng: BASE_LNG + DEG_PER_STEP * i,
    lat: BASE_LAT,
    ele: eleAt(d),
    t: startMs + Math.round(DT_MS * i),
    hr: 140 + (i % 12),
  })
}
const TRACK = {
  id: 'hill1',
  points,
  distanceM: TOTAL_M,
  elevationGainM: 200,
  name: '爬坡测试 5km',
  savedAt: startMs,
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1280,900'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/sw.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: '// noop' })
    if (u.includes('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '[]' })
    req.continue()
  })

  await page.evaluateOnNewDocument((track) => {
    localStorage.setItem('bike-travel:tracks', JSON.stringify([track]))
  }, TRACK)

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })
  await sleep(1200)

  console.log('— 加载轨迹到回放 + 分析 —')
  await page.click('[data-testid="tab-ride"]')
  await sleep(500)
  // 点击档案库条目加载回放（触发 analysisPoints → 底部剖面面板）
  await page.click('span[title="点击在地图回放 + 查看图表"]')
  await sleep(1000)

  // 1) 底部剖面面板与 SVG 渲染
  const ui = await page.evaluate(() => ({
    panel: !!document.querySelector('[data-testid="elev-panel"]'),
    svg: !!document.querySelector('[data-testid="elev-svg"]'),
    bars: document.querySelectorAll('[data-testid="elev-svg"] rect').length,
    climbs: document.querySelectorAll('[data-testid="climb-item"]').length,
  }))
  check('底部海拔剖面面板出现', ui.panel)
  check('剖面 SVG 已渲染', ui.svg)
  check('剖面竖条 > 30（面积图着色）', ui.bars > 30, ui.bars)
  check('识别到 1 个爬坡段', ui.climbs === 1, ui.climbs)

  // 2) 纯函数聚合数值（精确断言）
  const c = await page.evaluate(() => window.__climb || null)
  check('window.__climb 已生成', !!c)
  check('总距离 ≈ 5000m (4900–5100)', c && c.distanceM >= 4900 && c.distanceM <= 5100, c && Math.round(c.distanceM))
  check('总爬升 ≈ 200m (185–205)', c && c.totalAscentM >= 185 && c.totalAscentM <= 205, c && c.totalAscentM)
  check('总下降 ≈ 200m (185–205)', c && c.totalDescentM >= 185 && c.totalDescentM <= 205, c && c.totalDescentM)
  check('最陡坡 ≈ 10% (8–13)', c && c.maxGrade >= 8 && c.maxGrade <= 13, c && c.maxGrade.toFixed(1))
  check('爬坡段计数 = 1', c && c.climbCount === 1, c && c.climbCount)
  check('剖面点数 > 100（等距重采样 25m）', c && c.profileLen > 100, c && c.profileLen)

  // 3) 爬坡段定级标签（score≈20000 → C3；容忍 C2–C4）
  const climbText = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="climb-item"]')
    return el ? el.textContent : ''
  })
  check('爬坡段显示定级标签 (C2/C3/C4)', /C[2-4]\s*级/.test(climbText), climbText)
  check('爬坡段显示均坡百分比', /均\s*\d/.test(climbText), climbText)

  // 4) 剖面悬停 → 地图联动高亮标记
  const beforeHover = await page.evaluate(() => !!document.querySelector('.elev-hover-marker'))
  check('悬停前地图无高亮标记', !beforeHover)
  await page.evaluate(() => window.__elevHoverFrac && window.__elevHoverFrac(0.5))
  await sleep(500)
  const afterHover = await page.evaluate(() => ({
    marker: !!document.querySelector('.elev-hover-marker'),
    readout: (document.querySelector('[data-testid="elev-readout"]') || {}).textContent || '',
  }))
  check('悬停后地图出现红色高亮标记', afterHover.marker)
  check('悬停读数显示坡度', /坡度/.test(afterHover.readout), afterHover.readout.trim().slice(0, 40))

  await page.screenshot({ path: '/tmp/elevation_verify.png', fullPage: false })

  // 5) 收起 → 重开 pill
  await page.click('[data-testid="elev-close"]')
  await sleep(400)
  const closed = await page.evaluate(() => ({
    panel: !!document.querySelector('[data-testid="elev-panel"]'),
    reopen: !!document.querySelector('[data-testid="elev-reopen"]'),
    marker: !!document.querySelector('.elev-hover-marker'),
  }))
  check('收起后剖面面板消失', !closed.panel)
  check('收起后出现重开 pill', closed.reopen)
  check('收起后地图高亮标记一并移除', !closed.marker)
  await page.click('[data-testid="elev-reopen"]')
  await sleep(400)
  const reopened = await page.evaluate(() => !!document.querySelector('[data-testid="elev-panel"]'))
  check('点击 pill 后剖面面板重新出现', reopened)

  check('无运行期错误', errors.length === 0)
  if (errors.length) console.log('  ⚠️ errors:', errors.slice(0, 4))

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
