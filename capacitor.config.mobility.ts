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
  appId: 'net.nodecloud.mobility',
  appName: 'NodeCloud Mobility',
  webDir: 'dist',
  server: {
    // 起動 URL は /mobility/drive + ?app=mobility を付与し、
    // Web 側で MobilityAppGuard が他画面へのナビを封じる
    url: 'https://node-cloud-ict.vercel.app/mobility/drive?app=mobility',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    // iOS の Background Modes は Xcode で「Location updates」にチェック必須
    contentInset: 'automatic',
  },
}

export default config
