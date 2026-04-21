// 表示モード（PC / スマホ）の自動判定とユーザー選択の保存

const MODE_KEY = 'nc_display_mode_override'

export type DisplayMode = 'pc' | 'mobile' | null

export function getDisplayModeOverride(): DisplayMode {
  try {
    const v = localStorage.getItem(MODE_KEY)
    return v === 'pc' || v === 'mobile' ? v : null
  } catch {
    return null
  }
}

export function setDisplayModeOverride(mode: DisplayMode): void {
  try {
    if (mode === null) {
      localStorage.removeItem(MODE_KEY)
    } else {
      localStorage.setItem(MODE_KEY, mode)
    }
  } catch {
    // localStorage 使用不可の場合は無視
  }
}

// User Agent または画面幅からモバイル端末かを判定
export function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true
  return window.innerWidth < 768
}
