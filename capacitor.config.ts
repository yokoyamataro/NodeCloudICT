import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor 設定
// デフォルトは Vercel にホストされた本番 URL をそのまま表示する（リモートロード）。
// 開発中はローカル dev server を指したい場合に server.url を差し替える。
const config: CapacitorConfig = {
  appId: 'net.nodecloud.ict',
  appName: 'NodeCloud',
  webDir: 'dist',
  server: {
    // 本番（Vercel）— Web を push するだけで全端末に更新が行き渡る
    url: 'https://node-cloud-ict.vercel.app',
    cleartext: false,
    // androidScheme: 'https',
  },
  android: {
    // 位置情報の権限で必要
    allowMixedContent: false,
  },
}

export default config
