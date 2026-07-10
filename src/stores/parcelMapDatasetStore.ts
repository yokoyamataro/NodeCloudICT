// サイトオーナー管理の「地番マップ (JPGIS ベース)」データセットを扱う Zustand ストア。
//
// 責任:
//   * parcel_map_datasets メタデータの一覧取得 / active な 1 件の取得
//   * サイトオーナー用: アップロード時にクライアントでパース → 正規化 →
//     単一の parcels.geojson として Storage に保存
//   * 工区表示用: active データセットの GeoJSON を 1 度だけダウンロードして
//     メモリキャッシュ。表示側 (ParcelMapLayer) で bbox によりフィルタする
//   * active トグル / 削除
//
// Storage レイアウト:
//   {dataset_id}/parcels.geojson     ... 正規化済みの FeatureCollection
//   {dataset_id}/source.xml          ... JPGIS 原本 (GeoJSON 直接時は無し)
//
// 旧仕様 (タイル分割) との互換:
//   tile_zoom 列や tiles/ 配下のフォルダが残っている旧データセットに対しては、
//   parcels.geojson が無ければ tiles/index.json と各タイルをまとめてダウンロードし、
//   単一の FeatureCollection に統合するフォールバックを持つ。
//   タイル間の feature 重複は同一 ID / 同一形状で dedup する。

import { create } from 'zustand'
import type { FeatureCollection, Polygon } from 'geojson'
import { supabase } from '@/lib/supabase'
import type { ParcelMapDataset } from '@/types/database'
import { loadJpgisXmlFile } from '@/lib/jpgis-parser'
import {
  jpgisToGeoJson,
  normalizeGovParcelGeoJson,
  type ParcelFeatureProperties,
} from '@/lib/jpgis-to-geojson'

const BUCKET = 'parcel-maps'
const SIGNED_URL_TTL_SEC = 60 * 30 // 30 分。1 セッション用なら十分
const LEGACY_TILE_DL_CONCURRENCY = 6

export type ParcelFeatureCollection = FeatureCollection<
  Polygon,
  ParcelFeatureProperties
>

export interface UploadProgress {
  phase: 'parsing' | 'uploading' | 'saving' | 'done'
  done: number
  total: number
}

interface State {
  datasets: ParcelMapDataset[]
  loading: boolean
  error: string | null

  /** 現在キャッシュ中の GeoJSON。null は未取得または active なし */
  activeGeoJson: {
    datasetId: string
    data: ParcelFeatureCollection
  } | null
  geoJsonLoading: boolean

  fetchAll: () => Promise<void>
  /**
   * active な dataset の GeoJSON を全体ダウンロードして返す。
   * 既に同じ id のものをキャッシュ済みならそれを再利用する。
   * 旧タイル形式のデータセットには tiles/ 配下から全タイルを merge するフォールバック付き。
   */
  fetchActiveGeoJson: () => Promise<ParcelFeatureCollection | null>

  uploadDataset: (params: {
    file: File
    name: string
    description: string | null
    zone: number
    onProgress?: (p: UploadProgress) => void
  }) => Promise<ParcelMapDataset | null>

  setActive: (datasetId: string, active: boolean) => Promise<void>
  deleteDataset: (datasetId: string) => Promise<void>
}

function msg(err: unknown, fallback: string): string {
  const e = err as
    | (Partial<{ message: string; code: string; details: string; hint: string }> &
        Record<string, unknown>)
    | null
  const parts = [
    e?.message,
    e?.details,
    e?.hint,
    e?.code ? `(code: ${e.code})` : null,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0)
  return parts.length > 0 ? parts.join(' — ') : fallback
}

async function downloadJson<T>(bucket: string, path: string): Promise<T> {
  const { data: signed, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC)
  if (error) throw error
  const res = await fetch(signed.signedUrl)
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`)
  return (await res.json()) as T
}

async function tryDownloadJson<T>(
  bucket: string,
  path: string,
): Promise<T | null> {
  try {
    return await downloadJson<T>(bucket, path)
  } catch {
    return null
  }
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  onEach?: (i: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  const workers: Promise<void>[] = []
  for (let w = 0; w < concurrency; w++) {
    workers.push(
      (async () => {
        while (true) {
          const i = next++
          if (i >= tasks.length) return
          results[i] = await tasks[i]()
          onEach?.(i)
        }
      })(),
    )
  }
  await Promise.all(workers)
  return results
}

/** レガシー tile index (旧仕様) の最低限の型 */
interface LegacyTileIndex {
  zoom: number
  tiles: Array<{ z: number; x: number; y: number }>
}

/** feature のユニークキー: geometry の第 1 頂点 + parcel_name。同一 feature の
 *  タイル境界重複を消しつつ、別大字の同名地番は別物として残す。 */
function featureDedupKey(f: {
  properties: ParcelFeatureProperties
  geometry: { coordinates: number[][][] }
}): string {
  const outer = f.geometry.coordinates[0]
  const head = outer?.[0]
  const headKey = head ? `${head[0].toFixed(7)},${head[1].toFixed(7)}` : ''
  return `${f.properties.parcel_name}|${headKey}`
}

export const useParcelMapDatasetStore = create<State>((set, get) => ({
  datasets: [],
  loading: false,
  error: null,
  activeGeoJson: null,
  geoJsonLoading: false,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('parcel_map_datasets')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      set({ datasets: (data ?? []) as ParcelMapDataset[], loading: false })
    } catch (err) {
      set({
        loading: false,
        error: msg(err, '地番マップデータセットの取得に失敗しました'),
      })
    }
  },

  fetchActiveGeoJson: async () => {
    const active = get().datasets.find((d) => d.active) ?? null
    if (!active) {
      set({ activeGeoJson: null })
      return null
    }
    const cached = get().activeGeoJson
    if (cached && cached.datasetId === active.id) return cached.data

    set({ geoJsonLoading: true })
    try {
      let fc: ParcelFeatureCollection | null = null

      // 経路 1: 新形式または旧非タイル形式 — 単一 parcels.geojson を取得
      if (active.storage_geojson_path) {
        fc = await tryDownloadJson<ParcelFeatureCollection>(
          BUCKET,
          active.storage_geojson_path,
        )
      }

      // 経路 2: 旧タイル形式 — tiles/index.json を辿って全タイルを結合
      if (!fc) {
        const idx = await tryDownloadJson<LegacyTileIndex>(
          BUCKET,
          `${active.id}/tiles/index.json`,
        )
        if (idx) {
          const tasks = idx.tiles.map(
            (t) => () =>
              tryDownloadJson<ParcelFeatureCollection>(
                BUCKET,
                `${active.id}/tiles/${t.z}/${t.x}/${t.y}.geojson`,
              ),
          )
          const results = await runWithConcurrency(tasks, LEGACY_TILE_DL_CONCURRENCY)
          const nonNull = results.filter(
            (r): r is ParcelFeatureCollection => r != null,
          )
          const seen = new Set<string>()
          const combined: ParcelFeatureCollection = {
            type: 'FeatureCollection',
            features: [],
          }
          for (const t of nonNull) {
            for (const f of t.features) {
              const key = featureDedupKey(f)
              if (seen.has(key)) continue
              seen.add(key)
              combined.features.push(f)
            }
          }
          fc = combined
        }
      }

      if (!fc) {
        throw new Error(
          'データセットのファイルが見つかりません。管理画面から再アップロードしてください。',
        )
      }

      set({
        activeGeoJson: { datasetId: active.id, data: fc },
        geoJsonLoading: false,
      })
      return fc
    } catch (err) {
      set({
        geoJsonLoading: false,
        error: msg(err, 'GeoJSON の取得に失敗しました'),
      })
      return null
    }
  },

  uploadDataset: async ({ file, name, description, zone, onProgress }) => {
    set({ error: null })
    try {
      onProgress?.({ phase: 'parsing', done: 0, total: 1 })
      const lowerName = file.name.toLowerCase()
      const isGeoJson =
        /\.(geo)?json$/i.test(file.name) ||
        file.type === 'application/geo+json' ||
        file.type === 'application/json'
      const isXml =
        lowerName.endsWith('.xml') ||
        file.type === 'application/xml' ||
        file.type === 'text/xml'
      if (!isGeoJson && !isXml) {
        throw new Error(
          'ファイル形式を判定できません。.xml もしくは .geojson を指定してください',
        )
      }

      // 1) クライアント側で変換 or パース
      let featureCollection: ParcelFeatureCollection
      let bbox: ParcelMapDataset['bbox'] = null
      let parcelCount = 0
      let sourceKind: 'jpgis_xml' | 'geojson'
      let effectiveZone = zone
      if (isGeoJson) {
        const raw = JSON.parse(await file.text())
        const norm = normalizeGovParcelGeoJson(raw)
        featureCollection = norm.featureCollection
        bbox = norm.bbox
        parcelCount = norm.parcelCount
        sourceKind = 'geojson'
        if (norm.detectedZone != null) effectiveZone = norm.detectedZone
        for (const f of featureCollection.features) {
          if (f.properties.source_zone === 0)
            f.properties.source_zone = effectiveZone
        }
      } else {
        const parsed = await loadJpgisXmlFile(file)
        const conv = jpgisToGeoJson(parsed, zone)
        featureCollection = conv.featureCollection
        bbox = conv.bbox
        parcelCount = conv.parcelCount
        sourceKind = 'jpgis_xml'
      }
      onProgress?.({ phase: 'parsing', done: 1, total: 1 })

      // 2) dataset id と Storage パス
      const datasetId =
        crypto.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const xmlPath = isXml ? `${datasetId}/source.xml` : null
      const geoJsonPath = `${datasetId}/parcels.geojson`

      // 3) Storage にアップロード (GeoJSON 単一 + 任意で XML 原本)
      const geoJsonBlob = new Blob([JSON.stringify(featureCollection)], {
        type: 'application/geo+json',
      })
      const totalUploads = 1 + (xmlPath ? 1 : 0)
      onProgress?.({ phase: 'uploading', done: 0, total: totalUploads })
      const { error: gjErr } = (await supabase.storage
        .from(BUCKET)
        .upload(geoJsonPath, geoJsonBlob, {
          contentType: 'application/geo+json',
          upsert: false,
        })) as unknown as { error: unknown }
      if (gjErr) throw gjErr
      onProgress?.({ phase: 'uploading', done: 1, total: totalUploads })
      if (xmlPath) {
        const { error: xErr } = (await supabase.storage.from(BUCKET).upload(
          xmlPath,
          file,
          {
            contentType: 'application/xml',
            upsert: false,
          },
        )) as unknown as { error: unknown }
        if (xErr) throw xErr
        onProgress?.({ phase: 'uploading', done: 2, total: totalUploads })
      }

      // 4) メタデータ INSERT
      onProgress?.({ phase: 'saving', done: 0, total: 1 })
      const { data: userData } = await supabase.auth.getUser()
      const insertBody = {
        id: datasetId,
        name,
        description,
        coordinate_zone: effectiveZone,
        source_kind: sourceKind,
        storage_xml_path: xmlPath,
        storage_geojson_path: geoJsonPath,
        tile_format: 'geojson',
        bbox,
        parcel_count: parcelCount,
        active: false,
        uploaded_by_user_id: userData.user?.id ?? null,
      }
      const { data, error } = await supabase
        .from('parcel_map_datasets')
        .insert(insertBody as never)
        .select('*')
        .single()
      if (error) {
        const cleanup = [geoJsonPath]
        if (xmlPath) cleanup.push(xmlPath)
        await supabase.storage.from(BUCKET).remove(cleanup).catch(() => {})
        throw error
      }
      const created = data as ParcelMapDataset
      set((state) => ({ datasets: [created, ...state.datasets] }))
      onProgress?.({ phase: 'done', done: 1, total: 1 })
      return created
    } catch (err) {
      set({ error: msg(err, 'アップロードに失敗しました') })
      return null
    }
  },

  setActive: async (datasetId, active) => {
    const prev = get().datasets
    const next = active
      ? prev.map((d) =>
          d.id === datasetId ? { ...d, active: true } : { ...d, active: false },
        )
      : prev.map((d) => (d.id === datasetId ? { ...d, active: false } : d))
    set({
      datasets: next,
      // active が変わったのでキャッシュも破棄
      activeGeoJson: null,
    })
    try {
      if (active) {
        const { error: e1 } = await supabase
          .from('parcel_map_datasets')
          .update({ active: false } as never)
          .neq('id', datasetId)
          .eq('active', true)
        if (e1) throw e1
      }
      const { error } = await supabase
        .from('parcel_map_datasets')
        .update({ active } as never)
        .eq('id', datasetId)
      if (error) throw error
    } catch (err) {
      set({ datasets: prev, error: msg(err, 'active 切替に失敗しました') })
    }
  },

  deleteDataset: async (datasetId) => {
    const prev = get().datasets
    const target = prev.find((d) => d.id === datasetId)
    set({
      datasets: prev.filter((d) => d.id !== datasetId),
      activeGeoJson:
        get().activeGeoJson?.datasetId === datasetId
          ? null
          : get().activeGeoJson,
    })
    try {
      if (target) {
        // tiles/ フォルダ配下も含めてまるごと消す (旧タイル形式の掃除)
        const listAll = async (prefix: string, acc: string[]) => {
          const { data, error } = await supabase.storage
            .from(BUCKET)
            .list(prefix, { limit: 1000 })
          if (error) throw error
          for (const item of data ?? []) {
            const p = `${prefix}/${item.name}`
            if ((item as { id: string | null }).id === null) {
              await listAll(p, acc)
            } else {
              acc.push(p)
            }
          }
        }
        const paths: string[] = []
        await listAll(target.id, paths).catch(() => {})
        for (let i = 0; i < paths.length; i += 100) {
          await supabase.storage
            .from(BUCKET)
            .remove(paths.slice(i, i + 100))
            .catch(() => {})
        }
      }
      const { error } = await supabase
        .from('parcel_map_datasets')
        .delete()
        .eq('id', datasetId)
      if (error) throw error
    } catch (err) {
      set({ datasets: prev, error: msg(err, '削除に失敗しました') })
    }
  },
}))
