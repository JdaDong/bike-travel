import { useEffect, useMemo, useRef, useState } from 'react'
import type { Coordinate } from '@bike-travel/shared'
import {
  buildElevationAnalysis,
  gradeColor,
  GRADE_BUCKETS,
  type ClimbSegment,
  type ProfilePoint,
} from '@bike-travel/shared'

interface Props {
  points: Coordinate[]
  title?: string
  onHover?: (c: Coordinate | null) => void
  onClose?: () => void
  onAnalysis?: (summary: {
    distanceM: number
    totalAscentM: number
    totalDescentM: number
    maxGrade: number
    climbCount: number
    profileLen: number
  }) => void
}

// SVG 画布尺寸（viewBox；实际按容器宽度自适应缩放）
const W = 900
const H = 190
const PAD_L = 44
const PAD_R = 14
const PAD_T = 14
const PAD_B = 26

const km = (m: number) => (m / 1000).toFixed(m < 1000 ? 2 : 1)

function catLabel(c: ClimbSegment): { text: string; color: string } {
  if (c.category) {
    const map: Record<string, string> = { HC: '#8e2b26', C1: '#e2564d', C2: '#f39c3d', C3: '#f6c445', C4: '#4caf50' }
    return { text: c.category === 'HC' ? '超级坡 HC' : `${c.category} 级`, color: map[c.category] }
  }
  return { text: gradeText(c.avgGrade), color: gradeColor(c.avgGrade) }
}

function gradeText(g: number): string {
  if (g >= 15) return '极陡坡'
  if (g >= 12) return '峻坡'
  if (g >= 9) return '陡坡'
  if (g >= 6) return '中坡'
  if (g >= 3) return '缓坡'
  return '平缓'
}

export function ElevationProfile({ points, title, onHover, onClose, onAnalysis }: Props) {
  const { profile, climbs, summary } = useMemo(() => buildElevationAnalysis(points), [points])
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Y 轴（海拔）范围：留一点上下边距，避免曲线贴边
  const eleMin = summary.lowestEle
  const eleMax = summary.highestEle
  const eleSpan = Math.max(1, eleMax - eleMin)
  const yPad = eleSpan * 0.12
  const yLo = eleMin - yPad
  const yHi = eleMax + yPad
  const total = summary.distanceM || 1

  const xOf = (distM: number) => PAD_L + (distM / total) * (W - PAD_L - PAD_R)
  const yOf = (ele: number) => H - PAD_B - ((ele - yLo) / (yHi - yLo)) * (H - PAD_T - PAD_B)
  const baseY = H - PAD_B

  // 为控制 DOM 节点数，显示时最多约 480 个竖条（长轨迹自动降采样）
  const stride = Math.max(1, Math.ceil(profile.length / 480))
  const bars = useMemo(() => {
    const out: { x: number; w: number; y: number; color: string }[] = []
    for (let i = 0; i < profile.length - 1; i += stride) {
      const a = profile[i]
      const b = profile[Math.min(i + stride, profile.length - 1)]
      const x = xOf(a.distM)
      const w = Math.max(0.8, xOf(b.distM) - x + 0.4)
      out.push({ x, w, y: yOf(a.ele), color: gradeColor(a.grade) })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, total, yLo, yHi, stride])

  // 平滑轮廓线（折线）
  const linePath = useMemo(() => {
    if (profile.length < 2) return ''
    return profile
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.distM).toFixed(1)},${yOf(p.ele).toFixed(1)}`)
      .join(' ')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, total, yLo, yHi])

  // Y 轴刻度（海拔）：取 3 档
  const yTicks = useMemo(() => {
    const vals = [eleMin, Math.round((eleMin + eleMax) / 2), eleMax]
    return [...new Set(vals)]
  }, [eleMin, eleMax])

  const nearestIdxByDist = (distM: number): number => {
    // 剖面等距，二分/线性均可；线性足够
    let best = 0
    let bd = Infinity
    for (let i = 0; i < profile.length; i++) {
      const d = Math.abs(profile[i].distM - distM)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    return best
  }

  const setHover = (idx: number | null) => {
    setHoverIdx(idx)
    if (idx == null || !profile[idx]) {
      onHover?.(null)
    } else {
      const p = profile[idx]
      onHover?.({ lng: p.lng, lat: p.lat, crs: 'WGS84' })
    }
  }

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    const px = ((e.clientX - rect.left) / rect.width) * W // 换算回 viewBox 坐标
    const frac = (px - PAD_L) / (W - PAD_L - PAD_R)
    const distM = Math.max(0, Math.min(1, frac)) * total
    setHover(nearestIdxByDist(distM))
  }

  // 暴露测试钩子 + 上抛摘要
  useEffect(() => {
    ;(window as any).__climb = {
      distanceM: summary.distanceM,
      totalAscentM: summary.totalAscentM,
      totalDescentM: summary.totalDescentM,
      maxGrade: summary.maxGrade,
      climbCount: summary.climbCount,
      profileLen: profile.length,
    }
    ;(window as any).__elevHoverFrac = (f: number) => {
      const distM = Math.max(0, Math.min(1, f)) * total
      setHover(nearestIdxByDist(distM))
    }
    onAnalysis?.({
      distanceM: summary.distanceM,
      totalAscentM: summary.totalAscentM,
      totalDescentM: summary.totalDescentM,
      maxGrade: summary.maxGrade,
      climbCount: summary.climbCount,
      profileLen: profile.length,
    })
    return () => {
      delete (window as any).__elevHoverFrac
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary, profile.length])

  const hoverP: ProfilePoint | null = hoverIdx != null ? profile[hoverIdx] ?? null : null

  return (
    <div style={panel} data-testid="elev-panel">
      {/* 顶栏：标题 + 摘要 chips + 关闭 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>📈 {title ?? '海拔剖面'}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
          <Chip label="距离" value={`${km(summary.distanceM)} km`} />
          <Chip label="爬升" value={`${summary.totalAscentM} m`} color="#c0392b" />
          <Chip label="下降" value={`${summary.totalDescentM} m`} color="#2471a3" />
          <Chip label="最陡" value={`${summary.maxGrade.toFixed(1)}%`} color="#e67e22" />
          <Chip label="最高" value={`${summary.highestEle} m`} />
          <Chip label="爬坡段" value={`${summary.climbCount}`} color="#8e44ad" />
        </div>
        {onClose && (
          <button data-testid="elev-close" onClick={onClose} style={closeBtn} title="收起">
            ✕
          </button>
        )}
      </div>

      {/* SVG 剖面图 */}
      <svg
        ref={svgRef}
        data-testid="elev-svg"
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: 'block', width: '100%', height: 'auto', cursor: 'crosshair' }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {/* Y 轴网格 + 刻度 */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD_L} y1={yOf(v)} x2={W - PAD_R} y2={yOf(v)} stroke="#e6e9ee" strokeWidth={1} />
            <text x={PAD_L - 6} y={yOf(v) + 3} fontSize={10} fill="#8a94a3" textAnchor="end">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {/* X 轴刻度（0 / 中点 / 终点 km） */}
        {[0, 0.5, 1].map((f) => {
          const d = total * f
          return (
            <text key={f} x={xOf(d)} y={H - 8} fontSize={10} fill="#8a94a3" textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>
              {km(d)}km
            </text>
          )
        })}

        {/* 爬坡段高亮背景带 */}
        {climbs.map((c, i) => (
          <rect
            key={`cb-${i}`}
            x={xOf(c.startDistM)}
            y={PAD_T}
            width={Math.max(1, xOf(c.endDistM) - xOf(c.startDistM))}
            height={H - PAD_T - PAD_B}
            fill="rgba(230,126,34,.10)"
          />
        ))}

        {/* 按坡度分档着色的面积竖条（Strava 风格） */}
        {bars.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={Math.max(0, baseY - b.y)} fill={b.color} />
        ))}

        {/* 平滑轮廓线 */}
        <path d={linePath} fill="none" stroke="#3a4657" strokeWidth={1.2} opacity={0.7} />

        {/* 爬坡段编号标签 */}
        {climbs.map((c, i) => (
          <text
            key={`cl-${i}`}
            x={(xOf(c.startDistM) + xOf(c.endDistM)) / 2}
            y={PAD_T + 10}
            fontSize={10}
            fill="#b9541b"
            fontWeight={700}
            textAnchor="middle"
          >
            ▲{i + 1}
          </text>
        ))}

        {/* 悬停游标 */}
        {hoverP && (
          <g>
            <line x1={xOf(hoverP.distM)} y1={PAD_T} x2={xOf(hoverP.distM)} y2={baseY} stroke="#333" strokeWidth={1} strokeDasharray="3 2" />
            <circle cx={xOf(hoverP.distM)} cy={yOf(hoverP.ele)} r={4} fill="#fff" stroke="#e67e22" strokeWidth={2} />
          </g>
        )}
      </svg>

      {/* 悬停读数 */}
      <div style={{ height: 18, fontSize: 12, color: '#444', marginTop: 2 }} data-testid="elev-readout">
        {hoverP ? (
          <span>
            距离 <b>{km(hoverP.distM)} km</b>　海拔 <b>{Math.round(hoverP.ele)} m</b>　坡度{' '}
            <b style={{ color: gradeColor(hoverP.grade) }}>{hoverP.grade.toFixed(1)}%</b>
          </span>
        ) : (
          <span style={{ color: '#9aa4b0' }}>在剖面上移动查看该点海拔与坡度（地图同步高亮）</span>
        )}
      </div>

      {/* 坡度图例 */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '4px 0 2px', fontSize: 10, color: '#667' }}>
        {GRADE_BUCKETS.filter((b) => b.key !== 'flat').map((b) => (
          <span key={b.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: b.color, display: 'inline-block' }} />
            {b.label}
          </span>
        ))}
      </div>

      {/* 爬坡段列表 */}
      {climbs.length > 0 ? (
        <div style={{ marginTop: 4, maxHeight: 96, overflow: 'auto' }}>
          {climbs.map((c, i) => {
            const cl = catLabel(c)
            return (
              <div
                key={i}
                data-testid="climb-item"
                onMouseEnter={() => setHover(Math.round((c.startIdx + c.endIdx) / 2))}
                onMouseLeave={() => setHover(null)}
                style={climbRow}
              >
                <span style={{ ...badge, background: cl.color }}>▲{i + 1}</span>
                <span style={{ ...badge, background: cl.color, opacity: 0.85 }}>{cl.text}</span>
                <span style={{ flex: 1, color: '#556' }}>
                  {km(c.lengthM)}km ・ 爬升 {Math.round(c.gainM)}m
                </span>
                <span style={{ color: '#e67e22', fontWeight: 600 }}>均 {c.avgGrade.toFixed(1)}%</span>
                <span style={{ color: '#999', marginLeft: 6 }}>max {c.maxGrade.toFixed(0)}%</span>
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: '#9aa4b0', marginTop: 4 }}>未识别到明显爬坡段（多为平缓路线）</div>
      )}
    </div>
  )
}

function Chip({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span style={{ background: '#f2f5f8', borderRadius: 6, padding: '2px 7px', fontSize: 11, color: '#556' }}>
      {label} <b style={{ color: color ?? '#222' }}>{value}</b>
    </span>
  )
}

const panel: React.CSSProperties = {
  position: 'absolute',
  bottom: 14,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 3,
  width: 'min(900px, 96%)',
  background: '#fff',
  borderRadius: 12,
  boxShadow: '0 4px 20px rgba(0,0,0,.22)',
  padding: '10px 14px',
}

const closeBtn: React.CSSProperties = {
  border: 'none',
  background: '#eef1f4',
  color: '#556',
  borderRadius: 6,
  width: 24,
  height: 24,
  cursor: 'pointer',
  fontSize: 12,
  lineHeight: '24px',
  padding: 0,
}

const climbRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 12,
  padding: '3px 4px',
  borderRadius: 6,
  cursor: 'pointer',
}

const badge: React.CSSProperties = {
  color: '#fff',
  borderRadius: 5,
  padding: '1px 6px',
  fontSize: 10,
  fontWeight: 700,
  whiteSpace: 'nowrap',
}
