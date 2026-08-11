import { Component, useEffect, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Coordinate, LiveMember, POI, Route } from '@bike-travel/shared'
import { wgs84ToGcj02 } from '@bike-travel/shared'
import { projectOnRoute } from '../nav/nav'
import { PMTILES_URL } from '../config'
import { Protocol } from 'pmtiles'
import { createOfflinePMTiles } from '../offline/offline'
import { pmtilesStyle } from './pmtilesStyle'
import type { WeatherCell, WeatherMetric } from '../api'

// 在线街道级矢量底图（OpenFreeMap：免 key、WGS-84）
export const ONLINE_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

// 高德栅格底图：wprd0X 是 Autonavi 公开瓦片 CDN，免 key。注意瓦片为 GCJ-02，
// 因此渲染时凡落在高德底图上的 WGS-84 数据都要实时转 GCJ-02（见 project()）。
export const AMAP_STYLE: any = {
  version: 8,
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sources: {
    amap: {
      type: 'raster',
      tiles: [
        'https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
        'https://wprd02.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
        'https://wprd03.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
        'https://wprd04.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}',
      ],
      tileSize: 256,
      attribution: '© 高德地图 Autonavi',
    },
  },
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#eaeaea' } },
    { id: 'amap', type: 'raster', source: 'amap' },
  ],
}

let protocolRegistered = false
function ensureProtocol(): void {
  if (protocolRegistered) return
  const p = new Protocol()
  maplibregl.addProtocol('pmtiles', p.tile as any)
  if (PMTILES_URL) p.add(createOfflinePMTiles(PMTILES_URL))
  protocolRegistered = true
}

// 定位/搜索结果「水滴针」所需的动画样式（脉冲光环 + 落点），仅注入一次。
let pinStyleInjected = false
function ensurePinStyle(): void {
  if (pinStyleInjected || typeof document === 'undefined') return
  if (document.getElementById('bike-pin-style')) {
    pinStyleInjected = true
    return
  }
  const s = document.createElement('style')
  s.id = 'bike-pin-style'
  s.textContent =
    '@keyframes bike-pin-pulse{0%{transform:scale(.5);opacity:.55}70%{opacity:0}100%{transform:scale(2.4);opacity:0}}' +
    '.bike-pin-pulse{animation:bike-pin-pulse 1.8s ease-out infinite}' +
    '@keyframes bike-pin-drop{0%{transform:translateY(-14px) scale(.7);opacity:0}60%{transform:translateY(2px) scale(1.06)}100%{transform:translateY(0) scale(1);opacity:1}}' +
    '.bike-pin-drop{animation:bike-pin-drop .35s ease-out}'
  document.head.appendChild(s)
  pinStyleInjected = true
}

// 初始中心：上海人民广场（WGS-84）
export const SHANGHAI_CENTER: [number, number] = [121.4737, 31.2304]

function styleFor(basemap: string): any {
  if (basemap === 'amap') return AMAP_STYLE
  if (basemap === 'pmtiles' && PMTILES_URL) return pmtilesStyle(PMTILES_URL)
  return ONLINE_STYLE
}

export interface Pin {
  coord: Coordinate
  color: string
  label?: string
}

interface Props {
  basemap?: 'amap' | 'online' | 'pmtiles'
  center?: [number, number]
  routes?: Route[]
  pois?: POI[]
  liveTrack?: Coordinate[]
  pins?: Pin[]
  onMap?: (map: maplibregl.Map) => void
  onMapClick?: (c: Coordinate) => void
  selectedPoiId?: string
  onPoiClick?: (poi: POI) => void
  navPos?: Coordinate // 导航中当前位置（蓝点箭头）
  navHeading?: number // 朝向（度，0=北），用于箭头旋转
  heatPoints?: Coordinate[] // 运动热力图：所有轨迹点（密度着色叠加层）
  compareTracks?: { id: string; points: Coordinate[]; color: string }[] // 历史对比：多条轨迹多色叠加
  weatherField?: WeatherCell[] // 环境图层：bbox 网格天气/空气采样点
  weatherMetric?: WeatherMetric // 当前展示的指标（温度/空气质量/降水）
  livePos?: Coordinate // 录制中当前位置（绿色脉冲点），区别于导航蓝点
  followLive?: boolean // 录制时镜头是否跟随当前位置（默认开启）
  hoverPos?: Coordinate // 海拔剖面悬停联动高亮点（红色圆环）
  mates?: LiveMember[] // 结伴骑行：队友实时位置（各自专属色 + 名字标签）
}

const ROUTE_COLORS = ['#185FA5', '#639922', '#993C1D', '#534AB7', '#BA7517']

export function MapViewInner({
  basemap = 'amap',
  center = SHANGHAI_CENTER,
  routes,
  pois,
  liveTrack,
  pins,
  onMap,
  onMapClick,
  selectedPoiId,
  onPoiClick,
  navPos,
  navHeading,
  heatPoints,
  compareTracks,
  weatherField,
  weatherMetric,
  livePos,
  followLive,
  hoverPos,
  mates,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<maplibregl.Marker[]>([])
  const pinMarkersRef = useRef<maplibregl.Marker[]>([])
  const navMarkerRef = useRef<maplibregl.Marker | null>(null)
  const framedRef = useRef<string>('') // 已框选的路线签名，避免每次 GPS tick 都 fitBounds 抖动
  const weatherFramedRef = useRef<string>('') // 环境图层框选签名
  const livePosMarkerRef = useRef<maplibregl.Marker | null>(null) // 录制中当前位置标记
  const hoverMarkerRef = useRef<maplibregl.Marker | null>(null) // 海拔剖面联动高亮标记
  const matesMarkersRef = useRef<maplibregl.Marker[]>([]) // 结伴骑行：队友标记
  const [ready, setReady] = useState(false)

  // 高德底图是 GCJ-02，其余底图是 WGS-84。业务数据统一存 WGS-84，
  // 仅在高德底图上显示时投影到 GCJ-02，保证叠加层与瓦片对齐。
  const isAmap = basemap === 'amap'
  const project = (c: Coordinate): [number, number] => {
    if (isAmap) {
      const g = wgs84ToGcj02(c.lng, c.lat)
      return [g.lng, g.lat]
    }
    return [c.lng, c.lat]
  }

  // 底图变化时重建地图（同时解决原 guard 导致切底图不生效的问题）
  const onMapRef = useRef(onMap)
  onMapRef.current = onMap
  const onMapClickRef = useRef(onMapClick)
  onMapClickRef.current = onMapClick
  const onPoiClickRef = useRef(onPoiClick)
  onPoiClickRef.current = onPoiClick

  useEffect(() => {
    if (!containerRef.current) return
    ensureProtocol()
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleFor(basemap),
      center,
      zoom: 11,
    })
    map.addControl(new maplibregl.NavigationControl())
    mapRef.current = map
    map.on('load', () => setReady(true))
    onMapRef.current?.(map)
    if (onMapClickRef.current) {
      map.on('click', (e) => onMapClickRef.current!({ lng: e.lngLat.lng, lat: e.lngLat.lat, crs: 'WGS84' }))
    }
    return () => {
      map.remove()
      mapRef.current = null
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap])

  // 画路线 / 实时轨迹
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return

    const drawLine = (id: string, coords: Coordinate[], color: string) => {
      const data: any = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: coords.map((c) => project(c)) },
          },
        ],
      }
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data)
      else {
        map.addSource(id, { type: 'geojson', data })
        map.addLayer({ id: id + '-l', type: 'line', source: id, paint: { 'line-color': color, 'line-width': 5 } })
      }
    }

    // 导航中：把第一条路线按当前位置切成「已走(灰) + 未走(蓝)」
    if (navPos && routes?.[0]) {
      const pr = projectOnRoute(routes[0], navPos)
      const g = routes[0].geometry
      const passed = [...g.slice(0, pr.segIndex + 1), pr.nearest]
      const remain = [pr.nearest, ...g.slice(pr.segIndex + 1)]
      drawLine('nav-passed', passed, '#c9c9c9')
      drawLine('nav-remain', remain, '#185FA5')
    } else {
      // 未导航时清掉导航分段图层
      for (const id of ['nav-passed', 'nav-remain']) {
        if (map.getLayer(id + '-l')) map.removeLayer(id + '-l')
        if (map.getSource(id)) map.removeSource(id)
      }
    }

    routes?.forEach((r, i) => {
      if (navPos && i === 0) return // 第 0 条由 nav-passed/nav-remain 接管
      drawLine(`route-${i}`, r.geometry, ROUTE_COLORS[i % ROUTE_COLORS.length])
    })
    if (liveTrack && liveTrack.length > 1) drawLine('live-track', liveTrack, '#1D9E75')

    // 仅在「路线集合」发生变化时框选一次，避免导航中每次 GPS tick 都重新 fitBounds 造成镜头抖动
    const sig = (routes ?? []).map((r) => r.id).join('|') + (liveTrack ? '|L' : '') + '|' + basemap
    if (sig !== framedRef.current) {
      framedRef.current = sig
      const all: Coordinate[] = [...(routes?.flatMap((r) => r.geometry) ?? []), ...(liveTrack ?? [])]
      if (all.length > 1) {
        const b = new maplibregl.LngLatBounds()
        all.forEach((c) => b.extend(project(c)))
        map.fitBounds(b, { padding: 60, maxZoom: 15 })
      }
    }
  }, [routes, liveTrack, ready, basemap, navPos])

  // 画 POI 标记（支持选中高亮 + 点击回调，使地图与列表互通）
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []
    pois?.forEach((p) => {
      const selected = p.id === selectedPoiId
      const size = selected ? 20 : 14
      const el = document.createElement('div')
      el.style.cssText =
        `width:${size}px;height:${size}px;border-radius:50%;cursor:pointer;` +
        `background:${selected ? '#F5A623' : '#D4537E'};` +
        `border:${selected ? '3px solid #fff' : '2px solid #fff'};` +
        `box-shadow:0 0 0 1px #999${selected ? ',0 0 8px 2px rgba(245,166,35,.7)' : ''}`
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        onPoiClickRef.current?.(p)
      })
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat(project(p.coord))
        .setPopup(new maplibregl.Popup({ offset: 14 }).setText(`${p.name}\n${p.category}`))
      marker.addTo(map)
      markersRef.current.push(marker)
    })
  }, [pois, ready, basemap, selectedPoiId])

  // 画通用标记（定位点 / 搜索结果）：醒目水滴针 + 常驻名字气泡 + 脉冲光环 + 落点动画
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !pins) return
    ensurePinStyle()
    pinMarkersRef.current.forEach((m) => m.remove())
    pinMarkersRef.current = []
    pins.forEach((p) => {
      const color = p.color || '#D4537E'
      // 外层：交给 maplibregl 负责定位（会被加 transform），不要在这里放动画
      const el = document.createElement('div')
      el.style.cssText = 'position:relative;width:30px;height:44px;cursor:pointer;'
      // 内层：承载落点动画，避免覆盖 maplibregl 的定位 transform
      const inner = document.createElement('div')
      inner.className = 'bike-pin-drop'
      inner.style.cssText = 'position:relative;width:100%;height:100%;'

      // 脉冲光环：绕针帽扩散，吸引视线
      const halo = document.createElement('div')
      halo.className = 'bike-pin-pulse'
      halo.style.cssText =
        `position:absolute;left:50%;top:15px;width:24px;height:24px;` +
        `margin-left:-12px;margin-top:-12px;border-radius:50%;background:${color};`

      // 水滴针 SVG（针尖在底部，锚点 bottom 精确对位）
      const NS = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(NS, 'svg')
      svg.setAttribute('width', '30')
      svg.setAttribute('height', '44')
      svg.setAttribute('viewBox', '0 0 24 36')
      const path = document.createElementNS(NS, 'path')
      path.setAttribute('d', 'M12 35 C12 35 1 22 1 12 A11 11 0 1 1 23 12 C23 22 12 35 12 35 Z')
      path.setAttribute('fill', color)
      path.setAttribute('stroke', '#fff')
      path.setAttribute('stroke-width', '2.5')
      const dot = document.createElementNS(NS, 'circle')
      dot.setAttribute('cx', '12')
      dot.setAttribute('cy', '12')
      dot.setAttribute('r', '4.6')
      dot.setAttribute('fill', '#fff')
      svg.appendChild(path)
      svg.appendChild(dot)

      inner.appendChild(halo)
      inner.appendChild(svg)

      // 常驻名字气泡：始终显示（区别于点击才弹的 popup）
      if (p.label) {
        const lb = document.createElement('div')
        lb.textContent = p.label
        lb.style.cssText =
          `position:absolute;left:50%;top:-11px;transform:translateX(-50%);white-space:nowrap;` +
          `font-size:12px;font-weight:600;color:#fff;background:${color};padding:2px 8px;` +
          `border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.6);`
        inner.appendChild(lb)
      }

      el.appendChild(inner)
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(project(p.coord))
        .setPopup(new maplibregl.Popup({ offset: 26 }).setText(p.label ?? ''))
      marker.addTo(map)
      pinMarkersRef.current.push(marker)
    })
  }, [pins, ready, basemap])

  // 导航当前位置：蓝色箭头（指向行进方向）
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    navMarkerRef.current?.remove()
    navMarkerRef.current = null
    if (!navPos) return
    const el = document.createElement('div')
    el.textContent = '▲'
    el.style.cssText =
      `font-size:20px;line-height:20px;color:#185FA5;text-shadow:0 0 3px #fff;` +
      `transform:rotate(${navHeading ?? 0}deg);transform-origin:50% 50%`
    const marker = new maplibregl.Marker({ element: el }).setLngLat(project(navPos))
    marker.addTo(map)
    navMarkerRef.current = marker
  }, [navPos, navHeading, ready, basemap])

  // 录制中当前位置：绿色脉冲点（区别于导航蓝色箭头），始终反映最新 GPS 采样
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    livePosMarkerRef.current?.remove()
    livePosMarkerRef.current = null
    if (!livePos) return
    const el = document.createElement('div')
    el.style.cssText =
      'width:14px;height:14px;border-radius:50%;background:#1D9E75;border:3px solid #fff;' +
      'box-shadow:0 0 0 4px rgba(29,158,117,.4);'
    const marker = new maplibregl.Marker({ element: el }).setLngLat(project(livePos))
    marker.addTo(map)
    livePosMarkerRef.current = marker
  }, [livePos, ready, basemap])

  // 录制镜头跟随：开启时每收到 GPS 点平滑平移到当前位置（不旋转、不倾斜，保持正北向上）
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !followLive || !livePos) return
    map.easeTo({ center: [livePos.lng, livePos.lat], zoom: 15, duration: 400, bearing: 0, pitch: 0 })
  }, [livePos, followLive, ready, basemap])

  // 海拔剖面联动：在剖面上悬停时，地图对应位置显示红色圆环高亮点
  // （区别于导航蓝箭头 / 录制绿脉冲 / 回放橙点）。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    hoverMarkerRef.current?.remove()
    hoverMarkerRef.current = null
    if (!hoverPos) return
    const el = document.createElement('div')
    el.className = 'elev-hover-marker'
    el.style.cssText =
      'width:16px;height:16px;border-radius:50%;background:#fff;' +
      'border:4px solid #e2564d;box-shadow:0 0 0 3px rgba(226,86,77,.35);'
    const marker = new maplibregl.Marker({ element: el }).setLngLat(project(hoverPos))
    marker.addTo(map)
    hoverMarkerRef.current = marker
  }, [hoverPos, ready, basemap])

  // 结伴骑行：队友实时位置标记（每人专属色 + 名字气泡，锚点在圆点底部）。
  // 队友位置更新频繁，采用「全清 + 重建」策略（队伍规模小，开销可忽略）。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    for (const mk of matesMarkersRef.current) mk.remove()
    matesMarkersRef.current = []
    if (!mates || mates.length === 0) return
    for (const m of mates) {
      if (!m.pos) continue
      const color = m.color || '#3d7ff3'
      const el = document.createElement('div')
      el.className = 'mate-marker'
      el.setAttribute('data-mate', m.id)
      el.style.cssText = 'display:flex;flex-direction:column;align-items:center;cursor:pointer;'
      const label = document.createElement('div')
      label.textContent = m.name
      label.style.cssText =
        `font-size:11px;font-weight:600;color:#fff;background:${color};` +
        'padding:1px 6px;border-radius:8px;white-space:nowrap;max-width:96px;overflow:hidden;' +
        'text-overflow:ellipsis;box-shadow:0 1px 3px rgba(0,0,0,.35);margin-bottom:2px;'
      const dot = document.createElement('div')
      dot.style.cssText =
        `width:16px;height:16px;border-radius:50%;background:${color};` +
        `border:3px solid #fff;box-shadow:0 0 0 3px ${color}55;`
      el.appendChild(label)
      el.appendChild(dot)
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(project(m.pos))
      marker.addTo(map)
      matesMarkersRef.current.push(marker)
    }
  }, [mates, ready, basemap])

  // 运动热力图：把所有轨迹点作为点要素喂给 MapLibre heatmap 图层，
  // 重叠点自动累加密度，形成“常去路段”热力分布。开启时自动框选到全部点。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const SRC = 'ride-heat'
    const LYR = 'ride-heat-l'
    if (heatPoints && heatPoints.length > 0) {
      const data: any = {
        type: 'FeatureCollection',
        features: heatPoints.map((c) => ({
          type: 'Feature',
          properties: { weight: 1 },
          geometry: { type: 'Point', coordinates: project(c) },
        })),
      }
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data)
      else {
        map.addSource(SRC, { type: 'geojson', data })
        map.addLayer({
          id: LYR,
          type: 'heatmap',
          source: SRC,
          paint: {
            'heatmap-weight': ['get', 'weight'],
            'heatmap-intensity': 1.2,
            'heatmap-radius': 22,
            'heatmap-opacity': 0.75,
            'heatmap-color': [
              'interpolate',
              ['linear'],
              ['heatmap-density'],
              0, 'rgba(0,80,255,0)',
              0.2, 'rgba(0,120,255,0.6)',
              0.4, 'rgba(0,220,200,0.7)',
              0.6, 'rgba(120,230,40,0.8)',
              0.8, 'rgba(255,200,0,0.9)',
              1, 'rgba(255,40,0,1)',
            ],
          },
        })
      }
      const b = new maplibregl.LngLatBounds()
      heatPoints.forEach((c) => b.extend(project(c)))
      map.fitBounds(b, { padding: 60, maxZoom: 14 })
    } else {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
    }
  }, [heatPoints, ready, basemap])

  // 历史对比：把选中的多条轨迹以不同颜色叠加在地图上，便于直观比较线路差异
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const ids = (compareTracks ?? []).map((t) => t.id)
    // 清掉旧的对比图层（id 不在当前集合里的）
    const prefix = 'cmp-'
    const existing = map.getStyle().layers?.filter((l) => l.id.startsWith(prefix)).map((l) => l.id) ?? []
    for (const id of existing) {
      if (!ids.includes(id.slice(prefix.length))) {
        if (map.getLayer(id)) map.removeLayer(id)
        if (map.getSource(id)) map.removeSource(id)
      }
    }
    ;(compareTracks ?? []).forEach((t) => {
      const id = prefix + t.id
      const data: any = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: t.points.map((c) => project(c)) },
          },
        ],
      }
      const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data)
      else {
        map.addSource(id, { type: 'geojson', data })
        map.addLayer({ id: id + '-l', type: 'line', source: id, paint: { 'line-color': t.color, 'line-width': 4 } })
      }
    })
    if (ids.length > 0) {
      const b = new maplibregl.LngLatBounds()
      ;(compareTracks ?? []).forEach((t) => t.points.forEach((c) => b.extend(project(c))))
      map.fitBounds(b, { padding: 60, maxZoom: 14 })
    }
  }, [compareTracks, ready, basemap])

  // 环境图层：把天气/空气网格点渲染为按指标着色的圆形（重叠形成连续场感）。
  // 颜色随 weatherMetric 切换：温度(蓝→红) / 空气质量(绿→紫) / 降水(透明→蓝)。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const SRC = 'weather-cells'
    const LYR = 'weather-cells-l'
    if (weatherField && weatherField.length > 0 && weatherMetric) {
      const fieldName =
        weatherMetric === 'temp' ? 'tempC' : weatherMetric === 'aqi' ? 'aqi' : 'precipMm'
      const data: any = {
        type: 'FeatureCollection',
        features: weatherField
          .filter((c) => Number.isFinite((c as any)[fieldName]))
          .map((c) => ({
            type: 'Feature',
            properties: { tempC: c.tempC, aqi: c.aqi, precipMm: c.precipMm, windKmh: c.windKmh },
            geometry: { type: 'Point', coordinates: project({ lng: c.lng, lat: c.lat, crs: 'WGS84' }) },
          })),
      }
      const src = map.getSource(SRC) as maplibregl.GeoJSONSource | undefined
      if (src) src.setData(data)
      else {
        const colorExpr: any =
          weatherMetric === 'temp'
            ? ['interpolate', ['linear'], ['get', 'tempC'], -10, '#2b6cb0', 0, '#63b3ed', 15, '#f6e05e', 25, '#f6ad55', 35, '#e53e3e']
            : weatherMetric === 'aqi'
            ? ['interpolate', ['linear'], ['get', 'aqi'], 0, '#1a9850', 50, '#a6d96a', 100, '#fee08b', 150, '#fdae61', 200, '#d73027', 300, '#7b3297']
            : ['interpolate', ['linear'], ['get', 'precipMm'], 0, '#dbeafe', 1, '#7cb9e8', 3, '#2a6fb0', 8, '#133a8f']
        map.addSource(SRC, { type: 'geojson', data })
        map.addLayer({
          id: LYR,
          type: 'circle',
          source: SRC,
          paint: {
            'circle-color': colorExpr,
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 16, 12, 38],
            'circle-opacity': 0.55,
            'circle-stroke-width': 0,
          },
        })
      }
      // 仅在图层集合变化时框选一次，避免干扰导航/路线镜头
      const sig = weatherMetric + '|' + (weatherField ?? []).map((c) => `${c.lng.toFixed(3)},${c.lat.toFixed(3)}`).join(';')
      if (sig !== weatherFramedRef.current) {
        weatherFramedRef.current = sig
        const b = new maplibregl.LngLatBounds()
        weatherField.forEach((c) => b.extend(project({ lng: c.lng, lat: c.lat, crs: 'WGS84' })))
        map.fitBounds(b, { padding: 60, maxZoom: 13 })
      }
    } else {
      if (map.getLayer(LYR)) map.removeLayer(LYR)
      if (map.getSource(SRC)) map.removeSource(SRC)
      weatherFramedRef.current = ''
    }
  }, [weatherField, weatherMetric, ready, basemap])

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
}

// WebGL/底图异常时不白屏：显示友好提示，避免整个应用崩溃
class MapErrorBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false }
  static getDerivedStateFromError(): { error: boolean } {
    return { error: true }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[MapView] render failed:', error, info)
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#eef1f4',
            color: '#555',
            font: '14px sans-serif',
            textAlign: 'center',
            padding: 24,
          }}
        >
          地图加载失败：浏览器可能未启用 WebGL（请在设置中开启「硬件加速」或更换现代浏览器）。
        </div>
      )
    }
    return this.props.children
  }
}

export const MapView = (props: Props) => (
  <MapErrorBoundary>
    <MapViewInner {...props} />
  </MapErrorBoundary>
)
