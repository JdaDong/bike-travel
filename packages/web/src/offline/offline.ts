// 离线 PMTiles 封装：用缓存 Source 创建实例，并提供「按 bbox 预下载区域」
import { PMTiles } from 'pmtiles'
import type { BoundingBox } from '@bike-travel/shared'
import { createCachedSource } from './source'

export function createOfflinePMTiles(url: string): PMTiles {
  return new PMTiles(createCachedSource(url))
}

function lon2tile(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}
function lat2tile(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

// 预下载一个 bbox 在 [minZ, maxZ] 内的所有瓦片到 IndexedDB 缓存
export async function downloadRegion(
  pm: PMTiles,
  bbox: BoundingBox,
  minZ = 10,
  maxZ = 14,
): Promise<number> {
  let count = 0
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lon2tile(bbox.minLng, z)
    const x1 = lon2tile(bbox.maxLng, z)
    const yTop = lat2tile(bbox.maxLat, z)
    const yBot = lat2tile(bbox.minLat, z)
    const y0 = Math.min(yTop, yBot)
    const y1 = Math.max(yTop, yBot)
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const r = await pm.getZxy(z, x, y)
        if (r) count++
      }
    }
  }
  return count
}
