import { useEffect } from 'react'
import { MapContainer, TileLayer, Polygon, Polyline, CircleMarker, Marker, useMap, useMapEvents, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

export interface StripLabel {
  position: [number, number]
  text: string
  variant?: 'confirmed' | 'current'
}

function makeLabelIcon(text: string, variant: 'confirmed' | 'current'): L.DivIcon {
  const bg = variant === 'current' ? '#faf5ff' : '#ffffff'
  const border = variant === 'current' ? '#7c3aed' : '#a855f7'
  return L.divIcon({
    className: 'strip-label',
    html: `<div style="background:${bg};padding:2px 6px;border:1px solid ${border};border-radius:3px;font-size:11px;white-space:nowrap;color:#1e293b;box-shadow:0 1px 2px rgba(0,0,0,0.15);transform:translate(-50%,-50%);pointer-events:none;">${text}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

export type StripPlanBaseLayer = 'osm' | 'gsi-photo' | 'gsi-std'

export interface StripPlanMapProps {
  // 工事区域ポリゴン（lat, lng のペア配列）
  areaPolygon: [number, number][]
  // 基線（指定済み点を順に：0,1,2 個）
  baseline: [number, number][]
  // 軸（クリップ後）— 枝状パターンで表示
  axisLines?: [number, number][][]
  // 平行線
  parallelLines?: [number, number][][]
  // 垂直線
  perpLines?: [number, number][][]
  // フリー描画の確定済みライン
  freeLines?: [number, number][][]
  // フリー描画の入力途中ライン（点列）
  freeCurrent?: [number, number][]
  // プレビューセグメント（フリー描画中の直前点→ホバー位置）
  previewSegment?: [[number, number], [number, number]]
  // 帯ポリゴン（幅 WB の塗りつぶし表現）— 各カテゴリごと、各ポリゴンは [lat, lng] の頂点列
  axisBuffers?: [number, number][][]
  parallelBuffers?: [number, number][][]
  perpBuffers?: [number, number][][]
  freeBuffers?: [number, number][][] // 確定済みのフリー線
  freeCurrentBuffer?: [number, number][] | null // 入力途中（プレビュー含む）
  // 仮表示（確定前の平行コピー候補）
  provisionalLines?: [number, number][][]
  provisionalBuffers?: [number, number][][]
  freeLabels?: StripLabel[]
  freeCurrentLabel?: StripLabel | null
  selectedFreeIdx?: number | null
  onSelectFreeLine?: (idx: number | null) => void
  onFinishCurrentLine?: () => void
  // 編集アクションの可視化
  perpAnchor?: [number, number] | null
  actionPreview?: [[number, number], [number, number]] | null
  // 背景レイヤ
  baseLayer?: StripPlanBaseLayer
  // 地図クリックで点を追加するモード
  pickMode: boolean
  onMapClick?: (latLng: [number, number]) => void
  // ホバー位置（lat/lng）を親に通知
  onMouseMove?: (latLng: [number, number] | null) => void
}

function ClickCapture({
  enabled,
  onClick,
  onMouseMove,
}: {
  enabled: boolean
  onClick?: (ll: [number, number]) => void
  onMouseMove?: (ll: [number, number] | null) => void
}) {
  useMapEvents({
    click: (e) => {
      if (!enabled || !onClick) return
      onClick([e.latlng.lat, e.latlng.lng])
    },
    mousemove: (e) => {
      if (!enabled || !onMouseMove) return
      onMouseMove([e.latlng.lat, e.latlng.lng])
    },
    mouseout: () => {
      if (!enabled || !onMouseMove) return
      onMouseMove(null)
    },
  })
  return null
}

function FitToPolygon({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  useEffect(() => {
    if (positions.length < 2) return
    const bounds = L.latLngBounds(positions.map(([lat, lng]) => [lat, lng] as [number, number]))
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 })
  }, [positions, map])
  return null
}

export function StripPlanMap({
  areaPolygon,
  baseline,
  axisLines = [],
  parallelLines = [],
  perpLines = [],
  freeLines = [],
  freeCurrent = [],
  previewSegment,
  axisBuffers = [],
  parallelBuffers = [],
  perpBuffers = [],
  freeBuffers = [],
  freeCurrentBuffer = null,
  provisionalLines = [],
  provisionalBuffers = [],
  freeLabels = [],
  freeCurrentLabel = null,
  selectedFreeIdx = null,
  onSelectFreeLine,
  onFinishCurrentLine,
  perpAnchor = null,
  actionPreview = null,
  baseLayer = 'gsi-photo',
  pickMode,
  onMapClick,
  onMouseMove,
}: StripPlanMapProps) {
  const initialCenter: [number, number] =
    areaPolygon.length > 0 ? areaPolygon[0] : [35.6762, 139.6503]

  return (
    <MapContainer
      center={initialCenter}
      zoom={17}
      maxZoom={22}
      className="h-full w-full"
      style={{
        minHeight: '400px',
        cursor: pickMode ? 'crosshair' : '',
      }}
    >
      {baseLayer === 'osm' && (
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={22}
          maxNativeZoom={19}
        />
      )}
      {baseLayer === 'gsi-photo' && (
        <TileLayer
          attribution='&copy; 国土地理院'
          url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
          maxZoom={22}
          maxNativeZoom={18}
        />
      )}
      {baseLayer === 'gsi-std' && (
        <TileLayer
          attribution='&copy; 国土地理院'
          url="https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"
          maxZoom={22}
          maxNativeZoom={18}
        />
      )}

      <ClickCapture enabled={pickMode} onClick={onMapClick} onMouseMove={onMouseMove} />
      {areaPolygon.length >= 3 && <FitToPolygon positions={areaPolygon} />}

      {/* 工事区域 */}
      {areaPolygon.length >= 3 && (
        <Polygon
          positions={areaPolygon}
          pathOptions={{
            color: '#f59e0b',
            fillColor: '#f59e0b',
            fillOpacity: 0.12,
            weight: 2,
          }}
        />
      )}

      {/* 帯ポリゴン（幅 WB） */}
      {parallelBuffers.map((poly, i) => (
        <Polygon key={`par-buf-${i}`} positions={poly}
          pathOptions={{ color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.25, weight: 1 }} />
      ))}
      {perpBuffers.map((poly, i) => (
        <Polygon key={`perp-buf-${i}`} positions={poly}
          pathOptions={{ color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, weight: 1 }} />
      ))}
      {axisBuffers.map((poly, i) => (
        <Polygon key={`axis-buf-${i}`} positions={poly}
          pathOptions={{ color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.25, weight: 1 }} />
      ))}
      {freeBuffers.map((poly, i) => {
        const selected = selectedFreeIdx === i
        return (
          <Polygon
            key={`free-buf-${i}`}
            positions={poly}
            pathOptions={{
              color: selected ? '#7c3aed' : '#a855f7',
              fillColor: '#a855f7',
              fillOpacity: selected ? 0.5 : 0.25,
              weight: selected ? 3 : 1,
              interactive: !!onSelectFreeLine,
            }}
            eventHandlers={onSelectFreeLine ? {
              click: (e) => {
                L.DomEvent.stopPropagation(e.originalEvent)
                onSelectFreeLine(selected ? null : i)
              },
            } : undefined}
          />
        )
      })}
      {freeCurrentBuffer && (
        <Polygon
          positions={freeCurrentBuffer}
          pathOptions={{
            color: '#a855f7',
            fillColor: '#a855f7',
            fillOpacity: 0.18,
            weight: 1,
            dashArray: '4,4',
          }}
        />
      )}

      {/* 仮表示（平行コピーの確定前候補） */}
      {provisionalBuffers.map((poly, i) => (
        <Polygon
          key={`prov-buf-${i}`}
          positions={poly}
          pathOptions={{
            color: '#eab308',
            fillColor: '#eab308',
            fillOpacity: 0.25,
            weight: 2,
            dashArray: '6,3',
            interactive: false,
          }}
        />
      ))}
      {provisionalLines.map((line, i) => (
        <Polyline
          key={`prov-line-${i}`}
          positions={line}
          pathOptions={{ color: '#ca8a04', weight: 2, dashArray: '4,4', interactive: false }}
        />
      ))}

      {/* 平行線 */}
      {parallelLines.map((line, i) => (
        <Polyline
          key={`par-${i}`}
          positions={line}
          pathOptions={{ color: '#3b82f6', weight: 2 }}
        />
      ))}

      {/* 垂直線 */}
      {perpLines.map((line, i) => (
        <Polyline
          key={`perp-${i}`}
          positions={line}
          pathOptions={{ color: '#10b981', weight: 2 }}
        />
      ))}

      {/* 軸（枝状パターン） */}
      {axisLines.map((line, i) => (
        <Polyline
          key={`axis-${i}`}
          positions={line}
          pathOptions={{ color: '#dc2626', weight: 3 }}
        />
      ))}

      {/* フリー描画：確定済み */}
      {freeLines.map((line, i) => (
        <Polyline
          key={`free-${i}`}
          positions={line}
          pathOptions={{ color: '#a855f7', weight: 3 }}
        />
      ))}

      {/* フリー描画：入力途中 */}
      {freeCurrent.length >= 2 && (
        <Polyline
          positions={freeCurrent}
          pathOptions={{ color: '#a855f7', weight: 3 }}
        />
      )}
      {freeCurrent.map((pt, i) => {
        const isLast = i === freeCurrent.length - 1 && freeCurrent.length >= 2
        return (
          <CircleMarker
            key={`fc-${i}`}
            center={pt}
            radius={isLast ? 7 : 4}
            pathOptions={{
              color: isLast ? '#7c3aed' : '#a855f7',
              fillColor: '#fff',
              fillOpacity: 1,
              weight: isLast ? 3 : 2,
            }}
            eventHandlers={isLast && onFinishCurrentLine ? {
              click: (e) => {
                L.DomEvent.stopPropagation(e.originalEvent)
                onFinishCurrentLine()
              },
            } : undefined}
          >
            {isLast && (
              <Tooltip direction="top" offset={[0, -8]} opacity={0.9}>
                クリック / Enter で確定
              </Tooltip>
            )}
          </CircleMarker>
        )
      })}

      {/* マウス追従プレビュー：直前点 → 現在位置 */}
      {previewSegment && (
        <Polyline
          positions={previewSegment}
          pathOptions={{ color: '#a855f7', weight: 2, dashArray: '6,4', opacity: 0.7 }}
        />
      )}

      {/* 基線（クリック点を結ぶ） */}
      {baseline.length >= 2 && (
        <Polyline
          positions={baseline.slice(0, 2)}
          pathOptions={{ color: '#dc2626', weight: 3, dashArray: '6,4' }}
        />
      )}
      {baseline.map((pt, i) => (
        <CircleMarker
          key={`bp-${i}`}
          center={pt}
          radius={6}
          pathOptions={{ color: '#dc2626', fillColor: '#fff', fillOpacity: 1, weight: 2 }}
        >
          <Tooltip permanent direction="top" offset={[0, -6]}>
            P{i + 1}
          </Tooltip>
        </CircleMarker>
      ))}

      {/* 編集アクション：基準点（垂線作成の 1 点目） */}
      {perpAnchor && (
        <CircleMarker
          center={perpAnchor}
          radius={6}
          pathOptions={{ color: '#f59e0b', fillColor: '#fff', fillOpacity: 1, weight: 3 }}
        >
          <Tooltip permanent direction="top" offset={[0, -6]}>
            基準点
          </Tooltip>
        </CircleMarker>
      )}
      {actionPreview && (
        <Polyline
          positions={actionPreview}
          pathOptions={{ color: '#f59e0b', weight: 3, dashArray: '6,4', opacity: 0.85 }}
        />
      )}

      {/* 帯ラベル（番号・延長・台数） */}
      {freeLabels.map((lbl, i) => (
        <Marker
          key={`fl-${i}`}
          position={lbl.position}
          icon={makeLabelIcon(lbl.text, lbl.variant ?? 'confirmed')}
          interactive={false}
        />
      ))}
      {freeCurrentLabel && (
        <Marker
          position={freeCurrentLabel.position}
          icon={makeLabelIcon(freeCurrentLabel.text, 'current')}
          interactive={false}
        />
      )}
    </MapContainer>
  )
}
