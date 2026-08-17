import { useEffect, useRef } from 'react'
import { MapContainer, TileLayer, Polyline, Popup, CircleMarker, Marker, Polygon, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useUnderdrainStore, EXTENDED_PIPE_TYPES, type ExtendedPipeType } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore, type WorkAreaRow } from '@/stores/workAreaStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import { useStakingStore } from '@/stores/stakingStore'
import { CoordinateConverter } from '@/lib/coordinates'
import type { PipeVertex } from '@/types/database'

// 空配列の安定参照（selector で || [] すると新しい参照が毎回返り無限ループする）
const EMPTY_WORK_AREAS: WorkAreaRow[] = []

// ラベルアイコンを生成 (subLabel 指定時は下段に小さめで表示)
function createLabelIcon(
  label: string,
  color: string,
  subLabel?: string | null,
): L.DivIcon {
  const shadow = `
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
    2px 1px 0 white
  `
  const mainHtml = label
    ? `<div style="
        font-size: 18px;
        font-weight: bold;
        color: ${color};
        white-space: nowrap;
        text-shadow: ${shadow};
      ">${label}</div>`
    : ''
  const subHtml = subLabel
    ? `<div style="
        font-size: 12px;
        font-weight: 600;
        color: ${color};
        white-space: nowrap;
        text-shadow: ${shadow};
      ">${subLabel}</div>`
    : ''
  return L.divIcon({
    html: `<div style="display:flex; flex-direction:column; align-items:center; line-height:1.05;">${mainHtml}${subHtml}</div>`,
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

// 下流端 (end) から上流側 (prev) に少し引っ込めた位置を返す。
// 合流部で複数管の矢印が下流端に重なって潰れるのを避けるための表示補正。
// 最終セグメント長の 15% ぶん、または最大 4m 相当だけ後退させる。
function offsetTowardsPrev(
  end: [number, number],
  prev: [number, number],
): [number, number] {
  // 緯度経度距離ではなく単純な線形補間で十分 (表示用)
  const RATIO = 0.15
  // 短すぎるセグメントで補間しても離れないので下限を持たせる (概ね 4m 相当)
  const APPROX_METER_PER_DEG_LAT = 111000
  const dLat = end[0] - prev[0]
  const dLng = end[1] - prev[1]
  const segLatMeters = dLat * APPROX_METER_PER_DEG_LAT
  const segLngMeters = dLng * APPROX_METER_PER_DEG_LAT * Math.cos((end[0] * Math.PI) / 180)
  const segLen = Math.hypot(segLatMeters, segLngMeters)
  const target = 4 // meters
  const ratio =
    segLen > 0 ? Math.min(RATIO, target / segLen) : RATIO
  return [
    end[0] * (1 - ratio) + prev[0] * ratio,
    end[1] * (1 - ratio) + prev[1] * ratio,
  ]
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
  designLength: number | null
  vertexLength: number
}

// 管種コード → 表示ラベル
const PIPE_TYPE_LABEL: Record<string, string> = Object.fromEntries(
  EXTENDED_PIPE_TYPES.map((t) => [t.value, t.label])
)
function pipeTypeLabel(type: string | null): string {
  if (!type) return '未設定'
  return PIPE_TYPE_LABEL[type as ExtendedPipeType] ?? type
}

// 地図の表示状態を管理するコンポーネント
function MapViewManager({ pipeLines }: { pipeLines: PipeLineData[] }) {
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

  // 初期表示：保存された位置があればそれを使用、なければ管路にフィット
  useEffect(() => {
    if (initializedRef.current) return

    // 保存された位置があれば復元
    if (isInitialized && center && zoom) {
      map.setView(center, zoom)
      initializedRef.current = true
      return
    }

    // 保存された位置がなければ管路にフィット
    const allPositions = pipeLines.flatMap(p => p.positions)
    if (allPositions.length > 0) {
      const bounds = L.latLngBounds(allPositions)
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 20 })
      initializedRef.current = true
    }
  }, [pipeLines, map, center, zoom, isInitialized])

  return null
}

// 親コンテナのリサイズを検知して Leaflet に invalidateSize() を伝える。
// 施工計画ページのようにパラメータバーの高さが動的に変わると、Leaflet の
// 内部サイズが古いままになり地図上端が親コンテナの外側にはみ出す (見た目
// 上「隠れる」) 現象が起きるため、ResizeObserver で確実に再計算させる。
function InvalidateOnResize() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    if (!container || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      map.invalidateSize()
    })
    ro.observe(container)
    return () => ro.disconnect()
  }, [map])
  return null
}

// DXF 取込プレビューが空→非空に変わったタイミングで、その範囲に地図をフィットさせる
function FitImportPreview({
  positions,
}: {
  positions: [number, number][]
}) {
  const map = useMap()
  const prevCountRef = useRef(0)

  useEffect(() => {
    const count = positions.length
    if (count > 0 && prevCountRef.current === 0) {
      const bounds = L.latLngBounds(positions)
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 20 })
    }
    prevCountRef.current = count
  }, [positions, map])

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

// 施工計画表で編集中の点にパンする (ズームは変えない)
function FocusPoint({
  point,
  converter,
}: {
  point: { x: number; y: number } | null
  converter: CoordinateConverter
}) {
  const map = useMap()
  useEffect(() => {
    if (!point) return
    const { lat, lng } = converter.toLatLng(point.x, point.y)
    map.panTo([lat, lng], { animate: true, duration: 0.3 })
  }, [point, converter, map])
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
  isSelected?: boolean   // 選択中かどうか
}

// 背景地図の種類
export type BaseLayerType = 'osm' | 'gsi-photo' | 'gsi-std'

// 管切り替え点のデータ型
export interface PipeChangePoint {
  x: number
  y: number
  label: string  // 表示ラベル（例: "S4A S3C"）
}

// DXF 取込前の候補プレビュー
export interface ImportPreviewLine {
  tempId: string
  vertices: PipeVertex[]
  selected: boolean
  /** 地図上に表示する仮の番号 (例: 1, 2, 3 or P001) */
  label?: string | null
}

interface PipeMapProps {
  selectedPipeId?: string | null
  selectedPipeIds?: Set<string>
  assignedPipeIds?: Set<string>  // 設定済み管路（黄色表示用）
  highlightPipeIds?: Set<string> // コンテキスト強調表示（例: 選択中の系統全体）
  focusedPipeId?: string | null  // フォーカス対象の管路（中央拡大表示）
  /** 施工計画表で編集中のセルに対応する点。指定するとズームを変えずに地図中心を移動 */
  focusedPoint?: { x: number; y: number } | null
  onPipeSelect?: (id: string, ctrlKey?: boolean) => void
  onVertexClick?: (pipeId: string, vertexIndex: number) => void
  onJunctionSplitClick?: (pipeId: string, point: { x: number; y: number }) => void  // 合流点での分割
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
  selectedPointIds?: Set<string>  // 選択中の点ID（出力点選択用）
  selectedPointRoute?: [number, number][]  // 選択した点を結ぶルート（座標のリスト）
  showSelectedRoute?: boolean  // 選択ルートを表示するか
  baseLayer?: BaseLayerType     // 背景地図の種類
  pipeChangePoints?: PipeChangePoint[]  // 管切り替え点（〇マーカー表示用）
  importPreviewLines?: ImportPreviewLine[]  // DXF 取込前の候補プレビュー
  /** 取込プレビュー線がクリックされた時のコールバック (選択切替に使う) */
  onPreviewClick?: (tempId: string) => void
  /** 表内の測点タップで強調表示する頂点 */
  highlightedVertex?: { pipeId: string; vertexIdx: number } | null
  /** 配線番号の下に管径・延長 (φXX L=YY) を表記する */
  showPipeSpecs?: boolean
  /** 管路クリック時のポップアップ (配線番号/管種/延長/管径) を無効化する */
  hidePipePopup?: boolean
  /** 実測記録 (staking_records) をマーカー表示するか */
  showStakingRecords?: boolean
  /** 実測記録の補正後標高 = measuredZ + stakingZOffset で計算するオフセット (m) */
  stakingZOffset?: number
  /**
   * 施工計画: 選択配線の各測点に地盤高/計画高/切深を表示するオーバーレイ。
   * points は上流→下流の順で渡す。 segments はその中間点にラベルを置くのに使う。
   */
  planOverlay?: {
    points: Array<{
      id: string
      x: number
      y: number
      pointName?: string
      groundHeight: number | null
      plannedHeight: number | null
      cutDepth: number | null
    }>
    segments: Array<{
      x1: number
      y1: number
      x2: number
      y2: number
      slope: string | null   // "1/77" 形式
      distance: number | null
      diameter: number | null // mm
    }>
    flags: {
      showGround: boolean
      showPlanned: boolean
      showCut: boolean
      showSlope: boolean
      showDistance: boolean
      showDiameter: boolean
    }
  }
}

// 測点ラベルアイコンを生成（緑の丸マーカー + ラベル、選択時はオレンジ・拡大・パルス）
function createSurveyPointIcon(label: string, isSelected: boolean = false): L.DivIcon {
  const color = isSelected ? '#f97316' : '#22c55e'  // オレンジ or 緑
  const size = isSelected ? 22 : 12
  const borderColor = isSelected ? '#ea580c' : 'white'
  const ring = isSelected
    ? `<div style="
        position: absolute;
        left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: ${size + 16}px;
        height: ${size + 16}px;
        border-radius: 50%;
        border: 3px solid #f97316;
        opacity: 0.7;
        pointer-events: none;
      "></div>`
    : ''
  return L.divIcon({
    html: `<div style="display: flex; flex-direction: column; align-items: center;">
      <div style="
        font-size: ${isSelected ? 12 : 10}px;
        font-weight: ${isSelected ? 700 : 500};
        color: ${isSelected ? '#c2410c' : '#333'};
        background-color: ${isSelected ? 'rgba(255, 237, 213, 0.98)' : 'rgba(255, 255, 255, 0.9)'};
        padding: ${isSelected ? '2px 6px' : '1px 4px'};
        border-radius: 3px;
        white-space: nowrap;
        border: ${isSelected ? '2px solid #f97316' : '1px solid #ccc'};
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        margin-bottom: 2px;
      ">${label}</div>
      <div style="position: relative; width: ${size + 16}px; height: ${size + 16}px; display: flex; align-items: center; justify-content: center;">
        ${ring}
        <div style="
          width: ${size}px;
          height: ${size}px;
          background-color: ${color};
          border-radius: 50%;
          border: ${isSelected ? 3 : 2}px solid ${borderColor};
          box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        "></div>
      </div>
    </div>`,
    className: 'survey-point-marker',
    iconSize: [size + 16, isSelected ? 50 : 30],
    iconAnchor: [(size + 16) / 2, isSelected ? 50 : 30],
  })
}

// 座標管理の点用アイコン（座標管理画面と同じスタイル、選択時はオレンジ）
function createCoordinateIcon(label: string, type: string, isSelected: boolean = false): L.DivIcon {
  const typeColors: Record<string, string> = {
    control: '#ef4444',     // 基準点: 赤
    boundary: '#3b82f6',    // 境界点: 青
    underdrain: '#22c55e',  // 暗渠構成点: 緑
    soil_import: '#f59e0b', // 客土構成点: オレンジ
    stake: '#22c55e',       // 測点: 緑
  }
  const color = isSelected ? '#f97316' : (typeColors[type] || '#666')
  const size = isSelected ? 14 : 12
  const borderColor = isSelected ? '#ea580c' : 'white'

  return L.divIcon({
    html: `<div style="display: flex; flex-direction: column; align-items: center;">
      <div style="
        font-size: 10px;
        font-weight: 500;
        color: ${isSelected ? '#c2410c' : '#333'};
        background-color: ${isSelected ? 'rgba(255, 237, 213, 0.95)' : 'rgba(255, 255, 255, 0.9)'};
        padding: 1px 4px;
        border-radius: 3px;
        white-space: nowrap;
        border: 1px solid ${isSelected ? '#f97316' : '#ccc'};
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        margin-bottom: 2px;
      ">${label}</div>
      <div style="
        width: ${size}px;
        height: ${size}px;
        background-color: ${color};
        border-radius: 50%;
        border: 2px solid ${borderColor};
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>
    </div>`,
    className: 'coordinate-marker',
    iconSize: [size, 30],
    iconAnchor: [size / 2, 30],
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

// 実測記録用マーカーアイコン (点名 + 下段に補正後標高)
// isAsbuilt=true (出来形) は緑、false (起工) は青。
function createStakingIcon(
  name: string,
  correctedZ: number | null,
  isAsbuilt: boolean,
): L.DivIcon {
  const dotColor = isAsbuilt ? '#059669' : '#2563eb'
  const nameColor = isAsbuilt ? '#065f46' : '#1e3a8a'
  const zText = correctedZ != null && Number.isFinite(correctedZ) ? correctedZ.toFixed(3) : '-'
  return L.divIcon({
    html: `<div style="display:flex; flex-direction:column; align-items:center; line-height:1.05;">
      <div style="
        font-size: 10px;
        font-weight: 600;
        color: ${nameColor};
        background-color: rgba(255, 255, 255, 0.9);
        padding: 1px 4px;
        border-radius: 3px;
        white-space: nowrap;
        border: 1px solid ${dotColor};
        box-shadow: 0 1px 2px rgba(0,0,0,0.2);
        margin-bottom: 2px;
      ">${name || '(名無し)'}</div>
      <div style="
        width: 10px;
        height: 10px;
        background-color: ${dotColor};
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      "></div>
      <div style="
        font-size: 10px;
        font-weight: 600;
        color: #1e293b;
        background-color: rgba(255, 255, 255, 0.9);
        padding: 1px 4px;
        border-radius: 3px;
        white-space: nowrap;
        border: 1px solid #cbd5e1;
        box-shadow: 0 1px 2px rgba(0,0,0,0.2);
        margin-top: 2px;
      ">${zText}</div>
    </div>`,
    className: 'staking-marker',
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

// 管切り替え点用の〇マーカーアイコンを生成
function createPipeChangeIcon(label: string): L.DivIcon {
  return L.divIcon({
    html: `<div style="display: flex; flex-direction: column; align-items: center;">
      <div style="
        font-size: 10px;
        font-weight: 600;
        color: #b45309;
        background-color: rgba(254, 243, 199, 0.95);
        padding: 2px 6px;
        border-radius: 4px;
        white-space: nowrap;
        border: 1px solid #f59e0b;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        margin-bottom: 3px;
      ">${label}</div>
      <div style="
        width: 16px;
        height: 16px;
        background-color: transparent;
        border-radius: 50%;
        border: 3px solid #f59e0b;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      "></div>
    </div>`,
    className: 'pipe-change-marker',
    iconSize: [16, 40],
    iconAnchor: [8, 40],
  })
}

export function PipeMap({
  selectedPipeId,
  selectedPipeIds = new Set(),
  assignedPipeIds = new Set(),
  highlightPipeIds = new Set(),
  focusedPipeId = null,
  focusedPoint = null,
  onPipeSelect,
  onVertexClick,
  onJunctionSplitClick,
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
  selectedPointIds = new Set(),
  selectedPointRoute = [],
  showSelectedRoute = true,
  baseLayer = 'osm',
  pipeChangePoints = [],
  importPreviewLines = [],
  onPreviewClick,
  highlightedVertex = null,
  showPipeSpecs = false,
  hidePipePopup = false,
  showStakingRecords = false,
  stakingZOffset = 0,
  planOverlay,
}: PipeMapProps) {
  const { pipes } = useUnderdrainStore()
  const { zone, coordinates } = useCoordinateStore()
  const workAreas = useWorkAreaStore((state) => state.workAreas['underdrain'] ?? EMPTY_WORK_AREAS)
  const stakingRecords = useStakingStore((s) => s.records)

  const converter = new CoordinateConverter(zone)

  // 管路をポリラインデータに変換
  const pipeLines: PipeLineData[] = pipes
    .map((pipe): PipeLineData | null => {
      const positions = pipe.vertices
        .map(v => vertexToLatLng(v, converter))
        .filter((p): p is [number, number] => p !== null)

      if (positions.length < 2) return null

      // 頂点座標から実延長を計算
      let vertexLength = 0
      for (let i = 1; i < pipe.vertices.length; i++) {
        const a = pipe.vertices[i - 1]
        const b = pipe.vertices[i]
        vertexLength += Math.hypot(b.x - a.x, b.y - a.y)
      }

      return {
        id: pipe.id,
        number: pipe.number,
        pipeType: pipe.pipeType,
        diameter: pipe.diameter,
        positions,
        color: PIPE_COLORS[pipe.pipeType || 'default'] || PIPE_COLORS.default,
        weight: getDiameterWeight(pipe.diameter),
        measuredLength: pipe.measuredLength,
        designLength: pipe.designLength,
        vertexLength,
      }
    })
    .filter((p): p is PipeLineData => p !== null)

  // 取込プレビュー: ポリライン化
  const previewLineData = importPreviewLines
    .map((line) => {
      const positions = line.vertices
        .map((v) => vertexToLatLng(v, converter))
        .filter((p): p is [number, number] => p !== null)
      if (positions.length < 2) return null
      return {
        tempId: line.tempId,
        positions,
        selected: line.selected,
        label: line.label ?? null,
      }
    })
    .filter(
      (p): p is {
        tempId: string
        positions: [number, number][]
        selected: boolean
        label: string | null
      } => p !== null,
    )

  const importPreviewPositions = previewLineData.flatMap((l) => l.positions)

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
      maxZoom={24}
      className={`h-full w-full ${isBulkEditMode ? 'cursor-crosshair' : ''}`}
      style={{ minHeight: '400px' }}
    >
      {baseLayer === 'osm' && (
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={24}
          maxNativeZoom={19}
        />
      )}
      {baseLayer === 'gsi-photo' && (
        <TileLayer
          attribution='&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>'
          url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
          maxZoom={24}
          maxNativeZoom={18}
        />
      )}
      {baseLayer === 'gsi-std' && (
        <TileLayer
          attribution='&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>'
          url="https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"
          maxZoom={24}
          maxNativeZoom={18}
        />
      )}

      {focusedPipeId ? (
        <FocusPipe pipeLines={pipeLines} focusedPipeId={focusedPipeId} />
      ) : (
        <MapViewManager pipeLines={pipeLines} />
      )}

      <InvalidateOnResize />
      <FocusPoint point={focusedPoint} converter={converter} />

      {/* 施工計画: 選択配線の測点・区間ラベル */}
      {planOverlay && (
        <>
          {planOverlay.points.map((p) => {
            const { lat, lng } = converter.toLatLng(p.x, p.y)
            const lines: string[] = []
            if (planOverlay.flags.showGround && p.groundHeight != null) {
              lines.push(`<div style="color:#111827">${p.groundHeight.toFixed(3)}</div>`)
            }
            if (planOverlay.flags.showPlanned && p.plannedHeight != null) {
              lines.push(`<div style="color:#dc2626">${p.plannedHeight.toFixed(3)}</div>`)
            }
            if (planOverlay.flags.showCut && p.cutDepth != null) {
              lines.push(`<div style="color:#2563eb">${p.cutDepth.toFixed(3)}</div>`)
            }
            if (lines.length === 0) return null
            const html = `<div style="background:rgba(255,255,255,0.9);border:1px solid #cbd5e1;border-radius:4px;padding:2px 5px;font-family:ui-monospace,monospace;font-size:13px;line-height:1.15;white-space:nowrap;text-align:right;box-shadow:0 1px 2px rgba(0,0,0,0.1);">${lines.join('')}</div>`
            const icon = L.divIcon({
              className: 'plan-overlay-point',
              html,
              iconSize: undefined as unknown as [number, number],
              iconAnchor: [-6, 10],
            })
            return (
              <Marker
                key={`plan-pt-${p.id}`}
                position={[lat, lng]}
                icon={icon}
                interactive={false}
              />
            )
          })}
          {planOverlay.segments.map((s, i) => {
            // 各項目を 1 行ずつの div にして 縦積み (向きは水平のまま)。
            const lines: string[] = []
            if (planOverlay.flags.showDiameter && s.diameter != null) {
              lines.push(`<div style="color:#7c3aed">φ${s.diameter}</div>`)
            }
            if (planOverlay.flags.showSlope && s.slope) {
              lines.push(`<div style="color:#166534">${s.slope}</div>`)
            }
            if (planOverlay.flags.showDistance && s.distance != null) {
              lines.push(`<div style="color:#334155">${s.distance.toFixed(1)}m</div>`)
            }
            if (lines.length === 0) return null
            const mx = (s.x1 + s.x2) / 2
            const my = (s.y1 + s.y2) / 2
            const { lat, lng } = converter.toLatLng(mx, my)
            const html = `<div style="
              display:inline-flex;
              flex-direction:column;
              align-items:center;
              background:rgba(255,255,255,0.85);
              border:1px solid #cbd5e1;
              border-radius:4px;
              padding:2px 5px;
              font-family:ui-monospace,monospace;
              font-size:12px;
              line-height:1.15;
              white-space:nowrap;
              transform:translate(-50%,-50%);
              transform-origin:center center;
            ">${lines.join('')}</div>`
            const icon = L.divIcon({
              className: 'plan-overlay-segment',
              html,
              iconSize: undefined as unknown as [number, number],
              iconAnchor: [0, 0],
            })
            return (
              <Marker
                key={`plan-seg-${i}`}
                position={[lat, lng]}
                icon={icon}
                interactive={false}
              />
            )
          })}
        </>
      )}

      <FitImportPreview positions={importPreviewPositions} />

      {/* DXF 取込前の候補プレビュー（インポート確定前の仮表示） */}
      {previewLineData.flatMap((line) => {
        // 線の中点 (or 頂点の中央) にラベルを置く
        const midIdx = Math.floor(line.positions.length / 2)
        const midPos = line.positions[midIdx]
        const nodes = [
          <Polyline
            key={`import-preview-${line.tempId}`}
            positions={line.positions}
            pathOptions={{
              color: line.selected ? '#2563eb' : '#94a3b8',
              weight: line.selected ? 3 : 2,
              opacity: line.selected ? 0.9 : 0.5,
              dashArray: '6, 4',
              interactive: false,
            }}
          />,
        ]
        if (onPreviewClick) {
          nodes.push(
            <Polyline
              key={`import-preview-hit-${line.tempId}`}
              positions={line.positions}
              pathOptions={{
                color: '#000',
                weight: 20,
                opacity: 0,
              }}
              eventHandlers={{
                click: () => onPreviewClick(line.tempId),
              }}
            />,
          )
        }
        if (line.label && midPos) {
          nodes.push(
            <Marker
              key={`import-preview-label-${line.tempId}`}
              position={midPos}
              icon={createLabelIcon(
                line.label,
                line.selected ? '#2563eb' : '#94a3b8',
              )}
              interactive={false}
            />,
          )
        }
        return nodes
      })}

      {/* 管路ポリライン */}
      {pipeLines.map((pipe) => {
        const isSelected = pipe.id === selectedPipeId
        const isMultiSelected = selectedPipeIds.has(pipe.id)
        const isAssigned = assignedPipeIds.has(pipe.id)
        const isHighlighted = highlightPipeIds.has(pipe.id)
        const MERGE_SELECTED_COLOR = '#a855f7' // 紫色（結合選択用）
        const ASSIGNED_COLOR = '#eab308' // 黄色（設定済み管路用）
        const HIGHLIGHT_COLOR = '#f97316' // オレンジ（系統等の強調表示用）

        // 色の決定
        const getColor = () => {
          if (isSelected) return SELECTED_COLOR
          if (editMode === 'merge' && isMultiSelected) return MERGE_SELECTED_COLOR
          if (isHighlighted) return HIGHLIGHT_COLOR
          if (isAssigned) return ASSIGNED_COLOR
          return pipe.color
        }

        // 太さの決定
        const getWeight = () => {
          if (isSelected) return pipe.weight + 2
          if (editMode === 'merge' && isMultiSelected) return pipe.weight + 2
          if (isHighlighted) return pipe.weight + 2
          return pipe.weight
        }

        // ポップアップに表示する延長: 設計延長 > 実測延長 > 頂点座標から計算
        const displayLength =
          pipe.designLength != null && Number.isFinite(pipe.designLength)
            ? { value: pipe.designLength, source: '設計' }
            : pipe.measuredLength != null && Number.isFinite(pipe.measuredLength)
            ? { value: pipe.measuredLength, source: '実測' }
            : { value: pipe.vertexLength, source: '計算' }

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
          >
            {/* 一括訂正モード中はクリックのたびに詳細ポップアップを開かない
                （毎回開くと訂正操作の邪魔になるため）。
                hidePipePopup が true の呼び出し元 (例: 施工計画) では常に非表示。 */}
            {!isBulkEditMode && !hidePipePopup && (
              <Popup>
                <div className="text-xs space-y-0.5">
                  <div className="font-bold text-sm" style={{ color: pipe.color }}>
                    {pipe.number}
                  </div>
                  <div>
                    <span className="text-slate-500">管種: </span>
                    <span className="font-medium">{pipeTypeLabel(pipe.pipeType)}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">延長: </span>
                    <span className="font-mono">{displayLength.value.toFixed(2)} m</span>
                    <span className="text-slate-400 ml-1">({displayLength.source})</span>
                  </div>
                  <div>
                    <span className="text-slate-500">管径: </span>
                    <span className="font-mono">
                      {pipe.diameter != null ? `${pipe.diameter} mm` : '未設定'}
                    </span>
                  </div>
                </div>
              </Popup>
            )}
          </Polyline>
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

            // 終点は矢印マーカー (合流部で複数管の矢印が重ならないよう少し上流側へ)
            if (isEnd && pipe.positions.length >= 2) {
              const prevPos = pipe.positions[pipe.positions.length - 2]
              const angle = calculateAngle(prevPos, pos)
              const arrowPos = offsetTowardsPrev(pos, prevPos)
              return (
                <Marker
                  key={`${pipe.id}-${idx}`}
                  position={arrowPos}
                  icon={createArrowIcon(angle, SELECTED_COLOR, true)}
                />
              )
            }

            // 始点と中間点は円マーカー
            const isHighlighted =
              highlightedVertex != null &&
              highlightedVertex.pipeId === pipe.id &&
              highlightedVertex.vertexIdx === idx
            return (
              <CircleMarker
                key={`${pipe.id}-${idx}`}
                center={pos}
                radius={isHighlighted ? 11 : (isSplitMode && canSplit ? 8 : (isStart ? 7 : 5))}
                pathOptions={{
                  color: isHighlighted ? '#dc2626' : (canSplit ? '#f97316' : SELECTED_COLOR),
                  fillColor: isHighlighted ? '#fbbf24' : (canSplit ? '#f97316' : (isStart ? SELECTED_COLOR : '#fff')),
                  fillOpacity: 1,
                  weight: isHighlighted ? 3 : 2,
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
              />
            )
          })
        )}

      {/* 表内タップで指定された頂点を強調表示 (常時、選択管路と独立) */}
      {highlightedVertex && (() => {
        const pipe = pipeLines.find((p) => p.id === highlightedVertex.pipeId)
        if (!pipe) return null
        const pos = pipe.positions[highlightedVertex.vertexIdx]
        if (!pos) return null
        return (
          <CircleMarker
            key={`hl-${highlightedVertex.pipeId}-${highlightedVertex.vertexIdx}`}
            center={pos}
            radius={13}
            pathOptions={{
              color: '#dc2626',
              fillColor: '#fde047',
              fillOpacity: 0.9,
              weight: 4,
            }}
            interactive={false}
          />
        )
      })()}

      {/* 分割モードでの合流点マーカー（選択中管路上にある他の管路の端点） */}
      {editMode === 'split' && selectedPipeId && (() => {
        const selectedPipe = pipes.find(p => p.id === selectedPipeId)
        if (!selectedPipe || selectedPipe.vertices.length < 2) return null

        // 選択中の管路上にある他の管路の端点を探す
        const junctionPoints: { x: number; y: number; pipeNumber: string }[] = []
        const threshold = 0.5 // 50cm以内

        for (const otherPipe of pipes) {
          if (otherPipe.id === selectedPipeId) continue
          if (otherPipe.vertices.length < 2) continue

          // 他の管路の両端点をチェック
          const endpoints = [
            otherPipe.vertices[0],
            otherPipe.vertices[otherPipe.vertices.length - 1],
          ]

          for (const endpoint of endpoints) {
            // この端点が選択中の管路上にあるかチェック
            for (let i = 0; i < selectedPipe.vertices.length - 1; i++) {
              const v1 = selectedPipe.vertices[i]
              const v2 = selectedPipe.vertices[i + 1]

              const dx = v2.x - v1.x
              const dy = v2.y - v1.y
              const lengthSq = dx * dx + dy * dy
              if (lengthSq === 0) continue

              // 線分上の最近点を計算
              let t = ((endpoint.x - v1.x) * dx + (endpoint.y - v1.y) * dy) / lengthSq
              t = Math.max(0, Math.min(1, t))

              const nearestX = v1.x + t * dx
              const nearestY = v1.y + t * dy
              const dist = Math.sqrt(
                Math.pow(endpoint.x - nearestX, 2) + Math.pow(endpoint.y - nearestY, 2)
              )

              // 閾値内で、かつ既存の頂点とは離れている場合（端点では分割不可）
              if (dist <= threshold) {
                // 選択中管路の端点でないことを確認
                const isAtEndpoint = selectedPipe.vertices.some((v, idx) => {
                  if (idx === 0 || idx === selectedPipe.vertices.length - 1) {
                    const d = Math.sqrt(Math.pow(v.x - endpoint.x, 2) + Math.pow(v.y - endpoint.y, 2))
                    return d < 0.1
                  }
                  return false
                })

                if (!isAtEndpoint) {
                  // 重複チェック
                  const isDuplicate = junctionPoints.some(jp =>
                    Math.sqrt(Math.pow(jp.x - endpoint.x, 2) + Math.pow(jp.y - endpoint.y, 2)) < 0.1
                  )
                  if (!isDuplicate) {
                    junctionPoints.push({
                      x: endpoint.x,
                      y: endpoint.y,
                      pipeNumber: otherPipe.number,
                    })
                  }
                }
                break
              }
            }
          }
        }

        return junctionPoints.map((jp, idx) => {
          const { lat, lng } = converter.toLatLng(jp.x, jp.y)
          return (
            <CircleMarker
              key={`junction-${idx}`}
              center={[lat, lng]}
              radius={10}
              pathOptions={{
                color: '#16a34a',
                fillColor: '#22c55e',
                fillOpacity: 0.9,
                weight: 3,
              }}
              eventHandlers={{
                click: () => onJunctionSplitClick?.(selectedPipeId, { x: jp.x, y: jp.y }),
                mouseover: (e) => {
                  e.target.setStyle({ radius: 12, fillColor: '#15803d' })
                },
                mouseout: (e) => {
                  e.target.setStyle({ radius: 10, fillColor: '#22c55e' })
                },
              }}
            >
              <Popup>
                <div className="text-xs font-mono">
                  <div className="font-bold text-green-600">合流点で分割</div>
                  <div>接続管路: {jp.pipeNumber}</div>
                  <div className="mt-1 text-green-600">クリックで分割</div>
                </div>
              </Popup>
            </CircleMarker>
          )
        })
      })()}

      {/* 方向表示モード: 全管路の矢印 (下流端よりやや上流側に描画) */}
      {showDirection && pipeLines.map(pipe => {
        if (pipe.positions.length < 2) return null
        const isSelected = pipe.id === selectedPipeId
        // 選択中の管路は上で表示済みなのでスキップ
        if (isSelected) return null

        const lastPos = pipe.positions[pipe.positions.length - 1]
        const prevPos = pipe.positions[pipe.positions.length - 2]
        const angle = calculateAngle(prevPos, lastPos)
        const arrowPos = offsetTowardsPrev(lastPos, prevPos)

        return (
          <Marker
            key={`direction-${pipe.id}`}
            position={arrowPos}
            icon={createArrowIcon(angle, pipe.color, false)}
          />
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

      {/* 番号 / 管径等 ラベル表示モード */}
      {(showLabels || showPipeSpecs) && pipeLines.map(pipe => {
        if (pipe.positions.length < 2) return null

        // 管路の中央位置を計算
        const midIndex = Math.floor(pipe.positions.length / 2)
        const midPos = pipe.positions.length % 2 === 0
          ? [
              (pipe.positions[midIndex - 1][0] + pipe.positions[midIndex][0]) / 2,
              (pipe.positions[midIndex - 1][1] + pipe.positions[midIndex][1]) / 2,
            ] as [number, number]
          : pipe.positions[midIndex]

        // 管径 / 延長のサブラベル (φXX L=YY)。値がある部分だけ組み立て
        let subLabel: string | null = null
        if (showPipeSpecs) {
          const parts: string[] = []
          if (pipe.diameter != null) parts.push(`φ${pipe.diameter}`)
          const len = pipe.designLength ?? pipe.measuredLength ?? pipe.vertexLength
          if (len != null && Number.isFinite(len)) {
            parts.push(`L=${Math.round(len)}`)
          }
          if (parts.length > 0) subLabel = parts.join(' ')
        }
        const mainLabel = showLabels ? pipe.number : ''
        if (!mainLabel && !subLabel) return null

        return (
          <Marker
            key={`label-${pipe.id}`}
            position={midPos}
            icon={createLabelIcon(mainLabel, pipe.color, subLabel)}
            eventHandlers={{
              click: (e) => onPipeSelect?.(pipe.id, e.originalEvent.ctrlKey || e.originalEvent.metaKey),
            }}
          />
        )
      })}

      {/* 選択した点を結ぶルート */}
      {showSelectedRoute && selectedPointRoute.length >= 2 && (
        <Polyline
          positions={selectedPointRoute}
          pathOptions={{
            color: '#f97316',
            weight: 3,
            opacity: 0.8,
            dashArray: '8, 4',
          }}
        />
      )}

      {/* 測点表示モード */}
      {showSurveyPoints && surveyPoints.map(point => {
        const { lat, lng } = converter.toLatLng(point.x, point.y)
        // 選択中判定: SurveyPointData.isSelected または selectedPointIds に含まれる
        const isSelected = (point.isSelected ?? false) || selectedPointIds.has(point.id)
        return (
          <Marker
            key={`survey-${point.id}`}
            position={[lat, lng]}
            icon={createSurveyPointIcon(point.name, isSelected)}
            eventHandlers={selectablePoints && onPointClick ? {
              click: () => onPointClick(point.id),
            } : {}}
          />
        )
      })}

      {/* 区域ポリゴン表示（workAreaStoreから暗渠の工事区域） */}
      {showZones && workAreas.map((area, idx) => {
        const positions = area.points
          .filter((p): p is typeof p & { lat: number; lng: number } => p.lat !== null && p.lng !== null)
          .map(p => [p.lat, p.lng] as [number, number])

        if (positions.length < 3) return null

        const color = ZONE_COLORS[idx % ZONE_COLORS.length]

        return (
          <Polygon
            key={area.id}
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
                <div className="font-bold">{area.name}</div>
                <div>{positions.length}点で構成</div>
              </div>
            </Popup>
          </Polygon>
        )
      })}

      {/* 座標管理の点表示 */}
      {showCoordinates && coordinates.map(coord => {
        const { lat, lng } = converter.toLatLng(coord.x, coord.y)
        const isSelected = selectedPointIds.has(coord.id)
        return (
          <Marker
            key={`coord-${coord.id}`}
            position={[lat, lng]}
            icon={createCoordinateIcon(coord.pointNumber, coord.type, isSelected)}
            eventHandlers={selectablePoints && onPointClick ? {
              click: () => onPointClick(coord.id),
            } : {}}
          />
        )
      })}

      {/* 実測記録 (staking_records) マーカー — 点名 + 下段に補正後標高 */}
      {showStakingRecords && stakingRecords.map((r) => {
        if (r.measuredX == null || r.measuredY == null) return null
        let ll: { lat: number; lng: number }
        try {
          ll = converter.toLatLng(r.measuredX, r.measuredY)
        } catch {
          return null
        }
        if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null
        const rawZ = r.measuredZ
        const correctedZ = rawZ != null ? rawZ + stakingZOffset : null
        const isAsbuilt = r.surveyCategory === 'asbuilt'
        return (
          <Marker
            key={`staking-${r.id}`}
            position={[ll.lat, ll.lng]}
            icon={createStakingIcon(r.targetName ?? '', correctedZ, isAsbuilt)}
            interactive={false}
          />
        )
      })}

      {/* 管切り替え点（〇マーカー） */}
      {pipeChangePoints.map((point, idx) => {
        const { lat, lng } = converter.toLatLng(point.x, point.y)
        return (
          <Marker
            key={`pipe-change-${idx}`}
            position={[lat, lng]}
            icon={createPipeChangeIcon(point.label)}
          >
            <Popup>
              <div className="text-xs">
                <div className="font-bold text-amber-700">管切り替え点</div>
                <div>{point.label}</div>
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
