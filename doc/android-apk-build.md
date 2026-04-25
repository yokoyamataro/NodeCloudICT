# Android APK ビルド手順

NodeCloud ICT アプリを Capacitor でラップして Android APK を作る手順。

## 構成方針

- **リモートロード方式**: APK は空の WebView 入れ物として機能し、`https://node-cloud-ict.vercel.app` を表示する
- **利点**: Web を push すればすべての端末に即反映、Play ストア再提出不要
- **欠点**: オフラインで動作しない（オンライン必須）
- オフライン対応が必要になったら `server.url` を外して `webDir: 'dist'` の同梱方式に切替

## 前提

- Node.js / npm（既に導入済み）
- **Android Studio** をインストール（開発者 PC 側、初回のみ）
  - https://developer.android.com/studio
  - Android SDK / Build Tools / Platform-Tools も Android Studio 内から取得
- JDK 17+（Android Studio 同梱のものが使える）

## 初回セットアップ

プロジェクトルート (`NodeCloudICT/`) で以下を実行:

```bash
# 1. Web ビルド（capacitor が dist/ を参照する）
npm run build

# 2. Capacitor 初期化（既に capacitor.config.ts がコミット済みなのでスキップ可）
# npx cap init NodeCloud net.nodecloud.ict --web-dir=dist

# 3. Android プラットフォームを追加（android/ フォルダが作られる）
npx cap add android

# 4. Android Studio で開く
npx cap open android
```

## ビルド

Android Studio で以下を実行:

1. `File > Sync Project with Gradle Files`
2. `Build > Build Bundle(s) / APK(s) > Build APK(s)`
3. 出力先: `android/app/build/outputs/apk/debug/app-debug.apk`

コマンドラインからビルドする場合:

```bash
cd android
./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

## 端末へのインストール

1. 端末の「設定 > 開発者オプション」で **USB デバッグを ON**
2. PC に USB 接続
3. `adb install android/app/build/outputs/apk/debug/app-debug.apk`

または APK を端末に転送してタップインストール（不明なソースの許可が必要）。

## RTK-GNSS（DROGGER）の設定

1. 端末に **DROGGER** アプリをインストール（Google Play）
2. Bluetooth で RTK 受信機とペアリング
3. 端末の「設定 > 開発者オプション」で **Mock Location アプリを選ぶ** → DROGGER を選択
4. NodeCloud アプリを起動し、圃場 → **起工測量** を開く
5. 画面上部の精度表示が cm オーダーになれば RTK fix 成功

## 注意事項

- 初回起動時に **位置情報の権限** を許可
- リモートロード方式のため、アプリ起動中はネット接続必須
- Web を更新すると自動で反映（WebView のキャッシュで遅延する場合は再起動で解消）

## トラブルシューティング

| 症状 | 原因・対処 |
|---|---|
| 画面が真っ白 | Vercel 側の URL が変わった → `capacitor.config.ts` の `server.url` を修正 |
| 位置情報が取れない | 端末の位置情報権限と位置情報サービス自体が ON か確認 |
| 精度が数 m のまま | DROGGER の Mock Location 設定を確認、RTK fix しているか DROGGER 側 UI で確認 |
| APK ビルドが失敗 | Android Studio で Gradle sync、SDK / Build Tools のバージョンを整える |
