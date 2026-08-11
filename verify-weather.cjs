const puppeteer = require('puppeteer-core')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = 'http://localhost:5173'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); pass++ } else { console.log(`  ❌ ${name}`); fail++ }
}

// 网格 mock：7x7=49 单元格，按坐标给平滑变化的温度/空气/降水
function mockField(minLng, minLat, maxLng, maxLat, n) {
  const cells = []
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const fl = n === 1 ? 0.5 : i / (n - 1)
      const fj = n === 1 ? 0.5 : j / (n - 1)
      const lng = minLng + fl * (maxLng - minLng)
      const lat = minLat + fj * (maxLat - minLat)
      cells.push({
        lng: +lng.toFixed(5),
        lat: +lat.toFixed(5),
        tempC: +(18 + 8 * Math.sin(fl * 3) + 4 * Math.cos(fj * 2)).toFixed(1),
        aqi: Math.round(40 + 120 * fj + 30 * fl),
        precipMm: +(fl * 6).toFixed(1),
        windKmh: Math.round(8 + 10 * fl),
      })
    }
  }
  return cells
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  // 拦截 /api/weather* 与 /sw.js，mock 返回（脱离外部依赖，确定性验证）
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/sw.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: '// noop' })
    if (u.includes('/api/weather/field')) {
      const q = new URL(u).searchParams
      const cells = mockField(+q.get('minLng'), +q.get('minLat'), +q.get('maxLng'), +q.get('maxLat'), +q.get('n'))
      return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ cells }) })
    }
    if (u.includes('/api/weather?')) {
      return req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tempC: 22.5, humidity: 65, precipMm: 0, windKmh: 12, windDeg: 200,
          code: 1, aqi: 58, pm25: 18, pm10: 32, label: '大致晴朗',
        }),
      })
    }
    if (u.includes('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '[]' })
    req.continue()
  })

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })
  await sleep(1500)

  // 1) 开启环境图层
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const b = btns.find((x) => x.textContent.includes('开启环境图层'))
    b && b.click()
  })
  await sleep(2000)
  const afterOn = await page.evaluate(() => ({
    msg: document.body.innerText,
    hasLayer: !!(window.__map && window.__map.getLayer && window.__map.getLayer('weather-cells-l')),
    hasSource: !!(window.__map && window.__map.getSource && window.__map.getSource('weather-cells')),
  }))
  check('开启后 envMsg 含采样点', /已加载\s*\d+\s*个采样点/.test(afterOn.msg))
  check('地图出现 weather-cells 圆层', afterOn.hasLayer)
  check('地图出现 weather-cells 数据源', afterOn.hasSource)
  check('中心天气卡片出现', afterOn.msg.includes('中心天气'))
  check('温度图例出现', afterOn.msg.includes('°C'))

  // 2) 切到空气质量
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '空气质量')
    b && b.click()
  })
  await sleep(1200)
  const afterAqi = await page.evaluate(() => document.body.innerText)
  check('切空气质量后提示更新', afterAqi.includes('空气质量'))
  check('AQI 图例出现', afterAqi.includes('优 0') && afterAqi.includes('危 300'))

  // 3) 切到降水
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '降水')
    b && b.click()
  })
  await sleep(1200)
  const afterP = await page.evaluate(() => document.body.innerText)
  check('切降水后提示更新', afterP.includes('降水'))

  await page.screenshot({ path: '/tmp/weather_verify.png' })

  // 4) 关闭图层
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('关闭环境图层'))
    b && b.click()
  })
  await sleep(1200)
  const afterOff = await page.evaluate(() => ({
    msg: document.body.innerText,
    hasLayer: !!(window.__map && window.__map.getLayer && window.__map.getLayer('weather-cells-l')),
  }))
  check('关闭后图层移除', !afterOff.hasLayer)
  check('关闭后按钮回到开启态', afterOff.msg.includes('开启环境图层'))

  check('无运行期错误', errors.length === 0)
  if (errors.length) console.log('  ⚠️ errors:', errors.slice(0, 3))

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('FATAL', e); process.exit(2) })
