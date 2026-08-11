// 骑行记录器：GPS watchPosition 采样 → 实时距离/速度/爬升；可选 Web Bluetooth 心率
import type { Coordinate, Track, TrackPoint } from '@bike-travel/shared'
import { elevationGain, haversine } from '@bike-travel/shared'
import { trackToGpx } from '@bike-travel/shared'

export interface RideStats {
  distanceM: number
  durationS: number
  ascentM: number
  speed: number // m/s
  points: number
  hr?: number
  paused: boolean // 当前是否处于暂停态（时长不计入）
}

// 过滤阈值：低精度（城市峡谷漂移）或极小位移（静止抖动）的点跳过，保证轨迹干净
const ACCURACY_MAX = 35 // 米，超过视为不可信
const MIN_MOVE = 3 // 米，相邻点过近视为未移动

export class RideRecorder {
  private watchId: number | null = null
  private points: TrackPoint[] = []
  private last: TrackPoint | null = null
  private startedAt = 0
  private stoppedAt = 0
  private pausedAt = 0
  private pausedTotalMs = 0
  private lastRaw: Coordinate | null = null // 最近一次 GPS 坐标（无论是否被过滤），用于实时位置标记/镜头跟随
  private hr?: number
  onUpdate?: (s: RideStats) => void

  get isRecording(): boolean {
    return this.watchId !== null || this.pausedAt > 0
  }
  get isPaused(): boolean {
    return this.pausedAt > 0
  }
  // 实时轨迹坐标（供地图绘制，已按精度/位移过滤；不会停止记录）
  get coordinates(): Coordinate[] {
    return this.points
  }
  // 最近一次 GPS 原始坐标（即使被过滤也更新），供录制中蓝点与镜头跟随使用
  get livePos(): Coordinate | null {
    return this.lastRaw
  }

  // 有效录制时长（毫秒）：总时长 - 暂停累计，停止后冻结
  private elapsedMs(): number {
    const end = this.stoppedAt || Date.now()
    return Math.max(0, end - this.startedAt - this.pausedTotalMs)
  }

  start(): void {
    this.startedAt = Date.now()
    this.stoppedAt = 0
    this.pausedAt = 0
    this.pausedTotalMs = 0
    this.points = []
    this.last = null
    this.lastRaw = null
    this.beginWatch()
  }

  // 暂停：保留已采点，仅停止 GPS 监听并记录暂停起点
  pause(): void {
    if (this.watchId == null) return
    navigator.geolocation.clearWatch(this.watchId)
    this.watchId = null
    this.pausedAt = Date.now()
    this.emit()
  }

  // 继续：补偿暂停时长，重新开启 GPS 监听
  resume(): void {
    if (this.watchId != null) return
    if (this.pausedAt > 0) {
      this.pausedTotalMs += Date.now() - this.pausedAt
      this.pausedAt = 0
    }
    this.beginWatch()
    this.emit()
  }

  private beginWatch(): void {
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this.onPos(pos),
      (err) => console.warn('gps error', err),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    )
  }

  private onPos(pos: GeolocationPosition): void {
    const c = pos.coords
    const lng = c.longitude
    const lat = c.latitude
    this.lastRaw = { lng, lat }
    const acc = typeof c.accuracy === 'number' ? c.accuracy : undefined
    // 首点无条件接受（否则在弱信号下永远无法开始）
    const isFirst = this.points.length === 0
    if (!isFirst) {
      if (acc != null && acc > ACCURACY_MAX) return // 精度过低，疑似漂移
      if (this.last && haversine(this.last, { lng, lat }) < MIN_MOVE) return // 位移过小，去抖
    }
    const pt: TrackPoint = {
      lng,
      lat,
      ele: c.altitude ?? undefined,
      t: Date.now(),
      hr: this.hr,
      acc,
    }
    this.points.push(pt)
    this.last = pt
    this.emit()
  }

  setHr(v: number): void {
    this.hr = v
    if (this.last) {
      this.last.hr = v
      this.emit()
    }
  }

  private emit(): void {
    const dist = this.distance()
    const dur = this.elapsedMs() / 1000
    const speed =
      this.points.length > 1
        ? haversine(this.points[this.points.length - 2], this.last!) /
          Math.max(1, (this.last!.t - this.points[this.points.length - 2].t) / 1000)
        : 0
    this.onUpdate?.({
      distanceM: dist,
      durationS: dur,
      ascentM: elevationGain(this.points),
      speed,
      points: this.points.length,
      hr: this.hr,
      paused: this.isPaused,
    })
  }

  private distance(): number {
    return this.points.reduce((s, p, i) => (i ? s + haversine(this.points[i - 1], p) : 0), 0)
  }

  stop(): Track {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId)
    this.watchId = null
    this.pausedAt = 0
    this.stoppedAt = Date.now()
    return {
      id: 'ride-' + Date.now(),
      points: this.points,
      distanceM: this.distance(),
      elevationGainM: elevationGain(this.points),
    }
  }

  toGpx(track: Track): string {
    return trackToGpx(track)
  }

  // 连接蓝牙心率带（heart_rate service），自动解析并在每次采样写入 hr
  async connectHR(): Promise<boolean> {
    try {
      const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] })
      const server = await device.gatt!.connect()
      const service = await server.getPrimaryService('heart_rate')
      const char = await service.getCharacteristic('heart_rate_measurement')
      await char.startNotifications()
      char.addEventListener('characteristicvaluechanged', (e) => {
        const v = (e.target as BluetoothRemoteGATTCharacteristic).value
        if (v) this.setHr(parseHr(v))
      })
      return true
    } catch (e) {
      console.warn('hr connect failed', e)
      return false
    }
  }
}

// HR Measurement 特征值：flags 第 0 位为 1 表示 uint16，否则 uint8
function parseHr(buf: DataView): number {
  const flags = buf.getUint8(0)
  return flags & 0x1 ? buf.getUint16(1, true) : buf.getUint8(1)
}
