// 结伴骑行实时位置共享：协议类型 + 队伍分析纯函数，零依赖，端（Web 客户端）云（Server 房间）共用。
// 设计要点：
//  1) 消息用「判别联合」（type 字段做 tag），前后端各自 switch 一处即可穷尽处理，编译期查漏。
//  2) 所有坐标一律用 WGS-84（GPS 原始值），投影到底图（GCJ-02）由渲染端负责，协议层不掺杂坐标系。
//  3) 队伍聚散分析（groupSpread）是纯函数：给定成员位置，算质心、最大间距、掉队者，UI 与告警统一口径。
import type { Coordinate } from './types'
import { haversine } from './geo/geometry'

// 单个实时位置样本：经纬度必填，速度(m/s)/航向(度)可选，t 为客户端毫秒时间戳。
export interface LivePos {
  lng: number
  lat: number
  spd?: number // m/s
  hdg?: number // 0–360，正北为 0，顺时针
  t: number // epoch ms
}

// 房间内的一名成员。pos 可能尚未上报（刚加入）。self 仅在下发给本人时标记。
export interface LiveMember {
  id: string
  name: string
  color: string // 稳定色，用于地图标记/列表小圆点
  pos?: LivePos
  joinedAt: number
  self?: boolean
}

// ── 客户端 → 服务端 ────────────────────────────────────────────────────────
// 加入房间在 WebSocket 握手阶段用查询参数完成（room + token），故连接后只需上报位置与心跳。
export interface ClientPosMsg {
  type: 'pos'
  pos: LivePos
}
export interface ClientPingMsg {
  type: 'ping'
  t: number
}
export type ClientMsg = ClientPosMsg | ClientPingMsg

// ── 服务端 → 客户端 ────────────────────────────────────────────────────────
// welcome：连接建立后立即下发，含本人身份、房间号与当前全体成员快照。
export interface ServerWelcomeMsg {
  type: 'welcome'
  self: LiveMember
  room: string
  members: LiveMember[]
}
export interface ServerJoinMsg {
  type: 'join'
  member: LiveMember
}
export interface ServerLeaveMsg {
  type: 'leave'
  id: string
}
// pos：某成员位置更新（含本人回显以外的所有人）。
export interface ServerPosMsg {
  type: 'pos'
  id: string
  pos: LivePos
}
export interface ServerPongMsg {
  type: 'pong'
  t: number // 回带客户端 ping 的 t，便于算 RTT
}
export interface ServerErrorMsg {
  type: 'error'
  code: 'unauthorized' | 'bad_room' | 'server'
  message: string
}
export type ServerMsg =
  | ServerWelcomeMsg
  | ServerJoinMsg
  | ServerLeaveMsg
  | ServerPosMsg
  | ServerPongMsg
  | ServerErrorMsg

// 安全解析：网络来的 JSON 不可信，逐字段校验，失败返回 null 而非抛异常。
export function parseClientMsg(raw: unknown): ClientMsg | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (o.type === 'ping') {
    return { type: 'ping', t: typeof o.t === 'number' ? o.t : Date.now() }
  }
  if (o.type === 'pos') {
    const p = o.pos as Record<string, unknown> | undefined
    if (!p) return null
    const lng = Number(p.lng)
    const lat = Number(p.lat)
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
    if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return null
    const pos: LivePos = { lng, lat, t: typeof p.t === 'number' ? p.t : Date.now() }
    if (Number.isFinite(Number(p.spd))) pos.spd = Number(p.spd)
    if (Number.isFinite(Number(p.hdg))) pos.hdg = ((Number(p.hdg) % 360) + 360) % 360
    return { type: 'pos', pos }
  }
  return null
}

// 安全解析服务端消息（客户端侧用）：只放行已知 type，其余返回 null。
export function parseServerMsg(raw: unknown): ServerMsg | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  switch (o.type) {
    case 'welcome':
    case 'join':
    case 'leave':
    case 'pos':
    case 'pong':
    case 'error':
      return o as unknown as ServerMsg
    default:
      return null
  }
}

// 房间号规整：仅允许字母/数字/连字符，长度 1–24，统一转小写。非法返回空串。
export function normalizeRoom(input: string): string {
  const s = (input ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
  return s.slice(0, 24)
}

// 给定成员 id 稳定生成一个颜色（同一 id 每次同色，无需服务端存储）。
const PALETTE = [
  '#e2564d',
  '#f39c3d',
  '#f6c445',
  '#4caf50',
  '#2bb6a8',
  '#3d7ff3',
  '#7c6cf0',
  '#d857b8',
]
export function colorForId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

// ── 队伍聚散分析 ──────────────────────────────────────────────────────────
export interface GroupSpread {
  count: number // 有位置的成员数
  center?: Coordinate // 质心（有位置者的经纬度平均）
  maxPairM: number // 最大两两间距（米），衡量队伍拉开的程度
  radiusM: number // 到质心最远距离（米）
  laggards: string[] // 掉队者 id：到质心距离 > 阈值
}

/**
 * 计算队伍聚散：质心、最大间距、半径、掉队者。
 * @param members 房间成员（无 pos 者忽略）
 * @param laggardM 掉队阈值（到质心距离，米），默认 300
 */
export function groupSpread(members: LiveMember[], laggardM = 300): GroupSpread {
  const withPos = (members ?? []).filter((m) => m.pos)
  const n = withPos.length
  if (n === 0) return { count: 0, maxPairM: 0, radiusM: 0, laggards: [] }
  if (n === 1) {
    const p = withPos[0].pos!
    return { count: 1, center: { lng: p.lng, lat: p.lat }, maxPairM: 0, radiusM: 0, laggards: [] }
  }

  let sumLng = 0
  let sumLat = 0
  for (const m of withPos) {
    sumLng += m.pos!.lng
    sumLat += m.pos!.lat
  }
  const center: Coordinate = { lng: sumLng / n, lat: sumLat / n }

  let maxPairM = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversine(
        { lng: withPos[i].pos!.lng, lat: withPos[i].pos!.lat },
        { lng: withPos[j].pos!.lng, lat: withPos[j].pos!.lat },
      )
      if (d > maxPairM) maxPairM = d
    }
  }

  let radiusM = 0
  const laggards: string[] = []
  for (const m of withPos) {
    const d = haversine(center, { lng: m.pos!.lng, lat: m.pos!.lat })
    if (d > radiusM) radiusM = d
    if (d > laggardM) laggards.push(m.id)
  }

  return {
    count: n,
    center,
    maxPairM: Math.round(maxPairM),
    radiusM: Math.round(radiusM),
    laggards,
  }
}

// 人性化距离文案（供 HUD/列表复用）。
export function fmtDistance(m: number): string {
  if (!Number.isFinite(m)) return '—'
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`
}
