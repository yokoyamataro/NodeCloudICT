import type { CapacitorConfig } from '@capacitor/cli'

// NodeCloud Mobility (運転手専用アプリ) 用の Capacitor 設定。
//
// メインの capacitor.config.ts と共存させて、iOS 側では以下のように使う想定:
//   Mac で `CAPACITOR_CONFIG=capacitor.config.mobility.ts npx cap add ios`
//   もしくは、`ios-mobility/` フォルダを作って Xcode プロジェクトを手動生成
//
// Android 側は android-mobility/ ディレクトリを直接管理するため、
// この config ファイルは iOS の初回セットアップ用と、参照用ドキュメントとして使う。

const config: CapacitorConfig = {
  appId: 'jp.nodecloud.mobility',
  appName: 'NodeCloudモビリティ',
  webDir: 'dist',
  server: {
    // 起動 URL は 専用エントリ (mobility.html / basename '/m')。
    // ドライバー画面しか 積んでいないので ?app=mobility も 実行時ガードも 不要。
    url: 'https://node-cloud-ict.vercel.app/m/drive',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  // @capacitor-community/background-geolocation は capacitor-swift-pm 7.x 固定で
  // Capacitor 8 と 依存解決できない (実測エラー:
  //   'background-geolocation' depends on capacitor-swift-pm 7.0.0..<8.0.0 /
  //   'geolocation' depends on 8.0.0..<9.0.0)
  // iOS では 同名 ('BackgroundGeolocation') の プラグインを 自前で 実装して 置き換える。
  // TS 側は registerPlugin('BackgroundGeolocation') で 名前解決しているだけ なので変更不要。
  includePlugins: [
    '@capacitor/geolocation',
  ],
  packageClassList: [
    'GeolocationPlugin',
    'MobilityLocationPlugin',
  ],
  ios: {
    // 標準の ios/ ではなく ios-mobility/ をプロジェクトディレクトリにする
    path: 'ios-mobility',
    // iOS の Background Modes は Xcode で「Location updates」にチェック必須
    contentInset: 'automatic',
  },
}

export default config
