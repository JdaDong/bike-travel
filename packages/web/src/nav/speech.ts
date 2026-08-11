// 中文语音播报封装：用 Web Speech API 做导航 TTS。
// 无语音引擎的浏览器（如部分无头环境）会静默跳过，不影响导航逻辑。
export function speak(text: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  try {
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'zh-CN'
    u.rate = 1.05
    u.pitch = 1
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  } catch {
    /* 忽略：浏览器无可用语音引擎 */
  }
}
