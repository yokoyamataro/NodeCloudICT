# NodeCloudICT 仕様書

> 現段階の実装状況を反映した仕様スナップショット。
> 最終更新: 2026-08-16

---

## 1. 概要

**NodeCloudICT** は 地籍測量及び農業土木施工 (北海道の道営・国営農地整備事業を主対象) 向けの Web-based ICT 設計システム。
1 つのプロジェクト (工区) 単位で、地籍測量・暗渠設計・水理計算・施工計画・調査報告書作成・車両動態管理までを 1 つの Web アプリで完結させることを目的とする。

### 1.1 対象ユーザー

| 役割 | 主な使い方 |
|---|---|
| 測量設計会社 | 地権者情報・地番測量結果を管理し、土地調査報告書を出力する |
| 施工業者 (元請) | CAD 図面から暗渠系統を組み立て、水理計算書・LandXML を出力する |
| 現場作業者 | スマホで実測記録・杭打ち・工事記録を入力 (オフライン対応) |
| 車両管理者 | 現場の車両・ドライバーの位置と稼働状態をリアルタイム監視 (モビリティ製品) |

### 1.2 契約単位

- **組織 (Organization)** が契約単位。1 組織に複数ユーザー・複数プロジェクトが所属。
- 組織は **contract product** (`cadastral` / `civil` / `mobility`) の組合せで契約する。
  - `cadastral` — 地籍測量 (地番・地権者・土地調査報告書)
  - `civil` — 土木設計 (暗渠・客土・整地・線形物 など)
  - `mobility` — 車両動態管理 (1 台 1,800 円/月 + 税)

---

## 2. システム構成

### 2.1 技術スタック

| 層 | 使用技術 |
|---|---|
| フロント | React 19 + TypeScript + Vite 7 |
| 状態管理 | Zustand 5 (feature 単位のストア) |
| UI | Tailwind CSS 4 + lucide-react |
| 地図 | Leaflet 1.9 + react-leaflet + PMTiles + proj4 (平面直角座標 ↔ WGS84) |
| バックエンド | Supabase (PostgreSQL + Auth + Storage + Realtime + Edge Functions) |
| Excel / Word | ExcelJS + xlsx + docxtemplater |
| PDF | pdfjs-dist |
| AI 解析 | Claude Sonnet 4.6 / Haiku 4.5 (Edge Function 経由で PDF/DXF 抽出) |
| モバイル | Capacitor 8 (Android APK; モビリティ製品のみ) |

### 2.2 リポジトリ構成

```
c:\lab\NodeCloud\
├── NodeCloudICT\              # メインアプリ (Web / SPA)
│   ├── src\
│   │   ├── App.tsx                       # React Router 定義
│   │   ├── components\layout\AppLayout   # ナビ + Chrome
│   │   ├── features\<domain>\            # 機能別画面 (下記参照)
│   │   ├── stores\                       # Zustand ストア
│   │   ├── components\map\               # 地図共通コンポ (PipeMap / UnifiedFieldMap 等)
│   │   ├── components\charts\            # CrossSectionChart (縦断図)
│   │   ├── lib\                          # DXF/JPGIS/LandXML/Excel パーサ・ユーティリティ
│   │   └── types\database.ts             # Supabase テーブル型定義
│   ├── supabase\
│   │   ├── migrations\                   # DB スキーマ (SQL)
│   │   └── functions\                    # Edge Function (Deno)
│   ├── android-mobility\                 # モビリティ APK (Capacitor)
│   └── public\                           # Excel テンプレ・アイコン等
├── services\registry-fetcher\             # 登記情報取得サービス (Node バッチ)
└── doc\                                  # 参考資料 (Excel 様式・CAD サンプル)
```

### 2.3 認証・認可

- Supabase Auth (email + password / Magic Link / 招待リンク)
- 権限モデル
  - `site_owner` — 全組織・全データにアクセス可 (運営元)
  - `organization_members.role` = `admin` / `member` — 組織内権限
  - `project_members.role` = `owner` / `editor` / `viewer` — プロジェクト内権限
- RLS (Row Level Security) で テーブル単位に権限制御
  - **重要**: 組織メンバーシップは `organization_members` を権威ソースとする (`profiles.organization_id` は欠損することがあり、条件に使わない)

---

## 3. ナビゲーション / ルート

`src/App.tsx` に集約。以下は工種フィルタ (`ProjectCategory` = `cadastral` / `civil`) で表示切替される。

### 3.1 認証系 (未ログイン)

| Path | 画面 |
|---|---|
| `/login` | ログイン (email/password + Magic Link) |
| `/accept-invite` | 招待リンク受領 |
| `/reset-password` | パスワード再設定 |
| `/lp` | ランディングページ |
| `/apply` | 申し込み受付 |
| `/terms` / `/privacy` | 規約・プライバシーポリシー |

### 3.2 プロジェクト・工区管理

| Path | 画面 |
|---|---|
| `/` | プロジェクト/工区選択 (ホームゲート) |
| `/projects/:projectId` | プロジェクト内の工区一覧 |
| `/mobile` | モバイル用プロジェクト選択 |
| `/trash` | ゴミ箱 (soft delete 復元) |

### 3.3 共通ツール

| Path | 画面 |
|---|---|
| `/coordinates` | 座標管理 (測点 CRUD + 地図可視化) |
| `/staking-records` | 実測記録一覧 (SIMA/CSV 出力) |
| `/site-map` | 現場地図全画面 (別ウィンドウ) |
| `/orthophoto` | オルソ写真背景レイヤ管理 |
| `/memos` | 工区メモ |

### 3.4 地籍測量 (`cadastral`)

| Path | 画面 |
|---|---|
| `/boundary-survey/work-area` | 地番管理 (表 + 別ウィンドウ地図) |
| `/boundary-survey/landowners` | 地権者管理 |
| `/boundary-survey/land-report` | 土地調査報告書作成 (Excel 出力) |

### 3.5 暗渠 (`civil` / underdrain)

| Path | 画面 |
|---|---|
| `/underdrain/work-area` | 工事区域管理 |
| `/underdrain/cad-analysis` | DXF/SFC 解析 (Claude AI で管径・延長抽出) |
| `/underdrain/pipe-wiring` | 配管系統設計 (吸水/集水/落口/合流 の系統図) |
| `/underdrain/coordinate-calc` | 座標計算 (管路頂点の座標付与) |
| `/underdrain/depth-calc` | 施工計画 (地盤高/計画高/切深/勾配・水理延長 計算 + 縦断図) |
| `/underdrain/landxml` | LandXML 出力 |
| `/underdrain/field-data` | 実測記録閲覧 (staking_records) |

### 3.6 その他工種 (`civil`)

| Path | 画面 |
|---|---|
| `/soil-import/work-area` | 客土工事区域 |
| `/soil-import/strip-plan` | ストリップ計画 |
| `/soil-import/heap-plan` | 坪置図面 (未実装) |
| `/simple-grading/work-area` | 簡易整地 |
| `/grading/work-area` | 整地 |
| `/subsoil/work-area` | 心破土改 |
| `/stone-removal/work-area` | 徐礫 |
| `/open-channel/alignment` | 線形物 (水路・道路) |

### 3.7 モビリティ (`mobility`)

| Path | 画面 | 対象 |
|---|---|---|
| `/mobility` | ダッシュボード (車両位置・状態) | admin |
| `/mobility/vehicles/:id` | 車両管理 | admin |
| `/mobility/users/:id` | ドライバー管理 | admin |
| `/mobility/logs` | 走行記録 | admin |
| `/mobility/projects[/:id]` | モビリティプロジェクト | admin |
| `/mobility/drive` | リアルタイム地図 (乗車中) | driver (APK) |

### 3.8 モバイル (スマホ自動判定 → `/mobile` へ)

| Path | 画面 |
|---|---|
| `/mobile/farms/:projectId` | 工区トップ |
| `/mobile/map` | 詳細地図 |
| `/mobile/staking` | 測設記録入力 (RTK-GNSS) |
| `/mobile/construction` | 暗渠施工記録入力 |

### 3.9 管理・設定

| Path | 画面 |
|---|---|
| `/admin/signups` | 申し込み管理 (site_owner) |
| `/admin/organizations` | 組織・メンバー管理 (site_owner) |
| `/admin/announcements` | お知らせ管理 (site_owner) |
| `/admin/parcel-maps` | 地番マップ管理 (site_owner) |
| `/settings` | 工区設定 |
| `/settings/registry` | 登記情報提供サービス認証 |
| `/settings/password` | パスワード変更 |
| `/share/farm/:farmId` | 公開共有ビュー (認証不要 / 読み取り専用) |

---

## 4. 機能仕様

### 4.1 座標管理 (`/coordinates`)

- 測点の CRUD (点番号・平面直角座標 X/Y/Z・点種・備考)
- 点種 (`control` / `boundary` / `underdrain` / `soil_import` / `stake` + ユーザー定義)
- SIMA / CSV / DXF 入出力
- 地図可視化 (Leaflet)
- 地番マップ (背景) と重ね合わせ
- 一括計算 (面積・周長・座標変換)

### 4.2 実測記録 (`/staking-records`)

- スマホから記録した `staking_records` の一覧
- 起工測量 (`initial`) / 出来形測量 (`asbuilt`) を区別
- 設計座標 (target X/Y/Z) と 実測座標 (measured X/Y/Z) の 2 段ヘッダで並列表示
- **Z 補正値**: 工区単位で `design_survey_calibration.dz_offset` に保存。
  - 補正後 Z = `measured_z + dz_offset` で表示
  - DB を権威、localStorage `staking:zOffset:{farmId}` はフォールバック
- ΔX / ΔY / 水平誤差 / 精度 (m) / サンプル数
- SIMA / CSV 出力

### 4.3 地番管理 (`/boundary-survey/work-area`)

- 表 (メインウィンドウ) + 地図 (別ウィンドウ / chrome-less) の 2 画面構成
- 地番 (Parcel) の CRUD (所在・地番・地目・地積・座標)
- 地番マップ (法務省 JPGIS/GeoJSON) を PMTiles で背景表示
- 地図上でポリゴンをクリック → 表の該当行にスクロール (postMessage 同期)
- 面積計算書 / 区域削除 ボタンは横書き
- 対象 parcel と 地権者 (Landowner) の N:N 割当 (`parcel_landowners`)

### 4.4 地権者管理 (`/boundary-survey/landowners`)

- 地権者 (Landowner) の CRUD
- 属性: `applicant` (申請人) / `adjacent` (隣接者) — バッジ色で区別
- 本人確認方法: `license` / `idcard` / `meishiki` / `other` (本人 + 立会人 それぞれ)
- 住所・電話・立会人氏名・立会人続柄・立会人住所 (立会人フィールドは任意)
- 土地調査報告書に転記される

### 4.5 土地調査報告書作成 (`/boundary-survey/land-report`)

**報告書一覧表示列**: 報告書番号 / 作成日 / 登記の目的 / 調査した土地 (先頭+他N筆) / 最終更新 / 操作

**セクション構成**:
| 番号 | セクション |
|---|---|
| 01 | 登記の目的 (2 列レイアウト: 事由 ↔ 変更/更正 複数選択可) |
| 02 | 調査した土地 |
| 03 | 所有権登記名義人 (地権者選択モーダルから取込。所有地は `parcel_landowners` からインポート) |
| 04 | 現地確認 |
| 05 | 基本三角点等 (等級を日本語表示、写真は連携座標から取込) |
| 06 | 原本確認結果 (定型句登録 + 履歴取込) |
| 07 | 交叉法 |
| 08 | 引照点 |
| 09 | 基本三角点等に基づく測量ができない理由 (定型句登録 + 履歴取込) |
| 10 | 補足・特記事項 (定型句登録 + 履歴取込) |

**報告書番号自動採番**: `YY00001` 形式 (例: `2600001`)。年頭リセット・工区内最大値 + 1

**Excel 出力** (`public/調査報告書様式.xlsx` テンプレ):
- アンカートークン `{{ANCHOR:NAME}}` (単一行) と `{{ANCHOR:NAME:START/END}}` (ブロック) で領域を指定
- 系統的な行複製 + merge 復元 (merge snapshot → clearAllMerges → shift & restore)
- 数値変換は 小数点を含む場合のみ (地番 `343` や 電話 `0153...` の誤変換防止)
- 外枠罫線は AP 列の左罫線として書込 (AO 右罫線は merge されているため書込不可)
- 座標に紐づく写真を 1 行あたり 2 枚 (280×210 px) でブロック複製埋込

### 4.6 暗渠 - 配管系統 (`/underdrain/pipe-wiring`)

- 集水暗渠 (タブ複数) + 直落暗渠 の 2 系統
- 行タイプ (`RowType`):
  - `absorption_end` — 吸水端部
  - `absorption_merge` — 吸水合流
  - `collector_merge` — 集水合流 (別系統との合流点。合流先系統番号 `mergeSystemIndex` を保持)
  - `collector_change` — 集水変化点
  - `collector_junction` — 集水合流点
  - `outlet` — 落口
- 各行に 吸水管 + 集水管 を割当
- 系統ごとに支配延長・累加延長を自動計算 (下記 4.9 参照)
- 系統末端 (`endType`): `outlet` (落口) / `merge` (合流) / `open` (未完)

### 4.7 暗渠 - CAD 解析 (`/underdrain/cad-analysis`)

- DXF / SFC ファイルを読み込み → pipe run 候補を抽出
- Edge Function `analyze-underdrain-cad` が Claude Sonnet 4.6 に情報を送信し、管径・延長を推定
- 候補を確認して pipes テーブルに登録

### 4.8 暗渠 - 座標計算 (`/underdrain/coordinate-calc`)

- 管路頂点に測点名を自動採番 (下流端 `A` → 上流端 `C` → 中間 `B1/B2...`)
- 交点処理 (吸水と集水の交点で吸水管を分割)

### 4.9 暗渠 - 施工計画 (`/underdrain/depth-calc`) ⭐ 中核画面

**画面構成**: 表 (左) + 平面図 (右) の 2 画面 (左右分割)。縦断図は ツールバー「縦断図」ボタンで別ウィンドウ (`?panel=chart` / chrome-less popup) を開いて表示。各パネル (table / map / chart) は独立ウィンドウで表示可能。

**表 (行 1 系統分)**: 種別 / 地盤高 / 計画高 / 切深 / 区間距離 / 区間勾配 / 管径 / 水理延長 / 限界勾配 の 9 段

**主な計算**:

**吸水水理延長 (per-point)**:
- 最上流端: `配線間隔/4` (端部補正)
- それ以降: `端部補正 + 累加区間距離`
- 下流端点 (系統内で最初の吸水行を除く): さらに `配線間隔/2` を減算 (接続補正)

**集水累加水理延長 (per-row)**:
- 通常行: `前行 cum + 吸水下流端 + 自身の集水区間`
- 集水合流行 (本管側): `前行 cum + 枝管系統累加 (-w/2 減算済) + 本管区間距離`
- 系統末端 `endType='merge'`: 最終行 cum から `-配線間隔/2` を減算 (枝管側の表示にも反映)
- 系統間依存 (集水合流) は 最大 6 回反復解決 (`collectorCumByRowId` useMemo)

**限界勾配** (Manning 逆算):
- `computeCriticalSlopeDenominator({ 管径, 粗度, 水理延長, 計画流量, 配線間隔 })`
- 実勾配 > 限界勾配 or 逆勾配 → 赤 `!` 表示

**逆勾配警告** (`区間勾配` セル):
- 集水: `collector.plannedHeight <= next.collectorPoint.plannedHeight` で赤 (`! 1/N`)
- 縦断図側: 逆勾配は「逆 1/N」を赤で表示 (勾配不足も赤)

**自動計画高計算** (`autoCalculatePlannedHeights`):
- パラメータ: 吸水標準切深 `kh` / 集水標準切深 `sh` / 最低勾配 `imin` / 推奨勾配 `istd`
- スコープ: 現系統のみ / 全系統

**地盤高読込 (`reloadGroundHeights`)**:
- `staking_records` の起工測量 (`initial`) から補正後 Z (`measured_z + dz_offset`) を各測点座標に近傍マッチで割当

**地図オーバーレイ切替** (右上パネル):
- 地盤高 / 計画高 / 切深 / 管径 / 勾配 / 区間距離 (各測点/区間ラベル)
- **実測記録** (staking_records) マーカー ⭐ 新機能
  - チェックで トグル ON/OFF (既定 OFF)
  - マーカー = 点名 (上) + ドット (青=起工/緑=出来形) + 補正後標高 `measured_z + dz_offset` (下)
  - Z 補正値は工区の `design_survey_calibration.dz_offset` を DB → localStorage 順で解決

**縦断図 (`CrossSectionChart`)**:
- 系統 (集水スコープ) / 吸水管 (吸水スコープ) の 2 モード
- 計画高をマウスドラッグで編集 (感度 30%, `SENSITIVITY = 0.3`)
- LandXML TIN サーフェスを断面として重ね表示
- 集水合流のマージ流入を可視化

**Excel 出力**:
- 水理計算書 (`public/水理計算書様式.xlsx`)
- 測定結果一覧表 (`public/測定結果一覧表様式.xlsx`)
- SFC 平面図 (`sfcPipeExport.ts`)
- 縦断図 DXF (`crossSectionDxfExport.ts`)

### 4.10 暗渠 - LandXML 出力 (`/underdrain/landxml`)

- 施工計画を `<LandXML>` (Surface + Alignment) に変換
- Storage bucket `landxml` に保管 (`landxml_files` テーブルにメタデータ)
- モバイル側で工区を開くと自動 fetch → LandXMLPage で編集可能

### 4.11 モビリティ (`/mobility` + APK)

- 車両 (`vehicles`) の登録 (車種・ナンバー・使用組織)
- ドライバー (`profiles`) との割当 (`vehicle_assignments`)
- APK ドライバーアプリ (`/mobility/drive`):
  - Capacitor `@capacitor-community/background-geolocation` で バックグラウンド位置取得
  - オフラインキューイング (通信復帰時に一括送信)
- Realtime 更新 (Supabase Realtime): 管理画面の地図がリアルタイム反映
- モビリティプロジェクト (`mobility_projects`): 「何月何日の現場」を管理する単位
- モビリティチャット (`mobility_messages`): 車上 ↔ 管理画面の連絡

**課金**: 1 台 1,800 円/月 + 税 (相場 2〜5 千円の下限より少し安く、3 台で黒字化する水準)

### 4.12 共有ビュー (`/share/farm/:farmId`)

- 認証不要でアクセス可能な 読み取り専用の工区ビュー
- 対象データ・有効期限は `shared_farm_views` で制御

---

## 5. 主要データモデル

`src/types/database.ts` に集約された Supabase テーブル型。以下は主要なもののみ。

### 5.1 コア

| Table | 主キー / 主フィールド | 補足 |
|---|---|---|
| `profiles` | `id` (auth.users FK), full_name, phone | ユーザー情報 |
| `organizations` | `id`, name, code | 契約組織 |
| `organization_members` | `organization_id`, `user_id`, role | 権威ソース |
| `organization_products` | `organization_id`, `product` | cadastral / civil / mobility |
| `projects` | `id`, name, organization_id, category | 工事プロジェクト |
| `farms` | `id`, project_id, name | 工区 (Project の下位単位) |
| `project_members` | `project_id`, `user_id`, role | owner / editor / viewer |

### 5.2 座標・測量

| Table | 主フィールド |
|---|---|
| `coordinates` | farm_id, point_number, x, y, z, point_type |
| `design_survey_data` | farm_id, point_number, x, y, z, dz_raw, dz_calibrated |
| `design_survey_calibration` | farm_id (unique), is_enabled, dz_offset |
| `staking_records` | farm_id, survey_category (initial/asbuilt), target_x/y/z, measured_x/y/z, target_name, accuracy |
| `work_areas` | farm_id, work_type, area_polygon (GeoJSON) |
| `landxml_files` | farm_id, storage_path (bucket `landxml`) |

### 5.3 暗渠

| Table | 主フィールド |
|---|---|
| `pipes` | farm_id, number, pipe_type, diameter, design_length, vertices (JSONB) |
| `pipe_wiring_rows` | farm_id, row_type (RowType), absorption_pipes[], collector_pipe, merge_system_index |
| `construction_plan_rows` | farm_id, group_type, systemIndex, absorption_points, collector_point |

### 5.4 地籍測量

| Table | 主フィールド |
|---|---|
| `parcels` | farm_id, chiban, land_category, area, geom |
| `parcel_map_datasets` | prefecture_code, city_code, pmtiles_path |
| `landowners` | farm_id, full_name, address, phone, attribute (applicant/adjacent), id_method, agent_* |
| `parcel_landowners` | parcel_id, landowner_id |
| `land_reports` | farm_id, report_no, body (JSONB) |
| `organization_report_snippets` | organization_id, section_key, text |

### 5.5 モビリティ

| Table | 主フィールド |
|---|---|
| `vehicles` | organization_id, model, plate |
| `vehicle_assignments` | vehicle_id, user_id, effective_from/to |
| `mobility_positions` | user_id, vehicle_id, timestamp, lat, lng, accuracy |
| `mobility_projects` | organization_id, name, date |
| `mobility_project_members` | mobility_project_id, user_id, role |
| `mobility_messages` | mobility_project_id, sender_id, body |

### 5.6 その他

| Table | 補足 |
|---|---|
| `attachments` | Storage bucket ファイル + メタデータ |
| `map_drawings` | 地図上の描画 (線・矢印・テキスト・図形) |
| `farm_memos` | 工区メモ |
| `announcements` | お知らせ |
| `document_templates` | Word テンプレート |
| `user_registry_credentials` | 登記情報提供サービス認証 (暗号化) |
| `shared_farm_views` | 公開共有ビュー |

### 5.7 RLS / Storage の注意

- **`landxml` bucket の RLS**: `TO authenticated` を明示 (`public` 指定だと新 API キー方式で 403)
- **RLS 認可**: `organization_members` を join 経由で参照 (`profiles.organization_id` は欠損多いので使わない)
- **Landowner 添付ファイル**: `attachments` bucket の `landowners/{farm_id}/{landowner_id}/` パス

---

## 6. バックエンド

### 6.1 Edge Functions (`supabase/functions/`)

| 関数 | 用途 | 使用 AI |
|---|---|---|
| `parse-registry-pdf` | 登記情報提供 PDF → 所在・地番・地目・地積・所有者 の構造化抽出 | Claude Haiku 4.5 |
| `analyze-underdrain-cad` | DXF pipe run 情報 → 管径・延長 推定・補正 | Claude Sonnet 4.6 |
| `fetch-registry-pdfs` | 登記情報提供サービスから PDF 一括ダウンロード | - |
| `invite-member` | 組織メンバー招待メール送信 | - |
| `notify-signup` | 申し込み受付通知 | - |
| `send-feedback` | フィードバックメール送信 | - |
| `admin-delete-user` | site_owner 限定ユーザー削除 (Auth + profile) | - |

**運用注意**: Edge Function は手動デプロイ運用。ローカル `index.ts` ≠ 本番。`"Failed to send a request to the Edge Function"` は未デプロイ疑いが第一候補。

### 6.2 外部サービス

- **`services/registry-fetcher/`** — Node バッチ。登記情報提供サービスの認証情報 (暗号化) を使ってスケジュール実行で PDF を取得
- **地番マップ (`scripts/sync-parcel-maps.mjs`)** — G 空間情報センターの JPGIS XML → GeoJSON → PMTiles タイル化 → Storage アップロード
  - Storage 上限 1GB + stream-json + gzip level=9 で 全国 1740/1740 データセットを完走 (2026-07-15 達成)

### 6.3 モバイル (APK)

- **`android-mobility/`** = Capacitor + Android Studio (Gradle) の別プロジェクト
- **ビルドスコープ**: モビリティのみ (ICT 測量土木は Web 運用)。APK リビルド対象は `android-mobility/` だけ
- ビルド方式: React ビルド → `capacitor.config.mobility.ts` でコピー → `gradlew assembleRelease` → APK
- 主要プラグイン: `@capacitor/geolocation` / `@capacitor-community/background-geolocation`
- **leaflet-rotate 副作用 import**: モバイル側で import しただけで `L.Map` に `rotateControl:true` が注入されるため、Desktop の `MapContainer` は `rotateControl:false` を明示して抑止

---

## 7. 検証・運用

### 7.1 ビルド検証

- **`npm run build`** (実体: `tsc -b && vite build`) を commit 前に必ず通す
- `tsc --noEmit` では project references モードで拾うエラーを取りこぼす (CI が止まる原因)

### 7.2 Git 運用

- `main` 直接コミット。feature branch は基本使わない
- コミットメッセージは `feat(scope): ...` / `fix(scope): ...` / `refactor(scope): ...` / `chore(scope): ...` の Conventional Commits スタイル
- 大規模改修 (工区 → 圃場 全置換など) はまとめて 1 コミット可
- Co-Authored-By に AI エージェント (Claude) を明示

### 7.3 テンプレート・様式

`public/` および `doc/` 配下の Excel テンプレ:
- `調査報告書様式.xlsx` — 土地調査報告書
- `水理計算書様式.xlsx` — 暗渠水理計算書
- `測定結果一覧表様式.xlsx` — 暗渠測定結果

外部参照定義名は `workbook.definedNames.model = []` でクリア (Excel が「修復されたブック」警告を出さないため)。

---

## 8. 保留・未実装

TODO.md および実装状況から抜粋:

| 項目 | 状態 |
|---|---|
| サブユーザー管理 (組織 admin が組織内でユーザー招待) | 未着手 |
| CAD SFC 形式対応 (SXF/JWW) | 一部実装 (SFC 出力あり) |
| 坪置図面作成 (`/soil-import/heap-plan`) | 未実装 |
| 出来形管理 | 起工測量のみ実装、出来形は基盤のみ |
| Phone Auth (SMS OTP) | 未実装 (Magic Link 代替) |
| JPGIS/JSIMA を背景地図として表示 (工区単位で `map_layers` テーブル + Storage + GeoJSON 変換キャッシュ + `<MapBackgroundLayer>` 共通コンポ) | 設計案のみ |

---

## 9. 参考リンク

- ソース: `c:\lab\NodeCloud\NodeCloudICT`
- リモート: `https://github.com/yokoyamataro/NodeCloudICT`
- TODO: `TODO.md`
- ドキュメント: `doc/`
