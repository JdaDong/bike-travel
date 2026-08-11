// 带 IndexedDB 缓存的 PMTiles Source：联网时写入，离线时直接命中缓存
// 这样 pmtiles 的 header/目录/瓦片都会被缓存，飞行模式下仍可出图
import type { Source, RangeResponse } from 'pmtiles'

const DB_NAME = 'bike-travel-offline'
const STORE = 'bytes'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function dbGet(key: string): Promise<ArrayBuffer | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve((req.result as ArrayBuffer) ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function dbPut(key: string, buf: ArrayBuffer): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(buf, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export function createCachedSource(url: string): Source {
  return {
    getKey: () => url,
    getBytes: async (offset, length, signal) => {
      const key = `${url}|${offset}|${length}`
      const cached = await dbGet(key)
      if (cached) return { data: cached }
      const end = offset + length - 1
      const res = await fetch(url, {
        signal,
        headers: { Range: `bytes=${offset}-${end}` },
      })
      const buf = await res.arrayBuffer()
      await dbPut(key, buf).catch(() => {})
      return { data: buf }
    },
  }
}
