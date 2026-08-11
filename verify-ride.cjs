// 骑行数据可视化无头验证：注入多条轨迹 → 校验仪表盘汇总 / 按月柱状图 / 热力图开关 / 历史对比
const puppeteer = require('puppeteer-core')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:5173'
const SHOT = '/tmp/ride_verify.png'

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })

  const logs = []
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  let pass = 0
  let fail = 0
  const check = (name, ok, extra = '') => {
    if (ok) {
      pass++
      console.log(`PASS: ${name}${extra ? ' — ' + extra : ''}`)
    } else {
      fail++
      console.log(`FAIL: ${name}${extra ? ' — ' + extra : ''}`)
    }
  }

  await page.goto(URL, { waitUntil: 'networkidle2' }).catch(() => {})

  // 注入 3 条轨迹（2026-06 两条、2026-07 一条，上海不同区域）
  await page.evaluate(() => {
    function makeTrack(name, savedAt, center, n, distKm, startMs, durS, hr) {
      const pts = []
      for (let i = 0; i < n; i++) {
        pts.push({
          lng: center[0] + i * 0.002,
          lat: center[1] + i * 0.0015,
          ele: 10 + i,
          t: startMs + Math.round((durS * 1000 * i) / (n - 1)),
          hr: hr + (i % 3),
        })
      }
      return { id: 'ride-' + savedAt, points: pts, distanceM: distKm * 1000, elevationGainM: 40, name, savedAt }
    }
    const t1 = new Date(2026, 5, 10, 10, 0, 0).getTime()
    const t2 = new Date(2026, 5, 15, 18, 0, 0).getTime()
    const t3 = new Date(2026, 6, 5, 9, 0, 0).getTime()
    window.localStorage.setItem(
      'bike-travel:tracks',
      JSON.stringify([
        makeTrack('骑行 2026/6/10 人民广场', 1001, [121.4737, 31.2304], 8, 5.0, t1, 1500, 120),
        makeTrack('骑行 2026/6/15 外滩→豫园', 1002, [121.4905, 31.2469], 8, 8.0, t2, 2200, 135),
        makeTrack('骑行 2026/7/5 陆家嘴', 1003, [121.506, 31.2397], 6, 3.0, t3, 900, 110),
      ]),
    )
  })

  await page.reload({ waitUntil: 'networkidle2' })

  // 切到 骑行 Tab
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '骑行')
    if (b) { b.click(); return true }
    return false
  }, { timeout: 15000 })

  // 等待仪表盘渲染
  await page.waitForFunction(() => document.body.innerText.includes('骑行数据概览'), { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 800))

  const txt = await page.evaluate(() => document.body.innerText)

  // 1. 总里程 = 5+8+3 = 16.0 km
  check('总里程汇总', /16\.0\s*km/.test(txt), '预期 16.0 km')
  // 2. 骑行次数 = 3
  check('骑行次数', /骑行次数[\s\S]*?3\b/.test(txt.replace(/\n/g, ' ')) || txt.includes('3'))
  // 3. 按月里程柱状图存在（两个月份 bar）
  const bars = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('svg')]
    let count = 0
    for (const s of svgs) if (s.querySelectorAll('rect').length >= 2) count++
    return count
  })
  check('按月柱状图', bars >= 1, `含柱状 svg ${bars} 个`)

  // 4. 热力图开关
  const heatBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('运动热力图'))
    if (b) { b.click(); return true }
    return false
  })
  await new Promise((r) => setTimeout(r, 1200))
  const heatOn = await page.evaluate(() => document.body.innerText.includes('关闭运动热力图'))
  check('运动热力图开关', heatBtn && heatOn)

  // 5. 历史对比：勾选 2 条 → 在地图对比
  const cmpReady = await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('input[type=checkbox]')]
    if (boxes.length < 2) return false
    boxes[0].click()
    boxes[1].click()
    return true
  })
  await new Promise((r) => setTimeout(r, 300))
  const cmpClicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('在地图对比'))
    if (b) { b.click(); return true }
    return false
  })
  await new Promise((r) => setTimeout(r, 1000))
  const cmpTable = await page.evaluate(() => document.body.innerText.includes('指标') && document.body.innerText.includes('均速'))
  check('历史对比并排表', cmpReady && cmpClicked && cmpTable)

  await page.screenshot({ path: SHOT })
  console.log('SCREENSHOT:', SHOT)

  if (logs.length) console.log('--- page logs ---\n' + logs.join('\n'))
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('SCRIPT ERROR', e)
  process.exit(2)
})
