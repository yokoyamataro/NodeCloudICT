// ICT設計システム用型定義
// NodeCloudと同じSupabaseを共有

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

// 座標の種類
export type CoordinateType = 'control' | 'boundary' | 'underdrain' | 'soil_import'

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

// Database型定義
export interface Database {
  public: {
    Tables: {
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
    }
  }
}
