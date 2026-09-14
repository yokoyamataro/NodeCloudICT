// 別タブ / 外部ブラウザ で 開く。
//
// ブラウザ では 素直に 新しい タブ。
// アプリ (Capacitor) の WebView は タブ を 持たない ので、端末 の ブラウザ に
// 投げる。 iOS/Android とも Capacitor の ブリッジ が target=_blank を
// 外部ブラウザ に 回して くれる ので window.open で 足りる。
//
// なお iOS は Web を 端末内 に バンドル して いて origin が capacitor://localhost
// に なる。 自前 の 画面 (/file-view など) を 外部ブラウザ で 開く ときは
// 公開URL に 直して から 渡す 必要が ある —— それが toPublicUrl。

import { Capacitor } from '@capacitor/core'

/** アプリ の 公開URL。 端末内バンドル から 外部ブラウザ に 渡す ときの 土台 */
const PUBLIC_ORIGIN = 'https://node-cloud-ict.vercel.app'

export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform()
  } catch {
    return false
  }
}

/**
 * アプリ内 の パス (/file-view?… ) を 外部ブラウザ で 開ける URL に する。
 * ブラウザ で 動いて いる ときは 今 の origin の まま。
 */
export function toPublicUrl(pathWithQuery: string): string {
  if (typeof window === 'undefined') return pathWithQuery
  const origin = window.location.origin
  // capacitor://localhost や file:// は 外部ブラウザ で 開けない
  const usable = origin.startsWith('http://') || origin.startsWith('https://')
  return new URL(pathWithQuery, usable ? origin : PUBLIC_ORIGIN).toString()
}

/** 別タブ (アプリ なら 端末 の ブラウザ) で 開く */
export function openExternal(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer')
}

/** アプリ内 の パス を 別タブ で 開く */
export function openAppPath(pathWithQuery: string): void {
  openExternal(toPublicUrl(pathWithQuery))
}
