import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Polyline, Popup, CircleMarker, Marker, Polygon, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useUnderdrainStore, EXTENDED_PIPE_TYPES } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { CoordinateConverter, COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import type { PipeVertex } from '@/types/database'

// ラベルアイコンを生成
function createLabelIcon(label: string, color: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="
      font-size: 18px;
      font-weight: bold;
      color: ${color};
      white-space: nowrap;
      text-shadow:
        -2px -2px 0 white,
        2px -2px 0 white,
        -2px 2px 0 white,
        2px 2px 0 white,
        0 -2px 0 white,
        0 2px 0 white,
        -2px 0 0 white,
        2px 0 0 white,
        -1px -2px 0 white,
        1px -2px 0 white,
        -1px 2px 0 white,
        1px 2px 0 white,
        -2px -1px 0 white,
        2px -1px 0 white,
        -2px 1px 0 white,
        2px 1px 0 white;
    ">${label}</div>`,
    className: 'pipe-label-marker',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

// 矢印アイコンを生成（SVG）
function createArrowIcon(rotation: number, color: string, isSelected: boolean): L.DivIcon {
  const size = isSelected ? 16 : 12
  const svg = `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform: rotate(${rotation}deg)">
      <polygon points="12,2 22,22 12,17 2,22" fill="white" stroke="${color}" stroke-width="2"/>
    </svg>
  `
  return L.divIcon({
    html: svg,
    className: 'arrow-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 2点間の角度を計算（度）
function calculateAngle(from: [number, number], to: [number, number]): number {
  const dx = to[1] - from[1]
  const dy = to[0] - from[0]
  const angle = Math.atan2(dx, dy) * (180 / Math.PI)
  return angle
}

// 管種ごとの色
const PIPE_COLORS: Record<string, string> = {
  main: '#ef4444',       // 集水: 赤
  branch: '#3b82f6',     // 吸水: 青
  outlet: '#000000',     // 落口: 黒
  connection: '#000000', // 連絡渠: 黒
  spring: '#8b5cf6',     // 湧水処理: 紫
  auxiliary: '#06b6d4',  // 補助暗渠: シアン
  self_funded: '#22c55e',// 自費施工: 緑
  default: '#64748b',    // 未設定: スレートグレー
}

// 管径に応じた線の太さ（mm → px）
function getDiameterWeight(diameter: number | null): number {
  if (diameter === null) return 5 // 未設定
  if (diameter <= 60) return 4
  if (diameter <= 80) return 5
  if (diameter <= 100) return 6
  if (diameter <= 125) return 7
  if (diameter <= 150) return 8
  if (diameter <= 200) return 10
  return 12 // 250mm以上
}

// 選択中の色（ピンク）
const SELECTED_COLOR = '#ec4899'

// 頂点を経緯度に変換
function vertexToLatLng(
  vertex: PipeVertex,
  converter: CoordinateConverter
): [number, number] | null {
  if (vertex.x === 0 && vertex.y === 0) return null
  const { lat, lng } = converter.toLatLng(vertex.x, vertex.y)
  return [lat, lng]
}

// 管路のポリラインデータを生成
interface PipeLineData {
  id: string
  number: string
  pipeType: string | null
  diameter: number | null
  positions: [number, number][]
  color: string
  weight: number
  measuredLength: number | null
}

// 地図の境界を管路に合わせる
function MapBoundsUpdater({ pipeLines }: { pipeLines: PipeLineData[] }) {
  const map = useMap()
  const prevBoundsRef = useRef<string>('')

  useEffect(() => {
    const allPositions = pipeLines.flatMap(p => p.positions)
    if (allPositions.length === 0) return

    // 境界が変更されたかチェック
    const boundsKey = allPositions.map(p => `${p[0]}:${p[1]}`).join(',')
    if (boundsKey === prevBoundsRef.current) return
    prevBoundsRef.current = boundsKey

    const bounds = L.latLngBounds(allPositions)
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 20 })
  }, [pipeLines, map])

  return null
}

// 特定の管路にフォーカスする
function FocusPipe({ pipeLines, focusedPipeId }: { pipeLines: PipeLineData[], focusedPipeId: string | null }) {
  const map = useMap()
  const prevFocusedIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!focusedPipeId || focusedPipeId === prevFocusedIdRef.current) return
    prevFocusedIdRef.current = focusedPipeId

    const focusedPipe = pipeLines.find(p => p.id === focusedPipeId)
    if (!focusedPipe || focusedPipe.positions.length === 0) return

    const bounds = L.latLngBounds(focusedPipe.positions)
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 19 })
  }, [focusedPipeId, pipeLines, map])

  return null
}

// 測点データの型
export interface SurveyPointData {
  id: string
  name: string           // 表示名（例: "1C", "1A.2C"）
  x: number
  y: number
  z: number | null
  isMerged: boolean      // 集約された点かどうか
  originalCount?: number // 集約元の点数
}

interface PipeMapProps {
  selectedPipeId?: string | null
  selectedPipeIds?: Set<string>
  assignedPipeIds?: Set<string>  // 設定済み管路（黄色表示用）
  focusedPipeId?: string | null  // フォーカス対象の管路（中央拡大表示）
  onPipeSelect?: (id: string, ctrlKey?: boolean) => void
  onVertexClick?: (pipeId: string, vertexIndex: number) => void
  isBulkEditMode?: boolean
  showDirection?: boolean
  showLabels?: boolean
  showSurveyPoints?: boolean
  surveyPoints?: SurveyPointData[]
  editMode?: 'normal' | 'merge' | 'split'
  previewPoints?: PipeVertex[]
  showZones?: boolean           // 区域表示
  showCoordinates?: boolean     // 座標管理の点表示
  onPointClick?: (pointId: string) => void  // 点クリック時のコールバック
  selectablePoints?: boolean    // 点を選択可能にするか
}

// 測点ラベルアイコンを生成（緑の丸マーカー + ラベル）
function createSurveyPointIcon(label: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="display: flex; flex-direction: column; align-items: center;">
      <div style="
        font-size: 10px;
        font-weight: 500;
        color: #333;
        background-color: rgba(255, 255, 255, 0.9);
        padding: 1px 4px;
        border-radius: 3px;
        white-space: nowrap;
        border: 1px solid #ccc;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        margin-bottom: 2px;
      ">${label}</div>
      <div style="
        width: 12px;
        height: 12px;
        background-color: #22c55e;
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>
    </div>`,
    className: 'survey-point-marker',
    iconSize: [12, 30],
    iconAnchor: [6, 30],
  })
}

// 座標管理の点用アイコン（座標管理画面と同じスタイル）
function createCoordinateIcon(label: string, type: string): L.DivIcon {
  const typeColors: Record<string, string> = {
    control: '#ef4444',     // 基準点: 赤
    boundary: '#3b82f6',    // 外周点: 青
    underdrain: '#22c55e',  // 暗渠構成点: 緑
    soil_import: '#f59e0b', // 客土構成点: オレンジ
    stake: '#22c55e',       // 測点: 緑
  }
  const color = typeColors[type] || '#666'

  return L.divIcon({
    html: `<div style="display: flex; flex-direction: column; align-items: center;">
      <div style="
        font-size: 10px;
        font-weight: 500;
        color: #333;
        background-color: rgba(255, 255, 255, 0.9);
        padding: 1px 4px;
        border-radius: 3px;
        white-space: nowrap;
        border: 1px solid #ccc;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        margin-bottom: 2px;
      ">${label}</div>
      <div style="
        width: 12px;
        height: 12px;
        background-color: ${color};
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>
    </div>`,
    className: 'coordinate-marker',
    iconSize: [12, 30],
    iconAnchor: [6, 30],
  })
}

// 区域の色
const ZONE_COLORS = [
  '#3b82f6', // 青
  '#22c55e', // 緑
  '#f97316', // オレンジ
  '#8b5cf6', // 紫
  '#ec4899', // ピンク
  '#06b6d4', // シアン
]

export function PipeMap({
  selectedPipeId,
  selectedPipeIds = new Set(),
  assignedPipeIds = new Set(),
  focusedPipeId = null,
  onPipeSelect,
  onVertexClick,
  isBulkEditMode = false,
  showDirection = false,
  showLabels = false,
  showSurveyPoints = false,
  surveyPoints = [],
  editMode = 'normal',
  previewPoints = [],
  showZones = false,
  showCoordinates = false,
  onPointClick,
  selectablePoints = false,
}: PipeMapProps) {
  const { pipes } = useUnderdrainStore()
  const { zone, zones, coordinates } = useCoordinateStore()

  const converter = new CoordinateConverter(zone)

  // 管路をポリラインデータに変換
  const pipeLines: PipeLineData[] = pipes
    .map((pipe): PipeLineData | null => {
      const positions = pipe.vertices
        .map(v => vertexToLatLng(v, converter))
        .filter((p): p is [number, number] => p !== null)

      if (positions.length < 2) return null

      return {
        id: pipe.id,
        number: pipe.number,
        pipeType: pipe.pipeType,
        diameter: pipe.diameter,
        positions,
        color: PIPE_COLORS[pipe.pipeType || 'default'] || PIPE_COLORS.default,
        weight: getDiameterWeight(pipe.diameter),
        measuredLength: pipe.measuredLength,
      }
    })
    .filter((p): p is PipeLineData => p !== null)

  // 初期中心（管路がない場合は東京）
  const defaultCenter: [number, number] = [35.6762, 139.6503]
  const initialCenter =
    pipeLines.length > 0 && pipeLines[0].positions.length > 0
      ? pipeLines[0].positions[0]
      : defaultCenter

  return (
    <MapContainer
      center={initialCenter}
      zoom={15}
      maxZoom={22}
      className={`h-full w-full ${isBulkEditMode ? 'cursor-crosshair' : ''}`}
      style={{ minHeight: '400px' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={22}
        maxNativeZoom={19}
      />

      {focusedPipeId ? (
        <FocusPipe pipeLines={pipeLines} focusedPipeId={focusedPipeId} />
      ) : (
        <MapBoundsUpdater pipeLines={pipeLines} />
      )}

      {/* 管路ポリライン */}
      {pipeLines.map((pipe) => {
        const isSelected = pipe.id === selectedPipeId
        const isMultiSelected = selectedPipeIds.has(pipe.id)
        const isAssigned = assignedPipeIds.has(pipe.id)
        const MERGE_SELECTED_COLOR = '#a855f7' // 紫色（結合選択用）
        const ASSIGNED_COLOR = '#eab308' // 黄色（設定済み管路用）

        // 色の決定
        const getColor = () => {
          if (isSelected) return SELECTED_COLOR
          if (editMode === 'merge' && isMultiSelected) return MERGE_SELECTED_COLOR
          if (isAssigned) return ASSIGNED_COLOR
          return pipe.color
        }

        // 太さの決定
        const getWeight = () => {
          if (isSelected) return pipe.weight + 2
          if (editMode === 'merge' && isMultiSelected) return pipe.weight + 2
          return pipe.weight
        }

        return (
          <Polyline
            key={pipe.id}
            positions={pipe.positions}
            pathOptions={{
              color: getColor(),
              weight: getWeight(),
              opacity: isSelected || isMultiSelected ? 1 : 0.8,
            }}
            eventHandlers={{
              click: (e) => onPipeSelect?.(pipe.id, e.originalEvent.ctrlKey || e.originalEvent.metaKey),
              mouseover: (e) => {
                // 通常モードでもホバー時に太くする
                if (!isSelected && !isMultiSelected) {
                  e.target.setStyle({ weight: pipe.weight + 4 })
                }
                if (isBulkEditMode) {
                  e.target.setStyle({ weight: pipe.weight + 4, color: '#f59e0b' })
                }
                if (editMode === 'merge') {
                  e.target.setStyle({ weight: pipe.weight + 4, color: MERGE_SELECTED_COLOR })
                }
              },
              mouseout: (e) => {
                e.target.setStyle({
                  weight: getWeight(),
                  color: getColor(),
                })
              },
            }}
          />
        )
      })}

      {/* 頂点マーカー（選択中の管路のみ） */}
      {selectedPipeId && pipeLines
        .filter(p => p.id === selectedPipeId)
        .flatMap(pipe =>
          pipe.positions.map((pos, idx) => {
            const isStart = idx === 0
            const isEnd = idx === pipe.positions.length - 1
            const isSplitMode = editMode === 'split'
            const canSplit = isSplitMode && !isStart && !isEnd // 中間点のみ分割可能

            // 終点は矢印マーカー
            if (isEnd && pipe.positions.length >= 2) {
              const prevPos = pipe.positions[pipe.positions.length - 2]
              const angle = calculateAngle(prevPos, pos)
              return (
                <Marker
                  key={`${pipe.id}-${idx}`}
                  position={pos}
                  icon={createArrowIcon(angle, SELECTED_COLOR, true)}
                >
                  <Popup>
                    <div className="text-xs font-mono">
                      <div>下流（終点）</div>
                      <div>緯度: {pos[0].toFixed(6)}</div>
                      <div>経度: {pos[1].toFixed(6)}</div>
                    </div>
                  </Popup>
                </Marker>
              )
            }

            // 始点と中間点は円マーカー
            return (
              <CircleMarker
                key={`${pipe.id}-${idx}`}
                center={pos}
                radius={isSplitMode && canSplit ? 8 : (isStart ? 7 : 5)}
                pathOptions={{
                  color: canSplit ? '#f97316' : SELECTED_COLOR, // 分割可能点はオレンジ
                  fillColor: canSplit ? '#f97316' : (isStart ? SELECTED_COLOR : '#fff'),
                  fillOpacity: 1,
                  weight: 2,
                }}
                eventHandlers={canSplit ? {
                  click: () => onVertexClick?.(pipe.id, idx),
                  mouseover: (e) => {
                    e.target.setStyle({ radius: 10, fillColor: '#ea580c' })
                  },
                  mouseout: (e) => {
                    e.target.setStyle({ radius: 8, fillColor: '#f97316' })
                  },
                } : {}}
              >
                <Popup>
                  <div className="text-xs font-mono">
                    <div>{isStart ? '上流（起点）' : `点 ${idx + 1}`}</div>
                    <div>緯度: {pos[0].toFixed(6)}</div>
                    <div>経度: {pos[1].toFixed(6)}</div>
                    {canSplit && (
                      <div className="mt-1 text-orange-600 font-bold">クリックで分割</div>
                    )}
                  </div>
                </Popup>
              </CircleMarker>
            )
          })
        )}

      {/* 方向表示モード: 全管路の矢印 */}
      {showDirection && pipeLines.map(pipe => {
        if (pipe.positions.length < 2) return null
        const isSelected = pipe.id === selectedPipeId
        // 選択中の管路は上で表示済みなのでスキップ
        if (isSelected) return null

        const lastPos = pipe.positions[pipe.positions.length - 1]
        const prevPos = pipe.positions[pipe.positions.length - 2]
        const angle = calculateAngle(prevPos, lastPos)

        return (
          <Marker
            key={`direction-${pipe.id}`}
            position={lastPos}
            icon={createArrowIcon(angle, pipe.color, false)}
          >
            <Popup>
              <div className="text-xs">
                <div className="font-bold">{pipe.number}</div>
                <div>下流（終点）</div>
              </div>
            </Popup>
          </Marker>
        )
      })}

      {/* 中間点プレビューマーカー */}
      {previewPoints.length > 0 && previewPoints.map((point, idx) => {
        const latLng = converter.toLatLng(point.x, point.y)
        return (
          <CircleMarker
            key={`preview-${idx}`}
            center={[latLng.lat, latLng.lng]}
            radius={8}
            pathOptions={{
              color: '#16a34a',
              fillColor: '#22c55e',
              fillOpacity: 0.8,
              weight: 3,
            }}
          >
            <Popup>
              <div className="text-xs font-mono">
                <div className="font-bold text-green-600">プレビュー中間点 {idx + 1}</div>
                <div>X: {point.x.toFixed(3)}</div>
                <div>Y: {point.y.toFixed(3)}</div>
              </div>
            </Popup>
          </CircleMarker>
        )
      })}

      {/* 番号ラベル表示モード */}
      {showLabels && pipeLines.map(pipe => {
        if (pipe.positions.length < 2) return null

        // 管路の中央位置を計算
        const midIndex = Math.floor(pipe.positions.length / 2)
        const midPos = pipe.positions.length % 2 === 0
          ? [
              (pipe.positions[midIndex - 1][0] + pipe.positions[midIndex][0]) / 2,
              (pipe.positions[midIndex - 1][1] + pipe.positions[midIndex][1]) / 2,
            ] as [number, number]
          : pipe.positions[midIndex]

        return (
          <Marker
            key={`label-${pipe.id}`}
            position={midPos}
            icon={createLabelIcon(pipe.number, pipe.color)}
            eventHandlers={{
              click: (e) => onPipeSelect?.(pipe.id, e.originalEvent.ctrlKey || e.originalEvent.metaKey),
            }}
          />
        )
      })}

      {/* 測点表示モード */}
      {showSurveyPoints && surveyPoints.map(point => {
        const { lat, lng } = converter.toLatLng(point.x, point.y)
        return (
          <Marker
            key={`survey-${point.id}`}
            position={[lat, lng]}
            icon={createSurveyPointIcon(point.name)}
            eventHandlers={selectablePoints && onPointClick ? {
              click: () => onPointClick(point.id),
            } : {}}
          >
            <Popup>
              <div className="text-xs font-mono">
                <div className="font-bold">{point.name}</div>
                <div>X: {point.x.toFixed(3)}</div>
                <div>Y: {point.y.toFixed(3)}</div>
                {point.z !== null && <div>Z: {point.z.toFixed(3)}</div>}
                {point.isMerged && point.originalCount && (
                  <div className="mt-1 text-yellow-600">
                    {point.originalCount}点を集約
                  </div>
                )}
                {selectablePoints && (
                  <div className="mt-1 text-green-600 font-bold">
                    クリックで選択
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        )
      })}

      {/* 区域ポリゴン表示 */}
      {showZones && zones.map((zoneData, idx) => {
        const positions = zoneData.pointIds
          .map(pointId => {
            const coord = coordinates.find(c => c.id === pointId)
            if (!coord) return null
            const { lat, lng } = converter.toLatLng(coord.x, coord.y)
            return [lat, lng] as [number, number]
          })
          .filter((p): p is [number, number] => p !== null)

        if (positions.length < 3) return null

        const color = ZONE_COLORS[idx % ZONE_COLORS.length]

        return (
          <Polygon
            key={zoneData.id}
            positions={positions}
            pathOptions={{
              color: color,
              fillColor: color,
              fillOpacity: 0.15,
              weight: 2,
            }}
          >
            <Popup>
              <div className="text-xs">
                <div className="font-bold">{zoneData.name}</div>
                <div>{positions.length}点で構成</div>
              </div>
            </Popup>
          </Polygon>
        )
      })}

      {/* 座標管理の点表示 */}
      {showCoordinates && coordinates.map(coord => {
        const { lat, lng } = converter.toLatLng(coord.x, coord.y)
        return (
          <Marker
            key={`coord-${coord.id}`}
            position={[lat, lng]}
            icon={createCoordinateIcon(coord.pointNumber, coord.type)}
            eventHandlers={selectablePoints && onPointClick ? {
              click: () => onPointClick(coord.id),
            } : {}}
          >
            <Popup>
              <div className="text-xs font-mono">
                <div className="font-bold">{coord.pointNumber}</div>
                <div>種類: {COORDINATE_TYPE_NAMES[coord.type] || coord.type}</div>
                <div>X: {coord.x.toFixed(3)}</div>
                <div>Y: {coord.y.toFixed(3)}</div>
                {coord.z !== null && <div>Z: {coord.z.toFixed(3)}</div>}
                {selectablePoints && (
                  <div className="mt-1 text-green-600 font-bold">
                    クリックで選択
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        )
      })}

      {/* 凡例 */}
      <div className="absolute bottom-4 left-4 bg-white p-2 rounded shadow-md z-[1000] text-xs">
        {isBulkEditMode && (
          <div className="mb-2 pb-2 border-b">
            <div className="font-medium text-amber-600">一括訂正モード</div>
            <div className="text-amber-500">クリックで訂正適用</div>
          </div>
        )}
        <div className="font-medium mb-1">管種</div>
        {EXTENDED_PIPE_TYPES.map((type) => (
          <div key={type.value} className="flex items-center gap-2">
            <div
              className="w-3 h-1"
              style={{ backgroundColor: PIPE_COLORS[type.value] }}
            />
            <span>{type.label}</span>
          </div>
        ))}
        <div className="mt-2 pt-2 border-t">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full" style={{ backgroundColor: SELECTED_COLOR }} />
            <span>上流（起点）</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="12" height="12" viewBox="0 0 24 24">
              <polygon points="12,2 22,22 12,17 2,22" fill="white" stroke={SELECTED_COLOR} strokeWidth="2"/>
            </svg>
            <span>下流（終点）</span>
          </div>
        </div>
      </div>
    </MapContainer>
  )
}
