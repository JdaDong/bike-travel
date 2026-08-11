import { useEffect, useRef, useState } from 'react'
import type { Coordinate, Track } from '@bike-travel/shared'
import { gpxToTrack } from '@bike-travel/shared'
import { RideRecorder, type RideStats } from './RideRecorder'
import { RideCharts } from './RideCharts'
import { TrackReplay } from './TrackReplay'
import { RideDashboard } from './RideDashboard'
import { RideShareCard } from './RideShareCard'
import type { SavedTrack } from '../storage'

const fmt = (s: number): string => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

interface Props {
  onTrack?: (track: Coordinate[]) => void
  onLivePos?: (c: Coordinate | null) => void
  onStats?: (s: RideStats) => void
  onRecStatus?: (recording: boolean, paused: boolean) => void
  // 把暂停/继续/停止控制权上抛给 App，供地图底部 HUD 直接驱动内部 recorder
  onControls?: (c: { pause: () => void; resume: () => void; stop: () => void }) => void
  // 记录完成 / 导入 GPX 后，把轨迹交给 App 加载到回放+分析视图
  onLoadTrack?: (track: Track) => void
  // 回放状态由 App 持有（需联动地图），这里只做展示 + 回调
  replayTrack?: Track | null
  replayIdx?: number
  replaying?: boolean
  replaySpeed?: number
  onSeek?: (idx: number) => void
  onTogglePlay?: () => void
  onReplaySpeed?: (s: number) => void
  // 骑行档案库由 App 持有（需联动地图热力图/对比），这里改为受控
  library: SavedTrack[]
  onAddTrack: (t: Track, name?: string) => void
  onRemoveTrack: (savedAt: number) => void
  onHeatmap: (on: boolean) => void
  onCompare: (tracks: SavedTrack[]) => void
}

export function RidePanel({
  onTrack,
  onLivePos,
  onStats,
  onRecStatus,
  onControls,
  onLoadTrack,
  replayTrack,
  replayIdx = 0,
  replaying = false,
  replaySpeed = 1,
  onSeek,
  onTogglePlay,
  onReplaySpeed,
  library,
  onAddTrack,
  onRemoveTrack,
  onHeatmap,
  onCompare,
}: Props) {
  const recRef = useRef<RideRecorder | null>(null)
  const [stats, setStats] = useState<RideStats | null>(null)
  const [recording, setRecording] = useState(false)
  const [paused, setPaused] = useState(false)
  const [hrConnected, setHrConnected] = useState(false)
  const [showCard, setShowCard] = useState(false)
  const [lastTrack, setLastTrack] = useState<Track | null>(null)

  useEffect(() => {
    const rec = new RideRecorder()
    rec.onUpdate = (s) => {
      setStats(s)
      onTrack?.(rec.coordinates.slice()) // 新数组引用，保证地图实时重绘
      onStats?.(s)
      onRecStatus?.(true, s.paused)
      onLivePos?.(rec.livePos)
    }
    recRef.current = rec
    // 上抛控制句柄给 App（仅挂载时一次，捕获的 pause/resume/stop 逻辑稳定）
    onControls?.({ pause, resume, stop })
    return () => {
      rec.stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTrack, onStats, onRecStatus, onLivePos, onControls])

  const start = () => {
    recRef.current!.start()
    setRecording(true)
    setPaused(false)
    setStats(null)
    onRecStatus?.(true, false)
    onLivePos?.(recRef.current!.livePos)
  }
  const pause = () => {
    recRef.current!.pause()
    setPaused(true)
    onRecStatus?.(true, true)
  }
  const resume = () => {
    recRef.current!.resume()
    setPaused(false)
    onRecStatus?.(true, false)
  }
  const stop = () => {
    const track = recRef.current!.stop()
    setRecording(false)
    setPaused(false)
    setLastTrack(track)
    onRecStatus?.(false, false)
    onLivePos?.(null)
    // 命名后入库（不再强制下载 GPX，导出为可选按钮）
    const name = window.prompt('为这次骑行命名：', `骑行 ${new Date().toLocaleString('zh-CN')}`)
    if (name !== null) {
      onAddTrack(track, name.trim() || undefined)
    }
    onLoadTrack?.(track)
  }
  const connectHR = async () => {
    const ok = await recRef.current!.connectHR()
    setHrConnected(ok)
  }

  const saveTrack = (t: Track) => {
    onAddTrack(t)
  }

  // 导入 GPX 文件（兼容第三方导出 / 本应用导出），加载到回放分析
  const importGpx = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const track = gpxToTrack(String(reader.result))
        if (track.points.length < 2) {
          alert('GPX 文件无有效轨迹点')
          return
        }
        saveTrack(track)
        onLoadTrack?.(track)
      } catch (e) {
        alert('GPX 解析失败：' + (e as Error).message)
      }
    }
    reader.readAsText(file)
  }

  const exportGpx = (track: Track) => {
    const gpx = recRef.current!.toGpx(track)
    const blob = new Blob([gpx], { type: 'application/gpx+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${track.id}.gpx`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div style={card}>
      <h3 style={{ margin: '0 0 8px' }}>骑行记录</h3>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {!recording && (
          <button onClick={start}>开始记录</button>
        )}
        {recording && !paused && (
          <button onClick={pause}>暂停</button>
        )}
        {recording && paused && (
          <button onClick={resume}>继续</button>
        )}
        {recording && (
          <button onClick={stop} style={{ background: '#d64545', color: '#fff', border: 'none' }}>
            停止并保存
          </button>
        )}
        {lastTrack && (
          <button onClick={() => exportGpx(lastTrack)}>导出 GPX</button>
        )}
        <button onClick={connectHR} disabled={hrConnected}>
          {hrConnected ? '心率已连接' : '连接心率带'}
        </button>
        <label style={{ ...linkBtn }}>
          导入 GPX
          <input
            type="file"
            accept=".gpx,application/gpx+xml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) importGpx(f)
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: recording ? (paused ? '#c08a00' : '#d64545') : '#888' }}>
        {recording ? (paused ? '⏸ 已暂停（时长冻结）' : '🔴 录制中') : '待机'}
      </div>
      <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.8 }}>
        <div>距离：{(stats ? stats.distanceM / 1000 : 0).toFixed(2)} km</div>
        <div>时长：{fmt(stats?.durationS ?? 0)}</div>
        <div>速度：{(stats ? stats.speed * 3.6 : 0).toFixed(1)} km/h</div>
        <div>爬升：{Math.round(stats?.ascentM ?? 0)} m</div>
        <div>心率：{stats?.hr ? `${stats.hr} bpm` : '—'}</div>
        <div>采样点：{stats?.points ?? 0}</div>
      </div>

      {replayTrack && replayTrack.points.length > 1 && (
        <>
          <button style={{ marginTop: 8, width: '100%' }} onClick={() => setShowCard(true)}>
            🖼️ 生成成绩卡片
          </button>
          <RideCharts points={replayTrack.points} cursorIdx={replayIdx} />
          <TrackReplay
            points={replayTrack.points}
            idx={replayIdx}
            playing={replaying}
            speed={replaySpeed}
            onTogglePlay={onTogglePlay ?? (() => {})}
            onSeek={onSeek ?? (() => {})}
            onSpeed={onReplaySpeed ?? (() => {})}
          />
        </>
      )}
      {showCard && replayTrack && (
        <RideShareCard track={replayTrack} onClose={() => setShowCard(false)} />
      )}
      <p style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
        提示：GPS 需在 https/localhost 下授权；心率带需支持 Bluetooth LE heart_rate。暂停时不会计入时长。
      </p>

      {library.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>我的骑行（{library.length}）</div>
          <div style={{ maxHeight: 150, overflow: 'auto', fontSize: 12 }}>
            {library.map((t) => (
              <div key={t.savedAt} style={libRow}>
                <span
                  style={{ flex: 1, cursor: 'pointer' }}
                  title="点击在地图回放 + 查看图表"
                  onClick={() => onLoadTrack?.(t)}
                >
                  🚲 {t.name} · {(t.distanceM / 1000).toFixed(1)}km · {t.points.length}点
                </span>
                <a style={{ cursor: 'pointer', color: '#c00', marginLeft: 6 }} onClick={() => onRemoveTrack(t.savedAt)}>
                  删
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      <RideDashboard
        library={library}
        onHeatmap={onHeatmap}
        onCompare={onCompare}
        onLoadTrack={(t) => onLoadTrack?.(t)}
      />
    </div>
  )
}

const card: React.CSSProperties = {
  position: 'absolute',
  top: 12,
  right: 12,
  zIndex: 1,
  background: '#fff',
  padding: 14,
  borderRadius: 10,
  width: 240,
  boxShadow: '0 2px 8px rgba(0,0,0,.15)',
}

const linkBtn: React.CSSProperties = {
  padding: '1px 6px',
  borderRadius: 4,
  border: '1px solid #ccc',
  background: '#f5f5f5',
  cursor: 'pointer',
  fontSize: 13,
  alignSelf: 'center',
}

const libRow: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  padding: '4px 6px',
  borderRadius: 6,
  borderBottom: '1px solid #f0f0f0',
}
