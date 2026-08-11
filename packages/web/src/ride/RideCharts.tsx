import type { TrackPoint } from '@bike-travel/shared'
import { haversine } from '@bike-travel/shared'

interface Props {
  points: TrackPoint[]
  cursorIdx?: number
  width?: number
}

// 把一组数值缩放到 SVG 折线 path
function buildPath(vals: number[], w: number, h: number, pad = 6): string {
  if (vals.length < 2) return ''
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const span = max - min || 1
  const stepX = w / (vals.length - 1)
  return vals
    .map((v, i) => {
      const x = i * stepX
      const y = h - pad - ((v - min) / span) * (h - pad * 2)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

// 单张迷你折线图（纯 SVG，无第三方依赖）
function Sparkline({
  title,
  color,
  vals,
  unit,
  cursorIdx,
  w,
  h,
}: {
  title: string
  color: string
  vals: number[]
  unit: string
  cursorIdx?: number
  w: number
  h: number
}) {
  const path = buildPath(vals, w, h)
  const cur = cursorIdx != null && vals[cursorIdx] != null ? vals[cursorIdx] : undefined
  const cursorX =
    cursorIdx != null && vals.length > 1 ? (cursorIdx / (vals.length - 1)) * w : undefined
  const cursorY =
    cur != null && vals.length > 1
      ? h -
        6 -
        ((cur - Math.min(...vals)) / (Math.max(...vals) - Math.min(...vals) || 1)) * (h - 12)
      : undefined
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#555' }}>
        <span>{title}</span>
        <span style={{ color }}>
          {cur != null ? `${cur.toFixed(0)} ${unit}` : `${unit}`}
        </span>
      </div>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <path d={path} fill="none" stroke={color} strokeWidth={1.6} />
        {cursorX != null && cursorY != null && (
          <g>
            <line x1={cursorX} y1={0} x2={cursorX} y2={h} stroke="#999" strokeWidth={1} strokeDasharray="2 2" />
            <circle cx={cursorX} cy={cursorY} r={3} fill={color} stroke="#fff" strokeWidth={1} />
          </g>
        )}
      </svg>
    </div>
  )
}

export function RideCharts({ points, cursorIdx, width = 212 }: Props) {
  if (!points || points.length < 2) {
    return <div style={{ fontSize: 12, color: '#999', marginTop: 8 }}>暂无轨迹数据</div>
  }

  // 海拔剖面
  const elev = points.map((p) => p.ele ?? 0)
  // 心率（过滤缺失点）
  const hrVals = points.map((p) => p.hr ?? NaN)
  const hrIdx = hrVals.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0)
  const hrSeries = hrIdx.map((i) => hrVals[i])
  // 速度 (km/h)：相邻点距离 / 时间差
  const spd: number[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const dt = b.t && a.t ? (b.t - a.t) / 1000 : 0
    const d = haversine(a, b)
    spd.push(dt > 0 ? (d / dt) * 3.6 : 0)
  }

  return (
    <div style={{ background: '#fafafa', borderRadius: 8, padding: '6px 8px', marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#333' }}>轨迹分析</div>
      <Sparkline title="海拔" color="#6B8E23" vals={elev} unit="m" cursorIdx={cursorIdx} w={width} h={46} />
      {hrSeries.length > 1 && (
        <Sparkline title="心率" color="#D64545" vals={hrSeries} unit="bpm" cursorIdx={cursorIdx} w={width} h={46} />
      )}
      {spd.length > 1 && (
        <Sparkline title="速度" color="#1A73E8" vals={spd} unit="km/h" cursorIdx={cursorIdx} w={width} h={46} />
      )}
    </div>
  )
}
