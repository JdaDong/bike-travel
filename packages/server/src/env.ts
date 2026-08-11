// 运行时配置：从环境变量读取。.env 在仓库根，但 npm workspace 脚本的 cwd 是
// packages/server，故从本文件向上查找第一个存在的 .env 再加载，避免 cwd 依赖。
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

function findEnv(dir: string): string | null {
  const p = resolve(dir, '.env')
  if (existsSync(p)) return p
  const parent = dirname(dir)
  return parent === dir ? null : findEnv(parent)
}

const envPath = findEnv(dirname(fileURLToPath(import.meta.url)))
if (envPath) dotenv.config({ path: envPath })

function str(name: string, def = ''): string {
  const v = process.env[name]
  return v === undefined ? def : v
}

export const env = {
  // 端口优先级：config/ports.env 的 SERVER_PORT > 传统 PORT > 默认 3000
  PORT: Number(str('SERVER_PORT') || str('PORT') || '3000'),
  AMAP_KEY: str('AMAP_KEY'),
  AMAP_REST_HOST: str('AMAP_REST_HOST', 'https://restapi.amap.com'),
  // 自托管 Valhalla 的 base（末尾不带斜杠）。例如 http://localhost:8002
  VALHALLA_URL: str('VALHALLA_URL'),
  // OSRM 骑行路由 base，末尾带斜杠。例如 https://router.project-osrm.org/route/v1/cycling/
  OSM_ROUTING_URL: str('OSM_ROUTING_URL'),
  // 云同步数据目录（存 cloud.json）。留空则用仓库根 data/；容器部署可挂卷覆盖。
  DATA_DIR: str('DATA_DIR'),
}
