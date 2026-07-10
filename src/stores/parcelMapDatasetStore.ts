// サイトオーナー管理の「地番マップ (JPGIS ベース)」データセットを扱う Zustand ストア。
//
// 責任:
//   * parcel_map_datasets メタデータの一覧取得 / active な 1 件の取得
//   * サイトオーナー用: アップロード時にクライアントでパース → 正規化 →
//     タイル分割 (z=tile_zoom, デフォ 14) → Storage に個別タイルとして保存
//   * 工区表示用: 与えられた bbox に含まれるタイルだけダウンロードし、
//     重複排除して 1 つの FeatureCollection を返す (fetchTilesForBbox)
//   * active トグル / 削除
//
// Storage レイアウト:
//   {dataset_id}/parcels.geojson         ... 旧形式 (フォールバック用)
//   {dataset_id}/tiles/index.json        ... TileIndex (JSON)
//   {dataset_id}/tiles/{z}/{x}/{y}.geojson ... 各タイルの FeatureCollection
//   {dataset_id}/source.xml              ... JPGIS 原本 (GeoJSON 直接時は無し)

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
import {
  tileFeatureCollection,
  mergeAndDedup,
  type TileIndex,
} from '@/lib/geojson-tiler'
import { bboxToTiles, tileKey, type Bbox } from '@/lib/tile-math'

const BUCKET = 'parcel-maps'
const SIGNED_URL_TTL_SEC = 60 * 30 // 30 分。1 セッション用なら十分
const TILE_UPLOAD_CONCURRENCY = 6

export type ParcelFeatureCollection = FeatureCollection<
  Polygon,
  ParcelFeatureProperties
>

export interface UploadProgress {
  phase: 'parsing' | 'tiling' | 'uploading' | 'saving' | 'done'
  done: number
  total: number
}

interface TileCache {
  datasetId: string
  index: TileIndex | null
  /** タイルキー ('z/x/y') → その FeatureCollection */
  tiles: Map<string, ParcelFeatureCollection>
}

interface State {
  datasets: ParcelMapDataset[]
  loading: boolean
  error: string | null

  tileCache: TileCache | null
  tilesLoading: boolean

  fetchAll: () => Promise<void>
  /**
   * active な dataset のうち、bbox に交差するタイルを Storage からダウンロードし、
   * 重複排除した FeatureCollection を返す。
   * 既に取得済のタイルは再ダウンロードしない (メモリキャッシュ)。
   */
  fetchTilesForBbox: (bbox: Bbox) => Promise<ParcelFeatureCollection | null>

  uploadDataset: (params: {
    file: File
    name: string
    description: string | null
    zone: number
    tileZoom?: number
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

async function downloadJson<T>(
  bucket: string,
  path: string,
): Promise<T> {
  const { data: signed, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, SIGNED_URL_TTL_SEC)
  if (error) throw error
  const res = await fetch(signed.signedUrl)
  if (!res.ok) throw new Error(`Fetch failed (${res.status})`)
  return (await res.json()) as T
}

// 指定 URL が存在するか (HEAD 相当)。存在しなければ null を返す
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

// promise をキューで並列制御しつつ実行
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

export const useParcelMapDatasetStore = create<State>((set, get) => ({
  datasets: [],
  loading: false,
  error: null,
  tileCache: null,
  tilesLoading: false,

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

  fetchTilesForBbox: async (bbox) => {
    const active = get().datasets.find((d) => d.active) ?? null
    if (!active) {
      set({ tileCache: null })
      return null
    }

    // データセットが変わったらキャッシュを破棄
    let cache = get().tileCache
    if (!cache || cache.datasetId !== active.id) {
      cache = { datasetId: active.id, index: null, tiles: new Map() }
    }

    // インデックス取得 (初回のみ)
    if (!cache.index) {
      set({ tilesLoading: true })
      const idx = await tryDownloadJson<TileIndex>(
        BUCKET,
        `${active.id}/tiles/index.json`,
      )
      if (idx) {
        cache.index = idx
      } else {
        // 旧形式のデータセット (タイル分割前) → parcels.geojson を丸ごとダウンロードして
        // メモリで bbox フィルタする
        if (active.storage_geojson_path) {
          const fc = await tryDownloadJson<ParcelFeatureCollection>(
            BUCKET,
            active.storage_geojson_path,
          )
          if (fc) {
            // 1 個の擬似タイル (全体) として cache に入れる
            cache.tiles.set('legacy/0/0', fc)
            cache.index = {
              zoom: 0,
              bbox: active.bbox ?? {
                minLng: -180,
                minLat: -90,
                maxLng: 180,
                maxLat: 90,
              },
              tiles: [{ z: 0, x: 0, y: 0, count: fc.features.length }],
            }
          }
        }
      }
      set({ tileCache: cache, tilesLoading: false })
    }

    if (!cache.index) return null

    // legacy 分岐: 全 feature が cache.tiles['legacy/0/0'] にある
    if (cache.index.zoom === 0) {
      const legacy = cache.tiles.get('legacy/0/0')
      if (!legacy) return null
      // メモリで bbox フィルタして返す (旧形式のみのフォールバック)
      const features = legacy.features.filter((f) => {
        const outer = f.geometry.coordinates[0] as Array<[number, number]>
        if (outer.length === 0) return false
        for (const [lng, lat] of outer) {
          if (
            lng >= bbox.minLng &&
            lng <= bbox.maxLng &&
            lat >= bbox.minLat &&
            lat <= bbox.maxLat
          ) {
            return true
          }
        }
        return false
      })
      return { type: 'FeatureCollection', features }
    }

    // タイル分岐: bbox に交差するタイルを列挙し、まだキャッシュに無いものだけダウンロード
    const wanted = bboxToTiles(bbox, cache.index.zoom)
    // 索引に載っているタイル (空タイルはリクエストしない) だけに絞る
    const populated = new Set(
      cache.index.tiles.map((t) => tileKey({ z: t.z, x: t.x, y: t.y })),
    )
    const wantedKeys = wanted
      .filter((t) => populated.has(tileKey(t)))
      .map((t) => tileKey(t))
    const missing = wantedKeys.filter((k) => !cache!.tiles.has(k))

    if (missing.length > 0) {
      set({ tilesLoading: true })
      const tasks = missing.map(
        (k) => () =>
          tryDownloadJson<ParcelFeatureCollection>(
            BUCKET,
            `${active.id}/tiles/${k}.geojson`,
          ).then((fc) => ({ key: k, fc })),
      )
      const results = await runWithConcurrency(tasks, TILE_UPLOAD_CONCURRENCY)
      for (const r of results) {
        if (r.fc) cache.tiles.set(r.key, r.fc)
      }
      set({ tileCache: cache, tilesLoading: false })
    }

    // マージ + 重複排除
    const fcs: ParcelFeatureCollection[] = []
    for (const k of wantedKeys) {
      const fc = cache.tiles.get(k)
      if (fc) fcs.push(fc)
    }
    return mergeAndDedup(fcs)
  },

  uploadDataset: async ({ file, name, description, zone, tileZoom = 14, onProgress }) => {
    set({ error: null })
    try {
      onProgress?.({ phase: 'parsing', done: 0, total: 1 })
      // 拡張子 (フォールバックで MIME) から XML か GeoJSON かを判定
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
          if (f.properties.source_zone === 0) f.properties.source_zone = effectiveZone
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

      // 2) タイル分割
      onProgress?.({ phase: 'tiling', done: 0, total: 1 })
      const tiled = tileFeatureCollection(featureCollection, tileZoom)
      onProgress?.({ phase: 'tiling', done: 1, total: 1 })

      // 3) dataset id を確保 + パス
      const datasetId =
        crypto.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const xmlPath = isXml ? `${datasetId}/source.xml` : null
      const indexPath = `${datasetId}/tiles/index.json`

      // 4) Storage にタイル群 + インデックス + (XML 原本) をアップロード
      const uploads: (() => Promise<{ error: unknown }>)[] = []

      // index.json
      uploads.push(async () => {
        const blob = new Blob([JSON.stringify(tiled.index)], {
          type: 'application/json',
        })
        return (await supabase.storage.from(BUCKET).upload(indexPath, blob, {
          contentType: 'application/json',
          upsert: false,
        })) as unknown as { error: unknown }
      })

      // 各タイル
      for (const [key, fc] of tiled.tiles.entries()) {
        const tilePath = `${datasetId}/tiles/${key}.geojson`
        uploads.push(async () => {
          const blob = new Blob([JSON.stringify(fc)], {
            type: 'application/geo+json',
          })
          return (await supabase.storage.from(BUCKET).upload(tilePath, blob, {
            contentType: 'application/geo+json',
            upsert: false,
          })) as unknown as { error: unknown }
        })
      }

      // XML 原本 (JPGIS 由来なら)
      if (xmlPath) {
        uploads.push(async () => {
          return (await supabase.storage.from(BUCKET).upload(xmlPath, file, {
            contentType: 'application/xml',
            upsert: false,
          })) as unknown as { error: unknown }
        })
      }

      const totalUploads = uploads.length
      onProgress?.({ phase: 'uploading', done: 0, total: totalUploads })
      const results = await runWithConcurrency(
        uploads,
        TILE_UPLOAD_CONCURRENCY,
        (i) => {
          onProgress?.({
            phase: 'uploading',
            done: i + 1,
            total: totalUploads,
          })
        },
      )
      const firstError = results.find((r) => r.error)?.error
      if (firstError) throw firstError

      // 5) メタデータ INSERT (旧 storage_geojson_path は無し = null で保存)
      onProgress?.({ phase: 'saving', done: 0, total: 1 })
      const { data: userData } = await supabase.auth.getUser()
      const insertBody = {
        id: datasetId,
        name,
        description,
        coordinate_zone: effectiveZone,
        source_kind: sourceKind,
        storage_xml_path: xmlPath,
        storage_geojson_path: null,
        tile_format: 'geojson',
        tile_zoom: tileZoom,
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
        // 失敗時は Storage 掃除
        const cleanupPaths = [
          indexPath,
          ...Array.from(tiled.tiles.keys()).map(
            (k) => `${datasetId}/tiles/${k}.geojson`,
          ),
        ]
        if (xmlPath) cleanupPaths.push(xmlPath)
        // remove の 1000 件制限に注意して分割
        for (let i = 0; i < cleanupPaths.length; i += 100) {
          await supabase.storage
            .from(BUCKET)
            .remove(cleanupPaths.slice(i, i + 100))
            .catch(() => {})
        }
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
      // active が変わったのでタイルキャッシュも破棄
      tileCache: null,
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
      tileCache:
        get().tileCache?.datasetId === datasetId ? null : get().tileCache,
    })
    try {
      if (target) {
        // タイルを含むフォルダ配下を全部消す
        // Storage には「フォルダ削除」が無いので list → remove
        const listAll = async (prefix: string, acc: string[]) => {
          const { data, error } = await supabase.storage
            .from(BUCKET)
            .list(prefix, { limit: 1000 })
          if (error) throw error
          for (const item of data ?? []) {
            const p = `${prefix}/${item.name}`
            // フォルダ判定は item.id === null で行う (Supabase 仕様)
            if ((item as { id: string | null }).id === null) {
              await listAll(p, acc)
            } else {
              acc.push(p)
            }
          }
        }
        const paths: string[] = []
        await listAll(`${target.id}`, paths).catch(() => {})
        // 100 件ずつ remove
        for (let i = 0; i < paths.length; i += 100) {
          await supabase.storage.from(BUCKET).remove(paths.slice(i, i + 100)).catch(() => {})
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
