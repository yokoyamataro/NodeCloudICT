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
