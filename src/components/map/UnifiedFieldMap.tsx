import { useEffect, useMemo, useRef } from 'react'
import {
  MapContainer,
  TileLayer,
  Polyline,
  Polygon,
  Marker,
  CircleMarker,
  Tooltip,
  useMap,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useCoordinateStore, type RoutePoint } from '@/stores/coordinateStore'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useWorkAreaStore, type WorkAreaPoint, type WorkAreaRow } from '@/stores/workAreaStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { WORK_TYPE_NAMES, type WorkType } from '@/types/database'
import { CurrentLocationLayer } from './CurrentLocationLayer'

export type BaseLayerType = 'osm' | 'gsi-photo' | 'gsi-std'

export interface LayerVisibility {
  coordinatePoints: boolean
  pipes: boolean
  pipeNumbers: boolean
  pipeMeasurementPoints: boolean
  surveyPoints: boolean
  workAreas: boolean
  route: boolean
  currentLocation: boolean
}

interface UnifiedFieldMapProps {
  baseLayer?: BaseLayerType
  layers: LayerVisibility
}

// === 色/スタイル定義 ===

// 座標種類ごとのマーカー色
const COORDINATE_MARKER_COLORS: Record<string, string> = {
  control: '#ef4444',
  boundary: '#3b82f6',
  underdrain: '#22c55e',
  soil_import: '#f59e0b',
  stake: '#22c55e',
}

// 管種ごとの色
const PIPE_COLORS: Record<string, string> = {
  main: '#ef4444',
  branch: '#3b82f6',
  outlet: '#000000',
  connection: '#000000',
  spring: '#8b5cf6',
  auxiliary: '#06b6d4',
  self_funded: '#22c55e',
  default: '#64748b',
}

// 工種ごとの色
const WORK_TYPE_COLORS: Record<string, string> = {
  underdrain: '#3b82f6',
  soil_import: '#f59e0b',
  simple_grading: '#8b5cf6',
  grading: '#10b981',
  subsoil: '#ec4899',
  stone_removal: '#6b7280',
}

// 管径に応じた線の太さ
function getDiameterWeight(diameter: number | null): number {
  if (diameter === null) return 5
  if (diameter <= 60) return 3
  if (diameter <= 80) return 4
  if (diameter <= 100) return 5
  if (diameter <= 125) return 6
  if (diameter <= 150) return 7
  if (diameter <= 200) return 8
  return 10
}

function createColoredDotIcon(color: string, size = 12): L.DivIcon {
  return L.divIcon({
    className: 'unified-map-dot',
    html: `<div style="
      background-color: ${color};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      border: 2px solid white;
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function createLabelIcon(label: string, color: string): L.DivIcon {
  return L.divIcon({
    className: 'unified-map-label',
    html: `<div style="
      color: ${color};
      font-weight: 700;
      font-size: 12px;
      text-shadow: 0 0 3px white, 0 0 3px white, 0 0 3px white;
      white-space: nowrap;
    ">${label}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

// 頂点を緯度経度に
function vertexToLatLng(
  v: { x: number; y: number },
  converter: CoordinateConverter,
): [number, number] | null {
  try {
    const { lat, lng } = converter.toLatLng(v.x, v.y)
    if (Number.isFinite(lat) && Number.isFinite(lng)) return [lat, lng]
  } catch {
    return null
  }
  return null
}

// 地図の初期フィットをまとめる小コンポーネント
function FitBoundsOnce({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  const doneRef = useRef(false)
  useEffect(() => {
    if (doneRef.current) return
    if (!bounds) return
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 20 })
    doneRef.current = true
  }, [map, bounds])
  return null
}

function MapViewPersist() {
  const map = useMap()
  const { setView } = useMapViewStore()
  useEffect(() => {
    const handler = () => {
      const c = map.getCenter()
      setView([c.lat, c.lng], map.getZoom())
    }
    map.on('moveend', handler)
    map.on('zoomend', handler)
    return () => {
      map.off('moveend', handler)
      map.off('zoomend', handler)
    }
  }, [map, setView])
  return null
}


export function UnifiedFieldMap({ baseLayer = 'osm', layers }: UnifiedFieldMapProps) {
  const { coordinates, zone, route } = useCoordinateStore()
  const { pipes } = useUnderdrainStore()
  const workAreasByType = useWorkAreaStore((state) => state.workAreas)
  const { surveyData } = useSurveyStore()

  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // 座標
  const validCoords = coordinates.filter(
    (c): c is typeof c & { lat: number; lng: number } => c.lat !== null && c.lng !== null,
  )

  // 管路
  const pipeLines = useMemo(() => {
    return pipes
      .map((pipe: PipeRow) => {
        const positions = pipe.vertices
          .map((v) => vertexToLatLng(v, converter))
          .filter((p): p is [number, number] => p !== null)
        if (positions.length < 2) return null
        return {
          id: pipe.id,
          number: pipe.number,
          pipeType: pipe.pipeType,
          color: PIPE_COLORS[pipe.pipeType || 'default'] ?? PIPE_COLORS.default,
          weight: getDiameterWeight(pipe.diameter),
          positions,
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
  }, [pipes, converter])

  // 管路の測点（座標計算の C / B / A）
  // C=最上流、A=最下流、B1,B2...=中間点（下流から順）
  const pipeMeasurementPoints = useMemo(() => {
    type MP = { id: string; name: string; ll: [number, number]; color: string }
    const out: MP[] = []
    for (const pipe of pipes) {
      if (pipe.vertices.length < 1) continue
      const color = PIPE_COLORS[pipe.pipeType || 'default'] ?? PIPE_COLORS.default
      const vs = pipe.vertices
      // 最上流
      const upLL = vertexToLatLng(vs[0], converter)
      if (upLL) out.push({ id: `${pipe.id}-C`, name: `${pipe.number}C`, ll: upLL, color })
      // 中間点
      if (vs.length > 2) {
        const middleCount = vs.length - 2
        for (let i = 0; i < middleCount; i++) {
          const vertexIndex = vs.length - 2 - i
          const middleIndex = i + 1
          const ll = vertexToLatLng(vs[vertexIndex], converter)
          if (ll) {
            out.push({
              id: `${pipe.id}-B${middleIndex}`,
              name: `${pipe.number}B${middleIndex}`,
              ll,
              color,
            })
          }
        }
      }
      // 最下流
      if (vs.length >= 2) {
        const downLL = vertexToLatLng(vs[vs.length - 1], converter)
        if (downLL) out.push({ id: `${pipe.id}-A`, name: `${pipe.number}A`, ll: downLL, color })
      }
    }
    return out
  }, [pipes, converter])

  // 測量点（z を持つもののみ点として表示）
  const surveyMarkers = useMemo(() => {
    return surveyData
      .map((s) => ({ ...s, ll: vertexToLatLng(s, converter) }))
      .filter((s): s is typeof s & { ll: [number, number] } => s.ll !== null)
  }, [surveyData, converter])

  // 工事区域（全工種）
  const workAreas = useMemo(() => {
    const list: Array<WorkAreaRow & { workTypeKey: WorkType; positions: [number, number][] }> = []
    for (const [workTypeKey, areas] of Object.entries(workAreasByType) as Array<[
      WorkType,
      WorkAreaRow[] | undefined,
    ]>) {
      if (!areas) continue
      for (const area of areas) {
        const positions = (area.points as WorkAreaPoint[])
          .filter((p) => p.lat !== null && p.lng !== null)
          .map((p) => [p.lat as number, p.lng as number] as [number, number])
        if (positions.length >= 3) {
          list.push({ ...area, workTypeKey, positions })
        }
      }
    }
    return list
  }, [workAreasByType])

  // 初期表示の境界
  const allBounds = useMemo(() => {
    const all: [number, number][] = []
    for (const c of validCoords) all.push([c.lat, c.lng])
    for (const p of pipeLines) all.push(...p.positions)
    for (const a of workAreas) all.push(...a.positions)
    if (all.length === 0) return null
    const lats = all.map((p) => p[0])
    const lngs = all.map((p) => p[1])
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)])
  }, [validCoords, pipeLines, workAreas])

  const defaultCenter: [number, number] = [35.6762, 139.6503]
  const initialCenter = allBounds
    ? ([(allBounds.getNorth() + allBounds.getSouth()) / 2, (allBounds.getEast() + allBounds.getWest()) / 2] as [
        number,
        number,
      ])
    : defaultCenter

  return (
    <MapContainer center={initialCenter} zoom={15} maxZoom={22} className="h-full w-full">
      {baseLayer === 'osm' && (
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
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

      <FitBoundsOnce bounds={allBounds} />
      <MapViewPersist />

      {/* 工事区域 */}
      {layers.workAreas &&
        workAreas.map((area) => {
          const color = WORK_TYPE_COLORS[area.workTypeKey] ?? '#22c55e'
          return (
            <Polygon
              key={`wa-${area.id}`}
              positions={area.positions}
              pathOptions={{
                color,
                fillColor: color,
                fillOpacity: 0.2,
                weight: 2,
              }}
            >
              <Tooltip>
                {WORK_TYPE_NAMES[area.workTypeKey]} / {area.zoneNumber || area.name}
              </Tooltip>
            </Polygon>
          )
        })}

      {/* 管路 */}
      {layers.pipes &&
        pipeLines.map((pl) => (
          <Polyline
            key={`pipe-${pl.id}`}
            positions={pl.positions}
            pathOptions={{ color: pl.color, weight: pl.weight, opacity: 0.9 }}
          >
            <Tooltip sticky>
              {pl.number}
              {pl.pipeType ? ` (${pl.pipeType})` : ''}
            </Tooltip>
          </Polyline>
        ))}

      {/* 配管番号ラベル（最上流頂点の位置に） */}
      {layers.pipes &&
        layers.pipeNumbers &&
        pipeLines.map((pl) => {
          const pos = pl.positions[0]
          return (
            <Marker
              key={`pipe-label-${pl.id}`}
              position={pos}
              icon={createLabelIcon(pl.number, pl.color)}
              interactive={false}
            />
          )
        })}

      {/* 配管の測点（座標計算の C / B / A） */}
      {layers.pipeMeasurementPoints &&
        pipeMeasurementPoints.map((mp) => (
          <Marker
            key={`mp-${mp.id}`}
            position={mp.ll}
            icon={createColoredDotIcon(mp.color, 8)}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              {mp.name}
            </Tooltip>
          </Marker>
        ))}

      {/* 測量点（測点） */}
      {layers.surveyPoints &&
        surveyMarkers.map((s) => (
          <CircleMarker
            key={`survey-${s.id}`}
            center={s.ll}
            radius={4}
            pathOptions={{ color: '#0ea5e9', fillColor: '#38bdf8', fillOpacity: 0.9, weight: 1 }}
          >
            <Tooltip>
              {s.pointNumber}
              {s.z !== null && ` (z=${s.z.toFixed(3)})`}
            </Tooltip>
          </CircleMarker>
        ))}

      {/* 経路: down セグメントのみポリライン */}
      {layers.route && route.length > 1 && (() => {
        const coordById = new Map(validCoords.map((c) => [c.id, c]))
        const segments: Array<[number, number][]> = []
        let current: [number, number][] = []
        for (let i = 0; i < route.length; i++) {
          const p: RoutePoint = route[i]
          const c = coordById.get(p.coordinateId)
          if (!c) continue
          if (i === 0) {
            current = [[c.lat, c.lng]]
            continue
          }
          if (p.direction === 'down') {
            current.push([c.lat, c.lng])
          } else {
            if (current.length >= 2) segments.push(current)
            current = [[c.lat, c.lng]]
          }
        }
        if (current.length >= 2) segments.push(current)
        return segments.map((positions, idx) => (
          <Polyline
            key={`route-seg-${idx}`}
            positions={positions}
            pathOptions={{ color: '#2563eb', weight: 3, opacity: 0.9 }}
          />
        ))
      })()}

      {/* 経路の順番ラベル */}
      {layers.route &&
        route.map((p, idx) => {
          const c = validCoords.find((co) => co.id === p.coordinateId)
          if (!c) return null
          const color = p.direction === 'down' ? '#2563eb' : '#9ca3af'
          const icon = L.divIcon({
            className: 'route-order-marker',
            html: `<div style="
              background: ${color};
              color: white;
              border-radius: 50%;
              width: 22px;
              height: 22px;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 11px;
              font-weight: bold;
              border: 2px solid white;
              box-shadow: 0 1px 3px rgba(0,0,0,0.4);
            ">${idx + 1}</div>`,
            iconSize: [22, 22],
            iconAnchor: [11, 11],
          })
          return (
            <Marker
              key={`route-${idx}`}
              position={[c.lat, c.lng]}
              icon={icon}
              interactive={false}
              zIndexOffset={1000}
            />
          )
        })}

      {/* 座標点 */}
      {layers.coordinatePoints &&
        validCoords.map((coord) => (
          <Marker
            key={`coord-${coord.id}`}
            position={[coord.lat, coord.lng]}
            icon={createColoredDotIcon(COORDINATE_MARKER_COLORS[coord.type] ?? '#666', 10)}
          >
            <Tooltip>{coord.pointNumber}</Tooltip>
          </Marker>
        ))}

      {/* 現在位置（Geolocation） */}
      {layers.currentLocation && <CurrentLocationLayer />}
    </MapContainer>
  )
}
