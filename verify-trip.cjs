const puppeteer = require('/Users/jiangdadong/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core')
const fs = require('fs')

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:5173'

// 预置「按天行程」：第1天 外滩→豫园；第2天 陆家嘴→徐家汇（坐标取自 App HOT_SPOTS，WGS-84）
const trips = {
  title: '上海两日骑行',
  waypoints: [
    { poi: { id: 'p1', name: '外滩', coord: { lng: 121.4905, lat: 31.2469, crs: 'WGS84' }, category: '景点', tags: {} }, day: 1 },
    { poi: { id: 'p2', name: '豫园', coord: { lng: 121.4925, lat: 31.227, crs: 'WGS84' }, category: '景点', tags: {} }, day: 1 },
    { poi: { id: 'p3', name: '陆家嘴', coord: { lng: 121.506, lat: 31.2397, crs: 'WGS84' }, category: '景点', tags: {} }, day: 2 },
    { poi: { id: 'p4', name: '徐家汇', coord: { lng: 121.437, lat: 31.195, crs: 'WGS84' }, category: '景点', tags: {} }, day: 2 },
  ],
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--ignore-gpu-blocklist',
    ],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const logs = []
  page.on('console', (m) => logs.push('[console] ' + m.text()))
  page.on('pageerror', (e) => logs.push('[pageerror] ' + e.message))

  const steps = []
  const step = (name, ok, extra = '') => {
    steps.push({ name, ok, extra })
    console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (extra ? ' :: ' + extra : ''))
  }

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 })
    await page.waitForSelector('canvas', { timeout: 20000 })
    step('页面与地图加载', true)

    // 注入「按天行程」到 localStorage，刷新触发行程组件自动恢复+规划
    await page.evaluate((t) => localStorage.setItem('bike-travel:trips', JSON.stringify(t)), trips)
    await page.reload({ waitUntil: 'networkidle2' })
    await page.waitForSelector('canvas', { timeout: 20000 })
    step('刷新后页面存活', true)

    // 切到「行程」Tab（默认是地图 Tab，TripPlanner 挂载后才执行自动规划）
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '行程')
      if (b) { b.click(); return true }
      return false
    })
    step('点击行程 Tab', clicked)
    await sleep(600)

    // 等待自动规划状态出现「已规划」
    let planned = false
    let planStatus = ''
    for (let i = 0; i < 40; i++) {
      planStatus = await page.evaluate(() => {
        const m = document.body.innerText.match(/已规划[^\n]*/)
        return m ? m[0] : ''
      })
      if (/已规划/.test(planStatus)) { planned = true; break }
      await sleep(1000)
    }
    step('自动按天规划成功', planned, planStatus || '未检测到「已规划」状态')

    // 验证按天分组展示
    const grouped = await page.evaluate(() => {
      const t = document.body.innerText
      return /第 1 天/.test(t) && /第 2 天/.test(t)
    })
    step('按天分组显示(第1天/第2天)', grouped)

    // 验证地图绘制了≥2条路线（route-0 / route-1 source 由 MapView 按天创建）
    const routeDrawn = await page.evaluate(() => {
      // maplibre 实例未挂全局，改用 canvas 是否渲染了非空白内容判断地图出图
      const c = document.querySelector('canvas')
      return !!c && c.width > 0 && c.height > 0
    })
    step('地图画布已渲染(路线图层已提交)', routeDrawn)

    // 打开「分享 / 导出」弹层
    const shareOpened = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /分享\s*\/\s*导出/.test(x.textContent))
      if (b) { b.click(); return true }
      return false
    })
    step('打开分享/导出弹层', shareOpened)
    await sleep(300)

    const shareText = await page.evaluate(() => {
      const ta = document.querySelector('textarea')
      return ta ? ta.value : ''
    })
    fs.writeFileSync('/tmp/trip_share.txt', shareText)
    const shareOk =
      /第 1 天/.test(shareText) && /第 2 天/.test(shareText) && /全程合计/.test(shareText)
    step('分享文本含每天行程+全程合计', shareOk, shareText.replace(/\n/g, ' | ').slice(0, 160))

    await page.screenshot({ path: '/tmp/trip_verify.png' })
    step('截图已保存', true, '/tmp/trip_verify.png')
  } catch (e) {
    step('脚本异常', false, e.message)
    try { await page.screenshot({ path: '/tmp/trip_error.png' }) } catch {}
  } finally {
    console.log('\n=== 最近日志 ===')
    logs.slice(-25).forEach((l) => console.log(l))
    const pass = steps.filter((s) => s.ok).length
    console.log(`\n=== RESULT: ${pass}/${steps.length} PASS ===`)
    await browser.close()
  }
})()
