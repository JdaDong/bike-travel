// 途径点骑行导航 E2E：规划 3 站路线 → 校验合并路线/标记/导航 HUD 途径点进度/模拟行进逐站到达
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.BASE || 'http://localhost:5273'

const checks = []
const ok = (n, c) => { checks.push([n, !!c]); console.log((c ? 'PASS' : 'FAIL') + ' - ' + n) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

;(async () => {
const puppeteer = (await import('puppeteer-core')).default

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1100,720'],
})
const page = await browser.newPage()
// 按可见文字点击按钮 / 勾选框（兼容新版 puppeteer 移除的 $x）
const clickByText = (text) =>
  page.evaluate((t) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent || '').includes(t))
    if (b) { b.click(); return true }
    return false
  }, text)
const clickCheckboxByLabel = (label) =>
  page.evaluate((t) => {
    const l = Array.from(document.querySelectorAll('label')).find((x) => (x.textContent || '').includes(t))
    const inp = l && l.querySelector('input[type=checkbox]')
    if (inp) { inp.click(); return true }
    return false
  }, label)
const logs = []
page.on('console', (m) => logs.push(m.text()))
page.on('pageerror', (e) => logs.push('PAGEERROR ' + e.message))

try {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 })
  await page.waitForSelector('input[placeholder*="搜索地点"]', { timeout: 15000 })
  ok('页面与途径点输入框加载', true)

  // 加速模拟导航（仅测试生效）
  await page.evaluate(() => { window.__navFast = true })

  // 依次添加 起点 / 途经点 / 终点（三个相近上海地标，便于快速逐站到达）
  const stops = ['上海人民公园', '上海南京东路步行街', '上海外滩']
  for (let i = 0; i < stops.length; i++) {
    await page.click('input[placeholder*="搜索地点"]', { clickCount: 3 })
    await page.type('input[placeholder*="搜索地点"]', stops[i])
    await page.keyboard.press('Enter')
    await sleep(1500) // 等待地理编码 + 状态更新
  }
  const stopCount = await page.evaluate(() => document.querySelectorAll('.maplibregl-marker').length)
  ok('添加 3 站后地图出现标记（起点/途经点/终点）', stopCount >= 3)

  // 规划途径点路线
  await clickByText('规划途径点路线')
  await sleep(6000) // 逐段规划（每段联网）

  const plan = await page.evaluate(() => ({
    dist: window.__routeDist,
    stops: window.__navStops,
  }))
  ok('合并路线距离 > 0', plan.dist > 0)
  ok('导航上下文记录 3 个停靠点', plan.stops === 3)

  const pinLabels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.maplibregl-marker div')).map((d) => d.textContent || '').filter(Boolean),
  )
  ok('起点标记(🚩)存在', pinLabels.some((t) => t.includes('🚩')))
  ok('标记含「途经点1」', pinLabels.some((t) => t.includes('途经点1')))
  ok('终点标记(🏁)存在', pinLabels.some((t) => t.includes('🏁')))

  await page.screenshot({ path: '/tmp/wp_planned.png' })

  // 勾选模拟导航并开始
  await clickCheckboxByLabel('模拟导航')
  await clickByText('开始导航')
  await sleep(1500)

  const initWp = await page.evaluate(() => window.__navWp)
  ok('导航开始显示途径点进度 1/3', initWp && initWp.idx === 1 && initWp.total === 3)

  // 轮询：模拟行进应逐站推进 idx 直至到达（加速后数秒内完成）
  let lastIdx = 1
  let arrived = false
  for (let i = 0; i < 60; i++) {
    const wp = await page.evaluate(() => window.__navWp)
    const msg = await page.evaluate(() => window.__navMsg)
    if (wp && wp.idx > lastIdx) { lastIdx = wp.idx; console.log('  → 到达进展 idx=' + wp.idx + ' msg=' + msg) }
    if (msg && msg.includes('已到达目的地')) { arrived = true; break }
    await sleep(500)
  }
  ok('模拟行进逐站推进途径点（idx 至少到达 2）', lastIdx >= 2)
  ok('最终到达目的地', arrived)

  // HUD 显示途径点进度文本
  const hudText = await page.evaluate(() => {
    const el = document.querySelector('[style*="bottom"]')
    return document.body.innerText
  })
  ok('HUD/界面含「途经点」字样', hudText.includes('途经点'))

  await page.screenshot({ path: '/tmp/wp_nav.png' })
} catch (e) {
  console.log('ERROR', e.message)
  checks.push(['运行无异常', false])
} finally {
  const passed = checks.filter((c) => c[1]).length
  console.log(`\n=== 途径点导航验证 ${passed}/${checks.length} ===`)
  if (logs.length) console.log('--- page logs (tail) ---\n' + logs.slice(-12).join('\n'))
  await browser.close()
  process.exit(passed === checks.length ? 0 : 1)
}
})()
