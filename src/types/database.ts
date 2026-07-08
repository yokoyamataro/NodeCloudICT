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
  created_at: string
  updated_at: string
}

// プラン種別（profiles.plan）
export type AccountPlan = 'cadastral' | 'civil' | 'total'

// アカウント単位の付加情報（auth.users と 1:1）
export interface Profile {
  user_id: string
  full_name: string | null
  organization_id: string | null
  // 階層: 親 (admin) が NULL、子ユーザーは親の uid を持つ
  parent_user_id: string | null
  // 利用可能プラン（地籍 / 土木 / トータル）
  plan: AccountPlan | null
  // 親が抱えられる子ユーザー数の上限（NULL = 無制限）
  child_user_limit: number | null
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
  /** 所在（例: A市B町一丁目）。並び順のキーにも使う */
  location: string | null
  parcel_number: string | null
  notes: string | null
  registered_land_category: string | null
  registered_area_sqm: number | null
  updated_land_category: string | null
  updated_area_sqm: number | null
  /** 登記簿上の所有者住所（旧 owner_address） */
  registered_owner_address: string | null
  /** 登記簿上の所有者氏名（旧 owner_name） */
  registered_owner_name: string | null
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
  parent_user_id: string | null
  parent_email: string | null
  plan: AccountPlan | null
  child_user_limit: number | null
  child_user_count: number
  last_sign_in_at: string | null
  created_at: string
}

// 親（admin）用: 自分の子ユーザー一覧
export interface ChildUserRow {
  user_id: string
  email: string
  full_name: string | null
  organization_id: string | null
  organization_name: string | null
  last_sign_in_at: string | null
  created_at: string
}

// 親（admin）用: 自分のサマリ
export interface AdminSummary {
  user_id: string
  email: string
  full_name: string | null
  plan: AccountPlan | null
  child_user_limit: number | null
  child_user_count: number
  parent_user_id: string | null
}

// 工事の種別。地籍測量 / 土木工事。NULL は既存データの未分類（工区を開くときに分類する）。
export type ProjectCategory = 'cadastral' | 'civil'

export const PROJECT_CATEGORY_LABEL: Record<ProjectCategory, string> = {
  cadastral: '地籍測量',
  civil: '土木工事',
}

// NodeCloud-Design用プロジェクト
export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  start_date: string | null      // 工期開始日
  end_date: string | null        // 工期終了日
  client: string | null          // 発注者
  contractor: string | null      // 受託者
  coordinate_zone: number        // 座標系（平面直角座標系の系番号、デフォルト13系）
  category: ProjectCategory | null  // 工事種別（NULL は未分類）
  created_at: string
  updated_at: string
  deleted_at: string | null      // ゴミ箱運用: NULL 以外は削除済み。保持期間経過で物理削除
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
    }
  }
}
