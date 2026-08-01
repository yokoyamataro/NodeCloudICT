// アプリのバリアント (メインの ICT / モビリティ専用) を判定するユーティリティ。
//
// - メイン (NodeCloud ICT): 全機能表示。既存の挙動と同じ
// - モビリティ (NodeCloud Mobility): 運転手向けに /mobility/drive のみに絞る
//
// 判定は URL クエリ `?app=mobility` (Capacitor シェル側の起動 URL に埋め込み) と、
// localStorage の永続化 (最初に mobility 判定されたら以降はブラウザリロードでも維持)
// の両輪で行う。

const KEY = 'nodecloud:appVariant'

export type AppVariant = 'ict' | 'mobility'

/**
 * 現在のアプリ形態を返す。
 * - URL に ?app=mobility があれば mobility
 * - もしくは localStorage に mobility 保存があれば mobility
 * - それ以外は ict
 * 一度 mobility 判定になった端末は、以降 URL クエリなしでも mobility 動作する。
 */
export function getAppVariant(): AppVariant {
  if (typeof window === 'undefined') return 'ict'
  try {
    const url = new URL(window.location.href)
    const q = url.searchParams.get('app')
    if (q === 'mobility') {
      localStorage.setItem(KEY, 'mobility')
      return 'mobility'
    }
    if (q === 'ict') {
      // 明示的に ict に戻したい場合の脱出口 (テスト用)
      localStorage.removeItem(KEY)
      return 'ict'
    }
    const stored = localStorage.getItem(KEY)
    if (stored === 'mobility') return 'mobility'
  } catch {
    /* localStorage 拒否環境ではフォールバック */
  }
  return 'ict'
}

export function isMobilityApp(): boolean {
  return getAppVariant() === 'mobility'
}
