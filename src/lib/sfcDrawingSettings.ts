// 工区単位の SFC 平面図 図面レベルパラメータの取得/保存。
// テーブル: public.sfc_drawing_settings (farm_id PK)

import { supabase } from '@/lib/supabase'

export interface SfcDrawingLevelSettings {
  originX: number | null
  originY: number | null
  rotationDeg: number
  rotationMin: number
  rotationSec: number
  preserveSurveyCoords: boolean
}

export const DEFAULT_SFC_DRAWING_LEVEL: SfcDrawingLevelSettings = {
  originX: null,
  originY: null,
  rotationDeg: 0,
  rotationMin: 0,
  rotationSec: 0,
  preserveSurveyCoords: false,
}

interface Row {
  farm_id: string
  origin_x: number | null
  origin_y: number | null
  rotation_deg: number
  rotation_min: number
  rotation_sec: number
  preserve_survey_coords: boolean
}

/** サーバから読み込む。行が無い工区は null を返す */
export async function fetchSfcDrawingSettings(
  farmId: string,
): Promise<SfcDrawingLevelSettings | null> {
  const { data, error } = await supabase
    .from('sfc_drawing_settings')
    .select('*')
    .eq('farm_id', farmId)
    .maybeSingle()

  if (error) {
    console.error('SFC 図面レベル取得失敗:', error)
    return null
  }
  if (!data) return null
  const row = data as Row
  return {
    originX: row.origin_x,
    originY: row.origin_y,
    rotationDeg: row.rotation_deg,
    rotationMin: row.rotation_min,
    rotationSec: row.rotation_sec,
    preserveSurveyCoords: row.preserve_survey_coords,
  }
}

/** upsert (farm_id conflict) で保存 */
export async function upsertSfcDrawingSettings(
  farmId: string,
  s: SfcDrawingLevelSettings,
): Promise<void> {
  const payload = {
    farm_id: farmId,
    origin_x: s.originX,
    origin_y: s.originY,
    rotation_deg: s.rotationDeg,
    rotation_min: s.rotationMin,
    rotation_sec: s.rotationSec,
    preserve_survey_coords: s.preserveSurveyCoords,
    updated_at: new Date().toISOString(),
  }
  const { error } = await supabase
    .from('sfc_drawing_settings')
    // 型定義にまだ登録されていない新規テーブルなので never キャスト
    .upsert(payload as never, { onConflict: 'farm_id' })
  if (error) {
    console.error('SFC 図面レベル保存失敗:', error)
    throw error
  }
}
