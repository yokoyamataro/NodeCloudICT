import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useMapViewStore } from '@/stores/mapViewStore'

// デフォルトマーカーアイコンの修正（Leafletの既知の問題）
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// 座標種類ごとのマーカー色
const MARKER_COLORS: Record<string, string> = {
  control: '#ef4444',     // 基準点: 赤
  boundary: '#3b82f6',    // 外周点: 青
  underdrain: '#22c55e',  // 暗渠構成点: 緑
  soil_import: '#f59e0b', // 客土構成点: オレンジ
  stake: '#22c55e',       // 測点: 緑（暗渠構成点と同じ）
}

// カスタムマーカーアイコンを作成
function createColoredIcon(color: string, isSelected: boolean = false): L.DivIcon {
  const size = isSelected ? 16 : 12
  const borderWidth = isSelected ? 3 : 2
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${color};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      border: ${borderWidth}px solid ${isSelected ? '#1d4ed8' : 'white'};
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 地図の表示状態を管理するコンポーネント
function MapViewManager({ coordinates }: { coordinates: CoordinateRow[] }) {
  const map = useMap()
  const { center, zoom, isInitialized, setView } = useMapViewStore()
  const initializedRef = useRef(false)

  // 地図の移動・ズーム時にストアを更新
  useEffect(() => {
    const handleMoveEnd = () => {
      const currentCenter = map.getCenter()
      const currentZoom = map.getZoom()
      setView([currentCenter.lat, currentCenter.lng], currentZoom)
    }

    map.on('moveend', handleMoveEnd)
    map.on('zoomend', handleMoveEnd)

    return () => {
      map.off('moveend', handleMoveEnd)
      map.off('zoomend', handleMoveEnd)
    }
  }, [map, setView])

  // 初期表示：保存された位置があればそれを使用、なければ座標にフィット
  useEffect(() => {
    if (initializedRef.current) return

    // 保存された位置があれば復元
    if (isInitialized && center && zoom) {
      map.setView(center, zoom)
      initializedRef.current = true
      return
    }

    // 保存された位置がなければ座標にフィット
    const validCoords = coordinates.filter(c => c.lat !== null && c.lng !== null)
    if (validCoords.length > 0) {
      const bounds = L.latLngBounds(
        validCoords.map(c => [c.lat!, c.lng!] as [number, number])
      )
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 })
      initializedRef.current = true
    }
  }, [coordinates, map, center, zoom, isInitialized])

  return null
}

// 背景地図の種類
export type BaseLayerType = 'osm' | 'gsi-photo' | 'gsi-std'

// 外部から渡す区域ポリゴン
export interface ExternalPolygon {
  id: string
  name: string
  positions: [number, number][]
  isEditing?: boolean
}

interface CoordinateMapProps {
  selectedPointId?: string | null
  onPointSelect?: (id: string) => void
  showLabels?: boolean
  visibleTypes?: Set<string>
  baseLayer?: BaseLayerType
  externalPolygons?: ExternalPolygon[]
  editingExternalPolygonId?: string | null
}

export function CoordinateMap({
  selectedPointId,
  onPointSelect,
  showLabels = true,
  visibleTypes,
  baseLayer = 'osm',
  externalPolygons = [],
  editingExternalPolygonId,
}: CoordinateMapProps) {
  const { coordinates } = useCoordinateStore()

  // 有効な座標（緯度経度が計算済み）のみ表示
  const validCoordinates = coordinates.filter(
    (c): c is CoordinateRow & { lat: number; lng: number } =>
      c.lat !== null && c.lng !== null
  )

  // 表示対象の座標をフィルタリング
  const displayCoordinates = visibleTypes
    ? validCoordinates.filter(c => visibleTypes.has(c.type))
    : validCoordinates

  // 初期中心（座標がない場合は東京）
  const defaultCenter: [number, number] = [35.6762, 139.6503]
  const initialCenter =
    validCoordinates.length > 0
      ? [validCoordinates[0].lat, validCoordinates[0].lng] as [number, number]
      : defaultCenter

  return (
    <MapContainer
      center={initialCenter}
      zoom={15}
      className="h-full w-full"
      style={{ minHeight: '400px' }}
    >
      {baseLayer === 'osm' && (
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
      )}
      {baseLayer === 'gsi-photo' && (
        <TileLayer
          attribution='&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>'
          url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
          maxZoom={18}
        />
      )}
      {baseLayer === 'gsi-std' && (
        <TileLayer
          attribution='&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>'
          url="https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"
          maxZoom={18}
        />
      )}

      <MapViewManager coordinates={validCoordinates} />

      {/* 外部から渡されたポリゴン（workAreaStoreなど） */}
      {externalPolygons.map(polygon => {
        if (polygon.positions.length < 3) return null
        const isEditing = polygon.id === editingExternalPolygonId
        return (
          <Polygon
            key={polygon.id}
            positions={polygon.positions}
            pathOptions={{
              color: isEditing ? '#16a34a' : '#22c55e',
              fillColor: isEditing ? '#16a34a' : '#22c55e',
              fillOpacity: isEditing ? 0.3 : 0.2,
              weight: isEditing ? 3 : 2,
              dashArray: isEditing ? '5, 5' : undefined,
            }}
          />
        )
      })}

      {/* 座標マーカー */}
      {displayCoordinates.map(coord => (
        <Marker
          key={coord.id}
          position={[coord.lat, coord.lng]}
          icon={createColoredIcon(
            MARKER_COLORS[coord.type] || '#666',
            coord.id === selectedPointId
          )}
          eventHandlers={{
            click: () => onPointSelect?.(coord.id),
          }}
        >
          {showLabels && (
            <Tooltip
              permanent
              direction="top"
              offset={[0, -8]}
              className="point-label-tooltip"
            >
              {coord.pointNumber}
            </Tooltip>
          )}
        </Marker>
      ))}
    </MapContainer>
  )
}
