// 结伴骑行 WebSocket 客户端封装。
//
// 职责：建立 /ws/ride 长连接（token + room 走查询参数），把服务端判别联合消息分派到
// 回调；断线自动重连（指数退避）；应用层 ping/pong 保活并测 RTT。
// 与 UI 解耦：本类不碰 React/DOM，仅通过回调把「成员变化 / 位置更新 / 连接状态」抛出去。

import { parseServerMsg, type LiveMember, type LivePos, type ServerMsg } from '@bike-travel/shared'

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'closed'

export interface LiveHandlers {
  onWelcome?: (self: LiveMember, members: LiveMember[]) => void
  onJoin?: (m: LiveMember) => void
  onLeave?: (id: string) => void
  onPos?: (id: string, pos: LivePos) => void
  onStatus?: (s: LiveStatus) => void
  onError?: (message: string) => void
}

export class LiveClient {
  private ws: WebSocket | null = null
  private manualClose = false
  private retry = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private lastPingAt = 0
  /** 最近一次 ping/pong 往返毫秒，未知为 -1 */
  rtt = -1

  constructor(
    private readonly room: string,
    private readonly token: string,
    private readonly h: LiveHandlers,
  ) {}

  private url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const q = `room=${encodeURIComponent(this.room)}&token=${encodeURIComponent(this.token)}`
    return `${proto}//${location.host}/ws/ride?${q}`
  }

  connect(): void {
    this.manualClose = false
    this.open()
  }

  private open(): void {
    this.h.onStatus?.('connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url())
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.retry = 0
      this.h.onStatus?.('open')
      this.startPing()
    }

    ws.onmessage = (ev) => {
      let raw: unknown
      try {
        raw = JSON.parse(typeof ev.data === 'string' ? ev.data : '')
      } catch {
        return
      }
      const msg = parseServerMsg(raw)
      if (msg) this.dispatch(msg)
    }

    ws.onclose = () => {
      this.stopPing()
      this.ws = null
      if (this.manualClose) {
        this.h.onStatus?.('closed')
        return
      }
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // 具体原因浏览器不暴露；关闭后交给 onclose 处理重连
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
  }

  private dispatch(msg: ServerMsg): void {
    switch (msg.type) {
      case 'welcome':
        this.h.onWelcome?.(msg.self, msg.members)
        break
      case 'join':
        this.h.onJoin?.(msg.member)
        break
      case 'leave':
        this.h.onLeave?.(msg.id)
        break
      case 'pos':
        this.h.onPos?.(msg.id, msg.pos)
        break
      case 'pong':
        if (this.lastPingAt) this.rtt = Date.now() - this.lastPingAt
        break
      case 'error':
        this.h.onError?.(msg.message)
        break
    }
  }

  /** 上报本人位置（连接未就绪时静默丢弃，靠下一次定位回调补发） */
  sendPos(pos: LivePos): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify({ type: 'pos', pos }))
    } catch {
      /* ignore */
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.lastPingAt = Date.now()
      try {
        this.ws.send(JSON.stringify({ type: 'ping', t: this.lastPingAt }))
      } catch {
        /* ignore */
      }
    }, 20000)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return
    this.h.onStatus?.('connecting')
    const delay = Math.min(10000, 1000 * 2 ** this.retry)
    this.retry++
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  close(): void {
    this.manualClose = true
    this.stopPing()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    try {
      this.ws?.close(1000, 'bye')
    } catch {
      /* ignore */
    }
    this.ws = null
    this.h.onStatus?.('closed')
  }
}
