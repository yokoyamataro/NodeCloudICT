// サイトオーナーがマスターデータとしてアップロードした地番マップ (JPGIS)
// を CoordinateMap の背景レイヤとして重ねる。
//
// * 描画: 半透明ポリゴン。react-leaflet の <GeoJSON> を使うが、大量地番でも
//   軽くするため Canvas レンダラを併用。
// * 対話: ポリゴンクリック → Leaflet ネイティブの Popup で属性 + 「工区に取り込む」
//   ボタンを表示。ボタンは onImport(feature) を呼ぶ。呼出側 (親) が
//   design_coordinates / design_work_areas / parcels に INSERT する。

import { useEffect, useMemo, useRef } from 'react'
import { GeoJSON, useMap } from 'react-leaflet'
import type { Feature, Polygon } from 'geojson'
import L from 'leaflet'
import {
  useParcelMapDatasetStore,
  type ParcelFeatureCollection,
} from '@/stores/parcelMapDatasetStore'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'

interface Props {
  visible: boolean
  onImport: (
    feature: Feature<Polygon, ParcelFeatureProperties>,
  ) => Promise<void> | void
  /** 取込済の parcel_number (プロパティ側の一致で「既に工区にある」を判定する簡易チェック) */
  importedParcelNumbers?: Set<string>
}

const STYLE_DEFAULT = {
  color: '#f97316', // orange-500 (登記地図の面)
  weight: 1,
  fillColor: '#fdba74', // orange-300
  fillOpacity: 0.15,
}
const STYLE_IMPORTED = {
  color: '#059669', // emerald-600
  weight: 1.2,
  fillColor: '#a7f3d0', // emerald-200
  fillOpacity: 0.35,
}

export function ParcelMapLayer({
  visible,
  onImport,
  importedParcelNumbers,
}: Props) {
  const map = useMap()
  const geoJson = useParcelMapDatasetStore((s) => s.activeGeoJson?.data ?? null)
  const fetchActive = useParcelMapDatasetStore((s) => s.fetchActiveGeoJson)
  const importingRef = useRef<Set<string>>(new Set())

  // 可視化されたタイミングで一度だけ fetch
  useEffect(() => {
    if (!visible) return
    if (geoJson) return
    void fetchActive()
  }, [visible, geoJson, fetchActive])

  // Canvas レンダラを使うと数千地番でも軽い。ズームアウト時のパン中も
  // タイル型のように振る舞う
  const renderer = useMemo(() => L.canvas({ padding: 0.2 }), [])

  if (!visible || !geoJson) return null

  return (
    <GeoJson
      data={geoJson}
      renderer={renderer}
      importedParcelNumbers={importedParcelNumbers}
      onImport={async (feature) => {
        const key = feature.properties.parcel_number
        if (importingRef.current.has(key)) return
        importingRef.current.add(key)
        try {
          await onImport(feature)
        } finally {
          importingRef.current.delete(key)
          // Popup を閉じる (最新のアプリ状態で再クリック時にラベルを更新)
          map.closePopup()
        }
      }}
    />
  )
}

/** 内部コンポーネント。data と onImport が変わったら再マウントされるように分けている。 */
function GeoJson({
  data,
  renderer,
  onImport,
  importedParcelNumbers,
}: {
  data: ParcelFeatureCollection
  renderer: L.Renderer
  onImport: (feature: Feature<Polygon, ParcelFeatureProperties>) => void
  importedParcelNumbers?: Set<string>
}) {
  // GeoJSON は key で FeatureCollection を差し替えて再描画させる
  const key = useMemo(() => `parcel-map-${data.features.length}-${Date.now()}`, [data])
  return (
    <GeoJSON
      key={key}
      data={data}
      style={(feature) => {
        const props = feature?.properties as ParcelFeatureProperties | undefined
        const imported =
          !!props && !!importedParcelNumbers?.has(props.parcel_number)
        return {
          renderer,
          ...(imported ? STYLE_IMPORTED : STYLE_DEFAULT),
        }
      }}
      onEachFeature={(feature, layer) => {
        const props = feature.properties as ParcelFeatureProperties
        const container = document.createElement('div')
        container.style.minWidth = '180px'
        container.innerHTML = `
          <div style="font-size:12px;line-height:1.4;">
            <div style="font-weight:600;font-size:13px;margin-bottom:4px;">
              地番 ${escapeHtml(props.parcel_name || props.parcel_number || '(不明)')}
            </div>
            ${
              props.owner_name
                ? `<div>所有者: ${escapeHtml(props.owner_name)}</div>`
                : ''
            }
            ${
              props.registered_area_sqm != null
                ? `<div>登記面積: ${props.registered_area_sqm.toLocaleString()} m²</div>`
                : ''
            }
            <div style="color:#64748b;font-size:11px;margin-top:2px;">
              第 ${props.source_zone} 系
            </div>
            <button
              type="button"
              data-import-btn="1"
              style="margin-top:6px;width:100%;padding:6px 8px;border-radius:6px;background:#2563eb;color:white;font-size:12px;font-weight:600;border:none;cursor:pointer;"
            >
              この地番を工区に取り込む
            </button>
          </div>
        `
        const btn = container.querySelector<HTMLButtonElement>(
          'button[data-import-btn="1"]',
        )
        btn?.addEventListener('click', () => {
          onImport(feature as Feature<Polygon, ParcelFeatureProperties>)
        })
        layer.bindPopup(container, { maxWidth: 260 })
      }}
    />
  )
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      case "'":
        return '&#39;'
    }
    return c
  })
}
