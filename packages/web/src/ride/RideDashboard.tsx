import { useMemo, useState } from 'react'
import type { Track } from '@bike-travel/shared'
import { summarizeTrack, type TrackSummary } from '@bike-travel/shared'
import type { SavedTrack } from '../storage'

interface Props {
  library: SavedTrack[]
  onHeatmap: (on: boolean) => void
  onCompare: (tracks: SavedTrack[]) => void
  onLoadTrack: (t: Track) => void
}

const COMPARE_COLORS = ['#185FA5', '#D64545', '#639922']

const km = (m: number) => (m / 1000).toFixed(1)
const dur = (s: number) => {
  if (s <= 0) return '—'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h${m}m` : `${m}m`
}

// 纯 SVG 按月里程柱状图
function MonthlyBars({ rows }: { rows: { key: string; distanceM: number; count: number }[] }) {
  const w = 212
  const h = 92
  const padB = 18
  const max = Math.max(1, ...rows.map((r) => r.distanceM))
  const bw = rows.length ? Math.min(34, (w - 8) / rows.length - 4) : 0
  if (!rows.length) return <div style={{ fontSize: 12, color: '#999', marginTop: 6 }}>暂无按月数据</div>
  return (
    <svg width={w} height={h} style={{ display: 'block', marginTop: 4 }}>
      {rows.map((r, i) => {
        const bh = ((r.distanceM / max) * (h - padB - 6)).toFixed(0)
        const x = 4 + i * ((w - 8) / rows.length) + ((w - 8) / rows.length - bw) / 2
        return (
          <g key={r.key}>
            <rect x={x} y={h - padB - Number(bh)} width={bw} height={bh} rx={2} fill="#4C8BF5" />
            <text x={x + bw / 2} y={h - padB + 10} fontSize={9} fill="#666" textAnchor="middle">
              {r.key.slice(5)}
            </text>
            <text x={x + bw / 2} y={h - padB - Number(bh) - 2} fontSize={8} fill="#333" textAnchor="middle">
              {km(r.distanceM)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function RideDashboard({ library, onHeatmap, onCompare, onLoadTrack }: Props) {
  const [heatOn, setHeatOn] = useState(false)
  const [sel, setSel] = useState<number[]>([])

  const sums: TrackSummary[] = useMemo(() => library.map(summarizeTrack), [library])
  const totals = useMemo(() => {
    return sums.reduce(
      (a, s) => ({
        distanceM: a.distanceM + s.distanceM,
        ascentM: a.ascentM + s.ascentM,
        durationS: a.durationS + s.durationS,
        count: a.count + 1,
      }),
      { distanceM: 0, ascentM: 0, durationS: 0, count: 0 },
    )
  }, [sums])

  const monthly = useMemo(() => {
    const map = new Map<string, { distanceM: number; count: number }>()
    for (const t of library) {
      const s = summarizeTrack(t)
      if (!s.startMs) continue
      const d = new Date(s.startMs)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const cur = map.get(key) ?? { distanceM: 0, count: 0 }
      cur.distanceM += s.distanceM
      cur.count += 1
      map.set(key, cur)
    }
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({ key, ...v }))
  }, [library])

  const avg = totals.count ? { distanceM: totals.distanceM / totals.count, ascentM: totals.ascentM / totals.count } : { distanceM: 0, ascentM: 0 }

  const toggleHeat = () => {
    const next = !heatOn
    setHeatOn(next)
    onHeatmap(next)
  }
  const toggleSel = (savedAt: number) => {
    setSel((prev) => {
      if (prev.includes(savedAt)) return prev.filter((x) => x !== savedAt)
      if (prev.length >= 2) return [prev[1], savedAt]
      return [...prev, savedAt]
    })
  }
  const selectedTracks = library.filter((t) => sel.includes(t.savedAt))
  const selSums = selectedTracks.map(summarizeTrack)

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid #eee', paddingTop: 8 }}>
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 6 }}>📊 骑行数据概览</div>

      {/* 总览卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 12 }}>
        <Stat label="总里程" value={`${km(totals.distanceM)} km`} />
        <Stat label="总爬升" value={`${Math.round(totals.ascentM)} m`} />
        <Stat label="总时长" value={dur(totals.durationS)} />
        <Stat label="骑行次数" value={`${totals.count}`} />
        <Stat label="平均里程" value={`${km(avg.distanceM)} km`} />
        <Stat label="平均爬升" value={`${Math.round(avg.ascentM)} m`} />
      </div>

      {/* 按月里程 */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444' }}>按月里程</div>
        <MonthlyBars rows={monthly} />
      </div>

      {/* 热力图开关 */}
      <button
        onClick={toggleHeat}
        style={{
          marginTop: 6,
          width: '100%',
          padding: '6px 0',
          borderRadius: 8,
          border: 'none',
          background: heatOn ? '#185FA5' : '#eef1f4',
          color: heatOn ? '#fff' : '#185FA5',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {heatOn ? '🔥 关闭运动热力图' : '🗺️ 显示运动热力图'}
      </button>

      {/* 历史对比 */}
      <div style={{ marginTop: 10, borderTop: '1px solid #f0f0f0', paddingTop: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#444' }}>历史对比（选 2 条）</div>
        <div style={{ maxHeight: 110, overflow: 'auto', fontSize: 12, marginTop: 4 }}>
          {library.map((t) => (
            <label key={t.savedAt} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', cursor: 'pointer' }}>
              <input type="checkbox" checked={sel.includes(t.savedAt)} onChange={() => toggleSel(t.savedAt)} />
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} onClick={() => onLoadTrack(t)}>
                {t.name}
              </span>
              <span style={{ color: '#999' }}>{km(t.distanceM)}km</span>
            </label>
          ))}
        </div>
        {sel.length === 2 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={() => onCompare(selectedTracks)} style={{ flex: 1, ...cmpBtn }}>在地图对比</button>
              <button onClick={() => { setSel([]); onCompare([]) }} style={{ flex: 1, ...cmpBtn }}>清除</button>
            </div>
            <CompareTable a={selSums[0]} b={selSums[1]} nameA={selectedTracks[0].name} nameB={selectedTracks[1].name} />
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#f5f7fa', borderRadius: 6, padding: '4px 6px' }}>
      <div style={{ color: '#888', fontSize: 10 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 13 }}>{value}</div>
    </div>
  )
}

function CompareTable({ a, b, nameA, nameB }: { a: TrackSummary; b: TrackSummary; nameA: string; nameB: string }) {
  const rows: { k: string; av: string; bv: string }[] = [
    { k: '里程', av: `${km(a.distanceM)} km`, bv: `${km(b.distanceM)} km` },
    { k: '爬升', av: `${Math.round(a.ascentM)} m`, bv: `${Math.round(b.ascentM)} m` },
    { k: '时长', av: dur(a.durationS), bv: dur(b.durationS) },
    { k: '均速', av: `${a.avgSpeedKmh.toFixed(1)} km/h`, bv: `${b.avgSpeedKmh.toFixed(1)} km/h` },
    { k: '心率', av: a.maxHr ? `${a.maxHr} bpm` : '—', bv: b.maxHr ? `${b.maxHr} bpm` : '—' },
  ]
  return (
    <table style={{ width: '100%', fontSize: 11, marginTop: 6, borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ color: '#666' }}>
          <th style={{ textAlign: 'left' }}>指标</th>
          <th style={{ textAlign: 'right', color: COMPARE_COLORS[0] }}>A</th>
          <th style={{ textAlign: 'right', color: COMPARE_COLORS[1] }}>B</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.k}>
            <td style={{ color: '#888' }}>{r.k}</td>
            <td style={{ textAlign: 'right' }}>{r.av}</td>
            <td style={{ textAlign: 'right' }}>{r.bv}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const cmpBtn: React.CSSProperties = {
  padding: '5px 0',
  borderRadius: 6,
  border: 'none',
  background: '#185FA5',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 12,
}
