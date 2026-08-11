// 结伴骑行端到端验证：真实后端(:3000, 含 WebSocket) + 真实前端(:5173)，不 mock 任何链路。
// 两个独立浏览器上下文模拟「两台设备/两位骑友」，验证：
//   各自注册登录 → 加入同一房间 → 互相看到实时位置（WebSocket 广播）→ 地图出现队友标记
//   → 队伍聚散分析 → 一方离开另一方感知 → 非法 token 握手被拒。
// puppeteer-core 为 ESM，.cjs 里用动态 import 加载
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

const TS = Date.now().toString(36)
const ROOM = 'e2e' + TS // normalizeRoom 允许字母数字连字符
const USER_A = 'ga' + TS
const USER_B = 'gb' + TS
const PASS = 'test123456'
const POS_A = { lng: 121.5, lat: 31.24 } // 设备 A 上报位置
const POS_B = { lng: 121.48, lat: 31.23 } // 设备 B 上报位置

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

async function waitFor(page, fn, arg, timeout = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      if (await page.evaluate(fn, arg)) return true
    } catch {
      /* 页面跳转中，忽略 */
    }
    await sleep(250)
  }
  return false
}

const clickTab = (page, id) => page.click(`[data-testid="${id}"]`)

// 通过 REST 注册并把登录态写入 localStorage，reload 后 App 即处于已登录态
async function registerAndLogin(page, name, password) {
  const user = await page.evaluate(
    async (n, p) => {
      const r = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: n, password: p }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || 'register failed')
      localStorage.setItem('bike-travel:auth', JSON.stringify({ token: j.token, user: j.user }))
      return j.user
    },
    name,
    password,
  )
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-testid="tab-group"]', { timeout: 20000 })
  await waitFor(page, () => !!window.__group)
  return user
}

;(async () => {
  const puppeteer = (await import('puppeteer-core')).default
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--window-size=1280,900'],
  })
  const errors = []
  let expectingErrors = false
  const trackErrors = (p, tag) => {
    p.on('pageerror', (e) => errors.push(`[${tag}] ${e}`))
    p.on('console', (m) => {
      if (m.type() === 'error' && !expectingErrors) errors.push(`[${tag}] ${m.text()}`)
    })
  }

  // ========== 设备 A ==========
  console.log(`\n— 设备 A：注册 ${USER_A} 并加入房间 ${ROOM} —`)
  const pageA = await browser.newPage()
  trackErrors(pageA, 'A')
  await prepare(pageA)
  await pageA.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await pageA.waitForSelector('[data-testid="tab-group"]', { timeout: 20000 })
  const userA = await registerAndLogin(pageA, USER_A, PASS)
  check('设备 A 登录成功且结伴接口就绪', !!userA && !!(await pageA.evaluate(() => !!window.__group)))

  await clickTab(pageA, 'tab-group')
  await pageA.waitForSelector('[data-testid="group-panel"]', { timeout: 10000 })
  check('设备 A 结伴面板渲染', true)

  await pageA.evaluate((room) => window.__group.join(room), ROOM)
  const aOpen = await waitFor(pageA, () => window.__group.status === 'open')
  check('设备 A 连接 WebSocket 成功（status=open）', aOpen, await pageA.evaluate(() => window.__group.status))
  const aSelf = await waitFor(pageA, () => window.__group.members().length >= 1)
  check('设备 A 收到 welcome（成员含本人）', aSelf, await pageA.evaluate(() => window.__group.members().length))

  // ========== 设备 B ==========
  console.log(`\n— 设备 B：全新环境注册 ${USER_B} 并加入同一房间 —`)
  const ctxB = browser.createBrowserContext
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext()
  const pageB = await ctxB.newPage()
  trackErrors(pageB, 'B')
  await prepare(pageB)
  await pageB.goto(APP_URL, { waitUntil: 'networkidle2', timeout: 60000 })
  await pageB.waitForSelector('[data-testid="tab-group"]', { timeout: 20000 })
  const userB = await registerAndLogin(pageB, USER_B, PASS)
  check('设备 B 登录成功', !!userB && userB.id !== userA.id)

  await clickTab(pageB, 'tab-group')
  await pageB.waitForSelector('[data-testid="group-panel"]', { timeout: 10000 })
  await pageB.evaluate((room) => window.__group.join(room), ROOM)
  const bOpen = await waitFor(pageB, () => window.__group.status === 'open')
  check('设备 B 连接 WebSocket 成功', bOpen)

  // B 的欢迎快照应包含 A（A 先在房间里）
  const bSees2 = await waitFor(pageB, () => window.__group.members().length === 2)
  check('设备 B 快照看到 2 名成员（含设备 A）', bSees2, await pageB.evaluate(() => window.__group.members().length))

  // A 应实时收到 B 的加入广播
  const aSees2 = await waitFor(pageA, () => window.__group.members().length === 2)
  check('设备 A 实时收到「B 加入」广播（成员=2）', aSees2, await pageA.evaluate(() => window.__group.members().length))

  // ========== 位置共享（核心）==========
  console.log('\n— 双方上报位置，验证跨设备实时可见 —')
  await pageA.evaluate((p) => window.__group.sendPos(p.lng, p.lat), POS_A)
  await pageB.evaluate((p) => window.__group.sendPos(p.lng, p.lat), POS_B)

  // A 看到 B 的位置
  const aSeesB = await waitFor(
    pageA,
    (bid) => {
      const m = window.__group.members().find((x) => x.id === bid)
      return !!(m && m.pos && Math.abs(m.pos.lat - 31.23) < 0.001)
    },
    userB.id,
  )
  check('设备 A 实时看到设备 B 的位置（WebSocket 广播）', aSeesB, await pageA.evaluate((bid) => {
    const m = window.__group.members().find((x) => x.id === bid)
    return m ? m.pos : null
  }, userB.id))

  // B 看到 A 的位置
  const bSeesA = await waitFor(
    pageB,
    (aid) => {
      const m = window.__group.members().find((x) => x.id === aid)
      return !!(m && m.pos && Math.abs(m.pos.lat - 31.24) < 0.001)
    },
    userA.id,
  )
  check('设备 B 实时看到设备 A 的位置', bSeesA, await pageB.evaluate((aid) => {
    const m = window.__group.members().find((x) => x.id === aid)
    return m ? m.pos : null
  }, userA.id))

  // ========== 地图队友标记 ==========
  console.log('\n— 地图上出现队友标记（本人不画为队友）—')
  const aMarkers = await waitFor(pageA, () => document.querySelectorAll('.mate-marker').length === 1)
  check('设备 A 地图出现 1 个队友标记（B，且未含自己）', aMarkers, await pageA.evaluate(() => document.querySelectorAll('.mate-marker').length))
  const aMarkerName = await pageA.evaluate(() => {
    const el = document.querySelector('.mate-marker')
    return el ? el.textContent : null
  })
  check('队友标记显示对方用户名', aMarkerName === USER_B, aMarkerName)

  const bMarkers = await waitFor(pageB, () => document.querySelectorAll('.mate-marker').length === 1)
  check('设备 B 地图出现 1 个队友标记（A）', bMarkers, await pageB.evaluate(() => document.querySelectorAll('.mate-marker').length))

  // ========== 队伍聚散分析 ==========
  console.log('\n— 队伍聚散分析（跨度/掉队）—')
  const spreadText = await waitFor(
    pageA,
    () => {
      const el = document.querySelector('[data-testid="group-spread"]')
      return el && /km|m/.test(el.textContent)
    },
  )
  const spreadStr = await pageA.evaluate(() => {
    const el = document.querySelector('[data-testid="group-spread"]')
    return el ? el.textContent : null
  })
  check('设备 A 面板显示队伍跨度距离', spreadText, spreadStr)

  // ========== 一方离开，另一方感知 ==========
  console.log('\n— 设备 B 离开房间，设备 A 实时感知 —')
  await pageB.evaluate(() => window.__group.leave())
  const aBack1 = await waitFor(pageA, () => window.__group.members().length === 1)
  check('设备 B 离开后，设备 A 成员回落为 1', aBack1, await pageA.evaluate(() => window.__group.members().length))
  const aNoMarker = await waitFor(pageA, () => document.querySelectorAll('.mate-marker').length === 0)
  check('设备 B 离开后，设备 A 队友标记清除', aNoMarker, await pageA.evaluate(() => document.querySelectorAll('.mate-marker').length))
  const bIdle = await pageB.evaluate(() => window.__group.status)
  check('设备 B 离开后本地状态为已断开', bIdle === 'closed' || bIdle === 'idle', bIdle)

  // ========== 鉴权：非法 token 握手被拒 ==========
  console.log('\n— 安全：非法 token 的 WebSocket 握手应被拒 —')
  expectingErrors = true // 失败的握手会在控制台打红，属预期
  const rejected = await pageA.evaluate(
    (room) =>
      new Promise((resolve) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const ws = new WebSocket(`${proto}//${location.host}/ws/ride?room=${room}&token=totally-invalid`)
        let welcomed = false
        const done = () => resolve({ welcomed, closed: ws.readyState >= 2 })
        const timer = setTimeout(() => {
          try {
            ws.close()
          } catch {}
          done()
        }, 3000)
        ws.onmessage = (e) => {
          try {
            if (JSON.parse(e.data).type === 'welcome') welcomed = true
          } catch {}
        }
        ws.onclose = () => {
          clearTimeout(timer)
          done()
        }
        ws.onerror = () => {}
      }),
    ROOM,
  )
  check('非法 token 未收到 welcome 且连接被关闭', rejected.welcomed === false && rejected.closed === true, rejected)
  await sleep(300)
  expectingErrors = false

  await clickTab(pageA, 'tab-group')
  await sleep(400)
  await pageA.screenshot({ path: '/tmp/group_verify_A.png' })

  check('无运行期错误', errors.length === 0)
  if (errors.length) console.log('  ⚠️ errors:', errors.slice(0, 6))

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
  await browser.close()
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
