// 工区の 測点データを 事前ダウンロードして 端末に 置く (iOS のオフライン運用向け)。
//
// 圏外の 現場では supabase への 問い合わせが すべて 失敗するため、工区を 開いても
// ターゲットが 1 件も 出ない。そこで 電波のある うちに 「オフライン保存」して
// おき、圏外では その スナップショットで 画面を 動かす。
//
// 保存する もの:
//   farms / projects        … 画面を 描くのに 必須 (projects の coordinate_zone が
//                              無いと 平面直角座標の 変換が できない)
//   design_coordinates      … 測設する ターゲット本体
//   staking_records         … 測設済みかの 判定に 要る
//   design_work_areas       … 地番/工事区域の 形 (point_ids で 測点を 指す)
//   parcels                 … 地番の 属性 (地番号 / 所在 / 地目 など)
//   parcel_attribute_types  … 地番の 塗り分け色 (工事単位)
//
// 対象外:
//   地図タイル / オルソ画像 / 写真 / 配管 / 工区メモ
//
// 行は DB そのままの 形で 持つ。アプリ型への 変換は 各ストアの
// hydrate* に 任せ、変換ロジックを 二重に 持たない。

import { supabase } from '@/lib/supabase'
import { idbDelete, idbGet, idbGetAll, idbPut } from '@/lib/offlineDb'

export interface FarmSnapshot {
  farmId: string
  /** 一覧表示用。工区名 */
  farmName: string
  /** 保存時刻 (ISO)。「いつの データか」を 出すため */
  savedAt: string
  farm: Record<string, unknown>
  project: Record<string, unknown> | null
  /** design_coordinates の 生行 */
  coordinateRows: Record<string, unknown>[]
  /** staking_records の 生行 */
  recordRows: Record<string, unknown>[]
  /** design_work_areas の 生行 (地番/工事区域の ポリゴン構成) */
  workAreaRows: Record<string, unknown>[]
  /** parcels の 生行 (地番属性) */
  parcelRows: Record<string, unknown>[]
  /** parcel_attribute_types の 生行 (工事単位の 塗り分け定義) */
  parcelAttributeTypeRows: Record<string, unknown>[]
}

/** 一覧表示用の 軽い メタ情報 */
export interface SnapshotMeta {
  farmId: string
  farmName: string
  savedAt: string
  coordinateCount: number
}

/** Supabase の 1 リクエスト上限 (1000 行) を 越える分を ページングで 取り切る */
async function fetchAllRows(
  table: 'design_coordinates' | 'staking_records' | 'design_work_areas',
  farmId: string,
): Promise<Record<string, unknown>[]> {
  const PAGE = 1000
  const all: Record<string, unknown>[] = []
  let from = 0
  while (from < 1_000_000) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('farm_id', farmId)
      .range(from, from + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as Record<string, unknown>[]
    all.push(...rows)
    if (rows.length < PAGE) break
    from += PAGE
  }
  return all
}

/**
 * 工区 1 件を まるごと 取得して 端末に 保存する。オンラインでのみ 実行できる。
 * 既に 保存済みなら 上書き (最新化) する。
 */
export async function downloadFarmSnapshot(
  farmId: string,
  onProgress?: (phase: string) => void,
): Promise<SnapshotMeta> {
  onProgress?.('工区情報')
  const { data: farmData, error: farmErr } = await supabase
    .from('farms')
    .select('*')
    .eq('id', farmId)
    .single()
  if (farmErr) throw farmErr
  const farm = farmData as Record<string, unknown>

  let project: Record<string, unknown> | null = null
  const projectId = farm.project_id as string | null | undefined
  if (projectId) {
    const { data: projData, error: projErr } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single()
    if (projErr) throw projErr
    project = projData as Record<string, unknown>
  }

  onProgress?.('測点')
  const coordinateRows = await fetchAllRows('design_coordinates', farmId)
  onProgress?.('実測記録')
  const recordRows = await fetchAllRows('staking_records', farmId)

  // ---- 地番 ----
  onProgress?.('地番')
  const workAreaRows = await fetchAllRows('design_work_areas', farmId)
  // parcels は farm_id を 持たず work_area_id 参照なので、区域 id で 引く。
  // URL 長の 上限を 避けるため 200 件ずつ に 割る。
  const parcelRows: Record<string, unknown>[] = []
  const areaIds = workAreaRows
    .map((a) => a.id)
    .filter((id): id is string => typeof id === 'string')
  const ID_CHUNK = 200
  for (let i = 0; i < areaIds.length; i += ID_CHUNK) {
    const { data, error } = await supabase
      .from('parcels')
      .select('*')
      .in('work_area_id', areaIds.slice(i, i + ID_CHUNK))
    if (error) throw error
    parcelRows.push(...((data ?? []) as Record<string, unknown>[]))
  }
  let parcelAttributeTypeRows: Record<string, unknown>[] = []
  if (projectId) {
    const { data, error } = await supabase
      .from('parcel_attribute_types')
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: true })
    if (error) throw error
    parcelAttributeTypeRows = (data ?? []) as Record<string, unknown>[]
  }

  const snapshot: FarmSnapshot = {
    farmId,
    farmName: (farm.name as string) ?? '(名称なし)',
    savedAt: new Date().toISOString(),
    farm,
    project,
    coordinateRows,
    recordRows,
    workAreaRows,
    parcelRows,
    parcelAttributeTypeRows,
  }
  await idbPut(snapshot)
  return {
    farmId,
    farmName: snapshot.farmName,
    savedAt: snapshot.savedAt,
    coordinateCount: coordinateRows.length,
  }
}

export async function getFarmSnapshot(farmId: string): Promise<FarmSnapshot | null> {
  try {
    return (await idbGet<FarmSnapshot>(farmId)) ?? null
  } catch {
    return null
  }
}

export async function listFarmSnapshots(): Promise<SnapshotMeta[]> {
  try {
    const all = await idbGetAll<FarmSnapshot>()
    return all
      .map((s) => ({
        farmId: s.farmId,
        farmName: s.farmName,
        savedAt: s.savedAt,
        coordinateCount: s.coordinateRows?.length ?? 0,
      }))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  } catch {
    return []
  }
}

/**
 * 保存済みスナップショットに 含まれる 工事 (projects) を 重複なしで 返す。
 * 圏外で 工事一覧を 出すのに 使う。
 */
export async function listCachedProjects(): Promise<Record<string, unknown>[]> {
  try {
    const all = await idbGetAll<FarmSnapshot>()
    const byId = new Map<string, Record<string, unknown>>()
    for (const s of all) {
      if (s.project && typeof s.project.id === 'string') byId.set(s.project.id, s.project)
    }
    return [...byId.values()]
  } catch {
    return []
  }
}

/**
 * 保存済みスナップショットに 含まれる 工区 (farms) を 重複なしで 返す。
 * 圏外で 工区一覧を 出すのに 使う。
 */
export async function listCachedFarms(): Promise<Record<string, unknown>[]> {
  try {
    const all = await idbGetAll<FarmSnapshot>()
    const byId = new Map<string, Record<string, unknown>>()
    for (const s of all) {
      if (s.farm && typeof s.farm.id === 'string') byId.set(s.farm.id, s.farm)
    }
    return [...byId.values()]
  } catch {
    return []
  }
}

export async function deleteFarmSnapshot(farmId: string): Promise<void> {
  try {
    await idbDelete(farmId)
  } catch {
    /* 無ければ 何もしない */
  }
}
