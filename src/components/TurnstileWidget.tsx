// Cloudflare Turnstile Widget の 薄い React ラッパー。
//
// 使い方:
//   <TurnstileWidget onToken={(token) => setToken(token)} />
//
// 挙動:
//   - VITE_TURNSTILE_SITE_KEY が 未設定 の 場合 は 何 も 描画 しない (= 開発環境
//     や、 Turnstile を 入れる 前 の 本番 で は 自動 で 無効化)。 サーバー 側 の
//     api/contact.ts も TURNSTILE_SECRET 未設定 なら 検証 を skip する ので
//     両方 未設定 なら ノー チェック で 動く。
//   - script の 複数 ロード は 1 回 に 抑制。
//   - theme/size は props で 上書き 可。

import { useCallback, useEffect, useRef } from 'react'

interface Props {
  onToken: (token: string | null) => void
  theme?: 'light' | 'dark' | 'auto'
  size?: 'normal' | 'compact' | 'flexible'
  className?: string
}

const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'

/** window.turnstile の 最低限 の 型。 */
interface Turnstile {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string
      theme?: 'light' | 'dark' | 'auto'
      size?: 'normal' | 'compact' | 'flexible'
      callback?: (token: string) => void
      'expired-callback'?: () => void
      'error-callback'?: () => void
    },
  ) => string
  remove: (widgetId: string) => void
  reset: (widgetId?: string) => void
}

declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

let scriptLoaded = false
let scriptLoading: Promise<void> | null = null

function loadScript(): Promise<void> {
  if (scriptLoaded) return Promise.resolve()
  if (scriptLoading) return scriptLoading
  scriptLoading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(`script[src^="${SCRIPT_SRC.split('?')[0]}"]`)
    if (existing) {
      scriptLoaded = true
      resolve()
      return
    }
    const s = document.createElement('script')
    s.src = SCRIPT_SRC
    s.async = true
    s.defer = true
    s.onload = () => {
      scriptLoaded = true
      resolve()
    }
    s.onerror = () => reject(new Error('turnstile script failed to load'))
    document.head.appendChild(s)
  })
  return scriptLoading
}

export function TurnstileWidget({ onToken, theme = 'auto', size = 'flexible', className }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const widgetIdRef = useRef<string | null>(null)
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined
  // onToken は 親 の レンダ 毎 に 新しい 参照 に なり 得る の で ref に 退避 し、
  // widget を 再 render しない。
  const onTokenRef = useRef(onToken)
  useEffect(() => { onTokenRef.current = onToken }, [onToken])

  const render = useCallback(async () => {
    if (!siteKey) return
    await loadScript()
    const ts = window.turnstile
    if (!ts || !containerRef.current) return
    // すでに render 済み なら skip
    if (widgetIdRef.current) return
    try {
      widgetIdRef.current = ts.render(containerRef.current, {
        sitekey: siteKey,
        theme,
        size,
        callback: (token) => onTokenRef.current(token),
        'expired-callback': () => onTokenRef.current(null),
        'error-callback': () => onTokenRef.current(null),
      })
    } catch (err) {
      console.error('[turnstile] render failed', err)
    }
  }, [siteKey, theme, size])

  useEffect(() => {
    void render()
    return () => {
      const ts = window.turnstile
      if (ts && widgetIdRef.current) {
        try { ts.remove(widgetIdRef.current) } catch { /* ignore */ }
        widgetIdRef.current = null
      }
    }
  }, [render])

  if (!siteKey) return null
  return <div ref={containerRef} className={className} />
}
