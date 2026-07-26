import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, CircleMarker, Polyline, Polygon, Tooltip, Pane, Popup, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
// leaflet-rotate は Map クラスにパッチ (rotate オプション / setBearing) を当てる副作用付き import
import 'leaflet-rotate'
import {
  ArrowLeft,
  ArrowUp,
  Loader2,
  Circle as CircleIcon,
  Radio,
  Tag,
  Trash2,
  FileText,
  Database,
  Navigation2,
  Check,
  Camera,
  Upload,
  Download,
  Image as ImageIcon,
  X,
  Volume2,
  VolumeX,
  Plus,
  StickyNote,
  ExternalLink,
  Info,
  RefreshCw,
  AlertTriangle,
  Crosshair,
  Settings2,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { playStartChime, playStopChime, unlockAudio } from '@/lib/beep'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useFarmMemoStore, EMPTY_FARM_MEMOS } from '@/stores/farmMemoStore'
import { createMemoIcon, PhotoMarker } from '@/components/map/CoordinateMap'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import { useUnderdrainStore, type PipeRow, PIPE_TYPE_NAMES } from '@/stores/underdrainStore'
import { useStakingStore } from '@/stores/stakingStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { useExportRouteStore, type RoutePoint } from '@/stores/exportRouteStore'
import { useAuth } from '@/contexts/AuthContext'
import { loadSimaFile, downloadSimaFile } from '@/lib/sima-parser'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeLabel,
  getCoordinateTypeOptions,
} from '@/stores/coordinatePointTypeStore'
import { CoordinatePhotoModal } from '@/features/coordinates/CoordinatePhotoModal'
import { CoordinateCalcModal } from '@/features/coordinates/CoordinateCalcModal'
import { useAttachmentStore } from '@/stores/attachmentStore'
import { PhotoEditModal } from '@/features/coordinates/PhotoEditModal'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import {
  useParcelAttributeTypesStore,
  EMPTY_ATTRIBUTES,
} from '@/stores/parcelAttributeTypesStore'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { ParcelMapLayer, parcelFeatureKey } from '@/components/map/ParcelMapLayer'
import { MapDrawingLayer } from '@/components/map/MapDrawingLayer'
import { MapDrawingToolbar } from '@/components/map/MapDrawingToolbar'
import { useMapDrawingStore, type LineStyle } from '@/stores/mapDrawingStore'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'
import type { Feature, Polygon as GeoJsonPolygon } from 'geojson'
import { type Bbox } from '@/lib/tile-math'
import { importParcelBatch } from '@/features/parcel-maps/importParcelBatch'
import { Map as MapIcon } from 'lucide-react'
import { FeedbackButton } from '@/components/layout/FeedbackButton'
import { MobileHamburgerMenu } from './MobileHamburgerMenu'
import {
  MobileParcelListPanel,
  PARCEL_COLUMN_KEYS,
  type ParcelColumnKey,
} from './MobileParcelListPanel'
import { MobileParcelEditModal } from './MobileParcelEditModal'
import {
  MobileListColumnPicker,
  type ColumnDef,
} from './MobileListColumnPicker'
import { useOrthophotoStore } from '@/stores/orthophotoStore'
import { parseLandXml } from '@/lib/landxml/parser'
import {
  listLandxmlFiles,
  getActiveLandxmlFile,
  downloadLandxmlText,
  uploadLandxmlFile,
  setActiveLandxmlFile,
  deleteLandxmlFile,
  type LandxmlFileRow,
} from '@/lib/landxmlFiles'
import { indexTin, queryZ, type TinIndex, type TinSurfaceLike } from '@/lib/landxml/tinInterpolation'
import { buildTrenchTin } from '@/lib/landxml/surface'
import type { Alignment, AlignmentSegment } from '@/lib/landxml/types'
import type { Project, StakeStatus } from '@/types/database'
import {
  STAKE_STATUS_OPTIONS,
  STAKE_STATUS_LABEL,
  STAKE_STATUS_BADGE,
} from '@/types/database'

type TargetKind = 'coordinate' | 'pipe_vertex'

interface StakingTarget {
  id: string
  kind: TargetKind
  refId: string
  vertexIndex: number | null
  name: string
  x: number
  y: number
  z: number | null
  /** lat/lng（地図表示用） */
  lat: number
  lng: number
  /** 点種コード（coordinate: 'control'/'boundary'/'current' 等、pipe_vertex: PipeType） */
  subType: string
  /** 点種の表示名 */
  subTypeLabel: string
  /** 設置状態（coordinate のみ。pipe_vertex は 'unset' 相当） */
  stakeStatus: StakeStatus
}

// Haversine 距離（m）
function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6378137
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
  return R * c
}

// 真北基準の方位角（deg, 0–360）
function bearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const la1 = toRad(a.lat)
  const la2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(la2)
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng)
  const brng = toDeg(Math.atan2(y, x))
  return (brng + 360) % 360
}

function accuracyColor(acc: number | null): string {
  if (acc == null) return '#94a3b8'
  if (acc <= 0.05) return '#10b981' // green <= 5cm
  if (acc <= 0.2) return '#f59e0b' // amber <= 20cm
  if (acc <= 1) return '#f97316' // orange <= 1m
  return '#ef4444' // red
}

// この精度(m)以下のときだけ「FIX相当」とみなし、地図の自動追従・動的ズームに使う。
// これを超える（FIX解が外れて数m〜十数m飛ぶ）位置では地図を動かさず、画面を保持する。
const FOLLOW_FIX_THRESHOLD_M = 1.0

// RTK-FIX とみなす精度の既定値 (3cm)。ユーザーは設定で 0.02〜0.05m の範囲で変更可
const DEFAULT_FIX_ACCURACY_M = 0.03
const FIX_ACCURACY_MIN_M = 0.02
const FIX_ACCURACY_MAX_M = 0.05

// 一度 FIX に達した後、この精度(m)より悪い読みは短期間の "はずれ値" として棄却する。
// Android FLP が数十秒に一度ネットワーク測位を混ぜてくるケースへの緩和策。
const POST_FIX_REJECT_ACC_M = 0.50
// この回数を超えて連続で棄却が続いたら FIX 喪失とみなして受け入れる。
const MAX_CONSECUTIVE_REJECTS = 5

// 座標パネル: 表示列 定義
const COORD_COLUMN_KEYS = [
  'name',
  'xy',
  'z',
  'type',
  'stakeType',
  'stakeStatus',
  'photo',
  'updatedBy',
  'updatedAt',
] as const
type CoordColumnKey = (typeof COORD_COLUMN_KEYS)[number]

const COORD_COLUMNS: ReadonlyArray<ColumnDef<CoordColumnKey>> = [
  { key: 'name', label: '点名' },
  { key: 'xy', label: 'XY' },
  { key: 'z', label: 'Z' },
  { key: 'type', label: '点種' },
  { key: 'stakeType', label: '杭種' },
  { key: 'stakeStatus', label: '設置' },
  { key: 'photo', label: 'カメラ' },
  { key: 'updatedBy', label: '更新者' },
  { key: 'updatedAt', label: '更新日' },
]
const COORD_REQUIRED_KEYS: ReadonlyArray<CoordColumnKey> = ['name']

// 表示列の localStorage 永続化用 helper
const COORD_COLS_LS_PREFIX = 'mobile:coord-cols:'
const PARCEL_COLS_LS_PREFIX = 'mobile:parcel-cols:'
function loadColumnSet<K extends string>(
  key: string,
  fallback: ReadonlyArray<K>,
  validKeys: ReadonlyArray<K>,
): ReadonlySet<K> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return new Set(fallback)
    const arr = JSON.parse(raw) as string[]
    const valid = new Set(validKeys as ReadonlyArray<string>)
    const filtered = arr.filter((k) => valid.has(k)) as K[]
    return new Set(filtered.length > 0 ? filtered : fallback)
  } catch {
    return new Set(fallback)
  }
}
function saveColumnSet(key: string, set: ReadonlySet<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(set)))
  } catch {
    /* ignore quota */
  }
}

// 「ピッ」を count 回、短い間隔で鳴らす（Web Audio）
function playBeeps(ctx: AudioContext, count: number) {
  const now = ctx.currentTime
  for (let i = 0; i < count; i++) {
    const t = now + i * 0.14
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.value = 1400
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(t)
    osc.stop(t + 0.09)
  }
}

// 正規表現用エスケープ
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// 新点の採番モード
type NumberingMode = 'perPrefix' | 'global'

// {prefix}-{連番} の次の名前を返す。
//  perPrefix: 同じ頭文字ごとに採番（道路-1 の次に 境界-1）
//  global:    頭文字をまたいだ通し番号（道路-1 の次に 境界-2、番号は重複しない）
function nextNumberedName(
  prefix: string,
  existingNames: string[],
  mode: NumberingMode = 'perPrefix',
): string {
  const p = (prefix || '').trim() || '新点'
  let max = 0
  const re = mode === 'global' ? /-(\d+)$/ : new RegExp('^' + escapeRegExp(p) + '-(\\d+)$')
  for (const n of existingNames) {
    const m = n.match(re)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `${p}-${max + 1}`
}

// RTK が外れた時の警告音「ブッ」（短く控えめ）。
// 頻繁に外れる現場でうるさくならないよう、音量小・持続 0.12 秒に抑える。
function playBuzzer(ctx: AudioContext) {
  const t = ctx.currentTime
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sawtooth'
  osc.frequency.value = 240
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(0.13, t + 0.01)
  gain.gain.setValueAtTime(0.13, t + 0.09)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t)
  osc.stop(t + 0.15)
}

// 遅延読込のサムネ画像（点情報モーダル用）。signed URL を非同期で解決してから
// <img> を表示する。タップで onClick に photoId を返す。
function PointPhotoThumb({
  filePath,
  getSignedUrl,
  onClick,
}: {
  filePath: string
  getSignedUrl: (filePath: string) => Promise<string | null>
  onClick?: () => void
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void getSignedUrl(filePath).then((u) => {
      if (!cancelled) setUrl(u)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, getSignedUrl])
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full aspect-square rounded overflow-hidden bg-slate-200 hover:opacity-90"
    >
      {url ? (
        <img src={url} alt="" className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-slate-400 text-[10px]">
          読込中
        </div>
      )}
    </button>
  )
}

function FitOnce({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
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

// leaflet-rotate の bearing を方位センサー値に同期させる。
// enabled=false または heading=null の時は bearing=0 で北向きに戻す。
function MapBearingUpdater({
  enabled,
  heading,
}: {
  enabled: boolean
  heading: number | null
}) {
  const map = useMap() as L.Map & {
    setBearing?: (deg: number) => void
    getBearing?: () => number
  }
  useEffect(() => {
    if (typeof map.setBearing !== 'function') return
    const desired = enabled && heading != null ? -heading : 0
    try { map.setBearing(desired) } catch { /* ignore */ }
  }, [map, enabled, heading])
  return null
}

// 地図ズームを親の state に流すヘルパー
function ZoomWatcher({ onChange }: { onChange: (z: number) => void }) {
  const map = useMap()
  useEffect(() => {
    onChange(map.getZoom())
    const handler = () => onChange(map.getZoom())
    map.on('zoomend', handler)
    return () => {
      map.off('zoomend', handler)
    }
  }, [map, onChange])
  return null
}

// 地図の現在の表示範囲を親の state に流す。
// 大量マーカーの permanent tooltip を「画面内のものだけ」に絞るのに使う。
function BoundsWatcher({
  onChange,
}: {
  onChange: (b: L.LatLngBounds | null) => void
}) {
  const map = useMap()
  useEffect(() => {
    const update = () => onChange(map.getBounds())
    update()
    map.on('moveend', update)
    map.on('zoomend', update)
    return () => {
      map.off('moveend', update)
      map.off('zoomend', update)
    }
  }, [map, onChange])
  return null
}

// 工区メモのマーカー。長押し（contextmenu）で編集メニューを開き、
// ドラッグ移動 or 位置情報の削除ができる。写真マーカーの方の同種 UX と揃える。
function EditableMemoMarker({
  memo,
  onMove,
  onClearLocation,
}: {
  memo: {
    id: string
    lat: number
    lng: number
    content: string
  }
  onMove: (id: string, lat: number, lng: number) => void
  onClearLocation: (id: string) => void
}) {
  const [mode, setMode] = useState<'view' | 'menu' | 'dragging'>('view')
  const markerRef = useRef<L.Marker | null>(null)

  useEffect(() => {
    const m = markerRef.current
    if (!m) return
    if (mode === 'dragging') m.dragging?.enable()
    else m.dragging?.disable()
  }, [mode])

  return (
    <Marker
      ref={markerRef}
      position={[memo.lat, memo.lng]}
      icon={createMemoIcon()}
      zIndexOffset={mode === 'dragging' ? 900 : 500}
      eventHandlers={{
        contextmenu: (e) => {
          setMode('menu')
          ;(e.target as L.Marker).openPopup()
        },
        dragend: (e) => {
          const ll = (e.target as L.Marker).getLatLng()
          onMove(memo.id, ll.lat, ll.lng)
          setMode('view')
        },
        popupclose: () => {
          setMode((m) => (m === 'menu' ? 'view' : m))
        },
      }}
    >
      {mode === 'menu' ? (
        <Popup minWidth={200}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 2 }}>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 4 }}>メモの位置</div>
            <button
              type="button"
              onClick={() => {
                setMode('dragging')
                markerRef.current?.closePopup()
              }}
              style={{
                padding: '8px 12px',
                background: '#2563eb',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              位置を移動（ドラッグ）
            </button>
            <button
              type="button"
              onClick={() => {
                if (confirm('このメモの位置情報を削除しますか？（メモ本文は残ります）')) {
                  onClearLocation(memo.id)
                  markerRef.current?.closePopup()
                  setMode('view')
                }
              }}
              style={{
                padding: '8px 12px',
                background: '#dc2626',
                color: '#fff',
                border: 'none',
                borderRadius: 4,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              位置情報を削除
            </button>
          </div>
        </Popup>
      ) : (
        <Tooltip direction="top" offset={[0, -16]} className="staking-label-tooltip">
          <div style={{ maxWidth: 200, whiteSpace: 'pre-wrap' }}>
            {memo.content.length > 60 ? memo.content.slice(0, 60) + '…' : memo.content}
          </div>
        </Tooltip>
      )}
    </Marker>
  )
}

// 旧: 地図クリックで断面 2 点を拾うピッカー（座標 2 点を選ぶ方式に変更したため未使用）

function FollowCurrent({
  position,
  enabled,
}: {
  position: [number, number] | null
  enabled: boolean
}) {
  const map = useMap()
  useEffect(() => {
    if (!enabled || !position) return
    map.setView(position, Math.max(map.getZoom(), 18), { animate: true })
  }, [map, position, enabled])
  return null
}

// 「ターゲット選択時に一度だけ中心化」: フォローモードに関係なく
// 選択 ID が変わったタイミングで 1 回だけパン＋ズームする。
// target を毎レンダリング受け取り、id 変化時に最新位置を参照する。
// （ref 経由は子 effect が親 effect より先に走り旧位置を読む不具合があるため避ける）
function CenterOnSelect({
  target,
}: {
  target: { id: string; lat: number; lng: number } | null
}) {
  const map = useMap()
  const targetRef = useRef(target)
  targetRef.current = target
  const targetId = target?.id ?? null
  useEffect(() => {
    if (!targetId) return
    const t = targetRef.current
    if (!t || t.id !== targetId) return
    map.setView([t.lat, t.lng], Math.max(map.getZoom(), 18), { animate: true })
  }, [map, targetId])
  return null
}

type MapFollowMode = 'self' | 'off'

const MAP_FOLLOW_LABEL: Record<MapFollowMode, string> = {
  self: '自己位置中心（追尾）',
  off: '追尾なし',
}

const NEXT_FOLLOW_MODE: Record<MapFollowMode, MapFollowMode> = {
  self: 'off',
  off: 'self',
}

// 方位センサーの値（真北からの時計回り角度）を取得
// iOS: DeviceOrientationEvent.webkitCompassHeading（許可必須）
// Android Chrome: deviceorientationabsolute / event.alpha（左回りなので 360 - alpha）
function extractCompassHeading(e: DeviceOrientationEvent): number | null {
  // iOS Safari は webkitCompassHeading を提供（時計回り）
  const ios = (e as DeviceOrientationEvent & { webkitCompassHeading?: number })
    .webkitCompassHeading
  if (typeof ios === 'number' && Number.isFinite(ios)) return ios
  // Android: 'deviceorientationabsolute' で alpha が真北基準。
  // alpha は左回り（CCW）なので時計回りに直すため 360 - alpha
  if (e.absolute && typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
    return (360 - e.alpha) % 360
  }
  return null
}

// 方位コーンを描画する DivIcon を生成（heading: 度, 0=北, 時計回り）
function createHeadingIcon(heading: number): L.DivIcon {
  const svg = `
    <svg width="80" height="80" viewBox="0 0 80 80"
         style="transform: rotate(${heading}deg); transform-origin: 40px 40px;">
      <defs>
        <radialGradient id="cone" cx="50%" cy="100%" r="100%">
          <stop offset="0%" stop-color="#2563eb" stop-opacity="0.7"/>
          <stop offset="100%" stop-color="#2563eb" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <path d="M 40 40 L 16 4 A 36 36 0 0 1 64 4 Z" fill="url(#cone)" />
    </svg>
  `
  return L.divIcon({
    html: svg,
    className: 'heading-cone',
    iconSize: [80, 80],
    iconAnchor: [40, 40],
  })
}

export function MobileStakingPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const {
    setCurrentFarm,
    workAreaPolygons,
    fetchWorkAreaPolygons,
  } = useFarmStore()
  const {
    byProject: pointTypesByProject,
    fetchForProject: fetchPointTypes,
  } = useCoordinatePointTypeStore()
  const {
    setZone,
    fetchCoordinates,
    coordinates,
    importCoordinates,
    setStakeStatus,
    setCoordinateType,
    setNotes,
    setPointNumber: updatePointNumberStore,
    setStakeType: updateStakeTypeStore,
  } = useCoordinateStore()
  // 設置状態フィルタ（PC と共有。localStorage 永続化）
  const visibleStakeStatuses = useMapViewStore((s) => s.visibleStakeStatuses)
  const toggleVisibleStakeStatus = useMapViewStore((s) => s.toggleVisibleStakeStatus)
  const setVisibleStakeStatuses = useMapViewStore((s) => s.setVisibleStakeStatuses)
  // 工事区域は地図表示（ポリゴンレイヤ）にのみ使う。編集は PC 側のみ。
  const { workAreas: workAreasAll, fetchWorkAreas } = useWorkAreaStore()
  const fetchParcels = useParcelStore((s) => s.fetchByWorkAreaIds)
  const parcelAreas = workAreasAll['boundary_survey'] ?? []
  const {
    byEntity: attachmentsByEntity,
    fetchByEntityIds: fetchAttachments,
    uploadPhoto,
    getSignedUrl,
    removeAttachment,
  } = useAttachmentStore()
  const {
    byFarm: orthoByFarm,
    fetchByFarm: fetchOrthos,
    tileUrlTemplate: getOrthoUrl,
  } = useOrthophotoStore()
  const { fetchPipes, pipes } = useUnderdrainStore()
  const { records, fetchRecords, addRecord, deleteRecord, saving } = useStakingStore()
  const { user, profile } = useAuth()
  const userLabel = profile?.full_name?.trim() || (user?.email ? user.email.split('@')[0] : '')

  const [farm, setFarm] = useState<Farm | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const projectId = farm?.project_id ?? null

  // プロジェクトのカスタム点種を取得
  useEffect(() => {
    if (projectId) fetchPointTypes(projectId)
  }, [projectId, fetchPointTypes])

  // 現在位置（geolocation）
  const [currentPos, setCurrentPos] = useState<[number, number] | null>(null)
  const [currentAcc, setCurrentAcc] = useState<number | null>(null)
  const [currentAlt, setCurrentAlt] = useState<number | null>(null)
  // 地図追従用の「安定位置」: FIX相当の精度のときだけ更新する。
  // FIX が外れている間は値が変わらないので、地図は最後の良好位置のまま保持される。
  const [stablePos, setStablePos] = useState<[number, number] | null>(null)
  // 既定: 自己位置追尾は OFF にして、まず工区全体が画面内に収まる初期表示にする
  const [followMode, setFollowMode] = useState<MapFollowMode>('off')
  const [heading, setHeading] = useState<number | null>(null)
  const [headingEnabled, setHeadingEnabled] = useState(false)
  const [headingError, setHeadingError] = useState<string | null>(null)
  // 地図を進行方向に回す（コンパスに応じて .leaflet-container を CSS 回転）
  const [mapRotationEnabled, setMapRotationEnabled] = useState<boolean>(() => {
    try {
      return typeof localStorage !== 'undefined' &&
        localStorage.getItem('mobile:staking:mapRotation') === '1'
    } catch { return false }
  })
  useEffect(() => {
    try {
      localStorage.setItem('mobile:staking:mapRotation', mapRotationEnabled ? '1' : '0')
    } catch { /* ignore */ }
  }, [mapRotationEnabled])

  // 設定・UI
  const [avgSeconds, setAvgSeconds] = useState(3)
  // 画面モード: 起工測量のみに統一（出来形 / 施工管理 タブは削除）
  // 旧 localStorage の値が残っていても無視して 'initial' 固定で扱う。
  // 型は union のままにして既存の `screenMode === 'construction'` 等を
  // 残しても TS 警告にならないようにする（条件は常に false で評価される）
  type ScreenMode = 'initial' | 'asbuilt' | 'construction'
  const [screenMode] = useState<ScreenMode>('initial')
  // 旧キーの掃除（マウント時に一度だけ）
  useEffect(() => {
    try { localStorage.removeItem('survey:screenMode') } catch { /* ignore */ }
  }, [])
  // 保存記録に紐付ける区分（常に 起工測量）
  const surveyCategory: 'initial' | 'asbuilt' = 'initial'
  // アンテナ高 (m)。RTK ローバーのアンテナ位相中心〜地表（測点）までの高さ
  const [antennaHeight, setAntennaHeight] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('rtk:antennaHeight') : null
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) ? n : 2.0
  })
  useEffect(() => {
    try { localStorage.setItem('rtk:antennaHeight', String(antennaHeight)) } catch { /* ignore */ }
  }, [antennaHeight])
  // ジオイド補正の有効化。既定 ON（保存済みの OFF は無視）
  const [useGeoidCorrection, setUseGeoidCorrection] = useState<boolean>(true)
  useEffect(() => {
    try { localStorage.setItem('rtk:useGeoid', useGeoidCorrection ? '1' : '0') } catch { /* ignore */ }
  }, [useGeoidCorrection])
  // 三次元誘導（ターゲットとの比高表示）
  const [use3dGuidance, setUse3dGuidance] = useState<boolean>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('rtk:use3dGuidance') : null
    return saved === '1'
  })
  useEffect(() => {
    try { localStorage.setItem('rtk:use3dGuidance', use3dGuidance ? '1' : '0') } catch { /* ignore */ }
  }, [use3dGuidance])
  // RTK-FIX とみなす精度しきい値 [m]（0.02〜0.05）。精密モードで測定ボタン
  // の有効化と 1Hz ビープの判定に共通で使う。
  const [rtkFixAccuracyM, setRtkFixAccuracyM] = useState<number>(() => {
    const saved =
      typeof localStorage !== 'undefined' ? localStorage.getItem('rtk:fixAccuracyM') : null
    const n = saved ? parseFloat(saved) : NaN
    if (!Number.isFinite(n)) return DEFAULT_FIX_ACCURACY_M
    return Math.min(FIX_ACCURACY_MAX_M, Math.max(FIX_ACCURACY_MIN_M, n))
  })
  useEffect(() => {
    try { localStorage.setItem('rtk:fixAccuracyM', String(rtkFixAccuracyM)) } catch { /* ignore */ }
  }, [rtkFixAccuracyM])
  // ジオイドグリッド（遅延読込）
  const [geoidGrid, setGeoidGrid] = useState<import('@/lib/geoid').GeoidGrid | null>(null)
  const [geoidLoading, setGeoidLoading] = useState(false)
  const [geoidError, setGeoidError] = useState<string | null>(null)
  useEffect(() => {
    if (!useGeoidCorrection || geoidGrid) return
    setGeoidLoading(true)
    setGeoidError(null)
    import('@/lib/geoid')
      .then(({ loadGeoid }) => loadGeoid())
      .then((g) => setGeoidGrid(g))
      .catch((e) => setGeoidError(e instanceof Error ? e.message : 'ジオイド読込失敗'))
      .finally(() => setGeoidLoading(false))
  }, [useGeoidCorrection, geoidGrid])
  const [showSettings, setShowSettings] = useState(false)
  const [showTargetList, setShowTargetList] = useState(false)
  const [showRecordList, setShowRecordList] = useState(
    () => params.get('openCoords') === '1',
  )
  const [showParcelList, setShowParcelList] = useState(false)
  // 座標 / 地番 パネルの表示列設定 (farm 単位で localStorage に保存)
  const [coordColumns, setCoordColumnsState] = useState<ReadonlySet<CoordColumnKey>>(
    () =>
      loadColumnSet<CoordColumnKey>(
        COORD_COLS_LS_PREFIX + (farmId ?? ''),
        COORD_COLUMN_KEYS,
        COORD_COLUMN_KEYS,
      ),
  )
  const [parcelColumns, setParcelColumnsState] = useState<ReadonlySet<ParcelColumnKey>>(
    () =>
      loadColumnSet<ParcelColumnKey>(
        PARCEL_COLS_LS_PREFIX + (farmId ?? ''),
        PARCEL_COLUMN_KEYS,
        PARCEL_COLUMN_KEYS,
      ),
  )
  const [showCoordColumnPicker, setShowCoordColumnPicker] = useState(false)
  // 地図で地番ポリゴンをタップ → 開く 地番編集モーダルの target
  const [parcelInfoTarget, setParcelInfoTarget] = useState<{
    areaId: string
    parcelNumber: string
  } | null>(null)
  // 描画タブ + ペイント設定
  const [showDrawing, setShowDrawing] = useState(false)
  const [drawingMode, setDrawingMode] = useState<'off' | 'pen' | 'text' | 'eraser'>('off')
  const [drawingColor, setDrawingColor] = useState('#ef4444')
  const [drawingWidth, setDrawingWidth] = useState(3)
  const [drawingLineStyle, setDrawingLineStyle] = useState<LineStyle>('solid')
  const drawingUndoLen = useMapDrawingStore((s) => s.undoStack.length)
  const drawingRedoLen = useMapDrawingStore((s) => s.redoStack.length)
  const drawingUndo = useMapDrawingStore((s) => s.undo)
  const drawingRedo = useMapDrawingStore((s) => s.redo)
  // showDrawing OFF に切替時はモードもリセット
  useEffect(() => {
    if (!showDrawing) setDrawingMode('off')
  }, [showDrawing])
  const setCoordColumns = (next: ReadonlySet<CoordColumnKey>) => {
    // 必須列を常に含める
    const withReq = new Set(next)
    for (const r of COORD_REQUIRED_KEYS) withReq.add(r)
    setCoordColumnsState(withReq)
    saveColumnSet(COORD_COLS_LS_PREFIX + (farmId ?? ''), withReq)
  }
  const setParcelColumns = (next: ReadonlySet<ParcelColumnKey>) => {
    const withReq = new Set(next)
    withReq.add('parcel_number')
    setParcelColumnsState(withReq)
    saveColumnSet(PARCEL_COLS_LS_PREFIX + (farmId ?? ''), withReq)
  }
  // 座標一覧タブ内から手入力で 1 点追加するモーダル
  const [showManualCoordEntry, setShowManualCoordEntry] = useState(false)
  // 現場を開いたときの開始前チェック（ジオイド補正・目標高(アンテナ高)・既知点精度確認の喚起）
  // 工区IDごとにセッション中 1 回だけ表示する。
  const [showStartupCheck, setShowStartupCheck] = useState(false)
  // 測位モード選択（RTK / スマホ GPS）。工区ごとに sessionStorage で保持。
  //  - 'rtk': Drogger RTK 接続 (cm 測位)。既存フローどおり測定可、開始前チェックあり。
  //  - 'gps': スマホ GPS のみ。誤差ありのため測定ボタンは無効化。
  type PositioningMode = 'rtk' | 'gps'
  const [positioningMode, setPositioningMode] = useState<PositioningMode | null>(null)
  const [showModeChooser, setShowModeChooser] = useState(false)
  // 開始前チェック（RTK）内の「音声ガイダンスを有効化」チェック。既定 ON
  const [startupSoundOn, setStartupSoundOn] = useState(true)
  // 地図マーカータップで開く点情報モーダルの対象
  const [pointInfoTarget, setPointInfoTarget] = useState<StakingTarget | null>(null)
  // 座標計算（交点・線上）モーダル
  const [showCalcModal, setShowCalcModal] = useState(false)
  // 計算モーダルで地図から点選択中の割り当て関数
  const [calcAssign, setCalcAssign] = useState<((id: string) => void) | null>(null)
  // 表示モード（MAP / 3D / 2D の組合せ、最大 2 つまで同時表示）
  type ViewMode = 'map' | '3d' | '2d'
  const [viewModes, setViewModes] = useState<Set<ViewMode>>(new Set<ViewMode>(['map']))
  const showMap = viewModes.has('map')
  const show3D = viewModes.has('3d')
  const show2D = viewModes.has('2d')
  // 既存コードの参照互換
  const landxmlMode = show3D
  const prevBaseLayerRef = useRef<typeof baseLayer | null>(null)
  const landxmlInputRef = useRef<HTMLInputElement>(null)
  // モード切替: クリックされたモードをトグル。最大 2 つ、最少 1 つ。
  // 既に 2 つ ON のとき新しいモードを追加する場合は、クリックされたモード以外で
  // 一番古いもの（= 直近に追加されていない方）を外す。
  const toggleViewMode = (mode: ViewMode) => {
    setViewModes((prev) => {
      const next = new Set(prev)
      if (next.has(mode)) {
        if (next.size === 1) return prev
        next.delete(mode)
        return next
      }
      if (next.size >= 2) {
        // 1 つ外す: 任意のひとつ（先に入っていた方）を落とす
        const first = next.values().next().value as ViewMode | undefined
        if (first) next.delete(first)
      }
      next.add(mode)
      return next
    })
  }
  // 断面（クロスセクション）
  interface CrossSection {
    id: string
    name: string
    a: [number, number]
    b: [number, number]
    direction: 'along' | 'perp'
  }
  const [sections, setSections] = useState<CrossSection[]>([])
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null)
  /** 断面作成中に選択した座標 id（最大 2 件）。座標管理に登録された点から 2 点を選ぶ。 */
  const [sectionPickIds, setSectionPickIds] = useState<string[]>([])
  const [sectionDirection, setSectionDirection] = useState<'along' | 'perp'>('along')
  /** 断面から左右何 m 以内の現況点を断面チャートに重ねるか（既定 0.5m） */
  const [sectionToleranceM, setSectionToleranceM] = useState<number>(() => {
    try {
      const s = localStorage.getItem('mobile:sectionTolM')
      const n = s ? parseFloat(s) : NaN
      return Number.isFinite(n) && n > 0 ? n : 0.5
    } catch {
      return 0.5
    }
  })
  useEffect(() => {
    try { localStorage.setItem('mobile:sectionTolM', String(sectionToleranceM)) } catch { /* ignore */ }
  }, [sectionToleranceM])
  const sectionPickingMode = sectionPickIds.length < 2 && activeSectionId === 'pending'
  const startNewSection = () => {
    setActiveSectionId('pending')
    setSectionPickIds([])
  }
  // LANDXML モード ON で背景を「背景なし」に、OFF で元に戻す
  useEffect(() => {
    if (landxmlMode) {
      if (prevBaseLayerRef.current === null) prevBaseLayerRef.current = baseLayer
      if (baseLayer !== 'none') setBaseLayer('none')
    } else if (prevBaseLayerRef.current !== null) {
      setBaseLayer(prevBaseLayerRef.current)
      prevBaseLayerRef.current = null
    }
    // baseLayer はあえて依存に入れない（モード切替の前後のみ反映したい）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landxmlMode])
  const [targetFilter, setTargetFilter] = useState<
    'all' | 'coordinate' | 'pipe_vertex' | 'route'
  >('all')
  // 非表示にする点種コードの集合（地図マーカー＆リスト両方に効く）
  const [hiddenSubTypes, setHiddenSubTypes] = useState<Set<string>>(new Set())
  // 表示設定パネル（コンパス・点名・点種フィルタ・地番・背景地図）の表示
  const [showDisplaySettings, setShowDisplaySettings] = useState(false)
  // 写真モーダル: 選択中ターゲット（座標）の写真を閲覧／撮影できる
  const [photoModalTarget, setPhotoModalTarget] = useState<StakingTarget | null>(null)
  // メモ作成モーダル。lat/lng の上書きを伴う場合もある（地図長押し）
  const [memoModalState, setMemoModalState] = useState<
    | null
    | {
        lat: number | null
        lng: number | null
      }
  >(null)
  // 長押ししたときに出す選択シート（測点を追加 / メモを残す）
  const [longPressChoice, setLongPressChoice] = useState<{ lat: number; lng: number } | null>(null)
  // 長押し座標から測点を追加する入力モーダル
  const [addCoordDialog, setAddCoordDialog] = useState<
    | null
    | {
        lat: number
        lng: number
        x: number
        y: number
        name: string
        type: string
        z: string
        notes: string
      }
  >(null)
  // 工区写真（標準写真）撮影用: PhotoEditModal で編集する元ファイル
  const [editingStandalonePhoto, setEditingStandalonePhoto] = useState<File | null>(null)
  // 撮影(camera) / インポート(picker) の区別。カメラ撮影のときだけ 撮影日を「今」に既定化する
  const [standalonePhotoSource, setStandalonePhotoSource] = useState<'camera' | 'picker' | null>(null)
  // 工区写真タイトルのよく使う候補（既定 + ユーザーが最近使ったもの）
  const PHOTO_TITLE_DEFAULTS = ['全景', '道路', '建物', '水路'] as const
  const [photoTitleRecents, setPhotoTitleRecents] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem('mobile:photo:recentTitles')
      const arr = s ? JSON.parse(s) : null
      if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string')
    } catch { /* ignore */ }
    return []
  })
  const photoTitleSuggestions = useMemo(() => {
    // 既定 + 最近使った の順で重複除去（先着優先）
    const seen = new Set<string>()
    const out: string[] = []
    for (const s of [...PHOTO_TITLE_DEFAULTS, ...photoTitleRecents]) {
      const t = s.trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoTitleRecents])
  const pushPhotoTitleRecent = (prefix: string) => {
    const p = prefix.trim()
    if (!p) return
    setPhotoTitleRecents((prev) => {
      const next = [p, ...prev.filter((x) => x !== p)].slice(0, 8)
      try { localStorage.setItem('mobile:photo:recentTitles', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  // 既存の工区写真タイトル一覧（自動採番用）
  const existingFarmPhotoTitles = useMemo(() => {
    if (!farmId) return [] as string[]
    const list = attachmentsByEntity.get(`farm_photo:${farmId}`) ?? []
    return list.map((a) => a.category ?? '').filter((s) => s && s !== '現場')
  }, [farmId, attachmentsByEntity])
  // 既存の工区写真マーカーからの編集: 差替対象の attachment メタ + 元 File
  const [editingExistingPhoto, setEditingExistingPhoto] = useState<{
    file: File
    oldAttachmentId: string
    initialLat: number | null
    initialLng: number | null
    initialHeadingDeg: number | null
    initialCaption: string | null
    initialTakenAt: Date | null
    initialTitle: string | null
  } | null>(null)
  // カメラボタンの「撮影 / インポート」選択シート
  const [photoSourceSheet, setPhotoSourceSheet] = useState(false)
  const standalonePhotoInputRef = useRef<HTMLInputElement>(null)
  const standalonePhotoPickerRef = useRef<HTMLInputElement>(null)
  const [showLabels, setShowLabels] = useState(
    () => localStorage.getItem('mobile:staking:showLabels') !== '0',
  )
  useEffect(() => {
    try { localStorage.setItem('mobile:staking:showLabels', showLabels ? '1' : '0') } catch { /* ignore */ }
  }, [showLabels])
  // 測点（マーカー）全体の表示 ON/OFF。既定 ON。
  // 点種別フィルタ (hiddenSubTypes) の親トグル。
  const [showTargets, setShowTargets] = useState(
    () => localStorage.getItem('mobile:staking:showTargets') !== '0',
  )
  useEffect(() => {
    try { localStorage.setItem('mobile:staking:showTargets', showTargets ? '1' : '0') } catch { /* ignore */ }
  }, [showTargets])
  // 地番ポリゴンの表示 ON/OFF。既定 ON。
  const [showParcelPolygons, setShowParcelPolygons] = useState(
    () => localStorage.getItem('mobile:staking:showParcelPolygons') !== '0',
  )
  useEffect(() => {
    try { localStorage.setItem('mobile:staking:showParcelPolygons', showParcelPolygons ? '1' : '0') } catch { /* ignore */ }
  }, [showParcelPolygons])
  // 地番名ラベル（境界測量ポリゴンの上に表示）。既定 OFF、低ズーム時は自動 OFF。
  const [showParcelLabels, setShowParcelLabels] = useState(
    () => localStorage.getItem('mobile:staking:showParcelLabels') === '1',
  )
  useEffect(() => {
    try { localStorage.setItem('mobile:staking:showParcelLabels', showParcelLabels ? '1' : '0') } catch { /* ignore */ }
  }, [showParcelLabels])
  const [showOrtho, setShowOrtho] = useState(true)
  const PARCEL_LABEL_MIN_ZOOM = 17
  // ターゲット動的ズーム（ターゲットを中心にして、現在地も視野に収まるよう自動拡大縮小）
  // 地図ベースレイヤ（地理院の各種タイル / 背景なし）
  type BaseLayerKey = 'photo' | 'std' | 'pale' | 'blank' | 'none'
  const BASE_LAYERS: Record<BaseLayerKey, { label: string; url: string; maxNative?: number }> = {
    photo: {
      label: '航空写真',
      url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
      maxNative: 18,
    },
    std: {
      label: '地理院地図',
      url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
      maxNative: 18,
    },
    pale: {
      label: '淡色地図',
      url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
      maxNative: 18,
    },
    blank: {
      label: '白地図',
      url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png',
      maxNative: 14,
    },
    none: {
      label: '背景なし',
      // 透明 1px 画像をタイルにすることで、TileLayer を unmount せず URL のみ更新する
      // → 既存のポリゴンなどの上位レイヤを巻き込んで再描画されるのを防ぐ
      url:
        'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    },
  }
  const [baseLayer, setBaseLayer] = useState<BaseLayerKey>(() => {
    try {
      const saved = localStorage.getItem('mobile:baseLayer') as BaseLayerKey | null
      if (saved && BASE_LAYERS[saved]) return saved
    } catch {
      // ignore
    }
    return 'photo'
  })
  useEffect(() => {
    try { localStorage.setItem('mobile:baseLayer', baseLayer) } catch { /* ignore */ }
  }, [baseLayer])
  const currentBase = BASE_LAYERS[baseLayer]

  // ---- 法務省地図 (地番マップ) ----
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchParcelDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  const hasActiveParcelDataset = parcelDatasets.some((d) => d.active)
  const [showParcelLayer, setShowParcelLayer] = useState(false)
  const [parcelSelectionMode, setParcelSelectionMode] = useState(false)
  const [selectedParcels, setSelectedParcels] = useState<
    Map<string, Feature<GeoJsonPolygon, ParcelFeatureProperties>>
  >(new Map())
  const [parcelBusy, setParcelBusy] = useState(false)
  const [parcelMessage, setParcelMessage] = useState<string | null>(null)
  const selectedParcelKeys = useMemo(
    () => new Set(selectedParcels.keys()),
    [selectedParcels],
  )
  const toggleSelectedParcel = useCallback(
    (feature: Feature<GeoJsonPolygon, ParcelFeatureProperties>) => {
      const key = parcelFeatureKey(feature)
      setSelectedParcels((prev) => {
        const next = new Map(prev)
        if (next.has(key)) next.delete(key)
        else next.set(key, feature)
        return next
      })
    },
    [],
  )
  const clearParcelSelection = () => setSelectedParcels(new Map())
  useEffect(() => {
    void fetchParcelDatasets()
  }, [fetchParcelDatasets])
  // 点数が多いとラベル描画が重くなるため、低ズーム時は自動で非表示にする
  const [mapZoom, setMapZoom] = useState(17)
  const LABEL_MIN_ZOOM = 18
  // 地図の表示範囲（マーカーラベルの可視範囲カリングに使う）。
  // 大量点（数千点）で permanent tooltip を全 marker に付けると固まるため、
  // 画面に映っているマーカーだけ label を出すようにする。
  const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null)
  const [showRouteLine, setShowRouteLine] = useState(true)

  // 施工管理モード用：中心線形 / 床掘 TIN / 現況 TIN
  const { fetchPlan } = useConstructionPlanStore()
  const [alignmentLines, setAlignmentLines] = useState<Array<[number, number][]>>([])
  const [trenchSurface, setTrenchSurface] = useState<TinSurfaceLike | null>(null)
  const [groundSurface, setGroundSurface] = useState<TinSurfaceLike | null>(null)
  const [dataSourceLabel, setDataSourceLabel] = useState<string | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const xmlInputRef = useRef<HTMLInputElement>(null)

  // 保存済み LandXML（工区別・履歴あり）
  const [savedLandxmls, setSavedLandxmls] = useState<LandxmlFileRow[]>([])
  const [activeLandxmlId, setActiveLandxmlId] = useState<string | null>(null)
  const [landxmlBusy, setLandxmlBusy] = useState(false)
  const [showLandxmlList, setShowLandxmlList] = useState(false)
  // 既存コードの参照互換（2D モード ⇔ 断面パネル表示）
  const showSectionPanel = show2D
  const setShowSectionPanel = (v: boolean | ((prev: boolean) => boolean)) => {
    const next = typeof v === 'function' ? v(show2D) : v
    setViewModes((prev) => {
      const n = new Set(prev)
      if (next) {
        if (!n.has('2d')) {
          if (n.size >= 2) {
            const first = n.values().next().value as ViewMode | undefined
            if (first) n.delete(first)
          }
          n.add('2d')
        }
      } else {
        if (n.has('2d') && n.size > 1) n.delete('2d')
      }
      return n
    })
  }

  // 測設成功とみなす許容半径（m）
  const STAKE_TOLERANCE_M = 0.20

  // 選択中ターゲット
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
  // 近接モードを手動で閉じたフラグ（範囲外に出ると解除して再表示できるようにする）
  const [proximityCancelled, setProximityCancelled] = useState(false)
  // 1m 以内に重なっているターゲットをタップした際の選択シート。
  //   mode='select'  : 通常選択（setSelectedTargetId）
  //   mode='assign'  : 座標計算で点を割り当て中（calcAssign）
  const [overlapPicker, setOverlapPicker] = useState<{
    candidates: StakingTarget[]
    mode: 'select' | 'assign'
  } | null>(null)
  // 重なり判定の閾値（世界座標 m）。
  const OVERLAP_TOL_M = 1.0
  // 新点名の頭文字（直近で使ったものを localStorage に保持してクイック選択）
  const [recentPrefixes, setRecentPrefixes] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem('staking:freePrefixes')
      const arr = s ? JSON.parse(s) : null
      if (Array.isArray(arr) && arr.length > 0) return arr.filter((x) => typeof x === 'string')
    } catch { /* ignore */ }
    return ['新点']
  })
  const pushRecentPrefix = (prefix: string) => {
    const p = prefix.trim()
    if (!p) return
    setRecentPrefixes((prev) => {
      const next = [p, ...prev.filter((x) => x !== p)].slice(0, 8)
      try { localStorage.setItem('staking:freePrefixes', JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  // 新点の採番モード（設定で切替）
  const [numberingMode, setNumberingMode] = useState<NumberingMode>(() =>
    localStorage.getItem('staking:numberingMode') === 'global' ? 'global' : 'perPrefix',
  )
  useEffect(() => {
    try { localStorage.setItem('staking:numberingMode', numberingMode) } catch { /* ignore */ }
  }, [numberingMode])
  // 選択中の配線（タップでハイライト＋情報表示）
  const [selectedPipeId, setSelectedPipeId] = useState<string | null>(null)
  // 共有リンクのトースト表示
  const [shareToast, setShareToast] = useState<string | null>(null)
  // 誤差超過時の選択モーダル: 計測完了時に resolver を保持して回答を待つ
  const [errorChoice, setErrorChoice] = useState<{
    distance: number
    resolve: (choice: 'stake' | 'free' | 'cancel') => void
  } | null>(null)
  // 測設完了モーダル: 結果メッセージ + 写真撮影 / OK
  const [postStakeDialog, setPostStakeDialog] = useState<{
    message: string
    target: StakingTarget
    /** OK 押下時は 'ok'、写真撮影押下時は 'photo' を返す */
    resolve: (action: 'ok' | 'photo') => void
  } | null>(null)
  // 新点計測完了モーダル: 名前入力 + プレビュー + OK / 写真 / キャンセル
  const [freePointDialog, setFreePointDialog] = useState<{
    defaultName: string
    x: number
    y: number
    z: number | null
    distance: number | null
    accuracy: number
    sampleCount: number
    antennaHeight: number
  } | null>(null)

  // 記録状態
  const [recording, setRecording] = useState(false)
  const [recordedCount, setRecordedCount] = useState(0)
  const [rejectedCount, setRejectedCount] = useState(0)
  const recSamplesRef = useRef<Array<{ lat: number; lng: number; alt: number | null; acc: number | null }>>([])
  const recTimerRef = useRef<number | null>(null)
  const recCleanupRef = useRef<(() => void) | null>(null)
  // 目標終了時刻（ms）。ノイズで棄却したサンプル分だけ後ろにずれる。
  const recEndMsRef = useRef<number>(0)
  // 終了監視用 interval。setTimeout で固定終了せず、棄却で延長できるようにする。
  const recEndIntervalRef = useRef<number | null>(null)
  // 「現在地を記録」ボタンで起動した場合は、ターゲット測設判定をスキップして
  // 必ず新点として保存する
  const recForceFreeRef = useRef<boolean>(false)

  // データ読込
  useEffect(() => {
    if (!farmId) {
      setError('URL に farmId が指定されていません')
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const { data: farmData, error: farmErr } = await supabase
          .from('farms')
          .select('*')
          .eq('id', farmId)
          .single()
        if (farmErr) throw farmErr
        if (cancelled) return
        const typedFarm = farmData as Farm
        setFarm(typedFarm)
        setCurrentFarm(typedFarm)

        if (typedFarm.project_id) {
          const { data: projData } = await supabase
            .from('projects')
            .select('*')
            .eq('id', typedFarm.project_id)
            .single()
          if (!cancelled && projData) {
            const typedProj = projData as Project
            setProject(typedProj)
            useProjectListStore.setState({ currentProject: typedProj })
            setZone(typedProj.coordinate_zone)
          }
        }

        await Promise.all([
          fetchCoordinates(typedFarm.id),
          fetchPipes(typedFarm.id),
          fetchRecords(typedFarm.id),
          fetchWorkAreas(typedFarm.id),
          useExportRouteStore.getState().fetchRoute(typedFarm.id),
        ])
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : '読み込み失敗')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [farmId, setCurrentFarm, setZone, fetchCoordinates, fetchPipes, fetchRecords, fetchWorkAreas])

  // 地番リストが変わるたびに parcels（属性は表示のみ）を取得
  useEffect(() => {
    if (parcelAreas.length === 0) return
    void fetchParcels(parcelAreas.map((a) => a.id))
    // 比較は id 集合だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcelAreas.map((a) => a.id).join(','), fetchParcels])

  // 工区を開くたびに測位モード（RTK / スマホ GPS）の選択を促す。
  // 前回の選択は保持しない（毎回聞く運用）。
  useEffect(() => {
    if (!farmId) return
    setPositioningMode(null)
    setShowModeChooser(true)
  }, [farmId])

  // 地番編集機能はスマホから撤去（PC の地番管理から編集する運用）。
  // 「開始前チェック」モーダルは startRecording 内で初回押下時に出す。
  // （工区を開いた時点では出さず、実際に観測を始めようとしたタイミングで喚起する）

  // 座標が読み込まれたら、写真の枚数を一括取得（カメラボタンのバッジ表示用）
  useEffect(() => {
    if (coordinates.length === 0) return
    fetchAttachments('coordinate', coordinates.map((c) => c.id))
  }, [coordinates, fetchAttachments])

  // 工事区域ポリゴン（境界測量含む）を取得。
  // farm 単体ロード（URL 直アクセス）で farms 配列が未取得の状態でも
  // currentFarm を頼りにポリゴンを取れるように、farm がセットされてから走らせる。
  useEffect(() => {
    if (farmId && farm) fetchWorkAreaPolygons()
  }, [farmId, farm, fetchWorkAreaPolygons])

  // 工区メモ（地図上にマーカー表示 + メモボタンで作成）
  const farmMemos = useFarmMemoStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_FARM_MEMOS : EMPTY_FARM_MEMOS,
  )
  const fetchFarmMemos = useFarmMemoStore((s) => s.fetchByFarm)
  const createFarmMemo = useFarmMemoStore((s) => s.createMemo)
  const updateFarmMemo = useFarmMemoStore((s) => s.updateMemo)
  useEffect(() => {
    if (farmId) void fetchFarmMemos(farmId)
  }, [farmId, fetchFarmMemos])

  // 工区写真（entity_type='farm_photo' / entity_id=farmId）。
  // 撮影位置・方向を持つ独立した写真エンティティ。マーカー描画に使う。
  useEffect(() => {
    if (farmId) void fetchAttachments('farm_photo', [farmId])
  }, [farmId, fetchAttachments])

  // ---------------- データ更新（共同作業向けの再取得） ----------------
  // 手動: ヘッダの「更新」ボタン。自動: DEFAULT_ON かつ 60 秒間隔。
  // 座標 attachments は coordinates 変化を watch する既存 effect が拾うので明示は不要。
  const REFRESH_INTERVAL_MS = 60_000
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null)
  const refreshingRef = useRef(false)
  const refreshData = useCallback(async () => {
    if (!farmId) return
    if (refreshingRef.current) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      // キャッシュを持つストアは invalidate してから再取得
      useCoordinateStore.getState().invalidateCache()
      useWorkAreaStore.getState().invalidateCache()
      await Promise.all([
        fetchCoordinates(farmId),
        fetchWorkAreas(farmId),
        fetchPipes(farmId),
        fetchRecords(farmId),
        fetchFarmMemos(farmId),
        fetchAttachments('farm_photo', [farmId]),
      ])
      setLastRefreshAt(new Date())
    } catch (err) {
      console.warn('[mobile refresh] failed', err)
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [
    farmId,
    fetchCoordinates,
    fetchWorkAreas,
    fetchPipes,
    fetchRecords,
    fetchFarmMemos,
    fetchAttachments,
  ])
  // 60 秒ごとの自動更新（既定 ON、ページ表示中のみ）
  useEffect(() => {
    if (!farmId) return
    const id = window.setInterval(() => { void refreshData() }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [farmId, refreshData])
  const farmPhotos = useMemo(() => {
    if (!farmId) return [] as Array<{
      id: string
      lat: number
      lng: number
      headingDeg: number | null
      filePath: string
      caption: string | null
    }>
    const list = attachmentsByEntity.get(`farm_photo:${farmId}`) ?? []
    return list
      .filter((a) => a.lat != null && a.lng != null)
      .map((a) => ({
        id: a.id,
        lat: a.lat as number,
        lng: a.lng as number,
        headingDeg: a.headingDeg,
        filePath: a.filePath,
        caption: a.caption,
      }))
  }, [farmId, attachmentsByEntity])

  // オルソ画像タイルセットを取得
  useEffect(() => {
    if (farmId) fetchOrthos(farmId)
  }, [farmId, fetchOrthos])

  const farmOrthos = useMemo(
    () => (farmId ? orthoByFarm.get(farmId) ?? [] : []),
    [orthoByFarm, farmId],
  )

  // 当該工区のポリゴンのみ
  const farmPolygons = useMemo(
    () => workAreaPolygons.filter((p) => p.farmId === farmId),
    [workAreaPolygons, farmId],
  )

  // 方位センサー（DeviceOrientation）リスナー
  useEffect(() => {
    if (!headingEnabled) return
    if (typeof window === 'undefined') return

    const handler = (e: DeviceOrientationEvent) => {
      const h = extractCompassHeading(e)
      if (h != null) setHeading(h)
    }

    // Android: deviceorientationabsolute が真北基準
    window.addEventListener('deviceorientationabsolute', handler as EventListener)
    // iOS: deviceorientation で webkitCompassHeading が取得可
    window.addEventListener('deviceorientation', handler)
    return () => {
      window.removeEventListener('deviceorientationabsolute', handler as EventListener)
      window.removeEventListener('deviceorientation', handler)
    }
  }, [headingEnabled])

  // 方位 ON/OFF（iOS は requestPermission がユーザー操作下で必須）
  const toggleHeading = async () => {
    if (headingEnabled) {
      setHeadingEnabled(false)
      setHeading(null)
      return
    }
    setHeadingError(null)
    const proto = (
      typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null
    ) as (typeof DeviceOrientationEvent & {
      requestPermission?: () => Promise<'granted' | 'denied'>
    }) | null
    if (proto && typeof proto.requestPermission === 'function') {
      try {
        const result = await proto.requestPermission()
        if (result !== 'granted') {
          setHeadingError('方位センサーの利用が許可されませんでした')
          return
        }
      } catch (err) {
        setHeadingError(
          err instanceof Error ? err.message : '方位センサーの利用許可で失敗しました',
        )
        return
      }
    }
    setHeadingEnabled(true)
  }

  // 地図回転（進行方向を上に）のトグル。ON にすると方位センサーも自動 ON
  const toggleMapRotation = async () => {
    if (mapRotationEnabled) {
      setMapRotationEnabled(false)
      return
    }
    if (!headingEnabled) {
      await toggleHeading()
    }
    setMapRotationEnabled(true)
  }

  // 現在位置の監視
  //
  // RTK モードで一度 FIX に達したあとは、accuracy が急に 0.50m を超える読みを
  // 短期的な "はずれ値" として棄却する（Android FLP のネットワーク測位混入対策）。
  // ただし連続 5 回まで。それを超えたら FIX 喪失として受け入れ、通常フローに戻す。
  const postFixModeRef = useRef(false)
  const consecutiveRejectsRef = useRef(0)
  const positioningModeRef = useRef(positioningMode)
  const rtkFixAccuracyRef = useRef(rtkFixAccuracyM)
  // 位置更新の最終受信時刻。RTK 受信機が抜けたりして更新が止まった場合、
  // 以下の閾値を超えたら「FIX 喪失」とみなしてビープと表示を止める。
  const lastPosTimeRef = useRef(0)
  const POSITION_STALE_MS = 3_000
  useEffect(() => { positioningModeRef.current = positioningMode }, [positioningMode])
  useEffect(() => { rtkFixAccuracyRef.current = rtkFixAccuracyM }, [rtkFixAccuracyM])
  // 棄却中フラグ (>0 の間は FIX 音を鳴らさない)。ref と state の両方を持つ
  const [rejectingCount, setRejectingCount] = useState(0)
  const rejectingCountRef = useRef(0)
  useEffect(() => { rejectingCountRef.current = rejectingCount }, [rejectingCount])

  useEffect(() => {
    if (!('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const acc = pos.coords.accuracy
        const isRtk = positioningModeRef.current === 'rtk'
        const fixThreshold = rtkFixAccuracyRef.current

        // RTK モード + 既に一度 FIX 済 + 精度が閾値超過 → 棄却フェーズ
        if (
          isRtk &&
          postFixModeRef.current &&
          acc != null &&
          acc > POST_FIX_REJECT_ACC_M
        ) {
          consecutiveRejectsRef.current += 1
          if (consecutiveRejectsRef.current > MAX_CONSECUTIVE_REJECTS) {
            // 連続 5 回を超えた → FIX 喪失として受け入れる。棄却状態を解除して
            // この読みで currentAcc を更新することで既存の FIX→喪失トリガが警告音を鳴らす。
            postFixModeRef.current = false
            consecutiveRejectsRef.current = 0
            setRejectingCount(0)
            // fallthrough して下の accept 分岐へ
          } else {
            // まだ棄却継続。currentPos / currentAcc を更新しない (画面は最終良好値を保持)
            setRejectingCount(consecutiveRejectsRef.current)
            return
          }
        } else {
          // accept 分岐: 棄却カウントをリセット
          if (consecutiveRejectsRef.current !== 0) {
            consecutiveRejectsRef.current = 0
            setRejectingCount(0)
          }
        }

        // 一度 FIX 精度に達したら postFixMode に入り、以降のフィルタが有効化される
        if (isRtk && acc != null && acc <= fixThreshold) {
          postFixModeRef.current = true
        }

        const ll: [number, number] = [pos.coords.latitude, pos.coords.longitude]
        setCurrentPos(ll)
        setCurrentAcc(acc)
        setCurrentAlt(pos.coords.altitude)
        // 位置更新の鮮度計測: この時刻を beep ループから参照して「更新が
        // 止まった (RTK 受信機切断等)」ときにビープを停止するために使う。
        lastPosTimeRef.current = Date.now()
        // FIX相当の精度のときだけ追従用の安定位置を更新（外れたら据え置き）
        if (acc != null && acc <= FOLLOW_FIX_THRESHOLD_M) {
          setStablePos(ll)
        }
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [])

  const zone = project?.coordinate_zone ?? 13
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // ---- 法務省地図の bbox / 取込済セット / 一括取込ハンドラ ----
  const isCadastralProject = project?.category === 'cadastral'

  // 土木工事モードで 地番タブ を開いていたら強制的に閉じる (プロジェクト種別変更時の保険)
  useEffect(() => {
    if (!isCadastralProject && showParcelList) setShowParcelList(false)
  }, [isCadastralProject, showParcelList])
  const parcelsByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)

  // 地番属性: polygon の塗り色を attribute_code から解決するための lookup
  const projectIdForAttrs = project?.id ?? null
  const parcelAttrTypes = useParcelAttributeTypesStore((s) =>
    projectIdForAttrs
      ? s.byProject.get(projectIdForAttrs) ?? EMPTY_ATTRIBUTES
      : EMPTY_ATTRIBUTES,
  )
  const fetchParcelAttrTypes = useParcelAttributeTypesStore((s) => s.fetchForProject)
  useEffect(() => {
    if (projectIdForAttrs) void fetchParcelAttrTypes(projectIdForAttrs)
  }, [projectIdForAttrs, fetchParcelAttrTypes])
  const parcelAttrColorByCode = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of parcelAttrTypes) m.set(t.code, t.color)
    return m
  }, [parcelAttrTypes])
  // 常に「現在の地図ビュー」に追従する (以前は 工区+Nm プリセットがあったが、
  // features 数が数千〜数万に膨れてラベル bind が固まる原因になるため撤去)
  const effectiveParcelBbox: Bbox | null =
    (farm?.parcel_map_bbox as Bbox | null | undefined) ?? null
  const importedParcelKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of parcelsByWorkAreaId.values()) {
      if (!p.parcel_number) continue
      s.add(`${p.location ?? ''}|${p.parcel_number}`)
    }
    const areas = workAreasAll['boundary_survey'] ?? []
    for (const a of areas) {
      if (a.name) s.add(`|${a.name}`)
      if (a.zoneNumber && a.zoneNumber !== a.name) s.add(`|${a.zoneNumber}`)
    }
    return s
  }, [parcelsByWorkAreaId, workAreasAll])
  const handleImportParcelBatch = async (
    features: Feature<GeoJsonPolygon, ParcelFeatureProperties>[],
  ) => {
    if (!farm || !project) return
    if (features.length === 0) return
    setParcelBusy(true)
    setParcelMessage(null)
    try {
      const result = await importParcelBatch(features, {
        farmId: farm.id,
        zone: project.coordinate_zone,
      })
      setSelectedParcels(new Map())
      setParcelMessage(result.message)
    } catch (err) {
      console.error(err)
      setParcelMessage(err instanceof Error ? err.message : '取込に失敗しました')
    } finally {
      setParcelBusy(false)
    }
  }

  // ========== 施工管理モード関連 ==========
  // セグメントを離散化してポリラインに変換
  const segmentToPolylineXY = (seg: AlignmentSegment, samples = 12): Array<[number, number]> => {
    if (seg.type === 'line') return [[seg.startX, seg.startY], [seg.endX, seg.endY]]
    const pts: Array<[number, number]> = []
    for (let i = 0; i <= samples; i++) {
      const t = i / samples
      pts.push([seg.startX + (seg.endX - seg.startX) * t, seg.startY + (seg.endY - seg.startY) * t])
    }
    return pts
  }

  const buildAlignmentLines = (als: Alignment[], conv: CoordinateConverter): Array<[number, number][]> => {
    const lines: Array<[number, number][]> = []
    for (const al of als) {
      for (const seg of al.segments) {
        const xyPts = segmentToPolylineXY(seg, 12)
        const llPts: [number, number][] = xyPts.map(([x, y]) => {
          const r = conv.toLatLng(x, y)
          return [r.lat, r.lng]
        })
        lines.push(llPts)
      }
    }
    return lines
  }

  // LandXML テキストをパースして TIN / 線形をセット
  // parseLandXml は数十 MB の TIN に対して数秒〜数十秒かかる同期処理なので、
  // 呼び出し前に setLandxmlBusy(true) が React に描画される機会を確保する
  // (setTimeout 0 で 1 フレーム譲る) → 「読込中…」オーバーレイが出てから固まる。
  const applyLandxmlText = async (text: string, displayName: string) => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const result = parseLandXml(text, displayName)
    const trenchSurf =
      result.surfaces.find((s) => /trench|床掘|excav/i.test(s.name)) ??
      result.surfaces[0] ??
      null
    const groundSurf = result.surfaces.find((s) => /ground|現況|terrain/i.test(s.name)) ?? null
    setAlignmentLines(buildAlignmentLines(result.alignments, converter))
    setTrenchSurface(trenchSurf)
    setGroundSurface(groundSurf)
    setDataSourceLabel(`LandXML: ${displayName}`)
  }

  // ローカルファイル選択 → パース → 自動で工区にアップロードして共有
  const handleLoadXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setDataError(null)
    setLandxmlBusy(true)
    try {
      const text = await file.text()
      await applyLandxmlText(text, file.name)
      // 工区に自動アップロード（既存 active を退避し、新規 active に）
      if (farmId) {
        try {
          const row = await uploadLandxmlFile({
            farmId,
            fileName: file.name,
            content: text,
            kind: 'design',
          })
          setActiveLandxmlId(row.id)
          // 一覧を再取得
          const list = await listLandxmlFiles(farmId)
          setSavedLandxmls(list)
        } catch (upErr) {
          // アップロード失敗してもローカル読込は成功している。ユーザーには warning。
          setDataError(
            `読込は成功しましたが、サーバー保存に失敗しました: ${
              upErr instanceof Error ? upErr.message : String(upErr)
            }`,
          )
        }
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'LandXML 読込エラー')
    } finally {
      setLandxmlBusy(false)
      e.target.value = ''
    }
  }

  // 工区を開いたとき: 保存済み一覧を fetch し、active があれば自動読込
  useEffect(() => {
    if (!farmId) return
    let cancelled = false
    ;(async () => {
      try {
        const list = await listLandxmlFiles(farmId)
        if (cancelled) return
        setSavedLandxmls(list)
        // すでにメモリ上にロード済みなら何もしない
        if (trenchSurface) return
        const active = list.find((r) => r.isActive) ?? (await getActiveLandxmlFile(farmId))
        if (!active || cancelled) return
        setLandxmlBusy(true)
        const text = await downloadLandxmlText(active.storagePath)
        if (cancelled) return
        await applyLandxmlText(text, active.name)
        setActiveLandxmlId(active.id)
      } catch (err) {
        if (!cancelled)
          setDataError(
            `保存済み LandXML の取得に失敗: ${err instanceof Error ? err.message : String(err)}`,
          )
      } finally {
        if (!cancelled) setLandxmlBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // 初回工区切替時のみ自動読込。trenchSurface が変わるたびに走らせないよう除外
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId])

  // 保存済み履歴から 1 件選んで active に切替＆ロード
  const handleSelectSavedLandxml = async (row: LandxmlFileRow) => {
    setDataError(null)
    setLandxmlBusy(true)
    try {
      const text = await downloadLandxmlText(row.storagePath)
      await applyLandxmlText(text, row.name)
      if (!row.isActive) await setActiveLandxmlFile(row)
      setActiveLandxmlId(row.id)
      if (farmId) setSavedLandxmls(await listLandxmlFiles(farmId))
      setShowLandxmlList(false)
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'LandXMLの取得に失敗')
    } finally {
      setLandxmlBusy(false)
    }
  }

  const handleDeleteSavedLandxml = async (row: LandxmlFileRow) => {
    if (!confirm(`「${row.name}」を削除しますか？（端末からも工区からも消えます）`)) return
    setLandxmlBusy(true)
    try {
      await deleteLandxmlFile(row)
      if (farmId) setSavedLandxmls(await listLandxmlFiles(farmId))
      if (row.id === activeLandxmlId) {
        setActiveLandxmlId(null)
        setTrenchSurface(null)
        setGroundSurface(null)
        setAlignmentLines([])
        setDataSourceLabel(null)
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : '削除に失敗')
    } finally {
      setLandxmlBusy(false)
    }
  }

  const handleLoadFromPlan = async () => {
    if (!farmId) return
    setDataError(null)
    setImporting(true)
    try {
      await Promise.all([fetchPipes(farmId), fetchPlan(farmId)])
      const freshPipes = useUnderdrainStore.getState().pipes
      const freshPlan = useConstructionPlanStore.getState().planGroups
      const lines: Array<[number, number][]> = []
      for (const pipe of freshPipes) {
        if (pipe.vertices.length < 2) continue
        const ll: [number, number][] = pipe.vertices.map((v) => {
          const r = converter.toLatLng(v.x, v.y)
          return [r.lat, r.lng]
        })
        lines.push(ll)
      }
      setAlignmentLines(lines)
      const trench = buildTrenchTin({
        planGroups: freshPlan,
        halfWidth: 0.25,
        includeAbsorption: true,
        includeCollector: true,
        applyTransition: true,
        transitionDistance: 5.0,
        trimClearance: 0.10,
      })
      setTrenchSurface(trench)
      setGroundSurface(null)
      setDataSourceLabel(`施工計画から取込（暗渠 ${freshPipes.length} / 計画 ${freshPlan.length} 系統）`)
    } catch (err) {
      setDataError(err instanceof Error ? err.message : '施工計画の取込に失敗')
    } finally {
      setImporting(false)
    }
  }

  // TIN インデックス
  const trenchIdx = useMemo<TinIndex | null>(() => (trenchSurface ? indexTin(trenchSurface) : null), [trenchSurface])
  const groundIdx = useMemo<TinIndex | null>(() => (groundSurface ? indexTin(groundSurface) : null), [groundSurface])

  // 自己 XY と TIN 標高
  const selfXY = useMemo(() => (currentPos ? converter.toXY(currentPos[0], currentPos[1]) : null), [currentPos, converter])
  const trenchZ = useMemo<number | null>(() => (trenchIdx && selfXY ? queryZ(trenchIdx, selfXY.x, selfXY.y) : null), [trenchIdx, selfXY])
  const groundZ = useMemo<number | null>(() => (groundIdx && selfXY ? queryZ(groundIdx, selfXY.x, selfXY.y) : null), [groundIdx, selfXY])

  // 実効補正値: 簡易測定モードでは補正を無効化（生の楕円体高、アンテナ高 0）
  // 精密モードではユーザー設定値を使う
  const effUseGeoid = positioningMode === 'gps' ? false : useGeoidCorrection
  const effAntennaHeight = positioningMode === 'gps' ? 0 : antennaHeight

  // 自己標高（補正後）— 既存の計算ロジックをここで再利用
  const selfElevation = useMemo<number | null>(() => {
    if (currentAlt === null || currentPos === null) return null
    if (effUseGeoid && geoidGrid) {
      const rRow = (geoidGrid.latMax - currentPos[0]) / geoidGrid.dLat
      const rCol = (currentPos[1] - geoidGrid.lonMin) / geoidGrid.dLon
      if (rRow >= 0 && rCol >= 0 && rRow < geoidGrid.nrows && rCol < geoidGrid.ncols) {
        const r0 = Math.floor(rRow), c0 = Math.floor(rCol)
        const r1 = Math.min(r0 + 1, geoidGrid.nrows - 1)
        const c1 = Math.min(c0 + 1, geoidGrid.ncols - 1)
        const tr = rRow - r0, tc = rCol - c0
        const v00 = geoidGrid.values[r0 * geoidGrid.ncols + c0]
        const v01 = geoidGrid.values[r0 * geoidGrid.ncols + c1]
        const v10 = geoidGrid.values[r1 * geoidGrid.ncols + c0]
        const v11 = geoidGrid.values[r1 * geoidGrid.ncols + c1]
        const N = (v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr
        if (Number.isFinite(N)) return currentAlt - N - effAntennaHeight
      }
    }
    return currentAlt - effAntennaHeight
  }, [currentAlt, currentPos, effUseGeoid, geoidGrid, effAntennaHeight])

  const trenchDiff = trenchZ !== null && selfElevation !== null ? selfElevation - trenchZ : null
  const groundDiff = groundZ !== null && selfElevation !== null ? selfElevation - groundZ : null

  // 床掘 TIN の三角形エッジ（lat/lng）
  const trenchEdges = useMemo<Array<[number, number][]>>(() => {
    if (!trenchSurface) return []
    const edges: Array<[number, number][]> = []
    for (const tri of trenchSurface.triangles) {
      const a = trenchSurface.points[tri.a]
      const b = trenchSurface.points[tri.b]
      const c = trenchSurface.points[tri.c]
      if (!a || !b || !c) continue
      const aa = converter.toLatLng(a.x, a.y)
      const bb = converter.toLatLng(b.x, b.y)
      const cc = converter.toLatLng(c.x, c.y)
      edges.push([[aa.lat, aa.lng], [bb.lat, bb.lng], [cc.lat, cc.lng], [aa.lat, aa.lng]])
    }
    return edges
  }, [trenchSurface, converter])

  const diffColor = (dz: number): string => {
    const a = Math.abs(dz)
    if (a < 0.05) return '#10b981'
    if (a < 0.10) return '#84cc16'
    if (a < 0.20) return '#eab308'
    if (a < 0.50) return '#f97316'
    return '#ef4444'
  }
  // ========== 施工管理モード関連 終 ==========

  // ========== 断面（クロスセクション） ==========
  const activeSection = useMemo(
    () => sections.find((s) => s.id === activeSectionId && s.id !== 'pending') ?? null,
    [sections, activeSectionId],
  )

  // 表示用の断面線（along/perp）の lat/lng 端点
  const activeSectionLine = useMemo<[[number, number], [number, number]] | null>(() => {
    if (!activeSection) return null
    if (activeSection.direction === 'along') return [activeSection.a, activeSection.b]
    const A0 = converter.toXY(activeSection.a[0], activeSection.a[1])
    const B0 = converter.toXY(activeSection.b[0], activeSection.b[1])
    const Mx = (A0.x + B0.x) / 2
    const My = (A0.y + B0.y) / 2
    const dN = B0.x - A0.x
    const dE = B0.y - A0.y
    const L = Math.hypot(dN, dE)
    if (L === 0) return [activeSection.a, activeSection.b]
    const half = L / 2
    const nx = -dE / L
    const ny = dN / L
    const p1 = converter.toLatLng(Mx - nx * half, My - ny * half)
    const p2 = converter.toLatLng(Mx + nx * half, My + ny * half)
    return [
      [p1.lat, p1.lng],
      [p2.lat, p2.lng],
    ]
  }, [activeSection, converter])

  // 断面プロファイル: TIN サンプル + 現況点（記録の射影）
  const sectionProfile = useMemo(() => {
    if (!activeSection) return null
    const A0 = converter.toXY(activeSection.a[0], activeSection.a[1])
    const B0 = converter.toXY(activeSection.b[0], activeSection.b[1])
    let Ax: number, Ay: number, Bx: number, By: number
    if (activeSection.direction === 'perp') {
      const Mx = (A0.x + B0.x) / 2
      const My = (A0.y + B0.y) / 2
      const dN = B0.x - A0.x
      const dE = B0.y - A0.y
      const L0 = Math.hypot(dN, dE)
      const half = L0 / 2
      const nx = -dE / L0
      const ny = dN / L0
      Ax = Mx - nx * half; Ay = My - ny * half
      Bx = Mx + nx * half; By = My + ny * half
    } else {
      Ax = A0.x; Ay = A0.y; Bx = B0.x; By = B0.y
    }
    const dx = Bx - Ax
    const dy = By - Ay
    const len = Math.hypot(dx, dy)
    const N = 100
    const tinPts: { d: number; z: number | null }[] = []
    for (let i = 0; i <= N; i++) {
      const t = i / N
      const x = Ax + dx * t
      const y = Ay + dy * t
      const z = trenchIdx ? queryZ(trenchIdx, x, y) : null
      tinPts.push({ d: t * len, z })
    }
    const L2 = dx * dx + dy * dy
    const recPts: { d: number; z: number; name: string }[] = []
    for (const r of records) {
      if (r.measuredZ == null) continue
      const t = ((r.measuredX - Ax) * dx + (r.measuredY - Ay) * dy) / L2
      if (t < 0 || t > 1) continue
      const fx = Ax + t * dx
      const fy = Ay + t * dy
      const dist = Math.hypot(r.measuredX - fx, r.measuredY - fy)
      if (dist > sectionToleranceM) continue // 断面線から ±sectionToleranceM 以内のみ
      recPts.push({ d: t * len, z: r.measuredZ, name: r.targetName ?? '' })
    }
    return { length: len, tinPts, recPts }
  }, [activeSection, converter, trenchIdx, records, sectionToleranceM])

  // ターゲット一覧（座標管理 + 暗渠頂点）
  const targets = useMemo<StakingTarget[]>(() => {
    const out: StakingTarget[] = []
    for (const c of coordinates as CoordinateRow[]) {
      if (c.lat == null || c.lng == null) continue
      const sub = (c.type ?? 'other') as string
      out.push({
        id: `c-${c.id}`,
        kind: 'coordinate',
        refId: c.id,
        vertexIndex: null,
        name: c.pointNumber,
        x: c.x,
        y: c.y,
        z: c.z,
        lat: c.lat,
        lng: c.lng,
        subType: sub,
        subTypeLabel: getCoordinateTypeLabel(sub, projectId, pointTypesByProject),
        stakeStatus: c.stakeStatus,
      })
    }
    for (const pipe of pipes as PipeRow[]) {
      // 暗渠頂点は点種（基準点/境界点/現況）と並列で扱うため、管種別ではなく
      // 一括で '_pipe_vertex' / '暗渠頂点' として 1 つの subType にまとめる
      for (let i = 0; i < pipe.vertices.length; i++) {
        const v = pipe.vertices[i]
        try {
          const { lat, lng } = converter.toLatLng(v.x, v.y)
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
          const total = pipe.vertices.length
          let suffix: string
          if (i === 0) suffix = 'C'
          else if (i === total - 1) suffix = 'A'
          else suffix = `B${total - 1 - i}`
          out.push({
            id: `v-${pipe.id}-${i}`,
            kind: 'pipe_vertex',
            refId: pipe.id,
            vertexIndex: i,
            name: `${pipe.number}${suffix}`,
            x: v.x,
            y: v.y,
            z: v.z,
            lat,
            lng,
            subType: '_pipe_vertex',
            subTypeLabel: '暗渠頂点',
            stakeStatus: 'unset',
          })
        } catch {
          // skip
        }
      }
    }
    return out
  }, [coordinates, pipes, converter, projectId, pointTypesByProject])

  // 出力点選択（順路）に従ってターゲットを並べ替える。
  // 順路にある点（x,y で一致判定）を先に並べ、無い点は元の順序で末尾へ。
  // 順路が未保存の工区では何もせずそのまま返す。
  const route = useExportRouteStore((s) =>
    farmId ? s.routesByFarmId.get(farmId) ?? null : null,
  )
  // ルート順に並べた targets と、ルートに含まれる ID 集合を返す。
  // ルート点はルート点名（座標計算で集約された名前）で name を上書きする。
  // ルート未保存（または空）なら ordered=targets / routeIds=空集合。
  const { orderedTargets, routeTargetIds } = useMemo(() => {
    if (!route || route.length === 0) {
      return { orderedTargets: targets, routeTargetIds: new Set<string>() }
    }
    const TOL = 0.1 // 10cm
    const used = new Set<string>()
    const ordered: StakingTarget[] = []
    for (const rp of route as RoutePoint[]) {
      const hit = targets.find(
        (t) =>
          !used.has(t.id) &&
          Math.abs(t.x - rp.x) <= TOL &&
          Math.abs(t.y - rp.y) <= TOL,
      )
      if (hit) {
        ordered.push({ ...hit, name: rp.name })
        used.add(hit.id)
      }
    }
    for (const t of targets) {
      if (!used.has(t.id)) ordered.push(t)
    }
    return { orderedTargets: ordered, routeTargetIds: used }
  }, [targets, route])

  const filteredTargets = useMemo(() => {
    let base = orderedTargets
    if (targetFilter === 'route') {
      base = orderedTargets.filter((t) => routeTargetIds.has(t.id))
    } else if (targetFilter !== 'all') {
      base = orderedTargets.filter((t) => t.kind === targetFilter)
    }
    return base.filter((t) => {
      if (hiddenSubTypes.has(t.subType)) return false
      // 設置状態フィルタは coordinate にのみ適用（pipe_vertex は対象外）
      if (t.kind === 'coordinate' && !visibleStakeStatuses.has(t.stakeStatus)) {
        return false
      }
      return true
    })
  }, [orderedTargets, routeTargetIds, targetFilter, hiddenSubTypes, visibleStakeStatuses])

  // 現在表示候補（major filter 適用後）における点種ごとの件数を集計
  const subTypeStats = useMemo(() => {
    let base = orderedTargets
    if (targetFilter === 'route') {
      base = orderedTargets.filter((t) => routeTargetIds.has(t.id))
    } else if (targetFilter !== 'all') {
      base = orderedTargets.filter((t) => t.kind === targetFilter)
    }
    const map = new Map<string, { label: string; count: number; kind: TargetKind }>()
    for (const t of base) {
      const cur = map.get(t.subType)
      if (cur) cur.count++
      else map.set(t.subType, { label: t.subTypeLabel, count: 1, kind: t.kind })
    }
    return Array.from(map.entries()).map(([code, v]) => ({ code, ...v }))
  }, [orderedTargets, routeTargetIds, targetFilter])

  // 新点記録時に選べる点種（既定 + プロジェクトのカスタム点種）
  const typeOptions = useMemo(
    () => getCoordinateTypeOptions(projectId, pointTypesByProject),
    [projectId, pointTypesByProject],
  )

  // ルート点はルート点名（座標計算で集約された名前）で上書き済みの orderedTargets を使う
  const selectedTarget = useMemo(
    () => orderedTargets.find((t) => t.id === selectedTargetId) ?? null,
    [orderedTargets, selectedTargetId],
  )


  const distanceToTarget = useMemo(() => {
    if (!currentPos || !selectedTarget) return null
    return distanceMeters(
      { lat: currentPos[0], lng: currentPos[1] },
      { lat: selectedTarget.lat, lng: selectedTarget.lng },
    )
  }, [currentPos, selectedTarget])

  const bearingToTarget = useMemo(() => {
    if (!currentPos || !selectedTarget) return null
    return bearingDeg(
      { lat: currentPos[0], lng: currentPos[1] },
      { lat: selectedTarget.lat, lng: selectedTarget.lng },
    )
  }, [currentPos, selectedTarget])

  // 現在位置を平面直角座標 (X=北, Y=東) に変換
  const currentXY = useMemo(() => {
    if (!currentPos) return null
    try {
      return converter.toXY(currentPos[0], currentPos[1])
    } catch {
      return null
    }
  }, [currentPos, converter])

  // 近接モード: 自己位置→ターゲットの相対位置（測量座標 X=北/Y=東 ベースで高精度）
  const proximityRel = useMemo(() => {
    if (!currentXY || !selectedTarget || selectedTarget.x == null || selectedTarget.y == null) {
      return null
    }
    const dN = selectedTarget.x - currentXY.x // 北方向の差
    const dE = selectedTarget.y - currentXY.y // 東方向の差
    const dist = Math.hypot(dN, dE)
    return { dN, dE, dist }
  }, [currentXY, selectedTarget])

  // 1m 以内 かつ 未キャンセル のとき近接モードを表示
  const proximityActive = proximityRel != null && proximityRel.dist <= 1.0 && !proximityCancelled

  // 範囲外（1.2m 超のヒステリシス）に出たらキャンセルを解除して再表示できるようにする
  useEffect(() => {
    if (proximityRel == null || proximityRel.dist > 1.2) {
      setProximityCancelled(false)
    }
  }, [proximityRel])
  // ターゲットを切り替えたらキャンセル状態をリセット
  useEffect(() => {
    setProximityCancelled(false)
  }, [selectedTargetId])

  // ========== 音声ガイダンス ==========
  // FIX 時: 1Hz で「ピッ」。ターゲット 1m 以内で「ピピ」、10cm 以内で「ピピピ」。
  // FIX が外れた瞬間だけ「ブーッ」。
  const [soundEnabled, setSoundEnabled] = useState(false)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const soundAccRef = useRef<number | null>(null)
  const soundDistRef = useRef<number | null>(null)
  const prevFixRef = useRef<boolean>(false)
  // 最新の精度・ターゲット距離をタイマーから参照できるよう ref に同期
  useEffect(() => {
    soundAccRef.current = currentAcc
  }, [currentAcc])
  useEffect(() => {
    soundDistRef.current = proximityRel?.dist ?? null
  }, [proximityRel])

  // 1Hz ビープのループ。しきい値変更時は setInterval を再セットアップ
  useEffect(() => {
    if (!soundEnabled) return
    const ctx = audioCtxRef.current
    if (!ctx) return
    prevFixRef.current = soundAccRef.current != null && soundAccRef.current <= rtkFixAccuracyM
    const id = window.setInterval(() => {
      // 棄却フェーズ (連続 1〜5 回) の間は FIX 音を止める
      if (rejectingCountRef.current > 0) return
      // 位置更新が途絶えている (RTK 受信機切断等) → FIX 状態ではないのでビープしない
      if (
        lastPosTimeRef.current === 0 ||
        Date.now() - lastPosTimeRef.current > POSITION_STALE_MS
      ) {
        return
      }
      const acc = soundAccRef.current
      const fix = acc != null && acc <= rtkFixAccuracyM
      if (!fix) return
      const d = soundDistRef.current
      let count = 1
      if (d != null && d <= 0.1) count = 3
      else if (d != null && d <= 1.0) count = 2
      playBeeps(ctx, count)
    }, 1000)
    return () => window.clearInterval(id)
  }, [soundEnabled, rtkFixAccuracyM])

  // 位置更新の鮮度を state 化 (React で useEffect が反応するように 1Hz でチェック)。
  // これで「更新が止まって FIX 喪失扱い」の遷移を warning buzzer トリガに繋げられる。
  const [posStale, setPosStale] = useState(false)
  useEffect(() => {
    const id = window.setInterval(() => {
      const stale =
        lastPosTimeRef.current === 0 ||
        Date.now() - lastPosTimeRef.current > POSITION_STALE_MS
      setPosStale((prev) => (prev === stale ? prev : stale))
    }, 500)
    return () => window.clearInterval(id)
  }, [])

  // FIX→喪失の瞬間に警告音（ブーッ）を 1 回。「精度悪化」と「更新途絶」の両方を FIX 喪失とみなす。
  const soundIsFix =
    !posStale && currentAcc != null && currentAcc <= rtkFixAccuracyM
  useEffect(() => {
    if (!soundEnabled) {
      prevFixRef.current = soundIsFix
      return
    }
    if (prevFixRef.current && !soundIsFix) {
      const ctx = audioCtxRef.current
      if (ctx) playBuzzer(ctx)
    }
    prevFixRef.current = soundIsFix
  }, [soundIsFix, soundEnabled])

  // 音声 ON/OFF（ON 時はユーザー操作中に AudioContext を生成・再開）
  const toggleSound = async () => {
    if (soundEnabled) {
      setSoundEnabled(false)
      return
    }
    try {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) {
        alert('この端末は音声ガイダンスに対応していません')
        return
      }
      const ctx = audioCtxRef.current ?? new Ctor()
      audioCtxRef.current = ctx
      await ctx.resume()
      playBeeps(ctx, 1) // 起動確認音
      setSoundEnabled(true)
    } catch {
      alert('音声を開始できませんでした')
    }
  }

  // アンマウント時に AudioContext を閉じる
  useEffect(() => {
    return () => {
      audioCtxRef.current?.close().catch(() => {})
    }
  }, [])

  // 工区全体の bounds（自己位置は含めず、開いた直後の初期表示用）
  const allBounds = useMemo(() => {
    const all: [number, number][] = []
    for (const t of targets) all.push([t.lat, t.lng])
    if (all.length === 0) return null
    const lats = all.map((p) => p[0])
    const lngs = all.map((p) => p[1])
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)])
  }, [targets])

  // 配線（吸水管・集水管）の線形を緯度経度ポリラインに変換
  const pipePolylines = useMemo(() => {
    const out: Array<{
      id: string
      pipeType: 'branch' | 'collector'
      number: string
      positions: [number, number][]
    }> = []
    for (const pipe of pipes as PipeRow[]) {
      if (pipe.vertices.length < 2) continue
      const positions: [number, number][] = []
      for (const v of pipe.vertices) {
        try {
          const { lat, lng } = converter.toLatLng(v.x, v.y)
          if (Number.isFinite(lat) && Number.isFinite(lng)) positions.push([lat, lng])
        } catch {
          // skip
        }
      }
      if (positions.length < 2) continue
      out.push({
        id: pipe.id,
        // branch=吸水管、それ以外（main/collector/outlet等）はまとめて collector 扱い
        pipeType: pipe.pipeType === 'branch' ? 'branch' : 'collector',
        number: pipe.number,
        positions,
      })
    }
    return out
  }, [pipes, converter])

  // 既に測設済みのターゲット ID 集合
  // 同じ refId/vertexIndex で targetType が free 以外の記録があれば測設済みとみなす
  // （許容超過で「そのまま測設」を選んだ場合も測設済みに含めるため、距離判定は行わない）
  const stakedTargetIds = useMemo(() => {
    const set = new Set<string>()
    for (const t of targets) {
      const hit = records.some((r) => {
        if (r.targetType === 'free') return false
        if (r.targetType !== t.kind) return false
        if (r.targetRefId !== t.refId) return false
        if (t.kind === 'pipe_vertex' && r.targetVertexIndex !== t.vertexIndex) return false
        return true
      })
      if (hit) set.add(t.id)
    }
    return set
  }, [targets, records])

  // 記録開始
  const startRecording = (opts: { forceFreePoint?: boolean } = {}) => {
    if (recording) return
    if (!('geolocation' in navigator)) {
      alert('Geolocation が利用できません')
      return
    }
    if (!farmId) return
    // モード未選択なら選択モーダルを出す
    // （RTK の開始前チェックは選択時に出るのでここでは再表示しない）
    if (positioningMode == null) {
      setShowModeChooser(true)
      return
    }
    recSamplesRef.current = []
    setRecordedCount(0)
    setRejectedCount(0)
    recForceFreeRef.current = !!opts.forceFreePoint
    setRecording(true)
    // 開始音（ユーザ操作直後なので AudioContext を resume してから鳴らす）
    void unlockAudio().then(() => playStartChime())

    // スマホ GPS モード: 1 発計測。
    // getCurrentPosition を呼び直すと iPhone が GPS を再測位して数秒〜十数秒待たされるので、
    // すでに watchPosition が更新している currentPos / currentAcc / currentAlt をそのまま
    // スナップショットして即 finish する。
    if (positioningMode === 'gps') {
      if (!currentPos) {
        alert('位置情報を取得できませんでした')
        setRecording(false)
        return
      }
      recSamplesRef.current = [
        {
          lat: currentPos[0],
          lng: currentPos[1],
          alt: currentAlt,
          acc: currentAcc,
        },
      ]
      setRecordedCount(1)
      void finishRecording()
      return
    }

    // 以降は RTK モード（従来の平均化フロー）
    recEndMsRef.current = Date.now() + avgSeconds * 1000

    // 1 サンプルあたりのおおよその間隔（GPS の watchPosition は機種で揺れるが
    // ハイエンドで概ね 1 秒に 1 回）。棄却 1 回につきこの時間だけ終了時刻を後ろへ。
    const REJECT_EXTEND_MS = 1000

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        const sample = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          alt: pos.coords.altitude,
          acc: pos.coords.accuracy,
        }
        const accepted = recSamplesRef.current
        // 2 サンプル以上溜まったら、それまでの平均から 3cm 以上ずれた点はノイズ
        // として棄却する。棄却した分だけ目標終了時刻を後ろへ延長して、
        // 規定数の有効サンプルが揃うまで観測を継続する。
        if (accepted.length >= 2) {
          let sumLat = 0
          let sumLng = 0
          for (const p of accepted) {
            sumLat += p.lat
            sumLng += p.lng
          }
          const avgLat = sumLat / accepted.length
          const avgLng = sumLng / accepted.length
          const d = distanceMeters({ lat: sample.lat, lng: sample.lng }, { lat: avgLat, lng: avgLng })
          if (d > 0.03) {
            // 棄却して時間を延ばす
            recEndMsRef.current += REJECT_EXTEND_MS
            setRejectedCount((n) => n + 1)
            return
          }
        }
        accepted.push(sample)
        setRecordedCount(accepted.length)
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    )

    recCleanupRef.current = () => {
      try {
        navigator.geolocation.clearWatch(watchId)
      } catch {
        // ignore
      }
      if (recEndIntervalRef.current != null) {
        window.clearInterval(recEndIntervalRef.current)
        recEndIntervalRef.current = null
      }
    }
    // 終了時刻が動的に伸びるので setTimeout ではなく interval で監視する
    recEndIntervalRef.current = window.setInterval(() => {
      if (Date.now() >= recEndMsRef.current) {
        void finishRecording()
      }
    }, 250)
  }

  // 記録終了・保存
  const finishRecording = async () => {
    if (recTimerRef.current != null) {
      window.clearTimeout(recTimerRef.current)
      recTimerRef.current = null
    }
    if (recEndIntervalRef.current != null) {
      window.clearInterval(recEndIntervalRef.current)
      recEndIntervalRef.current = null
    }
    if (recCleanupRef.current) {
      recCleanupRef.current()
      recCleanupRef.current = null
    }
    const samples = recSamplesRef.current
    setRecording(false)
    // 終了音
    playStopChime()
    if (samples.length === 0) {
      alert('位置情報が取得できませんでした')
      return
    }
    if (!farmId) return

    // 平均値を算出
    let sumLat = 0
    let sumLng = 0
    let sumAlt = 0
    let altCount = 0
    let maxAcc = 0
    for (const s of samples) {
      sumLat += s.lat
      sumLng += s.lng
      if (s.alt != null && Number.isFinite(s.alt)) {
        sumAlt += s.alt
        altCount++
      }
      if (s.acc != null && Number.isFinite(s.acc)) {
        maxAcc = Math.max(maxAcc, s.acc)
      }
    }
    const avgLat = sumLat / samples.length
    const avgLng = sumLng / samples.length
    const rawEllipsoidal = altCount > 0 ? sumAlt / altCount : null

    // 標高 = 楕円体高 − ジオイド高 − アンテナ高
    // 実効補正値（effUseGeoid / effAntennaHeight）は簡易測定モードで自動 OFF/0 になる
    let geoidN: number | null = null
    if (effUseGeoid && geoidGrid) {
      const { lookupGeoid } = await import('@/lib/geoid')
      geoidN = lookupGeoid(geoidGrid, avgLat, avgLng)
    }
    const avgAlt = rawEllipsoidal !== null
      ? (geoidN !== null ? rawEllipsoidal - geoidN - effAntennaHeight : rawEllipsoidal - effAntennaHeight)
      : null

    const { x, y } = converter.toXY(avgLat, avgLng)

    // 互換用フラグ（将来再利用に備えて残置）
    recForceFreeRef.current = false

    // ターゲット未選択時 or ターゲットに座標が無い場合 → 新点記録に直行
    let mode: 'stake' | 'free' = 'stake'
    let dist: number | null = null
    if (!selectedTarget) {
      mode = 'free'
    } else {
      const dX = selectedTarget.x != null ? x - selectedTarget.x : null
      const dY = selectedTarget.y != null ? y - selectedTarget.y : null
      dist = dX != null && dY != null ? Math.hypot(dX, dY) : null
      if (dist === null) {
        // 座標欠落のターゲット → 新点扱い
        mode = 'free'
      } else if (dist > STAKE_TOLERANCE_M) {
        // 誤差超過時はユーザーに 3 択を聞く
        const choice = await new Promise<'stake' | 'free' | 'cancel'>((resolve) => {
          setErrorChoice({ distance: dist as number, resolve })
        })
        if (choice === 'cancel') return
        mode = choice
      }
    }

    if (mode === 'stake' && selectedTarget && dist != null) {
      // 測設記録の点名:
      //   1 回目 → "G_" + 元点名
      //   2 回目 → "G2_" + 元点名
      // 同じターゲット（farmId + surveyCategory + targetRefId + vertexIndex）への
      // 実測は 2 回まで。3 回目以降は「測設記録」画面で削除してから再測する運用。
      const existing = records.filter(
        (r) =>
          r.farmId === farmId &&
          r.surveyCategory === surveyCategory &&
          r.targetType === selectedTarget.kind &&
          r.targetRefId === selectedTarget.refId &&
          r.targetVertexIndex === selectedTarget.vertexIndex,
      ).length
      const MAX_PER_TARGET = 2
      if (existing >= MAX_PER_TARGET) {
        alert(
          `${selectedTarget.name} は既に ${existing} 回 実測済みです（上限 ${MAX_PER_TARGET} 回）。\n` +
            `古い記録を「実測記録」画面で削除してから再測してください。`,
        )
        return
      }
      const stakeRecordName =
        existing === 0 ? `G_${selectedTarget.name}` : `G2_${selectedTarget.name}`

      const saved = await addRecord({
        farmId,
        surveyCategory,
        targetType: selectedTarget.kind,
        targetRefId: selectedTarget.refId,
        targetVertexIndex: selectedTarget.vertexIndex,
        targetName: stakeRecordName,
        targetX: selectedTarget.x,
        targetY: selectedTarget.y,
        targetZ: selectedTarget.z,
        measuredX: x,
        measuredY: y,
        measuredZ: avgAlt,
        accuracy: maxAcc || null,
        sampleCount: samples.length,
        durationSeconds: avgSeconds,
        notes: null,
      })
      if (saved) {
        // 座標管理にも自動登録（新点と同じ扱い）。
        // 点種は「実測点 = measured」、出所が分かるよう notes に
        // 'mobile_measurement' を入れる。同名が既に居る場合はスキップ。
        const existsName = coordinates.some((c) => c.pointNumber === stakeRecordName)
        if (!existsName) {
          const inserted = await importCoordinates([
            {
              pointNumber: stakeRecordName,
              x,
              y,
              z: avgAlt,
              type: 'measured' as unknown as CoordinateRow['type'],
              notes: 'mobile_measurement',
            },
          ])
          if (inserted.length > 0) {
            setShareToast(`${stakeRecordName} を座標管理にも登録`)
            window.setTimeout(() => setShareToast(null), 2500)
          } else {
            const errMsg = useCoordinateStore.getState().error ?? '不明なエラー'
            setShareToast(`${stakeRecordName} の座標管理登録に失敗: ${errMsg}`)
            window.setTimeout(() => setShareToast(null), 4500)
          }
        }
        const msg =
          `${stakeRecordName} を測設しました（ターゲット: ${selectedTarget.name}）\n` +
          `誤差 ${dist.toFixed(3)} m / 精度 ${maxAcc.toFixed(3)} m / ${samples.length} サンプル`
        // 結果モーダルを開いて OK or 写真撮影 を待つ
        const action = await new Promise<'ok' | 'photo'>((resolve) => {
          setPostStakeDialog({ message: msg, target: selectedTarget, resolve })
        })
        const measuredTarget = selectedTarget
        const idx = filteredTargets.findIndex((t) => t.id === selectedTarget.id)
        const next = idx >= 0 ? filteredTargets[idx + 1] : null
        setSelectedTargetId(next?.id ?? null)
        // OK なら測点モーダル、写真撮影 なら写真モーダルが postStakeDialog 側で開いているので何もしない
        if (action === 'ok') {
          setPointInfoTarget(measuredTarget)
        }
      }
      return
    }

    // mode === 'free' : 新点計測完了モーダルを開いて確定を待つ
    const freeCount = records.filter((r) => r.targetType === 'free').length
    const defaultName = `新点-${freeCount + 1}`
    setFreePointDialog({
      defaultName,
      x,
      y,
      z: avgAlt,
      distance: dist,
      accuracy: maxAcc,
      sampleCount: samples.length,
      antennaHeight: effAntennaHeight,
    })
  }

  // 新点モーダルからの確定処理（OK or 写真撮影）。type は点種コード、prefix は頭文字
  const handleFreePointConfirm = async (
    name: string,
    type: string,
    prefix: string,
    openPhoto: boolean,
  ) => {
    const d = freePointDialog
    if (!d || !farmId) return
    setFreePointDialog(null)
    pushRecentPrefix(prefix)
    const saved = await addRecord({
      farmId,
      surveyCategory,
      targetType: 'free',
      targetRefId: null,
      targetVertexIndex: null,
      targetName: name,
      targetX: null,
      targetY: null,
      targetZ: null,
      measuredX: d.x,
      measuredY: d.y,
      measuredZ: d.z,
      accuracy: d.accuracy || null,
      sampleCount: d.sampleCount,
      durationSeconds: avgSeconds,
      notes: null,
    })
    if (!saved) return
    // 座標管理にも自動登録（重複点番号があればスキップ）。
    // 出所が分かるよう notes に 'mobile_measurement' を入れておく。
    // 失敗時はサイレントに握りつぶさず、トーストで知らせる（マーカーが
    // 出ない原因を画面で追えるようにする）。
    const exists = coordinates.some((c) => c.pointNumber === name)
    let createdId: string | null = null
    if (!exists) {
      const inserted = await importCoordinates([
        {
          pointNumber: name,
          x: d.x,
          y: d.y,
          z: d.z,
          type: type as unknown as CoordinateRow['type'],
          notes: 'mobile_measurement',
        },
      ])
      if (inserted.length > 0) {
        createdId = inserted[0].id
        setShareToast(`新点 ${name} を座標管理に登録`)
        window.setTimeout(() => setShareToast(null), 2500)
      } else {
        const errMsg = useCoordinateStore.getState().error ?? '不明なエラー'
        setShareToast(`新点 ${name} の座標管理登録に失敗: ${errMsg}`)
        window.setTimeout(() => setShareToast(null), 4500)
      }
    } else {
      const hit = coordinates.find((c) => c.pointNumber === name)
      createdId = hit?.id ?? null
      setShareToast(`座標管理に同名の点があるためスキップ: ${name}`)
      window.setTimeout(() => setShareToast(null), 2500)
    }
    if (openPhoto && createdId && farm?.project_id) {
      // 写真モーダルを開くために、StakingTarget 形式に変換
      setPhotoModalTarget({
        id: `c-${createdId}`,
        kind: 'coordinate',
        refId: createdId,
        vertexIndex: null,
        name,
        x: d.x,
        y: d.y,
        z: d.z,
        lat: 0,
        lng: 0,
        subType: type,
        subTypeLabel: getCoordinateTypeLabel(type, projectId, pointTypesByProject),
        stakeStatus: 'unset',
      })
    }
  }

  // 記録せずに測設済としてマークする（or マーク解除）
  // measuredXY = targetXY、notes='manual_mark' の擬似レコードで stakedTargetIds に乗せる
  const handleToggleManualStaked = async (target: StakingTarget) => {
    if (!farmId) return
    const existing = records.find(
      (r) =>
        r.notes === 'manual_mark' &&
        r.farmId === farmId &&
        r.surveyCategory === surveyCategory &&
        r.targetType === target.kind &&
        r.targetRefId === target.refId &&
        r.targetVertexIndex === target.vertexIndex,
    )
    if (existing) {
      if (!confirm(`${target.name} の測設済マークを解除しますか？`)) return
      await deleteRecord(existing.id)
      return
    }
    // 既に GPS で測設済みの場合は手動マークしない（記録が重複してしまうため）
    if (stakedTargetIds.has(target.id)) {
      alert(`${target.name} は既に測設済みです。`)
      return
    }
    if (!confirm(`${target.name} を記録なしで測設済としてマークしますか？`)) return
    await addRecord({
      farmId,
      surveyCategory,
      targetType: target.kind,
      targetRefId: target.refId,
      targetVertexIndex: target.vertexIndex,
      targetName: `G${target.name}`,
      targetX: target.x,
      targetY: target.y,
      targetZ: target.z,
      measuredX: target.x,
      measuredY: target.y,
      measuredZ: target.z,
      accuracy: null,
      sampleCount: 0,
      durationSeconds: null,
      notes: 'manual_mark',
    })
  }

  const cancelRecording = () => {
    if (recTimerRef.current != null) {
      window.clearTimeout(recTimerRef.current)
      recTimerRef.current = null
    }
    if (recEndIntervalRef.current != null) {
      window.clearInterval(recEndIntervalRef.current)
      recEndIntervalRef.current = null
    }
    if (recCleanupRef.current) {
      recCleanupRef.current()
      recCleanupRef.current = null
    }
    recSamplesRef.current = []
    setRecordedCount(0)
    setRejectedCount(0)
    setRecording(false)
    recForceFreeRef.current = false
  }

  // アンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      if (recTimerRef.current != null) window.clearTimeout(recTimerRef.current)
      if (recCleanupRef.current) recCleanupRef.current()
    }
  }, [])

  // 写真モーダルを開く（座標のみ対応）
  const handleOpenPhotoModal = () => {
    if (!selectedTarget) return
    if (selectedTarget.kind !== 'coordinate') {
      alert('現状は座標管理点の写真のみ登録できます。')
      return
    }
    setPhotoModalTarget(selectedTarget)
  }

  // SIM インポート
  const simInputRef = useRef<HTMLInputElement>(null)
  const handleOpenSimImport = () => simInputRef.current?.click()
  const handleSimImported = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !farmId) return
    try {
      const result = await loadSimaFile(file)
      const newCoords = result.coordinates.map((coord) => ({
        pointNumber: coord.pointNumber,
        x: coord.x,
        y: coord.y,
        z: coord.z,
        type: 'boundary' as unknown as CoordinateRow['type'],
      }))
      await importCoordinates(newCoords)
      const projectZone = project?.coordinate_zone ?? null
      if (result.system !== null && projectZone !== null && result.system !== projectZone) {
        alert(
          `SIMA ファイルの座標系（第${result.system}系）が工事の座標系（第${projectZone}系）と異なります。\n` +
            '座標値はそのまま読み込みました。',
        )
      } else {
        alert(`${newCoords.length} 点をインポートしました`)
      }
    } catch (err) {
      console.error('SIMA 読み込み失敗', err)
      alert('SIMA ファイルの読み込みに失敗しました')
    }
  }

  // SIM エクスポート（全座標を出力）
  const handleSimExport = () => {
    if (coordinates.length === 0) {
      alert('エクスポートできる座標がありません')
      return
    }
    const projectName = farm?.name || 'NoName'
    const zoneNum = project?.coordinate_zone ?? 13
    downloadSimaFile(
      {
        projectName,
        zone: zoneNum,
        points: coordinates.map((c) => ({
          pointNumber: c.pointNumber,
          x: c.x,
          y: c.y,
          z: c.z,
        })),
      },
      `${projectName}_coordinates.sim`,
    )
  }

  // 公開ビュー URL を取得して共有 or クリップボードコピー
  const handleShare = async () => {
    if (!farmId) return
    const url = `${window.location.origin}/share/farm/${farmId}`
    const shareTitle = farm?.name ? `工区「${farm.name}」` : '工区の起工測量データ'
    const navAny = navigator as Navigator & {
      share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>
    }
    try {
      if (navAny.share) {
        await navAny.share({ title: shareTitle, url })
        setShareToast('共有メニューを開きました')
      } else {
        await navigator.clipboard.writeText(url)
        setShareToast('共有リンクをコピーしました')
      }
    } catch {
      // share がキャンセル等で失敗してもコピーは試みる
      try {
        await navigator.clipboard.writeText(url)
        setShareToast('共有リンクをコピーしました')
      } catch {
        setShareToast(url)
      }
    }
    window.setTimeout(() => setShareToast(null), 3500)
  }

  const mapCenter: [number, number] = currentPos
    ? currentPos
    : allBounds
      ? [
          (allBounds.getNorth() + allBounds.getSouth()) / 2,
          (allBounds.getEast() + allBounds.getWest()) / 2,
        ]
      : [43.06, 141.35]

  if (loading) {
    return (
      <div className="mobile-min-screen flex flex-col items-center justify-center bg-slate-100 gap-3 px-6 text-center">
        <Loader2 className="h-10 w-10 animate-spin text-blue-600" />
        <div className="text-sm font-medium text-slate-800">工区データを読込中…</div>
        <div className="text-xs text-slate-500">
          座標・工事区域・地番などを取得しています。初回は数秒〜数十秒かかります。
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="mobile-min-screen flex flex-col bg-slate-100">
        <div className="px-3 py-2 bg-slate-800 text-white text-sm flex items-center">
          <button onClick={() => navigate('/mobile')} className="flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            戻る
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="p-4 bg-white rounded shadow text-red-600 text-sm">{error}</div>
        </div>
      </div>
    )
  }


  return (
    <div className="mobile-screen flex flex-col">
      {/* LandXML 読込中のオーバーレイ (大 TIN のパースは数秒〜数十秒固まる) */}
      {landxmlBusy && (
        <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center pointer-events-none">
          <div className="bg-white rounded-lg shadow-xl px-5 py-4 flex items-center gap-3 max-w-xs pointer-events-auto">
            <Loader2 className="h-6 w-6 animate-spin text-cyan-700 flex-shrink-0" />
            <div>
              <div className="font-medium text-slate-800 text-sm">LandXML を読込中…</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                大きな TIN は数十秒かかることがあります
              </div>
            </div>
          </div>
        </div>
      )}
      {/* ヘッダー（1 行目: メニュー・戻る・現場名・工区名・ユーザー名） */}
      <div className="px-2 py-1.5 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <MobileHamburgerMenu
          farmId={farm?.id ?? null}
          onOpenCoords={() => setShowRecordList(true)}
        />
        <button
          onClick={() => navigate('/mobile')}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700"
          title="戻る"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          {project && (
            <span className="text-[11px] text-slate-300 truncate max-w-[40%]" title={project.name}>
              {project.name}
            </span>
          )}
          <span className="font-medium truncate flex-1" title={farm?.name ?? ''}>
            {farm?.name ?? '工事測量'}
          </span>
        </div>
        {userLabel && (
          <span className="text-[11px] text-slate-300 truncate max-w-[6rem]" title={user?.email ?? ''}>
            {userLabel}
          </span>
        )}
        <FeedbackButton variant="mobile" />
      </div>
      {/* ヘッダー（2 行目: ツールボタン群）。すべて日本語ラベル。
          音声ガイダンスと SIMA インポート/エクスポートは別画面へ移動。 */}
      <div className="px-2 py-1.5 bg-slate-800 text-white flex items-center gap-1.5 text-xs border-t border-slate-700 overflow-x-auto">
        {/* 現在地・更新 ボタンは地図左上のズームコントロール下に移動 (下記 map overlay 参照) */}
        {farmOrthos.length > 0 && (
          <button
            onClick={() => setShowOrtho((v) => !v)}
            className={`shrink-0 px-2 py-1.5 rounded font-medium ${
              showOrtho ? 'bg-emerald-600' : 'bg-slate-700 hover:bg-slate-600'
            }`}
            title="オルソ画像の表示を切替"
          >
            オルソ
          </button>
        )}
        <button
          onClick={() => setShowDisplaySettings((v) => !v)}
          className={`shrink-0 relative px-2 py-1.5 rounded font-medium ${
            showDisplaySettings ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="表示設定（コンパス・点名・点種フィルタ）"
        >
          表示
          {(hiddenSubTypes.size > 0 || targetFilter !== 'all' || headingEnabled) && (
            <span className="absolute -top-1 -right-1 bg-amber-400 w-2 h-2 rounded-full" />
          )}
        </button>
        <button
          onClick={() => setShowCalcModal(true)}
          className="shrink-0 px-2 py-1.5 rounded font-medium bg-slate-700 hover:bg-slate-600"
          title="座標計算（交点・線上・2 点距離）"
        >
          計算
        </button>
        <button
          onClick={() => {
            setShowParcelList(false)
            setShowRecordList((v) => !v)
          }}
          className={`shrink-0 relative px-2 py-1.5 rounded font-medium ${
            showRecordList ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="座標一覧（SIMA インポート/エクスポートもここから）"
        >
          座標
          {coordinates.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">
              {coordinates.length > 9 ? '9+' : coordinates.length}
            </span>
          )}
        </button>
        {/* 地番タブは地籍測量プロジェクトのみ表示 (土木工事モードでは非表示) */}
        {isCadastralProject && (
          <button
            onClick={() => {
              setShowRecordList(false)
              setShowParcelList((v) => !v)
            }}
            className={`shrink-0 relative px-2 py-1.5 rounded font-medium ${
              showParcelList ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
            }`}
            title="地番一覧（工区配下の地番属性を表示）"
          >
            地番
            {parcelAreas.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">
                {parcelAreas.length > 9 ? '9+' : parcelAreas.length}
              </span>
            )}
          </button>
        )}
        {/* 描画タブ: 地図に手書きペイント */}
        <button
          onClick={() => setShowDrawing((v) => !v)}
          className={`shrink-0 relative px-2 py-1.5 rounded font-medium ${
            showDrawing ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="描画 (地図に手書きペイント)"
        >
          描画
        </button>
        <button
          onClick={handleShare}
          className="shrink-0 px-2 py-1.5 rounded font-medium bg-slate-700 hover:bg-slate-600"
          title="共有リンクを発行（他社にLINE等で送信）"
        >
          共有
        </button>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="shrink-0 px-2 py-1.5 rounded font-medium bg-slate-700 hover:bg-slate-600"
          title="設定"
        >
          設定
        </button>
      </div>
      {/* 共有結果トースト */}
      {shareToast && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 z-[2000] px-3 py-2 bg-slate-900 text-white text-xs rounded shadow-lg">
          {shareToast}
        </div>
      )}
      {/* SIM 入力（不可視）
          image MIME を含めると iOS で「写真ライブラリ」「写真撮影」が
          選択肢に出てしまうため、非画像 MIME のみ指定してファイルピッカーに直行させる */}
      <input
        ref={simInputRef}
        type="file"
        accept=".sim,.SIM,application/octet-stream,text/plain"
        onChange={handleSimImported}
        className="hidden"
      />
      {/* メモ作成モーダル */}
      {memoModalState && farmId && (
        <MobileMemoCreateModal
          defaultLat={memoModalState.lat}
          defaultLng={memoModalState.lng}
          onCancel={() => setMemoModalState(null)}
          onSave={async (data) => {
            const saved = await createFarmMemo(farmId, data)
            setMemoModalState(null)
            if (!saved) return
            setShareToast('メモを保存しました')
            window.setTimeout(() => setShareToast(null), 2500)
          }}
        />
      )}

      {/* 長押し時の選択シート（測点を追加 / メモを残す） */}
      {longPressChoice && (
        <div
          className="fixed inset-0 bg-black/50 flex items-end justify-center z-[3400]"
          onClick={() => setLongPressChoice(null)}
        >
          <div
            className="bg-white w-full rounded-t-xl shadow-xl p-3 space-y-2 max-w-md"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs text-slate-500 text-center pb-1">
              長押しした地点で
            </div>
            <button
              onClick={() => {
                const { lat, lng } = longPressChoice
                const { x, y } = converter.toXY(lat, lng)
                // 次の点名候補（既存座標数 + 1、頭 'M'）
                const nextIdx = coordinates.length + 1
                setAddCoordDialog({
                  lat,
                  lng,
                  x,
                  y,
                  name: `M-${nextIdx}`,
                  type: 'boundary',
                  z: '',
                  notes: '',
                })
                setLongPressChoice(null)
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg font-bold"
            >
              <Plus className="h-5 w-5" />
              測点を追加
            </button>
            <button
              onClick={() => {
                setMemoModalState({ lat: longPressChoice.lat, lng: longPressChoice.lng })
                setLongPressChoice(null)
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-amber-400 bg-amber-50 text-amber-800 rounded-lg font-semibold"
            >
              <StickyNote className="h-5 w-5" />
              メモを残す
            </button>
            <button
              onClick={() => {
                const { lat, lng } = longPressChoice
                const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
                window.open(url, '_blank')
                setLongPressChoice(null)
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-emerald-400 bg-emerald-50 text-emerald-800 rounded-lg font-semibold"
            >
              <Navigation2 className="h-5 w-5" />
              道案内（Google マップ）
            </button>
            <button
              onClick={() => setLongPressChoice(null)}
              className="w-full px-4 py-2 text-sm text-slate-500"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 長押し座標から測点を追加するモーダル */}
      {addCoordDialog && farmId && (
        <div
          className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3450] p-3"
          onClick={() => setAddCoordDialog(null)}
        >
          <div
            className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-800">測点を追加</h3>
              <button
                onClick={() => setAddCoordDialog(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-baseline gap-4 text-sm font-mono text-slate-600">
                <div>
                  <span className="text-[10px] text-slate-500 mr-1 font-sans">X</span>
                  <span className="text-slate-800">{addCoordDialog.x.toFixed(3)}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-500 mr-1 font-sans">Y</span>
                  <span className="text-slate-800">{addCoordDialog.y.toFixed(3)}</span>
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 mb-0.5">点名</div>
                <input
                  type="text"
                  value={addCoordDialog.name}
                  onChange={(e) =>
                    setAddCoordDialog((d) => (d ? { ...d, name: e.target.value } : d))
                  }
                  className="w-full px-2 py-1.5 text-sm border rounded"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-[10px] text-slate-500 mb-0.5">点種</div>
                  <select
                    value={addCoordDialog.type}
                    onChange={(e) =>
                      setAddCoordDialog((d) => (d ? { ...d, type: e.target.value } : d))
                    }
                    className="w-full px-2 py-1.5 text-sm border rounded bg-white"
                  >
                    {typeOptions.map((o) => (
                      <option key={o.code} value={o.code}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500 mb-0.5">Z（任意）</div>
                  <input
                    type="number"
                    step="0.001"
                    inputMode="decimal"
                    value={addCoordDialog.z}
                    onChange={(e) =>
                      setAddCoordDialog((d) => (d ? { ...d, z: e.target.value } : d))
                    }
                    placeholder="-"
                    className="w-full px-2 py-1.5 text-sm border rounded font-mono text-right"
                  />
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 mb-0.5">備考</div>
                <input
                  type="text"
                  value={addCoordDialog.notes}
                  onChange={(e) =>
                    setAddCoordDialog((d) => (d ? { ...d, notes: e.target.value } : d))
                  }
                  placeholder="任意"
                  className="w-full px-2 py-1.5 text-sm border rounded"
                />
              </div>
            </div>
            <div className="px-4 pb-4 pt-2 border-t flex gap-2">
              <button
                onClick={() => setAddCoordDialog(null)}
                className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={async () => {
                  const d = addCoordDialog
                  const name = d.name.trim()
                  if (!name) {
                    alert('点名を入力してください')
                    return
                  }
                  if (coordinates.some((c) => c.pointNumber === name)) {
                    alert(`点名 ${name} は既に存在します`)
                    return
                  }
                  const zNum = d.z.trim() ? parseFloat(d.z) : null
                  const inserted = await importCoordinates([
                    {
                      pointNumber: name,
                      x: d.x,
                      y: d.y,
                      z: zNum,
                      type: d.type as CoordinateRow['type'],
                      notes: d.notes.trim() || null,
                    },
                  ])
                  setAddCoordDialog(null)
                  if (inserted.length > 0) {
                    setShareToast(`測点 ${name} を追加しました`)
                    window.setTimeout(() => setShareToast(null), 2500)
                  } else {
                    const errMsg = useCoordinateStore.getState().error ?? '不明なエラー'
                    setShareToast(`測点追加に失敗: ${errMsg}`)
                    window.setTimeout(() => setShareToast(null), 3500)
                  }
                }}
                className="flex-1 px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                追加
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 既存の工区写真の編集モーダル: 差替アップロード + 旧行削除 */}
      {editingExistingPhoto && farm?.project_id && farmId && (
        <PhotoEditModal
          file={editingExistingPhoto.file}
          enableLocationEdit
          initialLat={editingExistingPhoto.initialLat}
          initialLng={editingExistingPhoto.initialLng}
          initialHeadingDeg={editingExistingPhoto.initialHeadingDeg}
          initialCaption={editingExistingPhoto.initialCaption}
          initialTakenAt={editingExistingPhoto.initialTakenAt}
          initialTitle={editingExistingPhoto.initialTitle ?? null}
          titleSuggestions={photoTitleSuggestions}
          existingTitles={existingFarmPhotoTitles}
          onUseTitlePrefix={pushPhotoTitleRecent}
          onCancel={() => setEditingExistingPhoto(null)}
          onConfirm={async (blob, _name, meta) => {
            // 確定を押しても閉じない。差替が済んだら oldAttachmentId を新しい方に
            // 付け替えて「次の確定でその新規行を再度差し替える」ようにする。
            // モーダルを閉じるのは右上 × ボタン。
            const projectId = farm.project_id
            if (!projectId) return
            const oldId = editingExistingPhoto.oldAttachmentId
            const r = await uploadPhoto({
              projectId,
              entityType: 'farm_photo',
              entityId: farmId,
              file: blob,
              // 工区写真は category にタイトル (例: '全景-1') を格納する。未指定なら旧値保持
              category: meta.title ?? editingExistingPhoto.initialTitle ?? '現場',
              caption: meta.caption,
              takenAt: meta.takenAt ?? new Date(),
              lat: meta.lat,
              lng: meta.lng,
              headingDeg: meta.headingDeg,
              skipResize: true,
            })
            if (r) {
              try {
                await removeAttachment(oldId)
              } catch (err) {
                console.warn('[farm_photo edit] failed to remove old', err)
              }
              setEditingExistingPhoto((prev) =>
                prev ? { ...prev, oldAttachmentId: r.id } : null,
              )
              setShareToast('写真を更新しました')
              window.setTimeout(() => setShareToast(null), 2500)
              void fetchAttachments('farm_photo', [farmId])
            } else {
              setShareToast('写真の更新に失敗しました')
              window.setTimeout(() => setShareToast(null), 3000)
            }
          }}
        />
      )}

      {/* 工区写真（標準写真）の編集モーダル — 撮影 / アップロード後の編集 */}
      {editingStandalonePhoto && farm?.project_id && farmId && (
        <PhotoEditModal
          file={editingStandalonePhoto}
          enableLocationEdit
          initialLat={currentPos?.[0] ?? null}
          initialLng={currentPos?.[1] ?? null}
          initialHeadingDeg={heading}
          // カメラ撮影のときは撮影日を「今」に既定化（EXIF に日時があれば PhotoEditModal 側で上書き）
          initialTakenAt={standalonePhotoSource === 'camera' ? new Date() : null}
          titleSuggestions={photoTitleSuggestions}
          existingTitles={existingFarmPhotoTitles}
          onUseTitlePrefix={pushPhotoTitleRecent}
          onCancel={() => {
            setEditingStandalonePhoto(null)
            setStandalonePhotoSource(null)
          }}
          onConfirm={async (blob, _name, meta) => {
            setEditingStandalonePhoto(null)
            setStandalonePhotoSource(null)
            const projectId = farm.project_id
            if (!projectId) return
            const r = await uploadPhoto({
              projectId,
              entityType: 'farm_photo',
              entityId: farmId,
              file: blob,
              // 工区写真は category にタイトル (例: '全景-1') を格納する。未指定は '現場' fallback
              category: meta.title ?? '現場',
              caption: meta.caption,
              takenAt: meta.takenAt ?? new Date(),
              // メタの位置・方向を優先（編集モーダルで変更可）、未指定なら現在地
              lat: meta.lat ?? currentPos?.[0] ?? null,
              lng: meta.lng ?? currentPos?.[1] ?? null,
              headingDeg: meta.headingDeg ?? heading,
              skipResize: true,
            })
            if (r) {
              setShareToast('写真を保存しました')
              window.setTimeout(() => setShareToast(null), 2500)
              // マーカーを即時更新するため取り直し
              void fetchAttachments('farm_photo', [farmId])
            } else {
              setShareToast('写真の保存に失敗しました')
              window.setTimeout(() => setShareToast(null), 3000)
            }
          }}
        />
      )}

      {/* 標準写真用の hidden input。撮影 (capture) と インポート (picker) で分ける */}
      <input
        ref={standalonePhotoInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) {
            setStandalonePhotoSource('camera')
            setEditingStandalonePhoto(f)
          }
        }}
        className="hidden"
      />
      <input
        ref={standalonePhotoPickerRef}
        type="file"
        accept="image/*"
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) {
            setStandalonePhotoSource('picker')
            setEditingStandalonePhoto(f)
          }
        }}
        className="hidden"
      />

      {/* カメラボタンを押したときに「撮影 / インポート」を選ばせるシート */}
      {photoSourceSheet && (
        <div
          className="fixed inset-0 bg-black/50 flex items-end justify-center z-[3000]"
          onClick={() => setPhotoSourceSheet(false)}
        >
          <div
            className="bg-white w-full sm:max-w-sm rounded-t-xl shadow-xl p-3 space-y-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-center text-xs text-slate-500 mb-1">写真を追加</div>
            <button
              type="button"
              onClick={async () => {
                setPhotoSourceSheet(false)
                // 撮影方向を記録するためコンパスを先に有効化（iOS はここで許可ダイアログ）。
                // 許可拒否 / 失敗しても撮影自体は続行する。
                if (!headingEnabled) {
                  try { await toggleHeading() } catch { /* ignore */ }
                }
                standalonePhotoInputRef.current?.click()
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg font-semibold"
            >
              <Camera className="h-5 w-5" />
              撮影
            </button>
            <button
              type="button"
              onClick={() => {
                setPhotoSourceSheet(false)
                standalonePhotoPickerRef.current?.click()
              }}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 border border-blue-600 text-blue-700 rounded-lg font-semibold"
            >
              <ImageIcon className="h-5 w-5" />
              インポート
            </button>
            <button
              type="button"
              onClick={() => setPhotoSourceSheet(false)}
              className="w-full px-4 py-2 text-sm text-slate-500"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}
      {photoModalTarget && farm?.project_id && (
        <CoordinatePhotoModal
          open={!!photoModalTarget}
          onClose={() => setPhotoModalTarget(null)}
          projectId={farm.project_id}
          coordinateId={photoModalTarget.refId}
          pointNumber={photoModalTarget.name}
        />
      )}
      {/* 座標計算モーダル（交点・線上） */}
      {showCalcModal && (
        <CoordinateCalcModal
          coordinates={coordinates
            .filter((c) => Number.isFinite(c.x) && Number.isFinite(c.y))
            .map((c) => ({ id: c.id, pointNumber: c.pointNumber, x: c.x, y: c.y }))}
          typeOptions={typeOptions}
          defaultType={'control'}
          onAdd={(p) => {
            importCoordinates([
              {
                pointNumber: p.pointNumber,
                x: p.x,
                y: p.y,
                z: null,
                type: p.type as CoordinateRow['type'],
              },
            ])
          }}
          onClose={() => {
            setShowCalcModal(false)
            setCalcAssign(null)
          }}
          onPickRequest={(fn) => setCalcAssign(() => fn)}
        />
      )}
      {/* 重なりターゲット選択シート（1m 以内に複数あるときに開く） */}
      {overlapPicker && (
        <OverlapTargetPicker
          candidates={overlapPicker.candidates}
          selectedId={selectedTargetId}
          onPick={(id) => {
            const picked = overlapPicker.candidates.find((c) => c.id === id)
            if (overlapPicker.mode === 'assign' && calcAssign && picked?.kind === 'coordinate') {
              calcAssign(picked.refId)
            } else {
              setSelectedTargetId(id)
            }
            setOverlapPicker(null)
          }}
          onCancel={() => setOverlapPicker(null)}
        />
      )}
      {/* 新点計測完了モーダル */}
      {freePointDialog && (
        <FreePointDialog
          data={freePointDialog}
          typeOptions={typeOptions}
          recentPrefixes={recentPrefixes}
          existingNames={coordinates.map((c) => c.pointNumber)}
          numberingMode={numberingMode}
          onConfirm={handleFreePointConfirm}
          onCancel={() => setFreePointDialog(null)}
        />
      )}
      {/* 測設完了モーダル（OK の上に写真撮影ボタン） */}
      {postStakeDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
          <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4">
            <h3 className="text-base font-bold mb-2">測設完了</h3>
            <p className="text-sm text-slate-700 whitespace-pre-line mb-3">
              {postStakeDialog.message}
            </p>
            {/* 設置状態セレクタ（座標点ターゲットのみ）。測定後にここで更新する */}
            {postStakeDialog.target.kind === 'coordinate' && (() => {
              const coord = coordinates.find((c) => c.id === postStakeDialog.target.refId)
              if (!coord) return null
              return (
                <label className="flex items-center gap-2 mb-3 text-sm">
                  <span className="text-slate-600 shrink-0">設置状態</span>
                  <select
                    value={coord.stakeStatus}
                    onChange={(e) =>
                      void setStakeStatus(coord.id, e.target.value as StakeStatus)
                    }
                    className={`flex-1 px-2 py-1.5 text-sm font-medium border rounded ${STAKE_STATUS_BADGE[coord.stakeStatus]}`}
                  >
                    {STAKE_STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {STAKE_STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })()}
            <div className="space-y-2">
              {postStakeDialog.target.kind === 'coordinate' && (
                <button
                  onClick={() => {
                    // 写真モーダルを開く（測設モーダルは閉じる）
                    const t = postStakeDialog.target
                    postStakeDialog.resolve('photo')
                    setPostStakeDialog(null)
                    setPhotoModalTarget(t)
                  }}
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
                >
                  <Camera className="h-5 w-5" />
                  写真撮影
                </button>
              )}
              <button
                onClick={() => {
                  postStakeDialog.resolve('ok')
                  setPostStakeDialog(null)
                }}
                className="w-full px-4 py-2.5 bg-slate-200 hover:bg-slate-300 rounded-lg text-sm font-medium"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 誤差超過時の選択モーダル */}
      {errorChoice && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
          <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4">
            <h3 className="text-base font-bold mb-1">位置がずれています</h3>
            <p className="text-sm text-slate-600 mb-3">
              ターゲットから <span className="font-mono font-bold">{errorChoice.distance.toFixed(3)} m</span>{' '}
              離れています（許容 {STAKE_TOLERANCE_M.toFixed(2)} m）。<br />
              どのように記録しますか？
            </p>
            <div className="space-y-2">
              <button
                onClick={() => {
                  errorChoice.resolve('stake')
                  setErrorChoice(null)
                }}
                className="w-full px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium"
              >
                そのまま測設として記録
              </button>
              <button
                onClick={() => {
                  errorChoice.resolve('free')
                  setErrorChoice(null)
                }}
                className="w-full px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                新点として記録
              </button>
              <button
                onClick={() => {
                  errorChoice.resolve('cancel')
                  setErrorChoice(null)
                }}
                className="w-full px-4 py-2 border rounded-lg hover:bg-slate-50 text-sm"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 表示設定パネル（表示アイコンで開閉）:
          コンパス / 測点（+点種別） / 点名 / 地番（ポリゴン） / 地番名 のチェックリスト */}
      {showDisplaySettings && (
        <div className="bg-white border-b px-3 py-2 text-sm space-y-1.5">
          {/* コンパス */}
          <label
            className="flex items-center gap-2 cursor-pointer"
            title={
              headingError
                ? `方位エラー: ${headingError}`
                : headingEnabled
                ? heading != null
                  ? `方位 ${heading.toFixed(0)}°`
                  : '方位センサー待機中'
                : '方位センサーをON'
            }
          >
            <input
              type="checkbox"
              checked={headingEnabled}
              onChange={toggleHeading}
              className="h-4 w-4"
            />
            <Navigation2 className="h-3.5 w-3.5 text-slate-500" />
            <span>コンパス</span>
            {headingEnabled && heading != null && (
              <span className="ml-1 text-[11px] text-emerald-700">
                {heading.toFixed(0)}°
              </span>
            )}
          </label>

          {/* 測点（マーカー） + 点種別ネスト */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showTargets}
              onChange={() => setShowTargets((v) => !v)}
              className="h-4 w-4"
            />
            <span>測点</span>
            <span className="text-[11px] text-slate-500">
              ({filteredTargets.length})
            </span>
          </label>
          {showTargets && subTypeStats.length > 0 && (
            <div className="pl-7 space-y-1 text-xs">
              {subTypeStats.map((s) => {
                const visible = !hiddenSubTypes.has(s.code)
                return (
                  <label
                    key={s.code}
                    className="flex items-center gap-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={visible}
                      onChange={() =>
                        setHiddenSubTypes((prev) => {
                          const next = new Set(prev)
                          if (next.has(s.code)) next.delete(s.code)
                          else next.add(s.code)
                          return next
                        })
                      }
                      className="h-3.5 w-3.5"
                    />
                    <span>{s.label}</span>
                    <span className="text-[10px] text-slate-500">
                      ({s.count})
                    </span>
                  </label>
                )
              })}
              {/* ルート絞り込み（順路が登録済みの工区でのみ） */}
              {routeTargetIds.size > 0 && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={targetFilter === 'route'}
                    onChange={() =>
                      setTargetFilter((prev) => (prev === 'route' ? 'all' : 'route'))
                    }
                    className="h-3.5 w-3.5"
                  />
                  <span className="text-orange-700">ルートのみ</span>
                  <span className="text-[10px] text-slate-500">
                    ({routeTargetIds.size})
                  </span>
                </label>
              )}
              {hiddenSubTypes.size > 0 && (
                <button
                  type="button"
                  onClick={() => setHiddenSubTypes(new Set())}
                  className="text-[11px] text-blue-600 hover:underline"
                >
                  全ての点種を表示
                </button>
              )}

              {/* 設置状態フィルタ。PC と mapViewStore で共有 */}
              <div className="border-t pt-1 mt-1">
                <div className="text-[10px] text-slate-500 mb-1">
                  設置状態 ({visibleStakeStatuses.size}/{STAKE_STATUS_OPTIONS.length})
                </div>
                {STAKE_STATUS_OPTIONS.map((s) => {
                  const on = visibleStakeStatuses.has(s)
                  return (
                    <label
                      key={s}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleVisibleStakeStatus(s)}
                        className="h-3.5 w-3.5"
                      />
                      <span
                        className={`px-1.5 py-0.5 text-[10px] font-medium border rounded ${STAKE_STATUS_BADGE[s]}`}
                      >
                        {STAKE_STATUS_LABEL[s]}
                      </span>
                    </label>
                  )
                })}
                {visibleStakeStatuses.size < STAKE_STATUS_OPTIONS.length && (
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleStakeStatuses(new Set(STAKE_STATUS_OPTIONS))
                    }
                    className="text-[11px] text-blue-600 hover:underline"
                  >
                    全ての設置状態を表示
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 点名 */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showLabels}
              onChange={() => setShowLabels((v) => !v)}
              className="h-4 w-4"
            />
            <Tag className="h-3.5 w-3.5 text-slate-500" />
            <span>点名</span>
            {showLabels && mapZoom < LABEL_MIN_ZOOM && (
              <span className="text-[10px] text-slate-400">
                ズーム {LABEL_MIN_ZOOM} 以上で表示
              </span>
            )}
          </label>

          {/* 地番（ポリゴン）。件数は常時表示して、取得失敗 (=0) と
              トグル OFF を切り分けられるようにする */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showParcelPolygons}
              onChange={() => setShowParcelPolygons((v) => !v)}
              className="h-4 w-4"
            />
            <span>地番（ポリゴン）</span>
            <span
              className={`text-[11px] ${
                farmPolygons.length === 0 ? 'text-amber-600' : 'text-slate-500'
              }`}
            >
              ({farmPolygons.length})
            </span>
            {farmPolygons.length === 0 && (
              <span className="text-[10px] text-amber-600 ml-1">
                取得 0 件
              </span>
            )}
          </label>

          {/* 地番名 */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showParcelLabels}
              onChange={() => setShowParcelLabels((v) => !v)}
              className="h-4 w-4"
            />
            <span>地番名</span>
            {showParcelLabels && mapZoom < PARCEL_LABEL_MIN_ZOOM && (
              <span className="text-[10px] text-slate-400">
                ズーム {PARCEL_LABEL_MIN_ZOOM} 以上で表示
              </span>
            )}
          </label>
        </div>
      )}

      {/* 施工管理モードのデータ取込バー */}
      {screenMode === 'construction' && (
        <>
          <div className="px-2 py-1 bg-cyan-900 text-white flex items-center gap-2 text-xs border-b border-cyan-800">
            <button
              onClick={handleLoadFromPlan}
              disabled={importing}
              className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50"
              title="現場データの施工計画 + 暗渠から床掘 TIN を生成"
            >
              <Database className="h-3.5 w-3.5" />
              施工計画
              {importing && <Loader2 className="h-3 w-3 animate-spin" />}
            </button>
            <label className="cursor-pointer">
              <input
                ref={xmlInputRef}
                type="file"
                accept=".xml,.XML,.landxml,.LANDXML"
                onChange={handleLoadXml}
                className="hidden"
              />
              <span className="flex items-center gap-1 px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600">
                <FileText className="h-3.5 w-3.5" />
                LandXML
              </span>
            </label>
            {dataSourceLabel && (
              <span className="text-cyan-100 truncate flex-1 text-[11px]">{dataSourceLabel}</span>
            )}
          </div>
          {dataError && (
            <div className="px-3 py-1 bg-red-50 border-b border-red-200 text-xs text-red-700">{dataError}</div>
          )}
        </>
      )}

      {/* 地図 */}
      <div className="flex-1 relative">
        {/* 描画ツールバー: showDrawing = true のときだけ表示。地図上部中央にフローティング。 */}
        {showDrawing && farm?.id && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1250]">
            <MapDrawingToolbar
              mode={drawingMode}
              onChangeMode={setDrawingMode}
              color={drawingColor}
              onChangeColor={setDrawingColor}
              widthPx={drawingWidth}
              onChangeWidth={setDrawingWidth}
              lineStyle={drawingLineStyle}
              onChangeLineStyle={setDrawingLineStyle}
              canUndo={drawingUndoLen > 0}
              canRedo={drawingRedoLen > 0}
              onUndo={() => void drawingUndo()}
              onRedo={() => void drawingRedo()}
            />
          </div>
        )}
        {/* 現在地 (追従モード切替) + 更新 ボタン。地図左上のズームコントロール直下に縦並び。 */}
        <div className="absolute top-[88px] left-2 z-[1200] flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setFollowMode((m) => NEXT_FOLLOW_MODE[m])}
            className={`w-9 h-9 flex items-center justify-center rounded shadow-md border ${
              followMode === 'self'
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-slate-400 text-slate-700 hover:bg-slate-50'
            }`}
            title={`地図表示モード: ${MAP_FOLLOW_LABEL[followMode]}（クリックで切替）`}
            aria-label="現在地"
          >
            <Crosshair className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void refreshData()}
            disabled={refreshing}
            className="w-9 h-9 flex items-center justify-center rounded shadow-md border bg-white border-slate-400 text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            title={
              refreshing
                ? 'データを更新中…'
                : `データを最新に更新（60 秒ごとに自動）${
                    lastRefreshAt
                      ? `\n最終更新: ${lastRefreshAt.toLocaleTimeString('ja-JP', { hour12: false })}`
                      : ''
                  }`
            }
            aria-label="更新"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
        {/* MAP / 3D / 2D 切替（地図右上に縦並び、ズームコントロールの対側）
            z は 2D パネル (z-[1000]) より高く、常に上に出す。 */}
        <div className="absolute top-2 right-2 z-[1200] flex flex-col gap-0.5 rounded overflow-hidden shadow-md border border-slate-400 bg-white">
          {(['map', '3d', '2d'] as const).map((m) => {
            const on = viewModes.has(m)
            const label = m === 'map' ? 'MAP' : m === '3d' ? '3D' : '2D'
            const title =
              m === 'map'
                ? '地図 + ターゲット'
                : m === '3d'
                  ? '3D（LANDXML）TIN + 比高'
                  : '2D 断面プロファイル'
            return (
              <button
                key={m}
                onClick={() => toggleViewMode(m)}
                className={`px-2 py-1.5 text-xs font-bold leading-none ${
                  on
                    ? 'bg-cyan-600 text-white'
                    : 'bg-white text-slate-700 hover:bg-slate-100'
                }`}
                title={title}
              >
                {label}
              </button>
            )
          })}
        </div>

        {/* 法務省地図 (地籍測量プロジェクトのみ) — 背景セレクタの上に配置 */}
        {isCadastralProject && hasActiveParcelDataset && (
          <div className="absolute bottom-14 right-1 z-[1000] flex flex-col items-end gap-1">
            {/* 選択モード時の追加コントロール */}
            {showParcelLayer && (
              <div className="flex items-center gap-1">
                {parcelMessage && (
                  <span
                    className="max-w-[10rem] px-1.5 py-0.5 text-[10px] bg-white/90 border border-slate-300 rounded text-slate-700 truncate"
                    title={parcelMessage}
                  >
                    {parcelMessage}
                  </span>
                )}
                {parcelSelectionMode && selectedParcels.size > 0 && (
                  <button
                    onClick={clearParcelSelection}
                    disabled={parcelBusy}
                    className="px-1.5 py-1 text-[11px] rounded shadow bg-white/95 border border-slate-300 disabled:opacity-50"
                    title="選択を全て解除"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  onClick={() => {
                    if (!parcelSelectionMode) {
                      setParcelSelectionMode(true)
                    } else if (selectedParcels.size === 0) {
                      setParcelSelectionMode(false)
                    } else {
                      void (async () => {
                        await handleImportParcelBatch(
                          Array.from(selectedParcels.values()),
                        )
                        setParcelSelectionMode(false)
                      })()
                    }
                  }}
                  disabled={parcelBusy}
                  className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded shadow border ${
                    !parcelSelectionMode
                      ? 'bg-white/95 border-slate-300 text-slate-800'
                      : selectedParcels.size === 0
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-emerald-600 border-emerald-500 text-white'
                  } disabled:opacity-50`}
                >
                  {parcelBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {!parcelSelectionMode
                    ? '地番データ取込'
                    : selectedParcels.size === 0
                      ? 'キャンセル'
                      : `取り込む (${selectedParcels.size})`}
                </button>
              </div>
            )}
            {/* 法務省地図トグル */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  setShowParcelLayer((v) => {
                    const next = !v
                    if (!next) {
                      setParcelSelectionMode(false)
                      clearParcelSelection()
                    }
                    return next
                  })
                }}
                className={`flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded shadow border ${
                  showParcelLayer
                    ? 'bg-orange-500 border-orange-500 text-white'
                    : 'bg-white/95 border-slate-300 text-slate-800'
                }`}
                title="法務省地図データを背景に表示する"
              >
                <MapIcon className="h-3.5 w-3.5" />
                法務省地図
              </button>
            </div>
          </div>
        )}

        {/* 背景地図セレクタ（右下、Leaflet 帰属の上） */}
        <div className="absolute bottom-5 right-1 z-[1000] flex items-center gap-1 px-1.5 py-0.5 rounded shadow border border-slate-300 bg-white/95 text-[11px]">
          <span className="text-slate-500">背景</span>
          <select
            value={baseLayer}
            onChange={(e) => {
              const v = e.target.value
              if (v.startsWith('ortho:')) {
                // オルソ選択: ベースは「背景なし」にしてオルソを表示
                setBaseLayer('none')
                setShowOrtho(true)
              } else {
                setBaseLayer(v as BaseLayerKey)
                setShowOrtho(false)
              }
            }}
            className="px-1 py-0.5 border border-slate-300 rounded bg-white text-[11px]"
          >
            {(Object.entries(BASE_LAYERS) as [BaseLayerKey, typeof currentBase][]).map(
              ([key, info]) => (
                <option key={key} value={key}>
                  {info.label}
                </option>
              ),
            )}
            {farmOrthos.length > 0 && (
              <optgroup label="オルソ">
                {farmOrthos.map((o) => (
                  <option key={o.id} value={`ortho:${o.id}`}>
                    {o.name || 'オルソ'}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <MapContainer
          center={mapCenter}
          zoom={17}
          maxZoom={24}
          className="h-full w-full"
          style={baseLayer === 'none' ? { background: '#ffffff' } : undefined}
          // leaflet-rotate: 回転機能を有効化。実際の bearing は MapBearingUpdater が制御
          {...({ rotate: true, bearing: 0, rotateControl: false } as Record<string, unknown>)}
        >
          <MapBearingUpdater
            enabled={mapRotationEnabled}
            heading={heading}
          />
          {/* 断面ピック中の仮マーカー（座標管理から選択した点を強調） */}
          {sectionPickingMode && sectionPickIds.map((id, i) => {
            const c = coordinates.find((cc) => cc.id === id)
            if (!c || c.lat == null || c.lng == null) return null
            return (
              <CircleMarker
                key={`spp-${i}`}
                center={[c.lat, c.lng]}
                radius={8}
                pathOptions={{ color: '#0891b2', fillColor: '#06b6d4', fillOpacity: 1, weight: 3 }}
              />
            )
          })}
          {/* アクティブ断面線 */}
          {(show3D || show2D) && activeSectionLine && (
            <Polyline positions={activeSectionLine} pathOptions={{ color: '#0891b2', weight: 3, dashArray: '6,4' }} />
          )}
          <TileLayer
            attribution='&copy; 国土地理院'
            url={currentBase.url ?? ''}
            maxZoom={24}
            maxNativeZoom={currentBase.maxNative ?? 18}
          />
          {/* オルソ画像（複数登録時は全て重ねる） */}
          {showOrtho && farmOrthos.map((ortho) => (
            <TileLayer
              key={ortho.id}
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
          <FitOnce bounds={allBounds} />
          {/* 追従は安定位置(stablePos)で行う。FIX が外れると stablePos が更新されないため
              地図は最後の良好位置で止まり、外側へ大きくスクロールしない */}
          <FollowCurrent position={stablePos} enabled={followMode === 'self'} />
          <ZoomWatcher onChange={setMapZoom} />
          <BoundsWatcher onChange={setMapBounds} />
          {/* ターゲット選択時はモードに関わらず 1 度だけ中心化（継続的な追尾はしない） */}
          <CenterOnSelect
            target={
              selectedTarget
                ? {
                    id: selectedTarget.id,
                    lat: selectedTarget.lat,
                    lng: selectedTarget.lng,
                  }
                : null
            }
          />

          {/* 工事区域ポリゴン（境界測量=属性色 / その他=工種色）。showParcelPolygons でまとめて非表示にできる */}
          {showParcelPolygons && farmPolygons.map((polygon) => {
            const workTypeColor =
              polygon.workType === 'boundary_survey'
                ? '#0ea5e9'
                : polygon.workType === 'underdrain'
                ? '#3b82f6'
                : polygon.workType === 'soil_import'
                ? '#f59e0b'
                : polygon.workType === 'simple_grading'
                ? '#8b5cf6'
                : polygon.workType === 'grading'
                ? '#10b981'
                : polygon.workType === 'subsoil'
                ? '#ec4899'
                : '#6b7280'
            const labelVisible = showParcelLabels && mapZoom >= PARCEL_LABEL_MIN_ZOOM
            const isParcel = polygon.workType === 'boundary_survey'
            // 地番なら parcel.attribute_code から色を解決 (未選択なら従来の workType 色)
            const parcelRow = isParcel ? parcelsByWorkAreaId.get(polygon.id) : null
            const attrColor =
              parcelRow?.attribute_code
                ? parcelAttrColorByCode.get(parcelRow.attribute_code)
                : null
            const color = attrColor ?? workTypeColor
            const fillOpacity = attrColor ? 0.4 : 0.18
            return (
              <Polygon
                key={polygon.id}
                positions={polygon.positions}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity,
                  weight: 2,
                }}
                eventHandlers={
                  isParcel && !(showDrawing && drawingMode !== 'off')
                    ? {
                        click: () =>
                          setParcelInfoTarget({
                            areaId: polygon.id,
                            parcelNumber: polygon.name,
                          }),
                      }
                    : undefined
                }
              >
                {polygon.name && (
                  <Tooltip
                    key={`pl-${labelVisible ? 'on' : 'off'}`}
                    className="staking-label-tooltip"
                    direction="center"
                    permanent={labelVisible}
                    opacity={1}
                    sticky
                  >
                    <span
                      style={{
                        color,
                        textShadow:
                          '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                      }}
                    >
                      {polygon.name}
                    </span>
                  </Tooltip>
                )}
              </Polygon>
            )
          })}

          {/* 工区メモのマーカー（長押しで移動・位置削除） */}
          {farmMemos.map((m) =>
            m.lat != null && m.lng != null ? (
              <EditableMemoMarker
                key={`memo-${m.id}`}
                memo={{ id: m.id, lat: m.lat, lng: m.lng, content: m.content }}
                onMove={(id, lat, lng) => {
                  void updateFarmMemo(id, { lat, lng })
                }}
                onClearLocation={(id) => {
                  void updateFarmMemo(id, { lat: null, lng: null })
                }}
              />
            ) : null,
          )}

          {/* 工区写真のマーカー: タップで写真ポップアップ、編集ボタンで PhotoEditModal を開く */}
          {farmPhotos.map((p) => (
            <PhotoMarker
              key={`photo-${p.id}`}
              photo={p}
              getSignedUrl={getSignedUrl}
              onDelete={async (photoId) => {
                if (!confirm('この写真を削除しますか？')) return
                try {
                  await removeAttachment(photoId)
                } catch (err) {
                  console.error('[farm_photo delete] failed', err)
                  alert('写真の削除に失敗しました')
                }
              }}
              onEdit={async (photoId) => {
                // Storage の写真を DL して File 化し、既存メタとともに編集モーダルへ渡す
                try {
                  const list = attachmentsByEntity.get(`farm_photo:${farmId}`) ?? []
                  const meta = list.find((a) => a.id === photoId)
                  if (!meta) return
                  const url = await getSignedUrl(meta.filePath)
                  if (!url) {
                    alert('写真のダウンロードに失敗しました')
                    return
                  }
                  const res = await fetch(url)
                  const blob = await res.blob()
                  const name = meta.filePath.split('/').pop() || 'photo.jpg'
                  const orgFile = new File([blob], name, {
                    type: blob.type || 'image/jpeg',
                  })
                  setEditingExistingPhoto({
                    file: orgFile,
                    oldAttachmentId: meta.id,
                    initialLat: meta.lat,
                    initialLng: meta.lng,
                    initialHeadingDeg: meta.headingDeg,
                    initialCaption: meta.caption,
                    initialTakenAt: meta.takenAt ? new Date(meta.takenAt) : null,
                    // タイトルは category に格納している ('現場' は旧値のためスキップ)
                    initialTitle: meta.category && meta.category !== '現場' ? meta.category : null,
                  })
                } catch (err) {
                  console.error('[farm_photo edit] failed to load', err)
                  alert('写真の読み込みに失敗しました')
                }
              }}
            />
          ))}

          {/* 地図の長押し / 右クリックで「測点追加 / メモを残す」の選択シートを開く。
              Leaflet の contextmenu イベントはスマホでも長押しで発火する */}
          <MapLongPressHandler
            onLongPress={(lat, lng) => setLongPressChoice({ lat, lng })}
          />

          {/* 配線ライン（吸水=青・集水=緑、選択中はオレンジ）
              タップ判定を確実にするため、透明な太い「ヒットレイヤ」を上に重ねる */}
          {pipePolylines.flatMap((p) => {
            const isSelected = p.id === selectedPipeId
            const baseColor = p.pipeType === 'branch' ? '#2563eb' : '#10b981'
            return [
              // 表示用ライン（クリック非対応）
              <Polyline
                key={`pipe-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: isSelected ? '#f97316' : baseColor,
                  weight: isSelected ? 5 : p.pipeType === 'branch' ? 2 : 3,
                  opacity: isSelected ? 1 : 0.85,
                  interactive: false,
                }}
              />,
              // タップ判定用の太い透明ライン（指タップでも確実に拾える）
              <Polyline
                key={`pipe-hit-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: '#000',
                  weight: 20,
                  opacity: 0,
                }}
                eventHandlers={{
                  click: () => setSelectedPipeId(p.id),
                }}
              />,
            ]
          })}

          {/* ルートのポリライン（ルートフィルタ選択時かつ表示ON時のみ） */}
          {targetFilter === 'route' && showRouteLine && filteredTargets.length >= 2 && (
            <Polyline
              positions={filteredTargets.map((t) => [t.lat, t.lng] as [number, number])}
              pathOptions={{
                color: '#f97316',
                weight: 3,
                opacity: 0.9,
                dashArray: '8 6',
              }}
            />
          )}

          {/* ターゲット（測点マーカー） */}
          {showTargets && (() => {
            // 点名ラベルは ON でも「画面内のマーカーだけ」に絞る。
            // 数千点を一気に permanent tooltip にすると DOM ノードが爆増して
            // 地図 (および同時に描画する地番ポリゴン) ごと固まるため。
            const labelsActive = showLabels && mapZoom >= LABEL_MIN_ZOOM
            const labelBounds =
              labelsActive && mapBounds ? mapBounds.pad(0.15) : null
            return filteredTargets.map((t) => {
            const isSelected = t.id === selectedTargetId
            const isStaked = stakedTargetIds.has(t.id)
            const showLabel =
              labelsActive &&
              (labelBounds == null || labelBounds.contains([t.lat, t.lng]))
            // 色: 選択中 = オレンジ、座標は点種で色分け、暗渠頂点 = 緑
            //   基準点(control) = 赤、境界点(boundary) = シアン、現況(current) = 青、その他 = 灰
            let baseColor = '#3b82f6'
            if (t.kind === 'pipe_vertex') {
              baseColor = '#22c55e'
            } else if (t.subType === 'control') {
              baseColor = '#dc2626'
            } else if (t.subType === 'boundary') {
              baseColor = '#0ea5e9'
            } else if (t.subType === 'current') {
              baseColor = '#3b82f6'
            } else {
              baseColor = '#64748b'
            }
            const fillColor = isSelected ? '#f97316' : baseColor
            const size = isSelected ? 18 : 12
            // タップ判定領域（指でも確実に拾えるよう 32px の透明枠で囲む）
            const HIT = 32
            const stakedInnerSize = size + 8
            const stakedHtml = `<div style="
              width:${HIT}px; height:${HIT}px;
              display:flex; align-items:center; justify-content:center;
              cursor:pointer;
            ">
              <div style="
                position: relative;
                width: ${stakedInnerSize}px;
                height: ${stakedInnerSize}px;
              ">
                <div style="
                  position:absolute; inset:0;
                  background:#ffffff;
                  border:2px solid ${isSelected ? '#f97316' : '#16a34a'};
                  border-radius:50%;
                  box-shadow:0 1px 3px rgba(0,0,0,0.35);
                  ${isSelected ? 'box-shadow:0 0 0 3px rgba(249,115,22,0.4),0 1px 3px rgba(0,0,0,0.35);' : ''}
                "></div>
                <svg viewBox="0 0 24 24" width="${stakedInnerSize}" height="${stakedInnerSize}"
                  style="position:absolute; inset:0;" fill="none"
                  stroke="${isSelected ? '#f97316' : '#16a34a'}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="6 12 10 16 18 8" />
                </svg>
              </div>
            </div>`
            const normalHtml = `<div style="
              width:${HIT}px; height:${HIT}px;
              display:flex; align-items:center; justify-content:center;
              cursor:pointer;
            ">
              <div style="
                width:${size}px;
                height:${size}px;
                background:${fillColor};
                border:2px solid white;
                border-radius:50%;
                box-shadow:0 1px 3px rgba(0,0,0,0.4);
                ${isSelected ? 'box-shadow:0 0 0 3px rgba(249,115,22,0.4),0 1px 3px rgba(0,0,0,0.4);' : ''}
              "></div>
            </div>`
            const iconSize = HIT
            return (
              <Marker
                key={t.id}
                position={[t.lat, t.lng]}
                icon={L.divIcon({
                  className: 'staking-target',
                  html: isStaked ? stakedHtml : normalHtml,
                  iconSize: [iconSize, iconSize],
                  iconAnchor: [iconSize / 2, iconSize / 2],
                })}
                eventHandlers={{
                  click: () => {
                    // 1m 以内の重なりターゲットを集める（自分も含む）。
                    // 2 件以上ならどれを選ぶか聞くシートを出す。
                    const nearby = filteredTargets.filter(
                      (other) => Math.hypot(other.x - t.x, other.y - t.y) <= OVERLAP_TOL_M,
                    )
                    // 座標計算で地図から点選択中なら、座標点に限り計算スロットへ割り当て
                    if (calcAssign && t.kind === 'coordinate') {
                      const assignable = nearby.filter((c) => c.kind === 'coordinate')
                      if (assignable.length <= 1) {
                        calcAssign(t.refId)
                        return
                      }
                      setOverlapPicker({ candidates: assignable, mode: 'assign' })
                      return
                    }
                    if (nearby.length <= 1) {
                      setSelectedTargetId(t.id)
                      return
                    }
                    setOverlapPicker({ candidates: nearby, mode: 'select' })
                  },
                }}
              >
                {showLabel && (
                  <Tooltip
                    key={`tip-${isStaked ? 'st' : 'no'}-${isSelected ? 'sel' : 'norm'}`}
                    className="staking-label-tooltip"
                    direction="top"
                    offset={[0, -6]}
                    permanent
                    opacity={1}
                  >
                    <span
                      style={{
                        color: fillColor,
                        // 白フチ（4 方向 + 斜め）でマーカーと同色文字を地図上で読みやすく
                        textShadow:
                          '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                        ...(isStaked
                          ? {
                              textDecoration: 'line-through',
                              textDecorationColor: 'rgba(22,163,74,0.7)',
                            }
                          : {}),
                      }}
                    >
                      {isStaked ? `✓ ${t.name}` : t.name}
                    </span>
                  </Tooltip>
                )}
              </Marker>
            )
          })
          })()}



          {/* 現在位置 */}
          {currentPos && (
            <>
              {currentAcc != null && (
                <CircleMarker
                  center={currentPos}
                  radius={Math.min(60, Math.max(6, currentAcc * 10))}
                  pathOptions={{
                    color: accuracyColor(currentAcc),
                    fillColor: accuracyColor(currentAcc),
                    fillOpacity: 0.15,
                    weight: 1,
                  }}
                />
              )}
              {headingEnabled && heading != null && (
                <Marker
                  position={currentPos}
                  icon={createHeadingIcon(heading)}
                  interactive={false}
                  keyboard={false}
                />
              )}
              {/* 現在位置の青い点は専用ペイン(z-index 650)に置き、
                  markerPane(600)のターゲット等より常に前面に表示する */}
              <Pane name="current-pos" style={{ zIndex: 650 }}>
                <CircleMarker
                  center={currentPos}
                  radius={6}
                  pane="current-pos"
                  pathOptions={{
                    color: accuracyColor(currentAcc),
                    fillColor: '#2563eb',
                    fillOpacity: 1,
                    weight: 2,
                  }}
                />
              </Pane>
            </>
          )}

          {/* LANDXML / 施工管理：床掘 TIN の三角形エッジ */}
          {(screenMode === 'construction' || landxmlMode) && trenchEdges.map((tri, i) => (
            <Polyline
              key={`trench-${i}`}
              positions={tri}
              pathOptions={{ color: '#0891b2', weight: 2, opacity: 0.85 }}
            />
          ))}

          {/* LANDXML / 施工管理：中心線形 */}
          {(screenMode === 'construction' || landxmlMode) && alignmentLines.map((line, i) => (
            <Polyline
              key={`align-${i}`}
              positions={line}
              pathOptions={{ color: '#1d4ed8', weight: 5, opacity: 0.95 }}
            />
          ))}

          {/* 法務省地図 (背景 + 地番選択) */}
          {isCadastralProject && hasActiveParcelDataset && (
            <ParcelMapLayer
              visible={showParcelLayer}
              bbox={effectiveParcelBbox}
              importedParcelKeys={importedParcelKeys}
              selectedKeys={selectedParcelKeys}
              onToggleSelect={toggleSelectedParcel}
              selectionMode={parcelSelectionMode}
              disableClicks={showDrawing && drawingMode !== 'off'}
            />
          )}
          {/* 描画レイヤ: showDrawing のときのみ描画モード有効。オフでも既存ストロークは表示 */}
          <MapDrawingLayer
            farmId={farm?.id ?? null}
            mode={showDrawing ? drawingMode : 'off'}
            color={drawingColor}
            widthPx={drawingWidth}
            lineStyle={drawingLineStyle}
          />
        </MapContainer>

        {/* 2D（断面）パネル: MAP/3D と併用なら下半分、単独なら全画面 */}
        {show2D && (
          <div
            className={`absolute left-0 right-0 z-[1000] bg-white/95 border-t border-cyan-300 flex flex-col ${
              showMap || show3D ? 'h-[50%] bottom-0' : 'top-0 bottom-0'
            }`}
          >
            {/* ヘッダー: 方向・新規・断面一覧・全消去・閉じる */}
            <div className="flex items-center flex-wrap gap-1 px-2 py-1 border-b bg-cyan-50 text-[11px]">
              <span className="font-semibold text-cyan-800 mr-1">断面</span>
              <select
                value={sectionDirection}
                onChange={(e) => setSectionDirection(e.target.value as 'along' | 'perp')}
                className="px-1 py-0.5 text-[11px] border rounded bg-white"
                title="2点を結ぶ線上 / 直角方向"
              >
                <option value="along">線上</option>
                <option value="perp">直角</option>
              </select>
              <button
                onClick={startNewSection}
                className="px-2 py-0.5 text-[11px] bg-cyan-700 text-white rounded hover:bg-cyan-600"
              >
                新規（2点）
              </button>
              {sectionPickingMode && (
                <span className="text-cyan-700">
                  座標から{sectionPickIds.length === 0 ? '1点目' : '2点目'}を選択…
                  <button
                    onClick={() => {
                      setSectionPickIds([])
                      setActiveSectionId(null)
                    }}
                    className="ml-1 underline"
                  >
                    中止
                  </button>
                </span>
              )}
              {/* 断面と現況点の照合許容範囲（半幅）*/}
              <label className="flex items-center gap-1 ml-1 text-slate-600">
                <span>幅±</span>
                <input
                  type="number"
                  step={0.1}
                  min={0.05}
                  value={sectionToleranceM}
                  onChange={(e) => {
                    const n = parseFloat(e.target.value)
                    if (Number.isFinite(n) && n > 0) setSectionToleranceM(n)
                  }}
                  className="w-12 px-1 py-0.5 text-[11px] border rounded text-right"
                  title="断面から左右何mまでの現況点を断面上に表示するか"
                />
                <span>m</span>
              </label>
              {sections.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setActiveSectionId(s.id === activeSectionId ? null : s.id)}
                  className={`px-1.5 py-0.5 text-[11px] rounded border ${
                    s.id === activeSectionId
                      ? 'bg-cyan-100 border-cyan-400 text-cyan-800'
                      : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'
                  }`}
                  title={s.direction === 'along' ? '線上' : '直角'}
                >
                  {s.name}
                </button>
              ))}
              {sections.length > 0 && (
                <button
                  onClick={() => {
                    if (!confirm('全ての断面を削除しますか？')) return
                    setSections([])
                    setActiveSectionId(null)
                  }}
                  className="px-1.5 py-0.5 text-[11px] border border-red-200 text-red-600 rounded hover:bg-red-50"
                >
                  全消去
                </button>
              )}
              <button
                onClick={() => setShowSectionPanel(false)}
                className="ml-auto px-2 py-0.5 border rounded hover:bg-white"
              >
                閉じる
              </button>
            </div>
            {/* 本体: アクティブ断面のチャート or プレースホルダ */}
            <div className="flex-1 overflow-hidden flex flex-col">
              {activeSection && sectionProfile ? (
                <ActiveSectionChart
                  name={activeSection.name}
                  direction={activeSection.direction}
                  profile={sectionProfile}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-xs text-slate-500">
                  「新規（2点）」で断面を作成、または上の一覧からタップして表示
                </div>
              )}
            </div>
          </div>
        )}

        {/* 旧: 単体チャート — 上のセクションパネル（ActiveSectionChart）に統合済 */}

        {/* 近接モード（1m 以内で地図表示から切替・精密誘導） */}
        {proximityActive && proximityRel && selectedTarget && (
          <ProximityGuide
            dN={proximityRel.dN}
            dE={proximityRel.dE}
            dist={proximityRel.dist}
            accuracy={currentAcc}
            targetName={selectedTarget.name}
            onCancel={() => setProximityCancelled(true)}
          />
        )}


        {/* 施工管理モード：ΔZ 大型表示 */}
        {screenMode === 'construction' && trenchDiff !== null && (
          <div className="absolute top-2 left-2 z-[1000] bg-white/95 border rounded-lg shadow-lg p-3 min-w-[180px]">
            <div className="text-[11px] text-slate-500">床掘 TIN との差分</div>
            <div className="text-2xl font-bold tabular-nums" style={{ color: diffColor(trenchDiff) }}>
              {trenchDiff >= 0 ? '+' : ''}{trenchDiff.toFixed(3)} m
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              実標高 {selfElevation !== null ? selfElevation.toFixed(3) : '-'} ／ TIN {trenchZ !== null ? trenchZ.toFixed(3) : '-'}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              {trenchDiff >= 0 ? '↑ 掘り不足' : '↓ 過掘'} {Math.abs(trenchDiff * 100).toFixed(1)} cm
            </div>
            {groundDiff !== null && (
              <div className="text-[10px] text-slate-500 mt-2 border-t pt-1">
                現況差 {groundDiff >= 0 ? '+' : ''}{groundDiff.toFixed(3)} m
              </div>
            )}
          </div>
        )}

        {/* 選択中の配線情報 */}
        {selectedPipeId && (() => {
          const pipe = pipes.find((p) => p.id === selectedPipeId)
          if (!pipe) return null
          const typeLabel = pipe.pipeType ? PIPE_TYPE_NAMES[pipe.pipeType] : '-'
          const length =
            pipe.measuredLength != null
              ? `${pipe.measuredLength.toFixed(2)} m（実測）`
              : pipe.designLength != null
                ? `${pipe.designLength.toFixed(2)} m（設計）`
                : '-'
          return (
            <div className="absolute top-2 left-2 z-[1000] bg-white/95 border rounded-lg shadow-lg p-2 text-xs space-y-0.5 max-w-[60%]">
              <div className="flex items-center justify-between gap-2">
                <span className="font-bold text-slate-800 truncate">{pipe.number}</span>
                <button
                  onClick={() => setSelectedPipeId(null)}
                  className="text-slate-400 hover:text-slate-700 px-1"
                  title="閉じる"
                >
                  ×
                </button>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">管種:</span>
                <span className="font-mono text-slate-800">{typeLabel}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">管径:</span>
                <span className="font-mono text-slate-800">
                  {pipe.diameter != null ? `${pipe.diameter} mm` : '-'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">延長:</span>
                <span className="font-mono text-slate-800">{length}</span>
              </div>
            </div>
          )
        })()}

        {/* 設定パネル */}
        {showSettings && (() => {
          const isGps = positioningMode === 'gps'
          return (
          <div className="absolute top-2 right-2 z-[3400] bg-white border rounded-lg shadow-lg w-64 text-sm flex flex-col max-h-[85vh]">
            <div className="px-3 pt-3 pb-2 border-b flex items-center justify-between shrink-0">
              <div className="font-semibold">設定</div>
              <button
                onClick={() => setShowSettings(false)}
                className="p-1 rounded hover:bg-slate-100"
                aria-label="閉じる"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="p-3 overflow-y-auto flex-1">

            {/* 地図回転（進行方向を画面上に） */}
            <label className="flex items-center gap-2 mb-1">
              <input
                type="checkbox"
                checked={mapRotationEnabled}
                onChange={() => void toggleMapRotation()}
              />
              <span className="text-xs">地図を進行方向に回す</span>
              <Navigation2
                className={`h-3.5 w-3.5 ml-auto ${
                  mapRotationEnabled ? 'text-emerald-600' : 'text-slate-400'
                }`}
              />
            </label>
            <div className="text-[10px] text-slate-500 mb-2">
              コンパス（方位センサー）を利用します。iOS では初回に許可を求められます。
            </div>

            {isGps && (
              <div className="mb-2 px-2 py-1.5 text-[11px] bg-amber-50 border border-amber-200 text-amber-800 rounded">
                簡易測定モードでは以下の RTK 用設定は編集できません
              </div>
            )}

            {/* 音声ガイダンス（精密モードのみ有効） */}
            <label className={`flex items-center gap-2 mb-3 ${isGps ? 'text-slate-400' : ''}`}>
              <input
                type="checkbox"
                checked={soundEnabled}
                onChange={() => void toggleSound()}
                disabled={isGps}
              />
              <span className="text-xs">音声ガイダンス</span>
              {soundEnabled ? (
                <Volume2 className="h-3.5 w-3.5 ml-auto text-emerald-600" />
              ) : (
                <VolumeX className="h-3.5 w-3.5 ml-auto text-slate-400" />
              )}
            </label>
            <div className={`text-[10px] mb-2 ${isGps ? 'text-slate-400' : 'text-slate-500'}`}>
              FIX: ピッ / 1m 以内: ピピ / 10cm 以内: ピピピ / FIX 喪失: ブーッ
            </div>

            <label className="flex flex-col gap-1 mb-3 border-t pt-2">
              <span className={`text-xs ${isGps ? 'text-slate-400' : 'text-slate-600'}`}>平均秒数</span>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={avgSeconds}
                onChange={(e) => setAvgSeconds(parseInt(e.target.value, 10))}
                disabled={recording || isGps}
              />
              <span className={`font-mono text-center ${isGps ? 'text-slate-400' : ''}`}>{avgSeconds} 秒</span>
            </label>

            <label className="flex flex-col gap-1 mb-3">
              <span className={`text-xs ${isGps ? 'text-slate-400' : 'text-slate-600'}`}>アンテナ高 (m)</span>
              <input
                type="number"
                step={0.01}
                value={antennaHeight}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  if (Number.isFinite(n)) setAntennaHeight(n)
                }}
                disabled={recording || isGps}
                className="w-full px-2 py-1 border rounded text-right font-mono disabled:bg-slate-50 disabled:text-slate-400"
              />
            </label>

            <label className={`flex items-center gap-2 mb-2 ${isGps ? 'text-slate-400' : ''}`}>
              <input
                type="checkbox"
                checked={useGeoidCorrection}
                onChange={(e) => setUseGeoidCorrection(e.target.checked)}
                disabled={recording || isGps}
              />
              <span className="text-xs">ジオイド補正を有効化</span>
            </label>
            {useGeoidCorrection && !isGps && (
              <div className="text-[11px] text-slate-500 mb-2">
                {geoidLoading && '読込中…'}
                {!geoidLoading && geoidGrid && '✓ JPGEO2024 読込済み'}
                {!geoidLoading && geoidError && <span className="text-red-600">エラー: {geoidError}</span>}
              </div>
            )}

            <div className={`text-[11px] mb-2 ${isGps ? 'text-slate-400' : 'text-slate-500'}`}>
              標高 = 楕円体高 − ジオイド高 − アンテナ高
            </div>

            {/* RTK 判定精度しきい値 (精密モードのみ効く) */}
            <label className="flex flex-col gap-1 mb-3 border-t pt-2">
              <span className={`text-xs ${isGps ? 'text-slate-400' : 'text-slate-600'}`}>
                RTK 判定精度 (精密モード)
              </span>
              <input
                type="range"
                min={FIX_ACCURACY_MIN_M}
                max={FIX_ACCURACY_MAX_M}
                step={0.005}
                value={rtkFixAccuracyM}
                onChange={(e) => setRtkFixAccuracyM(parseFloat(e.target.value))}
                disabled={isGps}
              />
              <span className={`font-mono text-center text-xs ${isGps ? 'text-slate-400' : ''}`}>
                {(rtkFixAccuracyM * 100).toFixed(1)} cm 以下で FIX
              </span>
              <span className={`text-[11px] ${isGps ? 'text-slate-400' : 'text-slate-500'}`}>
                この精度を下回ると測定ボタンが押せなくなり、RTK 受信音（ピッ）も出ません。
              </span>
            </label>

            <label className="flex items-center gap-2 mb-2 pt-2 border-t">
              <input
                type="checkbox"
                checked={use3dGuidance}
                onChange={(e) => setUse3dGuidance(e.target.checked)}
              />
              <span className="text-xs">三次元誘導（ターゲットとの比高を表示）</span>
            </label>
            <div className="text-[11px] text-slate-500 mb-2">
              方位・距離の右に「↓現在地が高い／↑現在地が低い」を表示します。
            </div>

            <div className="border-t pt-2 mb-2">
              <div className="text-xs text-slate-600 mb-1">新点の採番</div>
              <label className="flex items-center gap-2 mb-1">
                <input
                  type="radio"
                  name="numberingMode"
                  checked={numberingMode === 'perPrefix'}
                  onChange={() => setNumberingMode('perPrefix')}
                />
                <span className="text-xs">頭文字ごとに採番（道路-1 / 境界-1）</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="numberingMode"
                  checked={numberingMode === 'global'}
                  onChange={() => setNumberingMode('global')}
                />
                <span className="text-xs">通し番号・重複なし（道路-1 / 境界-2）</span>
              </label>
            </div>

            <div className="text-xs text-slate-500 border-t pt-2">
              Mock Location 経由で RTK-GNSS の補正座標を取得できます。
            </div>
            </div>
            <div className="px-3 py-2 border-t shrink-0">
              <button
                onClick={() => setShowSettings(false)}
                className="w-full px-2 py-1.5 text-xs border rounded hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
          </div>
          )
        })()}

        {/* ターゲットリスト（下部スライドアップ） */}
        {showTargetList && (
          <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[50%] flex flex-col">
            <div className="px-3 py-2 border-b flex items-center gap-2 text-sm">
              <span className="font-semibold">ターゲット</span>
              <span className="text-xs text-emerald-700 font-medium">
                測設済 {filteredTargets.filter((t) => stakedTargetIds.has(t.id)).length}
                <span className="text-slate-400"> / {filteredTargets.length}</span>
              </span>
              <div className="ml-2 flex gap-1 text-xs">
                {routeTargetIds.size > 0 && (
                  <button
                    onClick={() =>
                      setTargetFilter((prev) => (prev === 'route' ? 'all' : 'route'))
                    }
                    className={`px-2 py-0.5 rounded border ${
                      targetFilter === 'route'
                        ? 'bg-orange-600 text-white border-orange-600'
                        : ''
                    }`}
                    title={`保存済み順路の点のみを順番通りに表示（${routeTargetIds.size}点）`}
                  >
                    ルート
                    <span className="ml-1 text-[10px] opacity-80">({routeTargetIds.size})</span>
                  </button>
                )}
                {targetFilter === 'route' && (
                  <button
                    onClick={() => setShowRouteLine((v) => !v)}
                    className={`px-2 py-0.5 rounded border ${
                      showRouteLine
                        ? 'bg-orange-100 border-orange-400 text-orange-700'
                        : 'border-slate-300 text-slate-500'
                    }`}
                    title={showRouteLine ? 'ルート線を非表示' : 'ルート線を表示'}
                  >
                    線 {showRouteLine ? 'ON' : 'OFF'}
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowTargetList(false)}
                className="ml-auto text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
            {/* 点種フィルタ（チップ式トグル）: タップで該当点種をマーカー＆リストから非表示 */}
            {subTypeStats.length > 1 && (
              <div className="px-3 py-1.5 border-b bg-slate-50 flex items-center gap-1 flex-wrap text-[11px]">
                <span className="text-slate-500 mr-1">点種:</span>
                {subTypeStats.map((s) => {
                  const hidden = hiddenSubTypes.has(s.code)
                  const onCls =
                    s.kind === 'coordinate'
                      ? 'bg-blue-600 text-white border-blue-600'
                      : 'bg-emerald-600 text-white border-emerald-600'
                  const offCls = 'bg-white text-slate-400 border-slate-300 line-through'
                  return (
                    <button
                      key={s.code}
                      onClick={() =>
                        setHiddenSubTypes((prev) => {
                          const next = new Set(prev)
                          if (next.has(s.code)) next.delete(s.code)
                          else next.add(s.code)
                          return next
                        })
                      }
                      className={`px-1.5 py-0.5 rounded border font-medium ${
                        hidden ? offCls : onCls
                      }`}
                      title={hidden ? `${s.label} を表示` : `${s.label} を非表示`}
                    >
                      {s.label}
                      <span className="ml-1 text-[10px] opacity-80">({s.count})</span>
                    </button>
                  )
                })}
                {hiddenSubTypes.size > 0 && (
                  <button
                    onClick={() => setHiddenSubTypes(new Set())}
                    className="ml-1 px-1.5 py-0.5 text-slate-600 hover:text-slate-900 underline"
                  >
                    全て表示
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 overflow-auto">
              {filteredTargets.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">該当なし</div>
              ) : (
                <ul className="divide-y text-sm">
                  {filteredTargets.map((t) => {
                    const dist = currentPos
                      ? distanceMeters({ lat: currentPos[0], lng: currentPos[1] }, { lat: t.lat, lng: t.lng })
                      : null
                    const isSelected = t.id === selectedTargetId
                    const isStaked = stakedTargetIds.has(t.id)
                    return (
                      <li
                        key={t.id}
                        onClick={() => {
                          setSelectedTargetId(t.id)
                          setShowTargetList(false)
                        }}
                        className={`px-3 py-2 cursor-pointer flex items-center gap-2 ${
                          isSelected
                            ? 'bg-blue-50'
                            : isStaked
                            ? 'bg-emerald-50/60 hover:bg-emerald-100/60'
                            : 'hover:bg-slate-50'
                        }`}
                      >
                        {isStaked ? (
                          <svg
                            viewBox="0 0 24 24"
                            className="w-4 h-4 flex-shrink-0 text-emerald-600"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth={3}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="6 12 10 16 18 8" />
                          </svg>
                        ) : (
                          <span
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{
                              backgroundColor: t.kind === 'coordinate' ? '#3b82f6' : '#22c55e',
                            }}
                          />
                        )}
                        <span
                          className={`flex-1 font-medium ${
                            isStaked ? 'text-emerald-700 line-through decoration-emerald-400' : ''
                          }`}
                        >
                          {t.name}
                        </span>
                        <span className="text-xs text-slate-500">
                          {t.kind === 'coordinate'
                            ? '座標'
                            : '頂点'}
                        </span>
                        {dist != null && (
                          <span className="text-xs font-mono text-slate-600 w-16 text-right">
                            {dist < 1 ? `${(dist * 100).toFixed(0)}cm` : `${dist.toFixed(1)}m`}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        )}


        {/* 座標一覧（元の座標 + 起工測量記録をマージ表示） */}
        {showRecordList && (
          <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[65%] flex flex-col">
            <div className="px-3 py-2 border-b flex items-center gap-2 text-sm">
              <span className="font-semibold">座標</span>
              <span className="text-xs text-slate-500">{filteredTargets.length} 件</span>
              {/* SIMA インポート / エクスポート を「閉じる」の左に配置 */}
              <button
                onClick={() => setShowManualCoordEntry(true)}
                className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 border rounded text-emerald-700 border-emerald-300 hover:bg-emerald-50"
                title="X / Y 座標を手入力で 1 点追加"
              >
                <Plus className="h-3.5 w-3.5" />
                手入力
              </button>
              <button
                onClick={handleOpenSimImport}
                className="flex items-center gap-1 text-xs px-2 py-0.5 border rounded text-blue-700 border-blue-300 hover:bg-blue-50"
                title="SIMA インポート"
              >
                <Download className="h-3.5 w-3.5" />
                SIMA 取込
              </button>
              <button
                onClick={handleSimExport}
                className="flex items-center gap-1 text-xs px-2 py-0.5 border rounded text-blue-700 border-blue-300 hover:bg-blue-50"
                title="SIMA エクスポート"
              >
                <Upload className="h-3.5 w-3.5" />
                SIMA 出力
              </button>
              <button
                onClick={() => setShowCoordColumnPicker(true)}
                className="flex items-center gap-1 text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
                title="表示列を設定"
              >
                <Settings2 className="h-3.5 w-3.5" />
                表示列
              </button>
              <button
                onClick={() => setShowRecordList(false)}
                className="text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
              >
                閉じる
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {filteredTargets.length === 0 ? (
                <div className="p-4 text-center text-xs text-slate-400">座標がありません</div>
              ) : (
                <table className="w-full text-[11px]">
                  <thead className="sticky top-0 bg-slate-50 z-10">
                    <tr className="text-slate-500">
                      {coordColumns.has('name') && (
                        <th className="px-2 py-1 text-left">点名</th>
                      )}
                      {coordColumns.has('xy') && (
                        <>
                          <th className="px-2 py-1 text-right">X</th>
                          <th className="px-2 py-1 text-right">Y</th>
                        </>
                      )}
                      {coordColumns.has('z') && (
                        <th className="px-2 py-1 text-right">Z</th>
                      )}
                      {coordColumns.has('type') && (
                        <th className="px-2 py-1 text-left">点種</th>
                      )}
                      {coordColumns.has('stakeType') && (
                        <th className="px-2 py-1 text-left">杭種</th>
                      )}
                      {coordColumns.has('stakeStatus') && (
                        <th className="px-2 py-1 text-left">設置</th>
                      )}
                      {coordColumns.has('photo') && (
                        <th className="px-2 py-1 text-center">カメラ</th>
                      )}
                      {coordColumns.has('updatedBy') && (
                        <th className="px-2 py-1 text-left">更新者</th>
                      )}
                      {coordColumns.has('updatedAt') && (
                        <th className="px-2 py-1 text-left">更新日</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTargets.map((t) => {
                      const photoCount =
                        t.kind === 'coordinate'
                          ? attachmentsByEntity.get(`coordinate:${t.refId}`)?.length ?? 0
                          : 0
                      const statusLabel =
                        t.kind === 'coordinate' && t.stakeStatus
                          ? STAKE_STATUS_LABEL[t.stakeStatus] ?? ''
                          : ''
                      // coordinate 由来なら生 CoordinateRow から stakeType / updatedAt / updatedBy を拾う
                      const rawCoord =
                        t.kind === 'coordinate'
                          ? coordinates.find((c) => c.id === t.refId) ?? null
                          : null
                      const stakeTypeLabel = rawCoord?.stakeType ?? ''
                      const updatedAtLabel = rawCoord?.updatedAt
                        ? new Date(rawCoord.updatedAt).toLocaleString('ja-JP', {
                            year: '2-digit',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''
                      const updatedByLabel = rawCoord?.updatedBy
                        ? rawCoord.updatedBy === user?.id
                          ? '自分'
                          : rawCoord.updatedBy.slice(0, 6)
                        : ''
                      return (
                        <tr
                          key={t.id}
                          className="border-t hover:bg-blue-50 cursor-pointer"
                          onClick={() => setPointInfoTarget(t)}
                        >
                          {coordColumns.has('name') && (
                            <td className="px-2 py-1 font-medium text-slate-800 whitespace-nowrap max-w-[6rem] truncate">
                              {t.name}
                            </td>
                          )}
                          {coordColumns.has('xy') && (
                            <>
                              <td className="px-2 py-1 text-right font-mono">
                                {t.x.toFixed(3)}
                              </td>
                              <td className="px-2 py-1 text-right font-mono">
                                {t.y.toFixed(3)}
                              </td>
                            </>
                          )}
                          {coordColumns.has('z') && (
                            <td className="px-2 py-1 text-right font-mono">
                              {t.z != null ? t.z.toFixed(3) : '-'}
                            </td>
                          )}
                          {coordColumns.has('type') && (
                            <td className="px-2 py-1 text-slate-600 whitespace-nowrap max-w-[5rem] truncate">
                              {t.subTypeLabel}
                            </td>
                          )}
                          {coordColumns.has('stakeType') && (
                            <td className="px-2 py-1 text-slate-600 whitespace-nowrap max-w-[5rem] truncate">
                              {stakeTypeLabel || '-'}
                            </td>
                          )}
                          {coordColumns.has('stakeStatus') && (
                            <td className="px-2 py-1 text-slate-600">
                              {statusLabel || '-'}
                            </td>
                          )}
                          {coordColumns.has('photo') && (
                            <td className="px-2 py-1 text-center">
                              {photoCount > 0 ? (
                                <span className="inline-flex items-center gap-0.5 text-slate-700">
                                  <Camera className="h-3 w-3" />
                                  {photoCount}
                                </span>
                              ) : (
                                <span className="text-slate-300">-</span>
                              )}
                            </td>
                          )}
                          {coordColumns.has('updatedBy') && (
                            <td className="px-2 py-1 text-slate-600 whitespace-nowrap max-w-[5rem] truncate">
                              {updatedByLabel || '-'}
                            </td>
                          )}
                          {coordColumns.has('updatedAt') && (
                            <td className="px-2 py-1 text-slate-600 whitespace-nowrap">
                              {updatedAtLabel || '-'}
                            </td>
                          )}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}

        {/* 地番一覧パネル */}
        {showParcelList && farmId && (
          <MobileParcelListPanel
            farmId={farmId}
            visibleColumns={parcelColumns}
            onChangeColumns={setParcelColumns}
            onClose={() => setShowParcelList(false)}
          />
        )}

        {/* 座標: 表示列 picker */}
        {showCoordColumnPicker && (
          <MobileListColumnPicker
            title="座標: 表示列"
            columns={COORD_COLUMNS}
            requiredKeys={COORD_REQUIRED_KEYS}
            visible={coordColumns}
            onChange={setCoordColumns}
            onClose={() => setShowCoordColumnPicker(false)}
          />
        )}

        {/* 地図でポリゴンをタップ → 地番情報モーダル */}
        {parcelInfoTarget && (
          <MobileParcelEditModal
            workAreaId={parcelInfoTarget.areaId}
            parcelNumberFallback={parcelInfoTarget.parcelNumber}
            parcel={parcelsByWorkAreaId.get(parcelInfoTarget.areaId) ?? null}
            onClose={() => setParcelInfoTarget(null)}
          />
        )}
      </div>

      {/* 下部パネル（施工管理モードでは非表示） */}
      {screenMode !== 'construction' && (
      <div className="border-t bg-white px-3 py-2 text-sm space-y-1">
        {/* 3D モード行: LANDXML/TIN高/比高 + 断面表示ボタン */}
        {show3D && (
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[10px] text-slate-500 font-sans">LANDXML</span>
            {trenchSurface ? (
              <>
                <div className="flex items-baseline gap-1">
                  <span className="text-slate-500 text-[10px]">TIN高</span>
                  <span className="font-mono font-bold text-base tabular-nums">
                    {trenchZ !== null ? `${trenchZ.toFixed(3)} m` : '-'}
                  </span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-slate-500 text-[10px]">比高</span>
                  {trenchDiff !== null ? (
                    <span
                      className="font-mono font-bold text-base tabular-nums"
                      style={{ color: diffColor(trenchDiff) }}
                    >
                      {trenchDiff >= 0 ? '↑' : '↓'}
                      {Math.abs(trenchDiff).toFixed(3)} m
                    </span>
                  ) : (
                    <span className="text-slate-400 text-[11px]">範囲外/取得待ち</span>
                  )}
                </div>
                <button
                  onClick={() => setShowSectionPanel((v) => !v)}
                  className={`ml-auto px-3 py-1 text-xs rounded font-bold ${
                    showSectionPanel
                      ? 'bg-cyan-700 text-white'
                      : 'border border-cyan-700 text-cyan-700 hover:bg-cyan-50'
                  }`}
                  title="断面プロファイル表示"
                >
                  断面表示
                </button>
              </>
            ) : (
              <>
                <span className="text-xs text-slate-500">
                  {landxmlBusy ? '読込中…' : '未読込'}
                </span>
                <label className="cursor-pointer ml-auto">
                  <input
                    ref={landxmlInputRef}
                    type="file"
                    accept=".xml,.XML,.landxml,.LANDXML"
                    onChange={handleLoadXml}
                    className="hidden"
                  />
                  <span className="inline-flex items-center gap-1 px-2 py-1 bg-cyan-700 text-white text-xs rounded hover:bg-cyan-600">
                    <Upload className="h-3 w-3" />
                    LandXMLを選択
                  </span>
                </label>
                {savedLandxmls.length > 0 && (
                  <button
                    onClick={() => setShowLandxmlList(true)}
                    className="inline-flex items-center gap-1 px-2 py-1 border border-cyan-700 text-cyan-700 text-xs rounded hover:bg-cyan-50"
                  >
                    <Database className="h-3 w-3" />
                    履歴 ({savedLandxmls.length})
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* MAP モード行: ターゲット設定 → 誘導表示 */}
        {showMap && (selectedTarget ? (
          <div className="flex flex-col gap-1">
            {/* 1 行目: 点名 (伸縮) + 解除 X + 矢印/距離。
                点名を最大限に表示するため、測定/詳細ボタンは 2 行目に配置。 */}
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowTargetList(true)}
                className="flex-1 min-w-0 text-left"
                title="ターゲット切替"
              >
                <div className="font-bold text-base truncate">{selectedTarget.name}</div>
              </button>
              <button
                onClick={() => setSelectedTargetId(null)}
                className="p-1.5 rounded border border-slate-300 text-slate-500 hover:bg-slate-100 shrink-0"
                title="ターゲットを解除"
              >
                <X className="h-4 w-4" />
              </button>
              {distanceToTarget != null && bearingToTarget != null && (
                <div className="flex items-center gap-2 shrink-0">
                  <ArrowUp
                    className="h-7 w-7 text-blue-600"
                    style={{
                      transform: `rotate(${bearingToTarget}deg)`,
                      transition: 'transform 120ms linear',
                    }}
                  />
                  <div className="text-right">
                    <div className="text-[10px] text-slate-500 leading-none">
                      {bearingToTarget.toFixed(0)}°
                    </div>
                    <div className="font-mono font-bold text-lg leading-tight">
                      {distanceToTarget < 1
                        ? `${(distanceToTarget * 100).toFixed(0)} cm`
                        : `${distanceToTarget.toFixed(2)} m`}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {/* 2 行目: 測定 + 詳細ボタン。簡易測定モードでは測定ボタンなし。 */}
            <div className="flex items-center gap-2">
              {!recording && positioningMode !== 'gps' && (() => {
                const rtkNotFix =
                  positioningMode === 'rtk' &&
                  (currentAcc == null || currentAcc > rtkFixAccuracyM)
                const disabled = saving || !currentPos || rtkNotFix
                return (
                  <button
                    onClick={() => startRecording()}
                    disabled={disabled}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed font-bold text-sm bg-red-600 hover:bg-red-700"
                    title={
                      rtkNotFix
                        ? `精度 ${(rtkFixAccuracyM * 100).toFixed(1)}cm 以下で測定可能`
                        : undefined
                    }
                  >
                    <CircleIcon className="h-4 w-4" />
                    測定
                  </button>
                )
              })()}
              <button
                onClick={() => setPointInfoTarget(selectedTarget)}
                className="flex-1 flex items-center justify-center gap-1 px-3 py-2 border border-slate-300 rounded-lg text-slate-700 hover:bg-slate-100 text-sm font-semibold"
                title="ターゲットの詳細を表示"
              >
                <Info className="h-4 w-4" />
                詳細
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowTargetList(true)}
            className="w-full py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            ターゲットを選択
          </button>
        ))}

        {/* 現在地 XYZ + 精度（1 行で収めるため余白とコロンを詰める） */}
        <div className="mt-1 text-[11px] font-mono text-slate-600 flex items-center gap-1.5 border-t pt-1 whitespace-nowrap overflow-hidden">
          <span className="text-slate-500">現在地</span>
          {currentXY ? (
            <>
              <span>X<span className="text-slate-800 ml-0.5">{currentXY.x.toFixed(3)}</span></span>
              <span>Y<span className="text-slate-800 ml-0.5">{currentXY.y.toFixed(3)}</span></span>
              <span>
                Z
                <span className="text-slate-800 ml-0.5">
                  {(() => {
                    if (currentAlt == null) return '-'
                    // 楕円体高 → 標高（ジオイド補正 + アンテナ高）
                    // 簡易測定モードでは補正なしで楕円体高そのまま
                    let H: number | null = null
                    if (currentPos && effUseGeoid && geoidGrid) {
                      const rRow = (geoidGrid.latMax - currentPos[0]) / geoidGrid.dLat
                      const rCol = (currentPos[1] - geoidGrid.lonMin) / geoidGrid.dLon
                      if (rRow >= 0 && rCol >= 0 && rRow < geoidGrid.nrows && rCol < geoidGrid.ncols) {
                        const r0 = Math.floor(rRow), c0 = Math.floor(rCol)
                        const r1 = Math.min(r0 + 1, geoidGrid.nrows - 1)
                        const c1 = Math.min(c0 + 1, geoidGrid.ncols - 1)
                        const tr = rRow - r0, tc = rCol - c0
                        const v00 = geoidGrid.values[r0 * geoidGrid.ncols + c0]
                        const v01 = geoidGrid.values[r0 * geoidGrid.ncols + c1]
                        const v10 = geoidGrid.values[r1 * geoidGrid.ncols + c0]
                        const v11 = geoidGrid.values[r1 * geoidGrid.ncols + c1]
                        const N = (v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr
                        if (Number.isFinite(N)) H = currentAlt - N - effAntennaHeight
                      }
                    } else if (currentPos) {
                      H = currentAlt - effAntennaHeight
                    }
                    return (H ?? currentAlt).toFixed(3)
                  })()}
                </span>
              </span>
              <span className="inline-flex items-center gap-0.5 ml-auto" style={{ color: accuracyColor(currentAcc) }}>
                <Radio className="h-3 w-3" />
                {currentAcc != null ? currentAcc.toFixed(3) : '-'}
              </span>
            </>
          ) : (
            <span className="text-slate-400">取得中...</span>
          )}
        </div>

        {/* 操作ボタン: 測定 / カメラ / メモ を等幅で横並びに。
            ターゲット選択中はターゲット行の左に測定ボタンがあるので、この行自体を消す。
            ターゲット未選択時のみ表示（フリー点の記録 or カメラ / メモ）。
            測定中はどちらの状態でも進捗表示は必要なので出す。 */}
        {(recording || !selectedTarget) && (
        <div className="mt-1 flex gap-2">
          {!recording ? (
            <>
              {/* 測定（旧 記録）。GPS モードはオレンジ「簡易測定」。
                  RTK モードでは currentAcc がしきい値を超えているとき半透明化 */}
              {(() => {
                const isGps = positioningMode === 'gps'
                const rtkNotFix =
                  positioningMode === 'rtk' &&
                  (currentAcc == null || currentAcc > rtkFixAccuracyM)
                const disabled = saving || !currentPos || rtkNotFix
                return (
                  <button
                    onClick={() => startRecording()}
                    disabled={disabled}
                    className={`flex-1 basis-0 flex items-center justify-center gap-1 px-2 py-3 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed font-bold ${
                      isGps ? 'bg-orange-500 hover:bg-orange-600' : 'bg-red-600 hover:bg-red-700'
                    }`}
                    title={
                      isGps
                        ? '1 回だけ位置を取得します（補正なしの簡易測定）'
                        : rtkNotFix
                          ? `精度 ${(rtkFixAccuracyM * 100).toFixed(1)}cm 以下で測定可能`
                          : undefined
                    }
                  >
                    <CircleIcon className="h-5 w-5" />
                    {isGps ? '簡易測定' : '測定'}
                  </button>
                )
              })()}

              {/* カメラ: ターゲット選択時は座標の写真モーダル、それ以外は
                  位置 + 方向を持つ標準写真を撮影 → 直接アップロード */}
              {selectedTarget && selectedTarget.kind === 'coordinate' ? (() => {
                const photoCount =
                  attachmentsByEntity.get(`coordinate:${selectedTarget.refId}`)?.length ?? 0
                return (
                  <button
                    onClick={handleOpenPhotoModal}
                    className="flex-1 basis-0 relative flex items-center justify-center gap-1 px-2 py-3 rounded-lg font-bold bg-blue-600 text-white hover:bg-blue-700"
                    title="ターゲット座標の写真（撮影・閲覧）"
                  >
                    <Camera className="h-5 w-5" />
                    カメラ
                    {photoCount > 0 && (
                      <span className="absolute -top-1 -right-1 bg-amber-400 text-slate-900 text-[10px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
                        {photoCount > 99 ? '99+' : photoCount}
                      </span>
                    )}
                  </button>
                )
              })() : (
                <button
                  type="button"
                  onClick={() => setPhotoSourceSheet(true)}
                  className="flex-1 basis-0 flex items-center justify-center gap-1 px-2 py-3 rounded-lg font-bold bg-blue-600 text-white hover:bg-blue-700"
                  title="撮影またはインポート"
                >
                  <Camera className="h-5 w-5" />
                  カメラ
                </button>
              )}

              {/* メモ — 現在位置でメモを残す */}
              <button
                type="button"
                onClick={() =>
                  setMemoModalState({
                    lat: currentPos ? currentPos[0] : null,
                    lng: currentPos ? currentPos[1] : null,
                  })
                }
                className="flex-1 basis-0 flex items-center justify-center gap-1 px-2 py-3 rounded-lg border border-amber-400 bg-amber-50 text-amber-800 font-semibold active:bg-amber-100"
                title="現在位置でメモを残す"
              >
                <StickyNote className="h-5 w-5" />
                メモ
              </button>

              {/* 設置済 トグル（ターゲットありのときだけ追加表示） */}
              {selectedTarget && (() => {
                const isStaked = stakedTargetIds.has(selectedTarget.id)
                return (
                  <button
                    onClick={() => handleToggleManualStaked(selectedTarget)}
                    disabled={saving}
                    className={`shrink-0 px-3 py-3 rounded-lg font-bold disabled:opacity-50 ${
                      isStaked
                        ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                        : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                    }`}
                    title={isStaked ? '測設済（タップで解除）' : '記録せず測設済としてマーク'}
                  >
                    <Check className="h-5 w-5" />
                  </button>
                )
              })()}
            </>
          ) : (
            <>
              <div className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-amber-500 text-white rounded-lg font-bold">
                <Loader2 className="h-5 w-5 animate-spin" />
                <span>測定中… {recordedCount} サンプル</span>
                {rejectedCount > 0 && (
                  <span className="text-[11px] font-normal opacity-90">
                    （ノイズ棄却 {rejectedCount} 件 / 時間延長中）
                  </span>
                )}
              </div>
              <button
                onClick={cancelRecording}
                className="px-3 py-3 border rounded-lg hover:bg-slate-50"
              >
                中止
              </button>
            </>
          )}
        </div>
        )}
      </div>
      )}

      {/* 断面の 2 点を座標管理から選択するモーダル */}
      {sectionPickingMode && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-[3500]">
          <div className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl p-3 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-slate-800">
                断面の 2 点を座標から選択 ({sectionPickIds.length}/2)
              </h3>
              <button
                onClick={() => {
                  setSectionPickIds([])
                  setActiveSectionId(null)
                }}
                className="p-1 text-slate-500 hover:bg-slate-100 rounded"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="text-[11px] text-slate-500 mb-2">
              {sectionPickIds.length === 0 ? '1 点目を選んでください' : '2 点目を選んでください'}
              ・方向: {sectionDirection === 'along' ? '線上' : '直角'}
            </div>
            <div className="flex-1 overflow-auto border rounded divide-y">
              {(() => {
                const list = (coordinates as CoordinateRow[]).filter(
                  (c) => c.lat != null && c.lng != null,
                )
                if (list.length === 0)
                  return <div className="p-3 text-xs text-slate-500">座標が登録されていません</div>
                return list.map((c) => {
                  const picked = sectionPickIds.includes(c.id)
                  const disabled = picked
                  return (
                    <button
                      key={c.id}
                      disabled={disabled}
                      onClick={() => {
                        const next = [...sectionPickIds, c.id]
                        if (next.length < 2) {
                          setSectionPickIds(next)
                          return
                        }
                        const a = coordinates.find((cc) => cc.id === next[0])
                        const b = coordinates.find((cc) => cc.id === next[1])
                        if (
                          !a || !b ||
                          a.lat == null || a.lng == null ||
                          b.lat == null || b.lng == null
                        ) {
                          setSectionPickIds([])
                          setActiveSectionId(null)
                          return
                        }
                        const suggested = `${a.pointNumber}-${b.pointNumber}`
                        const name = window.prompt('断面名', suggested)
                        if (name === null) {
                          setSectionPickIds([])
                          setActiveSectionId(null)
                          return
                        }
                        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
                        const s: CrossSection = {
                          id,
                          name: name.trim() || suggested,
                          a: [a.lat, a.lng],
                          b: [b.lat, b.lng],
                          direction: sectionDirection,
                        }
                        setSections((prev) => [...prev, s])
                        setActiveSectionId(id)
                        setSectionPickIds([])
                      }}
                      className={`w-full text-left p-2 flex items-center gap-2 text-sm ${
                        picked ? 'bg-cyan-50 text-cyan-800' : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-medium flex-1 truncate">{c.pointNumber}</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        X{c.x.toFixed(2)} Y{c.y.toFixed(2)}
                      </span>
                      {picked && <span className="text-[10px] text-cyan-700">選択済</span>}
                    </button>
                  )
                })
              })()}
            </div>
          </div>
        </div>
      )}

      {/* 保存済み LandXML 一覧モーダル */}
      {showLandxmlList && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-[3500]">
          <div className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl p-3 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold text-slate-800">保存済み LandXML</h3>
              <button
                onClick={() => setShowLandxmlList(false)}
                className="p-1 text-slate-500 hover:bg-slate-100 rounded"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="text-[11px] text-slate-500 mb-2">
              この工区にアップロード済みの LandXML 一覧。タップで切替（active になります）。
            </div>
            <div className="flex-1 overflow-auto border rounded divide-y">
              {savedLandxmls.length === 0 ? (
                <div className="p-3 text-xs text-slate-500">まだ保存されていません</div>
              ) : (
                savedLandxmls.map((row) => {
                  const isActive = row.id === activeLandxmlId || row.isActive
                  return (
                    <div
                      key={row.id}
                      className={`p-2 flex items-start gap-2 ${
                        isActive ? 'bg-cyan-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <button
                        onClick={() => handleSelectSavedLandxml(row)}
                        className="flex-1 text-left"
                        disabled={landxmlBusy}
                      >
                        <div className="text-sm font-medium truncate" title={row.name}>
                          {isActive && (
                            <span className="text-[10px] bg-cyan-600 text-white px-1 rounded mr-1">
                              ACTIVE
                            </span>
                          )}
                          {row.name}
                        </div>
                        <div className="text-[10px] text-slate-500 mt-0.5">
                          {new Date(row.updatedAt).toLocaleString('ja-JP')}
                          {row.sizeBytes != null && ` ・ ${Math.round(row.sizeBytes / 1024)} KB`}
                        </div>
                      </button>
                      <button
                        onClick={() => handleDeleteSavedLandxml(row)}
                        className="p-1.5 text-red-500 hover:bg-red-50 rounded shrink-0"
                        title="削除"
                        disabled={landxmlBusy}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* 座標を手入力で 1 点追加するモーダル (座標一覧タブの「手入力」から起動) */}
      {showManualCoordEntry && farm && (
        <ManualCoordEntryModal
          farmId={farm.id}
          zone={zone}
          existingPointNumbers={coordinates.map((c) => c.pointNumber)}
          typeOptions={typeOptions}
          onCancel={() => setShowManualCoordEntry(false)}
          onSaved={() => {
            setShowManualCoordEntry(false)
          }}
        />
      )}

      {/* 点情報モーダル（座標一覧の行タップ / マップマーカータップで開く） */}
      {pointInfoTarget && (() => {
        const t = pointInfoTarget
        const isCoord = t.kind === 'coordinate'
        // 編集内容が即座に反映されるよう、最新の coordinate 行から type / stakeStatus を読み直す
        const liveCoord = isCoord ? coordinates.find((c) => c.id === t.refId) : null
        const currentType = liveCoord?.type ?? t.subType
        const currentStatus = (liveCoord?.stakeStatus ?? t.stakeStatus) as
          | typeof t.stakeStatus
          | ''
        // 写真（遠景 / 近景 / その他）
        const photos = isCoord
          ? attachmentsByEntity.get(`coordinate:${t.refId}`) ?? []
          : []
        const farView = photos.filter((p) => p.category === '遠景')
        const nearView = photos.filter((p) => p.category === '近景')
        const otherPhotos = photos.filter(
          (p) => p.category !== '遠景' && p.category !== '近景',
        )
        return (
          <div
            className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3400] p-3"
            onClick={() => setPointInfoTarget(null)}
          >
            <div
              className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[92vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-800 truncate">{t.name}</div>
                </div>
                <button
                  onClick={() => setPointInfoTarget(null)}
                  className="text-slate-400 hover:text-slate-600 p-1"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="overflow-auto flex-1 p-4 space-y-3">
                {/* 座標 X / Y / Z を横並び（枠なし） */}
                <div className="flex items-baseline gap-4 text-sm font-mono">
                  <div>
                    <span className="text-[10px] text-slate-500 mr-1 font-sans">X</span>
                    <span className="text-slate-800">{t.x.toFixed(3)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 mr-1 font-sans">Y</span>
                    <span className="text-slate-800">{t.y.toFixed(3)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 mr-1 font-sans">Z</span>
                    <span className="text-slate-800">
                      {t.z != null ? t.z.toFixed(3) : '-'}
                    </span>
                  </div>
                </div>

                {/* 点名 (coordinate のみ編集可) */}
                {isCoord && (
                  <div>
                    <div className="text-[10px] text-slate-500 mb-0.5">点名</div>
                    <input
                      type="text"
                      defaultValue={liveCoord?.pointNumber ?? t.name}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (!v) return
                        if (v === (liveCoord?.pointNumber ?? t.name)) return
                        void updatePointNumberStore(t.refId, v)
                      }}
                      className="w-full px-2 py-1 text-sm border rounded bg-white"
                    />
                  </div>
                )}

                {/* 点種 / 設置 を横並び（coordinate のみ編集可） */}
                {isCoord ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <div className="text-[10px] text-slate-500 mb-0.5">点種</div>
                        <select
                          value={currentType}
                          onChange={(e) =>
                            void setCoordinateType(
                              t.refId,
                              e.target.value as CoordinateRow['type'],
                            )
                          }
                          className="w-full px-2 py-1 text-sm border rounded bg-white"
                        >
                          {typeOptions.map((o) => (
                            <option key={o.code} value={o.code}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-500 mb-0.5">設置</div>
                        <select
                          value={currentStatus || ''}
                          onChange={(e) => {
                            const v = e.target.value as typeof currentStatus
                            void setStakeStatus(t.refId, v)
                          }}
                          className="w-full px-2 py-1 text-sm border rounded bg-white"
                        >
                          {STAKE_STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s}>
                              {STAKE_STATUS_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {/* 杭種 (自由入力。任意) */}
                    <div>
                      <div className="text-[10px] text-slate-500 mb-0.5">杭種</div>
                      <input
                        type="text"
                        defaultValue={liveCoord?.stakeType ?? ''}
                        onBlur={(e) => {
                          const v = e.target.value.trim()
                          const cur = liveCoord?.stakeType ?? ''
                          if (v === cur) return
                          void updateStakeTypeStore(t.refId, v.length > 0 ? v : null)
                        }}
                        placeholder="任意 (例: プラ杭 / 木杭)"
                        className="w-full px-2 py-1 text-sm border rounded bg-white"
                      />
                    </div>
                  </>
                ) : (
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div>
                      <div className="text-[10px] text-slate-500 mb-0.5">点種</div>
                      <div className="px-2 py-1 border rounded bg-slate-50 text-slate-800">
                        {t.subTypeLabel}
                      </div>
                    </div>
                  </div>
                )}

                {/* 備考（coordinate のみ編集可、blur で即時保存） */}
                {isCoord && (
                  <div>
                    <div className="text-[10px] text-slate-500 mb-0.5">備考</div>
                    <input
                      type="text"
                      defaultValue={liveCoord?.notes ?? ''}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        void setNotes(t.refId, v.length > 0 ? v : null)
                      }}
                      placeholder="任意のメモ"
                      className="w-full px-2 py-1 text-sm border rounded bg-white"
                    />
                  </div>
                )}

                {/* 写真セクション（coordinate のみ） */}
                {isCoord && (
                  <div className="border rounded p-2 bg-slate-50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-700 inline-flex items-center gap-1">
                        <Camera className="h-3.5 w-3.5" />
                        測点写真
                      </span>
                      <button
                        onClick={() => setPhotoModalTarget(t)}
                        className="text-xs px-2 py-0.5 border rounded bg-white text-blue-700 border-blue-300 hover:bg-blue-50"
                      >
                        写真を編集
                      </button>
                    </div>

                    {/* 遠景 / 近景 を横並び。1 枚あたりカードの幅いっぱいで大きく表示。
                        2 枚以上あるときは先頭のみ大きく、右上に +N バッジ */}
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          { label: '遠景', list: farView },
                          { label: '近景', list: nearView },
                        ] as const
                      ).map(({ label, list }) => (
                        <div key={label}>
                          <div className="text-[11px] text-slate-500 mb-1 flex items-center justify-between">
                            <span className="font-semibold text-slate-700">{label}</span>
                            <span>{list.length} 枚</span>
                          </div>
                          {list.length === 0 ? (
                            <button
                              onClick={() => setPhotoModalTarget(t)}
                              className="w-full aspect-square rounded border border-dashed border-slate-300 text-slate-400 text-sm hover:bg-slate-100"
                            >
                              追加
                            </button>
                          ) : (
                            <div className="relative">
                              <PointPhotoThumb
                                filePath={list[0].filePath}
                                getSignedUrl={getSignedUrl}
                                onClick={() => setPhotoModalTarget(t)}
                              />
                              {list.length > 1 && (
                                <span className="absolute top-1 right-1 bg-black/60 text-white text-[10px] rounded px-1.5 py-0.5">
                                  +{list.length - 1}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {/* その他があるときだけ下段に。1 枚を大きめ + バッジ */}
                    {otherPhotos.length > 0 && (
                      <div className="mt-3">
                        <div className="text-[11px] text-slate-500 mb-1 flex items-center justify-between">
                          <span className="font-semibold text-slate-700">その他</span>
                          <span>{otherPhotos.length} 枚</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {otherPhotos.slice(0, 3).map((p, idx) => (
                            <div key={p.id} className="relative">
                              <PointPhotoThumb
                                filePath={p.filePath}
                                getSignedUrl={getSignedUrl}
                                onClick={() => setPhotoModalTarget(t)}
                              />
                              {idx === 2 && otherPhotos.length > 3 && (
                                <span className="absolute top-1 right-1 bg-black/60 text-white text-[10px] rounded px-1.5 py-0.5">
                                  +{otherPhotos.length - 3}
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="px-4 pb-4 pt-2 border-t">
                <button
                  onClick={() => setPointInfoTarget(null)}
                  className="w-full px-3 py-2 text-sm border rounded hover:bg-slate-50"
                >
                  閉じる
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 現場開始前チェック（ジオイド補正・目標高 と既知点による精度チェックの喚起） */}
      {showStartupCheck && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-[3500]">
          <div className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl p-4 max-h-[95vh] overflow-auto">
            <h3 className="text-base font-bold mb-2 text-slate-800">現場の開始前チェック</h3>

            {/* Drogger アプリへのリンク */}
            <a
              href="https://play.google.com/store/search?q=Drogger%20GPS&c=apps"
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-between gap-2 mb-3 px-3 py-2 border border-emerald-300 rounded-lg bg-emerald-50 hover:bg-emerald-100"
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-emerald-800">Drogger アプリを開く</div>
                <div className="text-[10px] text-emerald-700">
                  Google Play で Drogger GPS / RTK を検索・起動
                </div>
              </div>
              <ExternalLink className="h-4 w-4 text-emerald-700 shrink-0" />
            </a>

            <p className="text-xs text-slate-600 mb-3">
              観測を始める前に以下の設定をご確認ください。
            </p>

            {/* ジオイド補正 */}
            <div className="border rounded-lg p-3 mb-3 bg-slate-50">
              <div className="text-xs font-bold text-slate-700 mb-1.5">ジオイド補正</div>
              <label className="flex items-center gap-2 mb-1">
                <input
                  type="checkbox"
                  checked={useGeoidCorrection}
                  onChange={(e) => setUseGeoidCorrection(e.target.checked)}
                />
                <span className="text-sm">ジオイド補正を有効化する</span>
                <span
                  className={`ml-auto text-[11px] px-1.5 py-0.5 rounded ${
                    useGeoidCorrection ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                  }`}
                >
                  {useGeoidCorrection ? 'ON' : 'OFF'}
                </span>
              </label>
              <div className="text-[11px] text-slate-500">
                {useGeoidCorrection ? (
                  <>
                    {geoidLoading && '読込中…'}
                    {!geoidLoading && geoidGrid && '✓ JPGEO2024 読込済み'}
                    {!geoidLoading && !geoidGrid && !geoidError && '未読込'}
                    {!geoidLoading && geoidError && (
                      <span className="text-red-600">エラー: {geoidError}</span>
                    )}
                  </>
                ) : (
                  <span className="text-amber-700">
                    OFF のとき標高は楕円体高 − アンテナ高のみで計算されます。
                  </span>
                )}
              </div>
            </div>

            {/* 目標高(アンテナ高) */}
            <div className="border rounded-lg p-3 mb-3 bg-slate-50">
              <div className="text-xs font-bold text-slate-700 mb-1.5">目標高（アンテナ高） (m)</div>
              <input
                type="number"
                step={0.01}
                value={antennaHeight}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  if (Number.isFinite(n)) setAntennaHeight(n)
                }}
                className="w-full px-2 py-1.5 border rounded text-right font-mono text-sm"
              />
              <div className="text-[11px] text-slate-500 mt-1">
                ロッド/ポール先端からアンテナ位相中心までの高さ。
              </div>
            </div>

            {/* 音声ガイダンス */}
            <div className="border rounded-lg p-3 mb-3 bg-slate-50">
              <div className="text-xs font-bold text-slate-700 mb-1.5">音声ガイダンス</div>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={startupSoundOn}
                  onChange={(e) => setStartupSoundOn(e.target.checked)}
                />
                <span className="text-sm">音声ガイダンスを有効化する</span>
                <span
                  className={`ml-auto text-[11px] px-1.5 py-0.5 rounded ${
                    startupSoundOn ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {startupSoundOn ? 'ON' : 'OFF'}
                </span>
              </label>
              <div className="text-[11px] text-slate-500 mt-1">
                FIX 判定 / FIX 喪失 / ターゲット接近を音で通知します（RTK 測位で推奨）。
              </div>
            </div>

            <button
              onClick={() => {
                // 音声 ON にする（ユーザー操作直後なので AudioContext を resume 可能）
                if (startupSoundOn && !soundEnabled) {
                  void toggleSound()
                } else if (!startupSoundOn && soundEnabled) {
                  void toggleSound()
                }
                setShowStartupCheck(false)
              }}
              className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-bold"
            >
              確認した
            </button>
          </div>
        </div>
      )}

      {/* 測位モード選択（工区を開くたびに表示） */}
      {showModeChooser && farmId && (
        <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-[3600]">
          <div className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl p-4">
            <h3 className="text-base font-bold mb-2 text-slate-800">測位方法を選択</h3>
            <p className="text-xs text-slate-600 mb-3">
              現場で使用する測位方法を選んでください。
            </p>

            <button
              onClick={() => {
                setPositioningMode('rtk')
                setShowModeChooser(false)
                // RTK を選んだら続けて開始前チェック（ジオイド補正 / アンテナ高 / 音声）を出す
                setShowStartupCheck(true)
              }}
              className="w-full border-2 border-blue-600 rounded-lg p-3 mb-3 text-left hover:bg-blue-50"
            >
              <div className="text-sm font-bold text-blue-700">精密測定モード</div>
              <div className="text-xs text-slate-600 mt-0.5">Android + Drogger で cm 精密測位</div>
            </button>

            <button
              onClick={() => {
                setPositioningMode('gps')
                setShowModeChooser(false)
              }}
              className="w-full border-2 border-amber-500 rounded-lg p-3 text-left hover:bg-amber-50"
            >
              <div className="text-sm font-bold text-amber-700">簡易測定モード</div>
              <div className="text-xs text-slate-600 mt-0.5">スマホで手軽に概略調査</div>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// 断面プロファイルチャート（断面パネル内で使用）
function ActiveSectionChart({
  name,
  direction,
  profile,
}: {
  name: string
  direction: 'along' | 'perp'
  profile: {
    length: number
    tinPts: { d: number; z: number | null }[]
    recPts: { d: number; z: number; name: string }[]
  }
}) {
  const W = 600
  const H = 200
  const padL = 40, padR = 10, padT = 14, padB = 22
  const PW = W - padL - padR
  const PH = H - padT - padB
  let zMin = Infinity, zMax = -Infinity
  for (const p of profile.tinPts) if (p.z != null) { if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z }
  for (const p of profile.recPts) { if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z }
  if (!Number.isFinite(zMin) || !Number.isFinite(zMax)) { zMin = 0; zMax = 1 }
  if (zMax - zMin < 0.5) { const m = (zMin + zMax) / 2; zMin = m - 0.25; zMax = m + 0.25 }
  const xOf = (d: number) => padL + (d / profile.length) * PW
  const yOf = (z: number) => padT + (1 - (z - zMin) / (zMax - zMin)) * PH
  let path = ''
  let started = false
  for (const p of profile.tinPts) {
    if (p.z == null) { started = false; continue }
    const cmd = started ? 'L' : 'M'
    path += `${cmd}${xOf(p.d).toFixed(1)},${yOf(p.z).toFixed(1)} `
    started = true
  }
  const yTicks: number[] = []
  const step = (zMax - zMin) / 4
  for (let i = 0; i <= 4; i++) yTicks.push(zMin + step * i)
  return (
    <>
      <div className="px-2 py-0.5 text-[10px] text-slate-500 border-b">
        <span className="font-semibold text-slate-700">{name}</span>
        <span className="ml-2">{direction === 'along' ? '線上' : '直角'} / 距離 {profile.length.toFixed(2)} m / 記録 {profile.recPts.length} 点</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="w-full h-full">
          <rect x={padL} y={padT} width={PW} height={PH} fill="#f8fafc" stroke="#cbd5e1" />
          {yTicks.map((z, i) => (
            <g key={i}>
              <line x1={padL} y1={yOf(z)} x2={padL + PW} y2={yOf(z)} stroke="#e2e8f0" strokeWidth={0.5} />
              <text x={padL - 3} y={yOf(z) + 3} fontSize={8} textAnchor="end" fill="#64748b">{z.toFixed(2)}</text>
            </g>
          ))}
          <text x={padL} y={H - 6} fontSize={8} fill="#64748b">0 m</text>
          <text x={padL + PW} y={H - 6} fontSize={8} textAnchor="end" fill="#64748b">{profile.length.toFixed(1)} m</text>
          <text x={padL + PW / 2} y={H - 6} fontSize={8} textAnchor="middle" fill="#64748b">距離</text>
          {path && <path d={path} fill="none" stroke="#0891b2" strokeWidth={1.5} />}
          {profile.recPts.map((p, i) => (
            <g key={i}>
              <circle cx={xOf(p.d)} cy={yOf(p.z)} r={3} fill="#f97316" stroke="#fff" strokeWidth={1} />
              <text x={xOf(p.d) + 4} y={yOf(p.z) - 4} fontSize={7} fill="#9a3412">{p.name}</text>
            </g>
          ))}
        </svg>
      </div>
    </>
  )
}


// 近接モード（精密誘導）: 地図に替えて自己位置中心のレーダー表示。
// 1m 以内で起動し、10cm 以内では 10cm 幅へ自動でズームイン。
function ProximityGuide({
  dN,
  dE,
  dist,
  accuracy,
  targetName,
  onCancel,
}: {
  dN: number // 北方向の差(m)
  dE: number // 東方向の差(m)
  dist: number // 距離(m)
  accuracy: number | null
  targetName: string
  onCancel: () => void
}) {
  // スケール: 粗(半径1m) / 精(半径10cm)。ヒステリシスでちらつき防止
  const [fine, setFine] = useState(dist <= 0.1)
  useEffect(() => {
    setFine((prev) => (prev ? dist <= 0.12 : dist <= 0.1))
  }, [dist])

  const U = 100 // SVG 上の表示半径（中心 100,100 → 端 100）
  const viewRadiusM = fine ? 0.1 : 1.0
  const unitsPerM = U / viewRadiusM
  // 画面座標: 東→右(+x), 北→上(-y)
  let ex = dE * unitsPerM
  let ey = -dN * unitsPerM
  const r = Math.hypot(ex, ey)
  if (r > U && r > 0) {
    ex = (ex / r) * U
    ey = (ey / r) * U
  }
  const tx = 100 + ex
  const ty = 100 + ey

  const distLabel = dist < 1 ? `${(dist * 100).toFixed(1)} cm` : `${dist.toFixed(3)} m`
  const rings = fine
    ? [
        { rM: 0.1, label: '10cm' },
        { rM: 0.05, label: '5cm' },
      ]
    : [
        { rM: 1.0, label: '1m' },
        { rM: 0.5, label: '50cm' },
      ]

  return (
    <div className="absolute inset-0 z-[1500] bg-black flex flex-col">
      {/* ヘッダ */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-900">
        <div className="text-sm min-w-0 text-slate-200">
          <span className="text-slate-400">近接モード</span>
          <span className="ml-2 font-bold truncate">{targetName}</span>
        </div>
        <button
          onClick={onCancel}
          className="flex items-center gap-1 px-2 py-1 rounded border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 text-xs shrink-0"
        >
          <X className="h-4 w-4" /> 通常表示
        </button>
      </div>

      {/* レーダー（自己位置中心） */}
      <div className="flex-1 flex items-center justify-center p-3 min-h-0">
        <svg
          viewBox="0 0 200 200"
          className="h-full"
          style={{ aspectRatio: '1 / 1', maxWidth: '100%', maxHeight: '100%' }}
        >
          {/* 十字 + 北 */}
          <line x1={100} y1={2} x2={100} y2={198} stroke="#334155" strokeWidth={0.6} />
          <line x1={2} y1={100} x2={198} y2={100} stroke="#334155" strokeWidth={0.6} />
          <text x={100} y={9} fill="#94a3b8" fontSize={6} textAnchor="middle">
            N
          </text>
          {/* 距離リング（最外＝1m/10cm を太く強調 / 内側＝50cm/5cm も視認できる太さに） */}
          {rings.map((ring, idx) => {
            const rr = ring.rM * unitsPerM
            if (rr > U + 0.5) return null
            const primary = idx === 0
            return (
              <g key={ring.label}>
                <circle
                  cx={100}
                  cy={100}
                  r={rr}
                  fill="none"
                  stroke={primary ? '#38bdf8' : '#94a3b8'}
                  strokeWidth={primary ? 2.4 : 1.8}
                />
                <text
                  x={102}
                  y={100 - rr + 7}
                  fill={primary ? '#7dd3fc' : '#cbd5e1'}
                  fontSize={primary ? 8 : 7}
                  fontWeight={primary ? 700 : 600}
                >
                  {ring.label}
                </text>
              </g>
            )
          })}
          {/* 中心→ターゲット線 */}
          <line x1={100} y1={100} x2={tx} y2={ty} stroke="#f97316" strokeWidth={1.2} />
          {/* ターゲット（十字マーカー） */}
          <circle cx={tx} cy={ty} r={5} fill="#f97316" stroke="#000" strokeWidth={1.4} />
          <line x1={tx - 9} y1={ty} x2={tx + 9} y2={ty} stroke="#f97316" strokeWidth={0.8} />
          <line x1={tx} y1={ty - 9} x2={tx} y2={ty + 9} stroke="#f97316" strokeWidth={0.8} />
          {/* 自己位置（中心） */}
          <circle cx={100} cy={100} r={3.5} fill="#3b82f6" stroke="#fff" strokeWidth={1.4} />
        </svg>
      </div>

      {/* 数値表示 */}
      <div className="px-4 pb-3 pt-1 text-center border-t border-slate-700">
        <div className="text-5xl font-mono font-bold tabular-nums text-white">{distLabel}</div>
        <div className="text-xs text-slate-400 mt-1">
          {fine ? '精密モード（10cm 幅）' : '近接モード（1m 幅）'}
          <span className="mx-1">/</span>
          精度 {accuracy != null ? `${(accuracy * 100).toFixed(1)} cm` : '-'}
        </div>
      </div>
    </div>
  )
}

// 新点計測完了モーダル
// 重なりターゲット選択シート。1m 以内に複数のターゲットが集まっている
// 場所をタップしたときに、候補一覧から確実に 1 点を選ばせる。
function OverlapTargetPicker({
  candidates,
  selectedId,
  onPick,
  onCancel,
}: {
  candidates: StakingTarget[]
  selectedId: string | null
  onPick: (id: string) => void
  onCancel: () => void
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]"
      onClick={onCancel}
    >
      <div
        className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b">
          <h3 className="text-base font-bold">重なっている点</h3>
          <div className="text-xs text-slate-500 mt-0.5">
            1m 以内に {candidates.length} 件あります。選んでください。
          </div>
        </div>
        <ul className="max-h-[60vh] overflow-auto">
          {candidates.map((t) => {
            const isCurrent = t.id === selectedId
            return (
              <li key={t.id}>
                <button
                  onClick={() => onPick(t.id)}
                  className={`w-full text-left px-4 py-2.5 border-b last:border-b-0 ${
                    isCurrent ? 'bg-blue-50' : 'hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{t.name}</span>
                    {isCurrent && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-600 text-white">
                        選択中
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
                    {t.subTypeLabel} · X={t.x.toFixed(3)}, Y={t.y.toFixed(3)}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
        <button
          onClick={onCancel}
          className="w-full px-4 py-3 text-sm text-slate-600 border-t hover:bg-slate-50"
        >
          キャンセル
        </button>
      </div>
    </div>
  )
}

function FreePointDialog({
  data,
  typeOptions,
  recentPrefixes,
  existingNames,
  numberingMode,
  onConfirm,
  onCancel,
}: {
  data: {
    defaultName: string
    x: number
    y: number
    z: number | null
    distance: number | null
    accuracy: number
    sampleCount: number
    antennaHeight: number
  }
  typeOptions: { code: string; label: string; builtIn: boolean }[]
  recentPrefixes: string[]
  existingNames: string[]
  numberingMode: NumberingMode
  onConfirm: (name: string, type: string, prefix: string, openPhoto: boolean) => void
  onCancel: () => void
}) {
  const initialPrefix = recentPrefixes[0] ?? '新点'
  const [prefix, setPrefix] = useState(initialPrefix)
  const [name, setName] = useState(() => nextNumberedName(initialPrefix, existingNames, numberingMode))
  // 既定の点種は「現況(current)」。無ければ先頭
  const [type, setType] = useState<string>(
    typeOptions.some((o) => o.code === 'current') ? 'current' : typeOptions[0]?.code ?? 'current',
  )
  // 頭文字を変えたら点名を自動採番し直す
  const applyPrefix = (p: string) => {
    setPrefix(p)
    setName(nextNumberedName(p, existingNames, numberingMode))
  }
  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
      <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-3">
        <h3 className="text-sm font-bold mb-2">新点計測完了</h3>

        {/* 頭文字: ラベル + 入力 + チップ を 1 行に配置 (改行なし・折り返しあり) */}
        <div className="flex items-center gap-1.5 flex-wrap mb-1.5">
          <span className="text-[11px] text-slate-500 shrink-0 w-10">頭文字</span>
          <input
            type="text"
            value={prefix}
            onChange={(e) => applyPrefix(e.target.value)}
            placeholder="道路/As/側溝/境界杭"
            className="w-24 px-1.5 py-1 border rounded text-xs"
          />
          {recentPrefixes.map((p) => (
            <button
              key={p}
              onClick={() => applyPrefix(p)}
              className={`px-1.5 py-0.5 rounded border text-[11px] font-medium ${
                prefix === p
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {p}
            </button>
          ))}
        </div>

        {/* 点名: ラベル + 入力を 1 行に */}
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[11px] text-slate-500 shrink-0 w-10">点名</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 px-1.5 py-1 border rounded text-xs"
          />
        </div>

        {/* 点種: ラベル + プルダウンを 1 行に */}
        <div className="flex items-center gap-1.5 mb-2">
          <span className="text-[11px] text-slate-500 shrink-0 w-10">点種</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="flex-1 px-1.5 py-1 border rounded text-xs bg-white"
          >
            {typeOptions.map((o) => (
              <option key={o.code} value={o.code}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {/* XYZ を横 1 行に */}
        <div className="text-xs font-mono flex gap-3 mb-2 bg-slate-50 rounded px-2 py-1.5">
          <span>X <span className="text-slate-800">{data.x.toFixed(3)}</span></span>
          <span>Y <span className="text-slate-800">{data.y.toFixed(3)}</span></span>
          <span>Z <span className="text-slate-800">{data.z != null ? data.z.toFixed(3) : '-'}</span></span>
        </div>

        <div className="text-[10px] text-slate-600 flex flex-wrap gap-x-3 gap-y-0.5 mb-3">
          <span>
            誤差 <span className="font-mono">{data.distance != null ? `${data.distance.toFixed(3)} m` : '-'}</span>
          </span>
          <span>
            アンテナ高 <span className="font-mono">{data.antennaHeight.toFixed(3)} m</span>
          </span>
          <span>
            精度 <span className="font-mono">{data.accuracy.toFixed(3)} m</span>
          </span>
          <span>
            サンプル <span className="font-mono">{data.sampleCount}</span>
          </span>
        </div>

        {/* OK / カメラ / キャンセル を横 1 列・等幅に */}
        <div className="flex gap-2">
          <button
            onClick={() => onConfirm(name.trim() || data.defaultName, type, prefix, false)}
            disabled={!name.trim()}
            className="flex-1 basis-0 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            OK
          </button>
          <button
            onClick={() => onConfirm(name.trim() || data.defaultName, type, prefix, true)}
            disabled={!name.trim()}
            className="flex-1 basis-0 px-3 py-2 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center"
            title="登録して写真撮影"
          >
            <Camera className="h-4 w-4" />
          </button>
          <button
            onClick={onCancel}
            className="flex-1 basis-0 px-3 py-2 border rounded-lg hover:bg-slate-50 text-xs"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}

// Leaflet 地図の長押し / 右クリック を拾うためだけのレイヤ。
// useMapEvents を使うので MapContainer の子としてレンダーする必要がある。
function MapLongPressHandler({
  onLongPress,
}: {
  onLongPress: (lat: number, lng: number) => void
}) {
  useMapEvents({
    contextmenu(e) {
      onLongPress(e.latlng.lat, e.latlng.lng)
    },
  })
  return null
}

// メモ作成（スマホ）。本文 + 位置のみ。写真は別管理（写真ボタン）。
function MobileMemoCreateModal({
  defaultLat,
  defaultLng,
  onCancel,
  onSave,
}: {
  defaultLat: number | null
  defaultLng: number | null
  onCancel: () => void
  onSave: (data: {
    content: string
    lat: number | null
    lng: number | null
    headingDeg: number | null
  }) => Promise<void>
}) {
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (busy) return
    setBusy(true)
    try {
      await onSave({
        content,
        lat: defaultLat,
        lng: defaultLng,
        headingDeg: null,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]"
      onClick={onCancel}
    >
      <div
        className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold flex items-center gap-2">📓 メモを残す</h3>

        <div className="text-[11px] text-slate-500">
          位置:{' '}
          {defaultLat != null && defaultLng != null
            ? `${defaultLat.toFixed(6)}, ${defaultLng.toFixed(6)}`
            : '取得中／未許可'}
        </div>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={5}
          className="w-full px-2 py-1.5 text-sm border rounded"
          placeholder="現場で気付いたことを書く"
          autoFocus
        />

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={save}
            disabled={busy || content.trim() === ''}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// 座標一覧タブの「手入力」ボタンから開く 1 点追加モーダル。
// 点名 / X / Y / Z / 種類 を入力して useCoordinateStore.importCoordinates に流す。
// 既存の pointNumber と重複したら自動でサフィックスを付ける (P001 → P001_2 等)。
// ============================================================
function ManualCoordEntryModal({
  farmId: _farmId,
  zone,
  existingPointNumbers,
  typeOptions,
  onCancel,
  onSaved,
}: {
  farmId: string
  zone: number
  existingPointNumbers: string[]
  typeOptions: { code: string; label: string; builtIn: boolean }[]
  onCancel: () => void
  onSaved: () => void
}) {
  // 次番の初期値: P001 / P002 ... の最大値 + 1、無ければ P001
  const nextP = useMemo(() => {
    let max = 0
    for (const pn of existingPointNumbers) {
      const m = /^P(\d+)$/.exec(pn)
      if (m) {
        const n = parseInt(m[1], 10)
        if (n > max) max = n
      }
    }
    return `P${String(max + 1).padStart(3, '0')}`
  }, [existingPointNumbers])

  const [pointNumber, setPointNumber] = useState(nextP)
  const [xStr, setXStr] = useState('')
  const [yStr, setYStr] = useState('')
  const [zStr, setZStr] = useState('')
  const [typeCode, setTypeCode] = useState<string>(
    typeOptions.some((o) => o.code === 'current') ? 'current' : typeOptions[0]?.code ?? 'current',
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parseNum = (s: string): number | null => {
    const t = s.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }

  const handleSave = async () => {
    setError(null)
    const trimmedPn = pointNumber.trim()
    if (!trimmedPn) {
      setError('点名を入力してください')
      return
    }
    const x = parseNum(xStr)
    const y = parseNum(yStr)
    if (x === null || y === null) {
      setError('X / Y を数値で入力してください')
      return
    }
    const z = parseNum(zStr) // null OK

    // 点名重複回避
    const existingSet = new Set(existingPointNumbers)
    let finalPn = trimmedPn
    if (existingSet.has(finalPn)) {
      let i = 2
      while (existingSet.has(`${finalPn}_${i}`)) i++
      finalPn = `${finalPn}_${i}`
    }

    setBusy(true)
    try {
      const inserted = await useCoordinateStore.getState().importCoordinates([
        {
          pointNumber: finalPn,
          x,
          y,
          z,
          type: typeCode as unknown as CoordinateRow['type'],
          notes: 'mobile_manual_entry',
        },
      ])
      if (inserted.length === 0) {
        setError(
          useCoordinateStore.getState().error ?? '追加に失敗しました (詳細不明)',
        )
        return
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[3000] bg-black/40 flex items-end sm:items-center justify-center p-3">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <span className="text-sm font-semibold">座標を手入力で追加</span>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-slate-400 hover:text-slate-700 disabled:opacity-50"
            title="閉じる"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-3 space-y-2.5">
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-0.5">点名 *</label>
            <input
              type="text"
              value={pointNumber}
              onChange={(e) => setPointNumber(e.target.value)}
              disabled={busy}
              className="w-full px-2 py-1.5 text-sm border rounded"
              placeholder="例: P001"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">X (m) *</label>
              <input
                type="number"
                inputMode="decimal"
                step="0.001"
                value={xStr}
                onChange={(e) => setXStr(e.target.value)}
                disabled={busy}
                className="w-full px-2 py-1.5 text-sm border rounded font-mono"
                placeholder="12345.678"
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Y (m) *</label>
              <input
                type="number"
                inputMode="decimal"
                step="0.001"
                value={yStr}
                onChange={(e) => setYStr(e.target.value)}
                disabled={busy}
                className="w-full px-2 py-1.5 text-sm border rounded font-mono"
                placeholder="98765.432"
              />
            </div>
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-0.5">Z (m) (任意)</label>
            <input
              type="number"
              inputMode="decimal"
              step="0.001"
              value={zStr}
              onChange={(e) => setZStr(e.target.value)}
              disabled={busy}
              className="w-full px-2 py-1.5 text-sm border rounded font-mono"
              placeholder="標高 (未入力なら null)"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-600 mb-0.5">種類</label>
            <select
              value={typeCode}
              onChange={(e) => setTypeCode(e.target.value)}
              disabled={busy}
              className="w-full px-2 py-1.5 text-sm border rounded bg-white"
            >
              {typeOptions.map((o) => (
                <option key={o.code} value={o.code}>{o.label}</option>
              ))}
            </select>
          </div>

          {error && (
            <div className="flex items-start gap-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-1.5">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}

          <p className="text-[10px] text-slate-500 leading-relaxed">
            X / Y は現在の工区座標系 (系 {zone}) の平面直角座標。緯度経度は自動計算されます。
          </p>
        </div>
        <div className="px-3 py-2 border-t flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={busy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {busy ? '追加中…' : '追加'}
          </button>
        </div>
      </div>
    </div>
  )
}

