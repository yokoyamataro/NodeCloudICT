import type React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
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
import { useStakingStore } from '@/stores/stakingStore'
import { useWorkAreaStore, type WorkAreaPoint, type WorkAreaRow } from '@/stores/workAreaStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import { useConstructionPlanStore, type PlanPoint } from '@/stores/constructionPlanStore'
import { useOrthophotoStore } from '@/stores/orthophotoStore'
import { useOpenChannelStore } from '@/stores/openChannelStore'
import {
  buildSegments,
  pointAtDistance,
  sampleAlignment,
  tangentAtDistance,
  type AlignmentVertex,
} from '@/lib/openChannel/alignment'
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
  stakingRecords: boolean // 実測記録 (staking_records)
  workAreas: boolean
  route: boolean
  currentLocation: boolean
  orthophoto: boolean
  /**
   * 線形物 (open channel) の 中心線 + 幅杭点 + 線形点 (BP/IP/EP) を まとめて 表示。
   * 3 種類 は 1 トグルで 制御 (画面クラッター 抑制 のため 個別 サブトグルは 省略)。
   */
  openChannels: boolean
}

interface UnifiedFieldMapProps {
  baseLayer?: BaseLayerType
  layers: LayerVisibility
  /** オルソタイル取得用の工区ID（指定時のみオルソを読み込む） */
  farmId?: string | null
  /** MapContainer の中に追加で差し込むレイヤ (地番マップ等) */
  children?: React.ReactNode
}

// === 色/スタイル定義 ===

// 座標種類ごとのマーカー色（CoordinateMap と揃える）
const COORDINATE_MARKER_COLORS: Record<string, string> = {
  control: '#ef4444',
  boundary: '#3b82f6',
  current: '#14b8a6',
  underdrain: '#22c55e',
  soil_import: '#f59e0b',
  stake: '#22c55e',
  map_xml: '#a855f7',
  national_survey: '#d97706',
  cadastral_diagram: '#0891b2',
  witness: '#eab308',
  confirmed_boundary: '#16a34a',
  measured: '#ec4899',
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
  boundary_survey: '#0ea5e9', // 境界測量: シアン
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

/**
 * 線形点 (BP / IP / EP) 用 の アイコン: 塗り丸 + 白ラベル。
 * 色は kind 毎 に 変える (BP=緑 / EP=赤 / IP=紫) 。
 */
function createChannelPointIcon(kind: 'BP' | 'IP' | 'EP'): L.DivIcon {
  const color = kind === 'BP' ? '#059669' : kind === 'EP' ? '#dc2626' : '#7c3aed'
  return L.divIcon({
    className: 'unified-map-oc-vertex',
    html: `<div style="display:flex;align-items:center;gap:3px;transform:translate(-9px,-9px)">
        <div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4)"></div>
        <div style="color:${color};font-weight:700;font-size:11px;text-shadow:0 0 3px #fff,0 0 3px #fff,0 0 3px #fff;line-height:1">${kind}</div>
      </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
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

// 選択配管用: 各頂点の詳細情報アイコン（測点/地盤高/計画高/切深）
function createVertexInfoIcon(content: {
  name: string
  groundHeight: number | null
  plannedHeight: number | null
  cutDepth: number | null
}): L.DivIcon {
  const fmt = (v: number | null): string => (v === null || v === undefined ? '-' : v.toFixed(3))
  return L.divIcon({
    className: 'pipe-point-info',
    html: `<div style="
      background: rgba(255,255,255,0.92);
      border: 1px solid #1d4ed8;
      border-radius: 4px;
      padding: 2px 4px;
      font-size: 10px;
      white-space: nowrap;
      line-height: 1.25;
      box-shadow: 0 1px 3px rgba(0,0,0,0.25);
      transform: translate(8px, -18px);
    ">
      <div style="font-weight:700;color:#1d4ed8">${content.name || '-'}</div>
      <div><span style="color:#92400e">地</span> ${fmt(content.groundHeight)}</div>
      <div><span style="color:#166534">計</span> ${fmt(content.plannedHeight)}</div>
      <div><span style="color:#7c2d12">切</span> ${fmt(content.cutDepth)}</div>
    </div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

// 選択配管用: 頂点間（区間）の距離・勾配ラベル
function createSegmentInfoIcon(content: {
  distance: number | null
  slope: string | null
}): L.DivIcon {
  const dist = content.distance === null ? '-' : `${content.distance.toFixed(2)} m`
  const slope = content.slope ?? '-'
  return L.divIcon({
    className: 'pipe-segment-info',
    html: `<div style="
      background: rgba(255,255,255,0.88);
      border: 1px solid #10b981;
      border-radius: 3px;
      padding: 1px 4px;
      font-size: 9px;
      color: #065f46;
      white-space: nowrap;
      line-height: 1.2;
      transform: translate(-50%, -50%);
      box-shadow: 0 1px 2px rgba(0,0,0,0.15);
    ">
      ${dist} / ${slope}
    </div>`,
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

// 地図の空白部分クリックで選択解除
function MapBackgroundClick({ onClick }: { onClick: () => void }) {
  const map = useMap()
  useEffect(() => {
    const handler = () => onClick()
    map.on('click', handler)
    return () => {
      map.off('click', handler)
    }
  }, [map, onClick])
  return null
}


export function UnifiedFieldMap({ baseLayer = 'osm', layers, farmId, children }: UnifiedFieldMapProps) {
  const { coordinates, zone, route } = useCoordinateStore()
  const { pipes } = useUnderdrainStore()
  const workAreasByType = useWorkAreaStore((state) => state.workAreas)
  const { surveyData } = useSurveyStore()
  const stakingRecords = useStakingStore((s) => s.records)
  const fetchStakingRecords = useStakingStore((s) => s.fetchRecords)
  useEffect(() => {
    if (farmId) void fetchStakingRecords(farmId)
  }, [farmId, fetchStakingRecords])
  const planGroups = useConstructionPlanStore((s) => s.planGroups)
  const {
    byFarm: orthoByFarm,
    fetchByFarm: fetchOrthos,
    tileUrlTemplate: getOrthoUrl,
  } = useOrthophotoStore()
  const openChannels = useOpenChannelStore((s) => s.channels)
  const fetchOpenChannels = useOpenChannelStore((s) => s.fetchChannels)
  useEffect(() => {
    if (farmId) void fetchOpenChannels(farmId)
  }, [farmId, fetchOpenChannels])

  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // オルソタイルを工区単位で読み込む
  useEffect(() => {
    if (farmId) fetchOrthos(farmId)
  }, [farmId, fetchOrthos])
  const farmOrthos = useMemo(
    () => (farmId ? orthoByFarm.get(farmId) ?? [] : []),
    [orthoByFarm, farmId],
  )

  // 選択中の配管（クリックで選択）
  const [selectedPipeId, setSelectedPipeId] = useState<string | null>(null)

  // 配管ID → (頂点インデックス → PlanPoint) のルックアップ
  const pipeVertexInfoMap = useMemo(() => {
    const map = new Map<string, Map<number, PlanPoint>>()
    const EPS = 1e-4
    for (const group of planGroups) {
      for (const row of group.rows) {
        // 吸水管: 順に対応
        if (row.absorptionPipeId) {
          const pipe = pipes.find((p) => p.id === row.absorptionPipeId)
          if (pipe) {
            const inner = map.get(row.absorptionPipeId) ?? new Map<number, PlanPoint>()
            const limit = Math.min(row.absorptionPoints.length, pipe.vertices.length)
            for (let i = 0; i < limit; i++) {
              inner.set(i, row.absorptionPoints[i])
            }
            map.set(row.absorptionPipeId, inner)
          }
        }
        // 集水管: 座標マッチで頂点検出
        if (row.collectorPipeId && row.collectorPoint) {
          const pipe = pipes.find((p) => p.id === row.collectorPipeId)
          if (pipe) {
            const inner = map.get(row.collectorPipeId) ?? new Map<number, PlanPoint>()
            for (let i = 0; i < pipe.vertices.length; i++) {
              const v = pipe.vertices[i]
              if (
                Math.abs(v.x - row.collectorPoint.x) < EPS &&
                Math.abs(v.y - row.collectorPoint.y) < EPS
              ) {
                inner.set(i, row.collectorPoint)
                break
              }
            }
            map.set(row.collectorPipeId, inner)
          }
        }
      }
    }
    return map
  }, [planGroups, pipes])

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

  // 実測記録 (staking_records) を lat/lng に変換
  const stakingMarkers = useMemo(() => {
    type SM = {
      id: string
      name: string
      ll: [number, number]
      isAsbuilt: boolean
    }
    const out: SM[] = []
    for (const r of stakingRecords) {
      if (r.measuredX == null || r.measuredY == null) continue
      try {
        const { lat, lng } = converter.toLatLng(r.measuredX, r.measuredY)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
        out.push({
          id: r.id,
          name: r.targetName ?? '(名無し)',
          ll: [lat, lng],
          isAsbuilt: r.surveyCategory === 'asbuilt',
        })
      } catch {
        /* skip */
      }
    }
    return out
  }, [stakingRecords, converter])

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

  // 線形物 (open channel) の 中心線 / 幅杭 / 線形点 (BP/IP/EP) を LatLng に 変換。
  // alignmentPoints は 座標 ID 参照 なので coordinates で 解決 する。
  // kind は 位置 (先頭=BP / 末尾=EP / それ以外=IP) で 自動判定。
  const openChannelRenders = useMemo(() => {
    type ChRender = {
      channelId: string
      channelName: string
      line: [number, number][]
      alignmentPoints: { id: string; ll: [number, number]; label: 'BP' | 'IP' | 'EP' }[]
      widthStakes: { id: string; ll: [number, number]; offset: number; note: string | null }[]
    }
    const out: ChRender[] = []
    for (const ch of openChannels) {
      // 頂点 (BP/IP/EP) を 座標 テーブル から 解決。 未解決 は スキップ。
      const vertices: AlignmentVertex[] = []
      const alignmentMarkers: ChRender['alignmentPoints'] = []
      const total = ch.alignmentPoints.length
      for (let i = 0; i < total; i++) {
        const p = ch.alignmentPoints[i]
        const c = coordinates.find((cc) => cc.id === p.coordId)
        if (!c) continue
        const kind: 'BP' | 'IP' | 'EP' =
          total <= 1 || i === 0 ? 'BP' : i === total - 1 ? 'EP' : 'IP'
        vertices.push({
          x: c.x,
          y: c.y,
          kind: kind.toLowerCase() as AlignmentVertex['kind'],
          radius: p.radius,
          spiralAIn: p.spiralAIn,
          spiralAOut: p.spiralAOut,
        })
        try {
          const ll = converter.toLatLng(c.x, c.y)
          if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
            alignmentMarkers.push({
              id: `${ch.id}-v-${i}`,
              ll: [ll.lat, ll.lng],
              label: kind,
            })
          }
        } catch {
          /* skip */
        }
      }
      if (vertices.length < 2) {
        // 頂点 1 個 のみでも BP マーカーだ け 出しておく
        out.push({
          channelId: ch.id,
          channelName: ch.name,
          line: [],
          alignmentPoints: alignmentMarkers,
          widthStakes: [],
        })
        continue
      }
      // 中心線 (サンプリング + LatLng 化)
      const sampled = sampleAlignment(vertices, 32)
      const line: [number, number][] = []
      for (const p of sampled) {
        try {
          const ll = converter.toLatLng(p.x, p.y)
          if (Number.isFinite(ll.lat) && Number.isFinite(ll.lng)) {
            line.push([ll.lat, ll.lng])
          }
        } catch {
          /* skip */
        }
      }
      // 幅杭 (中心線 に 垂直、 右手 = CCW 90°、 sideOrientation='reverse' で 反転)
      const segments = buildSegments(vertices)
      const sign = ch.sideOrientation === 'reverse' ? -1 : 1
      const widthStakes: ChRender['widthStakes'] = []
      for (const s of ch.widthStakes) {
        const c = pointAtDistance(segments, s.distance)
        const t = tangentAtDistance(segments, s.distance)
        if (!c || !t) continue
        const px = c.x - t.y * sign * s.offset
        const py = c.y + t.x * sign * s.offset
        try {
          const ll = converter.toLatLng(px, py)
          if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) continue
          widthStakes.push({
            id: s.id,
            ll: [ll.lat, ll.lng],
            offset: s.offset,
            note: s.note ?? null,
          })
        } catch {
          /* skip */
        }
      }
      out.push({
        channelId: ch.id,
        channelName: ch.name,
        line,
        alignmentPoints: alignmentMarkers,
        widthStakes,
      })
    }
    return out
  }, [openChannels, coordinates, converter])

  // 初期表示の境界（座標点・配管・工事区域・測量点・線形物 を包含）
  const allBounds = useMemo(() => {
    const all: [number, number][] = []
    for (const c of validCoords) all.push([c.lat, c.lng])
    for (const p of pipeLines) all.push(...p.positions)
    for (const a of workAreas) all.push(...a.positions)
    for (const s of surveyMarkers) all.push(s.ll)
    for (const ch of openChannelRenders) {
      all.push(...ch.line)
      for (const v of ch.alignmentPoints) all.push(v.ll)
      for (const s of ch.widthStakes) all.push(s.ll)
    }
    if (all.length === 0) return null
    const lats = all.map((p) => p[0])
    const lngs = all.map((p) => p[1])
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)])
  }, [validCoords, pipeLines, workAreas, surveyMarkers, openChannelRenders])

  const defaultCenter: [number, number] = [35.6762, 139.6503]
  const initialCenter = allBounds
    ? ([(allBounds.getNorth() + allBounds.getSouth()) / 2, (allBounds.getEast() + allBounds.getWest()) / 2] as [
        number,
        number,
      ])
    : defaultCenter

  return (
    <MapContainer center={initialCenter} zoom={15} maxZoom={24} className="h-full w-full">
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
          attribution='&copy; 国土地理院'
          url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
          maxZoom={24}
          maxNativeZoom={18}
        />
      )}
      {baseLayer === 'gsi-std' && (
        <TileLayer
          attribution='&copy; 国土地理院'
          url="https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png"
          maxZoom={24}
          maxNativeZoom={18}
        />
      )}

      {/* オルソ画像（登録分を重ねて表示） */}
      {layers.orthophoto &&
        farmOrthos.map((ortho) => (
          <TileLayer
            key={`ortho-${ortho.id}`}
            url={getOrthoUrl(ortho)}
            minZoom={ortho.minZoom}
            maxZoom={24}
            maxNativeZoom={ortho.maxZoom}
            opacity={ortho.opacity}
            bounds={[
              [ortho.bounds.south, ortho.bounds.west],
              [ortho.bounds.north, ortho.bounds.east],
            ]}
            zIndex={300}
          />
        ))}

      <FitBoundsOnce bounds={allBounds} />
      <MapViewPersist />
      <MapBackgroundClick onClick={() => setSelectedPipeId(null)} />

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
        pipeLines.map((pl) => {
          const isSelected = selectedPipeId === pl.id
          return (
            <Polyline
              key={`pipe-${pl.id}`}
              positions={pl.positions}
              pathOptions={{
                color: pl.color,
                weight: isSelected ? pl.weight + 3 : pl.weight,
                opacity: isSelected ? 1 : 0.9,
              }}
              eventHandlers={{
                click: () => setSelectedPipeId((prev) => (prev === pl.id ? null : pl.id)),
              }}
            >
              <Tooltip sticky>
                {pl.number}
                {pl.pipeType ? ` (${pl.pipeType})` : ''}
              </Tooltip>
            </Polyline>
          )
        })}

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
              eventHandlers={{
                click: () => setSelectedPipeId((prev) => (prev === pl.id ? null : pl.id)),
              }}
            />
          )
        })}

      {/* 配管の測点（座標計算の C / B / A）: ドットのみ（選択配管のときは詳細表示が別レイヤーで上に乗る） */}
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
            <Tooltip>{s.pointNumber}</Tooltip>
          </CircleMarker>
        ))}

      {/* 実測記録 (staking_records) — 起工=青, 出来形=緑 */}
      {layers.stakingRecords &&
        stakingMarkers.map((s) => (
          <CircleMarker
            key={`staking-${s.id}`}
            center={s.ll}
            radius={4}
            pathOptions={{
              color: s.isAsbuilt ? '#065f46' : '#1e3a8a',
              fillColor: s.isAsbuilt ? '#34d399' : '#60a5fa',
              fillOpacity: 0.9,
              weight: 1.5,
            }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              {s.name}
              {s.isAsbuilt ? ' [出来形]' : ' [起工]'}
            </Tooltip>
          </CircleMarker>
        ))}

      {/* 選択配管の詳細表示: 各頂点に測点/地盤高/計画高/切深、区間に距離/勾配 */}
      {selectedPipeId && (() => {
        const pipe = pipes.find((p) => p.id === selectedPipeId)
        if (!pipe) return null
        const vInfo = pipeVertexInfoMap.get(selectedPipeId)
        const total = pipe.vertices.length
        if (total === 0) return null

        // generatePointName と同じ規則（B は下流起点）
        const generatePointName = (idx: number): string => {
          if (idx === 0) return `${pipe.number}C`
          if (idx === total - 1) return `${pipe.number}A`
          return `${pipe.number}B${total - 1 - idx}`
        }

        // 距離ヘルパー
        const dist = (i: number) => {
          if (i <= 0 || i >= total) return null
          const a = pipe.vertices[i - 1]
          const b = pipe.vertices[i]
          const dx = b.x - a.x
          const dy = b.y - a.y
          return Math.sqrt(dx * dx + dy * dy)
        }

        const elems: React.ReactElement[] = []

        // 頂点ごとの詳細マーカー
        for (let i = 0; i < total; i++) {
          const v = pipe.vertices[i]
          const ll = vertexToLatLng(v, converter)
          if (!ll) continue
          const pp = vInfo?.get(i) ?? null
          const gh = pp?.groundHeight ?? v.z ?? null
          const ph = pp?.plannedHeight ?? null
          const cd = pp?.cutDepth ?? (gh !== null && ph !== null ? gh - ph : null)
          const name = pp?.pointName || generatePointName(i)
          elems.push(
            <Marker
              key={`pv-info-${selectedPipeId}-${i}`}
              position={ll}
              icon={createVertexInfoIcon({
                name,
                groundHeight: gh,
                plannedHeight: ph,
                cutDepth: cd,
              })}
              interactive={false}
            />,
          )
        }

        // 区間ラベル（中点位置・距離/勾配）
        for (let i = 1; i < total; i++) {
          const a = pipe.vertices[i - 1]
          const b = pipe.vertices[i]
          const midX = (a.x + b.x) / 2
          const midY = (a.y + b.y) / 2
          const midLL = vertexToLatLng({ x: midX, y: midY }, converter)
          if (!midLL) continue
          const pp = vInfo?.get(i) ?? null
          const segDist = pp?.segmentDistance ?? dist(i)
          let segSlope: string | null = pp?.segmentSlope ?? null
          if (!segSlope) {
            const prev = vInfo?.get(i - 1) ?? null
            const ph1 = prev?.plannedHeight ?? null
            const ph2 = pp?.plannedHeight ?? null
            if (ph1 !== null && ph2 !== null && segDist && segDist > 0) {
              const diff = Math.abs(ph1 - ph2)
              if (diff > 0) segSlope = `1/${Math.round(segDist / diff)}`
            }
          }
          elems.push(
            <Marker
              key={`pv-seg-${selectedPipeId}-${i}`}
              position={midLL}
              icon={createSegmentInfoIcon({ distance: segDist, slope: segSlope })}
              interactive={false}
            />,
          )
        }

        return <>{elems}</>
      })()}

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

      {/* 線形物 (open channel): 中心線 + 幅杭 + BP/IP/EP マーカー */}
      {layers.openChannels &&
        openChannelRenders.flatMap((ch) => {
          const nodes: React.ReactNode[] = []
          if (ch.line.length >= 2) {
            nodes.push(
              <Polyline
                key={`oc-line-${ch.channelId}`}
                positions={ch.line}
                pathOptions={{ color: '#6366f1', weight: 3, opacity: 0.9 }}
              >
                <Tooltip sticky direction="top">
                  {ch.channelName}
                </Tooltip>
              </Polyline>,
            )
          }
          for (const s of ch.widthStakes) {
            nodes.push(
              <CircleMarker
                key={`oc-stake-${s.id}`}
                center={s.ll}
                radius={4}
                pathOptions={{
                  color: '#f59e0b',
                  weight: 1.5,
                  fillColor: '#fbbf24',
                  fillOpacity: 0.9,
                }}
              >
                <Tooltip direction="top">
                  幅杭 offset={s.offset >= 0 ? '+' : ''}
                  {s.offset.toFixed(2)}m{s.note ? ` (${s.note})` : ''}
                </Tooltip>
              </CircleMarker>,
            )
          }
          for (const v of ch.alignmentPoints) {
            nodes.push(
              <Marker
                key={`oc-v-${v.id}`}
                position={v.ll}
                icon={createChannelPointIcon(v.label)}
                interactive={true}
                zIndexOffset={500}
              >
                <Tooltip direction="top">
                  {ch.channelName} — {v.label}
                </Tooltip>
              </Marker>,
            )
          }
          return nodes
        })}

      {/* 現在位置（Geolocation） */}
      {layers.currentLocation && <CurrentLocationLayer />}

      {/* 呼び出し側が差し込む追加レイヤ (例: 法務省地図の地番ポリゴン) */}
      {children}
    </MapContainer>
  )
}
