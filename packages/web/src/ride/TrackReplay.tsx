import type { TrackPoint } from '@bike-travel/shared'

interface Props {
  points: TrackPoint[]
  idx: number
  playing: boolean
  speed: number
  onTogglePlay: () => void
  onSeek: (idx: number) => void
  onSpeed: (s: number) => void
}

const fmtTime = (ms: number): string => {
  if (!ms) return '--:--'
  const d = new Date(ms)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const ss = d.getSeconds().toString().padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

const SPEEDS = [1, 2, 4, 8]

export function TrackReplay({ points, idx, playing, speed, onTogglePlay, onSeek, onSpeed }: Props) {
  const cur = points[Math.min(idx, points.length - 1)]
  const total = points[points.length - 1]
  return (
    <div style={{ marginTop: 8, background: '#fff', border: '1px solid #eee', borderRadius: 8, padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={onTogglePlay} style={{ ...miniBtn, background: '#185FA5', color: '#fff' }}>
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <span style={{ fontSize: 11, color: '#555', fontVariantNumeric: 'tabular-nums' }}>
          {fmtTime(cur?.t)} / {fmtTime(total?.t)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={points.length - 1}
        value={idx}
        onChange={(e) => onSeek(Number(e.target.value))}
        style={{ width: '100%', marginTop: 6 }}
      />
      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
        <span style={{ fontSize: 11, color: '#777', alignSelf: 'center' }}>倍速</span>
        {SPEEDS.map((s) => (
          <button key={s} onClick={() => onSpeed(s)} style={s === speed ? chipOn : chipOff}>
            {s}x
          </button>
        ))}
      </div>
    </div>
  )
}

const miniBtn: React.CSSProperties = {
  border: 'none',
  borderRadius: 6,
  padding: '5px 12px',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 600,
}

const chipOn: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 12,
  border: 'none',
  background: '#185FA5',
  color: '#fff',
  cursor: 'pointer',
  fontSize: 11,
}
const chipOff: React.CSSProperties = {
  padding: '2px 8px',
  borderRadius: 12,
  border: 'none',
  background: '#eef1f4',
  color: '#185FA5',
  cursor: 'pointer',
  fontSize: 11,
}
