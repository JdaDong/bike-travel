import { useState } from 'react'
import type { Track } from '@bike-travel/shared'
import { summarizeTrack } from '@bike-travel/shared'

interface Props {
  track: Track
  title?: string
  onClose: () => void
}

// 两点大圆距离（米），用于从 GPS 点推算瞬时速度，绘制成绩卡剖面
function haversine(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// 把轨迹渲染成一张可分享的成绩卡（SVG），支持导出 PNG。
// 纯前端、零依赖：SVG 序列化后用 Canvas 栅格化下载，避免引入图片库。
export function RideShareCard({ track, title, onClose }: Props) {
  const [busy, setBusy] = useState(false)
  const s = summarizeTrack(track)
  const W = 480
  const H = 300
  const name = title ?? track.id ?? '我的骑行'

  // 剖面数据：优先心率；否则用相邻点推算的瞬时速度（km/h）
  const hasHr = track.points.some((p) => typeof p.hr === 'number')
  const vals: number[] = []
  if (hasHr) {
    for (const p of track.points) if (typeof p.hr === 'number') vals.push(p.hr)
  } else {
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1]
      const b = track.points[i]
      const dt = (b.t - a.t) / 1000
      if (dt > 0) vals.push((haversine(a, b) / dt) * 3.6)
    }
  }
  const maxV = Math.max(...vals, 1)
  const minV = Math.min(...vals, 0)
  const rangeV = Math.max(1, maxV - minV)
  const chartX0 = 28
  const chartX1 = W - 28
  const chartY0 = 170
  const chartY1 = 238
  const profPath =
    vals.length > 1
      ? vals
          .map((v, i) => {
            const x = chartX0 + ((chartX1 - chartX0) * i) / (vals.length - 1)
            const y = chartY1 - ((v - minV) / rangeV) * (chartY1 - chartY0)
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
          })
          .join(' ')
      : ''

  const stats: [string, string][] = [
    [(s.distanceM / 1000).toFixed(1), 'km'],
    [(s.durationS / 60).toFixed(0), 'min'],
    [s.avgSpeedKmh.toFixed(1), 'km/h'],
    [String(s.maxHr ?? '—'), 'bpm'],
    [Math.round(s.ascentM).toString(), 'm↑'],
  ]

  const download = () => {
    setBusy(true)
    const svg = document.getElementById('share-card-svg') as SVGSVGElement | null
    if (!svg) {
      setBusy(false)
      return
    }
    const xml = new XMLSerializer().serializeToString(svg)
    const svg64 = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)))
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = W
      canvas.height = H
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, W, H)
      ctx.drawImage(img, 0, 0, W, H)
      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `${(title ?? track.id ?? 'ride').replace(/\s+/g, '_')}_card.png`
          a.click()
          URL.revokeObjectURL(url)
        }
        setBusy(false)
      }, 'image/png')
    }
    img.onerror = () => setBusy(false)
    img.src = svg64
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={cardBox} onClick={(e) => e.stopPropagation()}>
        <svg id="share-card-svg" xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <defs>
            <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#185FA5" />
              <stop offset="100%" stopColor="#0B3A66" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={W} height={H} rx="18" fill="url(#bg)" />
          <text x="28" y="50" fill="#fff" fontSize="24" fontWeight="700">
            🚲 {name.length > 22 ? name.slice(0, 21) + '…' : name}
          </text>
          <text x="28" y="78" fill="#cfe2f5" fontSize="13">
            骑行成绩 · {new Date(s.startMs || Date.now()).toLocaleDateString('zh-CN')}
          </text>

          {/* 指标 */}
          {stats.map(([val, unit], i) => {
            const x = 28 + i * 92
            return (
              <g key={i}>
                <text x={x} y="130" fill="#fff" fontSize="26" fontWeight="700">
                  {val}
                </text>
                <text x={x} y="150" fill="#cfe2f5" fontSize="11">
                  {unit}
                </text>
              </g>
            )
          })}

          {/* 剖面（心率 / 速度） */}
          <text x="28" y="164" fill="#cfe2f5" fontSize="11">
            {hasHr ? '心率剖面' : '速度剖面'}
          </text>
          <rect x="24" y="160" width={W - 48} height={84} rx="10" fill="rgba(255,255,255,.06)" />
          <path d={profPath} fill="none" stroke="#7FD1FF" strokeWidth="2" />
        </svg>

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={download} disabled={busy}>
            {busy ? '生成中…' : '下载 PNG'}
          </button>
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  )
}

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 20,
  background: 'rgba(0,0,0,.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const cardBox: React.CSSProperties = {
  background: '#fff',
  borderRadius: 14,
  padding: 16,
  width: 'min(520px, 94%)',
  textAlign: 'center',
}
