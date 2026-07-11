// 地番マップ (法務省地図) からの一括取込ロジック。PC / モバイル両方で共通利用する。
//
// 内容:
//   * 対象工区の座標系に合わせて JPRC 頂点を算出 (同一 zone で jprc_coords があれば
//     それを、それ以外は WGS84 → JPRC 再投影)
//   * 既存座標との (x, y) 一致判定 (0.1mm 精度) で境界点を統合。バッチ内の重複も統合
//   * 新規座標の点番号は x00001... の 5 桁連番 (旧 XMLnnnnnn も継続認識)
//   * type='map_xml' として design_coordinates に一括 INSERT
//   * design_work_areas / parcels に順次 INSERT / upsert
//   * 完了後、関連ストアのキャッシュを無効化 + 再取得

import type { Feature, Polygon } from 'geojson'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useFarmStore } from '@/stores/farmStore'
import type { CoordinateRow } from '@/stores/coordinateStore'

const MAX_COORDS_PER_FARM = 5000
const MAX_PARCELS_PER_FARM = 1000

export interface ImportParcelBatchDeps {
  farmId: string
  /** プロジェクト (工区) の座標系番号 */
  zone: number
}

export interface ImportParcelBatchResult {
  createdCount: number
  /** 新規に追加された座標点の数 */
  newCoordCount: number
  /** 既存 or バッチ内で共有された境界点の数 */
  sharedPointCount: number
  /** ユーザー向けの完了メッセージ */
  message: string
}

/**
 * @throws Error 上限超過、致命的な INSERT 失敗など
 */
export async function importParcelBatch(
  features: Feature<Polygon, ParcelFeatureProperties>[],
  deps: ImportParcelBatchDeps,
): Promise<ImportParcelBatchResult> {
  if (features.length === 0) {
    return {
      createdCount: 0,
      newCoordCount: 0,
      sharedPointCount: 0,
      message: '取り込む地番がありません',
    }
  }

  const { farmId, zone } = deps
  const coordState = useCoordinateStore.getState()
  const waState = useWorkAreaStore.getState()
  const parcelStoreGet = useParcelStore.getState

  const coordinates = coordState.coordinates
  const currentCoordCount = coordinates.length
  const currentParcelCount = waState.workAreas['boundary_survey']?.length ?? 0

  if (currentParcelCount + features.length > MAX_PARCELS_PER_FARM) {
    throw new Error(
      `地番数が上限 (${MAX_PARCELS_PER_FARM.toLocaleString()} 筆) を超えるため取込できません。`,
    )
  }

  // 1) 各 feature の JPRC 頂点を計算
  const conv = new CoordinateConverter(zone)
  const perFeatureJprc: Array<Array<[number, number]>> = features.map((feature) => {
    const props = feature.properties
    if (props.source_zone === zone && props.jprc_coords.length > 0) {
      return props.jprc_coords
    }
    const ring = feature.geometry.coordinates[0].slice(0, -1) as Array<
      [number, number]
    >
    return ring.map(([lng, lat]) => {
      const { x, y } = conv.toXY(lat, lng)
      return [x, y]
    })
  })

  // 2) 既存座標の (x, y) → id マップ
  const coordKey = (x: number, y: number): string =>
    `${x.toFixed(4)},${y.toFixed(4)}`
  const existingIdByKey = new Map<string, string>()
  for (const c of coordinates) {
    existingIdByKey.set(coordKey(c.x, c.y), c.id)
  }

  // 3) 既存の xNNNNN (旧 XMLnnnnnn) 点番号の最大値
  let maxSeq = 0
  for (const c of coordinates) {
    const m = c.pointNumber.match(/^(?:x|XML)(\d+)$/)
    if (m) {
      const n = parseInt(m[1], 10)
      if (n > maxSeq) maxSeq = n
    }
  }

  // 4) バッチ内で新規頂点を一意化し、順次シーケンスを付与
  const newVertexOrdered: Array<{
    x: number
    y: number
    pointNumber: string
  }> = []
  const newVertexKeySeen = new Set<string>()
  for (const jprc of perFeatureJprc) {
    for (const [x, y] of jprc) {
      const k = coordKey(x, y)
      if (existingIdByKey.has(k)) continue
      if (newVertexKeySeen.has(k)) continue
      newVertexKeySeen.add(k)
      maxSeq++
      newVertexOrdered.push({
        x,
        y,
        pointNumber: `x${maxSeq.toString().padStart(5, '0')}`,
      })
    }
  }

  if (currentCoordCount + newVertexOrdered.length > MAX_COORDS_PER_FARM) {
    throw new Error(
      `座標が上限 (${MAX_COORDS_PER_FARM.toLocaleString()} 点) を超えるため取込できません。\n新規追加予定: ${newVertexOrdered.length.toLocaleString()} 点`,
    )
  }

  // 5) 新規座標を batch INSERT (type='map_xml')
  let insertedCoords: CoordinateRow[] = []
  if (newVertexOrdered.length > 0) {
    const newCoordRows = newVertexOrdered.map((v) => ({
      pointNumber: v.pointNumber,
      x: v.x,
      y: v.y,
      z: null as number | null,
      type: 'map_xml' as unknown as CoordinateRow['type'],
    }))
    insertedCoords = await coordState.importCoordinates(newCoordRows, undefined, {
      skipStateUpdate: true,
    })
  }

  // 6) (x, y) → 座標 id の統合マップ
  const idByKey = new Map<string, string>(existingIdByKey)
  for (const c of insertedCoords) {
    idByKey.set(coordKey(c.x, c.y), c.id)
  }

  // 7) design_work_areas に INSERT する行を生成
  const insertRows: Array<{
    farm_id: string
    work_type: string
    zone_number: string
    name: string
    point_ids: string[]
    area_sqm: null
    area_ha: null
    perimeter_m: null
    notes: null
  }> = []
  const meta: Array<{
    parcelNumber: string
    location: string | null
    ownerName: string | null
    area: number | null
  }> = []
  for (let idx = 0; idx < features.length; idx++) {
    const feature = features[idx]
    const jprc = perFeatureJprc[idx]
    const props = feature.properties
    if (jprc.length < 3) continue
    const pointIds = jprc
      .map(([x, y]) => idByKey.get(coordKey(x, y)))
      .filter((id): id is string => !!id)
    if (pointIds.length < 3) continue
    const parcelNumber =
      props.parcel_number ||
      props.parcel_name ||
      `画地${currentParcelCount + insertRows.length + 1}`
    insertRows.push({
      farm_id: farmId,
      work_type: 'boundary_survey',
      zone_number: parcelNumber,
      name: parcelNumber,
      point_ids: pointIds,
      area_sqm: null,
      area_ha: null,
      perimeter_m: null,
      notes: null,
    })
    meta.push({
      parcelNumber,
      location: props.location,
      ownerName: props.owner_name,
      area: props.registered_area_sqm,
    })
  }

  // 8) チャンク単位で INSERT + parcels 属性を upsert
  const POLY_CHUNK = 100
  const parcelUpserts: Array<{
    work_area_id: string
    parcel_number: string
    location: string | null
    registered_owner_name: string | null
    registered_area_sqm: number | null
  }> = []
  let createdCount = 0
  for (let i = 0; i < insertRows.length; i += POLY_CHUNK) {
    const slice = insertRows.slice(i, i + POLY_CHUNK)
    const sliceMeta = meta.slice(i, i + POLY_CHUNK)
    const { data, error } = await supabase
      .from('design_work_areas')
      .insert(slice as never)
      .select('id')
    if (error) {
      console.error('design_work_areas INSERT 失敗:', error)
      continue
    }
    const rows = (data as { id: string }[] | null) ?? []
    createdCount += rows.length
    for (let j = 0; j < rows.length; j++) {
      const m = sliceMeta[j]
      if (!m) continue
      parcelUpserts.push({
        work_area_id: rows[j].id,
        parcel_number: m.parcelNumber,
        location: m.location,
        registered_owner_name: m.ownerName,
        registered_area_sqm: m.area,
      })
    }
  }

  if (parcelUpserts.length > 0) {
    const PARCEL_CHUNK = 200
    for (let i = 0; i < parcelUpserts.length; i += PARCEL_CHUNK) {
      const slice = parcelUpserts.slice(i, i + PARCEL_CHUNK)
      const { error } = await supabase
        .from('parcels')
        .upsert(slice as never, { onConflict: 'work_area_id' })
      if (error) console.error('parcels upsert 失敗:', error)
    }
  }

  // 9) キャッシュ無効化 + 再取得
  coordState.invalidateCache()
  waState.invalidateCache()
  await waState.fetchWorkAreas(farmId)
  await coordState.fetchCoordinates(farmId)
  // モバイル (MobileStakingPage / MobileTopPage) の地番ポリゴン描画は
  // useFarmStore.workAreaPolygons を参照するため、こちらも refresh する。
  // PC の CoordinateMap は useWorkAreaStore 経由なので不要だが、副作用として
  // 呼んでも実害はない。
  await useFarmStore.getState().fetchWorkAreaPolygons()
  const areasAfter =
    useWorkAreaStore.getState().workAreas['boundary_survey'] ?? []
  await parcelStoreGet().fetchByWorkAreaIds(areasAfter.map((a) => a.id))

  const sharedPointCount =
    perFeatureJprc.reduce((sum, jprc) => sum + jprc.length, 0) -
    newVertexOrdered.length

  return {
    createdCount,
    newCoordCount: newVertexOrdered.length,
    sharedPointCount,
    message: `${createdCount} 件の地番を取り込みました (新規座標 ${newVertexOrdered.length.toLocaleString()} 点、共有点 ${sharedPointCount.toLocaleString()} 点)`,
  }
}
