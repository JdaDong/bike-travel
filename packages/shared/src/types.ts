// 领域类型：端云共用，一套定义贯穿 Web / Server

export type CRS = 'WGS84' | 'BD09' | 'GCJ02'

export interface Coordinate {
  lng: number
  lat: number
  ele?: number
  crs?: CRS
}

export interface BoundingBox {
  minLng: number
  minLat: number
  maxLng: number
  maxLat: number
}

export type BikePreference = 'fastest' | 'shortest' | 'least_elevation' | 'scenic'

export interface RouteRequest {
  from: Coordinate
  to: Coordinate
  preference: BikePreference
  avoid?: ('highway' | 'ferry' | 'unpaved')[]
}

export type Maneuver =
  | 'depart'
  | 'arrive'
  | 'straight'
  | 'turn_left'
  | 'turn_right'
  | 'slight_left'
  | 'slight_right'
  | 'roundabout'

export interface RouteStep {
  instruction: string
  geometry: Coordinate[]
  distanceM: number
  durationS: number
  maneuver: Maneuver
}

export interface Route {
  id: string
  geometry: Coordinate[]
  distanceM: number
  durationS: number
  elevationGainM: number
  steps: RouteStep[]
  provider: 'osm' | 'amap' | 'demo'
  cached?: boolean // 离线路由回退标记（弱网/无网时使用缓存几何）
}

export interface TrackPoint extends Coordinate {
  t: number // epoch ms
  hr?: number
  cad?: number
  acc?: number // GPS 水平定位精度（米），用于录制时漂移过滤与质量评估
}

export interface Track {
  id: string
  points: TrackPoint[]
  distanceM: number
  elevationGainM: number
}

export interface POI {
  id: string
  name: string
  coord: Coordinate
  category: string
  tags: Record<string, string>
}

export interface DayPlan {
  date: string
  waypoints: (POI | Coordinate)[]
}

export interface Trip {
  id: string
  title: string
  days: DayPlan[]
  pois: POI[]
  routes: Route[]
}

// Provider 契约：高德 / OSM / Demo 都实现它，业务层只认这个接口
export interface GeoProvider {
  name: 'osm' | 'amap' | 'demo'
  route(req: RouteRequest): Promise<Route>
  searchPOI(q: string, near: Coordinate, radiusM?: number): Promise<POI[]>
  geocode(addr: string): Promise<Coordinate>
}

// 从高德 / OSM 等 route step 的 instruction 文本里推断转向类型，
// 用于导航图标与语音播报（高德 v4 骑行接口不返回标准 maneuver 枚举，只能从文案解析）。
export function parseManeuver(text: string): Maneuver {
  const t = text || ''
  if (/掉头|调头|U形|U型/.test(t)) return 'roundabout' // 近似：掉头借用环岛图标
  if (/环岛|环道|转盘|绕环|环形/.test(t)) return 'roundabout'
  if (/左前方|向左前方|靠左|左侧/.test(t)) return 'slight_left'
  if (/右前方|向右前方|靠右|右侧/.test(t)) return 'slight_right'
  if (/左转|向左|左拐|往左/.test(t)) return 'turn_left'
  if (/右转|向右|右拐|往右/.test(t)) return 'turn_right'
  if (/终点|到达|抵达/.test(t)) return 'arrive'
  if (/出发|起点/.test(t)) return 'depart'
  if (/直行|直走|继续|向前|前行/.test(t)) return 'straight'
  return 'straight'
}
