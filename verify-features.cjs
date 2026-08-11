// 四项新能力的无头验证：PWA 资源 / 导航增强 / 离线路由缓存 / 成绩分享卡片 / 行程编辑
const puppeteer = require('puppeteer-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:5173'
const results = []
const ok = (name, cond, extra = '') => {
  results.push({ name, pass: !!cond, extra })
  console.log(`${cond ? 'PASS' : 'FAIL'} · ${name}${extra ? ' · ' + extra : ''}`)
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-gpu'],
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })

  // 提前注入 localStorage（行程 + 轨迹），reload 让 App 在挂载时重新读取
  await page.evaluate(() => {
    const wp = (id, name, lng, lat) => ({
      poi: { id, name, coord: { lng, lat, crs: 'WGS84' }, category: '测试', tags: {} },
      day: 1,
    })
    localStorage.setItem(
      'bike-travel:trips',
      JSON.stringify({ title: '验证行程', waypoints: [wp('a', '点A', 121.4737, 31.2304), wp('b', '点B', 121.49, 31.2469)] }),
    )
    const pts = []
    const t0 = Date.now()
    for (let i = 0; i < 20; i++) {
      pts.push({ lng: 121.47 + i * 0.001, lat: 31.23 + i * 0.0008, t: t0 + i * 1000, hr: 120 + (i % 5) })
    }
    const track = { id: 'ride-verify', points: pts, distanceM: 5000, elevationGainM: 40 }
    const saved = { ...track, name: '验证骑行 2026/8/5', savedAt: Date.now() }
    localStorage.setItem('bike-travel:tracks', JSON.stringify([saved]))
  })
  await page.reload({ waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })

  // —— A. PWA 资源 ——
  const manifestLink = await page.$('link[rel="manifest"]')
  ok('PWA: manifest link 存在', !!manifestLink)
  const mft = await page.evaluate(async () => {
    const r = await fetch('/manifest.webmanifest')
    if (!r.ok) return null
    return r.json()
  })
  ok('PWA: /manifest.webmanifest 200 且含 name', mft && typeof mft.name === 'string', mft?.name)
  const sw = await page.evaluate(async () => (await fetch('/sw.js')).status)
  ok('PWA: /sw.js 可达', sw === 200, 'status=' + sw)
  const icon = await page.evaluate(async () => (await fetch('/icon.svg')).status)
  ok('PWA: /icon.svg 可达', icon === 200, 'status=' + icon)

  // —— B. 导航增强 UI（地图 Tab 默认）——
  const mapText = await page.evaluate(() => document.body.innerText)
  ok('导航增强: 路线对比(A/B)区块存在', mapText.includes('路线对比（A/B 双方案）'))
  ok('导航增强: 镜头跟随方向开关存在', mapText.includes('镜头跟随行进方向'))

  // —— C. 离线路由缓存：规划示例路线后 localStorage 应有缓存 ——
  await clickByText(page, 'button', '规划骑行路线（上海示例）')
  await new Promise((r) => setTimeout(r, 4000))
  const cacheKeys = await page.evaluate(() => {
    const raw = localStorage.getItem('bike-travel:routes-cache')
    if (!raw) return 0
    return Object.keys(JSON.parse(raw)).length
  })
  ok('离线缓存: 规划后 routes-cache 写入', cacheKeys >= 1, 'keys=' + cacheKeys)

  // —— D. 行程编辑：注入已在 reload 前完成，直接切到行程 Tab 验证 ↑/↓ 重排 ——
  await clickByText(page, 'button', '行程')
  await new Promise((r) => setTimeout(r, 1500))
  const hasDown = await page.evaluate(() => document.body.innerText.includes('↓'))
  ok('行程编辑: 存在 ↓ 重排控件', hasDown)
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('bike-travel:trips')).waypoints.map((w) => w.poi.name).join(','))
  await clickByText(page, 'a', '↓')
  await new Promise((r) => setTimeout(r, 800))
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('bike-travel:trips')).waypoints.map((w) => w.poi.name).join(','))
  ok('行程编辑: ↓ 点击后顺序改变', before !== after, `${before} -> ${after}`)

  // —— E. 成绩分享卡片：轨迹已在 reload 前注入，切骑行 Tab → 加载 → 生成卡片 ——
  await clickByText(page, 'button', '骑行')
  await new Promise((r) => setTimeout(r, 1200))
  // 点击档案库中的轨迹行加载到回放
  await clickByText(page, 'span', '验证骑行 2026/8/5')
  await new Promise((r) => setTimeout(r, 1000))
  const genBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const b = btns.find((x) => x.textContent.includes('生成成绩卡片'))
    if (b) { b.click(); return true }
    return false
  })
  ok('分享卡片: 生成成绩卡片按钮可用', genBtn)
  await new Promise((r) => setTimeout(r, 800))
  const svgOk = await page.evaluate(() => !!document.getElementById('share-card-svg'))
  ok('分享卡片: SVG 成绩卡已渲染', svgOk)

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
    (sel, t) => {
      const els = [...document.querySelectorAll(sel)]
      return els.find((e) => e.textContent.trim().includes(t)) || null
    },
    selector,
    text,
  )
  const el = handle.asElement()
  if (el) await el.click()
  return !!el
}
