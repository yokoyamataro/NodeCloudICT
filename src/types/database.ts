// ICT設計システム用型定義
// NodeCloudと同じSupabaseを共有

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// 工種タイプ
export type WorkType =
  | 'boundary_survey' // 境界測量（地番データを管理）
  | 'underdrain'     // 暗渠工事
  | 'soil_import'    // 客土工事
  | 'simple_grading' // 簡易整地
  | 'grading'        // 整地
  | 'subsoil'        // 心破土改
  | 'stone_removal'  // 徐礫
  | 'open_channel'   // 線形物（水路・道路）— 区域ではなく線形 + 標準断面で定義

// 工種の表示名
export const WORK_TYPE_NAMES: Record<WorkType, string> = {
  boundary_survey: '境界測量',
  underdrain: '暗渠工事',
  soil_import: '客土工事',
  simple_grading: '簡易整地',
  grading: '整地',
  subsoil: '心破土改',
  stone_removal: '徐礫',
  open_channel: '線形物',
}

// 座標の種類（DB 上は TEXT で制約なし。実体は lib/coordinates.ts の組み込み点種
// 一覧 + プロジェクトのカスタム点種コード）。
// 既定の組み込み点種は 'control' | 'boundary' | 'current' に加え、地籍測量向けの
// 'map_xml' / 'national_survey' / 'cadastral_diagram' / 'witness' /
// 'confirmed_boundary' / 'measured' の 6 種類。
// カスタム点種コード（任意文字列）も入り得るため string に開放する。
export type CoordinateType = string

// 杭設置ワークフローの状態（地籍測量モードで使用）。
// design_coordinates.stake_status に格納。既定は '' (空 / 未指定)。
//
// 旧コード対応:
//   ''(未指定)         → 既定値（フィルタ・新規行はここから始まる）
//   none / needed      → unset（未設置）
//   temporary          → temporary（仮杭）
//   permanent          → new（新設）
//   existing           → existing（既設）
//   impossible         → skip（不設置）
export type StakeStatus =
  | ''            // 未指定（既定）
  | 'unset'       // 未設置（まだ設置していない）
  | 'temporary'   // 仮杭
  | 'new'         // 新設（新たに本杭を設置）
  | 'replaced'    // 入替（既設を撤去のうえ新設）
  | 'existing'    // 既設（既設杭を採用）
  | 'skip'        // 不設置（設置しない方針）

export const STAKE_STATUS_OPTIONS: StakeStatus[] = [
  '',
  'unset',
  'temporary',
  'new',
  'replaced',
  'existing',
  'skip',
]

export const STAKE_STATUS_LABEL: Record<StakeStatus, string> = {
  '': '(空)',
  unset: '未設置',
  temporary: '仮杭',
  new: '新設',
  replaced: '入替',
  existing: '既設',
  skip: '不設置',
}

// バッジ用の Tailwind 配色。背景 / 文字 / 枠線を一括で。
export const STAKE_STATUS_BADGE: Record<StakeStatus, string> = {
  '': 'bg-white text-slate-400 border-slate-200',
  unset: 'bg-slate-100 text-slate-500 border-slate-200',
  temporary: 'bg-blue-50 text-blue-700 border-blue-300',
  new: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  replaced: 'bg-amber-50 text-amber-700 border-amber-300',
  existing: 'bg-teal-50 text-teal-700 border-teal-300',
  skip: 'bg-red-50 text-red-700 border-red-300',
}

// 点種（座標の用途）
export type PointType =
  | 'reference'      // 基準点
  | 'outer_boundary' // 境界点
  | 'inner_boundary' // 内周点（島部分）
  | 'zone_vertex'    // 区域頂点
  | 'construction'   // 施工点

// 座標データ
export interface Coordinate {
  id: string
  project_id: string
  field_id: string | null
  work_zone_id: string | null
  coordinate_type: CoordinateType
  point_number: string
  x: number // 平面直角座標X（北方向）
  y: number // 平面直角座標Y（東方向）
  z: number | null // 標高
  latitude: number | null // 緯度（自動計算）
  longitude: number | null // 経度（自動計算）
  notes: string | null
  created_at: string
  updated_at: string
}

// 区域座標登録（面積計算用）
export interface AreaZone {
  id: string
  project_id: string
  zone_number: string        // 区域番号
  name: string               // 区域名
  point_ids: string[]        // 構成点IDリスト（順序付き）
  area_sqm: number | null    // 面積(m²) - 計算結果
  area_ha: number | null     // 面積(ha) - 計算結果
  perimeter_m: number | null // 周長(m) - 計算結果
  notes: string | null
  created_at: string
  updated_at: string
}

// 面積計算簿の行データ
export interface AreaCalculationRow {
  point_number: string  // 点番号
  x: number             // X座標
  y: number             // Y座標
  xi_yi1: number        // Xi × Yi+1
  xi1_yi: number        // Xi+1 × Yi
  double_area: number   // 倍面積 (Xi × Yi+1 - Xi+1 × Yi)
}

// 面積計算簿
export interface AreaCalculationSheet {
  zone_id: string
  zone_number: string
  zone_name: string
  rows: AreaCalculationRow[]
  total_double_area: number  // 倍面積合計
  area_sqm: number           // 面積(m²)
  area_ha: number            // 面積(ha)
  perimeter_m: number        // 周長(m)
  calculated_at: string      // 計算日時
}

// 作業区域（工事区域を分割した作業単位）
export interface WorkZone {
  id: string
  project_id: string
  field_id: string | null
  name: string
  zone_number: string
  work_type: string // underdrain, soil_import など
  area_polygon: Json | null // GeoJSON
  area_hectares: number | null
  status: 'planned' | 'in_progress' | 'completed'
  notes: string | null
  created_at: string
  updated_at: string
}

// 暗渠設計データ
export interface UnderdrainDesign {
  id: string
  work_zone_id: string
  main_pipe_diameter: number // 本管径(mm)
  branch_pipe_diameter: number // 支管径(mm)
  pipe_spacing: number // 支管間隔(m)
  pipe_depth: number // 埋設深(m)
  slope_percent: number // 勾配(%)
  outlet_x: number
  outlet_y: number
  outlet_z: number
  notes: string | null
  created_at: string
  updated_at: string
}

// 客土設計データ
export interface SoilImportDesign {
  id: string
  work_zone_id: string
  design_thickness: number // 設計盛土厚(cm)
  soil_volume: number // 土量(m³)
  compaction_factor: number // 締固め係数
  soil_source: string | null // 土取場
  notes: string | null
  created_at: string
  updated_at: string
}

// 水理計算結果
export interface HydraulicCalculation {
  id: string
  work_zone_id: string
  calculation_type: 'manning' | 'hazen_williams' | 'darcy'
  catchment_area: number // 集水面積(ha)
  rainfall_intensity: number // 降雨強度(mm/h)
  runoff_coefficient: number // 流出係数
  design_flow: number // 計画流量(m³/s)
  pipe_diameter: number // 管径(mm)
  pipe_slope: number // 管勾配(%)
  flow_velocity: number // 流速(m/s)
  flow_depth: number // 水深(m)
  is_valid: boolean // 計算結果が有効か
  notes: string | null
  created_at: string
}

// 管種
export type PipeType =
  | 'main'           // 集水
  | 'branch'         // 吸水
  | 'outlet'         // 落口
  | 'connection'     // 連絡渠
  | 'spring'         // 湧水処理
  | 'auxiliary'      // 補助暗渠
  | 'self_funded'    // 自費施工

// 管路の構成点
export interface PipeVertex {
  x: number
  y: number
  z: number | null
}

// 管路データ（暗渠配管）
export interface Pipe {
  id: string
  project_id: string
  number: string              // 管路番号
  layer_name: string          // CADレイヤ名
  pipe_type: PipeType | null  // 管種
  diameter: number | null     // 管径(mm)
  design_length: number | null   // 設計延長(m)
  measured_length: number | null // 実測延長(m)
  vertices: PipeVertex[]      // 構成点リスト
  connection_to: string | null   // 接続先（管路ID）
  notes: string | null
  created_at: string
  updated_at: string
}

// オルソ画像レイヤー
export interface OrthoLayer {
  id: string
  project_id: string
  name: string
  file_url: string
  bounds: Json // [minLng, minLat, maxLng, maxLat]
  resolution: number // m/pixel
  capture_date: string | null
  notes: string | null
  created_at: string
}

// プロジェクトメンバーのロール
export type ProjectMemberRole = 'owner' | 'editor' | 'viewer'

// 法務省地図データ (JPGIS/JSIMA) をサイトオーナーがマスターデータとして
// アップロードしたもの。境界測量モードの背景レイヤとして全ユーザーに提供する。
export type TileFormat = 'geojson' | 'pmtiles'

export type ParcelMapSourceKind = 'jpgis_xml' | 'geojson'

export interface ParcelMapDataset {
  id: string
  name: string
  description: string | null
  coordinate_zone: number
  source_kind: ParcelMapSourceKind
  /** 元 XML のパス。GeoJSON 直接アップロードの場合は null (元ファイル = geojson 側) */
  storage_xml_path: string | null
  storage_geojson_path: string | null
  tile_format: TileFormat
  /** タイル分割時のズームレベル (デフォルト 14) */
  tile_zoom: number
  bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null
  parcel_count: number | null
  active: boolean
  uploaded_by_user_id: string | null
  created_at: string
  updated_at: string
  // G 空間情報センターからの自動同期用メタ (scripts/sync-parcel-maps.mjs)
  registry_code: string | null
  registry_sub: string | null
  prefecture_code: string | null
  source_year: number | null
  source_url: string | null
  ckan_package_id: string | null
  ckan_resource_id: string | null
  // Phase 2b: bbox 交差クエリ用スカラー列
  bbox_min_lng: number | null
  bbox_min_lat: number | null
  bbox_max_lng: number | null
  bbox_max_lat: number | null
}

// 開発者からのお知らせ
export interface Announcement {
  id: string
  title: string
  body: string
  published_at: string
  created_by: string | null
  created_at: string
  updated_at: string
}

// 所属組織（契約・請求の単位として使う「会社」マスタ）
export interface Organization {
  id: string
  name: string
  note: string | null
  postal_code: string | null
  phone: string | null
  address: string | null
  representative: string | null
  admin_user_id: string | null
  user_count_limit: number | null
  plan: string | null
  /** 組織の利用期限。NULL は無期限。past → 新規メンバー追加を拒否 (既存アクセスは影響なし) */
  expires_at: string | null
  created_at: string
  updated_at: string
}

// 組織が契約している製品 (地籍測量 / 土木工事 / モビリティ) を表す行。
// PK は (organization_id, product)。1 組織あたり最大 3 行入りうる。
// expires_at 経過後は has_org_product / i_have_product が false を返す。
export type OrgProduct = 'cadastral' | 'civil' | 'mobility'

export interface OrganizationProduct {
  organization_id: string
  product: OrgProduct
  plan: string | null
  /** その製品を利用する社員数の上限。NULL は無制限 */
  seat_limit: number | null
  starts_at: string | null
  /** その製品の契約終了。NULL は無期限。past → 製品利用不可 */
  expires_at: string | null
  memo: string | null
  created_at: string
  updated_at: string
}

// モビリティ機能: 車両・重機マスタ (組織単位)
export type VehicleKind = 'car' | 'truck' | 'heavy_equipment' | 'other'

export interface Vehicle {
  id: string
  organization_id: string
  name: string
  plate_or_serial: string | null
  kind: VehicleKind
  active: boolean
  memo: string | null
  created_at: string
  updated_at: string
}

// モビリティ機能: 「誰がいつからいつまでこの車両に乗ったか」の時系列。
// ended_at IS NULL = 稼働中。1 車両につき稼働中は最大 1 件 (DB 側の部分 UNIQUE で保証)。
export interface VehicleAssignment {
  id: string
  vehicle_id: string
  user_id: string
  started_at: string
  ended_at: string | null
  memo: string | null
  created_at: string
  destination_point_id: string | null
  destination_set_at: string | null
}

// モビリティ機能: GPS ping。assignment_id 経由で車両・運転者を辿れる。immutable。
export interface MobilityPosition {
  id: number
  assignment_id: string
  recorded_at: string
  lat: number
  lon: number
  accuracy_m: number | null
  speed_kmh: number | null
  heading_deg: number | null
  altitude_m: number | null
}

// モビリティ機能: カテゴリマスタ (組織単位)
export interface MobilityProject {
  id: string
  organization_id: string
  name: string
  description: string | null
  active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

// カテゴリのドライバー割当。現状は role='driver' のみ。
export type MobilityProjectMemberRole = 'driver'
export interface MobilityProjectMember {
  project_id: string
  user_id: string
  role: MobilityProjectMemberRole
  added_by: string | null
  added_at: string
}

// カテゴリ内のポイント (土取場・採石場・雪捨場・農場A 等)
export interface MobilityProjectPoint {
  id: string
  project_id: string
  name: string
  kind: string | null
  lat: number
  lon: number
  memo: string | null
  active: boolean
  display_order: number
  created_at: string
  updated_at: string
}

// アカウント単位の付加情報（auth.users と 1:1）
export interface Profile {
  user_id: string
  full_name: string | null
  organization_id: string | null
  created_at: string
  updated_at: string
}

// ユーザーがアップロードした Word テンプレートのメタ。
// 本体 .docx は Storage 'templates' バケットに {owner_uid}/{id}.docx で保存。
export interface DocumentTemplate {
  id: string
  owner_user_id: string
  name: string
  description: string | null
  storage_path: string
  created_at: string
  updated_at: string
}

// テンプレの共有先ユーザー
export interface DocumentTemplateShare {
  template_id: string
  shared_with_user_id: string
  created_at: string
}

// 地籍（境界測量）の地番属性。ポリゴン形状は design_work_areas 側に残しているので
// 1:1 のサイドカーテーブル parcels(work_area_id UNIQUE) と対応する。
//
// 地目は 23 地目（不動産登記規則 第99条）から選ぶ運用。値の正確な集合は
// src/lib/landCategory.ts と DB 側 CHECK 制約で同期している。
export interface Parcel {
  id: string
  work_area_id: string
  /** 所在の「字名」部分 (例: 「青葉町」「朝日町一丁目」)。並び順のキーにも使う。
   *  郡町村より上位の階層は prefecture / municipality に分離して保持する。 */
  location: string | null
  parcel_number: string | null
  notes: string | null
  /** 都道府県名 (例: 「北海道」)。表示では隠すが touki.or.jp 送信時に使う */
  prefecture: string | null
  /** 郡町村名 (例: 「斜里郡斜里町」)。表示は "municipality + location" を連結 */
  municipality: string | null
  registered_land_category: string | null
  registered_area_sqm: number | null
  updated_land_category: string | null
  updated_area_sqm: number | null
  /** 登記簿上の所有者住所（旧 owner_address） */
  registered_owner_address: string | null
  /** 登記簿上の所有者氏名（旧 owner_name） */
  registered_owner_name: string | null
  /** 属性コード (parcel_attribute_types.code を参照。NULL=未選択) */
  attribute_code: string | null
  created_at: string
  updated_at: string
}

// 地番属性の型 (parcel_attribute_types テーブル)。
// 組み込み (target/adjacent/road/river/other) 5 種類 + ユーザー任意追加。
export interface ParcelAttributeType {
  id: string
  project_id: string
  /** プロジェクト内でユニークな属性コード (例: 'target') */
  code: string
  /** 表示ラベル (例: '対象地') */
  label: string
  /** 塗り色 '#rrggbb' */
  color: string
  sort_order: number
  /** 組み込み属性 (削除不可、label/color は編集可) */
  is_builtin: boolean
  created_at: string
  updated_at: string
}

// 地権者の通知方法
export type LandownerNotificationMethod =
  | 'direct_visit'
  | 'mail'
  | 'phone'
  | 'agent'

export const LANDOWNER_NOTIFICATION_LABEL: Record<LandownerNotificationMethod, string> = {
  direct_visit: '直接訪問',
  mail: '郵送',
  phone: '電話',
  agent: '代理人',
}

// 地権者の立会状況
export type LandownerAttendanceStatus =
  | 'not_attended'
  | 'field_confirmed'
  | 'document_confirmed'
  | 'rejected'

export const LANDOWNER_ATTENDANCE_LABEL: Record<LandownerAttendanceStatus, string> = {
  not_attended: '未立会',
  field_confirmed: '現地立会確認済',
  document_confirmed: '書面確認済',
  rejected: '不承諾',
}

// 地権者の属性 (申請人 / 隣接者)
export type LandownerAttribute = 'applicant' | 'adjacent'

export const LANDOWNER_ATTRIBUTE_LABEL: Record<LandownerAttribute, string> = {
  applicant: '申請人',
  adjacent: '隣接者',
}

// 本人確認方法
export type LandownerIdMethod = 'license' | 'idcard' | 'meishiki' | 'other'

export const LANDOWNER_ID_METHOD_LABEL: Record<LandownerIdMethod, string> = {
  license: '運転免許証',
  idcard: 'マイナンバーカード',
  meishiki: '面識あり',
  other: 'その他',
}

// 地権者（工区単位で管理）。地番との関係は parcel_landowners 多対多関連で表現する。
export interface Landowner {
  id: string
  farm_id: string
  full_name: string
  postal_code: string | null
  address: string | null
  phone: string | null
  agent_name: string | null
  agent_address: string | null
  agent_phone: string | null
  agent_relation: string | null
  primary_attendance_at: string | null
  secondary_attendance_at: string | null
  notification_method: LandownerNotificationMethod | null
  attendance_status: LandownerAttendanceStatus
  notes: string | null
  /** 属性: 申請人 or 隣接者 */
  attribute: LandownerAttribute | null
  /** 本人 (地権者) の本人確認方法 */
  id_method: LandownerIdMethod | null
  /** 上記 'other' 選択時の 自由文 */
  id_method_other: string | null
  /** 立会人 (代理人) の本人確認方法 */
  agent_id_method: LandownerIdMethod | null
  agent_id_method_other: string | null
  created_at: string
  updated_at: string
}

// 地番と地権者の M:N 関連
export interface ParcelLandowner {
  parcel_id: string
  landowner_id: string
  created_at: string
}

// サイトオーナー用ユーザー一覧（admin_list_users RPC の戻り値）
export interface AdminUserRow {
  user_id: string
  email: string
  full_name: string | null
  organization_id: string | null
  organization_name: string | null
  last_sign_in_at: string | null
  created_at: string
}

// 工事の種別。地籍測量 / 土木工事。NULL は既存データの未分類（工区を開くときに分類する）。
export type ProjectCategory = 'cadastral' | 'civil'

export const PROJECT_CATEGORY_LABEL: Record<ProjectCategory, string> = {
  cadastral: '地籍測量',
  civil: '土木工事',
}

// NodeCloud-Design用プロジェクト
export type ProjectVisibility = 'private' | 'shared' | 'public'

export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  client: string | null          // 発注者
  contractor: string | null      // 受託者
  coordinate_zone: number        // 座標系（平面直角座標系の系番号、デフォルト13系）
  category: ProjectCategory | null  // 工事種別（NULL は未分類）
  created_at: string
  updated_at: string
  deleted_at: string | null      // ゴミ箱運用: NULL 以外は削除済み。保持期間経過で物理削除
  started_at: string | null      // 実際の着手日 (作成時に created_at を初期値、以後編集可能)
  completed_at: string | null    // 完成日 (完了チェック ON で now() を初期値、OFF なら NULL)
  visibility: ProjectVisibility  // 占有 / 共有 / 公開 の 3 段階
}

export const PROJECT_VISIBILITY_LABEL: Record<ProjectVisibility, string> = {
  private: '占有',
  shared: '共有',
  public: '公開',
}

// プロジェクトメンバー
export interface ProjectMember {
  id: string
  project_id: string
  user_id: string
  role: ProjectMemberRole
  created_at: string
  updated_at: string
  // get_project_members RPC で auth.users から付与される（オプション）
  email?: string | null
  display_name?: string | null
}

// NodeCloud-Design用工区
export interface Farm {
  id: string
  user_id: string
  project_id: string
  name: string
  description: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null      // ゴミ箱運用: NULL 以外は削除済み
  started_at: string | null      // 着手日 (作成時に created_at を初期値、以後編集可能)
  completed_at: string | null    // 完成日 (完了チェック ON で now() を初期値、以後編集可能。OFF なら NULL)
  /** 地番マップの表示範囲 (bbox)。null なら「工区周辺を自動計算」する */
  parcel_map_bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number } | null
}

// 後方互換性のためのエイリアス
export type DesignProject = Farm

// NodeCloud-Design用座標
export interface DesignCoordinate {
  id: string
  farm_id: string
  point_number: string
  x: number
  y: number
  z: number | null
  latitude: number | null
  longitude: number | null
  coordinate_type: string
  /** 杭種（木杭 / コンクリート杭 / プラスチック杭 / 金属鋲 / 金属標 / 石標 / 既設標 / 自由入力） */
  stake_type: string | null
  /** 設置状態（地籍測量モード）。'unset' | 'temporary' | 'new' | 'replaced' | 'existing' | 'skip' */
  stake_status: StakeStatus
  notes: string | null
  created_at: string
  updated_at: string
  /** 作成者 (auth.users.id)。Insert/Update トリガで自動設定される。 */
  created_by: string | null
  /** 最終更新者 (auth.users.id)。 */
  updated_by: string | null
  /** ソフト削除日時 (null = 未削除)。30 日 経過で 物理削除 (pg_cron) */
  deleted_at: string | null
  /** 削除者 (auth.users.id) */
  deleted_by: string | null
}

// 工種別工事区域
export interface DesignWorkArea {
  id: string
  farm_id: string
  work_type: WorkType
  zone_number: string
  name: string
  point_ids: string[]       // 構成点IDリスト（順序付き）
  area_sqm: number | null
  area_ha: number | null
  perimeter_m: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

// 工事区域に使用する座標点
export interface WorkAreaCoordinate {
  id: string
  work_area_id: string
  point_number: string
  x: number
  y: number
  z: number | null
  sort_order: number
  created_at: string
  updated_at: string
}

// NodeCloud-Design用管路
export interface DesignPipe {
  id: string
  farm_id: string
  number: string
  layer_name: string | null
  pipe_type: string | null
  diameter: number | null
  design_length: number | null
  measured_length: number | null
  vertices: PipeVertex[]
  connection_to: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

// 測量データカテゴリ
export type SurveyCategory = 'control' | 'boundary' | 'underdrain' | 'other'

// 管路設定グループ
export interface PipeWiringGroup {
  id: string
  farm_id: string
  group_type: 'collector' | 'direct'
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

// 管路設定行タイプ
export type PipeWiringRowType =
  | 'absorption_end'      // 吸水端部
  | 'absorption_merge'    // 吸水合流
  | 'collector_merge'     // 集水合流
  | 'collector_change'    // 集水変化点
  | 'collector_junction'  // 集水合流点
  | 'outlet'              // 落口

// 管路設定行
export interface PipeWiringRow {
  id: string
  group_id: string
  row_type: PipeWiringRowType | null
  absorption_pipe_ids: string[]
  collector_pipe_id: string | null
  is_merge_pipe: boolean
  merge_system_index: number | null  // 集水合流タイプの接続先系統番号
  sort_order: number
  created_at: string
  updated_at: string
}

// 施工計画行
export interface ConstructionPlanRow {
  id: string
  farm_id: string
  wiring_row_id: string
  group_type: 'collector' | 'direct'
  group_index: number
  row_index: number
  absorption_pipe_id: string | null
  collector_pipe_id: string | null
  created_at: string
  updated_at: string
}

// 施工計画点
export interface ConstructionPlanPoint {
  id: string
  row_id: string
  point_type: 'absorption' | 'collector'
  point_index: number
  point_name: string
  x: number
  y: number
  ground_height: number | null
  planned_height: number | null
  cut_depth: number | null
  segment_distance: number | null
  segment_slope: string | null
  /** 区間ごとの管径 (mm)。null の場合は所属 design_pipes.diameter を使用。 */
  segment_diameter: number | null
  created_at: string
  updated_at: string
}

// NodeCloud-Design用測量データ
export interface DesignSurveyData {
  id: string
  farm_id: string
  point_number: string
  x: number
  y: number
  z: number | null
  matched_point_id: string | null
  matched_point_type: 'pipe' | 'coordinate' | null
  match_distance: number | null
  category: SurveyCategory
  dz_raw: number | null
  dz_calibrated: number | null
  notes: string | null
  created_at: string
  updated_at: string
}

// NodeCloud-Design用測量補正設定
export interface DesignSurveyCalibration {
  id: string
  farm_id: string
  is_enabled: boolean
  dz_offset: number
  matching_threshold: number
  created_at: string
  updated_at: string
}

// Database型定義
export interface Database {
  public: {
    Tables: {
      // NodeCloud-Design テーブル
      projects: {
        Row: Project
        Insert: Omit<Project, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Project, 'id' | 'created_at' | 'updated_at'>>
      }
      project_members: {
        Row: ProjectMember
        Insert: Omit<ProjectMember, 'id' | 'created_at' | 'updated_at' | 'email'>
        Update: Partial<Omit<ProjectMember, 'id' | 'created_at' | 'updated_at' | 'email'>>
      }
      farms: {
        Row: Farm
        Insert: Omit<Farm, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Farm, 'id' | 'created_at' | 'updated_at'>>
      }
      design_coordinates: {
        Row: DesignCoordinate
        Insert: Omit<DesignCoordinate, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<DesignCoordinate, 'id' | 'created_at' | 'updated_at'>>
      }
      design_pipes: {
        Row: DesignPipe
        Insert: Omit<DesignPipe, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<DesignPipe, 'id' | 'created_at' | 'updated_at'>>
      }
      design_survey_data: {
        Row: DesignSurveyData
        Insert: Omit<DesignSurveyData, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<DesignSurveyData, 'id' | 'created_at' | 'updated_at'>>
      }
      design_survey_calibration: {
        Row: DesignSurveyCalibration
        Insert: Omit<DesignSurveyCalibration, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<DesignSurveyCalibration, 'id' | 'created_at' | 'updated_at'>>
      }
      // 既存テーブル（後方互換性）
      coordinates: {
        Row: Coordinate
        Insert: Omit<Coordinate, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<Coordinate, 'id' | 'created_at' | 'updated_at'>>
      }
      work_zones: {
        Row: WorkZone
        Insert: Omit<WorkZone, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<WorkZone, 'id' | 'created_at' | 'updated_at'>>
      }
      underdrain_designs: {
        Row: UnderdrainDesign
        Insert: Omit<UnderdrainDesign, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<UnderdrainDesign, 'id' | 'created_at' | 'updated_at'>>
      }
      soil_import_designs: {
        Row: SoilImportDesign
        Insert: Omit<SoilImportDesign, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<Omit<SoilImportDesign, 'id' | 'created_at' | 'updated_at'>>
      }
      hydraulic_calculations: {
        Row: HydraulicCalculation
        Insert: Omit<HydraulicCalculation, 'id' | 'created_at'>
        Update: Partial<Omit<HydraulicCalculation, 'id' | 'created_at'>>
      }
      ortho_layers: {
        Row: OrthoLayer
        Insert: Omit<OrthoLayer, 'id' | 'created_at'>
        Update: Partial<Omit<OrthoLayer, 'id' | 'created_at'>>
      }
      profiles: {
        Row: Profile
        Insert: Omit<Profile, 'created_at' | 'updated_at'>
        Update: Partial<Omit<Profile, 'user_id' | 'created_at' | 'updated_at'>>
      }
      organization_products: {
        Row: OrganizationProduct
        Insert: Omit<OrganizationProduct, 'created_at' | 'updated_at'>
        Update: Partial<
          Omit<OrganizationProduct, 'organization_id' | 'product' | 'created_at' | 'updated_at'>
        >
      }
      vehicles: {
        Row: Vehicle
        Insert: Omit<Vehicle, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<
          Omit<Vehicle, 'id' | 'organization_id' | 'created_at' | 'updated_at'>
        >
      }
      vehicle_assignments: {
        Row: VehicleAssignment
        Insert: Omit<VehicleAssignment, 'id' | 'created_at'>
        Update: Partial<
          Omit<VehicleAssignment, 'id' | 'vehicle_id' | 'user_id' | 'created_at'>
        >
      }
      mobility_positions: {
        Row: MobilityPosition
        Insert: Omit<MobilityPosition, 'id'>
        Update: never
      }
      mobility_projects: {
        Row: MobilityProject
        Insert: Omit<MobilityProject, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<
          Omit<MobilityProject, 'id' | 'organization_id' | 'created_at' | 'updated_at'>
        >
      }
      mobility_project_members: {
        Row: MobilityProjectMember
        Insert: Omit<MobilityProjectMember, 'added_at'>
        Update: Partial<
          Omit<MobilityProjectMember, 'project_id' | 'user_id' | 'added_at'>
        >
      }
      mobility_project_points: {
        Row: MobilityProjectPoint
        Insert: Omit<MobilityProjectPoint, 'id' | 'created_at' | 'updated_at'>
        Update: Partial<
          Omit<MobilityProjectPoint, 'id' | 'project_id' | 'created_at' | 'updated_at'>
        >
      }
    }
  }
}
