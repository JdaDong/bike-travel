const puppeteer = require('puppeteer-core')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const APP_URL = 'http://localhost:5173'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ✅ ${name}`)
    pass++
  } else {
    console.log(`  ❌ ${name}`)
    fail++
  }
}

// 预设绕圈轨迹（上海人民广场附近，WGS-84），每 200ms 注入一个点
const TRACK = [
  [121.4737, 31.2304],
  [121.4741, 31.2307],
  [121.4745, 31.2311],
  [121.4749, 31.2315],
  [121.4753, 31.2319],
  [121.4757, 31.2323],
  [121.4761, 31.2327],
  [121.4765, 31.2331],
  [121.4769, 31.2335],
  [121.4773, 31.2339],
]

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

  // 拦截外部请求：/api/* 与 /sw.js mock，脱离网络依赖
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/sw.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: '// noop' })
    if (u.includes('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '[]' })
    req.continue()
  })

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })
  await sleep(1500)

  // 切到「骑行」Tab（录制面板在该 Tab）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '骑行')
    b && b.click()
  })
  await sleep(800)

  // 注入 geolocation mock：持续推送预设轨迹；clearWatch 时停止推送（模拟暂停）
  await page.evaluate((pts) => {
    let i = 0
    let timer = null
    const cbs = []
    const tick = () => {
      if (i >= pts.length) {
        if (timer) {
          clearInterval(timer)
          timer = null
        }
        return
      }
      const [lng, lat] = pts[i++]
      const pos = {
        coords: { longitude: lng, latitude: lat, accuracy: 5, heading: 0, altitude: 10, speed: 5 },
        timestamp: Date.now(),
      }
      cbs.slice().forEach((cb) => cb(pos))
    }
    const watch = (ok) => {
      cbs.push(ok)
      if (!timer) timer = setInterval(tick, 200)
      return cbs.length
    }
    const clear = () => {
      cbs.length = 0
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
    const cur = (ok) => ok({ coords: { longitude: pts[0][0], latitude: pts[0][1], accuracy: 5 }, timestamp: Date.now() })
    Object.defineProperty(navigator, 'geolocation', {
      value: { watchPosition: watch, clearWatch: clear, getCurrentPosition: cur },
      configurable: true,
    })
    window.prompt = () => '验证骑行' // 停止命名弹窗，避免阻塞
  }, TRACK)

  // 1) 开始记录
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '开始记录')
    b && b.click()
  })
  await sleep(2200) // 注入约 10 个点

  const afterStart = await page.evaluate(() => ({
    hasLine: !!(window.__map && window.__map.getLayer && window.__map.getLayer('live-track-l')),
    hasHud: !!document.querySelector('[data-testid="rec-hud"]'),
    hudText: (document.querySelector('[data-testid="rec-hud"]') || {}).innerText || '',
    points: window.__recPoints || 0,
  }))
  check('开始录制后地图出现 live-track 轨迹线', afterStart.hasLine)
  check('地图出现录制 HUD', afterStart.hasHud)
  check('HUD 含距离(km)数据', afterStart.hudText.includes('km'))
  check('实时轨迹点数已累积 (>1)', afterStart.points > 1)
  const pointsRunning = afterStart.points

  // 2) 暂停：观察点数是否冻结
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '暂停')
    b && b.click()
  })
  await sleep(400)
  const p1 = await page.evaluate(() => window.__recPoints || 0)
  await sleep(1600)
  const p2 = await page.evaluate(() => window.__recPoints || 0)
  check('暂停后轨迹点数冻结（不增长）', p1 === p2)
  check('暂停后仍保留已录制的点', p2 === pointsRunning)

  // 3) 继续：恢复推送
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '继续')
    b && b.click()
  })
  await sleep(1000)

  // 4) 停止并保存：应触发命名入库
  const before = await page.evaluate(() => {
    const raw = localStorage.getItem('bike-travel:tracks')
    return raw ? JSON.parse(raw).length : 0
  })
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '停止')
    b && b.click()
  })
  await sleep(1200)

  const after = await page.evaluate(() => {
    const raw = localStorage.getItem('bike-travel:tracks')
    const arr = raw ? JSON.parse(raw) : []
    return { count: arr.length, hasHud: !!document.querySelector('[data-testid="rec-hud"]'), last: arr[0] || null }
  })
  check('停止后档案库骑行数 +1', after.count === before + 1)
  check('入库轨迹含命名', !!after.last && typeof after.last.name === 'string' && after.last.name.length > 0)
  check('停止后录制 HUD 消失', !after.hasHud)

  await page.screenshot({ path: '/tmp/record_verify.png' })
  check('无运行期错误', errors.length === 0)
  if (errors.length) console.log('  ⚠️ errors:', errors.slice(0, 3))

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
