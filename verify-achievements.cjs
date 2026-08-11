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

// —— 构造确定性数据集（全部 2026 年，上海）——
// 每条轨迹经度等距东移产生真实几何距离；时间戳按 20km/h 均速铺开，供 bestEffort 计算。
const BASE_LNG = 121.47
const BASE_LAT = 31.23
const STEP_M = 100 // 相邻点间距（米）
const DEG_PER_STEP = STEP_M / (111320 * Math.cos((BASE_LAT * Math.PI) / 180))

function buildTrack(id, startMs, km, ascent, hr, name) {
  const nSeg = km * 10 // 每 100m 一段 → km*10 段（km 为整数则精确）
  const nPts = nSeg + 1
  const speedKmh = 20
  const totalS = (km / speedKmh) * 3600
  const dt = (totalS / nSeg) * 1000
  const ascentPerStep = ascent / nSeg
  const points = []
  for (let i = 0; i < nPts; i++) {
    points.push({
      lng: BASE_LNG + DEG_PER_STEP * i,
      lat: BASE_LAT,
      ele: 10 + ascentPerStep * i,
      t: startMs + Math.round(dt * i),
      ...(hr ? { hr: hr + (i % 10) } : {}),
    })
  }
  return { id, points, distanceM: STEP_M * nSeg, elevationGainM: ascent, name, savedAt: startMs }
}

// 本地时间构造：YYYY,MM(0-based),DD,HH
const ms = (y, mo, d, h) => new Date(y, mo, d, h, 0, 0).getTime()

const TRACKS = [
  // 连续 7 天（1/5–1/11），其中 5 次清晨(5-8点)出发 → 触发 早起鸟 + 七日连骑
  buildTrack('t1', ms(2026, 0, 5, 6), 12, 300, 150, '晨骑 12km'),
  buildTrack('t2', ms(2026, 0, 6, 6), 8, 200, 145, '晨骑 8km'),
  buildTrack('t3', ms(2026, 0, 7, 7), 15, 400, 155, '晨骑 15km'),
  buildTrack('t4', ms(2026, 0, 8, 6), 10, 250, 148, '晨骑 10km'),
  buildTrack('t5', ms(2026, 0, 9, 5), 6, 100, 140, '晨骑 6km'),
  buildTrack('t6', ms(2026, 0, 10, 9), 55, 1200, 160, '崇明环岛 55km'), // 最长单次 + 累计爬升
  buildTrack('t7', ms(2026, 0, 11, 21), 9, 150, 142, '夜骑 9km'), // 夜骑 1 次
  // 另外两个月，丰富月度柱
  buildTrack('t8', ms(2026, 1, 15, 10), 20, 500, 152, '滨江 20km'),
  buildTrack('t9', ms(2026, 2, 20, 10), 18, 450, 150, '郊野 18km'),
]
// 期望值（用于断言）
const EXPECT_TOTAL_M = TRACKS.reduce((a, t) => a + t.distanceM, 0) // 153000
const EXPECT_COUNT = TRACKS.length // 9
const EXPECT_LONGEST_M = Math.max(...TRACKS.map((t) => t.distanceM)) // 55000

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

  // 拦截 /sw.js 与 /api/*，脱离网络依赖（成就功能纯前端，不需要真实接口）
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/sw.js')) return req.respond({ status: 200, contentType: 'text/javascript', body: '// noop' })
    if (u.includes('/api/')) return req.respond({ status: 200, contentType: 'application/json', body: '[]' })
    req.continue()
  })

  // 页面加载前把数据集写入 localStorage，App 挂载时即读入档案库
  await page.evaluateOnNewDocument((tracks) => {
    localStorage.setItem('bike-travel:tracks', JSON.stringify(tracks))
  }, TRACKS)

  await page.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await page.waitForSelector('button', { timeout: 20000 })
  await sleep(1200)

  // 切到「成就」Tab
  await page.click('[data-testid="tab-stats"]')
  await sleep(800)

  // 1) 报告对象存在且数值正确（精确断言纯函数聚合）
  const rep = await page.evaluate(() => window.__report || null)
  check('window.__report 已生成', !!rep)
  check(
    `年度总里程 = ${(EXPECT_TOTAL_M / 1000).toFixed(0)}km`,
    rep && Math.round(rep.aggregate.distanceM) === EXPECT_TOTAL_M,
    rep && Math.round(rep.aggregate.distanceM),
  )
  check(`骑行次数 = ${EXPECT_COUNT}`, rep && rep.aggregate.count === EXPECT_COUNT, rep && rep.aggregate.count)
  check('默认选中年份 = 2026', rep && rep.year === 2026, rep && rep.year)

  // 2) 个人纪录
  check(
    `最长单次 = ${(EXPECT_LONGEST_M / 1000).toFixed(0)}km`,
    rep && Math.round(rep.records.longestRideM) === EXPECT_LONGEST_M,
    rep && Math.round(rep.records.longestRideM),
  )
  check(
    '最快 10km 已计算且均速合理(15-25km/h)',
    rep && rep.records.best10k && rep.records.best10k.speedKmh > 15 && rep.records.best10k.speedKmh < 25,
    rep && rep.records.best10k && rep.records.best10k.speedKmh,
  )

  // 3) 连续打卡：数据是 1 月连续 7 天 → 最长 7 天
  check('最长连续打卡 = 7 天', rep && rep.streaks.longestDays === 7, rep && rep.streaks.longestDays)

  // 4) 徽章：至少解锁 百里挑一/半百单骑/爬升千米/七日连骑/早起鸟 中的多数
  const earned = rep ? rep.badges.filter((b) => b.earned).map((b) => b.id) : []
  check('已解锁徽章 ≥ 4 枚', earned.length >= 4, earned)
  check('解锁「百里挑一」(累计100km)', earned.includes('total_100'))
  check('解锁「半百单骑」(单次50km)', earned.includes('single_50'))
  check('解锁「七日连骑」', earned.includes('streak_7'))
  check('「五百将军」仍未解锁(累计153km<500)', rep && !earned.includes('total_500'))

  // 5) UI 渲染断言
  const ui = await page.evaluate(() => ({
    hasReport: !!document.querySelector('[data-testid="annual-report"]'),
    calCells: document.querySelectorAll('[data-testid="heat-calendar"] rect').length,
    hasRecords: !!document.querySelector('[data-testid="records"]'),
    earnedCells: document.querySelectorAll('[data-testid="badge-earned"]').length,
    lockedCells: document.querySelectorAll('[data-testid="badge-locked"]').length,
  }))
  check('年度报告面板已渲染', ui.hasReport)
  check('热力日历渲染出格子 (>300)', ui.calCells > 300, ui.calCells)
  check('个人纪录区块已渲染', ui.hasRecords)
  check('徽章墙含已解锁与未解锁', ui.earnedCells >= 4 && ui.lockedCells >= 1, `earned=${ui.earnedCells} locked=${ui.lockedCells}`)

  // 6) 生成年度报告卡（SVG→PNG 弹层）
  await page.click('[data-testid="gen-report-card"]')
  await sleep(500)
  const card = await page.evaluate(() => ({
    overlay: !!document.querySelector('[data-testid="report-card"]'),
    svg: !!document.getElementById('annual-card-svg'),
  }))
  check('年度报告卡弹层出现', card.overlay)
  check('报告卡 SVG 存在（可导出 PNG）', card.svg)

  await page.screenshot({ path: '/tmp/achievements_verify.png', fullPage: false })

  // 7) 切「全部时间」年份仍正常
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="report-card"]')
    // 关闭弹层
    const closeBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '关闭')
    closeBtn && closeBtn.click()
  })
  await sleep(200)
  await page.select('[data-testid="year-select"]', 'all')
  await sleep(400)
  const repAll = await page.evaluate(() => window.__report || null)
  check('切「全部时间」后报告仍生成且里程一致', repAll && Math.round(repAll.aggregate.distanceM) === EXPECT_TOTAL_M, repAll && Math.round(repAll.aggregate.distanceM))

  check('无运行期错误', errors.length === 0)
  if (errors.length) console.log('  ⚠️ errors:', errors.slice(0, 4))

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
