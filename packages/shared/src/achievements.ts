// 骑行成就与年度报告：从一批轨迹派生聚合统计、个人纪录、连续打卡与徽章。
// 纯函数、零依赖，端云共用同一份口径（Web 展示 / 未来 Server 也可复用）。
import type { Track } from './types'
import { haversine } from './geo/geometry'
import { summarizeTrack } from './trackStats'

// 档案库里的一条轨迹：Track + 名称 + 保存时间。为避免 shared 依赖 web 的 storage，
// 这里用结构化约束（只要求带 name/savedAt 的 Track 即可）。
export interface NamedTrack extends Track {
  name: string
  savedAt: number
}

export interface Aggregate {
  distanceM: number
  ascentM: number
  durationS: number
  count: number
  avgDistanceM: number
  avgSpeedKmh: number
}

export interface BestEffort {
  targetM: number
  durationS: number
  speedKmh: number
  trackName: string
}

export interface PersonalRecords {
  longestRideM: number // 单次最长距离
  longestRideName: string
  maxAscentM: number // 单次最大爬升
  maxAscentName: string
  longestDurationS: number // 单次最长时长
  longestDurationName: string
  maxAvgSpeedKmh: number // 单次最高均速
  maxAvgSpeedName: string
  maxHr?: number // 历史最高心率
  best5k?: BestEffort // 最快连续 5km
  best10k?: BestEffort // 最快连续 10km
  best20k?: BestEffort // 最快连续 20km
}

export interface Streaks {
  currentDays: number // 截至今天的当前连续打卡天数
  longestDays: number // 历史最长连续打卡天数
  activeDays: number // 有骑行的总天数（去重）
}

export interface DayCell {
  date: string // YYYY-MM-DD（本地时区）
  distanceM: number
  count: number
}

export interface Badge {
  id: string
  icon: string
  name: string
  desc: string
  earned: boolean
  progress: number // 0..1
  valueText: string // 当前进度文案，如 "382 / 500 km"
}

export interface AnnualReport {
  year: number | 'all'
  aggregate: Aggregate
  records: PersonalRecords
  streaks: Streaks
  monthly: { key: string; distanceM: number; count: number }[] // 长度 12（按年）或按数据（全部）
  calendar: DayCell[] // 有骑行的日期（升序）
  weekday: number[] // 长度 7：周日..周六 的里程(米)
  hour: number[] // 长度 24：各小时里程(米)
  badges: Badge[]
}

// —— 内部工具 ——

// 本地时区的 YYYY-MM-DD（用于按「日历日」去重打卡）
function localDay(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// 一条轨迹的起始日期年份（无时间戳则返回 NaN）
function trackYear(t: Track): number {
  const p = t.points
  return p.length && p[0].t ? new Date(p[0].t).getFullYear() : NaN
}

// 按年份过滤（'all' 不过滤）
function filterByYear(tracks: NamedTrack[], year: number | 'all'): NamedTrack[] {
  if (year === 'all') return tracks
  return tracks.filter((t) => trackYear(t) === year)
}

// 单条轨迹里「最快连续 targetM 米」的用时（秒）。滑动窗口：右指针扩张累计距离，
// 一旦窗口覆盖 ≥ targetM 就尝试收缩左指针取更短用时。需要点自带时间戳。
export function bestEffortInTrack(t: Track, targetM: number): { durationS: number } | null {
  const pts = t.points
  if (pts.length < 2) return null
  // 预计算累计距离
  const cum: number[] = new Array(pts.length)
  cum[0] = 0
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + haversine(pts[i - 1], pts[i])
  if (cum[cum.length - 1] < targetM) return null // 全程不足 targetM

  let best = Infinity
  let i = 0
  for (let j = 1; j < pts.length; j++) {
    while (i < j && cum[j] - cum[i] >= targetM) {
      const dt = (pts[j].t - pts[i].t) / 1000
      if (dt > 0 && dt < best) best = dt
      i++
    }
  }
  return Number.isFinite(best) ? { durationS: best } : null
}

// 跨全部轨迹的最快 targetM（返回用时最短的一条）
function fastestOverall(tracks: NamedTrack[], targetM: number): BestEffort | undefined {
  let out: BestEffort | undefined
  for (const t of tracks) {
    const r = bestEffortInTrack(t, targetM)
    if (r && (!out || r.durationS < out.durationS)) {
      out = {
        targetM,
        durationS: r.durationS,
        speedKmh: (targetM / r.durationS) * 3.6,
        trackName: t.name,
      }
    }
  }
  return out
}

// —— 聚合 ——

export function aggregate(tracks: NamedTrack[]): Aggregate {
  let distanceM = 0
  let ascentM = 0
  let durationS = 0
  for (const t of tracks) {
    const s = summarizeTrack(t)
    distanceM += s.distanceM
    ascentM += s.ascentM
    durationS += s.durationS
  }
  const count = tracks.length
  return {
    distanceM,
    ascentM,
    durationS,
    count,
    avgDistanceM: count ? distanceM / count : 0,
    avgSpeedKmh: durationS > 0 ? (distanceM / durationS) * 3.6 : 0,
  }
}

export function personalRecords(tracks: NamedTrack[]): PersonalRecords {
  const rec: PersonalRecords = {
    longestRideM: 0,
    longestRideName: '',
    maxAscentM: 0,
    maxAscentName: '',
    longestDurationS: 0,
    longestDurationName: '',
    maxAvgSpeedKmh: 0,
    maxAvgSpeedName: '',
  }
  for (const t of tracks) {
    const s = summarizeTrack(t)
    if (s.distanceM > rec.longestRideM) {
      rec.longestRideM = s.distanceM
      rec.longestRideName = t.name
    }
    if (s.ascentM > rec.maxAscentM) {
      rec.maxAscentM = s.ascentM
      rec.maxAscentName = t.name
    }
    if (s.durationS > rec.longestDurationS) {
      rec.longestDurationS = s.durationS
      rec.longestDurationName = t.name
    }
    // 均速纪录只在时长有效（有时间戳）时计入，避免 0 时长噪音
    if (s.durationS > 0 && s.avgSpeedKmh > rec.maxAvgSpeedKmh) {
      rec.maxAvgSpeedKmh = s.avgSpeedKmh
      rec.maxAvgSpeedName = t.name
    }
    if (typeof s.maxHr === 'number' && (rec.maxHr === undefined || s.maxHr > rec.maxHr)) {
      rec.maxHr = s.maxHr
    }
  }
  rec.best5k = fastestOverall(tracks, 5000)
  rec.best10k = fastestOverall(tracks, 10000)
  rec.best20k = fastestOverall(tracks, 20000)
  return rec
}

export function streaks(tracks: NamedTrack[]): Streaks {
  // 收集所有有骑行的「本地日」（去重）
  const days = new Set<string>()
  for (const t of tracks) {
    const p = t.points
    if (p.length && p[0].t) days.add(localDay(p[0].t))
  }
  const sorted = [...days].sort() // 字典序即时间序（YYYY-MM-DD）
  const activeDays = sorted.length
  if (!activeDays) return { currentDays: 0, longestDays: 0, activeDays: 0 }

  // 最长连续
  const toNum = (s: string) => Math.floor(new Date(s + 'T00:00:00').getTime() / 86400000)
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (toNum(sorted[i]) - toNum(sorted[i - 1]) === 1) {
      run++
      if (run > longest) longest = run
    } else {
      run = 1
    }
  }

  // 当前连续：从今天（或最近骑行日）往回数连续天
  const todayNum = Math.floor(Date.now() / 86400000)
  const lastNum = toNum(sorted[sorted.length - 1])
  let current = 0
  // 只有最近一次骑行是今天或昨天，才算「当前仍在延续」
  if (todayNum - lastNum <= 1) {
    current = 1
    for (let i = sorted.length - 2; i >= 0; i--) {
      if (toNum(sorted[i + 1]) - toNum(sorted[i]) === 1) current++
      else break
    }
  }
  return { currentDays: current, longestDays: longest, activeDays }
}

// 12 个月里程（year 为具体年份时按 1..12；'all' 时按数据出现的 YYYY-MM 升序聚合）
export function monthlyDistances(
  tracks: NamedTrack[],
  year: number | 'all',
): { key: string; distanceM: number; count: number }[] {
  if (year === 'all') {
    const map = new Map<string, { distanceM: number; count: number }>()
    for (const t of tracks) {
      const p = t.points
      if (!p.length || !p[0].t) continue
      const d = new Date(p[0].t)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const cur = map.get(key) ?? { distanceM: 0, count: 0 }
      cur.distanceM += summarizeTrack(t).distanceM
      cur.count += 1
      map.set(key, cur)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, v]) => ({ key, ...v }))
  }
  const rows = Array.from({ length: 12 }, (_, i) => ({
    key: `${year}-${String(i + 1).padStart(2, '0')}`,
    distanceM: 0,
    count: 0,
  }))
  for (const t of tracks) {
    const p = t.points
    if (!p.length || !p[0].t) continue
    const d = new Date(p[0].t)
    if (d.getFullYear() !== year) continue
    rows[d.getMonth()].distanceM += summarizeTrack(t).distanceM
    rows[d.getMonth()].count += 1
  }
  return rows
}

// 每日里程（用于热力日历）。升序返回有骑行的日期。
export function dayCalendar(tracks: NamedTrack[]): DayCell[] {
  const map = new Map<string, { distanceM: number; count: number }>()
  for (const t of tracks) {
    const p = t.points
    if (!p.length || !p[0].t) continue
    const key = localDay(p[0].t)
    const cur = map.get(key) ?? { distanceM: 0, count: 0 }
    cur.distanceM += summarizeTrack(t).distanceM
    cur.count += 1
    map.set(key, cur)
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v }))
}

export function weekdayHistogram(tracks: NamedTrack[]): number[] {
  const out = new Array(7).fill(0)
  for (const t of tracks) {
    const p = t.points
    if (!p.length || !p[0].t) continue
    out[new Date(p[0].t).getDay()] += summarizeTrack(t).distanceM
  }
  return out
}

export function hourHistogram(tracks: NamedTrack[]): number[] {
  const out = new Array(24).fill(0)
  for (const t of tracks) {
    const p = t.points
    if (!p.length || !p[0].t) continue
    out[new Date(p[0].t).getHours()] += 1
  }
  return out
}

// —— 徽章体系 ——
// 每个徽章给出是否达成 + 进度（用于展示进度条）。阈值取骑行圈常见里程碑。

export function computeBadges(tracks: NamedTrack[]): Badge[] {
  const agg = aggregate(tracks)
  const rec = personalRecords(tracks)
  const st = streaks(tracks)
  const hours = hourHistogram(tracks)
  const totalKm = agg.distanceM / 1000
  const longestKm = rec.longestRideM / 1000
  const earlyRides = hours.slice(5, 8).reduce((a, b) => a + b, 0) // 05:00-07:59 出发
  const nightRides = [...hours.slice(20, 24), ...hours.slice(0, 5)].reduce((a, b) => a + b, 0) // 20:00-04:59

  const milestone = (
    id: string,
    icon: string,
    name: string,
    cur: number,
    target: number,
    unit: string,
    fmt: (n: number) => string = (n) => String(Math.round(n)),
  ): Badge => ({
    id,
    icon,
    name,
    desc: `累计达到 ${fmt(target)} ${unit}`,
    earned: cur >= target,
    progress: Math.max(0, Math.min(1, target > 0 ? cur / target : 0)),
    valueText: `${fmt(Math.min(cur, target))} / ${fmt(target)} ${unit}`,
  })

  const flag = (
    id: string,
    icon: string,
    name: string,
    desc: string,
    earned: boolean,
    cur: number,
    target: number,
    unit: string,
  ): Badge => ({
    id,
    icon,
    name,
    desc,
    earned,
    progress: Math.max(0, Math.min(1, target > 0 ? cur / target : 0)),
    valueText: `${Math.round(Math.min(cur, target))} / ${target} ${unit}`,
  })

  return [
    milestone('total_100', '🥉', '百里挑一', totalKm, 100, 'km'),
    milestone('total_500', '🥈', '五百将军', totalKm, 500, 'km'),
    milestone('total_1000', '🥇', '千里骑行', totalKm, 1000, 'km'),
    milestone('single_50', '🚀', '半百单骑', longestKm, 50, 'km'),
    milestone('single_100', '💯', '单日百公里', longestKm, 100, 'km'),
    milestone('climb_1000', '⛰️', '累计爬升千米', agg.ascentM, 1000, 'm'),
    milestone('climb_5000', '🏔️', '累计爬升五千米', agg.ascentM, 5000, 'm'),
    flag('streak_7', '🔥', '七日连骑', '连续 7 天骑行打卡', st.longestDays >= 7, st.longestDays, 7, '天'),
    flag('streak_30', '🌟', '月度全勤', '连续 30 天骑行打卡', st.longestDays >= 30, st.longestDays, 30, '天'),
    flag('early_bird', '🌅', '早起鸟', '清晨(5-8 点)出发累计 5 次', earlyRides >= 5, earlyRides, 5, '次'),
    flag('night_owl', '🌙', '夜骑侠', '夜间(20 点后)出发累计 5 次', nightRides >= 5, nightRides, 5, '次'),
    flag('rides_50', '📅', '五十次出行', '累计完成 50 次骑行', agg.count >= 50, agg.count, 50, '次'),
  ]
}

// —— 汇总 ——

export function buildAnnualReport(all: NamedTrack[], year: number | 'all'): AnnualReport {
  const tracks = filterByYear(all, year)
  return {
    year,
    aggregate: aggregate(tracks),
    records: personalRecords(tracks),
    streaks: streaks(tracks),
    monthly: monthlyDistances(tracks, year),
    calendar: dayCalendar(tracks),
    weekday: weekdayHistogram(tracks),
    hour: hourHistogram(tracks),
    badges: computeBadges(tracks),
  }
}

// 数据里出现过的年份（降序），供 UI 年份切换
export function availableYears(tracks: NamedTrack[]): number[] {
  const set = new Set<number>()
  for (const t of tracks) {
    const y = trackYear(t)
    if (Number.isFinite(y)) set.add(y)
  }
  return [...set].sort((a, b) => b - a)
}
