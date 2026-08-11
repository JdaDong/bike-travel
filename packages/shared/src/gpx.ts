// GPX 编解码（与 Track 互转）。GPX 用 lat/lon，注意字段名差异。
import type { Track, TrackPoint } from './types'

export function trackToGpx(track: Track): string {
  const pts = track.points
    .map((p: TrackPoint) => {
      const ele = p.ele != null ? `\n      <ele>${p.ele}</ele>` : ''
      const hr = p.hr != null ? `\n      <extensions><hr>${p.hr}</hr></extensions>` : ''
      const time = p.t ? `\n      <time>${new Date(p.t).toISOString()}</time>` : ''
      return `    <trkpt lat="${p.lat}" lon="${p.lng}">${ele}${time}${hr}\n    </trkpt>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="bike-travel" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${track.id}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`
}

export function gpxToTrack(xml: string): Track {
  const lat = [...xml.matchAll(/lat="([-\d.]+)"/g)].map((m) => Number(m[1]))
  const lon = [...xml.matchAll(/lon="([-\d.]+)"/g)].map((m) => Number(m[1]))
  const ele = [...xml.matchAll(/<ele>([-\d.]+)<\/ele>/g)].map((m) => Number(m[1]))
  const time = [...xml.matchAll(/<time>([^<]+)<\/time>/g)].map((m) => Date.parse(m[1]))
  // 心率：兼容本应用导出的 <hr>123</hr> 与各厂商命名空间 <gpxtpx:hr>123</gpxtpx:hr> 等
  const hr = [...xml.matchAll(/<(?:[^:>\s]*:)?hr>(\d+)<\/(?:[^:>\s]*:)?hr>/gi)].map((m) => Number(m[1]))
  const points: TrackPoint[] = lat.map((la, i) => ({
    lat: la,
    lng: lon[i],
    ele: ele[i],
    t: Number.isNaN(time[i]) ? 0 : time[i],
    hr: hr[i] ?? undefined,
  }))
  return { id: 'imported', points, distanceM: 0, elevationGainM: 0 }
}
