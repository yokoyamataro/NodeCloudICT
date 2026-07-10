// サイトオーナーがマスターデータとしてアップロードした地番マップを
// CoordinateMap の背景レイヤとして重ねる。
//
// * 描画: 与えられた bbox 内のタイルだけダウンロード → merge → <GeoJSON>。
//   Canvas レンダラで大量地番も軽く描画。
// * 対話: ポリゴンクリック → Leaflet の Popup で属性 + 「工区に取り込む」ボタン。
//   Popup content は初回クリック時にだけ生成 (lazy) して 31k 件 upfront 生成を避ける。
// * 地番名ラベル: ズーム閾値以上のときにだけ bindTooltip する (lazy)。
//   数千件規模でも初期化は速い。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GeoJSON, useMap } from 'react-leaflet'
import type { Feature, Polygon } from 'geojson'
import L from 'leaflet'
import {
  useParcelMapDatasetStore,
  type ParcelFeatureCollection,
} from '@/stores/parcelMapDatasetStore'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'
import type { Bbox } from '@/lib/tile-math'

interface Props {
  visible: boolean
  /** 明示的な表示範囲 (farm.parcel_map_bbox 経由の固定範囲や工区座標由来の bbox)。
   *  null の場合は地図の現在ビューポートに追従して debounced fetch する。 */
  bbox: Bbox | null
  onImport: (
    feature: Feature<Polygon, ParcelFeatureProperties>,
  ) => Promise<void> | void
  /** 取込済の parcel_number (プロパティ側の一致で「既に工区にある」を判定する簡易チェック) */
  importedParcelNumbers?: Set<string>
}

const STYLE_DEFAULT = {
  color: '#f97316',
  weight: 1,
  fillColor: '#fdba74',
  fillOpacity: 0.15,
}
const STYLE_IMPORTED = {
  color: '#059669',
  weight: 1.2,
  fillColor: '#a7f3d0',
  fillOpacity: 0.35,
}

/** このズーム以上でラベル表示 */
const LABEL_MIN_ZOOM = 17

export function ParcelMapLayer({
  visible,
  bbox,
  onImport,
  importedParcelNumbers,
}: Props) {
  const map = useMap()
  const fetchTiles = useParcelMapDatasetStore((s) => s.fetchTilesForBbox)
  const importingRef = useRef<Set<string>>(new Set())
  const [fc, setFc] = useState<ParcelFeatureCollection | null>(null)
  const [viewportBbox, setViewportBbox] = useState<Bbox | null>(null)

  // bbox 未指定のときは、地図のビューポートを追跡してフェッチ範囲とする
  useEffect(() => {
    if (!visible) {
      setViewportBbox(null)
      return
    }
    if (bbox) {
      // 明示指定あり → ビューポート追跡不要
      setViewportBbox(null)
      return
    }
    const readBounds = (): Bbox => {
      const b = map.getBounds()
      return {
        minLng: b.getWest(),
        minLat: b.getSouth(),
        maxLng: b.getEast(),
        maxLat: b.getNorth(),
      }
    }
    // 初回反映
    setViewportBbox(readBounds())
    let t: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => setViewportBbox(readBounds()), 300)
    }
    map.on('moveend', debounced)
    return () => {
      if (t) clearTimeout(t)
      map.off('moveend', debounced)
    }
  }, [map, visible, bbox])

  const effectiveBbox = bbox ?? viewportBbox

  // bbox が変わったらタイルをフェッチ (bbox が null の間は fetch しない)
  useEffect(() => {
    if (!visible || !effectiveBbox) {
      setFc(null)
      return
    }
    let cancelled = false
    void (async () => {
      const result = await fetchTiles(effectiveBbox)
      if (cancelled) return
      setFc(result)
    })()
    return () => {
      cancelled = true
    }
  }, [visible, effectiveBbox, fetchTiles])

  // Canvas レンダラ
  const renderer = useMemo(() => L.canvas({ padding: 0.2 }), [])

  // ズームで地番名ラベルの表示クラスを切替
  useEffect(() => {
    const container = map.getContainer()
    const update = () => {
      if (!visible) {
        container.classList.remove('parcel-labels-visible')
        return
      }
      if (map.getZoom() >= LABEL_MIN_ZOOM) {
        container.classList.add('parcel-labels-visible')
      } else {
        container.classList.remove('parcel-labels-visible')
      }
    }
    update()
    map.on('zoomend', update)
    return () => {
      map.off('zoomend', update)
      container.classList.remove('parcel-labels-visible')
    }
  }, [map, visible])

  if (!visible || !fc || fc.features.length === 0) return null

  return (
    <GeoJsonInner
      data={fc}
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
          map.closePopup()
        }
      }}
    />
  )
}

/** GeoJSON 描画本体。data 参照が変わると再マウントされ、地番名 tooltip は
 *  「一度でもズーム閾値以上に上がったら全 layer に bind」ワンショット方式。 */
function GeoJsonInner({
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
  const map = useMap()
  const layerRef = useRef<L.GeoJSON | null>(null)
  const labelsBoundRef = useRef(false)

  // FeatureCollection が変わったら key を変えて再マウント
  const key = useMemo(
    () => `parcel-map-${data.features.length}-${Date.now()}`,
    [data],
  )

  // 別 FC に切り替わったらフラグをリセット
  useEffect(() => {
    labelsBoundRef.current = false
  }, [data])

  // ズームレベルが LABEL_MIN_ZOOM 以上に達したら、一度だけ全 layer に tooltip を bind
  useEffect(() => {
    const bindLabelsIfNeeded = () => {
      if (labelsBoundRef.current) return
      const layerGroup = layerRef.current
      if (!layerGroup) return
      if (map.getZoom() < LABEL_MIN_ZOOM) return
      layerGroup.eachLayer((layer) => {
        const feature = (layer as L.GeoJSON & { feature?: unknown }).feature as
          | Feature<Polygon, ParcelFeatureProperties>
          | undefined
        if (!feature) return
        const text =
          feature.properties.parcel_name || feature.properties.parcel_number
        if (text) {
          ;(layer as L.Layer).bindTooltip(text, {
            permanent: true,
            direction: 'center',
            className: 'parcel-map-label',
            opacity: 1,
          })
        }
      })
      labelsBoundRef.current = true
    }
    // マウント直後は layer 生成が済んでいないので少し待ってからも試す
    const t = setTimeout(bindLabelsIfNeeded, 100)
    map.on('zoomend', bindLabelsIfNeeded)
    return () => {
      clearTimeout(t)
      map.off('zoomend', bindLabelsIfNeeded)
    }
  }, [map, data])

  // クリック時のポップアップ (lazy 生成)
  const openImportPopup = useCallback(
    (
      feature: Feature<Polygon, ParcelFeatureProperties>,
      latlng: L.LatLng,
    ) => {
      const props = feature.properties
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
      btn?.addEventListener('click', () => onImport(feature))
      L.popup({ maxWidth: 260 }).setLatLng(latlng).setContent(container).openOn(map)
    },
    [map, onImport],
  )

  return (
    <GeoJSON
      key={key}
      ref={(ref: L.GeoJSON | null) => {
        layerRef.current = ref
      }}
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
      eventHandlers={{
        // FeatureGroup 全体で 1 つの click ハンドラ。propagatedFrom に個別 layer が入る
        click: (e: L.LeafletMouseEvent & { propagatedFrom?: L.Layer }) => {
          const layer = e.propagatedFrom as L.Layer & {
            feature?: Feature<Polygon, ParcelFeatureProperties>
          }
          const feature = layer?.feature
          if (feature) openImportPopup(feature, e.latlng)
        },
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
