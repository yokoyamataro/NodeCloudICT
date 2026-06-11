import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Polygon, Polyline, useMap, useMapEvents, Tooltip } from 'react-leaflet'
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

// 座標種類ごとのマーカー色
const MARKER_COLORS: Record<string, string> = {
  control: '#ef4444',     // 基準点: 赤
  boundary: '#3b82f6',    // 境界点: 青
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
  baseLayer?: BaseLayerType
  externalPolygons?: ExternalPolygon[]
  editingExternalPolygonId?: string | null
  /** ポリゴンクリックで親に通知（地番管理で一覧スクロール+選択ハイライトに使う） */
  onPolygonSelect?: (id: string) => void
  selectedExternalPolygonId?: string | null
  /** 編集中ポリゴンの構成点 ID 一覧（順序付き）。指定するとマーカーがドラッグ可能になり、
   *  辺の中点には + ボタン（ドラッグで挿入）が出る */
  editingConstituentPointIds?: string[]
  /** クリック選択された構成点 ID（オレンジ色で強調） */
  selectedConstituentPointId?: string | null
  /** 中点+ボタンをドラッグ中（リアルタイム） */
  onMidpointDrag?: (insertAfterIdx: number, lat: number, lng: number) => void
  /** 中点+ボタンをドラッグして別位置へドロップしたときに呼ぶ。
   *  insertAfterIdx は元の構成点リストの index で、その点と次の点の間に挿入する想定 */
  onMidpointDragEnd?: (insertAfterIdx: number, lat: number, lng: number) => void
  /** 中点 + ハンドルの再マウントキー（drop 後に bump して位置リセット） */
  midpointResetKey?: number
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
  baseLayer = 'osm',
  externalPolygons = [],
  editingExternalPolygonId,
  onPolygonSelect,
  selectedExternalPolygonId,
  editingConstituentPointIds,
  selectedConstituentPointId,
  onMidpointDrag,
  onMidpointDragEnd,
  midpointResetKey = 0,
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
          const baseColor = MARKER_COLORS[coord.type] || '#666'
          const iconColor = isSelectedConstituent ? '#f97316' : baseColor
          return (
          <Marker
            key={coord.id}
            position={[coord.lat, coord.lng]}
            icon={createColoredIcon(
              iconColor,
              isSelectedConstituent || isSelectedRegular,
            )}
            interactive={coordinatesInteractive}
            eventHandlers={coordinatesInteractive ? {
              click: () => onPointSelect?.(coord.id),
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

      {/* 構成点編集モード: 中点 + ボタンのみドラッグで挿入。
          構成点の置換は click-click（元の点をクリック → 別の座標をクリック）で確定 */}
      {editingConstituentPointIds && editingConstituentPointIds.length >= 2 && onMidpointDragEnd && (
        <MidpointPlusLayer
          constituentIds={editingConstituentPointIds}
          coordinates={validCoordinates}
          onDrag={onMidpointDrag}
          onDragEnd={onMidpointDragEnd}
          resetKey={midpointResetKey}
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
// マーカーをドラッグして座標上にドロップすると、その中点の位置（=次の辺の前）に
// 新しい構成点を挿入できる。
const MIDPOINT_PLUS_ICON = L.divIcon({
  className: 'midpoint-plus',
  html:
    '<div style="' +
    'background:#fff;color:#16a34a;border:2px solid #16a34a;' +
    'border-radius:50%;width:20px;height:20px;display:flex;align-items:center;' +
    'justify-content:center;font-size:14px;font-weight:bold;cursor:grab;' +
    'box-shadow:0 2px 4px rgba(0,0,0,0.2);">+</div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

function MidpointPlusLayer({
  constituentIds,
  coordinates,
  onDrag,
  onDragEnd,
  resetKey,
}: {
  constituentIds: string[]
  coordinates: Array<CoordinateRow & { lat: number; lng: number }>
  onDrag?: (insertAfterIdx: number, lat: number, lng: number) => void
  onDragEnd: (insertAfterIdx: number, lat: number, lng: number) => void
  resetKey: number
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
    out.push(
      <Marker
        key={`midplus-${i}-${a.id}-${resetKey}`}
        position={[midLat, midLng]}
        icon={MIDPOINT_PLUS_ICON}
        draggable
        zIndexOffset={500}
        eventHandlers={{
          drag: (e: { target: { getLatLng: () => { lat: number; lng: number } } }) => {
            if (!onDrag) return
            const ll = e.target.getLatLng()
            onDrag(i + 1, ll.lat, ll.lng)
          },
          dragend: (e: { target: { getLatLng: () => { lat: number; lng: number } } }) => {
            const ll = e.target.getLatLng()
            onDragEnd(i + 1, ll.lat, ll.lng)
          },
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
