import type { CapacitorConfig } from '@capacitor/cli'

// NodeCloud ICT (測量土木) 用の Capacitor 設定。
//
// 主要用途: Drogger RTK 受信機から Bluetooth SPP 直接受信で 位置情報を取得する。
// (Web ブラウザ経由の Mock GPS 方式から 段階的に移行)
//
// ネイティブプラグイン:
//   net.nodecloud.ict.DroggerLocationPlugin (Kotlin)
//   → src/lib/drogger.ts の 'DroggerLocation' TS wrapper と対応
//
// ビルド手順:
//   1. npm run build                                     (Web バンドル生成)
//   2. CAPACITOR_CONFIG=capacitor.config.ict.ts \
//      npx cap sync android --config capacitor.config.ict.ts  (android-ict/ を同期)
//   3. Android Studio で android-ict/ を開いて Run
//
// 注意:
//   - server.url を Vercel 本番にしているため、Web を push すれば APK 再ビルド不要
//     (ネイティブプラグイン契約を変更した時だけ APK 再ビルド)
//   - Drogger 経由を強制テストする場合、URL に ?locationSource=drogger を付ける
//     または アプリ内 設定 UI で ソース切替 (今後実装)

const config: CapacitorConfig = {
  appId: 'net.nodecloud.ict',
  appName: 'NodeCloud',
  webDir: 'dist',
  // Android プロジェクトディレクトリを明示 (デフォルトの android/ ではなく)
  android: {
    path: 'android-ict',
    allowMixedContent: false,
  },
  server: {
    // 本番 (Vercel) — Web を push するだけで 全端末に更新が行き渡る
    url: 'https://node-cloud-ict.vercel.app',
    cleartext: false,
  },
}

export default config
