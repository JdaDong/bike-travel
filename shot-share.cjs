const puppeteer = require('puppeteer-core')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL = 'http://localhost:5173'

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--disable-gpu'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })
  await page.evaluate(() => {
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
  await clickByText(page, 'button', '骑行')
  await new Promise((r) => setTimeout(r, 1200))
  await clickByText(page, 'span', '验证骑行 2026/8/5')
  await new Promise((r) => setTimeout(r, 1000))
  await clickByText(page, 'button', '生成成绩卡片')
  await new Promise((r) => setTimeout(r, 1000))
  await page.screenshot({ path: '/tmp/share_card.png' })
  await browser.close()
  console.log('shot saved: /tmp/share_card.png')
})().catch((e) => { console.error(e); process.exit(2) })

async function clickByText(page, selector, text) {
  const handle = await page.evaluateHandle(
    (sel, t) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t)) || null,
    selector, text,
  )
  const el = handle.asElement()
  if (el) await el.click()
  return !!el
}
