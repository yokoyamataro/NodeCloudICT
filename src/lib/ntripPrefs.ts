// NTRIP キャスター設定の localStorage 永続化。
//
// パスワードを 平文で localStorage に置くのは 理想的ではないが、単一端末の
// ネイティブ WebView 内 (他アプリ から isolate 済み) なので 実運用上の
// リスクは 限定的。後日 Capacitor Preferences (SharedPreferences) や
// Android の EncryptedSharedPreferences への移行を検討。

import type { NtripConfig } from './drogger'

const KEY = 'nodecloud.ntrip.config.v1'

/** 保存済み NTRIP 設定を読み込む。無ければ null */
export function loadNtripConfig(): NtripConfig | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return null
    const obj = JSON.parse(raw)
    if (
      typeof obj?.host === 'string' &&
      typeof obj?.port === 'number' &&
      typeof obj?.mountpoint === 'string'
    ) {
      return {
        host: obj.host,
        port: obj.port,
        mountpoint: obj.mountpoint,
        user: typeof obj.user === 'string' ? obj.user : '',
        pass: typeof obj.pass === 'string' ? obj.pass : '',
        sendGga: typeof obj.sendGga === 'boolean' ? obj.sendGga : true,
      }
    }
  } catch {
    /* 破損した JSON は無視 */
  }
  return null
}

export function saveNtripConfig(cfg: NtripConfig): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(KEY, JSON.stringify(cfg))
}

export function clearNtripConfig(): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY)
}

/** 既定値 (電子基準点 想定でユーザー入力を促す用) */
export const DEFAULT_NTRIP_CONFIG: NtripConfig = {
  host: '',
  port: 2101,
  mountpoint: '',
  user: '',
  pass: '',
  sendGga: true,
}
