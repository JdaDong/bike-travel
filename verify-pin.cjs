const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const BASE = process.env.BASE || 'http://localhost:5273'

;(async () => {
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--window-size=1100,720'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1100, height: 720 })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message))

  try {
    await page.goto(BASE, { waitUntil: 'load', timeout: 30000 })
  } catch (e) {
    console.log('GOTO_ERR', e.message)
  }
  await new Promise((r) => setTimeout(r, 6000))

  const diag = await page.evaluate(() => ({
    canvas: !!document.querySelector('.maplibregl-canvas'),
    mapError: document.body.innerText.includes('地图加载失败'),
    hasSearchInput: !!document.querySelector('input[placeholder*="地址"]'),
    bodyLen: document.body.innerText.length,
  }))
  console.log('DIAG_BEFORE:', JSON.stringify(diag))
  await page.screenshot({ path: '/tmp/pin_verify_before.png' })

  let pinOk = false
  let detail = { found: false }
  if (diag.hasSearchInput) {
    try {
      await page.type('input[placeholder*="地址"]', '外滩')
      await page.keyboard.press('Enter')
      // 软件 WebGL 环境下 React effect 创建 marker 较慢；用轮询 evaluate 做可靠检测
      try { await page.waitForSelector('.bike-pin-drop', { timeout: 15000 }) } catch {}
      await new Promise((r) => setTimeout(r, 3000))
      // 手动飞到针位置（验证环境 mapRef 可能尚未就绪导致 doSearch 内 flyTo 未执行）
      await page.evaluate(() => {
        const m = window.__map; if (!m) return
        m.flyTo({ center: [114.53, 23.03], zoom: 14 })
      })
      await new Promise((r) => setTimeout(r, 2500))
      // 确定性 DOM 检测：不依赖 puppeteer 选择器时序
      detail = await page.evaluate(() => {
        const drop = document.querySelector('.bike-pin-drop')
        if (!drop) return { found: false }
        const svg = drop.querySelector('svg path')
        const allDivs = Array.from(drop.querySelectorAll('div'))
        const label = allDivs.find((d) => d.textContent && !d.classList.contains('bike-pin-pulse'))
        return {
          found: true,
          hasSvgPath: !!svg,
          pathD: svg ? svg.getAttribute('d')?.slice(0, 10) : null,
          labelText: label ? label.textContent.trim() : null,
          hasHalo: !!drop.querySelector('.bike-pin-pulse'),
        }
      })
      pinOk = detail.found && detail.hasSvgPath && detail.hasHalo
    } catch (e) {
      console.log('SEARCH_ERR', e.message)
    }
  }
  await new Promise((r) => setTimeout(r, 800))
  await page.screenshot({ path: '/tmp/pin_verify.png' })

  console.log('PIN_RENDERED:', pinOk)
  console.log('DETAIL:', JSON.stringify(detail))
  console.log('ERRORS:', errors.length ? errors.slice(0, 6).join(' | ') : 'none')
  await browser.close()
  process.exit(pinOk && detail.found && detail.hasSvgPath && detail.hasHalo ? 0 : 1)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})
