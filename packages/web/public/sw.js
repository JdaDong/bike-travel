// 骑行旅游一体 · Service Worker
// 策略：
//  - 安装时预缓存核心壳（/、manifest、icon）
//  - 同源资源（JS/CSS/HTML）：stale-while-revalidate，离线也能秒开
//  - 跨域瓦片（高德/OpenFreeMap/PMTiles）：cache-first，弱网/飞行模式可出图
//  - /api 请求：network-first，失败回退缓存
const CACHE = 'bike-travel-v1'
const CORE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(CORE).catch(() => undefined))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  // 后端 API：network-first，离线回退缓存
  if (url.pathname.startsWith('/api')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
          return res
        })
        .catch(() => caches.match(req)),
    )
    return
  }

  // 跨域瓦片：cache-first（带过期清理）
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req)
        if (hit) return hit
        try {
          const res = await fetch(req)
          c.put(req, res.clone())
          return res
        } catch {
          return hit || Response.error()
        }
      }),
    )
    return
  }

  // 同源资源：stale-while-revalidate
  event.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req)
      const fetchP = fetch(req)
        .then((res) => {
          c.put(req, res.clone())
          return res
        })
        .catch(() => hit)
      return hit || fetchP
    }),
  )
})
