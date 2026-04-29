import { useEffect } from 'react'
import { MapContainer, TileLayer, Polygon, Polyline, CircleMarker, useMap, useMapEvents, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

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
  // 背景レイヤ
  baseLayer?: StripPlanBaseLayer
  // 地図クリックで点を追加するモード
  pickMode: boolean
  onMapClick?: (latLng: [number, number]) => void
}

function ClickCapture({ enabled, onClick }: { enabled: boolean; onClick?: (ll: [number, number]) => void }) {
  useMapEvents({
    click: (e) => {
      if (!enabled || !onClick) return
      onClick([e.latlng.lat, e.latlng.lng])
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
  baseLayer = 'gsi-photo',
  pickMode,
  onMapClick,
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

      <ClickCapture enabled={pickMode} onClick={onMapClick} />
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
          pathOptions={{ color: '#a855f7', weight: 3, dashArray: '4,4' }}
        />
      )}
      {freeCurrent.map((pt, i) => (
        <CircleMarker
          key={`fc-${i}`}
          center={pt}
          radius={4}
          pathOptions={{ color: '#a855f7', fillColor: '#fff', fillOpacity: 1, weight: 2 }}
        />
      ))}

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
    </MapContainer>
  )
}
