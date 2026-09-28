// 国土地理院 / 公共基準点 の GeoJSON 取込。
//
// 対応 フォーマット (properties の キー が 少し 違う):
//   Base (国土地理院基準点):
//     基準点名 / 等級種別 (TR1 / TR3 / L01 …) / 標高 / 基準点コード
//   Public (公共基準点):
//     点名 / 等級 (1級 / 2級 …) / 種別 (基準点 …) / 成果ID
//
// 「種別」 と 呼べる 要素 を 点種 (stakeType) に 入れる:
//   Base → 等級種別 の 値 (TR1 / L05 …)
//   Public → 「種別」 + 「等級」 を 連結 (例: 「基準点 1級」)
//
// 標高 は 数値 化 して z に。 pointNumber は 基準点名 / 点名 / name の
// 最初 に 見つかった もの。 座標 は geometry.coordinates [lng, lat] を
// CoordinateConverter で 平面直角 (X=北, Y=東) に 変換 する。

import type { CoordinateConverter } from './coordinates'
import type { ImportCoordinateInput } from '@/stores/coordinateStore'

interface Feature {
  type?: string
  geometry?: {
    type?: string
    coordinates?: [number, number] | [number, number, number]
  }
  properties?: Record<string, unknown>
}

interface FeatureCollection {
  type?: string
  features?: Feature[]
}

/** GeoJSON テキスト → 座標一覧。 変換 に 失敗 した Feature は 除外 */
export function parseKijuntenGeojson(
  text: string,
  converter: CoordinateConverter,
): ImportCoordinateInput[] {
  let root: FeatureCollection
  try {
    root = JSON.parse(text)
  } catch {
    throw new Error('GeoJSON の 解析 に 失敗 しました')
  }
  if (root?.type !== 'FeatureCollection' || !Array.isArray(root.features)) {
    throw new Error('FeatureCollection では ありません')
  }

  const out: ImportCoordinateInput[] = []
  for (let i = 0; i < root.features.length; i++) {
    const f = root.features[i]
    if (f?.geometry?.type !== 'Point') continue
    const c = f.geometry.coordinates
    if (!Array.isArray(c) || c.length < 2) continue
    const lng = Number(c[0])
    const lat = Number(c[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue

    const { x, y } = converter.toXY(lat, lng)

    const p = f.properties ?? {}
    const pointNumber = pickString(p, ['基準点名', '点名', 'name']) ?? `P${i + 1}`
    const z = parseElevation(p)
    const stakeType = pickStakeType(p)
    const notes = buildNotes(p)

    out.push({
      pointNumber,
      x,
      y,
      z,
      type: 'control',
      stakeType,
      notes,
    })
  }
  return out
}

function pickString(
  p: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return null
}

function parseElevation(p: Record<string, unknown>): number | null {
  // Base: '標高'  Public: '楕円体高' や '標高' の 場合 も
  const raw = pickString(p, ['標高', '楕円体高', 'elevation'])
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

function pickStakeType(p: Record<string, unknown>): string | null {
  // Base の 「等級種別」 (TR1 / L05 など) を そのまま 使う。
  // Public の 場合 は 「種別」 + 「等級」 を 連結 (例: 「基準点 1級」)。
  const grade = pickString(p, ['等級種別'])
  if (grade) return grade
  const kind = pickString(p, ['種別'])
  const rank = pickString(p, ['等級'])
  if (kind && rank) return `${kind} ${rank}`
  return kind ?? rank
}

function buildNotes(p: Record<string, unknown>): string | null {
  // 基準点コード / 成果ID / 年月日 を 備考 に 残す。 SIMA / CSV では 落ちない よう に。
  const parts: string[] = []
  const code = pickString(p, ['基準点コード', '成果ID'])
  if (code) parts.push(code)
  const date = pickString(p, ['年月日'])
  if (date) parts.push(date)
  return parts.length > 0 ? parts.join(' / ') : null
}
