// 结伴骑行 WebSocket 房间服务。
//
// 为什么用 noServer 模式：项目已有一个 Fastify(http) 实例在 3000 端口提供 REST，
// 我们不另起端口，而是挂到同一个 Node http.Server 的 'upgrade' 事件上，只接管
// 路径 /ws/ride 的握手，其余升级请求直接拒绝。这样前端开发代理与生产部署都只需
// 一个端口，且复用已有的 Bearer-token 账户体系做鉴权。
//
// 鉴权：浏览器 WebSocket 无法自定义请求头，故 token 通过查询参数 ?token= 传入，
// 用与 REST 相同的 userByToken 解析。房间以 ?room= 指定。
//
// 房间模型：rooms: Map<room, Map<userId, Client>>。一个用户在一个房间内只保留一条
// 连接（多设备重连会顶掉旧连接），成员身份 = 账户身份，天然去重。
//
// 心跳：两层。①ws 协议层 ping/pong 帧 + alive 标志，30s 探测并清理僵死连接；
// ②应用层 {type:'ping'}→{type:'pong'} 供客户端算 RTT / 保活代理。

import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import {
  colorForId,
  normalizeRoom,
  parseClientMsg,
  type LiveMember,
  type ServerMsg,
} from '@bike-travel/shared'
import { userByToken, type PublicUser } from '../store/db'

interface Client {
  ws: WebSocket
  member: LiveMember
  alive: boolean
}

type Room = Map<string, Client> // userId -> Client

const rooms = new Map<string, Room>()

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* 发送失败（连接已断）忽略，close 事件会做清理 */
  }
}

// 向房间内广播；exceptId 用于跳过消息来源自身。
function broadcast(room: Room, msg: ServerMsg, exceptId?: string): void {
  for (const [id, c] of room) {
    if (id === exceptId) continue
    send(c.ws, msg)
  }
}

function memberSnapshot(room: Room): LiveMember[] {
  return [...room.values()].map((c) => c.member)
}

function onConnection(ws: WebSocket, user: PublicUser, roomName: string): void {
  let room = rooms.get(roomName)
  if (!room) {
    room = new Map()
    rooms.set(roomName, room)
  }

  // 同一用户多设备：顶掉旧连接，保证成员唯一
  const existing = room.get(user.id)
  if (existing && existing.ws !== ws) {
    try {
      existing.ws.close(4001, 'replaced')
    } catch {
      /* ignore */
    }
  }

  const member: LiveMember = {
    id: user.id,
    name: user.name,
    color: colorForId(user.id),
    joinedAt: Date.now(),
  }
  const client: Client = { ws, member, alive: true }
  room.set(user.id, client)

  // 欢迎：下发自身身份 + 房间全体快照（self 标记本人那一条）
  const snapshot = memberSnapshot(room).map((m) =>
    m.id === user.id ? { ...m, self: true } : m,
  )
  send(ws, { type: 'welcome', self: { ...member, self: true }, room: roomName, members: snapshot })

  // 通知房间里其他人：有人加入
  broadcast(room, { type: 'join', member }, user.id)

  ws.on('pong', () => {
    client.alive = true
  })

  ws.on('message', (data) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }
    const msg = parseClientMsg(parsed)
    if (!msg) return
    if (msg.type === 'ping') {
      send(ws, { type: 'pong', t: msg.t })
      return
    }
    // pos：更新本人位置并广播给其他人（本人已知自身位置，无需回显）
    client.member.pos = msg.pos
    broadcast(room!, { type: 'pos', id: user.id, pos: msg.pos }, user.id)
  })

  const cleanup = (): void => {
    const r = rooms.get(roomName)
    if (!r) return
    // 仅当当前存的就是这条连接才移除（避免顶号后误删新连接）
    if (r.get(user.id) === client) {
      r.delete(user.id)
      broadcast(r, { type: 'leave', id: user.id })
      if (r.size === 0) rooms.delete(roomName)
    }
  }
  ws.on('close', cleanup)
  ws.on('error', cleanup)
}

/**
 * 把 WebSocket 房间服务挂到 Fastify 底层 http.Server 上。
 * 需在 app.server 存在后调用（Fastify() 构造后即可，无需等 listen）。
 */
export function registerLiveShare(server: Server): void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = ''
    let params: URLSearchParams
    try {
      const u = new URL(req.url ?? '', 'http://localhost')
      pathname = u.pathname
      params = u.searchParams
    } catch {
      socket.destroy()
      return
    }
    if (pathname !== '/ws/ride') {
      // 非本服务路径：拒绝，避免 socket 悬挂泄漏
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const room = normalizeRoom(params.get('room') ?? '')
    if (!room) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const user = userByToken(params.get('token') ?? undefined)
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, user, room)
    })
  })

  // 心跳巡检：清理僵死连接（对端断网但未发 close 帧）
  const timer = setInterval(() => {
    for (const room of rooms.values()) {
      for (const c of room.values()) {
        if (!c.alive) {
          try {
            c.ws.terminate()
          } catch {
            /* ignore */
          }
          continue
        }
        c.alive = false
        try {
          c.ws.ping()
        } catch {
          /* ignore */
        }
      }
    }
  }, 30000)
  timer.unref?.()

  wss.on('close', () => clearInterval(timer))
}

/** 仅供测试/调试：返回各房间人数快照 */
export function liveStats(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [name, room] of rooms) out[name] = room.size
  return out
}
