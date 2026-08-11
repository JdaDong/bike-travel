// 前端运行时配置（Vite 读取 VITE_ 前缀环境变量）
// 在 web/.env 设 VITE_PMTILES_URL 指向一个 .pmtiles 文件即可启用离线矢量底图
export const PMTILES_URL: string = (import.meta as any).env?.VITE_PMTILES_URL ?? ''
