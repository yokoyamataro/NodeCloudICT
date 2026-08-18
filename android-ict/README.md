# android-ict — NodeCloud ICT ネイティブアプリ

測量土木 (ICT) 側の Android APK。Drogger RTK 受信機から Bluetooth SPP 経由で
位置情報を直接受信する `DroggerLocationPlugin` (Kotlin) を含む。

主目的: Web ブラウザ + Drogger の Mock GPS 方式から、ネイティブアプリでの
BT SPP 直接受信への段階的移行。

## 前提

- Web バンドル (`../dist/`) が最新であること (`npm run build`)
- Capacitor CLI がインストールされていること (`npm install`)
- Android Studio 2024.2+ / JDK 21 / Android SDK (API 35 推奨)

## 初回セットアップ

このディレクトリは 手動で作成された ため、`node_modules/@capacitor/android` へ
のリンク や `capacitor-cordova-android-plugins/` の生成が 必要な場合がある:

```bash
# プロジェクトルートから
npm run build
CAPACITOR_CONFIG=capacitor.config.ict.ts \
  npx cap sync android --config capacitor.config.ict.ts
```

`cap sync` は 以下を更新する:
- `app/src/main/assets/public/` — Web バンドル
- `app/src/main/assets/capacitor.config.json` — 設定
- `app/src/main/assets/capacitor.plugins.json` — プラグイン一覧
- `capacitor-cordova-android-plugins/` — Cordova プラグイン集
- `capacitor.settings.gradle` — @capacitor/android への path

## Drogger プラグイン

`app/src/main/java/net/nodecloud/ict/DroggerLocationPlugin.kt`

TS 側 (`src/lib/drogger.ts`) の契約と対応:

| method / event | 実装 |
|---|---|
| `start({deviceAddress?})` | SPP UUID (`00001101-...`) で BT ソケット接続 → NMEA read loop |
| `stop()` | ソケット閉じ + read loop 停止 |
| `getStatus()` | { connected, deviceName } |
| `listPairedDevices()` | ペアリング済み BT デバイス列挙 |
| `location` イベント | `$GNGGA` + `$GNRMC` を組合せ 1 Hz で emit |
| `error` イベント | 接続失敗 / IO エラー |
| `statusChange` イベント | 接続 ON/OFF |

**注意点:**
- `accuracy_m` は GGA に無いので `HDOP × 3.0m` で概算。実運用では `$GNGST` の
  Lat/Lon std dev を使うのが厳密
- Android 12+ (API 31) は `BLUETOOTH_CONNECT` / `BLUETOOTH_SCAN` がランタイム
  権限。`start()` 内で自動リクエストする
- 現状 Foreground Service なし (アプリを閉じると受信停止)。バックグラウンド
  継続が必要なら 別途 Service を実装

## ビルド

```bash
cd android-ict
./gradlew assembleDebug   # debug APK
./gradlew assembleRelease # release APK (署名鍵設定要)
```

または Android Studio で `android-ict/` を Open。

## デバッグ

Chrome の `chrome://inspect` で WebView をリモートデバッグ可能。
`start()` が呼ばれた際の logcat タグは `DroggerLocationPlugin`。

## モビリティ APK との違い

| 項目 | android-mobility/ | android-ict/ |
|---|---|---|
| appId | `net.nodecloud.mobility` | `net.nodecloud.ict` |
| appName | NodeCloudモビリティ | NodeCloud |
| 起動 URL | `/mobility/drive?app=mobility` | Vercel トップ |
| Drogger BT 受信 | 未対応 | **対応** |
| バックグラウンド位置 | 対応 (Foreground Service) | 未対応 (今後) |
