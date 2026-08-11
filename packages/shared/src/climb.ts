// 海拔剖面与爬坡分析：纯函数、零依赖，端（Web）云（Server）共用同一口径。
// 设计要点：GPS 高程噪声很大，必须先「等距重采样 + 移动平均平滑」再算坡度，
// 否则相邻点抖动会算出荒谬的瞬时坡度。爬坡段识别用「峰值 + 回落容差」抵抗途中小起伏。
import type { Coordinate } from './types'
import { haversine } from './geo/geometry'

// 剖面上的一个采样点：累计距离、平滑海拔、原始海拔、到下一点的坡度%、经纬度（供地图联动）。
export interface ProfilePoint {
  distM: number
  ele: number
  eleRaw: number
  grade: number // 百分比坡度（正=上坡，负=下坡）
  lng: number
  lat: number
}

// 坡度分档：用于剖面着色与爬坡段标签（只区分上坡强度；下坡/平路归 flat）。
export type GradeBucket = 'flat' | 'easy' | 'moderate' | 'hard' | 'steep' | 'extreme'

export const GRADE_BUCKETS: { key: GradeBucket; min: number; label: string; color: string }[] = [
  { key: 'flat', min: -Infinity, label: '平缓', color: '#9fb3c8' },
  { key: 'easy', min: 3, label: '缓坡 3–6%', color: '#4caf50' },
  { key: 'moderate', min: 6, label: '中坡 6–9%', color: '#f6c445' },
  { key: 'hard', min: 9, label: '陡坡 9–12%', color: '#f39c3d' },
  { key: 'steep', min: 12, label: '峻坡 12–15%', color: '#e2564d' },
  { key: 'extreme', min: 15, label: '极陡 ≥15%', color: '#8e2b26' },
]

export function gradeBucket(grade: number): GradeBucket {
  let out: GradeBucket = 'flat'
  for (const b of GRADE_BUCKETS) if (grade >= b.min) out = b.key
  return out
}

export function gradeColor(grade: number): string {
  const k = gradeBucket(grade)
  return GRADE_BUCKETS.find((b) => b.key === k)!.color
}

// Strava 风格爬坡定级：score = 长度(m) × 平均坡度(%)。城市骑行多数为未定级小坡。
export type ClimbCategory = 'HC' | 'C1' | 'C2' | 'C3' | 'C4' | null

export function climbCategory(score: number): ClimbCategory {
  if (score >= 80000) return 'HC'
  if (score >= 64000) return 'C1'
  if (score >= 32000) return 'C2'
  if (score >= 16000) return 'C3'
  if (score >= 8000) return 'C4'
  return null
}

export interface ClimbSegment {
  startIdx: number
  endIdx: number
  startDistM: number
  endDistM: number
  lengthM: number
  gainM: number
  avgGrade: number
  maxGrade: number
  score: number
  category: ClimbCategory
}

export interface ProfileSummary {
  distanceM: number
  totalAscentM: number
  totalDescentM: number
  maxGrade: number // 最陡上坡
  minGrade: number // 最陡下坡（负值）
  highestEle: number
  lowestEle: number
  climbCount: number
  climbDistanceM: number // 处于爬坡段的总里程
  steepestClimb?: ClimbSegment // 平均坡度最大的爬坡段
}

/**
 * 把原始轨迹重采样为等距剖面点，并对海拔做移动平均平滑，最后逐点计算坡度。
 * @param points 原始轨迹（Coordinate[]，需带 ele）
 * @param stepM 重采样步长（米），默认 25
 * @param smoothWin 海拔平滑窗口点数（奇数为宜），默认 5
 */
export function buildProfile(points: Coordinate[], stepM = 25, smoothWin = 5): ProfilePoint[] {
  const pts = (points ?? []).filter(
    (p) => p && Number.isFinite(p.lng) && Number.isFinite(p.lat),
  )
  if (pts.length === 0) return []
  if (pts.length === 1) {
    const e = pts[0].ele ?? 0
    return [{ distM: 0, ele: e, eleRaw: e, grade: 0, lng: pts[0].lng, lat: pts[0].lat }]
  }

  // 累计距离
  const cum: number[] = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]))
  const total = cum[cum.length - 1]

  // 退化：总距离为 0（同点重复），直接返回首点
  if (!(total > 0)) {
    const e = pts[0].ele ?? 0
    return [{ distM: 0, ele: e, eleRaw: e, grade: 0, lng: pts[0].lng, lat: pts[0].lat }]
  }

  // 等距重采样：沿累计距离每 stepM 取一点，线性插值 lng/lat/ele
  const n = Math.max(2, Math.floor(total / stepM) + 1)
  const raw: ProfilePoint[] = []
  let seg = 0
  for (let k = 0; k < n; k++) {
    const d = Math.min(total, k * stepM)
    while (seg < pts.length - 2 && cum[seg + 1] < d) seg++
    const segLen = cum[seg + 1] - cum[seg]
    const t = segLen > 0 ? (d - cum[seg]) / segLen : 0
    const a = pts[seg]
    const b = pts[seg + 1]
    const lng = a.lng + (b.lng - a.lng) * t
    const lat = a.lat + (b.lat - a.lat) * t
    const ele = (a.ele ?? 0) + ((b.ele ?? 0) - (a.ele ?? 0)) * t
    raw.push({ distM: d, ele, eleRaw: ele, grade: 0, lng, lat })
  }
  // 保证最后一点落在终点
  if (raw[raw.length - 1].distM < total) {
    const last = pts[pts.length - 1]
    raw.push({ distM: total, ele: last.ele ?? 0, eleRaw: last.ele ?? 0, grade: 0, lng: last.lng, lat: last.lat })
  }

  // 海拔移动平均平滑
  const half = Math.max(0, Math.floor(smoothWin / 2))
  for (let i = 0; i < raw.length; i++) {
    let sum = 0
    let cnt = 0
    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < raw.length) {
        sum += raw[j].eleRaw
        cnt++
      }
    }
    raw[i].ele = cnt ? sum / cnt : raw[i].eleRaw
  }

  // 逐点坡度（到下一点；末点复用前值）
  for (let i = 0; i < raw.length; i++) {
    if (i < raw.length - 1) {
      const dd = raw[i + 1].distM - raw[i].distM
      raw[i].grade = dd > 0 ? ((raw[i + 1].ele - raw[i].ele) / dd) * 100 : 0
    } else {
      raw[i].grade = i > 0 ? raw[i - 1].grade : 0
    }
  }
  return raw
}

/**
 * 从剖面识别爬坡段：从每个上坡起点出发，跟踪到局部最高点，允许峰后小幅回落（DROP_TOL）
 * 视为同一段的途中起伏；段结束后按 minGain/minLen/minAvgGrade 过滤掉噪声小坡。
 */
export function detectClimbs(
  profile: ProfilePoint[],
  opts?: { minGainM?: number; minLenM?: number; minAvgGrade?: number; dropTolM?: number },
): ClimbSegment[] {
  const minGainM = opts?.minGainM ?? 15
  const minLenM = opts?.minLenM ?? 150
  const minAvgGrade = opts?.minAvgGrade ?? 2
  const dropTol = opts?.dropTolM ?? 12
  const climbs: ClimbSegment[] = []
  if (!profile || profile.length < 2) return climbs

  let i = 0
  while (i < profile.length - 1) {
    // 找到一个上坡起点
    if (profile[i + 1].ele <= profile[i].ele) {
      i++
      continue
    }
    const start = i
    let j = i + 1
    let peakEle = profile[j].ele
    let peakIdx = j
    while (j < profile.length - 1) {
      j++
      const e = profile[j].ele
      if (e > peakEle) {
        peakEle = e
        peakIdx = j
      } else if (peakEle - e > dropTol) {
        break // 回落超过容差，视为爬坡结束
      }
    }

    const s = start
    const e2 = peakIdx
    const lengthM = profile[e2].distM - profile[s].distM
    const gainM = profile[e2].ele - profile[s].ele
    const avgGrade = lengthM > 0 ? (gainM / lengthM) * 100 : 0
    if (gainM >= minGainM && lengthM >= minLenM && avgGrade >= minAvgGrade) {
      let maxGrade = 0
      for (let k = s; k < e2; k++) if (profile[k].grade > maxGrade) maxGrade = profile[k].grade
      const score = lengthM * avgGrade
      climbs.push({
        startIdx: s,
        endIdx: e2,
        startDistM: profile[s].distM,
        endDistM: profile[e2].distM,
        lengthM,
        gainM,
        avgGrade,
        maxGrade,
        score,
        category: climbCategory(score),
      })
    }
    i = Math.max(e2, i + 1)
  }
  return climbs
}

// 汇总：总爬升/下降、最陡坡、最高最低海拔、爬坡段数与爬坡总里程、最陡爬坡段。
export function analyzeProfile(profile: ProfilePoint[], climbs: ClimbSegment[]): ProfileSummary {
  let totalAscentM = 0
  let totalDescentM = 0
  let maxGrade = 0
  let minGrade = 0
  let highestEle = profile.length ? profile[0].ele : 0
  let lowestEle = profile.length ? profile[0].ele : 0
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i]
    if (p.ele > highestEle) highestEle = p.ele
    if (p.ele < lowestEle) lowestEle = p.ele
    if (p.grade > maxGrade) maxGrade = p.grade
    if (p.grade < minGrade) minGrade = p.grade
    if (i > 0) {
      const d = profile[i].ele - profile[i - 1].ele
      if (d > 0) totalAscentM += d
      else totalDescentM += -d
    }
  }
  let climbDistanceM = 0
  let steepestClimb: ClimbSegment | undefined
  for (const c of climbs) {
    climbDistanceM += c.lengthM
    if (!steepestClimb || c.avgGrade > steepestClimb.avgGrade) steepestClimb = c
  }
  return {
    distanceM: profile.length ? profile[profile.length - 1].distM : 0,
    totalAscentM: Math.round(totalAscentM),
    totalDescentM: Math.round(totalDescentM),
    maxGrade,
    minGrade,
    highestEle: Math.round(highestEle),
    lowestEle: Math.round(lowestEle),
    climbCount: climbs.length,
    climbDistanceM: Math.round(climbDistanceM),
    steepestClimb,
  }
}

export interface ElevationAnalysis {
  profile: ProfilePoint[]
  climbs: ClimbSegment[]
  summary: ProfileSummary
}

// 一站式：传轨迹点得到剖面 + 爬坡段 + 汇总。
export function buildElevationAnalysis(
  points: Coordinate[],
  opts?: { stepM?: number; smoothWin?: number },
): ElevationAnalysis {
  const profile = buildProfile(points, opts?.stepM ?? 25, opts?.smoothWin ?? 5)
  const climbs = detectClimbs(profile)
  const summary = analyzeProfile(profile, climbs)
  return { profile, climbs, summary }
}
