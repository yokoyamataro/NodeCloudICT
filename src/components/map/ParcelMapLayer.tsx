// サイトオーナーがマスターデータとしてアップロードした地番マップを
// CoordinateMap の背景レイヤとして重ねる。
//
// 動作方針 (Phase 2b):
//   * bbox (工区座標由来 / farm.parcel_map_bbox / ビューポート追従) と交差する
//     active dataset の GeoJSON だけを、必要になった時点でオンデマンド DL する。
//     全国 1700+ 市町村を溜めても、視野内の 5〜10 dataset しか読まない。
//   * 各 dataset の GeoJSON は dataset id 単位でメモリキャッシュ (再訪時に再 DL しない)
//   * 描画は cache に載っている dataset の feature を合体し、effectiveBbox でさらに
//     クライアント側フィルタしてから <GeoJSON> に渡す。Canvas レンダラで軽い。
//   * ポップアップは初回クリック時にだけ生成 (lazy)。tooltip (地番名) は
//     ズーム LABEL_MIN_ZOOM 以上に達したときに 1 度だけ全 layer に bind する。

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
   *  null の場合は地図の現在ビューポートに追従する。 */
  bbox: Bbox | null
  /** 取込済の "所在|地番" 複合キー集合。所在の異なる同名地番を別物として扱う */
  importedParcelKeys?: Set<string>
  /** 選択中の feature キー集合 (parcelFeatureKey で作る) */
  selectedKeys?: Set<string>
  /** 選択トグル (selectionMode=true で polygon クリック時、または popup ボタン) */
  onToggleSelect?: (feature: Feature<Polygon, ParcelFeatureProperties>) => void
  /** true のとき polygon クリック = 即トグル (popup 非表示)。
   *  false のとき polygon クリック = 属性情報の popup を開く (読み取り専用) */
  selectionMode?: boolean
}

/** 取込済判定用の複合キーを作る。所在と地番を "|" 区切りで結合。 */
function parcelImportKey(props: ParcelFeatureProperties): string {
  return `${props.location ?? ''}|${props.parcel_number}`
}

/** feature 個別のユニークキー。parcel_name + 第 1 頂点座標 で構成 */
export function parcelFeatureKey(
  f: Feature<Polygon, ParcelFeatureProperties>,
): string {
  const first = f.geometry.coordinates[0]?.[0]
  const label = f.properties.parcel_name || f.properties.parcel_number
  return `${label}|${first?.[0] ?? ''}|${first?.[1] ?? ''}`
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
const STYLE_SELECTED = {
  color: '#2563eb',
  weight: 1.5,
  fillColor: '#93c5fd',
  fillOpacity: 0.4,
}

/** このズーム以上でラベル表示 */
const LABEL_MIN_ZOOM = 17

/** Feature の geometry.outer が bbox と交差するか */
function featureIntersectsBbox(
  feature: Feature<Polygon, ParcelFeatureProperties>,
  bbox: Bbox,
): boolean {
  const outer = feature.geometry.coordinates[0] as Array<[number, number]>
  if (!outer || outer.length === 0) return false
  let minLng = Infinity
  let minLat = Infinity
  let maxLng = -Infinity
  let maxLat = -Infinity
  for (const p of outer) {
    const lng = p[0]
    const lat = p[1]
    if (lng < minLng) minLng = lng
    if (lat < minLat) minLat = lat
    if (lng > maxLng) maxLng = lng
    if (lat > maxLat) maxLat = lat
  }
  // AABB 交差判定
  return !(
    maxLng < bbox.minLng ||
    minLng > bbox.maxLng ||
    maxLat < bbox.minLat ||
    minLat > bbox.maxLat
  )
}

export function ParcelMapLayer({
  visible,
  bbox,
  importedParcelKeys,
  selectedKeys,
  onToggleSelect,
  selectionMode = false,
}: Props) {
  const map = useMap()
  const datasets = useParcelMapDatasetStore((s) => s.datasets)
  const cache = useParcelMapDatasetStore((s) => s.geoJsonCache)
  const ensureLoadedForBbox = useParcelMapDatasetStore(
    (s) => s.ensureLoadedForBbox,
  )
  const [viewportBbox, setViewportBbox] = useState<Bbox | null>(null)

  // bbox 未指定のときは、地図のビューポートを追跡してフィルタ範囲とする
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

  // 効いてる bbox に active な dataset のうち交差するものだけを、必要に応じて DL する。
  // dataset 一覧の active フラグや bbox が変わったら再評価される。
  useEffect(() => {
    if (!visible || !effectiveBbox) return
    void ensureLoadedForBbox(effectiveBbox)
  }, [visible, effectiveBbox, ensureLoadedForBbox, datasets])

  // bbox に交差する active dataset のうち、cache に載っているものの feature を合体
  const filteredFc = useMemo((): ParcelFeatureCollection | null => {
    if (!effectiveBbox) return null
    const features: ParcelFeatureCollection['features'] = []
    for (const d of datasets) {
      if (!d.active) continue
      const fc = cache[d.id]
      if (!fc) continue
      for (const f of fc.features) {
        if (featureIntersectsBbox(f, effectiveBbox)) features.push(f)
      }
    }
    if (features.length === 0) return null
    return { type: 'FeatureCollection', features }
  }, [datasets, cache, effectiveBbox])

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

  if (!visible || !filteredFc) return null

  return (
    <GeoJsonInner
      data={filteredFc}
      renderer={renderer}
      importedParcelKeys={importedParcelKeys}
      selectedKeys={selectedKeys}
      selectionMode={selectionMode}
      onToggleSelect={
        onToggleSelect
          ? (feature) => {
              onToggleSelect(feature)
              // 選択トグル後は Popup を閉じる (色が変わるので再クリックで最新状態)
              map.closePopup()
            }
          : undefined
      }
    />
  )
}

/** GeoJSON 描画本体。data 参照が変わると再マウントされ、地番名 tooltip は
 *  「一度でもズーム閾値以上に上がったら全 layer に bind」ワンショット方式。 */
function GeoJsonInner({
  data,
  renderer,
  importedParcelKeys,
  selectedKeys,
  onToggleSelect,
  selectionMode,
}: {
  data: ParcelFeatureCollection
  renderer: L.Renderer
  importedParcelKeys?: Set<string>
  selectedKeys?: Set<string>
  onToggleSelect?: (feature: Feature<Polygon, ParcelFeatureProperties>) => void
  selectionMode?: boolean
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

  // 選択 / 取込済セットが変わったら明示的に setStyle して再描画する
  // (<GeoJSON> の style prop は初回のみ評価されるため、選択切替時は手動更新が必要)
  useEffect(() => {
    const layerGroup = layerRef.current
    if (!layerGroup) return
    layerGroup.setStyle((feature) => {
      if (!feature) return { renderer, ...STYLE_DEFAULT }
      const f = feature as Feature<Polygon, ParcelFeatureProperties>
      const imported = !!importedParcelKeys?.has(parcelImportKey(f.properties))
      const selected = !!selectedKeys?.has(parcelFeatureKey(f))
      return {
        renderer,
        ...(imported
          ? STYLE_IMPORTED
          : selected
            ? STYLE_SELECTED
            : STYLE_DEFAULT),
      }
    })
  }, [selectedKeys, importedParcelKeys, renderer, data])

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
        // ラベルは 地番 のみ ("10-10" 等)。大字名は含めない
        const text =
          feature.properties.parcel_number || feature.properties.parcel_name
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
    const t = setTimeout(bindLabelsIfNeeded, 100)
    map.on('zoomend', bindLabelsIfNeeded)
    return () => {
      clearTimeout(t)
      map.off('zoomend', bindLabelsIfNeeded)
    }
  }, [map, data])

  // クリック時のポップアップ (lazy 生成)。
  // - selectionMode=false: 属性表示のみの読み取り popup を開く。取込済みなら緑バッジ
  // - selectionMode=true : popup を開かず、そのまま onToggleSelect が呼ばれる (別ハンドラ)
  const openInfoPopup = useCallback(
    (
      feature: Feature<Polygon, ParcelFeatureProperties>,
      latlng: L.LatLng,
    ) => {
      const props = feature.properties
      const isImported = !!importedParcelKeys?.has(parcelImportKey(props))
      const container = document.createElement('div')
      container.style.minWidth = '200px'
      container.innerHTML = `
        <div style="font-size:12px;line-height:1.4;">
          <div style="font-weight:600;font-size:13px;margin-bottom:4px;">
            地番 ${escapeHtml(props.parcel_number || '(不明)')}
          </div>
          ${
            props.location
              ? `<div>所在: ${escapeHtml(props.location)}</div>`
              : ''
          }
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
          ${
            isImported
              ? `<div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:#d1fae5;color:#065f46;font-size:12px;font-weight:600;text-align:center;">取込済み</div>`
              : `<div style="margin-top:6px;padding:6px 8px;border-radius:6px;background:#f1f5f9;color:#64748b;font-size:11px;text-align:center;">「地番データ取込」を押してから選択してください</div>`
          }
        </div>
      `
      L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(container).openOn(map)
    },
    [map, importedParcelKeys],
  )

  return (
    <GeoJSON
      key={key}
      ref={(ref: L.GeoJSON | null) => {
        layerRef.current = ref
      }}
      data={data}
      style={(feature) => {
        if (!feature) return { renderer, ...STYLE_DEFAULT }
        const f = feature as Feature<Polygon, ParcelFeatureProperties>
        const imported = !!importedParcelKeys?.has(parcelImportKey(f.properties))
        const selected = !!selectedKeys && selectedKeys.has(parcelFeatureKey(f))
        return {
          renderer,
          ...(imported
            ? STYLE_IMPORTED
            : selected
              ? STYLE_SELECTED
              : STYLE_DEFAULT),
        }
      }}
      eventHandlers={{
        click: (e: L.LeafletMouseEvent & { propagatedFrom?: L.Layer }) => {
          const layer = e.propagatedFrom as L.Layer & {
            feature?: Feature<Polygon, ParcelFeatureProperties>
          }
          const feature = layer?.feature
          if (!feature) return
          // 取込済みは常に情報表示 (誤って再選択しないように)
          const isImported = !!importedParcelKeys?.has(
            parcelImportKey(feature.properties),
          )
          if (selectionMode && !isImported && onToggleSelect) {
            // 選択モード: 即トグル (popup は開かない)
            onToggleSelect(feature)
          } else {
            // 通常モード or 取込済み: 情報表示 popup
            openInfoPopup(feature, e.latlng)
          }
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
