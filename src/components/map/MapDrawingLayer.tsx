// 地図上に手書きペイント + 直線 + 円 + 円弧 + 面 + テキスト注釈を重ねるレイヤ。
//
// モード:
//   ・'off'     描画無効。既存アイテムだけ表示。マップ操作は通常通り。
//   ・'pen'     ドラッグでフリーハンドのストローク (地図の 1 本指 pan は無効化、2 本指ピンチは有効)。
//   ・'line'    ドラッグで始点/終点だけ記録し 2 点の直線。
//   ・'circle'  2 タップで中心 → 縁 (半径 = 2 点間距離、L.Circle で描画)。
//   ・'arc'     3 タップで始点 → 通過点 → 終点 (3 点を通る一意の円弧を近似ポリラインで描画)。
//   ・'polygon' タップで頂点を追加。最初の頂点を再タップ or 「面を閉じる」で確定。半透明で塗り潰し。
//   ・'text'    タップした点にテキスト注釈 (prompt 経由)。文字サイズは fontSize。
//   ・'point'   タップした点に点を置く。registerCoordinate が true なら
//               onAddCoordinate も呼び、座標管理にも登録する。
//   ・'select'  ストロークをタップで選択 → 青ハンドルをドラッグで頂点移動 / 長押しで削除 /
//               辺の中点の「+」タップで頂点追加 (直線・円・円弧は追加/削除不可、位置移動のみ)。
//   ・'eraser'  アイテムをクリックで削除。
//   ・'measure-dist' / 'measure-area' / 'measure-perp'
//               計測。結果は保存せず、モードを抜けるまで地図上に表示する。
//
// ピック (snapEnabled): 既存の作図の頂点と extraSnapPoints (測点・区域の頂点) に
// 吸着する。判定は画面 px なので、縮尺が変わっても指の感覚は変わらない。
// フリーハンドは吸着しない (全点を吸わせると線が壊れるため)。直線・平行線は端点のみ。
//
// layer は DXF 出力時のレイヤ名。以後に作る図形へ付与する。
//
// 保存座標は lat/lng なので、地図を伸縮・移動しても地図上の位置は保持される。

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Circle as LeafletCircle,
  Marker,
  Pane,
  Polygon as LeafletPolygon,
  Polyline,
  useMap,
  useMapEvents,
} from 'react-leaflet'
import L, { type LatLng } from 'leaflet'
import {
  useMapDrawingStore,
  EMPTY_STROKES,
  type MapDrawingStroke,
  type LineStyle,
} from '@/stores/mapDrawingStore'
import type { CoordinateConverter } from '@/lib/coordinates'

export type DrawingMode =
  | 'off'
  | 'pen'
  | 'line'
  | 'circle'
  | 'arc'
  | 'polygon'
  | 'parallel'
  | 'text'
  | 'point'
  | 'select'
  | 'eraser'
  | 'measure-dist'
  | 'measure-area'
  | 'measure-perp'

/** 計測モードかどうか */
export function isMeasureMode(mode: DrawingMode): boolean {
  return mode === 'measure-dist' || mode === 'measure-area' || mode === 'measure-perp'
}

interface Props {
  farmId: string | null
  mode: DrawingMode
  color: string
  widthPx: number
  lineStyle: LineStyle
  /**
   * 平面直角座標への変換器。渡されていれば計測は平面距離 (測量と同じ) で行う。
   * 無ければ球面距離で近似する (数 km 程度なら実用上ほぼ同じ)。
   */
  converter?: CoordinateConverter
  /** DXF 出力時のレイヤ名。以後の作図に付与する */
  layer?: string
  /** テキストの文字サイズ [px] */
  fontSize?: number
  /** ピック (スナップ): 近くの点に吸着させる */
  snapEnabled?: boolean
  /** 図形以外のスナップ候補 (座標管理の点・区域の頂点など) */
  extraSnapPoints?: Array<[number, number]>
  /**
   * 'point' で 点を置いた時に 座標管理へも 登録する。
   * 未指定なら 登録機能そのものを 出さない (この画面に 座標管理が無い場合)
   */
  onAddCoordinate?: (lat: number, lng: number) => void
  /** 'point' で 座標管理にも 登録するか (チェックボックスの状態) */
  registerCoordinate?: boolean
  /** true のとき既存のペイントを地図に出さない (道具の入力受付は継続) */
  hidden?: boolean
}

// ---- 平行線 ----
//
// 道路の幅員や法面のように、引いた線と等間隔の線を並べるための計算。
// 緯度経度のままでは距離が扱えないので、基準線の中点を原点にした
// メートル座標 (東 / 北) に直してから直交方向へずらす。

const M_PER_DEG_LAT = 111320

interface LL {
  lat: number
  lng: number
}

/** 基準線に直交する単位ベクトル (東, 北)。進行方向の左を正とする */
function perpendicularUnit(a: LL, b: LL): { east: number; north: number } | null {
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const east = (b.lng - a.lng) * M_PER_DEG_LAT * Math.cos(latRad)
  const north = (b.lat - a.lat) * M_PER_DEG_LAT
  const len = Math.hypot(east, north)
  if (len < 1e-6) return null
  // 進行方向を 90° 左に回す
  return { east: -north / len, north: east / len }
}

/** 基準線を distanceM だけ直交方向へずらした線を返す */
function offsetLine(a: LL, b: LL, distanceM: number): [LL, LL] | null {
  const u = perpendicularUnit(a, b)
  if (!u) return null
  const shift = (p: LL): LL => {
    const latRad = p.lat * (Math.PI / 180)
    return {
      lat: p.lat + (u.north * distanceM) / M_PER_DEG_LAT,
      lng: p.lng + (u.east * distanceM) / (M_PER_DEG_LAT * Math.cos(latRad)),
    }
  }
  return [shift(a), shift(b)]
}

/** 点 p の基準線からの符号付き距離 [m] (左が正)。タップで間隔を決めるのに使う */
function signedDistanceM(a: LL, b: LL, p: LL): number {
  const u = perpendicularUnit(a, b)
  if (!u) return 0
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const east = (p.lng - a.lng) * M_PER_DEG_LAT * Math.cos(latRad)
  const north = (p.lat - a.lat) * M_PER_DEG_LAT
  return east * u.east + north * u.north
}

/** kind ごとの最小頂点数 (これ以下には削除できない) */
const MIN_POINTS: Record<string, number> = {
  stroke: 2,
  polygon: 3,
  line: 2,
  circle: 2,
  arc: 3,
}

/** 頂点追加 (中点 +) が許される kind (直線・円・円弧は頂点数固定) */
const VARIABLE_VERTEX_KINDS = new Set<string>(['stroke', 'polygon'])

/** ハンドル: 頂点移動用 (青丸 + 白フチ) */
const HANDLE_ICON = L.divIcon({
  className: 'map-drawing-handle',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#3b82f6;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6);"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
})

/** ハンドル: 頂点追加用 (緑丸 + "+") */
const MIDPOINT_ICON = L.divIcon({
  className: 'map-drawing-midpoint',
  html: '<div style="width:14px;height:14px;border-radius:50%;background:#22c55e;border:2px solid white;box-shadow:0 0 3px rgba(0,0,0,0.5);color:white;font-size:10px;font-weight:bold;line-height:10px;text-align:center;">+</div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})

/** ポリゴン描画中の最初の頂点マーカー (再タップで閉じる目印, 橙色) */
const FIRST_VERTEX_ICON = L.divIcon({
  className: 'map-drawing-first-vertex',
  html: '<div style="width:20px;height:20px;border-radius:50%;background:#f97316;border:3px solid white;box-shadow:0 0 6px rgba(0,0,0,0.6);"></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
})

/** LineStyle → Leaflet Polyline の dashArray に変換 (太さに合わせて自動調整) */
export function dashArrayFor(style: LineStyle, widthPx: number): string | undefined {
  if (style === 'solid') return undefined
  if (style === 'dashed') return `${widthPx * 3},${widthPx * 2}`
  return `0.1,${widthPx * 1.8}`
}

/** width_px (1-20) → テキストの font-size px。1→10px, 5→18px, 10→28px 相当 */
function textFontSizePx(widthPx: number): number {
  return Math.max(10, 8 + widthPx * 2)
}

/** テキスト注釈用の divIcon (背景なし、測点ラベルと同じ「白フチ + 色本体」スタイル) */
export function makeTextIcon(
  text: string,
  color: string,
  widthPx: number,
  interactive: boolean,
  /** 明示指定があればそれを使う。無ければ従来どおり太さから換算する */
  fontSizePx?: number | null,
): L.DivIcon {
  const size = fontSizePx ?? textFontSizePx(widthPx)
  const shadow =
    '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff'
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const html = `<span style="color:${color};font-size:${size}px;font-weight:bold;text-shadow:${shadow};white-space:nowrap;pointer-events:${
    interactive ? 'auto' : 'none'
  };cursor:${interactive ? 'pointer' : 'default'};">${escaped}</span>`
  return L.divIcon({
    className: 'map-drawing-text-label',
    html,
    iconSize: undefined as unknown as L.PointExpression,
    iconAnchor: [0, size / 2],
  })
}

/** 2 点の緯度経度から中点を求める (簡易平均、短距離なら十分な精度) */
function midpointOfLatLngs(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): { lat: number; lng: number } {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }
}

/**
 * 3 点 (始点・通過点・終点) を通る円弧を計算し、近似ポリライン用の頂点列を返す。
 * 局所平面近似 (原点 = 始点) で外接円中心 + 半径を求め、角度をスイープしながら
 * segments 個に分割する。1km 程度までなら投影歪みは無視できる。
 */
export function arcThroughPoints(
  start: { lat: number; lng: number },
  mid: { lat: number; lng: number },
  end: { lat: number; lng: number },
  segments = 40,
): Array<[number, number]> {
  const originLat = start.lat
  const originLng = start.lng
  const metersPerDegLat = 110540
  const metersPerDegLng = 111320 * Math.cos((originLat * Math.PI) / 180)
  const toXY = (p: { lat: number; lng: number }) => ({
    x: (p.lng - originLng) * metersPerDegLng,
    y: (p.lat - originLat) * metersPerDegLat,
  })
  const toLatLng = (xy: { x: number; y: number }): [number, number] => [
    originLat + xy.y / metersPerDegLat,
    originLng + xy.x / metersPerDegLng,
  ]

  const p0 = toXY(start)
  const p1 = toXY(mid)
  const p2 = toXY(end)

  // 外接円の中心 (perpendicular bisector 交点)
  const ax = p0.x
  const ay = p0.y
  const bx = p1.x
  const by = p1.y
  const cx = p2.x
  const cy = p2.y
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-6) {
    // ほぼ共線 → 折れ線として返す
    return [
      [start.lat, start.lng],
      [mid.lat, mid.lng],
      [end.lat, end.lng],
    ]
  }
  const centerX =
    ((ax * ax + ay * ay) * (by - cy) +
      (bx * bx + by * by) * (cy - ay) +
      (cx * cx + cy * cy) * (ay - by)) /
    d
  const centerY =
    ((ax * ax + ay * ay) * (cx - bx) +
      (bx * bx + by * by) * (ax - cx) +
      (cx * cx + cy * cy) * (bx - ax)) /
    d
  const radius = Math.hypot(ax - centerX, ay - centerY)

  // 3 点の角度
  const a0 = Math.atan2(ay - centerY, ax - centerX)
  const a1 = Math.atan2(by - centerY, bx - centerX)
  const a2 = Math.atan2(cy - centerY, cx - centerX)

  // a0 を基準に反時計回りに正規化した相対角度
  const twoPi = Math.PI * 2
  const norm = (a: number) => ((a - a0) % twoPi + twoPi) % twoPi
  const na1 = norm(a1)
  const na2 = norm(a2)

  // 通過点 (na1) が終点 (na2) より手前なら反時計回り、そうでなければ時計回り
  const ccw = na1 < na2
  const sweep = ccw ? na2 : twoPi - na2

  const result: Array<[number, number]> = []
  for (let i = 0; i <= segments; i++) {
    const t = i / segments
    const angle = a0 + (ccw ? 1 : -1) * sweep * t
    const x = centerX + radius * Math.cos(angle)
    const y = centerY + radius * Math.sin(angle)
    result.push(toLatLng({ x, y }))
  }
  return result
}

/** 円の半径 (メートル) を center/edge の 2 点から求める */
export function circleRadiusMeters(
  center: { lat: number; lng: number },
  edge: { lat: number; lng: number },
): number {
  return L.latLng(center.lat, center.lng).distanceTo(L.latLng(edge.lat, edge.lng))
}

// ---- 計測 ----
//
// 測量として使う値なので、平面直角座標 (X=北 / Y=東) が使えるときはそちらで計算する。
// converter が無い画面 (共有ビュー等) では球面距離で近似する。

export interface MeasureResult {
  kind: 'dist' | 'area' | 'perp'
  points: LL[]
  /** m または m² */
  value: number
  /** 値を表示する位置 */
  labelAt: LL
  /** 垂線の足 (perp のときのみ) */
  foot?: LL
}

function measureDist(c: CoordinateConverter | undefined, a: LL, b: LL): number {
  if (!c) return L.latLng(a.lat, a.lng).distanceTo(L.latLng(b.lat, b.lng))
  const A = c.toXY(a.lat, a.lng)
  const B = c.toXY(b.lat, b.lng)
  return Math.hypot(B.x - A.x, B.y - A.y)
}

function measureArea(c: CoordinateConverter | undefined, verts: LL[]): number {
  if (verts.length < 3) return 0
  // converter が無いときは中心緯度で経度を縮めた簡易平面に落とす
  const pts = c
    ? verts.map((v) => c.toXY(v.lat, v.lng))
    : (() => {
        const lat0 = verts.reduce((s, v) => s + v.lat, 0) / verts.length
        const k = Math.cos((lat0 * Math.PI) / 180)
        return verts.map((v) => ({
          x: v.lat * M_PER_DEG_LAT,
          y: v.lng * M_PER_DEG_LAT * k,
        }))
      })()
  let s = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** 点 p から線分 ab を含む直線までの距離と、その垂線の足 */
function measurePerp(
  c: CoordinateConverter | undefined,
  a: LL,
  b: LL,
  p: LL,
): { value: number; foot: LL } {
  // converter が無い場合も同じ式が使えるよう、簡易平面に統一する
  const lat0 = (a.lat + b.lat + p.lat) / 3
  const k = Math.cos((lat0 * Math.PI) / 180)
  const toXY = (ll: LL) =>
    c ? c.toXY(ll.lat, ll.lng) : { x: ll.lat * M_PER_DEG_LAT, y: ll.lng * M_PER_DEG_LAT * k }
  const toLL = (x: number, y: number): LL =>
    c ? c.toLatLng(x, y) : { lat: x / M_PER_DEG_LAT, lng: y / (M_PER_DEG_LAT * k) }

  const A = toXY(a)
  const B = toXY(b)
  const P = toXY(p)
  const abx = B.x - A.x
  const aby = B.y - A.y
  const len2 = abx * abx + aby * aby
  if (len2 === 0) return { value: 0, foot: a }
  const t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / len2
  const fx = A.x + t * abx
  const fy = A.y + t * aby
  return { value: Math.hypot(P.x - fx, P.y - fy), foot: toLL(fx, fy) }
}

function centroid(pts: LL[]): LL {
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length
  const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length
  return { lat, lng }
}

/** 計測値の表示文字列 */
export function formatMeasure(m: MeasureResult): string {
  if (m.kind === 'area') {
    return `${m.value.toFixed(2)} m² (${(m.value / 10000).toFixed(4)} ha)`
  }
  if (m.value < 1) return `${(m.value * 100).toFixed(1)} cm`
  return `${m.value.toFixed(3)} m`
}

/** 計測値のラベル (地図上に置く白フキダシ) */
function makeMeasureLabelIcon(text: string, color: string): L.DivIcon {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return L.divIcon({
    className: 'map-measure-label',
    html: `<div style="
      background:rgba(255,255,255,.92);border:1px solid ${color};color:${color};
      font-size:12px;font-weight:700;padding:1px 5px;border-radius:3px;
      white-space:nowrap;transform:translate(-50%,-50%);box-shadow:0 1px 2px rgba(0,0,0,.2)
    ">${esc}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

/** ピックの吸着範囲 [画面 px]。指でも届き、隣の点を誤って掴まない程度 */
const SNAP_RADIUS_PX = 18

/** 点 (kind='point') のアイコン */
function makePointIcon(color: string, widthPx: number): L.DivIcon {
  const d = Math.max(8, Math.min(20, 6 + widthPx))
  return L.divIcon({
    className: 'map-drawing-point',
    html: `<div style="background:${color};width:${d}px;height:${d}px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
    iconSize: [d, d],
    iconAnchor: [d / 2, d / 2],
  })
}

/** ピックの吸着先を示す印 */
const SNAP_HINT_ICON = L.divIcon({
  className: 'map-drawing-snap-hint',
  html: '<div style="width:14px;height:14px;border:2px solid #f59e0b;border-radius:2px;background:rgba(245,158,11,.25);box-sizing:border-box"></div>',
  iconSize: [14, 14],
  iconAnchor: [7, 7],
})

export function MapDrawingLayer({
  farmId,
  mode,
  color,
  widthPx,
  lineStyle,
  converter,
  layer = '0',
  fontSize,
  snapEnabled = false,
  extraSnapPoints,
  onAddCoordinate,
  registerCoordinate = false,
  hidden = false,
}: Props) {
  const map = useMap()
  const items = useMapDrawingStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_STROKES : EMPTY_STROKES,
  )
  const fetchByFarm = useMapDrawingStore((s) => s.fetchByFarm)
  const addStroke = useMapDrawingStore((s) => s.addStroke)
  const addPoint = useMapDrawingStore((s) => s.addPoint)
  const addText = useMapDrawingStore((s) => s.addText)
  const deleteStroke = useMapDrawingStore((s) => s.deleteStroke)
  const updateStrokePoints = useMapDrawingStore((s) => s.updateStrokePoints)

  const [currentPositions, setCurrentPositions] = useState<[number, number][]>([])
  /** 平行線: 引き終わった基準線。間隔と本数を決めるまで保持する */
  const [parallelBase, setParallelBase] = useState<[LL, LL] | null>(null)
  /** 平行線の設定。距離は左が正 (地図タップでも数値入力でも決められる) */
  // (パネル表示中の地図タップで間隔を拾う effect は下に置く)
  const [parallelSpacing, setParallelSpacing] = useState(3)
  const [parallelCount, setParallelCount] = useState(1)
  const [parallelBothSides, setParallelBothSides] = useState(false)
  const currentRef = useRef<LatLng[] | null>(null)

  // タップ式の描画で進行中の頂点列 (circle: 中心のみ / arc: [start] or [start,mid] / polygon: [p1..])
  const [shapeProgress, setShapeProgress] = useState<{
    kind: 'circle' | 'arc' | 'polygon'
    points: Array<{ lat: number; lng: number }>
  } | null>(null)

  // ---- ピック (スナップ) ----
  //
  // 既存の作図の頂点と、外から渡された候補 (座標管理の点・区域の頂点) に吸着させる。
  // 判定は画面上の距離で行う。地図の縮尺が変わっても指の感覚が変わらないようにするため。
  const snapCandidates = useMemo(() => {
    if (!snapEnabled) return []
    const out: LL[] = []
    for (const it of items) {
      for (const p of it.points) out.push({ lat: p.lat, lng: p.lng })
    }
    if (extraSnapPoints) {
      for (const [lat, lng] of extraSnapPoints) out.push({ lat, lng })
    }
    return out
  }, [snapEnabled, items, extraSnapPoints])

  /** 吸着後の座標を返す。候補が近くに無ければそのまま返す */
  const snap = useCallback(
    (ll: { lat: number; lng: number }): LL => {
      if (!snapEnabled || snapCandidates.length === 0) return { lat: ll.lat, lng: ll.lng }
      const target = map.latLngToContainerPoint([ll.lat, ll.lng])
      let best: LL | null = null
      let bestPx = SNAP_RADIUS_PX
      for (const c of snapCandidates) {
        const px = map.latLngToContainerPoint([c.lat, c.lng]).distanceTo(target)
        if (px < bestPx) {
          bestPx = px
          best = c
        }
      }
      return best ?? { lat: ll.lat, lng: ll.lng }
    },
    [snapEnabled, snapCandidates, map],
  )

  /** 吸着先が近くにあるか (カーソル位置に印を出すため) */
  const [snapHint, setSnapHint] = useState<LL | null>(null)
  useEffect(() => {
    // 直前の実行のクリーンアップで印は消えるので、ここでは購読しないだけでよい
    if (!snapEnabled || mode === 'off' || mode === 'select') return
    const onMove = (e: L.LeafletMouseEvent) => {
      const s = snap(e.latlng)
      setSnapHint(s.lat === e.latlng.lat && s.lng === e.latlng.lng ? null : s)
    }
    map.on('mousemove', onMove)
    return () => {
      map.off('mousemove', onMove)
      setSnapHint(null)
    }
  }, [map, snap, snapEnabled, mode])

  // 計測: 入力途中の点列と、確定した結果 (保存はしない)
  const [measurePoints, setMeasurePoints] = useState<LL[]>([])
  const [lastMeasure, setLastMeasure] = useState<MeasureResult | null>(null)

  // 選択モードの状態
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragPreview, setDragPreview] = useState<{
    strokeId: string
    points: Array<{ lat: number; lng: number }>
  } | null>(null)

  // テキスト追加ダイアログ (window.prompt を使わずページ内モーダルで入力させる。
  // ブラウザで「追加のダイアログを表示しない」がチェックされている状況でも動くように)
  const [textDialog, setTextDialog] = useState<{
    lat: number
    lng: number
    value: string
  } | null>(null)
  const textDialogInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (textDialog) {
      // 開いた瞬間にフォーカス
      requestAnimationFrame(() => textDialogInputRef.current?.focus())
    }
  }, [textDialog])

  // farm 切替時に fetch + 状態リセット
  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
    setShapeProgress(null)
    setSelectedId(null)
    setDragPreview(null)
  }, [farmId, fetchByFarm])

  // モード変更時にモードに合わない状態をクリア
  useEffect(() => {
    if (mode !== 'circle' && mode !== 'arc' && mode !== 'polygon') {
      setShapeProgress(null)
    }
    if (mode !== 'text') setTextDialog(null)
    if (mode !== 'select') {
      setSelectedId(null)
      setDragPreview(null)
    }
    // 計測は結果を残さない。モードを抜けた時点で消す
    if (!isMeasureMode(mode)) {
      setMeasurePoints([])
      setLastMeasure(null)
    } else {
      // 計測の種類を変えたら入力途中をリセット
      setMeasurePoints([])
    }
  }, [mode])

  // 平行線パネル表示中は、地図タップで間隔を決められるようにする。
  // 数値入力と併用できる (どちらでも良い、というのが現場では使いやすい)。
  useEffect(() => {
    if (!parallelBase) return
    const handler = (e: L.LeafletMouseEvent) => {
      const d = signedDistanceM(parallelBase[0], parallelBase[1], {
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      })
      // 符号で左右が決まる。小数第 1 位まで
      setParallelSpacing(Math.round(d * 10) / 10)
    }
    map.on('click', handler)
    return () => {
      map.off('click', handler)
    }
  }, [map, parallelBase])

  // 描画中は地図の 1 本指 pan を止める。text/circle/arc/polygon は click ベースだが誤 pan 防止で
  // dragging は残す (単発 click を邪魔しないため)。pen/line だけ dragging を止める。
  useEffect(() => {
    const isPointerDraw = mode === 'pen' || mode === 'line' || mode === 'parallel'
    const isTapDraw =
      mode === 'text' ||
      mode === 'point' ||
      mode === 'circle' ||
      mode === 'arc' ||
      mode === 'polygon' ||
      isMeasureMode(mode)
    const container = map.getContainer()
    if (isPointerDraw) {
      map.dragging.disable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.disable()
      map.boxZoom.disable()
      map.touchZoom.enable()
      container.style.cursor = 'crosshair'
      container.style.touchAction = 'pinch-zoom'
    } else if (isTapDraw) {
      map.dragging.enable()
      map.doubleClickZoom.disable()
      map.scrollWheelZoom.enable()
      map.boxZoom.enable()
      map.touchZoom.enable()
      container.style.cursor =
        mode === 'text' ? 'text' : 'crosshair'
      container.style.touchAction = ''
    } else {
      map.dragging.enable()
      map.touchZoom.enable()
      map.doubleClickZoom.enable()
      map.scrollWheelZoom.enable()
      map.boxZoom.enable()
      container.style.cursor =
        mode === 'eraser' ? 'not-allowed' : mode === 'select' ? 'pointer' : ''
      container.style.touchAction = ''
    }
    return () => {
      container.style.cursor = ''
      container.style.touchAction = ''
    }
  }, [mode, map])

  // タップ式描画 + text 追加: useMapEvents
  useMapEvents({
    click: (e) => {
      // ピックが ON なら、以降はすべて吸着後の座標で扱う
      const at = snap(e.latlng)

      // 計測は保存しないので farmId を必要としない
      if (isMeasureMode(mode)) {
        const pts = [...measurePoints, at]

        if (mode === 'measure-dist') {
          if (pts.length < 2) {
            setMeasurePoints(pts)
            return
          }
          const value = measureDist(converter, pts[0], pts[1])
          setLastMeasure({
            kind: 'dist',
            points: pts,
            value,
            labelAt: centroid(pts),
          })
          setMeasurePoints([])
          return
        }

        if (mode === 'measure-perp') {
          if (pts.length < 3) {
            setMeasurePoints(pts)
            return
          }
          const { value, foot } = measurePerp(converter, pts[0], pts[1], pts[2])
          setLastMeasure({
            kind: 'perp',
            points: pts,
            value,
            labelAt: centroid([pts[2], foot]),
            foot,
          })
          setMeasurePoints([])
          return
        }

        // measure-area: 最初の頂点付近を再タップで閉じる
        if (measurePoints.length >= 3) {
          const first = measurePoints[0]
          const firstPx = map.latLngToContainerPoint([first.lat, first.lng])
          if (firstPx.distanceTo(map.latLngToContainerPoint(e.latlng)) < 22) {
            const value = measureArea(converter, measurePoints)
            setLastMeasure({
              kind: 'area',
              points: measurePoints,
              value,
              labelAt: centroid(measurePoints),
            })
            setMeasurePoints([])
            return
          }
        }
        setMeasurePoints(pts)
        return
      }

      if (!farmId) return

      if (mode === 'point') {
        void addPoint({ farmId, color, widthPx, lat: at.lat, lng: at.lng, layer })
        // 「座標登録あり」なら 座標管理にも 同じ位置を 登録する。
        // 点そのものは ペイントに 残るので、CAD 出力にも 乗る
        if (registerCoordinate) onAddCoordinate?.(at.lat, at.lng)
        return
      }

      if (mode === 'text') {
        setTextDialog({ lat: at.lat, lng: at.lng, value: '' })
        return
      }
      if (mode === 'circle') {
        if (!shapeProgress || shapeProgress.kind !== 'circle') {
          setShapeProgress({ kind: 'circle', points: [at] })
        } else {
          const points = [...shapeProgress.points, at]
          void addStroke({
            farmId,
            kind: 'circle',
            color,
            widthPx,
            lineStyle,
            points,
            layer,
          })
          setShapeProgress(null)
        }
        return
      }
      if (mode === 'arc') {
        if (!shapeProgress || shapeProgress.kind !== 'arc') {
          setShapeProgress({ kind: 'arc', points: [at] })
        } else if (shapeProgress.points.length === 1) {
          setShapeProgress({
            kind: 'arc',
            points: [...shapeProgress.points, at],
          })
        } else {
          const points = [...shapeProgress.points, at]
          void addStroke({
            farmId,
            kind: 'arc',
            color,
            widthPx,
            lineStyle,
            points,
            layer,
          })
          setShapeProgress(null)
        }
        return
      }
      if (mode === 'polygon') {
        const current = shapeProgress?.kind === 'polygon' ? shapeProgress.points : []
        // 頂点が 3 個以上ある状態で最初の頂点付近をタップ → 閉じる
        if (current.length >= 3) {
          const first = current[0]
          const firstPx = map.latLngToContainerPoint([first.lat, first.lng])
          const clickPx = map.latLngToContainerPoint(e.latlng)
          if (firstPx.distanceTo(clickPx) < 22) {
            void addStroke({
              farmId,
              kind: 'polygon',
              color,
              widthPx,
              lineStyle,
              points: current,
              layer,
            })
            setShapeProgress(null)
            return
          }
        }
        const nextPoints = [...current, at]
        setShapeProgress({ kind: 'polygon', points: nextPoints })
        return
      }
    },
  })

  // Escape で進行中の描画・計測をキャンセル
  useEffect(() => {
    if (!shapeProgress && measurePoints.length === 0 && !lastMeasure) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setShapeProgress(null)
      setMeasurePoints([])
      setLastMeasure(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shapeProgress, measurePoints.length, lastMeasure])

  // pen / line モード: pointer events (フリーハンド / 2 点直線)
  useEffect(() => {
    // parallel も 2 点をドラッグして引くので line と同じ経路を通す
    if (mode !== 'pen' && mode !== 'line' && mode !== 'parallel') return
    const container = map.getContainer()

    const activePointers = new Set<number>()
    let drawingPointerId: number | null = null

    const commit = () => {
      const pts = currentRef.current
      currentRef.current = null
      setCurrentPositions([])
      if (!pts || pts.length < 2 || !farmId) return
      // 直線・平行線は 端点だけ 吸着させる。フリーハンドは 吸着させない
      // (全点を吸わせると 線が壊れるため)
      const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
      if (mode === 'line' || mode === 'parallel') {
        geo[0] = snap(geo[0])
        geo[geo.length - 1] = snap(geo[geo.length - 1])
      }
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points: geo, layer })
      if (mode === 'parallel' && geo.length >= 2) {
        // 基準線はそのまま残し、間隔と本数を決める段に進む
        setParallelBase([geo[0], geo[geo.length - 1]])
      }
    }
    const abortDrawing = () => {
      currentRef.current = null
      setCurrentPositions([])
      drawingPointerId = null
    }
    const eventToLatLng = (e: PointerEvent): LatLng | null => {
      try {
        return map.mouseEventToLatLng(e as unknown as MouseEvent)
      } catch {
        return null
      }
    }
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return
      activePointers.add(e.pointerId)
      if (activePointers.size > 1) {
        if (drawingPointerId != null) {
          try {
            container.releasePointerCapture(drawingPointerId)
          } catch {
            /* ignore */
          }
        }
        abortDrawing()
        return
      }
      const latlng = eventToLatLng(e)
      if (!latlng) return
      drawingPointerId = e.pointerId
      currentRef.current = [latlng]
      setCurrentPositions([[latlng.lat, latlng.lng]])
      try {
        container.setPointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      e.preventDefault()
    }
    const onMove = (e: PointerEvent) => {
      if (drawingPointerId == null || e.pointerId !== drawingPointerId) return
      if (activePointers.size > 1) return
      if (!currentRef.current) return
      const latlng = eventToLatLng(e)
      if (!latlng) return
      if (mode === 'line' || mode === 'parallel') {
        const start = currentRef.current[0]
        currentRef.current = [start, latlng]
        setCurrentPositions([
          [start.lat, start.lng],
          [latlng.lat, latlng.lng],
        ])
      } else {
        currentRef.current.push(latlng)
        setCurrentPositions(currentRef.current.map((p) => [p.lat, p.lng]))
      }
      e.preventDefault()
    }
    const onUp = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (e.pointerId !== drawingPointerId) return
      drawingPointerId = null
      try {
        container.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      commit()
    }
    const onCancel = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (e.pointerId !== drawingPointerId) return
      drawingPointerId = null
      commit()
    }

    container.addEventListener('pointerdown', onDown)
    container.addEventListener('pointermove', onMove)
    container.addEventListener('pointerup', onUp)
    container.addEventListener('pointercancel', onCancel)
    return () => {
      container.removeEventListener('pointerdown', onDown)
      container.removeEventListener('pointermove', onMove)
      container.removeEventListener('pointerup', onUp)
      container.removeEventListener('pointercancel', onCancel)
    }
  }, [mode, map, farmId, color, widthPx, lineStyle, layer, snap, addStroke])

  // ポリゴン描画中に「面を閉じる」ボタンを L.Control として map の右上に表示
  useEffect(() => {
    if (!shapeProgress || shapeProgress.kind !== 'polygon' || shapeProgress.points.length < 3) {
      return
    }
    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control')
    container.style.cssText =
      'background:white;padding:6px 12px;font-size:12px;font-weight:bold;cursor:pointer;color:#111;border:2px solid rgba(0,0,0,0.2);border-radius:4px;'
    container.innerText = '✓ 面を閉じる'
    L.DomEvent.on(container, 'click', (ev) => {
      L.DomEvent.stop(ev)
      if (!farmId) return
      void addStroke({
        farmId,
        kind: 'polygon',
        color,
        widthPx,
        lineStyle,
        points: shapeProgress.points,
        layer,
      })
      setShapeProgress(null)
    })
    L.DomEvent.disableClickPropagation(container)
    const control = new L.Control({ position: 'topright' })
    control.onAdd = () => container
    control.addTo(map)
    return () => {
      control.remove()
    }
  }, [shapeProgress, map, farmId, color, widthPx, lineStyle, layer, addStroke])

  // 選択中のストローク (端点ハンドル用)
  const selectedStroke = useMemo(
    () =>
      mode === 'select' && selectedId
        ? items.find((s) => s.id === selectedId) ?? null
        : null,
    [items, mode, selectedId],
  )
  // 頂点ハンドル用の points (ドラッグ中はプレビュー)
  const handlePoints =
    selectedStroke && selectedStroke.kind !== 'text'
      ? dragPreview?.strokeId === selectedStroke.id
        ? dragPreview.points
        : selectedStroke.points
      : null

  // 既存アイテムの描画
  const rendered = useMemo(
    () =>
      items.map((s: MapDrawingStroke) => {
        if (s.kind === 'text') {
          const pt = s.points[0]
          if (!pt) return null
          const isEraser = mode === 'eraser'
          return (
            <Marker
              key={s.id}
              position={[pt.lat, pt.lng]}
              icon={makeTextIcon(s.text ?? '', s.color, s.width_px, isEraser, s.font_size)}
              interactive={isEraser}
              eventHandlers={
                isEraser ? { click: () => void deleteStroke(s.id) } : undefined
              }
            />
          )
        }

        if (s.kind === 'point') {
          const pt = s.points[0]
          if (!pt) return null
          const isEraser = mode === 'eraser'
          return (
            <Marker
              key={s.id}
              position={[pt.lat, pt.lng]}
              icon={makePointIcon(s.color, s.width_px)}
              interactive={isEraser}
              eventHandlers={
                isEraser ? { click: () => void deleteStroke(s.id) } : undefined
              }
            />
          )
        }

        // ドラッグ中は preview の points を採用してリアルタイム反映
        const pointsForRender =
          dragPreview?.strokeId === s.id ? dragPreview.points : s.points
        const isSelected = mode === 'select' && s.id === selectedId
        const dash = dashArrayFor(
          (s.line_style ?? 'solid') as LineStyle,
          s.width_px,
        )
        const clickHandlers =
          mode === 'eraser'
            ? { click: () => void deleteStroke(s.id) }
            : mode === 'select'
              ? { click: () => setSelectedId(s.id) }
              : undefined

        if (s.kind === 'circle') {
          const center = pointsForRender[0]
          const edge = pointsForRender[1]
          if (!center || !edge) return null
          const radius = circleRadiusMeters(center, edge)
          return (
            <Fragment key={s.id}>
              {isSelected && (
                <LeafletCircle
                  center={[center.lat, center.lng]}
                  radius={radius}
                  pathOptions={{
                    color: '#3b82f6',
                    weight: s.width_px + 8,
                    opacity: 0.35,
                    fill: false,
                  }}
                  interactive={false}
                />
              )}
              <LeafletCircle
                center={[center.lat, center.lng]}
                radius={radius}
                pathOptions={{
                  color: s.color,
                  weight: s.width_px,
                  opacity: 0.9,
                  fill: false,
                  dashArray: dash,
                }}
                eventHandlers={clickHandlers}
              />
            </Fragment>
          )
        }
        if (s.kind === 'arc') {
          if (pointsForRender.length < 3) return null
          const [a, b, c] = pointsForRender
          const arcPts = arcThroughPoints(a, b, c)
          return (
            <Fragment key={s.id}>
              {isSelected && (
                <Polyline
                  positions={arcPts}
                  pathOptions={{
                    color: '#3b82f6',
                    weight: s.width_px + 8,
                    opacity: 0.35,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                  interactive={false}
                />
              )}
              <Polyline
                positions={arcPts}
                pathOptions={{
                  color: s.color,
                  weight: s.width_px,
                  opacity: 0.9,
                  lineCap: 'round',
                  lineJoin: 'round',
                  dashArray: dash,
                }}
                eventHandlers={clickHandlers}
              />
            </Fragment>
          )
        }
        if (s.kind === 'polygon') {
          const positions = pointsForRender.map(
            (p) => [p.lat, p.lng] as [number, number],
          )
          return (
            <Fragment key={s.id}>
              {isSelected && (
                <LeafletPolygon
                  positions={positions}
                  pathOptions={{
                    color: '#3b82f6',
                    weight: s.width_px + 8,
                    opacity: 0.35,
                    fill: false,
                  }}
                  interactive={false}
                />
              )}
              <LeafletPolygon
                positions={positions}
                pathOptions={{
                  color: s.color,
                  weight: s.width_px,
                  opacity: 0.9,
                  fillColor: s.color,
                  fillOpacity: 0.2,
                  dashArray: dash,
                }}
                eventHandlers={clickHandlers}
              />
            </Fragment>
          )
        }
        // stroke (フリーハンド or 直線)
        const positions = pointsForRender.map(
          (p) => [p.lat, p.lng] as [number, number],
        )
        return (
          <Fragment key={s.id}>
            {isSelected && (
              <Polyline
                positions={positions}
                pathOptions={{
                  color: '#3b82f6',
                  weight: s.width_px + 8,
                  opacity: 0.35,
                  lineCap: 'round',
                  lineJoin: 'round',
                }}
                interactive={false}
              />
            )}
            <Polyline
              positions={positions}
              pathOptions={{
                color: s.color,
                weight: s.width_px,
                opacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
                dashArray: dash,
              }}
              eventHandlers={clickHandlers}
            />
          </Fragment>
        )
      }),
    [items, mode, deleteStroke, selectedId, dragPreview],
  )

  // タップ式描画の進行中プレビュー
  const shapePreview = useMemo(() => {
    if (!shapeProgress) return null
    if (shapeProgress.kind === 'circle') {
      const center = shapeProgress.points[0]
      if (!center) return null
      return (
        <Marker
          position={[center.lat, center.lng]}
          icon={FIRST_VERTEX_ICON}
          interactive={false}
        />
      )
    }
    if (shapeProgress.kind === 'arc') {
      return (
        <>
          {shapeProgress.points.map((p, i) => (
            <Marker
              key={`arc-progress-${i}`}
              position={[p.lat, p.lng]}
              icon={FIRST_VERTEX_ICON}
              interactive={false}
            />
          ))}
          {shapeProgress.points.length === 2 && (
            <Polyline
              positions={shapeProgress.points.map(
                (p) => [p.lat, p.lng] as [number, number],
              )}
              pathOptions={{
                color,
                weight: widthPx,
                opacity: 0.5,
                dashArray: '4,4',
              }}
            />
          )}
        </>
      )
    }
    // polygon
    const positions = shapeProgress.points.map(
      (p) => [p.lat, p.lng] as [number, number],
    )
    return (
      <>
        {positions.length >= 2 && (
          <Polyline
            positions={positions}
            pathOptions={{
              color,
              weight: widthPx,
              opacity: 0.6,
              dashArray: '4,4',
            }}
          />
        )}
        {shapeProgress.points.map((p, i) => (
          <Marker
            key={`poly-progress-${i}`}
            position={[p.lat, p.lng]}
            icon={i === 0 ? FIRST_VERTEX_ICON : HANDLE_ICON}
            interactive={false}
          />
        ))}
      </>
    )
  }, [shapeProgress, color, widthPx])

  // 計測の表示 (入力途中 + 確定結果)。保存はしないのでここだけで完結する
  const measureOverlay = useMemo(() => {
    if (!isMeasureMode(mode) && !lastMeasure) return null
    const MEASURE_COLOR = '#e11d48'
    const vertexIcon = L.divIcon({
      className: 'map-measure-vertex',
      html: `<div style="background:${MEASURE_COLOR};width:9px;height:9px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4)"></div>`,
      iconSize: [9, 9],
      iconAnchor: [4.5, 4.5],
    })
    const dash: L.PathOptions = {
      color: MEASURE_COLOR,
      weight: 2,
      dashArray: '6,4',
    }
    const solid: L.PathOptions = { color: MEASURE_COLOR, weight: 2.5 }

    return (
      <>
        {/* 入力途中 */}
        {measurePoints.length >= 2 && (
          <Polyline positions={measurePoints.map((p) => [p.lat, p.lng] as [number, number])} pathOptions={dash} />
        )}
        {measurePoints.map((p, i) => (
          <Marker key={`mp-${i}`} position={[p.lat, p.lng]} icon={vertexIcon} interactive={false} />
        ))}

        {/* 確定結果 */}
        {lastMeasure && lastMeasure.kind === 'area' && (
          <LeafletPolygon
            positions={lastMeasure.points.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={{ ...solid, fillColor: MEASURE_COLOR, fillOpacity: 0.15 }}
          />
        )}
        {lastMeasure && lastMeasure.kind === 'dist' && (
          <Polyline
            positions={lastMeasure.points.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={solid}
          />
        )}
        {lastMeasure && lastMeasure.kind === 'perp' && lastMeasure.foot && (
          <>
            {/* 基準線は破線、垂線本体を実線にして「どちらを測ったか」を分かるようにする */}
            <Polyline
              positions={[
                [lastMeasure.points[0].lat, lastMeasure.points[0].lng],
                [lastMeasure.points[1].lat, lastMeasure.points[1].lng],
              ]}
              pathOptions={dash}
            />
            <Polyline
              positions={[
                [lastMeasure.points[2].lat, lastMeasure.points[2].lng],
                [lastMeasure.foot.lat, lastMeasure.foot.lng],
              ]}
              pathOptions={solid}
            />
          </>
        )}
        {lastMeasure &&
          lastMeasure.points.map((p, i) => (
            <Marker key={`mr-${i}`} position={[p.lat, p.lng]} icon={vertexIcon} interactive={false} />
          ))}
        {lastMeasure && (
          <Marker
            position={[lastMeasure.labelAt.lat, lastMeasure.labelAt.lng]}
            icon={makeMeasureLabelIcon(formatMeasure(lastMeasure), MEASURE_COLOR)}
            interactive={false}
          />
        )}
      </>
    )
  }, [mode, measurePoints, lastMeasure])

  // 選択中ストロークの中点 (+) ハンドル用の位置列。頂点数可変 kind でのみ表示。
  const midpoints = useMemo(() => {
    if (!selectedStroke || !handlePoints) return []
    if (!VARIABLE_VERTEX_KINDS.has(selectedStroke.kind)) return []
    const list: Array<{ index: number; lat: number; lng: number }> = []
    const closed = selectedStroke.kind === 'polygon'
    for (let i = 0; i < handlePoints.length - 1; i++) {
      const m = midpointOfLatLngs(handlePoints[i], handlePoints[i + 1])
      list.push({ index: i, lat: m.lat, lng: m.lng })
    }
    if (closed && handlePoints.length >= 3) {
      const m = midpointOfLatLngs(
        handlePoints[handlePoints.length - 1],
        handlePoints[0],
      )
      list.push({ index: handlePoints.length - 1, lat: m.lat, lng: m.lng })
    }
    return list
  }, [selectedStroke, handlePoints])

  return (
    <Pane name="map-drawing" style={{ zIndex: 500 }}>
      {hidden ? null : rendered}
      {shapePreview}
      {measureOverlay}
      {/* ピックの吸着先 (マウス操作時のみ。指では出ないが、タップ時は吸着する) */}
      {snapHint && (
        <Marker
          position={[snapHint.lat, snapHint.lng]}
          icon={SNAP_HINT_ICON}
          interactive={false}
        />
      )}
      {currentPositions.length >= 2 && (
        <Polyline
          positions={currentPositions}
          pathOptions={{
            color,
            weight: widthPx,
            opacity: 0.7,
            lineCap: 'round',
            lineJoin: 'round',
            dashArray: dashArrayFor(lineStyle, widthPx),
          }}
        />
      )}
      {/* 選択中ストロークの頂点ハンドル (ドラッグで移動 / 長押しで削除) */}
      {selectedStroke &&
        handlePoints &&
        handlePoints.map((p, idx) => (
          <Marker
            key={`vertex-${selectedStroke.id}-${idx}`}
            position={[p.lat, p.lng]}
            icon={HANDLE_ICON}
            draggable
            eventHandlers={{
              drag: (e) => {
                const marker = e.target as L.Marker
                const latlng = marker.getLatLng()
                const nextPoints = selectedStroke.points.map((pp, i) =>
                  i === idx ? { lat: latlng.lat, lng: latlng.lng } : pp,
                )
                setDragPreview({
                  strokeId: selectedStroke.id,
                  points: nextPoints,
                })
              },
              dragend: (e) => {
                const marker = e.target as L.Marker
                const latlng = marker.getLatLng()
                const nextPoints = selectedStroke.points.map((pp, i) =>
                  i === idx ? { lat: latlng.lat, lng: latlng.lng } : pp,
                )
                setDragPreview(null)
                void updateStrokePoints(selectedStroke.id, nextPoints)
              },
              contextmenu: () => {
                // 長押し or 右クリックで頂点削除 (頂点数可変 kind のみ)
                if (!VARIABLE_VERTEX_KINDS.has(selectedStroke.kind)) return
                const min = MIN_POINTS[selectedStroke.kind] ?? 2
                if (selectedStroke.points.length <= min) return
                const nextPoints = selectedStroke.points.filter(
                  (_, i) => i !== idx,
                )
                void updateStrokePoints(selectedStroke.id, nextPoints)
              },
            }}
          />
        ))}
      {/* 中点 + ハンドル (頂点数可変 kind: stroke / polygon のみ) */}
      {selectedStroke &&
        midpoints.map((m) => (
          <Marker
            key={`midpoint-${selectedStroke.id}-${m.index}`}
            position={[m.lat, m.lng]}
            icon={MIDPOINT_ICON}
            eventHandlers={{
              click: () => {
                const nextPoints = [...selectedStroke.points]
                nextPoints.splice(m.index + 1, 0, { lat: m.lat, lng: m.lng })
                void updateStrokePoints(selectedStroke.id, nextPoints)
              },
            }}
          />
        ))}
      {/* 計測の操作案内 + 結果。値は保存しないので、ここに出したものが全て */}
      {isMeasureMode(mode) &&
        createPortal(
          <div className="fixed inset-x-3 bottom-24 z-[4000] rounded-lg bg-white shadow-xl border px-3 py-2 flex items-center gap-3 max-w-sm mx-auto">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-800">
                {mode === 'measure-dist' ? '距離' : mode === 'measure-area' ? '面積' : '垂線'}
              </div>
              {lastMeasure ? (
                <div className="text-base font-bold text-rose-600 tabular-nums truncate">
                  {formatMeasure(lastMeasure)}
                </div>
              ) : (
                <div className="text-[11px] text-slate-500">
                  {mode === 'measure-dist'
                    ? '2 点をタップ'
                    : mode === 'measure-area'
                      ? `頂点をタップ (${measurePoints.length}) → 最初の点をもう一度タップで確定`
                      : '基準線の 2 点 → 対象の 1 点をタップ'}
                </div>
              )}
            </div>
            {mode === 'measure-area' && measurePoints.length >= 3 && (
              <button
                type="button"
                onClick={() => {
                  setLastMeasure({
                    kind: 'area',
                    points: measurePoints,
                    value: measureArea(converter, measurePoints),
                    labelAt: centroid(measurePoints),
                  })
                  setMeasurePoints([])
                }}
                className="px-2.5 py-1.5 rounded bg-rose-600 text-white text-xs shrink-0"
              >
                確定
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMeasurePoints([])
                setLastMeasure(null)
              }}
              className="px-2.5 py-1.5 rounded border text-slate-600 text-xs shrink-0"
            >
              クリア
            </button>
          </div>,
          document.body,
        )}
      {/* 平行線の設定。基準線を引いた直後に出す。
          間隔は数値入力でも、地図タップでも決められる (両方使える)。
          基準線はそのまま残し、指定した本数だけ平行線を足す。 */}
      {parallelBase &&
        createPortal(
          <div className="fixed inset-x-3 bottom-24 z-[4000] rounded-lg bg-white shadow-xl border p-3 flex flex-col gap-2 max-w-sm mx-auto">
            <div className="text-sm font-semibold text-slate-800">平行線を作成</div>
            <div className="text-[11px] text-slate-500">
              間隔を入力するか、地図をタップして位置で指定します
            </div>
            <div className="flex items-center gap-2">
              <label className="flex-1">
                <span className="text-[11px] text-slate-600">間隔 (m)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={parallelSpacing}
                  onChange={(ev) => setParallelSpacing(Number(ev.target.value))}
                  className="mt-0.5 w-full px-2 py-1 border border-slate-300 rounded text-right font-mono"
                />
              </label>
              <label className="w-20">
                <span className="text-[11px] text-slate-600">本数</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={parallelCount}
                  onChange={(ev) =>
                    setParallelCount(Math.max(1, Math.min(20, Number(ev.target.value))))
                  }
                  className="mt-0.5 w-full px-2 py-1 border border-slate-300 rounded text-right font-mono"
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={parallelBothSides}
                onChange={(ev) => setParallelBothSides(ev.target.checked)}
              />
              両側に作る
            </label>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setParallelBase(null)}
                className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50"
              >
                やめる
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!farmId || !parallelBase) return
                  const [a, b] = parallelBase
                  const signs = parallelBothSides ? [1, -1] : [Math.sign(parallelSpacing) || 1]
                  const step = Math.abs(parallelSpacing)
                  for (const sign of signs) {
                    for (let i = 1; i <= parallelCount; i += 1) {
                      const line = offsetLine(a, b, sign * step * i)
                      if (!line) continue
                      void addStroke({
                        farmId,
                        kind: 'stroke',
                        color,
                        widthPx,
                        lineStyle,
                        points: line,
                        layer,
                      })
                    }
                  }
                  setParallelBase(null)
                }}
                className="flex-1 px-3 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700"
              >
                作成
              </button>
            </div>
          </div>,
          document.body,
        )}

      {/* テキスト入力ダイアログ (window.prompt の代替。Portal で map の外に出す) */}
      {textDialog &&
        createPortal(
          <div
            className="fixed inset-0 z-[4000] flex items-center justify-center bg-black/40 p-4"
            onClick={() => setTextDialog(null)}
          >
            <div
              className="bg-white rounded-lg shadow-xl p-4 w-full max-w-sm flex flex-col gap-3"
              onClick={(ev) => ev.stopPropagation()}
            >
              <div className="text-sm font-semibold text-slate-800">
                テキストを入力
              </div>
              <input
                ref={textDialogInputRef}
                type="text"
                value={textDialog.value}
                onChange={(ev) =>
                  setTextDialog({ ...textDialog, value: ev.target.value })
                }
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    const trimmed = textDialog.value.trim()
                    if (trimmed && farmId) {
                      void addText({
                        farmId,
                        color,
                        widthPx,
                        lat: textDialog.lat,
                        lng: textDialog.lng,
                        text: trimmed,
                        layer,
                        fontSize,
                      })
                    }
                    setTextDialog(null)
                  } else if (ev.key === 'Escape') {
                    setTextDialog(null)
                  }
                }}
                placeholder="ここに文字を入力"
                className="w-full border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setTextDialog(null)}
                  className="px-3 py-1.5 text-sm rounded border text-slate-700 hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = textDialog.value.trim()
                    if (trimmed && farmId) {
                      void addText({
                        farmId,
                        color,
                        widthPx,
                        lat: textDialog.lat,
                        lng: textDialog.lng,
                        text: trimmed,
                        layer,
                        fontSize,
                      })
                    }
                    setTextDialog(null)
                  }}
                  disabled={!textDialog.value.trim()}
                  className="px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  追加
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </Pane>
  )
}
