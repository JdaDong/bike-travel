// 轨迹统计：从 Track 派生一组成果指标，供骑行仪表盘 / 历史对比 / 档案库复用同一口径。
import type { Track } from './types'

export interface TrackSummary {
  distanceM: number
  ascentM: number
  durationS: number
  avgSpeedKmh: number
  maxHr?: number
  pointCount: number
  startMs: number
  endMs: number
}

// 从一段 Track 计算成果指标。时长由首末点的时间戳推算（无时间戳则记为 0）。
export function summarizeTrack(t: Track): TrackSummary {
  const pts = t.points
  const startMs = pts.length ? pts[0].t : 0
  const endMs = pts.length ? pts[pts.length - 1].t : 0
  let dur = (endMs - startMs) / 1000
  if (!Number.isFinite(dur) || dur < 0) dur = 0
  const avgSpeedKmh = dur > 0 ? (t.distanceM / dur) * 3.6 : 0
  let maxHr: number | undefined
  for (const p of pts) {
    if (typeof p.hr === 'number' && (maxHr === undefined || p.hr > maxHr)) maxHr = p.hr
  }
  return {
    distanceM: t.distanceM,
    ascentM: t.elevationGainM,
    durationS: dur,
    avgSpeedKmh: avgSpeedKmh,
    maxHr,
    pointCount: pts.length,
    startMs,
    endMs,
  }
}
