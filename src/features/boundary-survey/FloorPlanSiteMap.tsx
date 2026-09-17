// 配置 の 地図。
//
// 座標一覧 と 同じ GIS 地図 (CoordinateMap) を 下敷き に する ので、法務省地図
// も 測点 も オルソ も そのまま 出る。 その 上 に
//   * 選んだ 地番 の 外形 (複数筆 に またがる こと が ある)
//   * 選んで いる 境界線 と 建物 の 角
//   * 据えた 建物 の 外形
// を 重ねる。
//
// 建物 は 平面直角座標 で 計算 して いる ので、描く 直前 に 緯度経度 へ 直す。

import { useEffect, useMemo, useReducer } from 'react'
import L from 'leaflet'
import { CircleMarker, Marker, Polygon, Polyline, Tooltip, useMap, useMapEvents } from 'react-leaflet'
import { Map as MapIcon } from 'lucide-react'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import { ParcelBatchImportBar } from '@/features/parcel-maps/ParcelBatchImportBar'
import { useParcelImportSelection } from '@/features/parcel-maps/useParcelImportSelection'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import type { CoordinateConverter } from '@/lib/coordinates'
import { placeOutline, type Pt } from './floorPlanTypes'
import type { EN } from './floorPlanPlace'

const escapeHtml = (t: string) =>
  t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * 寸法 の 文字。 白地 の 吹き出し では なく 文字 だけ を 置き、
 * その 線 の 向き に 合わせて 傾ける。
 *
 * 傾き は 画面 上 の 角度 な ので、地図 の 縮尺 や 回転 で 変わる。
 * 動く たび に 描き直す 必要 が ある。
 */
function GuideLabel({
  from,
  to,
  text,
}: {
  from: [number, number]
  to: [number, number]
  text: string
}) {
  const map = useMap()
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  useMapEvents({ zoom: redraw, move: redraw, viewreset: redraw })
  // 回転 (leaflet-rotate) は 型 に 無い ので 直 に 繋ぐ
  useEffect(() => {
    map.on('rotate', redraw)
    return () => {
      map.off('rotate', redraw)
    }
  }, [map])

  const a = map.latLngToContainerPoint(from)
  const b = map.latLngToContainerPoint(to)
  let deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  // 逆さま に ならない ように
  if (deg > 90 || deg < -90) deg += 180

  const mid: [number, number] = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2]
  const icon = L.divIcon({
    className: 'fp-guide-icon',
    iconSize: [0, 0],
    html:
      `<span class="fp-guide-rot" style="transform:translate(-50%,-50%) rotate(${deg}deg)">` +
      `<span class="fp-guide-text">${escapeHtml(text)}</span></span>`,
  })
  return <Marker position={mid} icon={icon} interactive={false} />
}

export interface SiteRingForMap {
  parcelId: string
  label: string
  /** 平面直角座標 の 構成点 (X=北 / Y=東) */
  points: { id: string; pointNumber: string; x: number; y: number }[]
}

export function FloorPlanSiteMap({
  farmId,
  zone,
  conv,
  rings,
  chosenParcelIds,
  onToggleParcelId,
  ring,
  outline,
  placed,
  offsetE,
  offsetN,
  rotationDeg,
  others,
  highlightEdge,
  highlightVertex,
  highlightBuildingEdge,
  guides,
  preview = false,
  onEdgePick,
  onVertexPick,
  onBuildingEdgePick,
  onEdgePointPick,
  pointPickEdge,
}: {
  farmId: string | null
  /** 平面直角 の 系番号。 地番 の 取込 に 使う */
  zone: number
  conv: CoordinateConverter
  /** 工区 の 地番 すべて。 地図 から 敷地 を 選べる ように 全部 描く */
  rings: SiteRingForMap[]
  /** その うち 敷地 と して 選んで いる もの */
  chosenParcelIds: string[]
  /** 地図 の 地番 を 押した (敷地 の 付け外し) */
  onToggleParcelId?: (parcelId: string) => void
  /** 配置 の 計算 に 使う 一続き の 敷地 (複数筆 を 繋いだ もの) */
  ring: EN[]
  /** 今 据えて いる 棟 の 外形 */
  outline: Pt[]
  placed: boolean
  offsetE: number
  offsetN: number
  rotationDeg: number
  /** 他 の 棟 (附属建物 など)。 据え済み の もの を 薄く 描く */
  others?: { id: string; label: string; pts: { e: number; n: number }[] }[]
  /** 今 選んで いる 境界線 (ring の 辺 番号)。 複数 可 */
  highlightEdge: number[]
  /** 今 選んで いる 建物 の 角 (outline の 番号)。 複数 可 */
  highlightVertex: number[]
  /** 今 選んで いる 建物 の 辺 (1辺平行 で 使う) */
  highlightBuildingEdge?: number | null
  /** 入力中 の 寸法 を 図 に 出す ため の 線 */
  guides?: { id: string; from: EN; to: EN; label: string }[]
  /** 確定 前 の 仮 の 配置。 破線 で 描く */
  preview?: boolean
  /**
   * 地図 の 地番 を 押した (敷地 の 付け外し)。
   * 未指定 の 間 は 押しても 何も 起きない。 選択中 だけ 渡す。
   */
  /** 地図 上 の 境界線 を 押した */
  onEdgePick?: (edgeIndex: number) => void
  /** 地図 上 の 建物 の 角 を 押した */
  onVertexPick?: (vertexIndex: number) => void
  /** 地図 上 の 建物 の 辺 を 押した */
  onBuildingEdgePick?: (edgeIndex: number) => void
  /** 建物 の 辺 の 上 の 一点 を 押した。 t は 辺 の 始点 から の 割合 */
  onEdgePointPick?: (edgeIndex: number, t: number) => void
  /** 点 を 拾う 対象 の 辺 (これ だけ 押せる ように する) */
  pointPickEdge?: number | null
}) {
  const ll = useMemo(() => (e: number, n: number) => conv.toLatLng(n, e), [conv])

  // ---- 法務省地図 (地番管理 と 同じ 背景 レイヤ) ----
  const datasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  useEffect(() => {
    void fetchDatasets()
  }, [fetchDatasets])
  const hasDataset = datasets.some((d) => d.active)
  const showParcelMap = useMapViewStore((s) => s.showParcelMap)
  const setShowParcelMap = useMapViewStore((s) => s.setShowParcelMap)

  // 取込済 の 色分け 用。 キー は 「所在|地番」
  const parcelsByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)
  const workAreas = useWorkAreaStore((s) => s.workAreas)
  const importedParcelKeys = useMemo(() => {
    const set = new Set<string>()
    for (const p of parcelsByWorkAreaId.values()) {
      if (p.parcel_number) set.add(`${p.location ?? ''}|${p.parcel_number}`)
    }
    // parcels 未作成 の 地番 は 工事区域 の 名前 で 補う
    for (const a of workAreas['boundary_survey'] ?? []) {
      if (a.name) set.add(`|${a.name}`)
      if (a.zoneNumber && a.zoneNumber !== a.name) set.add(`|${a.zoneNumber}`)
    }
    return set
  }, [parcelsByWorkAreaId, workAreas])

  // 地番 の 取込 (地番管理 と 同じ 共通フック)
  const selection = useParcelImportSelection({ resetTrigger: showParcelMap })

  // 地番 の 外形 は CoordinateMap の 外部ポリゴン と して 渡す。
  // 選んで いない 地番 も 描いて おき、地図 から 敷地 を 選べる ように する。
  const polygons: ExternalPolygon[] = useMemo(
    () =>
      rings
        .filter((r) => r.points.length >= 3)
        .map((r) => ({
          id: `fp-${r.parcelId}`,
          name: r.label,
          positions: r.points.map((p) => {
            const c = conv.toLatLng(p.x, p.y)
            return [c.lat, c.lng] as [number, number]
          }),
          pointIds: r.points.map((p) => p.id),
        })),
    [rings, conv],
  )

  // 選んで いる 地番 は 橙 で 塗る (CoordinateMap の 複数選択 の 見た目)
  const checkedPolygonIds = useMemo(
    () => new Set(chosenParcelIds.map((id) => `fp-${id}`)),
    [chosenParcelIds],
  )

  // 敷地 の 辺 (配置 の 基準 に 使う 通し番号)
  const edges = useMemo(() => {
    if (ring.length < 2) return []
    return ring.map((a, i) => {
      const b = ring[(i + 1) % ring.length]
      const p = ll(a.e, a.n)
      const q = ll(b.e, b.n)
      return {
        index: i,
        positions: [
          [p.lat, p.lng],
          [q.lat, q.lng],
        ] as [number, number][],
      }
    })
  }, [ring, ll])

  // 据えた 建物
  const building = useMemo(() => {
    if (!placed || outline.length < 3) return []
    return placeOutline(outline, offsetE, offsetN, rotationDeg).map((p) => {
      const c = ll(p.e, p.n)
      return [c.lat, c.lng] as [number, number]
    })
  }, [placed, outline, offsetE, offsetN, rotationDeg, ll])

  const edgeOn = useMemo(() => new Set(highlightEdge), [highlightEdge])
  const vertexOn = useMemo(() => new Set(highlightVertex), [highlightVertex])

  return (
    <div className="relative w-full h-full">
      <CoordinateMap
        farmId={farmId}
        externalPolygons={polygons}
        checkedExternalPolygonIds={checkedPolygonIds}
        onPolygonSelect={
          onToggleParcelId
            ? (id: string) => onToggleParcelId(id.replace(/^fp-/, ''))
            : undefined
        }
        showPolygonLabels
        showEdgeLengths
        edgeDigits={3}
        coordinatesInteractive={false}
      >
      {hasDataset && showParcelMap && (
        <ParcelMapLayer
          visible
          bbox={null}
          importedParcelKeys={importedParcelKeys}
          selectedKeys={selection.selectedKeys}
          onToggleSelect={selection.toggleSelect}
          selectionMode={selection.selectionMode}
        />
      )}
      {/* 敷地 の 辺。 選んで いる もの は 太く 色 を 変える */}
      {edges.map((e) => (
        <Polyline
          key={`edge-${e.index}`}
          positions={e.positions}
          pathOptions={{
            color: edgeOn.has(e.index) ? '#f97316' : '#0ea5e9',
            weight: edgeOn.has(e.index) ? 6 : 3,
            opacity: edgeOn.has(e.index) ? 0.95 : 0.35,
          }}
          eventHandlers={onEdgePick ? { click: () => onEdgePick(e.index) } : undefined}
        >
          <Tooltip sticky>境界線 {e.index + 1}</Tooltip>
        </Polyline>
      ))}

      {/* 据えた 建物。 確定 前 は 破線 */}
      {building.length >= 3 && (
        <Polygon
          positions={building}
          pathOptions={{
            color: preview ? '#2563eb' : '#1e293b',
            weight: 2,
            dashArray: preview ? '6 4' : undefined,
            fillColor: preview ? '#3b82f6' : '#334155',
            fillOpacity: preview ? 0.15 : 0.25,
          }}
          interactive={false}
        />
      )}

      {/* 他 の 棟 */}
      {(others ?? []).map((o) => {
        const poly = o.pts.map((p) => {
          const c = ll(p.e, p.n)
          return [c.lat, c.lng] as [number, number]
        })
        if (poly.length < 3) return null
        return (
          <Polygon
            key={o.id}
            positions={poly}
            pathOptions={{
              color: '#64748b',
              weight: 1.5,
              fillColor: '#94a3b8',
              fillOpacity: 0.18,
            }}
            interactive={false}
          >
            <Tooltip direction="center">{o.label}</Tooltip>
          </Polygon>
        )
      })}

      {/* 辺 の 上 の 点 を 拾う */}
      {onEdgePointPick != null &&
        pointPickEdge != null &&
        building.length >= 2 &&
        (() => {
          const a = building[pointPickEdge % building.length]
          const b = building[(pointPickEdge + 1) % building.length]
          if (!a || !b) return null
          return (
            <Polyline
              positions={[a, b]}
              pathOptions={{ color: '#2563eb', weight: 12, opacity: 0.35 }}
              eventHandlers={{
                click: (ev) => {
                  // 押した 場所 を 辺 に 落として 割合 を 出す
                  const p = ev.latlng
                  const ax = a[1]
                  const ay = a[0]
                  const bx = b[1]
                  const by = b[0]
                  const dx = bx - ax
                  const dy = by - ay
                  const L2 = dx * dx + dy * dy
                  let t = L2 < 1e-18 ? 0 : ((p.lng - ax) * dx + (p.lat - ay) * dy) / L2
                  t = Math.min(1, Math.max(0, t))
                  // 端 の 近く は 端部 に 吸い付かせる
                  if (t < 0.06) t = 0
                  else if (t > 0.94) t = 1
                  onEdgePointPick(pointPickEdge, Math.round(t * 1000) / 1000)
                },
              }}
            >
              <Tooltip sticky>辺の上を押す（端は端部に吸着）</Tooltip>
            </Polyline>
          )
        })()}

      {/* 建物 の 辺。 押して 選べる ように する */}
      {onBuildingEdgePick != null &&
        building.length >= 2 &&
        building.map((_, i) => {
          const on = highlightBuildingEdge === i
          return (
            <Polyline
              key={`be-${i}`}
              positions={[building[i], building[(i + 1) % building.length]]}
              pathOptions={{
                color: on ? '#f97316' : '#2563eb',
                weight: on ? 6 : 8,
                opacity: on ? 0.95 : 0.001, // 押せる 幅 だけ 残して 透明 に
              }}
              eventHandlers={{ click: () => onBuildingEdgePick(i) }}
            >
              <Tooltip sticky>建物の辺 {i + 1}</Tooltip>
            </Polyline>
          )
        })}
      {onBuildingEdgePick == null && highlightBuildingEdge != null && building.length >= 2 && (
        <Polyline
          positions={[
            building[highlightBuildingEdge % building.length],
            building[(highlightBuildingEdge + 1) % building.length],
          ]}
          pathOptions={{ color: '#f97316', weight: 6, opacity: 0.95 }}
          interactive={false}
        />
      )}

      {/* 入力中 の 寸法。 文字 は 線 に 沿わせる */}
      {(guides ?? []).map((g) => {
        const a = ll(g.from.e, g.from.n)
        const b = ll(g.to.e, g.to.n)
        const from: [number, number] = [a.lat, a.lng]
        const to: [number, number] = [b.lat, b.lng]
        return (
          <g key={g.id}>
            <Polyline
              positions={[from, to]}
              pathOptions={{ color: '#7c3aed', weight: 2, dashArray: '4 3' }}
              interactive={false}
            />
            <GuideLabel from={from} to={to} text={g.label} />
          </g>
        )
      })}

      {/* 建物 の 角。 配置前 は 位置 が 決まって いない ので 出さない */}
      {placed &&
        outline.map((p, i) => {
          const q = placeOutline([p], offsetE, offsetN, rotationDeg)[0]
          const c = ll(q.e, q.n)
          const on = vertexOn.has(i)
          return (
            <CircleMarker
              key={`v-${i}`}
              center={[c.lat, c.lng]}
              radius={on ? 8 : 5}
              pathOptions={{
                color: on ? '#f97316' : '#1e293b',
                weight: on ? 3 : 1.5,
                fillColor: on ? '#fb923c' : '#ffffff',
                fillOpacity: 1,
              }}
              eventHandlers={onVertexPick ? { click: () => onVertexPick(i) } : undefined}
            >
              <Tooltip direction="top">角 {i + 1}</Tooltip>
            </CircleMarker>
          )
        })}
      </CoordinateMap>

      {/* 地図左下: 法務省地図 の 切替 と 地番 の 取込 (地番管理 と 同じ 並び) */}
      {hasDataset && (
        <div className="absolute bottom-6 left-2 z-[1000] flex flex-col items-start gap-2">
          {showParcelMap && (
            <ParcelBatchImportBar farmId={farmId} zone={zone} selection={selection} />
          )}
          <button
            type="button"
            onClick={() => setShowParcelMap(!showParcelMap)}
            className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded border shadow ${
              showParcelMap
                ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
                : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
            }`}
            title="法務省地図データを背景に表示する"
          >
            <MapIcon className="h-4 w-4" />
            法務省地図
          </button>
        </div>
      )}

      {selection.message && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1100] px-3 py-1.5 rounded bg-slate-800/90 text-white text-xs shadow">
          {selection.message}
        </div>
      )}
    </div>
  )
}
