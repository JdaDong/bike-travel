import { useEffect, useMemo, useState } from 'react'
import {
  buildAnnualReport,
  availableYears,
  type AnnualReport as Report,
  type Badge,
  type DayCell,
} from '@bike-travel/shared'
import type { SavedTrack } from '../storage'

interface Props {
  library: SavedTrack[]
}

const km = (m: number) => (m / 1000).toFixed(1)
const dur = (s: number) => {
  if (s <= 0) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}
const pace = (be?: { durationS: number; speedKmh: number }) =>
  be ? `${be.speedKmh.toFixed(1)} km/h · ${dur(be.durationS)}` : '—'

// GitHub 风格年度热力日历：以「周」为列、周内 7 天为行，按每日里程分 5 档着色。
function HeatCalendar({ year, cells }: { year: number | 'all'; cells: DayCell[] }) {
  // 'all' 情况下用最近有数据的年份画（否则跨年网格太宽）
  const map = new Map(cells.map((c) => [c.date, c]))
  const yr =
    year === 'all'
      ? cells.length
        ? Number(cells[cells.length - 1].date.slice(0, 4))
        : new Date().getFullYear()
      : year
  const max = Math.max(1, ...cells.filter((c) => c.date.startsWith(String(yr))).map((c) => c.distanceM))

  const start = new Date(yr, 0, 1)
  const end = new Date(yr, 11, 31)
  // 网格从 1/1 所在周的周日开始
  const gridStart = new Date(start)
  gridStart.setDate(start.getDate() - start.getDay())
  const days: { date: string; distanceM: number; inYear: boolean }[] = []
  for (let d = new Date(gridStart); d <= end || d.getDay() !== 0; d.setDate(d.getDate() + 1)) {
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    const hit = map.get(key)
    days.push({ date: key, distanceM: hit?.distanceM ?? 0, inYear: d >= start && d <= end })
    if (d > end && d.getDay() === 6) break
  }
  const weeks = Math.ceil(days.length / 7)
  const cell = 11
  const gap = 2
  const w = weeks * (cell + gap) + 24
  const h = 7 * (cell + gap) + 18

  const color = (m: number, inYear: boolean) => {
    if (!inYear) return '#f4f6f8'
    if (m <= 0) return '#ebedf0'
    const r = m / max
    if (r < 0.25) return '#c6e48b'
    if (r < 0.5) return '#7bc96f'
    if (r < 0.75) return '#40a35a'
    return '#1e6b34'
  }
  const monthLabels: { x: number; label: string }[] = []
  let lastMonth = -1
  days.forEach((d, i) => {
    if (i % 7 === 0) {
      const mo = Number(d.date.slice(5, 7))
      if (mo !== lastMonth && d.inYear) {
        monthLabels.push({ x: 24 + Math.floor(i / 7) * (cell + gap), label: `${mo}月` })
        lastMonth = mo
      }
    }
  })
  const wd = ['日', '一', '二', '三', '四', '五', '六']

  return (
    <svg width={w} height={h} style={{ display: 'block', maxWidth: '100%' }} data-testid="heat-calendar">
      {monthLabels.map((m) => (
        <text key={m.label} x={m.x} y={10} fontSize={8} fill="#888">
          {m.label}
        </text>
      ))}
      {wd.map((label, r) =>
        r % 2 === 1 ? (
          <text key={label} x={0} y={18 + 14 + r * (cell + gap)} fontSize={7} fill="#aaa">
            {label}
          </text>
        ) : null,
      )}
      {days.map((d, i) => {
        const col = Math.floor(i / 7)
        const row = i % 7
        return (
          <rect
            key={d.date}
            x={24 + col * (cell + gap)}
            y={14 + row * (cell + gap)}
            width={cell}
            height={cell}
            rx={2}
            fill={color(d.distanceM, d.inYear)}
          >
            <title>{`${d.date} · ${km(d.distanceM)} km`}</title>
          </rect>
        )
      })}
    </svg>
  )
}

// 月度里程柱状（纯 SVG）
function MonthlyBars({ rows }: { rows: { key: string; distanceM: number }[] }) {
  const w = 300
  const h = 96
  const padB = 16
  const max = Math.max(1, ...rows.map((r) => r.distanceM))
  if (!rows.length) return <div style={{ fontSize: 12, color: '#999' }}>暂无按月数据</div>
  const slot = (w - 8) / rows.length
  const bw = Math.min(22, slot - 3)
  return (
    <svg width={w} height={h} style={{ display: 'block', maxWidth: '100%' }}>
      {rows.map((r, i) => {
        const bh = (r.distanceM / max) * (h - padB - 8)
        const x = 4 + i * slot + (slot - bw) / 2
        return (
          <g key={r.key}>
            <rect x={x} y={h - padB - bh} width={bw} height={bh} rx={2} fill="#4C8BF5" />
            <text x={x + bw / 2} y={h - padB + 10} fontSize={8} fill="#666" textAnchor="middle">
              {r.key.slice(5)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: '#f5f7fa', borderRadius: 8, padding: '8px 10px' }}>
      <div style={{ color: '#888', fontSize: 10 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
      {sub && <div style={{ color: '#aaa', fontSize: 9, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  )
}

function BadgeCell({ b }: { b: Badge }) {
  return (
    <div
      data-testid={b.earned ? 'badge-earned' : 'badge-locked'}
      title={b.desc}
      style={{
        border: `1px solid ${b.earned ? '#f0c419' : '#e5e7eb'}`,
        background: b.earned ? 'linear-gradient(135deg,#fffdf3,#fff6d8)' : '#fafafa',
        borderRadius: 10,
        padding: '8px 8px 10px',
        textAlign: 'center',
        opacity: b.earned ? 1 : 0.7,
      }}
    >
      <div style={{ fontSize: 22, filter: b.earned ? 'none' : 'grayscale(1)' }}>{b.icon}</div>
      <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>{b.name}</div>
      <div style={{ height: 4, background: '#eceff2', borderRadius: 3, marginTop: 5, overflow: 'hidden' }}>
        <div style={{ width: `${Math.round(b.progress * 100)}%`, height: '100%', background: b.earned ? '#f0c419' : '#9aa4af' }} />
      </div>
      <div style={{ fontSize: 8, color: '#999', marginTop: 3 }}>{b.valueText}</div>
    </div>
  )
}

export function AnnualReport({ library }: Props) {
  const years = useMemo(() => availableYears(library), [library])
  const [year, setYear] = useState<number | 'all'>(() => (years.length ? years[0] : 'all'))
  const [showCard, setShowCard] = useState(false)

  // 数据变化后确保选中年份仍有效
  useEffect(() => {
    if (year !== 'all' && years.length && !years.includes(year)) setYear(years[0])
  }, [years, year])

  const report: Report = useMemo(() => buildAnnualReport(library, year), [library, year])

  // 暴露给无头验证做精确数值断言
  useEffect(() => {
    ;(window as unknown as { __report?: Report }).__report = report
  }, [report])

  const earnedCount = report.badges.filter((b) => b.earned).length
  const r = report.records

  if (!library.length) {
    return (
      <div style={{ padding: 16, color: '#888', fontSize: 13 }}>
        还没有骑行记录。去「骑行」Tab 开始录制或导入 GPX，这里会自动生成你的成就与年度报告。
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 2px', overflowY: 'auto' }} data-testid="annual-report">
      {/* 年份切换 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <div style={{ fontWeight: 700, fontSize: 15 }}>🏆 骑行成就</div>
        <select
          data-testid="year-select"
          value={String(year)}
          onChange={(e) => setYear(e.target.value === 'all' ? 'all' : Number(e.target.value))}
          style={{ marginLeft: 'auto', padding: '4px 8px', borderRadius: 8, border: '1px solid #ddd', fontSize: 13 }}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y} 年
            </option>
          ))}
          <option value="all">全部时间</option>
        </select>
      </div>

      {/* 年度四大数字 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Stat label="总里程" value={`${km(report.aggregate.distanceM)} km`} />
        <Stat label="总时长" value={dur(report.aggregate.durationS)} />
        <Stat label="总爬升" value={`${Math.round(report.aggregate.ascentM)} m`} />
        <Stat label="骑行次数" value={`${report.aggregate.count}`} sub={`活跃 ${report.streaks.activeDays} 天`} />
      </div>

      {/* 连续打卡 */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <div style={{ flex: 1, background: '#fff4e6', borderRadius: 8, padding: '6px 10px' }}>
          <div style={{ fontSize: 10, color: '#b26a00' }}>🔥 当前连续</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#e8590c' }}>{report.streaks.currentDays} 天</div>
        </div>
        <div style={{ flex: 1, background: '#fff4e6', borderRadius: 8, padding: '6px 10px' }}>
          <div style={{ fontSize: 10, color: '#b26a00' }}>🌟 最长连续</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#e8590c' }}>{report.streaks.longestDays} 天</div>
        </div>
      </div>

      {/* 年度热力日历 */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 4 }}>骑行日历</div>
        <div style={{ overflowX: 'auto' }}>
          <HeatCalendar year={year} cells={report.calendar} />
        </div>
      </div>

      {/* 月度里程 */}
      <div style={{ marginTop: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 2 }}>按月里程</div>
        <MonthlyBars rows={report.monthly} />
      </div>

      {/* 个人纪录 */}
      <div style={{ marginTop: 12 }} data-testid="records">
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 4 }}>个人纪录</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Stat label="最长单次" value={`${km(r.longestRideM)} km`} sub={r.longestRideName} />
          <Stat label="最大爬升" value={`${Math.round(r.maxAscentM)} m`} sub={r.maxAscentName} />
          <Stat label="最长时长" value={dur(r.longestDurationS)} sub={r.longestDurationName} />
          <Stat label="最高均速" value={`${r.maxAvgSpeedKmh.toFixed(1)} km/h`} sub={r.maxAvgSpeedName} />
          <Stat label="最快 10km" value={pace(r.best10k)} sub={r.best10k?.trackName} />
          <Stat label="最快 5km" value={pace(r.best5k)} sub={r.best5k?.trackName} />
        </div>
      </div>

      {/* 徽章墙 */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 4 }}>
          徽章墙（{earnedCount}/{report.badges.length}）
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {report.badges.map((b) => (
            <BadgeCell key={b.id} b={b} />
          ))}
        </div>
      </div>

      <button
        data-testid="gen-report-card"
        onClick={() => setShowCard(true)}
        style={{
          marginTop: 14,
          width: '100%',
          padding: '10px 0',
          borderRadius: 10,
          border: 'none',
          background: '#185FA5',
          color: '#fff',
          fontWeight: 600,
          fontSize: 14,
          cursor: 'pointer',
        }}
      >
        🖼️ 生成年度报告卡
      </button>

      {showCard && <AnnualReportCard report={report} earnedCount={earnedCount} onClose={() => setShowCard(false)} />}
    </div>
  )
}

// —— 可分享年度报告卡（SVG → PNG）——
function AnnualReportCard({
  report,
  earnedCount,
  onClose,
}: {
  report: Report
  earnedCount: number
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const W = 480
  const H = 320
  const a = report.aggregate
  const title = report.year === 'all' ? '全部时间' : `${report.year} 年度`

  // 迷你月度柱
  const max = Math.max(1, ...report.monthly.map((m) => m.distanceM))
  const bars = report.monthly.slice(0, 12)
  const bx0 = 28
  const bx1 = W - 28
  const by1 = 250
  const by0 = 200
  const slot = (bx1 - bx0) / Math.max(1, bars.length)

  const download = () => {
    setBusy(true)
    const svg = document.getElementById('annual-card-svg') as SVGSVGElement | null
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
          const link = document.createElement('a')
          link.href = url
          link.download = `骑行${title}报告卡.png`.replace(/\s+/g, '_')
          link.click()
          URL.revokeObjectURL(url)
        }
        setBusy(false)
      }, 'image/png')
    }
    img.onerror = () => setBusy(false)
    img.src = svg64
  }

  const bigStats: [string, string][] = [
    [km(a.distanceM), 'km'],
    [String(Math.floor(a.durationS / 3600)), 'h'],
    [String(Math.round(a.ascentM)), 'm↑'],
    [String(a.count), '次'],
  ]

  return (
    <div style={overlay} onClick={onClose}>
      <div style={cardBox} onClick={(e) => e.stopPropagation()} data-testid="report-card">
        <svg id="annual-card-svg" xmlns="http://www.w3.org/2000/svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
          <defs>
            <linearGradient id="abg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#0B3A66" />
              <stop offset="100%" stopColor="#185FA5" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={W} height={H} rx="18" fill="url(#abg)" />
          <text x="28" y="48" fill="#fff" fontSize="26" fontWeight="700">
            🚲 我的{title}骑行报告
          </text>
          <text x="28" y="74" fill="#cfe2f5" fontSize="13">
            连续打卡 {report.streaks.longestDays} 天 · 解锁徽章 {earnedCount}/{report.badges.length}
          </text>

          {bigStats.map(([val, unit], i) => {
            const x = 28 + i * 112
            return (
              <g key={i}>
                <text x={x} y="130" fill="#fff" fontSize="30" fontWeight="700">
                  {val}
                </text>
                <text x={x} y="152" fill="#cfe2f5" fontSize="12">
                  {unit}
                </text>
              </g>
            )
          })}

          <text x="28" y="188" fill="#cfe2f5" fontSize="12">
            月度里程
          </text>
          <rect x="24" y="194" width={W - 48} height={68} rx="10" fill="rgba(255,255,255,.06)" />
          {bars.map((m, i) => {
            const bh = (m.distanceM / max) * (by1 - by0)
            const x = bx0 + i * slot + slot / 2 - 6
            return <rect key={m.key} x={x} y={by1 - bh} width={12} height={bh} rx={2} fill="#7FD1FF" />
          })}

          <text x="28" y="292" fill="#7FD1FF" fontSize="12">
            最长单次 {km(report.records.longestRideM)} km · 最快10km {report.records.best10k ? report.records.best10k.speedKmh.toFixed(1) + ' km/h' : '—'}
          </text>
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
