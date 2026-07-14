# TODO

NodeCloud (ICT 農業土木施工システム) の未対応タスク一覧。
更新日: 2026-07-15

---

## 🔥 直近ホットな保留 (すぐ動かせる)

- [x] ~~Supabase Dashboard: Redirect URLs に `/reset-password` を追加~~ — 既存の `.../*` パターンでカバー済み (2026-07-15 確認)
- [ ] **Supabase Dashboard: Email Template 日本語化** (Magic Link / Reset Password / Invite user / Confirm signup の 4 種)
- [ ] **巨大 7 市 (天草/唐津/岩国/高松/東広島/佐渡/一関) の Storage upload 失敗**
  - bucket `file_size_limit = 1 GiB` に引き上げ済でも 50MB 上限エラー
  - **プロジェクトレベルの upload 上限** (Dashboard → Project Settings → Storage → File upload size limit) を確認 → 1000 MB 以上に変更が必要
  - 修正後 `node scripts/sync-parcel-maps.mjs --prefecture 03,15,34,35,37,41,43 --concurrency 2` で再取得

## 🧪 実装済み・エンド-エンド検証待ち (2026-07 追加分)

- [ ] 認証: **Magic Link** (メール受信 → クリック → ログイン) の実機フルテスト
- [ ] 認証: **パスワード再設定** (`/settings/password` + `/reset-password`) のフルテスト
- [ ] 認証: **ユーザーメニュー** (ヘッダ右上ドロップダウン) のクリック感確認
- [ ] 組織: **メンバー招待フロー** (別ユーザーでログイン → 招待受諾 → organization_members に自動転記) の実機テスト
- [ ] 組織: **電話番号列** (`profiles.phone`) の onBlur 保存とバリデーション
- [ ] 座標管理: **測点クリック時パネル** (点種/杭種/設置/備考 の編集) の使い心地
- [ ] 地番マップ: **ラベル chunked binding** で pinch/pan の重さが解消されたか
- [ ] 全般: **ErrorBoundary + chunk 自動リロード** — 次回デプロイ時に「一部 PC で真っ白」が消えるか

---

## 🚀 大機能 (未実装)

### 業務機能
- [ ] **サブユーザー管理** (社内アカウントの子アカウント発行、権限限定)
- [ ] **CAD 出力: SFC 形式対応** (DWG/DXF に加えて)
- [ ] **客土の坪置図面** 作成機能
- [ ] **暗渠の出来形管理** 機能
- [ ] **路線 SIM インポート**
- [ ] **地番データの属性機能強化** (所有者情報、地目変更履歴等)
- [ ] **地積測量図** 作成・エクスポート
- [ ] **建物図面** 作成・エクスポート
- [ ] **直落ち暗渠** 対応
- [ ] **ファイル保存機能** (LandXML 以外の作業ファイル全般)

### 認証・招待
- [ ] **Phone Auth (SMS OTP)** — Supabase Phone Provider + Twilio 契約 + `auth.users.phone` 同期 + UI
  - 準備: `profiles.phone` は 2026-07-15 に導入済
- [ ] **Custom SMTP (Resend)** への切替 — 組み込みメール 30 通/時の壁を解消
  - 現状の 30/時 でも実運用は問題無いが、招待やテストで詰まる

### 登記情報連携
- [ ] **登記情報 AI パース強化** — 現状 `src/lib/registryPdf.ts` は正規表現ベース。Claude Vision / GPT-4V で精度向上余地
- [ ] **`RegistryCredentialsPage` の実用途決定** — touki.or.jp の ID/PW 保管箱は作った (2026-07-13) が、それを使う導線が無い
  - 案: 「地番選択画面から touki.or.jp を開く際に自動ログイン」または削除

---

## 📄 ドキュメント / 運用 (基盤整備、今後 3 ヶ月の推奨)

- [ ] **README を書き直し** (現状 Vite テンプレのまま) — 概要 / セットアップ / デプロイ手順
- [ ] **doc/architecture.md** — テーブル一覧 + Edge Function 一覧 + 主要フロー
- [ ] **E2E テスト**: Playwright で smoke test 1 本 (ログイン → 工事一覧 → 工区開く)
- [ ] **CI/CD**: GitHub Actions で以下を自動化
  - `supabase db push` (migration の反映)
  - `supabase functions deploy` (Edge Function のデプロイ)
- [ ] **Sentry** など監視サービス導入 (今日入れた ErrorBoundary の受け皿)

## 🎨 UX 改善余地 (小粒)

- [ ] ログイン画面「開発中プロトタイプです」バッジの見直し (本番運用時)
- [ ] Supabase Studio SQL Editor の履歴に平文パスワードが残る問題 (2026-07-13 の緊急復旧手順) — 「.env の service_role キー使った Node ワンライナー」に移行する運用手順を残す

---

## ✅ 対応済み (履歴、直近 3 ヶ月)

### 2026-07 追加分
- [x] 全国 1740 市町村の法務省地図データ自動同期 (gzip + streaming JSON parse + chunked upload)
- [x] 地番マップ layer: label toggle 廃止 → 常時 ON + zoom / feature 数で自動抑制
- [x] 地番マップ layer: 表示範囲プリセット撤廃 → 常に現在ビュー限定
- [x] 「地番から工区作成」フロー (都道府県 → 市町村 → 所在 → 本番/枝番 の cascading combobox)
- [x] 認証: パスワード + Magic Link ハイブリッド + パスワード再設定フロー + Reset Password ページ
- [x] ヘッダにユーザーメニュー (登記情報 / パスワード変更 / ログアウト)
- [x] 座標管理: 測点クリック時に写真パネル自動オープン + 点情報の inline 編集
- [x] 組織メンバー制 (organization_members + admin/member ロール + Phase 1〜3 完了)
- [x] `AdminUsersPage` を廃止し `AdminOrganizationsPage` に統合 (Master-Detail + 検索)
- [x] メンバー電話番号列 (profiles.phone)
- [x] ErrorBoundary + chunk 自動リロード (デプロイ後の真っ白防止)
- [x] `admin-delete-user` / `invite-member` Edge Function デプロイ
- [x] Supabase pgcrypto + Vault で登記情報提供サービスの ID/PW 保管基盤

### それ以前
- [x] 写真帳出力機能
- [x] 測点写真管理機能
- [x] 路線測量にクロソイド対応
- [x] 横断測量機能
- [x] 工程管理機能
- [x] LandXML 表示・管理機能
- [x] 自己位置マーカー矢印化 (停止中も方位維持)
- [x] RTK-GNSS におけるジオイド補正対応
- [x] 平面図 CAD 出力に集水の縦断変化点を追加
- [x] LandXML 出力機能 (中心線形 + TIN サーフェス、LandXML 1.2)
- [x] LandXML 出力の Face 頂点順を反転 (CCW / 上向き法線)
- [x] LandXML 重複チェック (三角形の内部重なり検出)
- [x] メンバー方式の RLS (工事ごとに project_members 登録者のみ閲覧)
- [x] Android アプリの出力
- [x] CAD 出力に配線番号を各配線中央に (layer 2005)
- [x] 路線測量機能

---

## ⚠️ 継続的注意事項 (memory から)

- **Edge Function は手動デプロイ運用** — ローカル `index.ts` ≠ 本番。「Failed to send a request to the Edge Function」はまず未デプロイ疑い。CI 化まで注意
- **Supabase Storage RLS は `TO authenticated`** — `public` 指定だとアップロードが 403 で弾かれる (新 API キー方式)
- **LandXML は工区別 Storage 保管** — bucket 'landxml' + `landxml_files` メタ、モバイルは工区を開くと自動 fetch・自動アップロード
- **Parcel map sync 実測**: aigid-moj-map 直 GeoJSON、山形県 36 市町村 225 秒、鶴岡市 raw 260MB、gzip で 50MB 上限クリア
