import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 直接指向 shared 源码（TS），免去先 build shared
    alias: {
      '@bike-travel/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    // 端口取自 config/ports.env（由 start 脚本注入 WEB_PORT；缺省回退 5173）
    port: Number(process.env.WEB_PORT) || 5173,
    // 前端 /api 代理到后端，避免跨域；/ws 走 WebSocket 代理（结伴骑行长连接）
    // 代理目标端口取自 config/ports.env 的 SERVER_PORT，随后端端口自动适配
    proxy: {
      '/api': `http://localhost:${Number(process.env.SERVER_PORT) || 3000}`,
      '/ws': { target: `ws://localhost:${Number(process.env.SERVER_PORT) || 3000}`, ws: true },
    },
  },
})
