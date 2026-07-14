// Vite の動的 import で古い chunk (デプロイ後に消えた hash 付きファイル) を
// 取りに行って 404 になると、ブラウザは画面遷移中に真っ白のまま止まる。
// この関数はグローバル error / unhandledrejection を監視し、chunk load 失敗
// パターンに一致したら 1 回だけ自動リロードする。
//
// 使い方: main.tsx で installChunkReloadHandler() を 1 回呼ぶだけ。
//
// 挙動:
//   * chunk load エラー検知
//     → sessionStorage の履歴を見て未リロードなら window.location.reload()
//   * 5 分以内に 2 回連続でリロードすると「本当に chunk が無い / ネットワーク
//     不通」の可能性が高いので、以降は自動リロードを止めて ErrorBoundary に任せる
//     (ユーザーに「再読み込み」ボタンを見せる状態)

const STORAGE_KEY = '__nc_chunk_reload_at__'
const COOLDOWN_MS = 5 * 60 * 1000 // 5 分

const CHUNK_ERROR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
  /Loading chunk \S+ failed/i,
  /Loading CSS chunk \S+ failed/i,
  /ChunkLoadError/i,
]

function isChunkLoadError(message: string): boolean {
  return CHUNK_ERROR_PATTERNS.some((re) => re.test(message))
}

function extractMessage(input: unknown): string {
  if (!input) return ''
  if (typeof input === 'string') return input
  if (input instanceof Error) return input.message || String(input)
  const obj = input as { message?: string }
  if (obj?.message) return obj.message
  try {
    return String(input)
  } catch {
    return ''
  }
}

function tryAutoReload(): boolean {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    const lastAt = raw ? parseInt(raw, 10) : 0
    const now = Date.now()
    if (lastAt && now - lastAt < COOLDOWN_MS) {
      // クールダウン中: これ以上リロードせず ErrorBoundary に任せる
      return false
    }
    sessionStorage.setItem(STORAGE_KEY, String(now))
  } catch {
    /* ignore storage errors (private mode etc.) */
  }
  console.warn('[chunkReload] dynamic import failed, reloading page')
  window.location.reload()
  return true
}

export function installChunkReloadHandler(): void {
  if (typeof window === 'undefined') return
  window.addEventListener('error', (event) => {
    const msg = extractMessage(event.error) || event.message || ''
    if (isChunkLoadError(msg)) {
      tryAutoReload()
    }
  })
  window.addEventListener('unhandledrejection', (event) => {
    const msg = extractMessage(event.reason)
    if (isChunkLoadError(msg)) {
      tryAutoReload()
    }
  })
}
