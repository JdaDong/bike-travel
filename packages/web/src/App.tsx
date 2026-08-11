import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import { MapView, type Pin } from './map/MapView'
import { RidePanel } from './ride/RidePanel'
import { type RideStats } from './ride/RideRecorder'
import { TripPlanner } from './trip/TripPlanner'
import { getRoute, searchPlace, searchPOI, getWeather, getWeatherField, type WeatherCell, type WeatherMetric, type WeatherNow } from './api'
import { getRouteSmart } from './offline/routeCache'
import { recommendRoutes, type SmartRecommendation } from './trip/smartRoute'
import { PMTILES_URL } from './config'
import { createOfflinePMTiles, downloadRegion } from './offline/offline'
import { bearing, computeNavState, isOffRoute, MANEUVER_ARROW, type NavState } from './nav/nav'
import { mergeRoutes, planWaypointRoute, singleNavContext, type NavStop } from './nav/waypoints'
import { speak } from './nav/speech'
import type { BoundingBox, Coordinate, POI, RideStyle, Route, Track } from '@bike-travel/shared'
import { loadJSON, saveJSON, KEYS, type AuthState, type SavedTrack } from './storage'
import { CloudPanel } from './cloud/CloudPanel'
import { AnnualReport } from './ride/AnnualReport'
import { ElevationProfile } from './ride/ElevationProfile'
import { GroupPanel } from './live/GroupPanel'
import { LiveClient, type LiveStatus } from './live/liveClient'
import { normalizeRoom, type LiveMember, type LivePos } from '@bike-travel/shared'
import {
  login as cloudLogin,
  logout as cloudLogout,
  push as cloudPush,
  readAuth,
  readLocalPayload,
  readSyncMeta,
  register as cloudRegister,
  writeAuth,
  writeLocalPayload,
} from './cloud/cloudApi'

// PWA 安装事件（非标准 DOM 类型，本地声明）
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

// 初始中心点：上海人民广场（WGS-84）
const FROM: Coordinate = { lng: 121.4737, lat: 31.2304, crs: 'WGS84' }
const TO: Coordinate = { lng: 121.506, lat: 31.245, crs: 'WGS84' }

// 上海热门目的地（WGS-84 近似坐标，用于「推荐」Tab 一键直达）
const HOT_SPOTS: { name: string; coord: Coordinate }[] = [
  { name: '外滩', coord: { lng: 121.4905, lat: 31.2469, crs: 'WGS84' } },
  { name: '豫园', coord: { lng: 121.4925, lat: 31.227, crs: 'WGS84' } },
  { name: '陆家嘴', coord: { lng: 121.506, lat: 31.2397, crs: 'WGS84' } },
  { name: '人民公园', coord: { lng: 121.471, lat: 31.232, crs: 'WGS84' } },
  { name: '徐家汇', coord: { lng: 121.437, lat: 31.195, crs: 'WGS84' } },
  { name: '田子坊', coord: { lng: 121.475, lat: 31.207, crs: 'WGS84' } },
]

// 周边分类一键搜
const CATEGORIES = ['美食', '咖啡', '景点', '单车租赁', '充电桩']

type Tab = 'map' | 'ride' | 'trip' | 'recommend' | 'stats' | 'cloud' | 'group'

// 本地数据签名：轨迹 id 集合 + 删除墓碑 + 行程修改时间。
// 签名不变即无实质变更，可跳过一次网络往返（空闲时零请求）。
function localSignature(): string {
  const p = readLocalPayload()
  return `${p.tracks.map((t) => t.savedAt).join(',')}|${p.deletedTracks.join(',')}|${p.trip?.updatedAt ?? 0}`
}
type Basemap = 'amap' | 'online' | 'pmtiles'
const NEXT_BASEMAP: Record<Basemap, Basemap> = { amap: 'online', online: 'pmtiles', pmtiles: 'amap' }
const BASEMAP_LABEL: Record<Basemap, string> = { amap: '高德', online: '在线', pmtiles: '离线' }
const ROUTE_COLORS = ['#185FA5', '#639922', '#993C1D', '#534AB7', '#BA7517']

// 直线距离（米），用于推荐「最近的公园」等
function distM(a: Coordinate, b: Coordinate): number {
  const dx = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)
  const dy = (a.lat - b.lat) * 111320
  return Math.sqrt(dx * dx + dy * dy)
}

export default function App() {
  const [tab, setTab] = useState<Tab>('map')
  const [routes, setRoutes] = useState<Route[]>([])
  const [pois, setPois] = useState<POI[]>([])
  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null)
  const [liveTrack, setLiveTrack] = useState<Coordinate[]>([])
  const [basemap, setBasemap] = useState<Basemap>('amap')
  const [center, setCenter] = useState<Coordinate>(FROM)
  const [offlineMsg, setOfflineMsg] = useState('')
  const [map, setMap] = useState<maplibregl.Map | null>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)

  // PWA 安装提示：捕获 beforeinstallprompt，提供「安装到主屏」按钮
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setInstalled(true)
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])
  const installApp = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    await deferredPrompt.userChoice
    setDeferredPrompt(null)
  }

  // 定位（浏览器 GPS，返回 WGS-84）
  const [locate, setLocate] = useState<Coordinate | null>(null)
  const [locateMsg, setLocateMsg] = useState('')
  // 搜索（地理编码，返回 WGS-84）
  const [query, setQuery] = useState('')
  const [searchPin, setSearchPin] = useState<Coordinate | null>(null)
  const [searchMsg, setSearchMsg] = useState('')

  // 附近搜索（POI）
  const [poiQuery, setPoiQuery] = useState('美食')
  const [poiRadius, setPoiRadius] = useState(2000)
  const [poiMsg, setPoiMsg] = useState('')
  // 推荐
  const [recoMsg, setRecoMsg] = useState('')
  // 智能路线推荐
  const [smartTarget, setSmartTarget] = useState(10) // 目标里程 km
  const [smartStyle, setSmartStyle] = useState<RideStyle>('scenic')
  const [smartResults, setSmartResults] = useState<SmartRecommendation[]>([])
  const [smartSel, setSmartSel] = useState(0)
  const [smartMsg, setSmartMsg] = useState('')

  // —— 实时导航状态 ——
  const [navActive, setNavActive] = useState(false)
  const [navSim, setNavSim] = useState(false) // 模拟导航（无 GPS 预览）
  const [navFollow, setNavFollow] = useState(true) // 镜头是否随行进方向旋转
  const [navPos, setNavPos] = useState<Coordinate | null>(null)
  const [navHeading, setNavHeading] = useState<number | undefined>(undefined)
  const [navState, setNavState] = useState<NavState | null>(null)
  const [navMsg, setNavMsg] = useState('')
  // 途径点骑行导航：起点 / 终点 / 中间途经点 / HUD 进度
  const [navStart, setNavStart] = useState<NavStop | null>(null)
  const [navEnd, setNavEnd] = useState<NavStop | null>(null)
  const [navWps, setNavWps] = useState<NavStop[]>([])
  const [navWp, setNavWp] = useState<{ idx: number; total: number; name?: string } | null>(null)
  const [wpQuery, setWpQuery] = useState('')
  const [wpMsg, setWpMsg] = useState('')

  // 多路线对比：A/B 两套起终点，各自规划后在地图双色叠加 + 指标对比
  const [routeA, setRouteA] = useState<Route | null>(null)
  const [routeB, setRouteB] = useState<Route | null>(null)
  const [fromC, setFromC] = useState<Coordinate>(FROM)
  const [toC, setToC] = useState<Coordinate>(TO)
  const [cmpMsg, setCmpMsg] = useState('')

  // —— 轨迹回放状态（联动地图 marker + 图表游标）——
  const [replayTrack, setReplayTrack] = useState<Track | null>(null)
  const [replayIdx, setReplayIdx] = useState(0)
  const [replaying, setReplaying] = useState(false)
  const [replaySpeed, setReplaySpeed] = useState(1)

  // —— 海拔剖面与爬坡分析（底部面板 + 剖面悬停联动地图高亮）——
  const [profileHover, setProfileHover] = useState<Coordinate | null>(null)
  const [elevHidden, setElevHidden] = useState(false)

  // 骑行档案库：提升到 App，以便地图热力图 / 历史对比叠加读取同一份数据
  const [library, setLibrary] = useState<SavedTrack[]>(() => loadJSON<SavedTrack[]>(KEYS.tracks, []))
  const [heatmapOn, setHeatmapOn] = useState(false)
  const [compareTracks, setCompareTracks] = useState<{ id: string; points: Coordinate[]; color: string }[]>([])
  const COMPARE_COLORS = ['#185FA5', '#D64545', '#639922']

  // 环境图层（天气 / 空气质量 / 降水）：网格采样 + 地图着色
  const [envOn, setEnvOn] = useState(false)
  const [envMetric, setEnvMetric] = useState<WeatherMetric>('temp')
  const [weatherField, setWeatherField] = useState<WeatherCell[]>([])
  const [centerWeather, setCenterWeather] = useState<WeatherNow | null>(null)
  const [envMsg, setEnvMsg] = useState('')

  // —— 实时录制状态 ——
  const [recording, setRecording] = useState(false)
  const [recPaused, setRecPaused] = useState(false)
  const [recStats, setRecStats] = useState<RideStats | null>(null)
  const [followRec, setFollowRec] = useState(true) // 录制时镜头是否跟随当前位置
  const [livePos, setLivePos] = useState<Coordinate | null>(null) // 录制中最新 GPS 位置（驱动地图标记 + 跟随）
  const recControlsRef = useRef<{ pause: () => void; resume: () => void; stop: () => void } | null>(null)

  // —— 云同步状态 ——
  const [auth, setAuth] = useState<AuthState | null>(() => readAuth())
  const [cloudTracks, setCloudTracks] = useState<number | null>(null)
  const [lastSyncAt, setLastSyncAt] = useState<number>(() => readSyncMeta().lastSyncAt)
  const [syncing, setSyncing] = useState(false)
  const [cloudMsg, setCloudMsg] = useState('')
  // 行程被云端版本覆盖后，用 key 强制 remount TripPlanner，让它重新读取 localStorage
  const [tripVersion, setTripVersion] = useState(0)
  const authRef = useRef<AuthState | null>(auth) // 供定时器闭包读取最新登录态
  const lastSigRef = useRef<string>('') // 上次同步完成时的本地数据签名，用于判断"是否有新变更"

  // —— 结伴骑行（WebSocket 多人位置共享）——
  const [groupRoom, setGroupRoom] = useState<string>(() => loadJSON<string>(KEYS.groupRoom, ''))
  const [groupStatus, setGroupStatus] = useState<LiveStatus>('idle')
  const [members, setMembers] = useState<LiveMember[]>([]) // 房间成员（含本人 self=true）
  const [groupMsg, setGroupMsg] = useState('')
  const liveRef = useRef<LiveClient | null>(null)
  const groupWatchRef = useRef<number | null>(null)
  const selfIdRef = useRef<string>('')

  const persistLibrary = (next: SavedTrack[]) => {
    setLibrary(next)
    saveJSON(KEYS.tracks, next)
  }
  const addTrack = (t: Track, name?: string) => {
    const saved: SavedTrack = {
      ...t,
      name:
        name ??
        `骑行 ${new Date().toLocaleDateString('zh-CN')} ${new Date().toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      savedAt: Date.now(),
    }
    setLibrary((prev) => {
      const next = [saved, ...prev].slice(0, 50)
      saveJSON(KEYS.tracks, next)
      return next
    })
  }
  const removeTrack = (savedAt: number) => {
    persistLibrary(library.filter((x) => x.savedAt !== savedAt))
    // 记墓碑：下次同步时告诉云端"这条被删了"，避免其它设备把它推回来
    const prev = loadJSON<number[]>(KEYS.deletedTracks, [])
    saveJSON(KEYS.deletedTracks, [savedAt, ...prev.filter((x) => x !== savedAt)].slice(0, 500))
  }
  // 记忆化：避免每次渲染生成新数组导致 MapView heatmap 副作用无限重跑（fitBounds→moveend→setCenter→重渲染循环）
  const allHeatPoints: Coordinate[] = useMemo(
    () => library.flatMap((t) => t.points.map((p) => ({ lng: p.lng, lat: p.lat }))),
    [library],
  )

  // 用 ref 持有最新导航上下文，避免 watchPosition / setInterval 闭包捕获旧值
  const navRouteRef = useRef<Route | null>(null)
  const navDestRef = useRef<Coordinate | null>(null)
  const navActiveRef = useRef(false)
  const navSimRef = useRef(false)
  const navFollowRef = useRef(true)
  const navHeadingRef = useRef<number | undefined>(undefined)
  const watchIdRef = useRef<number | null>(null)
  const simTimerRef = useRef<number | null>(null)
  const simIdxRef = useRef(0)
  const spokenRef = useRef<Set<string>>(new Set())
  const arrivedRef = useRef(false)
  const lastRerouteRef = useRef(0) // 偏航重算节流：避免每 tick 都打高德
  // 途径点导航上下文：有序停靠点、分段路线、下一个待到达站索引
  const navStopsRef = useRef<NavStop[]>([])
  const navLegsRef = useRef<Route[]>([])
  const navStopIdxRef = useRef(1)

  // —— 云同步核心 ——
  // push 的是本地全量，服务端用同一套 mergeSync 合并后回传权威版本，
  // 因此「推送」同时也完成了「拉取」，一次往返即可收敛。
  const doSync = useCallback(async (silent = false) => {
    const a = authRef.current
    if (!a) return
    setSyncing(true)
    if (!silent) setCloudMsg('同步中…')
    try {
      const local = readLocalPayload()
      const merged = await cloudPush(a.token, local)
      writeLocalPayload(merged)
      setLibrary(merged.tracks)
      setCloudTracks(merged.tracks.length)
      setLastSyncAt(Date.now())
      // 云端行程更新（其它设备改过）：remount TripPlanner 使其重新读取
      if ((merged.trip?.updatedAt ?? 0) > (local.trip?.updatedAt ?? 0)) setTripVersion((v) => v + 1)
      lastSigRef.current = localSignature()
      setCloudMsg(`✅ 已同步 ${merged.tracks.length} 条轨迹`)
    } catch (e) {
      const m = (e as Error).message
      setCloudMsg(`⚠️ ${m}`)
      // token 失效（换机重装 / 服务端重置）：清本地登录态，引导重新登录
      if (m.includes('失效')) {
        authRef.current = null
        setAuth(null)
        writeAuth(null)
      }
    } finally {
      setSyncing(false)
    }
  }, [])

  const handleAuth = useCallback(
    async (mode: 'login' | 'register', name: string, password: string) => {
      setSyncing(true)
      setCloudMsg(mode === 'login' ? '登录中…' : '注册中…')
      try {
        const r = mode === 'login' ? await cloudLogin(name, password) : await cloudRegister(name, password)
        const a: AuthState = { token: r.token, user: r.user }
        writeAuth(a)
        authRef.current = a
        setAuth(a) // 触发同步 effect，完成首次合并
      } catch (e) {
        setCloudMsg(`⚠️ ${(e as Error).message}`)
      } finally {
        setSyncing(false)
      }
    },
    [],
  )

  const handleLogout = useCallback(async () => {
    const a = authRef.current
    authRef.current = null
    setAuth(null)
    writeAuth(null)
    setCloudTracks(null)
    setCloudMsg('已退出登录（本地数据保留）')
    if (a) await cloudLogout(a.token)
  }, [])

  // 登录期间：进入即同步一次，之后每 4s 比对本地数据签名，有变更才推送。
  // 用轮询而非监听，是因为行程由 TripPlanner 直接写 localStorage，App 无法直接感知；
  // 签名比对使得「无变更时零请求」。
  useEffect(() => {
    if (!auth) return
    void doSync(true)
    const id = window.setInterval(() => {
      if (localSignature() !== lastSigRef.current) void doSync(true)
    }, 4000)
    return () => window.clearInterval(id)
  }, [auth, doSync])

  // 暴露同步状态，便于自动化断言与调试
  useEffect(() => {
    ;(window as any).__cloud = {
      loggedIn: !!auth,
      user: auth?.user?.name ?? null,
      localTracks: library.length,
      cloudTracks,
      lastSyncAt,
      syncing,
      sync: () => doSync(false),
    }
  }, [auth, library.length, cloudTracks, lastSyncAt, syncing, doSync])

  // —— 结伴骑行核心 ——
  const upsertMember = useCallback((m: LiveMember) => {
    setMembers((prev) => {
      const i = prev.findIndex((x) => x.id === m.id)
      if (i === -1) return [...prev, m]
      const next = prev.slice()
      next[i] = { ...next[i], ...m }
      return next
    })
  }, [])

  // 上报本人位置：发给服务端并本地回显（更新自己在列表里的位置）
  const reportSelfPos = useCallback((lng: number, lat: number, spd?: number, hdg?: number) => {
    const pos: LivePos = { lng, lat, t: Date.now() }
    if (spd != null && Number.isFinite(spd)) pos.spd = spd
    if (hdg != null && Number.isFinite(hdg)) pos.hdg = hdg
    liveRef.current?.sendPos(pos)
    const sid = selfIdRef.current
    if (sid) setMembers((prev) => prev.map((x) => (x.id === sid ? { ...x, pos } : x)))
  }, [])

  const stopGroupWatch = useCallback(() => {
    if (groupWatchRef.current != null) {
      navigator.geolocation.clearWatch(groupWatchRef.current)
      groupWatchRef.current = null
    }
  }, [])

  const startGroupWatch = useCallback(() => {
    if (!('geolocation' in navigator) || groupWatchRef.current != null) return
    groupWatchRef.current = navigator.geolocation.watchPosition(
      (p) => {
        const spd =
          typeof p.coords.speed === 'number' && !Number.isNaN(p.coords.speed) ? p.coords.speed : undefined
        const hdg =
          typeof p.coords.heading === 'number' && !Number.isNaN(p.coords.heading) ? p.coords.heading : undefined
        reportSelfPos(p.coords.longitude, p.coords.latitude, spd, hdg)
      },
      () => {
        /* GPS 失败：静默，队友仍可看到最后已知位置 */
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 2000 },
    )
  }, [reportSelfPos])

  const joinGroup = useCallback(
    (roomArg?: string) => {
      const a = authRef.current
      if (!a) {
        setGroupMsg('⚠️ 请先在「云端」登录后再结伴')
        return
      }
      const room = normalizeRoom(roomArg ?? groupRoom)
      if (!room) {
        setGroupMsg('⚠️ 房间号仅支持字母/数字/连字符（1–24 位）')
        return
      }
      setGroupRoom(room)
      saveJSON(KEYS.groupRoom, room)
      liveRef.current?.close()
      setMembers([])
      selfIdRef.current = ''
      const client = new LiveClient(room, a.token, {
        onStatus: setGroupStatus,
        onWelcome: (self, ms) => {
          selfIdRef.current = self.id
          setMembers(ms)
          setGroupMsg(`✅ 已加入房间「${room}」`)
        },
        onJoin: (m) => upsertMember(m),
        onLeave: (id) => setMembers((prev) => prev.filter((x) => x.id !== id)),
        onPos: (id, pos) => setMembers((prev) => prev.map((x) => (x.id === id ? { ...x, pos } : x))),
        onError: (m) => setGroupMsg(`⚠️ ${m}`),
      })
      liveRef.current = client
      client.connect()
      startGroupWatch()
    },
    [groupRoom, upsertMember, startGroupWatch],
  )

  const leaveGroup = useCallback(() => {
    liveRef.current?.close()
    liveRef.current = null
    stopGroupWatch()
    selfIdRef.current = ''
    setMembers([])
    setGroupStatus('idle')
    setGroupMsg('已离开房间')
  }, [stopGroupWatch])

  const focusMate = useCallback((m: LiveMember) => {
    if (!m.pos) return
    mapRef.current?.flyTo({ center: [m.pos.lng, m.pos.lat], zoom: 15 })
    setTab('map')
  }, [])

  // 组件卸载时断开连接，避免泄漏
  useEffect(() => () => leaveGroup(), [leaveGroup])

  // 暴露结伴状态，便于双端自动化验证（真实 WebSocket 全链路）
  useEffect(() => {
    ;(window as any).__group = {
      status: groupStatus,
      room: normalizeRoom(groupRoom),
      selfId: () => selfIdRef.current,
      members: () => members,
      join: (r?: string) => joinGroup(r),
      sendPos: (lng: number, lat: number) => reportSelfPos(lng, lat),
      leave: () => leaveGroup(),
    }
  }, [groupStatus, groupRoom, members, joinGroup, reportSelfPos, leaveGroup])

  const onMap = useCallback((m: maplibregl.Map) => {
    mapRef.current = m
    setMap(m)
    if (typeof window !== 'undefined') (window as any).__map = m // 便于自动化/调试断言图层
    m.on('moveend', () => {
      const c = m.getCenter()
      setCenter({ lng: c.lng, lat: c.lat, crs: 'WGS84' })
    })
  }, [])

  // 录制状态回调：用 useCallback 稳定引用，避免 RidePanel 内部 effect 频繁重建 recorder
  const handleStats = useCallback((s: RideStats) => setRecStats(s), [])
  const handleRecStatus = useCallback((r: boolean, p: boolean) => {
    setRecording(r)
    setRecPaused(p)
  }, [])
  const handleLivePos = useCallback((c: Coordinate | null) => setLivePos(c), [])
  const handleControls = useCallback(
    (c: { pause: () => void; resume: () => void; stop: () => void }) => {
      recControlsRef.current = c
    },
    [],
  )

  // POI 搜索圆心：优先定位点，否则地图中心
  const poiCenter = (): Coordinate => locate ?? center

  // 把一条已规划路线（或途径点多段）写入导航上下文引用，供 tickNav 统一处理到达/偏航。
  // stops 省略时按「起点=几何首点 / 终点=几何末点」派生为单段模型。
  const seedNav = (merged: Route, legs?: Route[], stops?: NavStop[]) => {
    const ctx = stops ? { stops, legs: legs && legs.length ? legs : [merged] } : singleNavContext(merged)
    navStopsRef.current = ctx.stops
    navLegsRef.current = ctx.legs
    navStopIdxRef.current = 1
    setNavWp(null)
  }

  const planDemo = async () => {
    const r = await getRouteSmart(FROM, TO)
    seedNav(r)
    setRoutes([r])
    if (r.cached) setNavMsg('（离线缓存路线）')
  }

  // —— 途径点骑行导航规划 ——
  // 停靠点顺序：起点 → …途经点… → 终点。每站可经搜索/当前位置/地图中心设定。
  const wpStops = (): NavStop[] => {
    const s = navStart ?? { name: '起点', coord: center }
    const e = navEnd ?? { name: '终点', coord: center }
    return [s, ...navWps, e]
  }

  const addWaypoint = (stop: NavStop) => {
    setNavWps((ws) => [...ws, stop])
    setWpMsg(`已添加途径点：${stop.name ?? `${stop.coord.lng.toFixed(4)},${stop.coord.lat.toFixed(4)}`}`)
  }

  const geocodeToStop = async (q: string, role: 'start' | 'wp' | 'end'): Promise<boolean> => {
    const name = q.trim()
    if (!name) return false
    try {
      setWpMsg('搜索中…')
      const r = await searchPlace(name)
      if (!r.coord) {
        setWpMsg(`未找到「${name}」`)
        return false
      }
      const stop: NavStop = { name, coord: r.coord }
      if (role === 'start') setNavStart(stop)
      else if (role === 'end') setNavEnd(stop)
      else addWaypoint(stop)
      return true
    } catch (e) {
      setWpMsg('搜索失败：' + (e as Error).message)
      return false
    }
  }

  const useCurrentAs = (role: 'start' | 'wp' | 'end') => {
    const c = locate ?? center
    const stop: NavStop = { name: role === 'start' ? '起点(当前)' : role === 'end' ? '终点(当前)' : '途经点(当前)', coord: c }
    if (role === 'start') setNavStart(stop)
    else if (role === 'end') setNavEnd(stop)
    else addWaypoint(stop)
  }

  const removeWp = (idx: number) => setNavWps((ws) => ws.filter((_, i) => i !== idx))
  const moveWp = (idx: number, dir: -1 | 1) =>
    setNavWps((ws) => {
      const j = idx + dir
      if (j < 0 || j >= ws.length) return ws
      const copy = [...ws]
      ;[copy[idx], copy[j]] = [copy[j], copy[idx]]
      return copy
    })

  const planWaypoints = async () => {
    const stops = wpStops()
    if (stops.length < 2) {
      setWpMsg('至少需要起点与终点')
      return
    }
    if (stops.some((s) => !s.coord)) {
      setWpMsg('存在空坐标，请先补全起点/终点/途径点')
      return
    }
    setWpMsg('正在规划途径点路线（逐段骑行导航）…')
    try {
      const { merged, legs } = await planWaypointRoute(stops, (a, b) => getRouteSmart(a, b))
      seedNav(merged, legs, stops)
      setRoutes([merged])
      const km = (merged.distanceM / 1000).toFixed(1)
      const min = Math.round(merged.durationS / 60)
      setWpMsg(`规划完成：${stops.length} 站，全程约 ${km}km / ${min} 分钟`)
    } catch (e) {
      setWpMsg('规划失败：' + (e as Error).message)
    }
  }

  // 多路线对比：规划 A / B 方案并同时展示
  const planCompare = async (which: 'A' | 'B') => {
    setCmpMsg('规划中…')
    try {
      const r = await getRouteSmart(fromC, toC)
      if (which === 'A') setRouteA(r)
      else setRouteB(r)
      const a = which === 'A' ? r : routeA
      const b = which === 'B' ? r : routeB
      seedNav(a ?? r)
      if (a && b) setRoutes([a, b])
      else setRoutes([r])
      setCmpMsg(which === 'A' ? '已规划方案 A' : '已规划方案 B')
    } catch (e) {
      setCmpMsg('规划失败：' + (e as Error).message)
    }
  }

  const locateMe = () => {
    if (!('geolocation' in navigator)) {
      setLocateMsg('当前浏览器不支持定位')
      return
    }
    setLocateMsg('定位中…')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const c: Coordinate = { lng: pos.coords.longitude, lat: pos.coords.latitude, crs: 'WGS84' }
        setLocate(c)
        mapRef.current?.flyTo({ center: [c.lng, c.lat], zoom: 14 })
        setLocateMsg('已定位到当前位置')
      },
      (err) => setLocateMsg('定位失败：' + err.message),
      { enableHighAccuracy: true, timeout: 10000 },
    )
  }

  const doSearch = async () => {
    const q = query.trim()
    if (!q) return
    try {
      setSearchMsg('搜索中…')
      const r = await searchPlace(q)
      if (!r.coord) {
        setSearchMsg('未找到「' + q + '」')
        return
      }
      setSearchPin(r.coord)
      mapRef.current?.flyTo({ center: [r.coord.lng, r.coord.lat], zoom: 14 })
      setSearchMsg(`已定位：${q}（${r.provider}）`)
    } catch (e) {
      setSearchMsg('搜索失败：' + (e as Error).message)
    }
  }

  // 附近搜索 POI（以定位点/地图中心为圆心）
  const searchNearby = async () => {
    const q = poiQuery.trim() || '美食'
    const near = poiCenter()
    setPoiMsg('搜索「' + q + '」中…')
    try {
      const list = await searchPOI(q, near, poiRadius)
      setPois(list)
      setSelectedPoiId(list[0]?.id ?? null)
      setPoiMsg(`找到 ${list.length} 个结果（半径 ${(poiRadius / 1000).toFixed(1)}km）`)
      mapRef.current?.flyTo({ center: [near.lng, near.lat], zoom: 13 })
    } catch (e) {
      setPoiMsg('搜索失败：' + (e as Error).message)
    }
  }

  // 点击 POI（列表或地图标记）：飞行 + 选中
  const flyToPoi = (p: POI) => {
    setSelectedPoiId(p.id)
    mapRef.current?.flyTo({ center: [p.coord.lng, p.coord.lat], zoom: 15 })
  }

  // 推荐：热门目的地一键直达
  const gotoSpot = (s: { name: string; coord: Coordinate }) => {
    setCenter(s.coord)
    setSearchPin(s.coord)
    setSearchMsg(`已定位：${s.name}（推荐）`)
    mapRef.current?.flyTo({ center: [s.coord.lng, s.coord.lat], zoom: 13 })
  }

  // 推荐：智能骑行路线（搜附近公园 -> 取最近 -> 规划骑行）
  const recommendRide = async () => {
    const near = poiCenter()
    setRecoMsg('正在为你推荐附近骑行目的地…')
    try {
      const parks = await searchPOI('公园', near, 3000)
      if (!parks.length) {
        setRecoMsg('附近暂未找到公园，换个位置试试')
        return
      }
      let best = parks[0]
      let bestD = Infinity
      for (const p of parks) {
        const d = distM(near, p.coord)
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      const route = await getRouteSmart(near, best.coord)
      seedNav(route)
      setRoutes([route])
      setPois([best])
      setSelectedPoiId(best.id)
      setSearchPin(null)
      mapRef.current?.flyTo({ center: [near.lng, near.lat], zoom: 12 })
      setRecoMsg(
        `推荐：从当前位置骑行到「${best.name}」，约 ${(route.distanceM / 1000).toFixed(1)}km / ${Math.round(
          route.durationS / 60,
        )} 分钟`,
      )
    } catch (e) {
      setRecoMsg('推荐失败：' + (e as Error).message)
    }
  }

  // 推荐：分类周边一键搜
  const recommendCategory = async (cat: string) => {
    const near = poiCenter()
    setRecoMsg(`搜索「${cat}」中…`)
    try {
      const list = await searchPOI(cat, near, 3000)
      setPois(list)
      setSelectedPoiId(list[0]?.id ?? null)
      setRecoMsg(`已为你找到 ${list.length} 个「${cat}」`)
      mapRef.current?.flyTo({ center: [near.lng, near.lat], zoom: 13 })
    } catch (e) {
      setRecoMsg('搜索失败：' + (e as Error).message)
    }
  }

  // 智能路线推荐：按里程 + 风格生成多条候选环线，打分排序后渲染
  const genSmart = async () => {
    setSmartMsg('推荐中…（检索 POI + 多条候选路线打分）')
    try {
      const recs = await recommendRoutes({
        center: poiCenter(),
        targetKm: smartTarget,
        style: smartStyle,
        heatPoints: allHeatPoints,
      })
      setSmartResults(recs)
      if (recs.length) {
        pickSmart(0, recs)
        setSmartMsg(`已生成 ${recs.length} 条候选，按推荐分排序。点击卡片可换选，选中后可一键导航。`)
      } else {
        setSmartMsg('附近暂未找到合适路线，可调大距离或换个位置再试')
      }
    } catch (e) {
      setSmartMsg('推荐失败：' + (e as Error).message)
    }
  }
  // 选用第 i 条：选中路线置顶（蓝色），其余作为备选多色叠加
  const pickSmart = (i: number, recs = smartResults) => {
    setSmartSel(i)
    const r = recs[i]
    if (!r) return
    seedNav(r.route)
    setRoutes([r.route, ...recs.filter((_, j) => j !== i).map((x) => x.route)])
    setPois(r.pois)
    setSelectedPoiId(r.pois[0]?.id ?? null)
  }

  const downloadOffline = async () => {
    if (!PMTILES_URL) {
      setOfflineMsg('未配置 VITE_PMTILES_URL，无法下载离线包')
      return
    }
    const b = mapRef.current?.getBounds()
    if (!b) return
    const bbox: BoundingBox = {
      minLng: b.getWest(),
      minLat: b.getSouth(),
      maxLng: b.getEast(),
      maxLat: b.getNorth(),
    }
    setOfflineMsg('下载中…')
    const pm = createOfflinePMTiles(PMTILES_URL)
    const n = await downloadRegion(pm, bbox, 10, 14)
    setOfflineMsg(`已缓存 ${n} 个瓦片到 IndexedDB（飞行模式可出图）`)
  }

  // 环境图层：按当前地图视野 bbox 拉取天气网格，并刷新中心实时天气卡片
  const refreshCenterWeather = useCallback(async () => {
    const c = center
    try {
      const w = await getWeather(c.lng, c.lat)
      setCenterWeather(w)
    } catch {
      /* 中心天气卡片失败不阻断图层 */
    }
  }, [center])

  const loadEnvLayer = useCallback(async () => {
    setEnvMsg('加载天气图层…')
    try {
      // 优先用当前地图视野 bbox，否则以中心扩 ±0.12°（约 ±13km）
      const b = mapRef.current?.getBounds()
      const bbox = b
        ? { minLng: b.getWest(), minLat: b.getSouth(), maxLng: b.getEast(), maxLat: b.getNorth() }
        : {
            minLng: center.lng - 0.12,
            minLat: center.lat - 0.1,
            maxLng: center.lng + 0.12,
            maxLat: center.lat + 0.1,
          }
      const cells = await getWeatherField(bbox, 7)
      setWeatherField(cells)
      setEnvMsg(`已加载 ${cells.length} 个采样点 · ${envMetric === 'temp' ? '温度' : envMetric === 'aqi' ? '空气质量' : '降水'}`)
      await refreshCenterWeather()
    } catch (e) {
      setEnvMsg('天气数据获取失败（Open-Meteo 不可达）')
      console.error(e)
    }
  }, [center, envMetric, refreshCenterWeather])

  const toggleEnv = (on: boolean) => {
    setEnvOn(on)
    if (on) loadEnvLayer()
    else {
      setWeatherField([])
      setEnvMsg('')
    }
  }

  const changeEnvMetric = (m: WeatherMetric) => {
    setEnvMetric(m)
    if (envOn) {
      setEnvMsg(`指标已切换 · ${m === 'temp' ? '温度' : m === 'aqi' ? '空气质量' : '降水'}`)
      // 仅切换配色，无需重新拉取数据
    }
  }

  // —— 导航核心 ——
  const stopWatch = () => {
    if (watchIdRef.current != null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
  }
  const stopSim = () => {
    if (simTimerRef.current != null) {
      clearInterval(simTimerRef.current)
      simTimerRef.current = null
    }
  }

  const arrive = useCallback(() => {
    if (arrivedRef.current) return
    arrivedRef.current = true
    navActiveRef.current = false
    setNavActive(false)
    setNavMsg('已到达目的地 🏁')
    speak('您已到达目的地')
    stopWatch()
    stopSim()
    setNavPos(null)
    setNavHeading(undefined)
    setNavWp(null)
  }, [])

  // 每个 GPS 点 / 模拟点进入：算进度、途径点到达、偏航重算、转向播报、镜头跟随
  const tickNav = useCallback((pos: Coordinate) => {
    if (!navActiveRef.current || !navRouteRef.current) return
    setNavPos(pos)
    const route = navRouteRef.current

    // 途径点到达判定：到「下一站」坐标 40m 内即视为到达（独立于路线投影，避免绕路误差）
    const stops = navStopsRef.current
    const idx = navStopIdxRef.current
    const target = stops[idx]
    if (target && distM(pos, target.coord) < 40) {
      if (idx >= stops.length - 1) {
        arrive() // 末站 = 目的地
        return
      }
      const reached = target
      navStopIdxRef.current = idx + 1
      const next = stops[idx + 1]
      navDestRef.current = next?.coord ?? null
      setNavWp({ idx: idx + 1, total: stops.length, name: next?.name })
      speak(`已到达${reached.name ?? '途经点'}${next ? '，继续前往' + (next.name ?? '下一站') : ''}`)
      setNavMsg(`已到达${reached.name ?? '途经点'}（${idx + 1}/${stops.length}）`)
    }

    // 偏航（仅真实 GPS 模式）：偏离路线超 40m → 重路由到「当前目标站」，并保留后续分段重建完整路线
    if (!navSimRef.current && navDestRef.current && isOffRoute(route, pos, 40)) {
      const now = Date.now()
      if (now - lastRerouteRef.current > 5000) {
        lastRerouteRef.current = now
        const targetStop = navDestRef.current
        setNavMsg('已偏航，正在重新规划到下一站…')
        speak('已偏航，正在重新规划路线')
        getRouteSmart(pos, targetStop)
          .then((rr) => {
            const rebuilt = mergeRoutes([rr, ...navLegsRef.current.slice(navStopIdxRef.current)])
            navRouteRef.current = rebuilt
            setRoutes([rebuilt])
            spokenRef.current = new Set()
            if (rr.cached) setNavMsg('已偏航，使用离线缓存路线继续导航')
          })
          .catch(() => setNavMsg('重新规划失败，请手动结束导航'))
      }
      return
    }

    const st = computeNavState(route, pos)
    setNavState(st)

    // 转向播报：进入 200m 范围时播报一次
    if (st.nextManeuver) {
      const d = st.nextManeuver.distanceM
      const key = String(st.nextManeuver.index)
      if (!spokenRef.current.has(key) && d <= 200) {
        spokenRef.current.add(key)
        speak(`前方约 ${Math.round(d)} 米，${st.nextManeuver.instruction}`)
      }
    }

    if (st.remainingM < 25) {
      arrive()
      return
    }
    // 镜头跟随：开启时随行进方向旋转（bearing=heading，pitch 给 3D 感），否则仅居中
    const map = mapRef.current
    if (map) {
      if (navFollowRef.current && navHeadingRef.current != null) {
        map.easeTo({ center: [pos.lng, pos.lat], bearing: navHeadingRef.current, pitch: 50, zoom: 15, duration: 400 })
      } else {
        map.easeTo({ center: [pos.lng, pos.lat], zoom: 15, duration: 400 })
      }
    }
  }, [arrive])

  const startWatch = () => {
    if (!('geolocation' in navigator)) {
      setNavMsg('当前浏览器不支持定位，可改用「模拟导航」')
      return
    }
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const c: Coordinate = { lng: pos.coords.longitude, lat: pos.coords.latitude, crs: 'WGS84' }
        const h = typeof pos.coords.heading === 'number' && !Number.isNaN(pos.coords.heading) ? pos.coords.heading : undefined
        if (h != null) {
          setNavHeading(h)
          navHeadingRef.current = h
        }
        tickNav(c)
      },
      (err) => setNavMsg('GPS 信号弱：' + err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 1000 },
    )
  }

  const startSim = (route: Route) => {
    simIdxRef.current = 0
    setNavPos(route.geometry[0])
    // 模拟步进间隔：默认 350ms；测试时可通过 window.__navFast 加速（不影响正常体验）
    const stepMs = (window as any).__navFast ? 25 : 350
    simTimerRef.current = window.setInterval(() => {
      const g = navRouteRef.current?.geometry
      if (!g) return
      simIdxRef.current = Math.min(simIdxRef.current + 1, g.length - 1)
      const idx = simIdxRef.current
      const pos = g[idx]
      if (idx > 0) {
        const h = bearing(g[idx - 1], pos)
        setNavHeading(h)
        navHeadingRef.current = h
      }
      tickNav(pos)
      if (idx >= g.length - 1) arrive()
    }, stepMs)
  }

  const startNav = (route?: Route) => {
    const r = route ?? routes[0]
    if (!r) {
      setNavMsg('请先规划一条路线再开始导航')
      return
    }
    // 确保导航上下文引用就绪（规划时已由 seedNav 设置；此处兜底，避免直接拿 routes[0] 导航时缺失）
    if (navStopsRef.current.length < 2) {
      const ctx = singleNavContext(r)
      navStopsRef.current = ctx.stops
      navLegsRef.current = ctx.legs
    }
    navStopIdxRef.current = 1
    navRouteRef.current = r
    const stops = navStopsRef.current
    navDestRef.current = stops[1]?.coord ?? r.geometry[r.geometry.length - 1]
    navActiveRef.current = true
    navSimRef.current = navSim
    navFollowRef.current = navFollow
    arrivedRef.current = false
    spokenRef.current = new Set()
    setNavActive(true)
    setNavPos(r.geometry[0])
    setNavWp({ idx: 1, total: stops.length, name: stops[1]?.name })
    setNavMsg('导航中…')
    setTab('map')
    mapRef.current?.flyTo({ center: [r.geometry[0].lng, r.geometry[0].lat], zoom: 14 })
    speak(
      `开始导航，共 ${stops.length} 站，全程约 ${(r.distanceM / 1000).toFixed(1)} 公里，预计 ${Math.round(r.durationS / 60)} 分钟`,
    )
    if (navSim) startSim(r)
    else startWatch()
  }

  const stopNav = () => {
    stopWatch()
    stopSim()
    navActiveRef.current = false
    navSimRef.current = false
    navRouteRef.current = null
    navDestRef.current = null
    navStopsRef.current = []
    navLegsRef.current = []
    navStopIdxRef.current = 1
    setNavActive(false)
    setNavPos(null)
    setNavHeading(undefined)
    setNavState(null)
    setNavWp(null)
    setNavMsg('已退出导航')
  }

  // —— 轨迹回放（记录完成 / 导入 GPX 后加载）——
  const loadTrack = (track: Track) => {
    setReplayTrack(track)
    setReplayIdx(0)
    setReplaying(true)
  }
  const seekReplay = (idx: number) => {
    if (!replayTrack) return
    setReplaying(false)
    setReplayIdx(Math.max(0, Math.min(idx, replayTrack.points.length - 1)))
  }
  const toggleReplay = (): void => setReplaying((p) => !p)

  // 回放定时器：按倍速推进游标（200ms 基础节拍）
  useEffect(() => {
    if (!replaying || !replayTrack) return
    const len = replayTrack.points.length
    if (len < 2) return
    const id = setInterval(() => {
      setReplayIdx((i) => Math.min(i + replaySpeed, len - 1))
    }, 200)
    return () => clearInterval(id)
  }, [replaying, replayTrack, replaySpeed])

  // 到达末尾自动暂停
  useEffect(() => {
    if (replaying && replayTrack && replayIdx >= replayTrack.points.length - 1) {
      setReplaying(false)
    }
  }, [replaying, replayTrack, replayIdx])

  // 海拔剖面分析对象：优先「已加载的回放轨迹」，否则用带高程起伏的第一条规划路线
  const analysisPoints: Coordinate[] | null = useMemo(() => {
    if (replayTrack && replayTrack.points.length > 1) return replayTrack.points
    const g = routes[0]?.geometry
    if (g && g.length > 1) {
      const e0 = g[0].ele ?? 0
      if (g.some((p) => (p.ele ?? 0) !== e0)) return g
    }
    return null
  }, [replayTrack, routes])
  // 分析对象变化时重置悬停/展开状态，避免残留高亮
  useEffect(() => {
    setProfileHover(null)
    setElevHidden(false)
  }, [analysisPoints])

  const pins: Pin[] = []
  if (locate) pins.push({ coord: locate, color: '#1A73E8', label: '我的位置' })
  if (searchPin) pins.push({ coord: searchPin, color: '#D4537E', label: query || '搜索结果' })
  // 途径点规划标记：起点(蓝) / 中间途经点(多彩编号) / 终点(橙)。导航中由 navStart/Wps/End 驱动。
  const WP_COLORS = ['#7B61FF', '#00A86B', '#E8833A', '#C2185B', '#0097A7', '#D81B60']
  if (navStart) pins.push({ coord: navStart.coord, color: '#1A73E8', label: '🚩 ' + (navStart.name ?? '起点') })
  navWps.forEach((w, i) =>
    pins.push({ coord: w.coord, color: WP_COLORS[i % WP_COLORS.length], label: `途经点${i + 1} ${w.name ?? ''}`.trim() }),
  )
  if (navEnd) pins.push({ coord: navEnd.coord, color: '#F5A623', label: '🏁 ' + (navEnd.name ?? '终点') })
  else if (navDestRef.current && !navStart && navWps.length === 0)
    pins.push({ coord: navDestRef.current, color: '#F5A623', label: '🏁 目的地' })
  // 回放当前位置（橙色，与导航蓝色箭头区分）
  if (replayTrack && (replaying || replayIdx > 0)) {
    const rp = replayTrack.points[Math.min(replayIdx, replayTrack.points.length - 1)]
    if (rp) pins.push({ coord: rp, color: '#FF7A00', label: '回放位置' })
  }

  // 结伴骑行：地图上只画「队友」（排除本人），且需已有位置
  const mates = members.filter((m) => !m.self && m.pos)

  // 暴露实时轨迹点数给自动化验证（不影响业务逻辑）
  if (typeof window !== 'undefined') (window as any).__recPoints = liveTrack.length
  // 暴露导航上下文给自动化验证（途径点进度 / 消息 / 路线距离）
  if (typeof window !== 'undefined') {
    ;(window as any).__navWp = navWp
    ;(window as any).__navMsg = navMsg
    ;(window as any).__navStops = navStopsRef.current.length
    ;(window as any).__routeDist = routes[0]?.distanceM ?? 0
  }

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <MapView
        basemap={basemap}
        center={[center.lng, center.lat]}
        routes={routes}
        pois={pois}
        liveTrack={replayTrack ? replayTrack.points : liveTrack}
        livePos={livePos ?? undefined}
        followLive={followRec}
        pins={pins}
        selectedPoiId={selectedPoiId ?? undefined}
        onPoiClick={(p) => setSelectedPoiId(p.id)}
        navPos={navPos ?? undefined}
        navHeading={navHeading}
        heatPoints={heatmapOn ? allHeatPoints : undefined}
        compareTracks={compareTracks}
        weatherField={envOn ? weatherField : undefined}
        weatherMetric={envMetric}
        hoverPos={profileHover ?? undefined}
        mates={mates}
        onMap={onMap}
      />

      {/* 顶部 Tab + 底图切换 */}
      <div style={topBar}>
        {(['map', 'ride', 'trip', 'recommend', 'stats', 'group', 'cloud'] as Tab[]).map((t) => {
          const label: Record<Tab, string> = {
            map: '地图',
            ride: '骑行',
            trip: '行程',
            recommend: '推荐',
            stats: '🏆 成就',
            group: mates.length > 0 ? `👥 结伴·${mates.length}` : '👥 结伴',
            cloud: auth ? '☁️ 已登录' : '☁️ 云端',
          }
          return (
            <button key={t} data-testid={`tab-${t}`} onClick={() => setTab(t)} style={tab === t ? tabOn : tabOff}>
              {label[t]}
            </button>
          )
        })}
        <span style={{ flex: 1 }} />
        {deferredPrompt && !installed && (
          <button onClick={installApp} style={tabOff}>
            ＋ 安装到主屏
          </button>
        )}
        <button onClick={() => setBasemap((b) => NEXT_BASEMAP[b])}>底图: {BASEMAP_LABEL[basemap]}</button>
      </div>

      {tab === 'map' && (
        <div style={leftCard}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>搜索地点</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={query}
              placeholder="地址 / 地名，如：外滩"
              onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, fontSize: 13, padding: '4px 6px' }}
              onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            />
            <button onClick={doSearch}>搜</button>
          </div>
          <button style={{ marginTop: 8 }} onClick={locateMe}>
            📍 定位我的位置
          </button>
          <div style={{ marginTop: 6, fontSize: 12, color: '#555', minHeight: 16 }}>
            {searchMsg && <div>🔍 {searchMsg}</div>}
            {locateMsg && <div>📍 {locateMsg}</div>}
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '10px 0' }} />

          <div style={{ fontWeight: 600, marginBottom: 6 }}>附近搜索（POI）</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={poiQuery}
              placeholder="关键词，如：咖啡"
              onChange={(e) => setPoiQuery(e.target.value)}
              style={{ flex: 1, fontSize: 13, padding: '4px 6px' }}
              onKeyDown={(e) => e.key === 'Enter' && searchNearby()}
            />
            <button onClick={searchNearby}>搜</button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {[1000, 2000, 5000].map((r) => (
              <button
                key={r}
                onClick={() => setPoiRadius(r)}
                style={poiRadius === r ? chipOn : chipOff}
              >
                {r / 1000}km
              </button>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#555', minHeight: 16 }}>{poiMsg}</div>
          <PoiList pois={pois} selectedId={selectedPoiId} onSelect={flyToPoi} />

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '10px 0' }} />

          <button onClick={planDemo}>规划骑行路线（上海示例）</button>
          <div style={{ marginTop: 8, fontSize: 13 }}>
            {routes[0]
              ? `路线(${routes[0].provider}) ${(routes[0].distanceM / 1000).toFixed(1)}km 爬升 ${Math.round(
                  routes[0].elevationGainM,
                )}m`
              : '点击上方按钮在地图上画线'}
          </div>

          {/* 途径点骑行导航规划 */}
          <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #eee' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>🚩 途径点骑行导航</div>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
              依次添加 起点 → 途经点（可多个）→ 终点，逐段规划后合并为一条路线导航。
            </div>
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input
                value={wpQuery}
                placeholder="搜索地点（回车添加）"
                onChange={(e) => setWpQuery(e.target.value)}
                style={{ flex: 1, fontSize: 13, padding: '4px 6px' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (!navStart) void geocodeToStop(wpQuery, 'start')
                    else if (!navEnd) void geocodeToStop(wpQuery, 'end')
                    else void geocodeToStop(wpQuery, 'wp')
                  }
                }}
              />
              <button onClick={() => void geocodeToStop(wpQuery, !navStart ? 'start' : !navEnd ? 'end' : 'wp')}>加为下一站</button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <button style={{ fontSize: 12 }} onClick={() => useCurrentAs(!navStart ? 'start' : !navEnd ? 'end' : 'wp')}>
                用当前位置
              </button>
              <button style={{ fontSize: 12 }} onClick={() => { setNavStart(null); setNavEnd(null); setNavWps([]); setWpMsg('已清空途径点') }}>
                清空
              </button>
            </div>

            {/* 有序停靠点列表 */}
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {navStart && (
                <StopRow label="起点" name={navStart.name} onUse={() => useCurrentAs('start')} onClear={() => setNavStart(null)} />
              )}
              {navWps.map((w, i) => (
                <StopRow
                  key={i}
                  label={`途经点 ${i + 1}`}
                  name={w.name}
                  onUp={i > 0 ? () => moveWp(i, -1) : undefined}
                  onDown={i < navWps.length - 1 ? () => moveWp(i, 1) : undefined}
                  onClear={() => removeWp(i)}
                />
              ))}
              {navEnd && <StopRow label="终点" name={navEnd.name} onUse={() => useCurrentAs('end')} onClear={() => setNavEnd(null)} />}
            </div>

            <button
              style={{ ...navStartBtn, marginTop: 8 }}
              disabled={!navStart && !navEnd && navWps.length === 0}
              onClick={() => void planWaypoints()}
            >
              🧭 规划途径点路线
            </button>
            {wpMsg && <div style={{ marginTop: 6, fontSize: 12, color: '#185FA5' }}>{wpMsg}</div>}
          </div>

          {/* 导航控制 */}
          <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #eee' }}>
            {!navActive && (
              <button
                disabled={!routes[0]}
                onClick={() => startNav()}
                style={routes[0] ? navStartBtn : { ...navStartBtn, opacity: 0.5 }}
              >
                🧭 开始导航
              </button>
            )}
            {navActive && (
              <button onClick={stopNav} style={{ ...navStartBtn, background: '#d64545', color: '#fff' }}>
                退出导航
              </button>
            )}
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 8, fontSize: 12, color: '#555' }}>
              <input
                type="checkbox"
                checked={navSim}
                onChange={(e) => setNavSim(e.target.checked)}
                disabled={navActive}
              />
              模拟导航（无 GPS 室内预览）
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 12, color: '#555' }}>
              <input
                type="checkbox"
                checked={navFollow}
                onChange={(e) => setNavFollow(e.target.checked)}
                disabled={navActive}
              />
              镜头跟随行进方向
            </label>
            {navMsg && <div style={{ marginTop: 6, fontSize: 12, color: '#185FA5' }}>{navMsg}</div>}
          </div>

          {PMTILES_URL && (
            <>
              <button style={{ marginTop: 8 }} onClick={downloadOffline}>
                下载当前区域离线包
              </button>
              <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>{offlineMsg}</div>
            </>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '12px 0' }} />
          <div style={{ fontWeight: 600, marginBottom: 6 }}>路线对比（A/B 双方案）</div>
          <CoordInput label="A 起点" value={fromC} onChange={setFromC} />
          <CoordInput label="A 终点" value={toC} onChange={setToC} />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button onClick={() => planCompare('A')}>规划 A</button>
            <button onClick={() => planCompare('B')}>规划 B</button>
          </div>
          {routeA && routeB && (
            <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7 }}>
              <div style={{ color: ROUTE_COLORS[0] }}>A：{(routeA.distanceM / 1000).toFixed(1)}km / {Math.round(routeA.durationS / 60)}min</div>
              <div style={{ color: ROUTE_COLORS[1] }}>B：{(routeB.distanceM / 1000).toFixed(1)}km / {Math.round(routeB.durationS / 60)}min</div>
              <div style={{ color: '#555' }}>
                差：{(((routeB.distanceM - routeA.distanceM) / 1000) >= 0 ? '+' : '') +
                  ((routeB.distanceM - routeA.distanceM) / 1000).toFixed(1)}km
              </div>
            </div>
          )}
          <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>{cmpMsg}</div>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '12px 0' }} />
          <div style={{ fontWeight: 600, marginBottom: 6 }}>🌤️ 环境图层（天气 / 空气）</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button
              onClick={() => toggleEnv(!envOn)}
              style={envOn ? { ...navStartBtn, background: '#1D9E75', color: '#fff' } : navStartBtn}
            >
              {envOn ? '关闭环境图层' : '开启环境图层'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            {(['temp', 'aqi', 'precip'] as WeatherMetric[]).map((m) => (
              <button
                key={m}
                disabled={!envOn}
                onClick={() => changeEnvMetric(m)}
                style={envOn && envMetric === m ? chipOn : chipOff}
              >
                {m === 'temp' ? '温度' : m === 'aqi' ? '空气质量' : '降水'}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 12, color: '#555', minHeight: 16 }}>{envMsg}</div>

          {/* 中心实时天气卡片 */}
          {centerWeather && (
            <div
              style={{
                marginTop: 8,
                padding: '8px 10px',
                borderRadius: 8,
                background: '#f4f8fb',
                fontSize: 12,
                lineHeight: 1.8,
              }}
            >
              <div style={{ fontWeight: 600, color: '#185FA5' }}>
                📍 中心天气 · {centerWeather.label}
              </div>
              <div>🌡️ {centerWeather.tempC}°C · 💧 湿度 {centerWeather.humidity}%</div>
              <div>
                🌬️ 风 {centerWeather.windKmh} km/h · 🌧️ 降水 {centerWeather.precipMm} mm
              </div>
              <div>
                🏭 AQI {centerWeather.aqi} · PM2.5 {centerWeather.pm25}
              </div>
            </div>
          )}

          {/* 图例 */}
          {envOn && weatherField.length > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: '#555' }}>
              {envMetric === 'temp' && <EnvLegend stops={[['-10°C', '#2b6cb0'], ['15°C', '#f6e05e'], ['35°C', '#e53e3e']]} />}
              {envMetric === 'aqi' && (
                <EnvLegend stops={[['优 0', '#1a9850'], ['良 100', '#fee08b'], ['差 200', '#d73027'], ['危 300', '#7b3297']]} />
              )}
              {envMetric === 'precip' && <EnvLegend stops={[['0mm', '#dbeafe'], ['3mm', '#2a6fb0'], ['8mm', '#133a8f']]} />}
            </div>
          )}
        </div>
      )}

      {tab === 'ride' && (
        <RidePanel
          onTrack={setLiveTrack}
          onLivePos={handleLivePos}
          onStats={handleStats}
          onRecStatus={handleRecStatus}
          onControls={handleControls}
          onLoadTrack={loadTrack}
          replayTrack={replayTrack}
          replayIdx={replayIdx}
          replaying={replaying}
          replaySpeed={replaySpeed}
          onSeek={seekReplay}
          onTogglePlay={toggleReplay}
          onReplaySpeed={setReplaySpeed}
          library={library}
          onAddTrack={addTrack}
          onRemoveTrack={removeTrack}
          onHeatmap={setHeatmapOn}
          onCompare={(ts) =>
            setCompareTracks(ts.map((t, i) => ({ id: String(t.savedAt), points: t.points.map((p) => ({ lng: p.lng, lat: p.lat })), color: COMPARE_COLORS[i] ?? '#185FA5' })))
          }
        />
      )}

      {tab === 'stats' && (
        <div style={statsCard}>
          <AnnualReport library={library} />
        </div>
      )}

      {tab === 'cloud' && (
        <CloudPanel
          auth={auth}
          localTracks={library.length}
          cloudTracks={cloudTracks}
          lastSyncAt={lastSyncAt}
          syncing={syncing}
          msg={cloudMsg}
          onLogin={(n, p) => void handleAuth('login', n, p)}
          onRegister={(n, p) => void handleAuth('register', n, p)}
          onLogout={() => void handleLogout()}
          onSyncNow={() => void doSync(false)}
        />
      )}

      {tab === 'group' && (
        <GroupPanel
          auth={auth}
          status={groupStatus}
          members={members}
          selfId={selfIdRef.current}
          room={groupRoom}
          msg={groupMsg}
          onRoomChange={setGroupRoom}
          onJoin={() => joinGroup()}
          onLeave={leaveGroup}
          onFocusMate={focusMate}
          onGotoCloud={() => setTab('cloud')}
        />
      )}

      {tab === 'trip' && (
        <TripPlanner
          key={tripVersion}
          center={center}
          onPlan={(rs, ps, switchTab) => {
            if (rs[0]) seedNav(rs[0])
            setRoutes(rs)
            setPois(ps)
            setSelectedPoiId(ps[0]?.id ?? null)
            if (switchTab) setTab('map')
          }}
        />
      )}

      {tab === 'recommend' && (
        <div style={recoCard}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>🧠 智能路线推荐</div>
          <div style={{ fontSize: 12, color: '#555', marginBottom: 6 }}>
            按目标里程 + 风格自动生成候选环线，沿途 POI 丰富度 / 新颖度综合打分
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <span style={{ width: 40 }}>里程</span>
            {[5, 10, 15, 20].map((k) => (
              <button key={k} onClick={() => setSmartTarget(k)} style={smartTarget === k ? chipOn : chipOff}>
                {k}km
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 12 }}>
            <span style={{ width: 40 }}>风格</span>
            {([
              ['leisure', '休闲'],
              ['scenic', '景观'],
              ['food', '美食'],
              ['explore', '探索'],
            ] as [RideStyle, string][]).map(([s, label]) => (
              <button key={s} onClick={() => setSmartStyle(s)} style={smartStyle === s ? chipOn : chipOff}>
                {label}
              </button>
            ))}
          </div>
          <button style={{ marginTop: 8, width: '100%' }} onClick={genSmart}>
            🚴 生成推荐路线
          </button>
          <div style={{ marginTop: 6, fontSize: 12, color: '#185FA5', minHeight: 16 }}>{smartMsg}</div>

          {smartResults.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {smartResults.map((r, i) => (
                <div
                  key={i}
                  onClick={() => pickSmart(i)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    border: `1px solid ${i === smartSel ? '#185FA5' : '#eee'}`,
                    background: i === smartSel ? '#F2F7FC' : '#fff',
                    marginBottom: 6,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600 }}>
                      {i === 0 ? '🥇 ' : i === 1 ? '🥈 ' : '🥉 '}
                      {r.destName}
                    </span>
                    <span style={{ fontSize: 11, color: '#999' }}>分 {r.score.toFixed(2)}</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#444', marginTop: 2 }}>
                    {(r.distanceM / 1000).toFixed(1)}km · {Math.round(r.durationS / 60)}min · 爬升 {Math.round(r.elevationGainM)}m
                    {r.pois.length ? ` · ${r.pois.length}个停靠点` : ''}
                  </div>
                  {i === smartSel && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        startNav(r.route)
                      }}
                      style={{ ...navStartBtn, marginTop: 6, padding: '5px 0', fontSize: 12 }}
                    >
                      🧭 用此路线导航
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '12px 0' }} />

          <div style={{ fontWeight: 600, marginBottom: 6 }}>🔥 上海热门目的地</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {HOT_SPOTS.map((s) => (
              <button key={s.name} onClick={() => gotoSpot(s)} style={chipOff}>
                {s.name}
              </button>
            ))}
          </div>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '12px 0' }} />

          <button onClick={recommendRide}>🚴 为我推荐一条骑行路线</button>
          <div style={{ marginTop: 6, fontSize: 12, color: '#555', minHeight: 16 }}>{recoMsg}</div>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '12px 0' }} />

          <div style={{ fontWeight: 600, marginBottom: 6 }}>周边分类推荐</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {CATEGORIES.map((c) => (
              <button key={c} onClick={() => recommendCategory(c)} style={chipOff}>
                {c}
              </button>
            ))}
          </div>
          <PoiList pois={pois} selectedId={selectedPoiId} onSelect={flyToPoi} />
        </div>
      )}

      {/* 底部导航 HUD */}
      {navActive && navState && (
        <NavHUD state={navState} msg={navMsg} onStop={stopNav} wp={navWp} />
      )}

      {/* 实时录制 HUD：距离/时长/速度/心率 + 暂停/停止/镜头跟随控制 */}
      {recording && recStats && (
        <RecHUD
          stats={recStats}
          paused={recPaused}
          follow={followRec}
          onPause={() => recControlsRef.current?.pause()}
          onResume={() => recControlsRef.current?.resume()}
          onStop={() => recControlsRef.current?.stop()}
          onToggleFollow={() => setFollowRec((v) => !v)}
        />
      )}

      {/* 底部海拔剖面与爬坡分析（悬停联动地图高亮）——录制/导航时让位 */}
      {analysisPoints && !elevHidden && !recording && !navActive && (
        <ElevationProfile
          points={analysisPoints}
          title={replayTrack ? '海拔剖面 · 爬坡分析' : '路线海拔剖面'}
          onHover={setProfileHover}
          onClose={() => {
            setProfileHover(null)
            setElevHidden(true)
          }}
        />
      )}
      {/* 收起后的重开 pill */}
      {analysisPoints && elevHidden && !recording && !navActive && (
        <button data-testid="elev-reopen" style={elevPill} onClick={() => setElevHidden(false)}>
          📈 海拔剖面
        </button>
      )}
    </div>
  )
}

// 底部导航条：剩余距离/时间 + 下一步转向 + 退出
function NavHUD({
  state,
  msg,
  onStop,
  wp,
}: {
  state: NavState
  msg: string
  onStop: () => void
  wp?: { idx: number; total: number; name?: string } | null
}) {
  const m = state.remainingM
  const dist = m >= 1000 ? `${(m / 1000).toFixed(1)} 公里` : `${Math.round(m)} 米`
  const min = Math.max(1, Math.round(state.remainingS / 60))
  const arrow = state.nextManeuver ? MANEUVER_ARROW[state.nextManeuver.maneuver] : '⬆️'
  const turn = state.nextManeuver ? state.nextManeuver.instruction : '直行'
  const turnDist = state.nextManeuver
    ? state.nextManeuver.distanceM >= 1000
      ? `${(state.nextManeuver.distanceM / 1000).toFixed(1)}公里`
      : `${Math.round(state.nextManeuver.distanceM)}米`
    : ''
  const wpText = wp && wp.total > 2 ? `途经点 ${wp.idx}/${wp.total}${wp.name ? ' · ' + wp.name : ''}` : null
  return (
    <div style={navHud}>
      <div style={{ fontSize: 28, width: 36, textAlign: 'center' }}>{arrow}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 18 }}>
          {dist} · 约 {min} 分钟
        </div>
        <div style={{ fontSize: 13, color: '#444', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {turnDist ? `${turnDist}后 ` : ''}
          {turn}
        </div>
        {wpText && (
          <div style={{ fontSize: 12, color: '#185FA5', fontWeight: 600, marginTop: 1 }}>🚩 {wpText}</div>
        )}
        {msg && <div style={{ fontSize: 11, color: '#d64545', marginTop: 2 }}>{msg}</div>}
      </div>
      <button onClick={onStop} style={{ ...tabOff, background: '#d64545', color: '#fff' }}>
        退出
      </button>
    </div>
  )
}

// 实时录制 HUD：地图底部浮层，展示关键指标并提供暂停/停止/跟随控制
function RecHUD({
  stats,
  paused,
  follow,
  onPause,
  onResume,
  onStop,
  onToggleFollow,
}: {
  stats: RideStats
  paused: boolean
  follow: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onToggleFollow: () => void
}) {
  const km = (stats.distanceM / 1000).toFixed(2)
  const m = Math.floor(stats.durationS / 60)
  const s = Math.floor(stats.durationS % 60)
  const dur = `${m}:${s.toString().padStart(2, '0')}`
  const spd = (stats.speed * 3.6).toFixed(1)
  return (
    <div style={recHud} data-testid="rec-hud">
      <div style={{ display: 'flex', gap: 16 }}>
        <div>
          <div style={recBig}>{km}</div>
          <div style={recLbl}>km</div>
        </div>
        <div>
          <div style={recBig}>{dur}</div>
          <div style={recLbl}>时长</div>
        </div>
        <div>
          <div style={recBig}>{spd}</div>
          <div style={recLbl}>km/h</div>
        </div>
        <div>
          <div style={recBig}>{stats.hr ? String(stats.hr) : '—'}</div>
          <div style={recLbl}>bpm</div>
        </div>
        <div>
          <div style={recBig}>{stats.points}</div>
          <div style={recLbl}>采样点</div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {paused ? (
          <button onClick={onResume}>继续</button>
        ) : (
          <button onClick={onPause}>暂停</button>
        )}
        <button onClick={onStop} style={{ ...tabOff, background: '#d64545', color: '#fff' }}>
          停止
        </button>
        <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center', color: '#555' }}>
          <input type="checkbox" checked={follow} onChange={onToggleFollow} />
          镜头跟随
        </label>
        <span style={{ fontSize: 12, color: paused ? '#c08a00' : '#d64545', fontWeight: 600 }}>
          {paused ? '已暂停' : '录制中'}
        </span>
      </div>
    </div>
  )
}

// 地图/推荐共用的 POI 列表：点击飞行 + 选中高亮
function PoiList({
  pois,
  selectedId,
  onSelect,
}: {
  pois: POI[]
  selectedId: string | null
  onSelect: (p: POI) => void
}) {
  if (!pois.length) return null
  return (
    <div style={{ marginTop: 8, maxHeight: 160, overflow: 'auto', fontSize: 12 }}>
      {pois.map((p) => (
        <div
          key={p.id}
          onClick={() => onSelect(p)}
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            padding: '4px 6px',
            borderRadius: 6,
            cursor: 'pointer',
            background: p.id === selectedId ? '#FFF3DD' : 'transparent',
          }}
        >
          <span style={{ flex: 1 }}>📍 {p.name}</span>
          <span style={{ color: '#999', fontSize: 11 }}>{p.category.split(';')[0]}</span>
        </div>
      ))}
    </div>
  )
}

const topBar: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 2,
  display: 'flex',
  gap: 8,
  padding: 8,
  background: 'rgba(255,255,255,.92)',
  boxShadow: '0 1px 4px rgba(0,0,0,.1)',
}

const leftCard: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  left: 12,
  zIndex: 1,
  background: '#fff',
  padding: 12,
  borderRadius: 10,
  width: 248,
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const recoCard: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  left: 12,
  zIndex: 1,
  background: '#fff',
  padding: 12,
  borderRadius: 10,
  width: 260,
  maxHeight: '88%',
  overflow: 'auto',
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const statsCard: React.CSSProperties = {
  position: 'absolute',
  top: 56,
  left: 12,
  zIndex: 1,
  background: '#fff',
  padding: 12,
  borderRadius: 10,
  width: 340,
  maxHeight: '88%',
  overflow: 'auto',
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const navHud: React.CSSProperties = {
  position: 'absolute',
  bottom: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 3,
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  width: 'min(440px, 92%)',
  padding: '10px 14px',
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 4px 16px rgba(0,0,0,.25)',
}

const recHud: React.CSSProperties = {
  position: 'absolute',
  bottom: 18,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 3,
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  alignItems: 'center',
  width: 'min(440px, 92%)',
  padding: '12px 16px',
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 4px 16px rgba(0,0,0,.25)',
}

const elevPill: React.CSSProperties = {
  position: 'absolute',
  bottom: 16,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 3,
  padding: '8px 16px',
  background: '#fff',
  color: '#2c3e50',
  border: 'none',
  borderRadius: 20,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 3px 12px rgba(0,0,0,.2)',
}

const recBig: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 22,
  lineHeight: 1.1,
  textAlign: 'center',
}

const recLbl: React.CSSProperties = {
  fontSize: 11,
  color: '#888',
  textAlign: 'center',
}

const navStartBtn: React.CSSProperties = {
  width: '100%',
  padding: '8px 0',
  borderRadius: 8,
  border: 'none',
  background: '#185FA5',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 14,
  fontWeight: 600,
}

const tabOn: React.CSSProperties = {
  padding: '4px 12px',
  borderRadius: 16,
  border: 'none',
  background: '#185FA5',
  color: '#fff',
  cursor: 'pointer',
}

const tabOff: React.CSSProperties = {
  padding: '4px 12px',
  borderRadius: 16,
  border: 'none',
  background: '#e3e1da',
  color: '#333',
  cursor: 'pointer',
}

const chipOn: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 14,
  border: 'none',
  background: '#185FA5',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
}

const chipOff: React.CSSProperties = {
  padding: '3px 10px',
  borderRadius: 14,
  border: 'none',
  background: '#eef1f4',
  color: '#185FA5',
  cursor: 'pointer',
  fontSize: 12,
}

// 经纬度输入（路线对比用）：lng/lat 两个数字框
function StopRow({
  label,
  name,
  onUp,
  onDown,
  onUse,
  onClear,
}: {
  label: string
  name?: string
  onUp?: () => void
  onDown?: () => void
  onUse?: () => void
  onClear?: () => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, background: '#f6f8fa', borderRadius: 6, padding: '3px 6px' }}>
      <span style={{ fontWeight: 600, color: '#185FA5', minWidth: 56 }}>{label}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#333' }}>
        {name ?? '未设置'}
      </span>
      {onUp && (
        <button style={{ fontSize: 11, padding: '1px 6px' }} onClick={onUp}>
          ↑
        </button>
      )}
      {onDown && (
        <button style={{ fontSize: 11, padding: '1px 6px' }} onClick={onDown}>
          ↓
        </button>
      )}
      {onUse && (
        <button style={{ fontSize: 11, padding: '1px 6px' }} onClick={onUse}>
          当前
        </button>
      )}
      {onClear && (
        <button style={{ fontSize: 11, padding: '1px 6px', color: '#d64545' }} onClick={onClear}>
          删除
        </button>
      )}
    </div>
  )
}

function CoordInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: Coordinate
  onChange: (c: Coordinate) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4, fontSize: 12 }}>
      <span style={{ width: 52 }}>{label}</span>
      <input
        type="number"
        step="0.0001"
        value={Number(value.lng.toFixed(4))}
        onChange={(e) => onChange({ ...value, lng: Number(e.target.value) })}
        style={{ width: 84, fontSize: 12, padding: '2px 4px' }}
      />
      <input
        type="number"
        step="0.0001"
        value={Number(value.lat.toFixed(4))}
        onChange={(e) => onChange({ ...value, lat: Number(e.target.value) })}
        style={{ width: 84, fontSize: 12, padding: '2px 4px' }}
      />
    </div>
  )
}

// 环境图层颜色图例：横向色带 + 端点标签
function EnvLegend({ stops }: { stops: [string, string][] }) {
  const grad = `linear-gradient(to right, ${stops.map((s) => s[1]).join(',')})`
  return (
    <div>
      <div style={{ height: 10, borderRadius: 5, background: grad, marginBottom: 2 }} />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {stops.map((s) => (
          <span key={s[0]}>{s[0]}</span>
        ))}
      </div>
    </div>
  )
}
