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

import { useMemo } from 'react'
import { CircleMarker, Polygon, Polyline, Tooltip } from 'react-leaflet'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'
import type { CoordinateConverter } from '@/lib/coordinates'
import { placeOutline, type Pt } from './floorPlanTypes'
import type { EN } from './floorPlanPlace'

export interface SiteRingForMap {
  parcelId: string
  label: string
  /** 平面直角座標 の 構成点 (X=北 / Y=東) */
  points: { id: string; pointNumber: string; x: number; y: number }[]
}

export function FloorPlanSiteMap({
  farmId,
  conv,
  rings,
  ring,
  outline,
  placed,
  offsetE,
  offsetN,
  rotationDeg,
  highlightEdge,
  highlightVertex,
  onEdgePick,
  onVertexPick,
}: {
  farmId: string | null
  conv: CoordinateConverter
  /** 選んだ 地番 ごと の 外形 (一覧 の 見出し 用) */
  rings: SiteRingForMap[]
  /** 配置 の 計算 に 使う 一続き の 敷地 (複数筆 を 繋いだ もの) */
  ring: EN[]
  outline: Pt[]
  placed: boolean
  offsetE: number
  offsetN: number
  rotationDeg: number
  /** 今 選んで いる 境界線 (ring の 辺 番号)。 複数 可 */
  highlightEdge: number[]
  /** 今 選んで いる 建物 の 角 (outline の 番号)。 複数 可 */
  highlightVertex: number[]
  /** 地図 上 の 境界線 を 押した */
  onEdgePick?: (edgeIndex: number) => void
  /** 地図 上 の 建物 の 角 を 押した */
  onVertexPick?: (vertexIndex: number) => void
}) {
  const ll = useMemo(() => (e: number, n: number) => conv.toLatLng(n, e), [conv])

  // 地番 の 外形 は CoordinateMap の 外部ポリゴン と して 渡す
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
    <CoordinateMap
      farmId={farmId}
      externalPolygons={polygons}
      showPolygonLabels
      showEdgeLengths
      edgeDigits={3}
      coordinatesInteractive={false}
    >
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

      {/* 据えた 建物 */}
      {building.length >= 3 && (
        <Polygon
          positions={building}
          pathOptions={{ color: '#1e293b', weight: 2, fillColor: '#334155', fillOpacity: 0.25 }}
          interactive={false}
        />
      )}

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
  )
}
