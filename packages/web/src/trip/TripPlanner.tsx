import { useEffect, useRef, useState } from 'react'
import type { Coordinate, POI, Route } from '@bike-travel/shared'
import { searchPOI } from '../api'
import { getRouteSmart } from '../offline/routeCache'
import { loadJSON, saveJSON, KEYS } from '../storage'

interface Waypoint {
  poi: POI
  day: number
}

// 行程整体结构（持久化到 localStorage）
// updatedAt 参与云同步的 Last-Write-Wins 比较：行程是单文档、会被反复编辑，
// 无法逐字段合并，只能按「谁改得更晚」取胜。
interface SavedTrip {
  title: string
  waypoints: Waypoint[]
  updatedAt?: number
}

interface DaySummary {
  day: number
  distanceM: number
  durationS: number
  elevationGainM: number
  color: string
}

interface Props {
  center?: Coordinate
  // switchTab=false 用于刷新后自动恢复（不强行切到地图 Tab）
  onPlan?: (routes: Route[], pois: POI[], switchTab?: boolean) => void
}

const DEFAULT_CENTER: Coordinate = { lng: 121.4737, lat: 31.2304, crs: 'WGS84' }

// 与 MapView.ROUTE_COLORS 保持一致，使行程卡片的「第 N 天」色块与地图路线同色
const DAY_COLORS = ['#185FA5', '#639922', '#993C1D', '#534AB7', '#BA7517']
const RECO_RADIUS = 1500
const RECO_CATS = ['景点', '美食', '咖啡', '休息站']

// 把某天内相邻段的 route 合并为一条（geometry 拼接去重衔接点、指标累加），
// 这样每天只产生 1 条 Route，MapView 会按天序自动赋予不同颜色。
function mergeDayRoute(day: number, segs: Route[]): Route {
  let geometry: Coordinate[] = []
  let distanceM = 0
  let durationS = 0
  let elevationGainM = 0
  const steps: Route['steps'] = []
  for (const s of segs) {
    geometry = geometry.length ? [...geometry, ...s.geometry.slice(1)] : s.geometry
    distanceM += s.distanceM
    durationS += s.durationS
    elevationGainM += s.elevationGainM
    steps.push(...s.steps)
  }
  return {
    id: `day-${day}`,
    geometry,
    distanceM,
    durationS,
    elevationGainM,
    steps,
    provider: segs[0]?.provider ?? 'demo',
  }
}

export function TripPlanner({ center = DEFAULT_CENTER, onPlan }: Props) {
  const [title, setTitle] = useState('我的骑行旅游行程')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<POI[]>([])
  // 行程持久化：刷新页面后从 localStorage 恢复（兼容旧版纯数组结构）
  const [waypoints, setWaypoints] = useState<Waypoint[]>(() => {
    const raw = loadJSON<unknown>(KEYS.trips, null)
    if (Array.isArray(raw)) return raw as Waypoint[]
    const saved = raw as SavedTrip | null
    if (saved && saved.waypoints) {
      if (saved.title) setTitle(saved.title)
      return saved.waypoints
    }
    return []
  })
  const [day, setDay] = useState(1)
  const [planning, setPlanning] = useState(false)
  const [status, setStatus] = useState('')

  // 沿途推荐：每个途经点展开的候选列表
  const [recoFor, setRecoFor] = useState<number | null>(null)
  const [recoCat, setRecoCat] = useState('景点')
  const [recoItems, setRecoItems] = useState<POI[]>([])
  const [recoMsg, setRecoMsg] = useState('')

  // 每天的路线汇总（用于分享文本 & 卡片展示距离）
  const [daySummaries, setDaySummaries] = useState<DaySummary[]>([])

  // 分享弹层
  const [showShare, setShowShare] = useState(false)
  const [shareText, setShareText] = useState('')

  // 途经点/标题变更即落盘（localStorage）
  useEffect(() => {
    saveJSON(KEYS.trips, { title, waypoints, updatedAt: Date.now() } as SavedTrip)
  }, [title, waypoints])

  // 刷新后若存在完整行程（>=2 途经点），自动重新规划路线恢复地图
  const didInitRef = useRef(false)
  useEffect(() => {
    if (didInitRef.current) return
    didInitRef.current = true
    if (waypoints.length >= 2) void plan(false)
    // 仅在挂载时执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const doSearch = async () => {
    if (!query.trim()) return
    try {
      const r = await searchPOI(query, center)
      setResults(r)
    } catch (e) {
      setStatus('搜索失败: ' + (e as Error).message)
    }
  }

  const add = (poi: POI) => {
    setWaypoints((w) => [...w, { poi, day }])
    setResults([])
    setQuery('')
  }

  const remove = (idx: number) => setWaypoints((w) => w.filter((_, i) => i !== idx))

  // 途经点排序（上移/下移）与所属「天」编辑
  const move = (idx: number, dir: -1 | 1) => {
    setWaypoints((w) => {
      const j = idx + dir
      if (j < 0 || j >= w.length) return w
      const next = [...w]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }
  const setWpDay = (idx: number, d: number) => {
    setWaypoints((w) => w.map((x, i) => (i === idx ? { ...x, day: Math.max(1, d) } : x)))
  }

  // 在某点之后插入候选（用于沿途推荐），插入点归属该点所在的「天」
  const insertAfter = (idx: number, poi: POI) => {
    const ref = waypoints[idx]
    const newWp: Waypoint = { poi, day: ref?.day ?? day }
    setWaypoints((w) => {
      const next = [...w]
      next.splice(idx + 1, 0, newWp)
      return next
    })
    setRecoFor(null)
    setRecoItems([])
  }

  const plan = async (switchTab = true) => {
    if (waypoints.length < 2) {
      setStatus('至少需要 2 个途经点')
      return
    }
    setPlanning(true)
    setStatus('规划中…')
    try {
      // 按天分组：组内相邻点连成当天路线，跨天不连
      const byDay = new Map<number, Waypoint[]>()
      for (const w of waypoints) {
        if (!byDay.has(w.day)) byDay.set(w.day, [])
        byDay.get(w.day)!.push(w)
      }
      const days = [...byDay.keys()].sort((a, b) => a - b)
      const routes: Route[] = []
      const summaries: DaySummary[] = []
      for (const d of days) {
        const ws = byDay.get(d)!
        if (ws.length < 2) continue // 单点天不生成路线
        const segs: Route[] = []
        for (let i = 0; i < ws.length - 1; i++) {
          segs.push(await getRouteSmart(ws[i].poi.coord, ws[i + 1].poi.coord))
        }
        const merged = mergeDayRoute(d, segs)
        const dayIndex = routes.length
        routes.push(merged)
        summaries.push({
          day: d,
          distanceM: merged.distanceM,
          durationS: merged.durationS,
          elevationGainM: merged.elevationGainM,
          color: DAY_COLORS[dayIndex % DAY_COLORS.length],
        })
      }
      if (!routes.length) {
        setStatus('没有可连的行程（每天至少需要 2 个点）')
        return
      }
      setDaySummaries(summaries)
      onPlan?.(routes, waypoints.map((w) => w.poi), switchTab)
      setStatus(`已规划 ${days.length} 天行程，共 ${routes.length} 段路线`)
    } catch (e) {
      setStatus('规划失败: ' + (e as Error).message)
    } finally {
      setPlanning(false)
    }
  }

  // 沿途推荐：搜索某点附近 POI（支持分类切换）
  const recommendNear = async (idx: number, cat = '景点') => {
    const wp = waypoints[idx]
    if (!wp) return
    setRecoFor(idx)
    setRecoCat(cat)
    setRecoMsg(`正在搜索「${cat}」…`)
    try {
      const list = await searchPOI(cat, wp.poi.coord, RECO_RADIUS)
      const filtered = list.filter((p) => p.id !== wp.poi.id).slice(0, 6)
      setRecoItems(filtered)
      setRecoMsg(`附近找到 ${filtered.length} 个「${cat}」`)
    } catch (e) {
      setRecoMsg('推荐失败: ' + (e as Error).message)
    }
  }

  // 生成分享文本（标题 + 每天途经点 + 距离/时长/爬升汇总）
  const buildShareText = (): string => {
    const days = [...new Set(waypoints.map((w) => w.day))].sort((a, b) => a - b)
    const lines: string[] = []
    lines.push(`🚴 ${title}`)
    lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}`)
    lines.push('')
    let totalDist = 0
    let totalDur = 0
    for (const d of days) {
      const ws = waypoints.filter((w) => w.day === d)
      lines.push(`第 ${d} 天`)
      ws.forEach((w, i) =>
        lines.push(`  ${i + 1}. ${w.poi.name}${w.poi.category ? '（' + w.poi.category.split(';')[0] + '）' : ''}`),
      )
      const s = daySummaries.find((x) => x.day === d)
      if (s) {
        lines.push(
          `  路线：约 ${(s.distanceM / 1000).toFixed(1)} km / ${Math.round(s.durationS / 60)} 分钟 / 爬升 ${Math.round(
            s.elevationGainM,
          )} m`,
        )
        totalDist += s.distanceM
        totalDur += s.durationS
      }
      lines.push('')
    }
    lines.push(`全程合计：约 ${(totalDist / 1000).toFixed(1)} km / ${Math.round(totalDur / 60)} 分钟`)
    return lines.join('\n')
  }

  const openShare = () => {
    setShareText(buildShareText())
    setShowShare(true)
  }

  // 预下载离线路线：把每段途经点的规划结果写入本地缓存，无网也能导航
  const predownloadOffline = async () => {
    if (waypoints.length < 2) {
      setStatus('至少需要 2 个途经点才能预下载')
      return
    }
    setStatus('正在预下载离线路线…')
    try {
      let n = 0
      for (let i = 0; i < waypoints.length - 1; i++) {
        await getRouteSmart(waypoints[i].poi.coord, waypoints[i + 1].poi.coord)
        n++
      }
      setStatus(`已缓存 ${n} 段路线到本地，飞行模式也能导航`)
    } catch (e) {
      setStatus('预下载失败: ' + (e as Error).message)
    }
  }

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareText)
      setStatus('已复制到剪贴板')
    } catch {
      setStatus('复制失败，请手动选择文本')
    }
  }

  const downloadBlob = (content: string, filename: string, mime: string) => {
    if (typeof document === 'undefined') return
    const blob = new Blob([content], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  // 按天分组（保留全局 idx 供删除/推荐使用）
  const days = [...new Set(waypoints.map((w) => w.day))].sort((a, b) => a - b)
  const groups = days.map((d) => ({
    day: d,
    items: waypoints.map((w, i) => ({ w, i })).filter((x) => x.w.day === d),
    summary: daySummaries.find((s) => s.day === d),
  }))

  return (
    <div style={card}>
      <h3 style={{ margin: '0 0 8px' }}>旅游行程</h3>

      {/* 行程标题（用于分享/导出） */}
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="给行程起个名字"
        style={{ width: '100%', fontSize: 13, padding: '4px 6px', boxSizing: 'border-box' }}
      />

      {/* 搜索添加途经点 */}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          value={query}
          placeholder="搜索地点，如：咖啡 / 博物馆"
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, fontSize: 13, padding: '4px 6px' }}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <button onClick={doSearch}>搜</button>
      </div>
      {results.map((p) => (
        <div key={p.id} style={resRow}>
          <span style={{ flex: 1 }}>{p.name}</span>
          <button onClick={() => add(p)}>添加</button>
        </div>
      ))}

      {/* 选择「第几天」后添加的点归属该天 */}
      <div style={{ marginTop: 8, fontSize: 13 }}>
        添加到第{' '}
        <input
          type="number"
          min={1}
          value={day}
          onChange={(e) => setDay(Math.max(1, Number(e.target.value)))}
          style={{ width: 44 }}
        />{' '}
        天 · 共 {waypoints.length} 个途经点
      </div>

      {/* 按天分组展示 */}
      <div style={{ marginTop: 8, maxHeight: '42%', overflow: 'auto' }}>
        {groups.length === 0 && <div style={{ fontSize: 12, color: '#999' }}>还没有途经点，先搜索添加吧</div>}
        {groups.map((g) => (
          <div key={g.day} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600 }}>
              <span style={{ width: 10, height: 10, borderRadius: 2, background: g.summary?.color ?? '#ccc' }} />
              第 {g.day} 天
              {g.summary && (
                <span style={{ fontWeight: 400, color: '#666', fontSize: 12 }}>
                  {(g.summary.distanceM / 1000).toFixed(1)}km / {Math.round(g.summary.durationS / 60)}min
                </span>
              )}
            </div>
            <ol style={{ fontSize: 12, paddingLeft: 18, margin: '4px 0' }}>
              {g.items.map(({ w, i }) => (
                <li key={i}>
                  {w.poi.name}{' '}
                  <a style={{ cursor: 'pointer', color: '#185FA5' }} onClick={() => recommendNear(i)}>
                    附近
                  </a>{' '}
                  <a style={{ cursor: 'pointer', color: '#0a7d3b' }} onClick={() => move(i, -1)} title="上移">
                    ↑
                  </a>{' '}
                  <a style={{ cursor: 'pointer', color: '#0a7d3b' }} onClick={() => move(i, 1)} title="下移">
                    ↓
                  </a>{' '}
                  <span style={{ fontSize: 11, color: '#666' }}>
                    第
                    <input
                      type="number"
                      min={1}
                      value={w.day}
                      onChange={(e) => setWpDay(i, Number(e.target.value))}
                      style={{ width: 38, fontSize: 11 }}
                    />
                    天
                  </span>{' '}
                  <a style={{ cursor: 'pointer', color: '#c00' }} onClick={() => remove(i)}>
                    删
                  </a>
                  {/* 沿途推荐候选 */}
                  {recoFor === i && (
                    <div style={recoBox}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {RECO_CATS.map((c) => (
                          <button
                            key={c}
                            onClick={() => recommendNear(i, c)}
                            style={recoCat === c ? chipOn : chipOff}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                      <div style={{ fontSize: 11, color: '#555', margin: '4px 0' }}>{recoMsg}</div>
                      {recoItems.map((p) => (
                        <div key={p.id} style={resRow}>
                          <span style={{ flex: 1 }}>📍 {p.name}</span>
                          <button onClick={() => insertAfter(i, p)}>插入</button>
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>

      <button onClick={() => plan()} disabled={planning} style={{ width: '100%', marginTop: 4 }}>
        规划行程路线
      </button>
      <button onClick={predownloadOffline} style={{ width: '100%', marginTop: 6 }}>
        💾 下载离线路线
      </button>
      <button onClick={openShare} style={{ width: '100%', marginTop: 6 }} disabled={!waypoints.length}>
        🔗 分享 / 导出
      </button>
      <div style={{ marginTop: 6, fontSize: 12, color: '#555' }}>{status}</div>

      {/* 分享弹层 */}
      {showShare && (
        <div style={overlay} onClick={() => setShowShare(false)}>
          <div style={shareCard} onClick={(e) => e.stopPropagation()}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>行程分享 / 导出</div>
            <textarea readOnly value={shareText} style={shareTextarea} />
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button onClick={copyShare}>复制文本</button>
              <button
                onClick={() => downloadBlob(shareText, 'trip.txt', 'text/plain')}
                disabled={!shareText}
              >
                下载 .txt
              </button>
              <button
                onClick={() =>
                  downloadBlob(
                    JSON.stringify({ title, waypoints, daySummaries, generatedAt: new Date().toISOString() }, null, 2),
                    'trip.json',
                    'application/json',
                  )
                }
                disabled={!waypoints.length}
              >
                下载 .json
              </button>
              <span style={{ flex: 1 }} />
              <button onClick={() => setShowShare(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const card: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  left: 12,
  zIndex: 1,
  background: '#fff',
  padding: 14,
  borderRadius: 10,
  width: 278,
  maxHeight: '92%',
  overflow: 'auto',
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const resRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  fontSize: 12,
  marginTop: 4,
}

const recoBox: React.CSSProperties = {
  marginTop: 4,
  padding: 6,
  background: '#f5f7fa',
  borderRadius: 6,
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 10,
  background: 'rgba(0,0,0,.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const shareCard: React.CSSProperties = {
  background: '#fff',
  borderRadius: 12,
  padding: 16,
  width: 'min(420px, 92%)',
  maxHeight: '86%',
  overflow: 'auto',
}

const shareTextarea: React.CSSProperties = {
  width: '100%',
  height: 220,
  fontSize: 12,
  fontFamily: 'monospace',
  padding: 8,
  boxSizing: 'border-box',
  borderRadius: 6,
  border: '1px solid #ddd',
  resize: 'vertical',
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
