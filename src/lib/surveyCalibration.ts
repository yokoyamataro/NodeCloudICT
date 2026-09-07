// 実測値に かける スライド量 (工区ごとの 定数オフセット)。
//
// GPS の 系統差や 基準点の ずれを 素早く 吸収する ための 簡易補正で、
// 測設記録の 画面 (StakingRecordsPage) で 入力し、design_survey_calibration に
// 工区単位で 保存している。
//
//   スライド後設計値   = 設計 + スライド量   (設計を 実測に 寄せる)
//   逆スライド後実測値 = 実測 − スライド量   (実測を 設計に 寄せる)
//
// 現況横断の 取込など、実測値を 設計の 土俵に 乗せて 使う 場面では
// 逆スライド後の 値を 使う。

import { supabase } from './supabase'

export interface SurveySlide {
  dx: number
  dy: number
  dz: number
}

export const NO_SLIDE: SurveySlide = { dx: 0, dy: 0, dz: 0 }

/**
 * 工区の スライド量を 読む。
 * 未マイグレーション環境や 未設定では 0 を 返す (Z だけ 旧 localStorage の
 * 値に 落ちる のは 測設記録の 画面と 同じ 扱い)。
 */
export async function fetchSurveySlide(farmId: string): Promise<SurveySlide> {
  let dx = 0
  let dy = 0
  let dz = 0
  try {
    const { data } = await supabase
      .from('design_survey_calibration')
      .select('dx_offset, dy_offset, dz_offset')
      .eq('farm_id', farmId)
      .maybeSingle()
    const row = data as {
      dx_offset?: number | string | null
      dy_offset?: number | string | null
      dz_offset?: number | string | null
    } | null
    if (row) {
      const vx = row.dx_offset != null ? Number(row.dx_offset) : NaN
      const vy = row.dy_offset != null ? Number(row.dy_offset) : NaN
      const vz = row.dz_offset != null ? Number(row.dz_offset) : NaN
      if (Number.isFinite(vx)) dx = vx
      if (Number.isFinite(vy)) dy = vy
      if (Number.isFinite(vz)) dz = vz
    }
  } catch {
    /* 未マイグレーション環境。0 の まま */
  }
  if (dz === 0) {
    // 旧: Z だけ 端末に 持っていた 時期の 値
    try {
      const raw =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem(`staking:zOffset:${farmId}`)
          : null
      const v = raw != null ? parseFloat(raw) : NaN
      if (Number.isFinite(v)) dz = v
    } catch {
      /* ignore */
    }
  }
  return { dx, dy, dz }
}

/** 実測値を 設計の 土俵に 乗せる (実測 − スライド量) */
export function applyReverseSlide(
  p: { x: number; y: number; z: number },
  slide: SurveySlide,
): { x: number; y: number; z: number } {
  return { x: p.x - slide.dx, y: p.y - slide.dy, z: p.z - slide.dz }
}
