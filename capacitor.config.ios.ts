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
// server.url を コメントアウトしている ため、iOS は Vercel ではなく 端末内に
// バンドルされた dist を 読む。Web を 変更したら ios:sync + Xcode 再ビルドが必要。
const config: CapacitorConfig = {
  appId: 'jp.nodecloud.ict',
  appName: 'NodeCloud',
  webDir: 'dist',
//  server: {
//    url: 'https://node-cloud-ict.vercel.app',
//    cleartext: false,
//  },
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