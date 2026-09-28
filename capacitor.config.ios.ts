import type { CapacitorConfig } from '@capacitor/cli'

// iOS 専用設定 (ICT 側 = 測量土木アプリ)
//
// background-geolocation は capacitor-swift-pm 7.x 固定のため Capacitor 8 と非互換。
// iOS では Drogger の BLE から直接 NMEA を受けるため除外する。
//
// ビルド:
//   npm run ios:sync     … このファイルを capacitor.config.ts に コピーしてから
//                          build + cap sync ios し、最後に android 用に 戻す
//   npx cap open ios     … Xcode で ios-ict/ を開く → ⌘R
//
// Capacitor 8 で `--config` オプションは 廃止された。設定の 切替は ios:sync の
// ように capacitor.config.ts を 差し替える 方式で 行う。
//
// 読み込み 方針 (2026-09-29): Android / Mobility と 揃えて Vercel を リモート
// 読み込み する。 Web を push した 瞬間 に iOS 端末 の 画面 も 追従 する
// (Android の 左上 「更新日時」 が 今日 に なる の と 同じ 挙動)。
// webDir: 'dist' は 残す (cap sync 時 に ipa 内 に バンドル は 焼き込まれる)。
// これで App Store 審査 の Guideline 4.2 (Minimum Functionality) 対策 に なる。
// Capacitor plugin bridge (Drogger BLE / Geolocation 等) は 読み込み 方式 に
// 依存 しない ので、 native 機能 は これまで 通り 動く。
//
// この 変更 を 端末 に 反映 する に は 一度 だけ Xcode 再ビルド + 配布 が 必要。
// 以後 は Web push だけ で 自動 反映 される。
const config: CapacitorConfig = {
  appId: 'jp.nodecloud.ict',
  appName: 'NodeCloud',
  webDir: 'dist',
  server: {
    url: 'https://node-cloud-ict.vercel.app',
    cleartext: false,
  },
  ios: {
    path: 'ios-ict',
  },
  includePlugins: [
    '@capacitor/geolocation',
  ],
  packageClassList: [
    'GeolocationPlugin',
    'DroggerLocationPlugin',
  ],
}

export default config