// 云同步端到端验证：真实后端（:3000）+ 真实前端（:5173），不 mock 任何认证/同步接口。
// 用两个独立浏览器上下文模拟「两台设备」（localStorage 互相隔离），验证：
//   注册 → 上传 → 换设备登录 → 数据恢复 → 一端删除 → 另一端不复活（墓碑生效）→ 退出登录
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
    console.log(`  ❌ ${name}${extra !== undefined ? ` （实际: ${JSON.stringify(extra)}）` : ''}`)
    fail++
  }
}

const USER = 'e2e_' + Date.now().toString(36)
const PASS = 'test123456'

// 造两条本地轨迹（结构与 SavedTrack 一致）
function mkTrack(i) {
  const t0 = Date.now() - i * 3600_000
  const points = Array.from({ length: 20 }, (_, k) => ({
    lng: 121.47 + i * 0.002 + k * 0.0002,
    lat: 31.23 + k * 0.0002,
    ele: 10 + k * 0.2,
    t: t0 + k * 5000,
  }))
  return {
    id: `e2e-${i}`,
    points,
    distanceM: 1000 + i * 500,
    elevationGainM: 12,
    name: `E2E 轨迹 ${i}`,
    savedAt: t0,
  }
}

// 只拦 /sw.js（避免 Service Worker 缓存干扰），其余（含 /api/*）走真实链路
async function prepare(page) {
  await page.setViewport({ width: 1280, height: 900 })
  await page.setRequestInterception(true)
  page.on('request', (req) => {
    if (req.url().includes('/sw.js')) {
      return req.respond({ status: 200, contentType: 'text/javascript', body: '// noop' })
    }
    req.continue()
  })
}

// 轮询等待页面内条件成立
async function waitFor(page, fn, arg, timeout = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (await page.evaluate(fn, arg)) return true
    } catch {
      /* 页面正在跳转，忽略 */
    }
    await sleep(300)
  }
  return false
}

const clickTab = (page, id) => page.click(`[data-testid="${id}"]`)

async function fillAuth(page, mode) {
  // 注册模式需先切 chip（默认是登录）
  if (mode === 'register') {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '注册')
      b && b.click()
    })
    await sleep(200)
  }
  await page.type('[data-testid="cloud-name"]', USER)
  await page.type('[data-testid="cloud-pass"]', PASS)
  await page.click('[data-testid="cloud-submit"]')
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1280,900'],
  })
  const errors = []
  // 验证过程中会**故意**发起被拒绝的请求（非法 token / 已吊销 token）来断言鉴权行为，
  // 这些预期内的失败不应计入"运行期错误"。用开关圈定预期区间，避免噪音掩盖真实缺陷。
  let expectingErrors = false
  const trackErrors = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`[${tag}] ${e}`))
    p.on('console', (m) => {
      if (m.type() === 'error' && !expectingErrors) errors.push(`[${tag}] ${m.text()}`)
    })
  }

  // ========== 设备 A ==========
  console.log(`\n— 设备 A：注册 ${USER} 并上传本地数据 —`)
  const pageA = await browser.newPage()
  trackErrors(pageA, 'A')
  await prepare(pageA)
  await pageA.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await pageA.waitForSelector('[data-testid="tab-cloud"]', { timeout: 20000 })

  // 预置本地数据后刷新，让 App 从 localStorage 载入（模拟"本机已有骑行记录"）
  await pageA.evaluate((tracks) => {
    localStorage.setItem('bike-travel:tracks', JSON.stringify(tracks))
    localStorage.setItem(
      'bike-travel:trips',
      JSON.stringify({ title: 'E2E 行程', waypoints: [], updatedAt: Date.now() }),
    )
  }, [mkTrack(1), mkTrack(2)])
  await pageA.reload({ waitUntil: 'networkidle2' })
  await pageA.waitForSelector('[data-testid="tab-cloud"]', { timeout: 20000 })
  await sleep(600)

  await clickTab(pageA, 'tab-cloud')
  await pageA.waitForSelector('[data-testid="cloud-panel"]', { timeout: 10000 })
  check('云端 Tab 渲染出面板', true)

  await fillAuth(pageA, 'register')
  const loggedInA = await waitFor(pageA, () => !!(window.__cloud && window.__cloud.loggedIn))
  check('注册成功并进入登录态', loggedInA)

  const syncedA = await waitFor(pageA, () => window.__cloud && window.__cloud.cloudTracks === 2)
  const stateA = await pageA.evaluate(() => ({ ...window.__cloud }))
  check('登录后自动同步：云端轨迹数 = 2', syncedA, stateA)
  check('面板显示用户名', (await pageA.$eval('[data-testid="cloud-user"]', (e) => e.textContent)) === USER)

  // 直接查服务端，确认数据真的落到了后端（而非仅前端状态）
  const serverSide = await pageA.evaluate(async () => {
    const auth = JSON.parse(localStorage.getItem('bike-travel:auth'))
    const r = await fetch('/api/sync', { headers: { authorization: `Bearer ${auth.token}` } })
    const j = await r.json()
    return { status: r.status, tracks: j.tracks.length, trip: j.trip && j.trip.title }
  })
  check('服务端 GET /api/sync 返回 2 条轨迹', serverSide.tracks === 2, serverSide)
  check('服务端同时保存了行程文档', serverSide.trip === 'E2E 行程', serverSide)

  // ========== 设备 B ==========
  console.log('\n— 设备 B：全新环境登录同一账号 —')
  const ctxB = browser.createBrowserContext
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext()
  const pageB = await ctxB.newPage()
  trackErrors(pageB, 'B')
  await prepare(pageB)
  await pageB.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await pageB.waitForSelector('[data-testid="tab-cloud"]', { timeout: 20000 })

  const freshB = await pageB.evaluate(() => localStorage.getItem('bike-travel:tracks'))
  check('设备 B 初始为空环境（无本地轨迹）', !freshB, freshB)

  await clickTab(pageB, 'tab-cloud')
  await pageB.waitForSelector('[data-testid="cloud-panel"]', { timeout: 10000 })
  await fillAuth(pageB, 'login')

  const restored = await waitFor(pageB, () => window.__cloud && window.__cloud.localTracks === 2)
  const stateB = await pageB.evaluate(() => ({ ...window.__cloud }))
  check('设备 B 登录后拉回 2 条轨迹', restored, stateB)

  const lsB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('bike-travel:tracks') || '[]'))
  check('设备 B 轨迹已落本地存储（换设备可离线用）', lsB.length === 2, lsB.length)
  check('轨迹内容完整（含名称与轨迹点）', !!lsB[0] && lsB[0].points.length === 20 && !!lsB[0].name)

  // ========== 删除墓碑跨设备生效 ==========
  console.log('\n— 设备 B 删除一条，验证不会被设备 A 回灌 —')
  await clickTab(pageB, 'tab-ride')
  await sleep(500)
  await pageB.evaluate(() => {
    const a = [...document.querySelectorAll('a')].find((x) => x.textContent.trim() === '删')
    a && a.click()
  })
  await sleep(400)
  const afterDel = await pageB.evaluate(
    () => JSON.parse(localStorage.getItem('bike-travel:tracks') || '[]').length,
  )
  check('设备 B 本地删除后剩 1 条', afterDel === 1, afterDel)

  const tomb = await pageB.evaluate(() =>
    JSON.parse(localStorage.getItem('bike-travel:deleted-tracks') || '[]'),
  )
  check('删除写入墓碑记录', Array.isArray(tomb) && tomb.length === 1, tomb)

  // 自动同步（4s 轮询侦测到签名变化）把删除推送到云端
  const pushedDel = await waitFor(pageB, () => window.__cloud && window.__cloud.cloudTracks === 1, null, 25000)
  check('删除已自动同步到云端（云端剩 1 条）', pushedDel, await pageB.evaluate(() => ({ ...window.__cloud })))

  // 设备 A 手动同步：本地仍有 2 条，但被删的那条不应复活
  await clickTab(pageA, 'tab-cloud')
  await sleep(300)
  await pageA.click('[data-testid="cloud-sync"]')
  const aConverged = await waitFor(pageA, () => window.__cloud && window.__cloud.localTracks === 1)
  const lsA = await pageA.evaluate(() => JSON.parse(localStorage.getItem('bike-travel:tracks') || '[]'))
  check('设备 A 同步后收敛为 1 条（删除生效，未复活）', aConverged && lsA.length === 1, lsA.length)

  // ========== 退出登录 ==========
  console.log('\n— 退出登录：清登录态但保留本地数据 —')
  await clickTab(pageB, 'tab-cloud')
  await sleep(300)
  // 记下退出前的 token，用于验证服务端确实吊销了它（而非只清了本地）
  const tokenB = await pageB.evaluate(() => JSON.parse(localStorage.getItem('bike-travel:auth')).token)
  await pageB.click('[data-testid="cloud-logout"]')
  await sleep(800)
  const outB = await pageB.evaluate(() => ({
    loggedIn: !!(window.__cloud && window.__cloud.loggedIn),
    auth: localStorage.getItem('bike-travel:auth'),
    tracks: JSON.parse(localStorage.getItem('bike-travel:tracks') || '[]').length,
  }))
  check('退出后登录态清除', !outB.loggedIn && (outB.auth === null || outB.auth === 'null'), outB)
  check('退出后本地数据保留（不清空）', outB.tracks === 1, outB.tracks)

  // 以下两个请求预期被拒，暂时关闭错误统计
  expectingErrors = true
  // 回归：曾因 logout 请求带 json 头却无 body 被 Fastify 400 拒绝，
  // 导致服务端 token 从未吊销（前端假装已退出）。此断言守住该缺陷。
  const revoked = await pageB.evaluate(async (t) => {
    const r = await fetch('/api/sync', { headers: { authorization: `Bearer ${t}` } })
    return r.status
  }, tokenB)
  check('退出后旧 token 已被服务端吊销（401）', revoked === 401, revoked)

  const badToken = await pageB.evaluate(async () => {
    const r = await fetch('/api/sync', { headers: { authorization: 'Bearer not-a-real-token' } })
    return r.status
  })
  check('非法 token 访问 /api/sync 返回 401', badToken === 401, badToken)
  await sleep(300)
  expectingErrors = false

  await clickTab(pageA, 'tab-cloud')
  await sleep(500)
  await pageA.screenshot({ path: '/tmp/cloud_verify.png' })

  check('无运行期错误', errors.length === 0)
  if (errors.length) console.log('  ⚠️ errors:', errors.slice(0, 5))

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
