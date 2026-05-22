import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, CircleMarker, Polyline, Polygon, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  ArrowLeft,
  ArrowUp,
  Loader2,
  Crosshair,
  Circle as CircleIcon,
  Radio,
  Settings,
  List,
  Save,
  Tag,
  Trash2,
  ChevronDown,
  ChevronRight,
  FileText,
  Database,
  Navigation2,
  Share2,
  Check,
  Filter,
  Camera,
  Car,
  Upload,
  Download,
  ZoomIn,
  Image as ImageIcon,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useUnderdrainStore, type PipeRow, PIPE_TYPE_NAMES } from '@/stores/underdrainStore'
import { useStakingStore, type StakingRecord } from '@/stores/stakingStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { useExportRouteStore, type RoutePoint } from '@/stores/exportRouteStore'
import { useAuth } from '@/contexts/AuthContext'
import { loadSimaFile, downloadSimaFile } from '@/lib/sima-parser'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeLabel,
} from '@/stores/coordinatePointTypeStore'
import { CoordinatePhotoModal } from '@/features/coordinates/CoordinatePhotoModal'
import { useAttachmentStore } from '@/stores/attachmentStore'
import { useOrthophotoStore } from '@/stores/orthophotoStore'
import { parseLandXml } from '@/lib/landxml/parser'
import { indexTin, queryZ, type TinIndex, type TinSurfaceLike } from '@/lib/landxml/tinInterpolation'
import { buildTrenchTin } from '@/lib/landxml/surface'
import type { Alignment, AlignmentSegment } from '@/lib/landxml/types'
import type { Project } from '@/types/database'

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

// ターゲット動的ズーム
// ターゲットを画面中心に置き、現在地も視野に収まるよう自動でズームを調整する。
// ターゲットに近づくほど拡大され、概略誘導 → 精密誘導の連続的な体験を実現する。
function DynamicTargetZoom({
  target,
  currentPos,
  enabled,
}: {
  target: { id: string; lat: number; lng: number } | null
  currentPos: [number, number] | null
  enabled: boolean
}) {
  const map = useMap()
  const lastZoomRef = useRef<number | null>(null)
  useEffect(() => {
    if (!enabled || !target) return
    const targetLL = L.latLng(target.lat, target.lng)
    let desiredZoom: number
    if (currentPos) {
      const curLL = L.latLng(currentPos[0], currentPos[1])
      const distance = targetLL.distanceTo(curLL) // meters
      const size = map.getSize()
      const halfMinDim = Math.max(40, Math.min(size.x, size.y) / 2 - 24) // 24px の余白
      if (distance < 0.5) {
        desiredZoom = 22
      } else {
        const metersPerPixelAtZ0 =
          156543.03392 * Math.cos((target.lat * Math.PI) / 180)
        const z = Math.floor(
          Math.log2((metersPerPixelAtZ0 * halfMinDim) / distance),
        )
        desiredZoom = Math.max(15, Math.min(22, z))
      }
    } else {
      desiredZoom = 19
    }
    // 1 ズーム以上変わるとき、または最初のときだけ setView でズームを反映
    const cur = map.getZoom()
    if (lastZoomRef.current == null || Math.abs(cur - desiredZoom) >= 1) {
      map.setView(targetLL, desiredZoom, { animate: true })
      lastZoomRef.current = desiredZoom
    } else {
      // ズームは変えずに中心だけターゲットへ寄せる（動きを抑える）
      map.panTo(targetLL, { animate: true })
    }
  }, [map, enabled, target, currentPos])
  return null
}

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
  const { setZone, fetchCoordinates, coordinates, importCoordinates } = useCoordinateStore()
  const {
    byEntity: attachmentsByEntity,
    fetchByEntityIds: fetchAttachments,
  } = useAttachmentStore()
  const {
    byFarm: orthoByFarm,
    fetchByFarm: fetchOrthos,
    tileUrlTemplate: getOrthoUrl,
  } = useOrthophotoStore()
  const { fetchPipes, pipes } = useUnderdrainStore()
  const { records, fetchRecords, addRecord, deleteRecord, saving } = useStakingStore()
  const { user } = useAuth()
  const userLabel = user?.email ? user.email.split('@')[0] : ''

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
  // ジオイド補正の有効化
  const [useGeoidCorrection, setUseGeoidCorrection] = useState<boolean>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('rtk:useGeoid') : null
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    try { localStorage.setItem('rtk:useGeoid', useGeoidCorrection ? '1' : '0') } catch { /* ignore */ }
  }, [useGeoidCorrection])
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
  const [showRecordList, setShowRecordList] = useState(false)
  const [targetFilter, setTargetFilter] = useState<
    'all' | 'coordinate' | 'pipe_vertex' | 'route'
  >('all')
  // 非表示にする点種コードの集合（地図マーカー＆リスト両方に効く）
  const [hiddenSubTypes, setHiddenSubTypes] = useState<Set<string>>(new Set())
  // フィルタパネル（点種チップ＋種別ボタン）の表示
  const [showFilterPanel, setShowFilterPanel] = useState(false)
  // 写真モーダル: 選択中ターゲット（座標）の写真を閲覧／撮影できる
  const [photoModalTarget, setPhotoModalTarget] = useState<StakingTarget | null>(null)
  const [showLabels, setShowLabels] = useState(true)
  // 地番名ラベル（境界測量ポリゴンの上に表示）。既定 OFF、低ズーム時は自動 OFF。
  const [showParcelLabels, setShowParcelLabels] = useState(false)
  const [showOrtho, setShowOrtho] = useState(true)
  const PARCEL_LABEL_MIN_ZOOM = 17
  // ターゲット動的ズーム（ターゲットを中心にして、現在地も視野に収まるよう自動拡大縮小）
  const [dynamicZoom, setDynamicZoom] = useState(false)
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
  // 点数が多いとラベル描画が重くなるため、低ズーム時は自動で非表示にする
  const [mapZoom, setMapZoom] = useState(17)
  const LABEL_MIN_ZOOM = 18
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

  // 測設成功とみなす許容半径（m）
  const STAKE_TOLERANCE_M = 0.20

  // 選択中ターゲット
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null)
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
    resolve: () => void
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
  const recSamplesRef = useRef<Array<{ lat: number; lng: number; alt: number | null; acc: number | null }>>([])
  const recTimerRef = useRef<number | null>(null)
  const recCleanupRef = useRef<(() => void) | null>(null)
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
  }, [farmId, setCurrentFarm, setZone, fetchCoordinates, fetchPipes, fetchRecords])

  // 座標が読み込まれたら、写真の枚数を一括取得（カメラボタンのバッジ表示用）
  useEffect(() => {
    if (coordinates.length === 0) return
    fetchAttachments('coordinate', coordinates.map((c) => c.id))
  }, [coordinates, fetchAttachments])

  // 工事区域ポリゴン（境界測量含む）を取得
  useEffect(() => {
    if (farmId) fetchWorkAreaPolygons()
  }, [farmId, fetchWorkAreaPolygons])

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

  // 現在位置の監視
  useEffect(() => {
    if (!('geolocation' in navigator)) return
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const ll: [number, number] = [pos.coords.latitude, pos.coords.longitude]
        setCurrentPos(ll)
        setCurrentAcc(pos.coords.accuracy)
        setCurrentAlt(pos.coords.altitude)
        // FIX相当の精度のときだけ追従用の安定位置を更新（外れたら据え置き）
        if (pos.coords.accuracy != null && pos.coords.accuracy <= FOLLOW_FIX_THRESHOLD_M) {
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

  const handleLoadXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setDataError(null)
    try {
      const text = await file.text()
      const result = parseLandXml(text, file.name)
      const trenchSurf = result.surfaces.find((s) => /trench|床掘|excav/i.test(s.name)) ?? result.surfaces[0] ?? null
      const groundSurf = result.surfaces.find((s) => /ground|現況|terrain/i.test(s.name)) ?? null
      setAlignmentLines(buildAlignmentLines(result.alignments, converter))
      setTrenchSurface(trenchSurf)
      setGroundSurface(groundSurf)
      setDataSourceLabel(`LandXML: ${file.name}`)
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'LandXML 読込エラー')
    } finally {
      e.target.value = ''
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

  // 自己標高（補正後）— 既存の計算ロジックをここで再利用
  const selfElevation = useMemo<number | null>(() => {
    if (currentAlt === null || currentPos === null) return null
    if (useGeoidCorrection && geoidGrid) {
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
        if (Number.isFinite(N)) return currentAlt - N - antennaHeight
      }
    }
    return currentAlt - antennaHeight
  }, [currentAlt, currentPos, useGeoidCorrection, geoidGrid, antennaHeight])

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
      })
    }
    for (const pipe of pipes as PipeRow[]) {
      // 暗渠頂点は点種（基準点/外周点/現況）と並列で扱うため、管種別ではなく
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
    if (hiddenSubTypes.size === 0) return base
    return base.filter((t) => !hiddenSubTypes.has(t.subType))
  }, [orderedTargets, routeTargetIds, targetFilter, hiddenSubTypes])

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
    recSamplesRef.current = []
    setRecordedCount(0)
    recForceFreeRef.current = !!opts.forceFreePoint
    setRecording(true)

    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        recSamplesRef.current.push({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          alt: pos.coords.altitude,
          acc: pos.coords.accuracy,
        })
        setRecordedCount(recSamplesRef.current.length)
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
    }
    recTimerRef.current = window.setTimeout(() => {
      finishRecording()
    }, avgSeconds * 1000)
  }

  // 記録終了・保存
  const finishRecording = async () => {
    if (recTimerRef.current != null) {
      window.clearTimeout(recTimerRef.current)
      recTimerRef.current = null
    }
    if (recCleanupRef.current) {
      recCleanupRef.current()
      recCleanupRef.current = null
    }
    const samples = recSamplesRef.current
    setRecording(false)
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
    let geoidN: number | null = null
    if (useGeoidCorrection && geoidGrid) {
      const { lookupGeoid } = await import('@/lib/geoid')
      geoidN = lookupGeoid(geoidGrid, avgLat, avgLng)
    }
    const avgAlt = rawEllipsoidal !== null
      ? (geoidN !== null ? rawEllipsoidal - geoidN - antennaHeight : rawEllipsoidal - antennaHeight)
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
      // 測設記録の点名: 元の点名に "G" を前置。
      // 同じターゲット（farmId + surveyCategory + targetRefId + vertexIndex）に対する
      // 記録が既にある場合は "_2", "_3" ... を末尾に付与する。
      const base = `G${selectedTarget.name}`
      const existing = records.filter(
        (r) =>
          r.farmId === farmId &&
          r.surveyCategory === surveyCategory &&
          r.targetType === selectedTarget.kind &&
          r.targetRefId === selectedTarget.refId &&
          r.targetVertexIndex === selectedTarget.vertexIndex,
      ).length
      const stakeRecordName = existing === 0 ? base : `${base}_${existing + 1}`

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
        const msg =
          `${stakeRecordName} を測設しました（ターゲット: ${selectedTarget.name}）\n` +
          `誤差 ${dist.toFixed(3)} m / 精度 ${maxAcc.toFixed(3)} m / ${samples.length} サンプル`
        // 結果モーダルを開いて OK を待つ（OK の上に「写真撮影」ボタンも表示）
        await new Promise<void>((resolve) => {
          setPostStakeDialog({ message: msg, target: selectedTarget, resolve })
        })
        const idx = filteredTargets.findIndex((t) => t.id === selectedTarget.id)
        const next = idx >= 0 ? filteredTargets[idx + 1] : null
        setSelectedTargetId(next?.id ?? null)
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
      antennaHeight,
    })
  }

  // 新点モーダルからの確定処理（OK or 写真撮影）
  const handleFreePointConfirm = async (name: string, openPhoto: boolean) => {
    const d = freePointDialog
    if (!d || !farmId) return
    setFreePointDialog(null)
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
    // 座標管理に 現況点 として登録（重複点番号があればスキップ）
    const exists = coordinates.some((c) => c.pointNumber === name)
    let createdId: string | null = null
    if (!exists) {
      try {
        const inserted = await importCoordinates([
          {
            pointNumber: name,
            x: d.x,
            y: d.y,
            z: d.z,
            type: 'current' as unknown as CoordinateRow['type'],
          },
        ])
        if (inserted.length > 0) createdId = inserted[0].id
      } catch {
        // 座標登録失敗は致命ではない
      }
    } else {
      const hit = coordinates.find((c) => c.pointNumber === name)
      createdId = hit?.id ?? null
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
        subType: 'current',
        subTypeLabel: '現況',
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
    if (recCleanupRef.current) {
      recCleanupRef.current()
      recCleanupRef.current = null
    }
    recSamplesRef.current = []
    setRecordedCount(0)
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
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
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
      {/* ヘッダー（1 行目: 戻る・工事名・工区名・ユーザー名） */}
      <div className="px-2 py-1.5 bg-slate-800 text-white flex items-center gap-2 text-sm">
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
        {/* 道案内（Google マップ） — 工区の中心座標へ */}
        <button
          onClick={() => {
            // 座標の平均位置を目的地とする
            const locs = coordinates.filter(
              (c): c is typeof c & { lat: number; lng: number } =>
                c.lat != null && c.lng != null,
            )
            if (locs.length === 0) {
              alert('工区の位置情報が取得できません')
              return
            }
            const lat = locs.reduce((s, l) => s + l.lat, 0) / locs.length
            const lng = locs.reduce((s, l) => s + l.lng, 0) / locs.length
            window.open(
              `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`,
              '_blank',
            )
          }}
          className="p-1.5 rounded hover:bg-slate-700"
          title="道案内（Google マップ）"
        >
          <Car className="h-4 w-4" />
        </button>
        {userLabel && (
          <span className="text-[11px] text-slate-300 truncate max-w-[6rem]" title={user?.email ?? ''}>
            {userLabel}
          </span>
        )}
      </div>
      {/* ヘッダー（2 行目: ツールボタン群） */}
      <div className="px-2 py-1.5 bg-slate-800 text-white flex items-center gap-2 text-sm border-t border-slate-700">
        <button
          onClick={() => setFollowMode((m) => NEXT_FOLLOW_MODE[m])}
          className={`flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium ${
            followMode === 'self'
              ? 'bg-blue-600'
              : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title={`地図表示モード: ${MAP_FOLLOW_LABEL[followMode]}（クリックで切替）`}
        >
          <Crosshair className="h-4 w-4" />
          <span className="hidden sm:inline">{MAP_FOLLOW_LABEL[followMode]}</span>
        </button>
        <button
          onClick={() => setDynamicZoom((v) => !v)}
          className={`p-1.5 rounded ${
            dynamicZoom ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="ターゲット動的ズーム（ON: ターゲットを中心に距離に応じて自動拡大）"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
        {farmOrthos.length > 0 && (
          <button
            onClick={() => setShowOrtho((v) => !v)}
            className={`p-1.5 rounded ${
              showOrtho ? 'bg-emerald-600' : 'bg-slate-700 hover:bg-slate-600'
            }`}
            title="オルソ画像の表示を切替"
          >
            <ImageIcon className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={toggleHeading}
          className={`p-1.5 rounded ${
            headingEnabled
              ? heading != null
                ? 'bg-emerald-600'
                : 'bg-amber-600'
              : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title={
            headingError
              ? `方位エラー: ${headingError}`
              : headingEnabled
              ? heading != null
                ? `方位 ${heading.toFixed(0)}°（クリックでOFF）`
                : '方位センサー待機中'
              : '方位センサーをON'
          }
        >
          <Navigation2 className="h-4 w-4" />
        </button>
        <button
          onClick={() => setShowLabels((v) => !v)}
          className={`p-1.5 rounded ${
            showLabels ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="点名表示"
        >
          <Tag className="h-4 w-4" />
        </button>
        <button
          onClick={() => setShowParcelLabels((v) => !v)}
          className={`p-1.5 rounded text-[10px] font-bold w-7 flex items-center justify-center ${
            showParcelLabels ? 'bg-blue-600' : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title={`地番名表示（ズーム ${PARCEL_LABEL_MIN_ZOOM} 以上で有効）`}
        >
          地
        </button>
        <button
          onClick={() => setShowFilterPanel((v) => !v)}
          className={`p-1.5 rounded relative ${
            showFilterPanel || hiddenSubTypes.size > 0 || targetFilter !== 'all'
              ? 'bg-blue-600'
              : 'bg-slate-700 hover:bg-slate-600'
          }`}
          title="点種フィルタ"
        >
          <Filter className="h-4 w-4" />
          {(hiddenSubTypes.size > 0 || targetFilter !== 'all') && (
            <span className="absolute -top-1 -right-1 bg-amber-400 w-2 h-2 rounded-full" />
          )}
        </button>
        <button
          onClick={() => setShowRecordList((v) => !v)}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600 relative"
          title="記録一覧"
        >
          <List className="h-4 w-4" />
          {records.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] rounded-full w-4 h-4 flex items-center justify-center">
              {records.length > 9 ? '9+' : records.length}
            </span>
          )}
        </button>
        <button
          onClick={handleOpenSimImport}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600"
          title="SIMA インポート"
        >
          <Download className="h-4 w-4" />
        </button>
        <button
          onClick={handleSimExport}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600"
          title="SIMA エクスポート"
        >
          <Upload className="h-4 w-4" />
        </button>
        <button
          onClick={handleShare}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600"
          title="共有リンクを発行（他社にLINE等で送信）"
        >
          <Share2 className="h-4 w-4" />
        </button>
        <button
          onClick={() => setShowSettings((v) => !v)}
          className="p-1.5 rounded bg-slate-700 hover:bg-slate-600"
          title="設定"
        >
          <Settings className="h-4 w-4" />
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
      {/* 写真モーダル（撮影・閲覧） */}
      {photoModalTarget && farm?.project_id && (
        <CoordinatePhotoModal
          open={!!photoModalTarget}
          onClose={() => setPhotoModalTarget(null)}
          projectId={farm.project_id}
          coordinateId={photoModalTarget.refId}
          pointNumber={photoModalTarget.name}
        />
      )}
      {/* 新点計測完了モーダル */}
      {freePointDialog && (
        <FreePointDialog
          data={freePointDialog}
          onConfirm={handleFreePointConfirm}
          onCancel={() => setFreePointDialog(null)}
        />
      )}
      {/* 測設完了モーダル（OK の上に写真撮影ボタン） */}
      {postStakeDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
          <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4">
            <h3 className="text-base font-bold mb-2">測設完了</h3>
            <p className="text-sm text-slate-700 whitespace-pre-line mb-4">
              {postStakeDialog.message}
            </p>
            <div className="space-y-2">
              {postStakeDialog.target.kind === 'coordinate' && (
                <button
                  onClick={() => {
                    // 写真モーダルを開く（測設モーダルは閉じる）
                    const t = postStakeDialog.target
                    postStakeDialog.resolve()
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
                  postStakeDialog.resolve()
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

      {/* 点種フィルタ（ヘッダの Filter アイコンで開閉）
          基準点 / 外周点 / 現況 / 暗渠頂点（あれば）を並列で表示 */}
      {showFilterPanel && (
        <div className="bg-white border-b">
          <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap text-[11px]">
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
                  className={`px-1.5 py-0.5 rounded border font-medium ${hidden ? offCls : onCls}`}
                >
                  {s.label}
                  <span className="ml-1 text-[10px] opacity-80">({s.count})</span>
                </button>
              )
            })}
            {/* ルート絞り込み（順路が登録済みの工区でのみ表示） */}
            {routeTargetIds.size > 0 && (
              <button
                onClick={() =>
                  setTargetFilter((prev) => (prev === 'route' ? 'all' : 'route'))
                }
                className={`px-1.5 py-0.5 rounded border font-medium ml-1 ${
                  targetFilter === 'route'
                    ? 'bg-orange-600 text-white border-orange-600'
                    : 'bg-white text-orange-700 border-orange-400'
                }`}
              >
                ルート ({routeTargetIds.size})
              </button>
            )}
            {hiddenSubTypes.size > 0 && (
              <button
                onClick={() => setHiddenSubTypes(new Set())}
                className="ml-1 px-1.5 py-0.5 text-slate-600 hover:text-slate-900 underline"
              >
                全て表示
              </button>
            )}
          </div>
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
        <MapContainer
          center={mapCenter}
          zoom={17}
          maxZoom={24}
          className="h-full w-full"
          style={baseLayer === 'none' ? { background: '#ffffff' } : undefined}
        >
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
          <FollowCurrent position={stablePos} enabled={followMode === 'self' && !dynamicZoom} />
          <ZoomWatcher onChange={setMapZoom} />
          {/* ターゲット選択時はモードに関わらず 1 度だけ中心化（継続的な追尾はしない）
              動的ズーム時は DynamicTargetZoom 側で都度設定するためスキップ */}
          {!dynamicZoom && (
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
          )}
          {/* ターゲット動的ズーム（ON 時のみ） */}
          <DynamicTargetZoom
            enabled={dynamicZoom}
            target={
              selectedTarget
                ? {
                    id: selectedTarget.id,
                    lat: selectedTarget.lat,
                    lng: selectedTarget.lng,
                  }
                : null
            }
            currentPos={stablePos}
          />

          {/* 工事区域ポリゴン（境界測量=シアン 等） */}
          {farmPolygons.map((polygon) => {
            const color =
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
            return (
              <Polygon
                key={polygon.id}
                positions={polygon.positions}
                pathOptions={{
                  color,
                  fillColor: color,
                  fillOpacity: 0.18,
                  weight: 2,
                }}
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

          {/* ターゲット */}
          {filteredTargets.map((t) => {
            const isSelected = t.id === selectedTargetId
            const isStaked = stakedTargetIds.has(t.id)
            // 色: 選択中 = オレンジ、座標は点種で色分け、暗渠頂点 = 緑
            //   基準点(control) = 赤、外周点(boundary) = シアン、現況(current) = 青、その他 = 灰
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
                  click: () => setSelectedTargetId(t.id),
                }}
              >
                <Tooltip
                  key={`tip-${showLabels && mapZoom >= LABEL_MIN_ZOOM ? 'on' : 'off'}-${isStaked ? 'st' : 'no'}-${isSelected ? 'sel' : 'norm'}`}
                  className="staking-label-tooltip"
                  direction="top"
                  offset={[0, -6]}
                  permanent={showLabels && mapZoom >= LABEL_MIN_ZOOM}
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
              </Marker>
            )
          })}

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
              <CircleMarker
                center={currentPos}
                radius={6}
                pathOptions={{
                  color: accuracyColor(currentAcc),
                  fillColor: '#2563eb',
                  fillOpacity: 1,
                  weight: 2,
                }}
              />
            </>
          )}

          {/* 施工管理：床掘 TIN の三角形エッジ */}
          {screenMode === 'construction' && trenchEdges.map((tri, i) => (
            <Polyline
              key={`trench-${i}`}
              positions={tri}
              pathOptions={{ color: '#06b6d4', weight: 0.5, opacity: 0.5 }}
            />
          ))}

          {/* 施工管理：中心線形 */}
          {screenMode === 'construction' && alignmentLines.map((line, i) => (
            <Polyline
              key={`align-${i}`}
              positions={line}
              pathOptions={{ color: '#1d4ed8', weight: 3, opacity: 0.9 }}
            />
          ))}
        </MapContainer>

        {/* ベースレイヤ切替（地理院の各種タイル + 背景なし） */}
        <div className="absolute bottom-2 right-2 z-[1000] bg-white/95 border rounded shadow text-xs">
          <select
            value={baseLayer}
            onChange={(e) => setBaseLayer(e.target.value as BaseLayerKey)}
            className="px-2 py-1 bg-transparent outline-none"
            title="背景レイヤ"
          >
            {(Object.entries(BASE_LAYERS) as [BaseLayerKey, typeof currentBase][]).map(
              ([key, info]) => (
                <option key={key} value={key}>
                  {info.label}
                </option>
              ),
            )}
          </select>
        </div>

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
        {showSettings && (
          <div className="absolute top-2 right-2 z-[1000] bg-white border rounded-lg shadow-lg p-3 w-64 text-sm">
            <div className="font-semibold mb-2">設定</div>
            <label className="flex flex-col gap-1 mb-3">
              <span className="text-xs text-slate-600">平均秒数</span>
              <input
                type="range"
                min={1}
                max={10}
                step={1}
                value={avgSeconds}
                onChange={(e) => setAvgSeconds(parseInt(e.target.value, 10))}
                disabled={recording}
              />
              <span className="font-mono text-center">{avgSeconds} 秒</span>
            </label>

            <label className="flex flex-col gap-1 mb-3">
              <span className="text-xs text-slate-600">アンテナ高 (m)</span>
              <input
                type="number"
                step={0.01}
                value={antennaHeight}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  if (Number.isFinite(n)) setAntennaHeight(n)
                }}
                disabled={recording}
                className="w-full px-2 py-1 border rounded text-right font-mono"
              />
            </label>

            <label className="flex items-center gap-2 mb-2">
              <input
                type="checkbox"
                checked={useGeoidCorrection}
                onChange={(e) => setUseGeoidCorrection(e.target.checked)}
                disabled={recording}
              />
              <span className="text-xs">ジオイド補正を有効化</span>
            </label>
            {useGeoidCorrection && (
              <div className="text-[11px] text-slate-500 mb-2">
                {geoidLoading && '読込中…'}
                {!geoidLoading && geoidGrid && '✓ JPGEO2024 読込済み'}
                {!geoidLoading && geoidError && <span className="text-red-600">エラー: {geoidError}</span>}
              </div>
            )}

            <div className="text-[11px] text-slate-500 mb-2">
              標高 = 楕円体高 − ジオイド高 − アンテナ高
            </div>

            <div className="text-xs text-slate-500 border-t pt-2">
              Mock Location 経由で RTK-GNSS の補正座標を取得できます。
            </div>
            <button
              onClick={() => setShowSettings(false)}
              className="mt-2 w-full px-2 py-1 text-xs border rounded hover:bg-slate-50"
            >
              閉じる
            </button>
          </div>
        )}

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

        {/* 記録リスト */}
        {showRecordList && (() => {
          const filtered = records.filter((r) => r.surveyCategory === surveyCategory)
          return (
            <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[60%] flex flex-col">
              <div className="px-3 py-2 border-b flex items-center gap-2 text-sm">
                <span className="font-semibold">
                  {surveyCategory === 'initial' ? '起工測量' : '出来形測量'} 記録
                </span>
                <span className="text-xs text-slate-500">{filtered.length} 件</span>
                <button
                  onClick={() => setShowRecordList(false)}
                  className="ml-auto text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
                >
                  閉じる
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                {filtered.length === 0 ? (
                  <div className="p-4 text-center text-xs text-slate-400">記録なし</div>
                ) : (
                  <RecordList records={filtered} onDelete={deleteRecord} saving={saving} />
                )}
              </div>
            </div>
          )
        })()}
      </div>

      {/* 下部パネル（施工管理モードでは非表示） */}
      {screenMode !== 'construction' && (
      <div className="border-t bg-white px-3 py-2 text-sm">
        {selectedTarget ? (
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowTargetList(true)}
              className="flex-1 min-w-0 text-left"
              title="ターゲット切替"
            >
              <div className="text-xs text-slate-500">ターゲット</div>
              <div className="font-bold truncate">
                {selectedTarget.name}
                <span className="ml-2 text-xs text-slate-500 font-normal">
                  {selectedTarget.kind === 'coordinate' ? '座標' : '暗渠頂点'}
                </span>
              </div>
            </button>
            {distanceToTarget != null && bearingToTarget != null && (
              <div className="flex items-center gap-2">
                {/* 矢印（北を 0° として時計回りに回転） */}
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
        ) : (
          <button
            onClick={() => setShowTargetList(true)}
            className="w-full py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            ターゲットを選択
          </button>
        )}

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
                    let H: number | null = null
                    if (currentPos && useGeoidCorrection && geoidGrid) {
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
                        if (Number.isFinite(N)) H = currentAlt - N - antennaHeight
                      }
                    } else if (currentPos) {
                      H = currentAlt - antennaHeight
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

        {/* 記録ボタン */}
        <div className="mt-2 flex gap-2">
          {!recording ? (
            <>
              <button
                onClick={() => startRecording()}
                disabled={saving || !currentPos}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed font-bold"
              >
                <CircleIcon className="h-5 w-5" />
                記録 ({avgSeconds} 秒平均)
              </button>
              {selectedTarget && (() => {
                const isStaked = stakedTargetIds.has(selectedTarget.id)
                const photoCount =
                  selectedTarget.kind === 'coordinate'
                    ? (attachmentsByEntity.get(`coordinate:${selectedTarget.refId}`)?.length ?? 0)
                    : 0
                return (
                  <>
                    {selectedTarget.kind === 'coordinate' && (
                      <button
                        onClick={handleOpenPhotoModal}
                        className="relative px-3 py-3 rounded-lg font-bold bg-blue-600 text-white hover:bg-blue-700"
                        title="写真（撮影・閲覧）"
                      >
                        <Camera className="h-5 w-5" />
                        {photoCount > 0 && (
                          <span className="absolute -top-1 -right-1 bg-amber-400 text-slate-900 text-[10px] font-bold rounded-full min-w-[16px] h-4 px-1 flex items-center justify-center">
                            {photoCount > 99 ? '99+' : photoCount}
                          </span>
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => handleToggleManualStaked(selectedTarget)}
                      disabled={saving}
                      className={`px-3 py-3 rounded-lg font-bold disabled:opacity-50 ${
                        isStaked
                          ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                      }`}
                      title={isStaked ? '測設済（タップで解除）' : '記録せず測設済としてマーク'}
                    >
                      <Check className="h-5 w-5" />
                    </button>
                  </>
                )
              })()}
            </>
          ) : (
            <>
              <div className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-amber-500 text-white rounded-lg font-bold">
                <Loader2 className="h-5 w-5 animate-spin" />
                記録中… {recordedCount} サンプル
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
      </div>
      )}
    </div>
  )
}

function RecordList({
  records,
  onDelete,
  saving,
}: {
  records: StakingRecord[]
  onDelete: (id: string) => Promise<void>
  saving: boolean
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  return (
    <ul className="divide-y text-sm">
      {records.map((r) => {
        const diff =
          r.targetX != null && r.targetY != null
            ? Math.hypot(r.measuredX - r.targetX, r.measuredY - r.targetY)
            : null
        const isOpen = expanded.has(r.id)
        return (
          <li key={r.id} className="px-3 py-2">
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  setExpanded((s) => {
                    const n = new Set(s)
                    if (n.has(r.id)) n.delete(r.id)
                    else n.add(r.id)
                    return n
                  })
                }
                className="p-0.5"
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
              </button>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate">
                  {r.targetName ?? '(フリー記録)'}
                </div>
                <div className="text-[11px] text-slate-500">
                  {new Date(r.recordedAt).toLocaleString('ja-JP')}
                  {r.accuracy != null && ` · 精度 ${r.accuracy.toFixed(3)}m`}
                  {r.sampleCount != null && ` · ${r.sampleCount}samples`}
                </div>
              </div>
              {diff != null && (
                <span className="text-xs font-mono text-slate-700 w-16 text-right">
                  Δ{diff < 1 ? `${(diff * 100).toFixed(0)}cm` : `${diff.toFixed(2)}m`}
                </span>
              )}
              <button
                onClick={() => {
                  if (confirm('この記録を削除しますか？')) onDelete(r.id)
                }}
                disabled={saving}
                className="p-1 text-slate-400 hover:text-red-500 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {isOpen && (
              <div className="mt-1 ml-5 text-[11px] text-slate-600 font-mono space-y-0.5">
                {r.targetX != null && (
                  <div>
                    目標: X={r.targetX.toFixed(3)}, Y={r.targetY?.toFixed(3)}
                    {r.targetZ != null && `, Z=${r.targetZ.toFixed(3)}`}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <Save className="h-3 w-3" />
                  実測: X={r.measuredX.toFixed(3)}, Y={r.measuredY.toFixed(3)}
                  {r.measuredZ != null && `, Z=${r.measuredZ.toFixed(3)}`}
                </div>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// 新点計測完了モーダル
function FreePointDialog({
  data,
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
  onConfirm: (name: string, openPhoto: boolean) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(data.defaultName)
  return (
    <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
      <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4">
        <h3 className="text-base font-bold mb-3">新点計測完了</h3>

        <label className="block text-xs text-slate-500 mb-1">点名</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2 py-1.5 border rounded text-sm mb-3"
          autoFocus
        />

        <div className="text-sm font-mono space-y-1 mb-3 bg-slate-50 rounded p-2">
          <div>X = <span className="text-slate-800">{data.x.toFixed(3)}</span></div>
          <div>Y = <span className="text-slate-800">{data.y.toFixed(3)}</span></div>
          <div>Z = <span className="text-slate-800">{data.z != null ? data.z.toFixed(3) : '-'}</span></div>
        </div>

        <div className="text-[11px] text-slate-600 flex flex-wrap gap-x-3 gap-y-0.5 mb-4">
          <span>
            誤差 = <span className="font-mono">{data.distance != null ? `${data.distance.toFixed(3)} m` : '-'}</span>
          </span>
          <span>
            アンテナ高 = <span className="font-mono">{data.antennaHeight.toFixed(3)} m</span>
          </span>
          <span>
            精度 = <span className="font-mono">{data.accuracy.toFixed(3)} m</span>
          </span>
          <span>
            サンプル = <span className="font-mono">{data.sampleCount}</span>
          </span>
        </div>

        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => onConfirm(name.trim() || data.defaultName, false)}
              disabled={!name.trim()}
              className="flex-1 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              OK
            </button>
            <button
              onClick={() => onConfirm(name.trim() || data.defaultName, true)}
              disabled={!name.trim()}
              className="px-4 py-2.5 bg-slate-700 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 flex items-center justify-center"
              title="登録して写真撮影"
            >
              <Camera className="h-5 w-5" />
            </button>
          </div>
          <button
            onClick={onCancel}
            className="w-full px-4 py-2 border rounded-lg hover:bg-slate-50 text-sm"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}

