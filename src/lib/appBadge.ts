// アプリアイコンのバッジ (未読数) の設定。
//
// iOS ネイティブ側 (MobilityLocationPlugin) に setBadge を用意し、そこへ渡す。
// プッシュ通知は未導入なので、**アプリが動いている間しか更新できない**。
// モビリティは位置情報のバックグラウンドモードで常時動くため、乗車中は
// バックグラウンドでも更新が届く。
//
// Web / Android では何もしない (Badging API は iOS Safari 非対応)。

import { Capacitor, registerPlugin } from '@capacitor/core'

interface BadgePlugin {
  setBadge(options: { count: number }): Promise<void>
  updateActivity(options: {
    destinationName: string | null
    distanceKm: number
    pendingCount: number
    online: boolean
  }): Promise<void>
}

const plugin = registerPlugin<BadgePlugin>('BackgroundGeolocation')

export async function setAppBadge(count: number): Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return
  try {
    await plugin.setBadge({ count })
  } catch {
    /* ネイティブ未実装の版では黙って無視 */
  }
}

/**
 * ロック画面 / Dynamic Island の表示内容を更新する。
 *
 * 表示する値 (行き先 / 走行距離 / 未送信件数 / 通信状態) はすべて TS 側が
 * 持っているので、ネイティブでは組み立てず渡すだけにしている。
 * ネイティブ側で 10 秒間隔に間引かれる (ActivityKit の更新予算のため)。
 */
export async function updateLiveActivity(state: {
  destinationName: string | null
  distanceKm: number
  pendingCount: number
  online: boolean
}): Promise<void> {
  if (Capacitor.getPlatform() !== 'ios') return
  try {
    await plugin.updateActivity(state)
  } catch {
    /* ネイティブ未実装の版では黙って無視 */
  }
}
