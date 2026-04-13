import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import { COORDINATE_TYPE_NAMES } from '@/lib/coordinates'

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

interface CoordinateMapProps {
  selectedPointId?: string | null
  onPointSelect?: (id: string) => void
  showZonePolygons?: boolean
  editingZoneId?: string | null
  showLabels?: boolean
  visibleTypes?: Set<string>
  baseLayer?: BaseLayerType
}

export function CoordinateMap({
  selectedPointId,
  onPointSelect,
  showZonePolygons = true,
  editingZoneId,
  showLabels = true,
  visibleTypes,
  baseLayer = 'osm',
}: CoordinateMapProps) {
  const { coordinates, zones } = useCoordinateStore()

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

  // 区域のポリゴンデータを生成
  const zonePolygons = zones
    .filter(zone => zone.pointIds.length >= 3)
    .map(zone => {
      const points = zone.pointIds
        .map(id => coordinates.find(c => c.id === id))
        .filter((c): c is CoordinateRow & { lat: number; lng: number } =>
          c !== undefined && c.lat !== null && c.lng !== null
        )
        .map(c => [c.lat, c.lng] as [number, number])

      return {
        id: zone.id,
        name: zone.name,
        zoneNumber: zone.zoneNumber,
        positions: points,
        area: zone.areaHa,
      }
    })
    .filter(z => z.positions.length >= 3)

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

      {/* 区域ポリゴン */}
      {showZonePolygons &&
        zonePolygons.map(zone => {
          const isEditing = zone.id === editingZoneId
          return (
            <Polygon
              key={zone.id}
              positions={zone.positions}
              pathOptions={{
                color: isEditing ? '#2563eb' : '#3b82f6',
                fillColor: isEditing ? '#2563eb' : '#3b82f6',
                fillOpacity: isEditing ? 0.3 : 0.2,
                weight: isEditing ? 3 : 2,
                dashArray: isEditing ? '5, 5' : undefined,
              }}
            >
              <Popup>
                <div className="text-sm">
                  <div className="font-bold">{zone.zoneNumber}: {zone.name}</div>
                  {zone.area !== null && (
                    <div>面積: {zone.area.toFixed(4)} ha</div>
                  )}
                </div>
              </Popup>
            </Polygon>
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
          <Popup>
            <div className="text-sm">
              <div className="font-bold">{coord.pointNumber}</div>
              <div className="text-muted-foreground">
                {COORDINATE_TYPE_NAMES[coord.type]}
              </div>
              <div className="mt-1 font-mono text-xs">
                <div>X: {coord.x.toFixed(3)} m</div>
                <div>Y: {coord.y.toFixed(3)} m</div>
                {coord.z !== null && <div>Z: {coord.z.toFixed(2)} m</div>}
              </div>
            </div>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  )
}
