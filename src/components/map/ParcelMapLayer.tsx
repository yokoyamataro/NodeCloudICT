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
import { createPortal } from 'react-dom'
import { GeoJSON, useMap } from 'react-leaflet'
import type { Feature, Polygon } from 'geojson'
import L from 'leaflet'
import { Loader2 } from 'lucide-react'
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
  /** 地番名 (parcel_number) の常時ラベル表示を有効にするか。default: false。
   *  true でも zoom < LABEL_MIN_ZOOM の間は強制的に非表示 (描画コスト回避) */
  showLabels?: boolean
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
/** このズーム未満では地番レイヤ自体を描画しない (モバイル pan/pinch 対策)。
 *  zoom 14 未満だと 1 筆が 1px 以下になり、Canvas 描画コストだけかかって見えない。 */
const MIN_RENDER_ZOOM = 14
/** viewport 追跡のバッファ倍率 (0.5 = 上下左右に viewport の 50% 分拡張 = 総 2x エリア)。
 *  小さな pan では filteredFc が変わらないので <GeoJSON> の remount が起きない */
const VIEWPORT_BUFFER_FACTOR = 0.5
/** ラベル bind を分割するチャンクサイズ (1 フレームあたりの bindTooltip 呼び出し数)。
 *  一気に 100-500 個の bindTooltip を呼ぶと数百 ms 固まるので、フレームごとに
 *  少しずつ bind してユーザー操作をブロックしないようにする。 */
const LABEL_BIND_CHUNK = 30

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

/** outer が inner を完全に包含するか (viewport が buffered bbox 内に収まっているかの判定) */
function bboxContains(outer: Bbox, inner: Bbox): boolean {
  return (
    outer.minLng <= inner.minLng &&
    outer.minLat <= inner.minLat &&
    outer.maxLng >= inner.maxLng &&
    outer.maxLat >= inner.maxLat
  )
}

/** bbox を factor 倍 (各方向) 拡張 */
function expandBbox(b: Bbox, factor: number): Bbox {
  const dLng = (b.maxLng - b.minLng) * factor
  const dLat = (b.maxLat - b.minLat) * factor
  return {
    minLng: b.minLng - dLng,
    minLat: b.minLat - dLat,
    maxLng: b.maxLng + dLng,
    maxLat: b.maxLat + dLat,
  }
}

export function ParcelMapLayer({
  visible,
  bbox,
  importedParcelKeys,
  selectedKeys,
  onToggleSelect,
  selectionMode = false,
  showLabels = false,
}: Props) {
  const map = useMap()
  const datasets = useParcelMapDatasetStore((s) => s.datasets)
  const cache = useParcelMapDatasetStore((s) => s.geoJsonCache)
  const loadingIds = useParcelMapDatasetStore((s) => s.loadingIds)
  const ensureLoadedForBbox = useParcelMapDatasetStore(
    (s) => s.ensureLoadedForBbox,
  )
  const [viewportBbox, setViewportBbox] = useState<Bbox | null>(null)
  const [zoomHidden, setZoomHidden] = useState(
    () => map.getZoom() < MIN_RENDER_ZOOM,
  )

  // ズームが閾値未満の間は描画自体をスキップ (pinch-zoom がカクつく最大の原因)
  useEffect(() => {
    const update = () => setZoomHidden(map.getZoom() < MIN_RENDER_ZOOM)
    update()
    map.on('zoomend', update)
    return () => {
      map.off('zoomend', update)
    }
  }, [map])

  // bbox 未指定のときは、地図のビューポートを追跡してフィルタ範囲とする。
  // ただし viewport の 2x に拡張したバッファ bbox を保持しておき、
  // viewport がそのバッファ内に収まっている間は state を更新しない
  // (= filteredFc の再計算と <GeoJSON> の remount を抑制する)。
  useEffect(() => {
    if (!visible || zoomHidden) {
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
    setViewportBbox(expandBbox(readBounds(), VIEWPORT_BUFFER_FACTOR))
    let t: ReturnType<typeof setTimeout> | null = null
    const debounced = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        const view = readBounds()
        setViewportBbox((prev) => {
          // 既存バッファ内に viewport が完全に収まっているなら再計算しない
          if (prev && bboxContains(prev, view)) return prev
          return expandBbox(view, VIEWPORT_BUFFER_FACTOR)
        })
      }, 300)
    }
    map.on('moveend', debounced)
    return () => {
      if (t) clearTimeout(t)
      map.off('moveend', debounced)
    }
  }, [map, visible, bbox, zoomHidden])

  const effectiveBbox = bbox ?? viewportBbox

  // 効いてる bbox に active な dataset のうち交差するものだけを、必要に応じて DL する。
  // dataset 一覧の active フラグや bbox が変わったら再評価される。
  //
  // 100ms 遅延を入れて先に UI (「地番マップ読込中…」インジケータ等) を描画させる。
  // これで toggle 直後の 1 フレーム目でスピナが出てから DL / パースが始まる。
  useEffect(() => {
    if (!visible || !effectiveBbox) return
    const t = setTimeout(() => {
      void ensureLoadedForBbox(effectiveBbox)
    }, 100)
    return () => clearTimeout(t)
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

  // 実際に <GeoJsonInner> に流す data は 2 段階遅延で反映する。
  //   Phase 1: filteredFc 変化 → renderPending=true → indicator 描画
  //   Phase 2: 2 RAF 後 → displayFc に反映 → Leaflet がレイヤ生成 (同期ブロック)。
  //            renderPending はまだ true のまま (indicator は残ってる)。
  //   Phase 3: displayFc = filteredFc になった後、さらに 2 RAF 後 →
  //            renderPending=false → indicator 消える
  // これで Leaflet の重い commit 中も indicator が画面に残る。
  const [displayFc, setDisplayFc] =
    useState<ParcelFeatureCollection | null>(null)
  const [renderPending, setRenderPending] = useState(false)

  // Phase 1 + 2: filteredFc 変化 → 2 RAF 後に displayFc に反映
  useEffect(() => {
    if (!filteredFc) {
      setDisplayFc(null)
      setRenderPending(false)
      return
    }
    if (filteredFc === displayFc) return
    setRenderPending(true)
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setDisplayFc(filteredFc)
        // ここでは renderPending を落とさない。Phase 3 で処理する。
      })
    })
    return () => {
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [filteredFc, displayFc])

  // Phase 3: displayFc === filteredFc になった後、ブラウザが painted するまで
  // 待ってから renderPending を落とす。
  useEffect(() => {
    if (!renderPending) return
    if (displayFc !== filteredFc) return
    let raf1 = 0
    let raf2 = 0
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        setRenderPending(false)
      })
    })
    return () => {
      if (raf1) cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [displayFc, filteredFc, renderPending])

  // Canvas レンダラ
  const renderer = useMemo(() => L.canvas({ padding: 0.2 }), [])

  // ズームで地番名ラベルの表示クラスを切替。
  // showLabels=false のときは常に非表示。true でも zoom < LABEL_MIN_ZOOM は強制非表示。
  useEffect(() => {
    const container = map.getContainer()
    const update = () => {
      if (!visible || !showLabels) {
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
  }, [map, visible, showLabels])

  // 地番名ラベルのバインド進捗 ({done, total} または null)。バインド中は
  // インジケータを「地番名 X/Y 適用中…」表示にする。
  const [labelBindProgress, setLabelBindProgress] = useState<{
    done: number
    total: number
  } | null>(null)

  // 「地番マップ読込中…」インジケータ。dataset の DL 中 or Leaflet レイヤの
  // 差替え待ち (renderPending) 中 or 地番名バインド中に、地図右上に固定表示する。
  // 地図操作は塞がない (pointer-events-none)。
  const showLoadingIndicator =
    visible &&
    !zoomHidden &&
    (loadingIds.size > 0 || renderPending || labelBindProgress != null)
  const indicatorLabel = (() => {
    if (loadingIds.size > 0) return `地番マップ読込中… (${loadingIds.size})`
    if (labelBindProgress) {
      return `地番名 適用中… ${labelBindProgress.done.toLocaleString()}/${labelBindProgress.total.toLocaleString()}`
    }
    return '地番マップを描画中…'
  })()
  const indicator = showLoadingIndicator
    ? createPortal(
        <div
          className="absolute top-2 right-2 z-[1200] bg-white/95 border border-slate-300 rounded shadow px-2 py-1 text-xs flex items-center gap-1.5 pointer-events-none"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-600" />
          <span className="text-slate-700">{indicatorLabel}</span>
        </div>,
        map.getContainer(),
      )
    : null

  if (!visible || zoomHidden || !displayFc) {
    return <>{indicator}</>
  }

  return (
    <>
      {indicator}
      <GeoJsonInner
        data={displayFc}
        renderer={renderer}
        importedParcelKeys={importedParcelKeys}
        selectedKeys={selectedKeys}
        selectionMode={selectionMode}
        showLabels={showLabels}
        onLabelBindProgress={setLabelBindProgress}
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
    </>
  )
}

/** GeoJSON 描画本体。data 参照が変わると再マウントされ、地番名 tooltip は
 *  「showLabels=true かつ zoom >= LABEL_MIN_ZOOM に達したら全 layer に bind」方式。
 *  showLabels=false の間は tooltip 自体を作らないので、pan/pinch のレンダーコストが
 *  地番数×パーマネントラベル分だけ削れる。 */
function GeoJsonInner({
  data,
  renderer,
  importedParcelKeys,
  selectedKeys,
  onToggleSelect,
  selectionMode,
  showLabels,
  onLabelBindProgress,
}: {
  data: ParcelFeatureCollection
  renderer: L.Renderer
  importedParcelKeys?: Set<string>
  selectedKeys?: Set<string>
  onToggleSelect?: (feature: Feature<Polygon, ParcelFeatureProperties>) => void
  selectionMode?: boolean
  showLabels: boolean
  onLabelBindProgress?: (
    progress: { done: number; total: number } | null,
  ) => void
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

  // showLabels=true かつ zoom >= LABEL_MIN_ZOOM のときのみ tooltip を bind する。
  // 100〜500 個の bindTooltip を一気に呼ぶと数百 ms 固まるので、1 フレーム
  // あたり LABEL_BIND_CHUNK 個ずつ requestAnimationFrame で分割 bind する。
  // 途中で ON→OFF に切り替わったり feature が変わったら cancel。
  useEffect(() => {
    let cancelled = false
    let scheduledRaf = 0
    const unbindAllLabels = () => {
      const layerGroup = layerRef.current
      if (!layerGroup) return
      layerGroup.eachLayer((layer) => {
        ;(layer as L.Layer).unbindTooltip()
      })
      labelsBoundRef.current = false
    }
    if (!showLabels) {
      unbindAllLabels()
      onLabelBindProgress?.(null)
      return
    }
    const bindLabelsIfNeeded = () => {
      if (cancelled || labelsBoundRef.current) return
      const layerGroup = layerRef.current
      if (!layerGroup) return
      if (map.getZoom() < LABEL_MIN_ZOOM) return

      // bind 対象を先に列挙 (Leaflet の内部イテレータを回すので同期でも軽い)
      const targets: Array<{ layer: L.Layer; text: string }> = []
      layerGroup.eachLayer((layer) => {
        const feature = (layer as L.GeoJSON & { feature?: unknown }).feature as
          | Feature<Polygon, ParcelFeatureProperties>
          | undefined
        if (!feature) return
        // ラベルは 地番 のみ ("10-10" 等)。大字名は含めない
        const text =
          feature.properties.parcel_number || feature.properties.parcel_name
        if (text) targets.push({ layer, text })
      })

      if (targets.length === 0) {
        labelsBoundRef.current = true
        return
      }

      let idx = 0
      onLabelBindProgress?.({ done: 0, total: targets.length })
      const bindChunk = () => {
        if (cancelled) return
        const end = Math.min(idx + LABEL_BIND_CHUNK, targets.length)
        for (let i = idx; i < end; i++) {
          targets[i].layer.bindTooltip(targets[i].text, {
            permanent: true,
            direction: 'center',
            className: 'parcel-map-label',
            opacity: 1,
          })
        }
        idx = end
        onLabelBindProgress?.({ done: idx, total: targets.length })
        if (idx < targets.length) {
          scheduledRaf = requestAnimationFrame(bindChunk)
        } else {
          labelsBoundRef.current = true
          onLabelBindProgress?.(null)
        }
      }
      scheduledRaf = requestAnimationFrame(bindChunk)
    }
    const t = setTimeout(bindLabelsIfNeeded, 100)
    map.on('zoomend', bindLabelsIfNeeded)
    return () => {
      cancelled = true
      if (scheduledRaf) cancelAnimationFrame(scheduledRaf)
      clearTimeout(t)
      map.off('zoomend', bindLabelsIfNeeded)
      unbindAllLabels()
      onLabelBindProgress?.(null)
    }
  }, [map, data, showLabels, onLabelBindProgress])

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
