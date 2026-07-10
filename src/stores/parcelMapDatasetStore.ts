// サイトオーナー管理の「地番マップ (JPGIS ベース)」データセットを扱う Zustand ストア。
//
// 責任:
//   * parcel_map_datasets メタデータの一覧取得 / active な 1 件の取得
//   * active データセットの GeoJSON を Storage からダウンロードしてメモリキャッシュ
//   * サイトオーナー用: XML アップロード → クライアント側で GeoJSON 変換 → Storage 二重保存 → INSERT
//   * active トグル / 削除
//
// キャッシュ戦略:
//   * fetchAll は毎回 fetch
//   * fetchActiveGeoJson は「同じ dataset id」を要求されるかぎりメモリの Feature Collection を再利用
//     (署名 URL の期限には触れず、ダウンロードは 1 度だけ)

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

export type ParcelFeatureCollection = FeatureCollection<
  Polygon,
  ParcelFeatureProperties
>

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
   * active な dataset の GeoJSON をダウンロードして返す。
   * 既に同じ id のものをキャッシュ済みならそれを再利用する。
   */
  fetchActiveGeoJson: () => Promise<ParcelFeatureCollection | null>

  uploadDataset: (params: {
    file: File
    name: string
    description: string | null
    zone: number
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
    if (!active.storage_geojson_path) {
      // 変換キャッシュがまだ無い場合
      set({ activeGeoJson: null })
      return null
    }
    set({ geoJsonLoading: true })
    try {
      // 署名付き URL 経由でダウンロード (バケットは private だが SELECT は authenticated 全員可)
      const { data: signed, error: signErr } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(active.storage_geojson_path, SIGNED_URL_TTL_SEC)
      if (signErr) throw signErr
      const res = await fetch(signed.signedUrl)
      if (!res.ok) throw new Error(`GeoJSON の取得に失敗しました (${res.status})`)
      const json = (await res.json()) as ParcelFeatureCollection
      set({
        activeGeoJson: { datasetId: active.id, data: json },
        geoJsonLoading: false,
      })
      return json
    } catch (err) {
      set({
        geoJsonLoading: false,
        error: msg(err, 'GeoJSON の取得に失敗しました'),
      })
      return null
    }
  },

  uploadDataset: async ({ file, name, description, zone }) => {
    set({ error: null })
    try {
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
      let featureCollection
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
        // properties の「座標系」から系番号を検出できた場合はそちらを優先
        if (norm.detectedZone != null) effectiveZone = norm.detectedZone
        // ソース由来 zone が拾えたら feature の source_zone を上書き (取込時の
        // 「同一 zone なら jprc をそのまま」判定に効くよう合わせる。ただし
        // jprc_coords は空なので実質は再投影パス)
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

      // 2) dataset id を先に確保
      const datasetId =
        crypto.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const xmlPath = isXml ? `${datasetId}/source.xml` : null
      const geoJsonPath = `${datasetId}/parcels.geojson`

      // 3) Storage にアップロード。GeoJSON 側は正規化したものを、XML 側は原本をそのまま。
      const geoJsonBlob = new Blob([JSON.stringify(featureCollection)], {
        type: 'application/geo+json',
      })
      const uploadOps: Promise<{ error: unknown }>[] = [
        supabase.storage
          .from(BUCKET)
          .upload(geoJsonPath, geoJsonBlob, {
            contentType: 'application/geo+json',
            upsert: false,
          }) as unknown as Promise<{ error: unknown }>,
      ]
      if (xmlPath) {
        uploadOps.push(
          supabase.storage.from(BUCKET).upload(xmlPath, file, {
            contentType: 'application/xml',
            upsert: false,
          }) as unknown as Promise<{ error: unknown }>,
        )
      }
      const results = await Promise.all(uploadOps)
      for (const r of results) {
        if (r.error) throw r.error
      }

      // 4) メタデータ INSERT
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
        // Storage のオーファンを掃除
        const paths = [geoJsonPath]
        if (xmlPath) paths.push(xmlPath)
        await supabase.storage.from(BUCKET).remove(paths).catch(() => {})
        throw error
      }
      const created = data as ParcelMapDataset
      set((state) => ({ datasets: [created, ...state.datasets] }))
      return created
    } catch (err) {
      set({ error: msg(err, 'アップロードに失敗しました') })
      return null
    }
  },

  setActive: async (datasetId, active) => {
    // 楽観更新: active=true にする場合、既存の active はすべて false に落とす。
    // (UI では 1 件だけ active にする運用)
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
        // 既存の active を先に落とす
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
      // Storage のオブジェクトを消してからメタ行を削除
      if (target) {
        const paths: string[] = []
        if (target.storage_xml_path) paths.push(target.storage_xml_path)
        if (target.storage_geojson_path) paths.push(target.storage_geojson_path)
        if (paths.length > 0) {
          await supabase.storage.from(BUCKET).remove(paths).catch(() => {})
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
