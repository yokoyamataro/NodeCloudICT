import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polygon, Polyline, useMap, useMapEvents, Tooltip, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useCoordinateStore, type CoordinateRow, type RoutePoint } from '@/stores/coordinateStore'
import { useMapViewStore } from '@/stores/mapViewStore'
import { useOrthophotoStore } from '@/stores/orthophotoStore'

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

// 座標種類ごとのマーカー色（既定の組み込み点種に対する色割当て）。
// 一目で点種が見分けられるよう、グレーフォールバックに頼らないで色を当てる。
const MARKER_COLORS: Record<string, string> = {
  // 土木の基本 3 種
  control: '#ef4444',           // 基準点: 赤
  boundary: '#3b82f6',          // 境界点: 青
  current: '#14b8a6',           // 現況: ティール

  // 暗渠 / 客土 / 起工測点
  underdrain: '#22c55e',        // 暗渠構成点: 緑
  soil_import: '#f59e0b',       // 客土構成点: オレンジ
  stake: '#22c55e',             // 測点: 緑（暗渠構成点と同じ）

  // 地籍測量
  map_xml: '#a855f7',           // 地図XML: 紫
  national_survey: '#d97706',   // 国調成果: ダークオレンジ
  cadastral_diagram: '#0891b2', // 地積測量図: シアン
  witness: '#eab308',           // 立会点: 黄
  confirmed_boundary: '#16a34a',// 確定筆界点: 深緑
  measured: '#ec4899',          // 実測点: ピンク
}

// カスタムマーカーアイコンを作成。
//   isSelected: 単一選択時に太い青枠で強調
//   isChecked : 複数選択（チェックボックス系）でスカイブルーのハロー（外側リング）を出す
function createColoredIcon(
  color: string,
  isSelected: boolean = false,
  isChecked: boolean = false,
): L.DivIcon {
  const size = isSelected ? 16 : 12
  const borderWidth = isSelected ? 3 : 2
  // チェック中はマーカーの外周にスカイブルーのハロー（4px のアウターリング）を出す。
  // box-shadow を 2 段重ねて、内側の白縁とは別の色で目立たせる。
  const checkedHalo = isChecked
    ? `0 0 0 4px #38bdf8, 0 0 0 5px rgba(255,255,255,0.9), 0 2px 4px rgba(0,0,0,0.3)`
    : `0 2px 4px rgba(0,0,0,0.3)`
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${color};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      border: ${borderWidth}px solid ${isSelected ? '#1d4ed8' : 'white'};
      box-shadow: ${checkedHalo};
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 工区写真のマーカーアイコン。SVG カメラ + 撮影方向の「視野コーン」を一体で描く。
// heading（0=北, 90=東 ...）が指定されていれば半透明の三角錐で「撮影方向」を表示。
// 全体を SVG で組むことで、emoji や絵文字に依存せず端末横断で同じ見た目になる。
export function createPhotoIcon(headingDeg: number | null): L.DivIcon {
  const cone =
    headingDeg == null
      ? ''
      : `
        <g transform="rotate(${headingDeg})">
          <polygon points="0,-28 -14,-9 14,-9"
            fill="rgba(37, 99, 235, 0.4)"
            stroke="rgba(37, 99, 235, 0.8)"
            stroke-width="1"
            stroke-linejoin="round" />
        </g>
      `
  // 中央 (0,0) に置いたカメラ本体 (rect) + 上の Hot shoe + レンズ (二重円)
  return L.divIcon({
    className: 'photo-marker',
    html: `<svg viewBox="-22 -22 44 44" width="44" height="44"
      style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.4));">
      ${cone}
      <rect x="-12" y="-9" width="24" height="18" rx="3"
        fill="#1d4ed8" stroke="white" stroke-width="2" />
      <rect x="-3" y="-13" width="9" height="5" rx="1"
        fill="#1d4ed8" stroke="white" stroke-width="1.5" />
      <circle cx="0" cy="1" r="6" fill="white" stroke="#1d4ed8" stroke-width="1.5" />
      <circle cx="0" cy="1" r="3" fill="#1d4ed8" />
    </svg>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  })
}

// 工区メモのマーカーアイコン。黄色付箋風のピン + 方向矢印（heading 指定時のみ）。
// heading は 0=北, 90=東 ... の地理学的角度。SVG 上は北が下向きなので 180° オフセット。
export function createMemoIcon(headingDeg: number | null): L.DivIcon {
  const arrow =
    headingDeg == null
      ? ''
      : `<div style="
          position: absolute;
          top: -6px;
          left: 50%;
          width: 0;
          height: 0;
          transform: translate(-50%, -100%) rotate(${headingDeg}deg);
          transform-origin: 50% calc(100% + 12px);
          border-left: 6px solid transparent;
          border-right: 6px solid transparent;
          border-bottom: 12px solid #f59e0b;
          filter: drop-shadow(0 1px 1px rgba(0,0,0,0.3));
        "></div>`
  return L.divIcon({
    className: 'memo-marker',
    html: `<div style="position: relative; width: 22px; height: 22px;">
      ${arrow}
      <div style="
        width: 22px;
        height: 22px;
        background: #fde68a;
        border: 2px solid #d97706;
        border-radius: 4px 4px 4px 12px;
        box-shadow: 0 2px 4px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 700;
        color: #92400e;
      ">M</div>
    </div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  })
}

// 辺長の端数処理
export type EdgeRounding = 'round' | 'floor'

export function formatEdgeLength(
  length: number,
  digits: number,
  rounding: EdgeRounding,
): string {
  const f = Math.pow(10, digits)
  const n = rounding === 'floor' ? Math.floor(length * f) / f : Math.round(length * f) / f
  return n.toFixed(digits)
}

// 辺長ラベル用アイコン（背景なし・白縁取り・辺の傾きに合わせて回転）
function createEdgeLengthIcon(label: string, angle: number): L.DivIcon {
  return L.divIcon({
    className: 'edge-length-label',
    html: `<div style="
      transform: translate(-50%, -50%) rotate(${angle}deg);
      font-size: 11px;
      font-weight: 700;
      color: #14532d;
      white-space: nowrap;
      text-shadow: -1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 0 2px #fff;
    ">${label} m</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

// 地図の表示状態を管理するコンポーネント
// 地図の長押し / 右クリック を拾うレイヤ。MapContainer の子としてマウントする。
function CoordinateMapLongPressBridge({
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

// 工区写真マーカー。カメラアイコン (createPhotoIcon) を表示し、クリックで
// 写真のサムネを含む Popup を開く。signed URL は遅延取得で、popup が開いた
// タイミングで初回ロードする。
export function PhotoMarker({
  photo,
  getSignedUrl,
  onClick,
}: {
  photo: {
    id: string
    lat: number
    lng: number
    headingDeg: number | null
    filePath: string
    caption?: string | null
  }
  getSignedUrl: (filePath: string) => Promise<string | null>
  onClick?: (id: string) => void
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'loaded' | 'error'>('idle')
  const [url, setUrl] = useState<string | null>(null)

  const ensureUrl = async () => {
    if (status === 'loading' || status === 'loaded') return
    setStatus('loading')
    try {
      const u = await getSignedUrl(photo.filePath)
      if (u) {
        setUrl(u)
        setStatus('loaded')
      } else {
        setStatus('error')
      }
    } catch {
      setStatus('error')
    }
  }

  return (
    <Marker
      position={[photo.lat, photo.lng]}
      icon={createPhotoIcon(photo.headingDeg)}
      zIndexOffset={450}
      eventHandlers={{
        click: () => {
          onClick?.(photo.id)
          void ensureUrl()
        },
      }}
    >
      <Popup minWidth={180} maxWidth={260}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {status === 'loading' && (
            <div style={{ padding: '12px 0', textAlign: 'center', color: '#64748b' }}>
              読み込み中…
            </div>
          )}
          {status === 'error' && (
            <div style={{ padding: '12px 0', textAlign: 'center', color: '#dc2626' }}>
              写真を取得できませんでした
            </div>
          )}
          {status === 'loaded' && url && (
            <a href={url} target="_blank" rel="noreferrer">
              <img
                src={url}
                alt=""
                style={{
                  display: 'block',
                  maxWidth: '100%',
                  maxHeight: 240,
                  borderRadius: 4,
                }}
              />
            </a>
          )}
          {photo.caption && (
            <div style={{ fontSize: 11, color: '#475569' }}>{photo.caption}</div>
          )}
          {photo.headingDeg != null && (
            <div style={{ fontSize: 10, color: '#94a3b8' }}>
              方向 {photo.headingDeg.toFixed(0)}°
            </div>
          )}
        </div>
      </Popup>
    </Marker>
  )
}

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

// 件数が多いときに「画面内 (ビューポート) のものだけ + 一定ズーム以上で
// のみ」描画する高密度レンダラ。React で 10000+ の Marker / Polygon を
// 一気にマウントすると詰まるので、拡大して画面内に絞り込んだ時のみ
// 子要素を描画する。
function HighDensityList<T>({
  items,
  threshold,
  zoomMin,
  labelZoomMin,
  getLatLng,
  getPolygonPositions,
  render,
}: {
  items: T[]
  /** この件数を超えるときだけ閾値・ビューポート絞り込みを有効化する */
  threshold: number
  /** ゲート時、この zoom 以上のときだけ描画する */
  zoomMin: number
  /**
   * ラベル（点名・地番名など）はマーカー描画より重いので、件数が多いときは
   * さらに高いズーム以上でのみ表示したい。
   * render 関数の第 2 引数 ctx.showLabel に「現在ラベル表示してよいか」を渡す。
   * 未指定なら常に true。
   */
  labelZoomMin?: number
  /** 点項目用: 単一の (lat, lng) を返す */
  getLatLng?: (item: T) => [number, number]
  /** ポリゴン項目用: positions を返す（バウンディングボックス判定用） */
  getPolygonPositions?: (item: T) => [number, number][]
  render: (item: T, ctx: { showLabel: boolean }) => React.ReactNode
}) {
  const map = useMap()
  const [zoom, setZoom] = useState<number>(() => map.getZoom())
  const [bounds, setBounds] = useState<L.LatLngBounds>(() => map.getBounds())
  useMapEvents({
    zoomend() {
      setZoom(map.getZoom())
      setBounds(map.getBounds())
    },
    moveend() {
      setBounds(map.getBounds())
    },
  })

  const isDense = items.length > threshold
  if (isDense && zoom < zoomMin) return null

  // 件数が多いときだけビューポート culling を効かせる
  const visible = !isDense
    ? items
    : items.filter((it) => {
        if (getLatLng) {
          const [lat, lng] = getLatLng(it)
          return bounds.contains([lat, lng])
        }
        if (getPolygonPositions) {
          const ps = getPolygonPositions(it)
          // 1 点でも画面内ならポリゴンとして可視扱い（粗い判定だが十分速い）
          for (const [lat, lng] of ps) {
            if (bounds.contains([lat, lng])) return true
          }
          return false
        }
        return true
      })

  // 件数が少ない (~threshold 未満) 場合はラベルも常に許可。
  // 多い場合は labelZoomMin 以上でのみ許可。
  const showLabel = !isDense || labelZoomMin == null || zoom >= labelZoomMin
  const ctx = { showLabel }
  return <>{visible.map((it) => render(it, ctx))}</>
}

// 背景地図の種類
export type BaseLayerType = 'osm' | 'gsi-photo' | 'gsi-std'

// 外部から渡す区域ポリゴン
export interface ExternalPolygon {
  id: string
  name: string
  positions: [number, number][]
  isEditing?: boolean
  /** 各頂点に対応する座標ID（positions と同じ順序・長さ）。境界線選択で利用 */
  pointIds?: string[]
  /** 各辺の中点・辺長(m)・画面上の傾き(deg)。測量座標(X,Y)から算出 */
  edges?: Array<{ mid: [number, number]; length: number; angle: number }>
}

interface CoordinateMapProps {
  selectedPointId?: string | null
  onPointSelect?: (id: string) => void
  showLabels?: boolean
  visibleTypes?: Set<string>
  /** 設置状態フィルタ（地籍測量のワークフロー） */
  visibleStakeStatuses?: Set<string>
  /** 親側で計算済みの「表示する座標 ID 集合」。
   *  指定すると visibleTypes / visibleStakeStatuses に加えてこの集合とも
   *  AND を取って絞り込む。親が複数のフィルタ条件をまとめて反映したい時に使う。 */
  displayCoordinateIds?: Set<string>
  /** オレンジ色で強調する座標 ID 集合（出力順指定モード等で使う）。
   *  指定された ID のマーカーは色をオレンジに置き換え、リング付きで大きめに描画する */
  orangeCoordIds?: Set<string>
  /** チェック中（表のチェックボックスで選択中）の座標 ID 集合。
   *  指定された ID のマーカーはスカイブルーのハロー（外側リング）で強調表示し、
   *  Ctrl/⌘ + クリックで onPointToggleCheck と連動して選択状態を切替できるようにする */
  checkedCoordIds?: Set<string>
  /** Ctrl/⌘ + マーカークリックで呼ぶ。指定すると複数選択 UI と連動。
   *  未指定なら従来通り通常クリックで onPointSelect だけ呼ばれる */
  onPointToggleCheck?: (id: string) => void
  /** 工区メモ（lat/lng 必須）。マーカーで地図上に位置・方向を表示する */
  farmMemos?: Array<{
    id: string
    content: string
    lat: number
    lng: number
    headingDeg: number | null
  }>
  /** メモマーカーをクリックしたとき */
  onMemoClick?: (memoId: string) => void
  /** 工区写真（標準写真）のマーカー。撮影位置 + 撮影方向 + サムネ用 filePath */
  farmPhotos?: Array<{
    id: string
    lat: number
    lng: number
    headingDeg: number | null
    filePath: string
    caption?: string | null
  }>
  /** サムネ表示のため Popup から呼ぶ signed URL ヘルパ */
  photoGetSignedUrl?: (filePath: string) => Promise<string | null>
  onPhotoClick?: (photoId: string) => void
  /** 地図の長押し（右クリック / モバイル長押し）で呼ぶ。メモ作成等に利用 */
  onMapLongPress?: (lat: number, lng: number) => void
  baseLayer?: BaseLayerType
  externalPolygons?: ExternalPolygon[]
  editingExternalPolygonId?: string | null
  /** ポリゴンクリックで親に通知（地番管理で一覧スクロール+選択ハイライトに使う） */
  onPolygonSelect?: (id: string) => void
  selectedExternalPolygonId?: string | null
  /** 編集中ポリゴンの構成点 ID 一覧（順序付き）。指定すると辺の中点に
   *  + ボタンが出る（click で挿入待機モード → 続けて座標 click で挿入確定） */
  editingConstituentPointIds?: string[]
  /** クリック選択された構成点 ID（オレンジ色で強調） */
  selectedConstituentPointId?: string | null
  /** 中点 + を click したときに呼ぶ。
   *  insertAfterIdx は元の構成点リストの index で、その点と次の点の間に挿入する想定 */
  onMidpointClick?: (insertAfterIdx: number) => void
  /** 挿入待機中の中点 + の index（緑で強調） */
  activeMidpointIdx?: number | null
  /** 地図上の mousemove。構成点クリック → 別座標クリックの間にポリゴンを
   *  追従させる用途で使う（リアルタイムプレビュー） */
  onMapMouseMove?: (lat: number, lng: number) => void
  /** 地図エリアからマウスが外れたときに呼ぶ（プレビュー解除用） */
  onMapMouseLeave?: () => void
  // 経路（順路）の描画
  route?: RoutePoint[]
  showRoute?: boolean
  // オルソ画像
  farmId?: string | null
  showOrtho?: boolean
  // 区域ポリゴンの辺長表示
  showEdgeLengths?: boolean
  edgeDigits?: number
  edgeRounding?: EdgeRounding
  // 区域ポリゴンの「名前」をポリゴン中央にラベルとして表示する（地番名など）
  showPolygonLabels?: boolean
  // 境界線（区域の辺）選択モード: 辺クリックで両端2点の座標IDを返す
  lineSelectMode?: boolean
  onLineSelect?: (id1: string, id2: string) => void
  /**
   * 座標マーカーを操作不能（クリック・hover無効）にする。
   * オルソ画像ページのように地図を「下絵」として使い、クリックを地図側へ通したい場合に false 相当にする。
   * デフォルト true（クリックで選択できる従来動作）
   */
  coordinatesInteractive?: boolean
  // MapContainer の子として追加レイヤを差し込む（作図・計測など）
  children?: React.ReactNode
}

export function CoordinateMap({
  selectedPointId,
  onPointSelect,
  showLabels = true,
  visibleTypes,
  visibleStakeStatuses,
  displayCoordinateIds,
  orangeCoordIds,
  checkedCoordIds,
  onPointToggleCheck,
  farmMemos,
  onMemoClick,
  farmPhotos,
  photoGetSignedUrl,
  onPhotoClick,
  onMapLongPress,
  baseLayer = 'osm',
  externalPolygons = [],
  editingExternalPolygonId,
  onPolygonSelect,
  selectedExternalPolygonId,
  editingConstituentPointIds,
  selectedConstituentPointId,
  onMidpointClick,
  activeMidpointIdx,
  onMapMouseMove,
  onMapMouseLeave,
  route = [],
  showRoute = false,
  farmId,
  showOrtho = true,
  showEdgeLengths = false,
  edgeDigits = 2,
  edgeRounding = 'round',
  showPolygonLabels = false,
  lineSelectMode = false,
  onLineSelect,
  coordinatesInteractive = true,
  children,
}: CoordinateMapProps) {
  const { coordinates } = useCoordinateStore()
  const {
    byFarm: orthoByFarm,
    fetchByFarm: fetchOrthos,
    tileUrlTemplate: getOrthoUrl,
  } = useOrthophotoStore()

  useEffect(() => {
    if (farmId) fetchOrthos(farmId)
  }, [farmId, fetchOrthos])
  const farmOrthos = farmId ? orthoByFarm.get(farmId) ?? [] : []

  // 有効な座標（緯度経度が計算済み）のみ表示
  const validCoordinates = coordinates.filter(
    (c): c is CoordinateRow & { lat: number; lng: number } =>
      c.lat !== null && c.lng !== null
  )

  // 表示対象の座標をフィルタリング（点種 + 設置状態）
  const displayCoordinates = validCoordinates.filter((c) => {
    if (visibleTypes && !visibleTypes.has(c.type)) return false
    if (visibleStakeStatuses && !visibleStakeStatuses.has(c.stakeStatus)) return false
    if (displayCoordinateIds && !displayCoordinateIds.has(c.id)) return false
    return true
  })

  // 初期中心（座標がない場合は東京）
  const defaultCenter: [number, number] = [35.6762, 139.6503]
  const initialCenter =
    validCoordinates.length > 0
      ? [validCoordinates[0].lat, validCoordinates[0].lng] as [number, number]
      : defaultCenter

  // ズームレベル表示（+/- ボタン直下に出すための state）。初期値は MapContainer の zoom と同じ
  const [currentZoom, setCurrentZoom] = useState<number>(15)

  return (
    <div className="relative h-full w-full">
      {/* +/- ボタン直下のズーム値表示。Leaflet の zoom control が
          top:10px + 60px (2 ボタン分) 程度なので、その下に余白少しで配置 */}
      <div
        className="absolute left-[10px] top-[78px] z-[1000] w-[30px] h-[30px] flex items-center justify-center bg-white border border-slate-300 rounded text-xs font-mono font-bold text-slate-700 shadow select-none"
        title="現在のズームレベル"
      >
        {Math.round(currentZoom)}
      </div>
      <MapContainer
      center={initialCenter}
      zoom={15}
      maxZoom={24}
      className="h-full w-full"
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

      {/* オルソ画像（登録分を重ねて表示） */}
      {showOrtho &&
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

      <MapViewManager coordinates={validCoordinates} />

      {/* 外部から渡されたポリゴン（workAreaStore など）。地番ポリゴンは
          4000+ になるので、500 件超なら zoom 16 以上 + 画面内のみ描画する。
          ラベル（地番名）はさらに重いので zoom 17 以上に絞る。 */}
      <HighDensityList
        items={externalPolygons.filter((p) => p.positions.length >= 3)}
        threshold={500}
        zoomMin={16}
        labelZoomMin={17}
        getPolygonPositions={(p) => p.positions}
        render={(polygon, { showLabel }) => {
          const isEditing = polygon.id === editingExternalPolygonId
          const isSelected = !isEditing && polygon.id === selectedExternalPolygonId
          return (
            <Polygon
              key={polygon.id}
              positions={polygon.positions}
              pathOptions={{
                color: isEditing ? '#16a34a' : isSelected ? '#f97316' : '#22c55e',
                fillColor: isEditing ? '#16a34a' : isSelected ? '#f97316' : '#22c55e',
                fillOpacity: isEditing ? 0.3 : isSelected ? 0.35 : 0.2,
                weight: isEditing ? 3 : isSelected ? 3 : 2,
                dashArray: isEditing ? '5, 5' : undefined,
              }}
              eventHandlers={
                onPolygonSelect
                  ? { click: () => onPolygonSelect(polygon.id) }
                  : undefined
              }
            >
              {showPolygonLabels && showLabel && polygon.name && (
                <Tooltip
                  permanent
                  direction="center"
                  className="polygon-label-tooltip"
                >
                  <span
                    style={{
                      color: isEditing ? '#15803d' : '#15803d',
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
        }}
      />

      {/* 境界線選択モード: 各辺をクリック可能なポリラインで重ねる */}
      {lineSelectMode &&
        externalPolygons.map((polygon) => {
          const ids = polygon.pointIds
          if (!ids || ids.length !== polygon.positions.length) return null
          const n = polygon.positions.length
          return polygon.positions.map((pos, i) => {
            const next = (i + 1) % n
            return (
              <Polyline
                key={`pickedge-${polygon.id}-${i}`}
                positions={[pos, polygon.positions[next]]}
                pathOptions={{ color: '#2563eb', weight: 8, opacity: 0.45 }}
                eventHandlers={{ click: () => onLineSelect?.(ids[i], ids[next]) }}
              />
            )
          })
        })}

      {/* 区域ポリゴンの辺長ラベル（測量座標から算出した平面距離） */}
      {showEdgeLengths &&
        externalPolygons.map((polygon) =>
          (polygon.edges ?? []).map((edge, i) => (
            <Marker
              key={`edge-${polygon.id}-${i}`}
              position={edge.mid}
              icon={createEdgeLengthIcon(
                formatEdgeLength(edge.length, edgeDigits, edgeRounding),
                edge.angle,
              )}
              interactive={false}
              zIndexOffset={500}
            />
          )),
        )}

      {/* 経路: down セグメントのみポリラインで結線 */}
      {showRoute && route.length > 1 && (() => {
        const coordById = new Map(validCoordinates.map((c) => [c.id, c]))
        const segments: Array<[number, number][]> = []
        let current: [number, number][] = []
        for (let i = 0; i < route.length; i++) {
          const p = route[i]
          const c = coordById.get(p.coordinateId)
          if (!c) continue
          if (i === 0) {
            current = [[c.lat, c.lng]]
            continue
          }
          if (p.direction === 'down') {
            // 前の点からこの点までを down として描く
            current.push([c.lat, c.lng])
          } else {
            // up: 現在のセグメントを終了し、新しいセグメントをこの点から開始
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

      {/* 工区メモのマーカー */}
      {farmMemos?.map((m) => (
        <Marker
          key={`memo-${m.id}`}
          position={[m.lat, m.lng]}
          icon={createMemoIcon(m.headingDeg)}
          zIndexOffset={500}
          eventHandlers={{ click: () => onMemoClick?.(m.id) }}
        >
          <Tooltip direction="top" offset={[0, -16]} className="memo-tooltip">
            <div style={{ maxWidth: 200, whiteSpace: 'pre-wrap' }}>
              {m.content.length > 80 ? m.content.slice(0, 80) + '…' : m.content}
            </div>
          </Tooltip>
        </Marker>
      ))}

      {/* 工区写真のマーカー（カメラアイコン + 撮影方向 + クリックでサムネ） */}
      {photoGetSignedUrl &&
        farmPhotos?.map((p) => (
          <PhotoMarker
            key={`photo-${p.id}`}
            photo={p}
            getSignedUrl={photoGetSignedUrl}
            onClick={onPhotoClick}
          />
        ))}

      {/* 長押し / 右クリック でメモ作成等のコールバックを発火 */}
      {onMapLongPress && <CoordinateMapLongPressBridge onLongPress={onMapLongPress} />}

      {/* 経路の順番ラベル */}
      {showRoute && route.map((p, idx) => {
        const c = validCoordinates.find((co) => co.id === p.coordinateId)
        if (!c) return null
        const color = p.direction === 'down' ? '#2563eb' : '#9ca3af'
        const orderIcon = L.divIcon({
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
            icon={orderIcon}
            interactive={false}
            zIndexOffset={1000}
          />
        )
      })}

      {/* 座標マーカー: 件数が多い (1000+) ときは zoom 17 以上 + 画面内のみ描画。
          ラベル（点名）はマーカー自体より重いので zoom 19 以上に絞る。
          編集モードで構成点は「選択中ならオレンジ強調」だが、マーカー自体は
          ドラッグできない（元の点と点名はその場に固定）。
          ドラッグは別レイヤの透明ハンドル (ConstituentHandlesLayer) で行う */}
      <HighDensityList
        items={displayCoordinates}
        threshold={1000}
        zoomMin={17}
        labelZoomMin={19}
        getLatLng={(c) => [c.lat, c.lng]}
        render={(coord, { showLabel }) => {
          const isSelectedConstituent = coord.id === selectedConstituentPointId
          const isSelectedRegular = coord.id === selectedPointId
          const isOrange = orangeCoordIds?.has(coord.id) ?? false
          const isChecked = checkedCoordIds?.has(coord.id) ?? false
          const isHighlighted = isSelectedConstituent || isSelectedRegular || isOrange
          const baseColor = MARKER_COLORS[coord.type] || '#666'
          const iconColor = isSelectedConstituent || isOrange ? '#f97316' : baseColor
          return (
          <Marker
            key={coord.id}
            position={[coord.lat, coord.lng]}
            icon={createColoredIcon(iconColor, isHighlighted, isChecked)}
            // ハイライト中 / チェック中のマーカーを必ず最前面に出して、
            // 後ろに隠れて見えなくなる現象を防ぐ
            zIndexOffset={isHighlighted || isChecked ? 1000 : 0}
            interactive={coordinatesInteractive}
            eventHandlers={coordinatesInteractive ? {
              // Ctrl/⌘ + クリック で複数選択をトグル（ハンドラ指定時のみ）。
              // 通常クリックは従来通り単一選択。
              click: (e) => {
                const orig = (e.originalEvent ?? null) as MouseEvent | null
                if (onPointToggleCheck && orig && (orig.ctrlKey || orig.metaKey)) {
                  onPointToggleCheck(coord.id)
                  return
                }
                onPointSelect?.(coord.id)
              },
            } : undefined}
          >
            {/* showLabels && showLabel が true なら常時表示、false ならホバー
                時のみ点名を出す（Tooltip 自体はマーカー上に常駐させておく）。
                スマホと同じく、マーカー色 + 白フチで地図上に読みやすく表示 */}
            <Tooltip
              permanent={showLabels && showLabel}
              direction="top"
              offset={[0, -8]}
              className="point-label-tooltip"
            >
              <span
                style={{
                  color: MARKER_COLORS[coord.type] || '#666',
                  textShadow:
                    '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                }}
              >
                {coord.pointNumber}
              </span>
            </Tooltip>
          </Marker>
        )
        }}
      />

      {/* 構成点編集モード: 中点 + を click で「挿入待機」、次に座標を click で確定。
          構成点の置換も click-click（元の点をクリック → 別の座標をクリック）。 */}
      {editingConstituentPointIds && editingConstituentPointIds.length >= 2 && onMidpointClick && (
        <MidpointPlusLayer
          constituentIds={editingConstituentPointIds}
          coordinates={validCoordinates}
          onClick={onMidpointClick}
          activeIdx={activeMidpointIdx ?? null}
        />
      )}

      {/* 外部から差し込む追加レイヤ（オルソ画像ページの作図・計測など） */}
      {children}

      {/* マウス位置を親へ伝える不可視トラッカ（クリック確定までの
          ポリゴン追従プレビュー用）。コールバックが無いときは null を返すだけ */}
      {(onMapMouseMove || onMapMouseLeave) && (
        <MouseMoveTracker onMove={onMapMouseMove} onLeave={onMapMouseLeave} />
      )}

      {/* ズームレベルを上の表示用 state に伝搬する不可視トラッカ */}
      <ZoomTracker onChange={setCurrentZoom} />
      {/* ホイールズームを 1 段ずつに制限 */}
      <OneStepWheelZoom />
    </MapContainer>
    </div>
  )
}

// 構成点編集中の各辺の中点に "+" マーカーを描画。
// click すると親が「挿入待機モード」へ。次に座標 click で確定挿入する。
const MIDPOINT_PLUS_ICON = L.divIcon({
  className: 'midpoint-plus',
  html:
    '<div style="' +
    'background:#fff;color:#16a34a;border:2px solid #16a34a;' +
    'border-radius:50%;width:20px;height:20px;display:flex;align-items:center;' +
    'justify-content:center;font-size:14px;font-weight:bold;cursor:pointer;' +
    'box-shadow:0 2px 4px rgba(0,0,0,0.2);">+</div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

const MIDPOINT_PLUS_ICON_ACTIVE = L.divIcon({
  className: 'midpoint-plus-active',
  html:
    '<div style="' +
    'background:#16a34a;color:#fff;border:3px solid #15803d;' +
    'border-radius:50%;width:24px;height:24px;display:flex;align-items:center;' +
    'justify-content:center;font-size:16px;font-weight:bold;cursor:crosshair;' +
    'box-shadow:0 2px 6px rgba(0,0,0,0.35);">+</div>',
  iconSize: [24, 24],
  iconAnchor: [12, 12],
})

function MidpointPlusLayer({
  constituentIds,
  coordinates,
  onClick,
  activeIdx,
}: {
  constituentIds: string[]
  coordinates: Array<CoordinateRow & { lat: number; lng: number }>
  onClick: (insertAfterIdx: number) => void
  activeIdx: number | null
}) {
  const coordById = new Map(coordinates.map((c) => [c.id, c]))
  const out: React.ReactElement[] = []
  const n = constituentIds.length
  for (let i = 0; i < n; i++) {
    const a = coordById.get(constituentIds[i])
    const b = coordById.get(constituentIds[(i + 1) % n])
    if (!a || !b) continue
    const midLat = (a.lat + b.lat) / 2
    const midLng = (a.lng + b.lng) / 2
    const insertAfterIdx = i + 1
    const isActive = insertAfterIdx === activeIdx
    out.push(
      <Marker
        key={`midplus-${i}-${a.id}`}
        position={[midLat, midLng]}
        icon={isActive ? MIDPOINT_PLUS_ICON_ACTIVE : MIDPOINT_PLUS_ICON}
        zIndexOffset={500}
        eventHandlers={{
          click: () => onClick(insertAfterIdx),
        }}
      />,
    )
  }
  return <>{out}</>
}

// マウス位置を親へ伝える不可視トラッカ。mousemove は throttle (16ms ≒ 60fps)。
function MouseMoveTracker({
  onMove,
  onLeave,
}: {
  onMove?: (lat: number, lng: number) => void
  onLeave?: () => void
}) {
  const last = useRef(0)
  useMapEvents({
    mousemove(e) {
      if (!onMove) return
      const now = performance.now()
      if (now - last.current < 16) return
      last.current = now
      onMove(e.latlng.lat, e.latlng.lng)
    },
    mouseout() {
      onLeave?.()
    },
  })
  return null
}

// MapContainer の中で useMapEvents をフックし、ズーム値を親 state に伝える。
// 自身は何も描画しない。
function ZoomTracker({ onChange }: { onChange: (zoom: number) => void }) {
  const map = useMap()
  useEffect(() => {
    onChange(map.getZoom())
  }, [map, onChange])
  useMapEvents({
    zoomend() {
      onChange(map.getZoom())
    },
  })
  return null
}

// Leaflet 標準のホイールズーム (deltaY を 60px / level で蓄積) は、
// 高 DPI マウスや高速スクロールで 1 イベントに 2 段以上ズームしてしまうため、
// 自前で「1 ホイールイベント = ±1 段」に置き換える。
function OneStepWheelZoom() {
  const map = useMap()
  useEffect(() => {
    map.scrollWheelZoom.disable()
    const container = map.getContainer()
    let lastTime = 0
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      // 高頻度スクロール（トラックパッドなど）の連発を間引く
      const now = Date.now()
      if (now - lastTime < 80) return
      lastTime = now
      if (e.deltaY < 0) map.zoomIn(1, { animate: true })
      else if (e.deltaY > 0) map.zoomOut(1, { animate: true })
    }
    container.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      container.removeEventListener('wheel', onWheel)
      map.scrollWheelZoom.enable()
    }
  }, [map])
  return null
}
