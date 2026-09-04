import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor 設定 (ICT 側 = 測量土木アプリ)
//
// Web を Vercel からリモートロードする方式。
// Android プロジェクトは android-ict/ (Drogger RTK BLE 直接受信対応)。
//   → 標準の `android/` ではなく android-ict/ に向けている
//
// ビルド:
//   npm run build
//   npx cap sync android          (android-ict/ を対象に同期)
//   npx cap open android          (Android Studio で android-ict/ を open)
//
// 別 APK (モビリティ) は capacitor.config.mobility.ts + android-mobility/ を使う。
const config: CapacitorConfig = {
  appId: 'jp.nodecloud.ict',
  appName: 'NodeCloud',
  webDir: 'dist',
  server: {
    // 本番（Vercel）— Web を push するだけで全端末に更新が行き渡る
    url: 'https://node-cloud-ict.vercel.app',
    cleartext: false,
    // androidScheme: 'https',
  },
  android: {
    // 標準の android/ ではなく android-ict/ をプロジェクトディレクトリにする
    path: 'android-ict',
    // 位置情報の権限で必要
    allowMixedContent: false,
  },
  ios: {
    path: 'ios-ict',
  },
}

export default config
