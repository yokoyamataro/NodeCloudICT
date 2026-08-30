// 地図上に手書きペイント + 直線 + 円 + 円弧 + 面 + テキスト注釈を重ねるレイヤ。
//
// モード:
//   ・'off'     描画無効。既存アイテムだけ表示。マップ操作は通常通り。
//   ・'pen'     ドラッグでフリーハンドのストローク (地図の 1 本指 pan は無効化、2 本指ピンチは有効)。
//   ・'line'    クリックで頂点を追加する連続線。Backspace で 1 つ戻る、
//               Enter (または「線を確定」) で確定、Esc で取り消し。
//   ・'circle'  2 タップで中心 → 縁 (半径 = 2 点間距離、L.Circle で描画)。
//   ・'arc'     3 タップで始点 → 通過点 → 終点 (3 点を通る一意の円弧を近似ポリラインで描画)。
//   ・'polygon' タップで頂点を追加。最初の頂点を再タップ / Enter / 「面を閉じる」で確定。
//               Backspace で 1 つ戻る、Esc で取り消し。半透明で塗り潰し。
//   ・'text'    先に内容と書き方 (水平文字 / 線上文字) を決め、地図をクリックして置く。
//               クリック前はカーソルに仮表示が付いてくる (置いた時と同じ見え方)。
//               線上文字は 始点 → 向きの点 の 2 クリックで方位に合わせる。
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
  DEFAULT_LAYERS,
  KIND_LABEL,
  type MapDrawingStroke,
  type LineStyle,
} from '@/stores/mapDrawingStore'
import type { CoordinateConverter } from '@/lib/coordinates'
import { useCommandBarEl } from './mapDrawingCommandBar'

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
  /** 文字サイズを変える (コマンドバーで調整させる。未指定ならスライダを出さない) */
  onChangeFontSize?: (px: number) => void
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
  /** レイヤ名の入力候補 (選択した図形の属性を編集するパネルで使う) */
  existingLayers?: string[]
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
  /** 回転角 [度]。反時計回りが正 (0 = 水平文字) */
  rotationDeg?: number | null,
): L.DivIcon {
  const size = fontSizePx ?? textFontSizePx(widthPx)
  // CSS の rotate は時計回りが正なので符号を反転する
  const rot = rotationDeg ? `transform:rotate(${-rotationDeg}deg);transform-origin:0 50%;` : ''
  const shadow =
    '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff'
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  const html = `<span style="display:inline-block;color:${color};font-size:${size}px;font-weight:bold;text-shadow:${shadow};white-space:nowrap;${rot}pointer-events:${
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

/**
 * 半径 [m] から円周上の点 (真北) を作る。保存は [中心, 縁] の 2 点のままにしたいので、
 * 数値で入れた半径もこの形に直す。緯度 1 度の長さは場所で少し変わるので 1 回補正する。
 */
export function edgePointFromRadius(
  center: { lat: number; lng: number },
  radiusM: number,
): { lat: number; lng: number } {
  let dLat = radiusM / M_PER_DEG_LAT
  for (let i = 0; i < 2; i += 1) {
    const cand = { lat: center.lat + dLat, lng: center.lng }
    const actual = circleRadiusMeters(center, cand)
    if (actual <= 0) break
    dLat *= radiusM / actual
  }
  return { lat: center.lat + dLat, lng: center.lng }
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
function makePointIcon(color: string, widthPx: number, selected = false): L.DivIcon {
  const d = Math.max(8, Math.min(20, 6 + widthPx))
  const ring = selected ? 'box-shadow:0 0 0 3px #3b82f6,0 1px 3px rgba(0,0,0,.4);' : 'box-shadow:0 1px 3px rgba(0,0,0,.4);'
  return L.divIcon({
    className: 'map-drawing-point',
    html: `<div style="background:${color};width:${d}px;height:${d}px;border-radius:50%;border:2px solid #fff;${ring}"></div>`,
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

/**
 * a → b の向き [度]。東を 0 とした反時計回り (DXF の TEXT 回転と同じ向き)。
 * 文字が上下逆さにならないよう、-90〜90 度の範囲に丸める。
 */
function bearingDeg(a: LL, b: LL, c?: CoordinateConverter): number {
  let east: number
  let north: number
  if (c) {
    const A = c.toXY(a.lat, a.lng)
    const B = c.toXY(b.lat, b.lng)
    north = B.x - A.x
    east = B.y - A.y
  } else {
    const k = Math.cos(((a.lat + b.lat) / 2 / 180) * Math.PI)
    north = (b.lat - a.lat) * M_PER_DEG_LAT
    east = (b.lng - a.lng) * M_PER_DEG_LAT * k
  }
  let deg = (Math.atan2(north, east) * 180) / Math.PI
  // 真下向きに書かれると読めないので、180 度回して読める向きに揃える
  if (deg > 90) deg -= 180
  if (deg < -90) deg += 180
  return Math.round(deg * 10) / 10
}

/** 基準線を拾う判定の広さ [画面 px] */
const PICK_LINE_RADIUS_PX = 14

/** 点と線分の距離 (画面座標) */
function distancePointToSegmentPx(p: L.Point, a: L.Point, b: L.Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return p.distanceTo(a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** 基準線に選べる図形か (線 / 面 / 手書き) */
function isLineLike(kind: MapDrawingStroke['kind']): boolean {
  return kind === 'stroke' || kind === 'polygon'
}

export function MapDrawingLayer({
  farmId,
  mode,
  color,
  widthPx,
  lineStyle,
  converter,
  layer = '0',
  fontSize,
  onChangeFontSize,
  snapEnabled = false,
  extraSnapPoints,
  onAddCoordinate,
  registerCoordinate = false,
  hidden = false,
  existingLayers,
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
  const updateStrokeAttrs = useMapDrawingStore((s) => s.updateStrokeAttrs)

  const [currentPositions, setCurrentPositions] = useState<[number, number][]>([])
  /** 文字: 線上文字にするか (水平文字なら false)。線上なら 2 点で向きを決める */
  const [textAlongLine, setTextAlongLine] = useState(false)
  /** 文字: 置くときの角度 [度]。反時計回りが正。線上文字なら 2 点目で自動的に入る */
  const [textAngle, setTextAngle] = useState(0)
  /** 文字: 線上文字の 1 点目 (2 点目のクリックで向きが決まる) */
  const [textLineStart, setTextLineStart] = useState<LL | null>(null)
  /** 円: 中心を決めたあとの半径 [m]。数値入力でも、円周上のクリックでも決まる */
  const [circleRadius, setCircleRadius] = useState(10)
  /** 平行線: 選んだ基準線。間隔と本数を決めるまで保持する */
  const [parallelBase, setParallelBase] = useState<[LL, LL] | null>(null)
  /** 平行線の設定。距離は左が正 (地図タップでも数値入力でも決められる) */
  // (パネル表示中の地図タップで間隔を拾う effect は下に置く)
  const [parallelSpacing, setParallelSpacing] = useState(3)
  const [parallelCount, setParallelCount] = useState(1)
  const [parallelBothSides, setParallelBothSides] = useState(false)
  const currentRef = useRef<LatLng[] | null>(null)

  // タップ式の描画で進行中の頂点列 (circle: 中心のみ / arc: [start] or [start,mid] / polygon: [p1..])
  const [shapeProgress, setShapeProgress] = useState<{
    kind: 'circle' | 'arc' | 'polygon' | 'line'
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

  // 文字は 先に 内容を決めてから 地図に置く。
  // マウスを動かすと 置いた時の見え方が そのまま付いてくる (仮表示) ので、
  // 位置と 向きを 見ながら 決められる。
  const [textValue, setTextValue] = useState('')
  const textInputRef = useRef<HTMLInputElement | null>(null)
  /** 文字モードのときの カーソル位置 (仮表示に使う)。指では出ない */
  const [textHover, setTextHover] = useState<LL | null>(null)

  // 文字モードに入ったら 入力欄へ フォーカスする
  useEffect(() => {
    if (mode !== 'text') return
    const id = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [mode])

  // 文字モードの間だけ カーソルを 追う
  useEffect(() => {
    if (mode !== 'text') return
    const onMove = (e: L.LeafletMouseEvent) => {
      setTextHover(snap(e.latlng))
    }
    const onOut = () => setTextHover(null)
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
    return () => {
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      setTextHover(null)
    }
  }, [map, mode, snap])

  // farm 切替時に fetch + 状態リセット
  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
    setShapeProgress(null)
    setSelectedId(null)
    setDragPreview(null)
  }, [farmId, fetchByFarm])

  // モード変更時にモードに合わない状態をクリア
  useEffect(() => {
    if (mode !== 'circle' && mode !== 'arc' && mode !== 'polygon' && mode !== 'line') {
      setShapeProgress(null)
    }
    if (mode !== 'parallel') setParallelBase(null)
    if (mode !== 'text') setTextLineStart(null)
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
    const isPointerDraw = mode === 'pen'
    const isTapDraw =
      mode === 'text' ||
      mode === 'point' ||
      mode === 'line' ||
      mode === 'parallel' ||
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
        const trimmed = textValue.trim()
        // 内容が空のうちは 置かない (先に コマンドバーで 打ってもらう)
        if (!trimmed) {
          textInputRef.current?.focus()
          return
        }
        if (textAlongLine) {
          // 1 点目 = 文字の始点、2 点目 = 向き
          if (!textLineStart) {
            setTextLineStart(at)
            return
          }
          const deg = bearingDeg(textLineStart, at, converter)
          setTextAngle(deg)
          void addText({
            farmId,
            color,
            widthPx,
            lat: textLineStart.lat,
            lng: textLineStart.lng,
            text: trimmed,
            layer,
            fontSize,
            rotationDeg: deg,
          })
          setTextLineStart(null)
          return
        }
        void addText({
          farmId,
          color,
          widthPx,
          lat: at.lat,
          lng: at.lng,
          text: trimmed,
          layer,
          fontSize,
          rotationDeg: textAngle,
        })
        return
      }
      if (mode === 'parallel') {
        // 既存の線 / 面の辺から、クリックに一番近いものを基準線にする
        if (parallelBase) return
        const clickPx = map.latLngToContainerPoint(e.latlng)
        let best: [LL, LL] | null = null
        let bestPx = PICK_LINE_RADIUS_PX
        for (const it of items) {
          if (!isLineLike(it.kind)) continue
          const pts = it.points
          const last = it.kind === 'polygon' ? pts.length : pts.length - 1
          for (let i = 0; i < last; i += 1) {
            const a = pts[i]
            const b = pts[(i + 1) % pts.length]
            const px = distancePointToSegmentPx(
              clickPx,
              map.latLngToContainerPoint([a.lat, a.lng]),
              map.latLngToContainerPoint([b.lat, b.lng]),
            )
            if (px < bestPx) {
              bestPx = px
              best = [a, b]
            }
          }
        }
        if (best) setParallelBase(best)
        return
      }
      if (mode === 'line') {
        const current = shapeProgress?.kind === 'line' ? shapeProgress.points : []
        setShapeProgress({ kind: 'line', points: [...current, at] })
        return
      }
      if (mode === 'circle') {
        if (!shapeProgress || shapeProgress.kind !== 'circle') {
          // 1 回目 = 中心。ここから半径パネルを出す
          setShapeProgress({ kind: 'circle', points: [at] })
        } else {
          // 2 回目以降 = 円周上の点。半径を入れ直すだけで、確定はパネルから
          const center = shapeProgress.points[0]
          setCircleRadius(Math.round(circleRadiusMeters(center, at) * 100) / 100)
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

  /** 詳細入力の差し込み先 (道具アイコンの下のバー) */
  const commandBarEl = useCommandBarEl()

  /** 円を確定する。半径は数値入力でも円周上のクリックでも同じ扱い */
  const commitCircle = useCallback(() => {
    const center = shapeProgress?.kind === 'circle' ? shapeProgress.points[0] : null
    if (!farmId || !center || circleRadius <= 0) return
    void addStroke({
      farmId,
      kind: 'circle',
      color,
      widthPx,
      lineStyle,
      points: [center, edgePointFromRadius(center, circleRadius)],
      layer,
    })
    setShapeProgress(null)
  }, [shapeProgress, farmId, circleRadius, color, widthPx, lineStyle, layer, addStroke])

  /** 頂点をクリックで置く図形 (線 / 面) を確定する。頂点が足りなければ何もしない */
  const commitVertexShape = useCallback(() => {
    if (!farmId || !shapeProgress) return
    const { kind, points } = shapeProgress
    if (kind === 'line' && points.length >= 2) {
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points, layer })
      setShapeProgress(null)
      return
    }
    if (kind === 'polygon' && points.length >= 3) {
      void addStroke({ farmId, kind: 'polygon', color, widthPx, lineStyle, points, layer })
      setShapeProgress(null)
    }
  }, [farmId, shapeProgress, color, widthPx, lineStyle, layer, addStroke])

  // 進行中の描画・計測のキーボード操作
  //   Backspace / Delete … 直前の頂点を取り消す
  //   Enter              … 確定する
  //   Escape             … まるごと取り消す
  useEffect(() => {
    if (!shapeProgress && !parallelBase && measurePoints.length === 0 && !lastMeasure) return
    const onKey = (e: KeyboardEvent) => {
      // 文字入力中のキーは拾わない
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return

      if (e.key === 'Escape') {
        setShapeProgress(null)
        setParallelBase(null)
        setTextLineStart(null)
        setMeasurePoints([])
        setLastMeasure(null)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // ブラウザの「前のページへ戻る」を止める
        e.preventDefault()
        if (shapeProgress) {
          const next = shapeProgress.points.slice(0, -1)
          setShapeProgress(next.length === 0 ? null : { ...shapeProgress, points: next })
        } else if (measurePoints.length > 0) {
          setMeasurePoints(measurePoints.slice(0, -1))
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        commitVertexShape()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [shapeProgress, parallelBase, measurePoints, lastMeasure, commitVertexShape])

  // pen モード: pointer events (フリーハンド)
  useEffect(() => {
    // クリック式に変えたので、ここを通るのはフリーハンドだけ
    if (mode !== 'pen') return
    const container = map.getContainer()

    const activePointers = new Set<number>()
    let drawingPointerId: number | null = null

    const commit = () => {
      const pts = currentRef.current
      currentRef.current = null
      setCurrentPositions([])
      if (!pts || pts.length < 2 || !farmId) return
      // フリーハンドは吸着させない (全点を吸わせると線が壊れるため)
      const geo = pts.map((p) => ({ lat: p.lat, lng: p.lng }))
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points: geo, layer })
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
      currentRef.current.push(latlng)
      setCurrentPositions(currentRef.current.map((p) => [p.lat, p.lng]))
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

  // 線 / 面の描画中に確定ボタンを L.Control として map の右上に表示。
  // キーボードのある PC は Enter で確定できるが、指しか無い端末にも出口が要る
  useEffect(() => {
    if (!shapeProgress) return
    const enough =
      (shapeProgress.kind === 'line' && shapeProgress.points.length >= 2) ||
      (shapeProgress.kind === 'polygon' && shapeProgress.points.length >= 3)
    if (!enough) return

    const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control')
    container.style.cssText =
      'background:white;padding:6px 12px;font-size:12px;font-weight:bold;cursor:pointer;color:#111;border:2px solid rgba(0,0,0,0.2);border-radius:4px;'
    container.innerText =
      shapeProgress.kind === 'line' ? '✓ 線を確定 (Enter)' : '✓ 面を閉じる (Enter)'
    L.DomEvent.on(container, 'click', (ev) => {
      L.DomEvent.stop(ev)
      commitVertexShape()
    })
    L.DomEvent.disableClickPropagation(container)
    const control = new L.Control({ position: 'topright' })
    control.onAdd = () => container
    control.addTo(map)
    return () => {
      control.remove()
    }
  }, [shapeProgress, map, commitVertexShape])

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
          const isSelect = mode === 'select'
          return (
            <Marker
              key={s.id}
              position={[pt.lat, pt.lng]}
              icon={makeTextIcon(
                s.text ?? '',
                s.color,
                s.width_px,
                isEraser || isSelect,
                s.font_size,
                s.rotation_deg,
              )}
              interactive={isEraser || isSelect}
              eventHandlers={
                isEraser
                  ? { click: () => void deleteStroke(s.id) }
                  : isSelect
                    ? { click: () => setSelectedId(s.id) }
                    : undefined
              }
            />
          )
        }

        if (s.kind === 'point') {
          const pt = s.points[0]
          if (!pt) return null
          const isEraser = mode === 'eraser'
          const isSelect = mode === 'select'
          return (
            <Marker
              key={s.id}
              position={[pt.lat, pt.lng]}
              icon={makePointIcon(s.color, s.width_px, isSelect && s.id === selectedId)}
              interactive={isEraser || isSelect}
              eventHandlers={
                isEraser
                  ? { click: () => void deleteStroke(s.id) }
                  : isSelect
                    ? { click: () => setSelectedId(s.id) }
                    : undefined
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
        <>
          {/* 仮の円は点線。確定するまで保存しない */}
          {circleRadius > 0 && (
            <LeafletCircle
              center={[center.lat, center.lng]}
              radius={circleRadius}
              pathOptions={{
                color,
                weight: widthPx,
                opacity: 0.7,
                dashArray: '6,4',
                fill: false,
              }}
              interactive={false}
            />
          )}
          <Marker
            position={[center.lat, center.lng]}
            icon={FIRST_VERTEX_ICON}
            interactive={false}
          />
        </>
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
    // polygon / line (どちらも頂点列をそのまま点線でつなぐ)
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
            key={`vertex-progress-${i}`}
            position={[p.lat, p.lng]}
            icon={i === 0 ? FIRST_VERTEX_ICON : HANDLE_ICON}
            interactive={false}
          />
        ))}
      </>
    )
  }, [shapeProgress, color, widthPx, circleRadius])

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

  /** これから作る平行線の位置。パネルの数値を変えるたびに引き直す */
  const parallelLines = useMemo(() => {
    if (!parallelBase) return []
    const [a, b] = parallelBase
    const signs = parallelBothSides ? [1, -1] : [Math.sign(parallelSpacing) || 1]
    const step = Math.abs(parallelSpacing)
    const out: Array<[LL, LL]> = []
    for (const sign of signs) {
      for (let i = 1; i <= parallelCount; i += 1) {
        const line = offsetLine(a, b, sign * step * i)
        if (line) out.push(line)
      }
    }
    return out
  }, [parallelBase, parallelSpacing, parallelCount, parallelBothSides])

  /** 仮表示している平行線をまとめて保存する */
  const commitParallel = useCallback(() => {
    if (!farmId) return
    for (const line of parallelLines) {
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points: line, layer })
    }
    setParallelBase(null)
  }, [farmId, parallelLines, color, widthPx, lineStyle, layer, addStroke])

  // 平行線の仮表示。基準線は実線の強調、作られる線は点線
  const parallelPreview = useMemo(() => {
    if (!parallelBase) return null
    return (
      <>
        <Polyline
          positions={parallelBase.map((p) => [p.lat, p.lng] as [number, number])}
          pathOptions={{ color: '#6366f1', weight: widthPx + 4, opacity: 0.35 }}
          interactive={false}
        />
        {parallelLines.map((line, i) => (
          <Polyline
            key={`parallel-preview-${i}`}
            positions={line.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={{
              color,
              weight: widthPx,
              opacity: 0.8,
              dashArray: '6,4',
            }}
            interactive={false}
          />
        ))}
      </>
    )
  }, [parallelBase, parallelLines, color, widthPx])

  /** 文字の仮表示 (置く場所と向き)。指では hover が無いので出ない */
  const textGhost = useMemo(() => {
    if (mode !== 'text') return null
    const text = textValue.trim()
    if (!text) return null
    if (textAlongLine && textLineStart) {
      // 1 点目は決まっている → カーソルの方へ向ける
      const angle = textHover ? bearingDeg(textLineStart, textHover, converter) : textAngle
      return { at: textLineStart, angle, text, color }
    }
    if (!textHover) return null
    return { at: textHover, angle: textAlongLine ? 0 : textAngle, text, color }
  }, [mode, textValue, textAlongLine, textLineStart, textHover, textAngle, converter, color])

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
      {parallelPreview}
      {/* 線上文字: 向きを決める 1 点目 */}
      {textLineStart && (
        <Marker
          position={[textLineStart.lat, textLineStart.lng]}
          icon={FIRST_VERTEX_ICON}
          interactive={false}
        />
      )}
      {/* 文字の仮表示。カーソルに付いてきて、置いた時と同じ見え方になる。
          線上文字で 1 点目が決まっていれば、そこを起点にカーソルの方へ向く */}
      {textGhost && (
        <Marker
          position={[textGhost.at.lat, textGhost.at.lng]}
          icon={makeTextIcon(
            textGhost.text,
            textGhost.color,
            widthPx,
            false,
            fontSize,
            textGhost.angle,
          )}
          opacity={0.6}
          interactive={false}
        />
      )}
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
      {/* 今の道具の詳細入力。地図に重ねず、道具アイコンのすぐ下 (ページが置いた
          MapDrawingCommandBar) に 1 行で差し込む。バーが無い画面では出さない */}
      {commandBarEl &&
        createPortal(
          <>
            {/* 文字: 先に 内容と 書き方を 決めて、地図をクリックして 置く。
                クリックする前は カーソルの上に 仮表示が付いてくる */}
            {mode === 'text' && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">文字</span>
                <input
                  ref={textInputRef}
                  type="text"
                  value={textValue}
                  onChange={(ev) => setTextValue(ev.target.value)}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Escape') {
                      setTextValue('')
                      setTextLineStart(null)
                    }
                  }}
                  placeholder="置く文字を入力"
                  className="flex-1 min-w-[8rem] h-7 px-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex items-center rounded border overflow-hidden shrink-0">
                  {([false, true] as const).map((along) => (
                    <button
                      key={String(along)}
                      type="button"
                      onClick={() => {
                        setTextAlongLine(along)
                        setTextLineStart(null)
                        if (!along) setTextAngle(0)
                      }}
                      className={`h-7 px-2 ${
                        textAlongLine === along
                          ? 'bg-blue-600 text-white'
                          : 'bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {along ? '線上文字' : '水平文字'}
                    </button>
                  ))}
                </div>
                {onChangeFontSize && (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">サイズ</span>
                    <input
                      type="range"
                      min={10}
                      max={48}
                      step={1}
                      value={fontSize ?? 14}
                      onChange={(ev) => onChangeFontSize(Number(ev.target.value))}
                      className="w-20"
                    />
                    <span className="font-mono text-[10px] w-6 text-right">{fontSize ?? 14}</span>
                  </label>
                )}
                {/* 線上文字の角度は 2 点目のクリックで入るので、そこでは触らせない */}
                {!textAlongLine && (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">角度</span>
                    <input
                      type="number"
                      step="1"
                      value={textAngle}
                      onChange={(ev) => setTextAngle(Number(ev.target.value))}
                      className="w-16 h-7 px-1 border rounded text-right font-mono"
                    />
                    <span className="text-[11px] text-slate-500">°</span>
                  </label>
                )}
                <span className="text-[11px] text-slate-500 shrink-0">
                  {!textValue.trim()
                    ? '置く文字を入力してください'
                    : textAlongLine
                      ? textLineStart
                        ? '2 点目 (向き) をクリック'
                        : '文字の始点をクリック → 向きの点をクリック'
                      : '地図をクリックで配置 (続けて何個でも置けます)'}
                </span>
                {textValue && (
                  <button
                    type="button"
                    onClick={() => {
                      setTextValue('')
                      setTextLineStart(null)
                    }}
                    className="h-7 px-2 rounded border text-slate-600 shrink-0"
                  >
                    クリア
                  </button>
                )}
              </>
            )}

            {/* 円: 半径。数値でも、円周上のクリックでも決まる */}
            {shapeProgress?.kind === 'circle' && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">円</span>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">半径 (m)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min={0}
                    value={circleRadius}
                    onChange={(ev) => setCircleRadius(Math.max(0, Number(ev.target.value)))}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') commitCircle()
                    }}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <span className="text-[11px] text-slate-500 shrink-0">
                  円周上をクリックしても決まります
                </span>
                <button
                  type="button"
                  disabled={circleRadius <= 0}
                  onClick={commitCircle}
                  className="h-7 px-3 rounded bg-indigo-600 text-white disabled:opacity-40 shrink-0"
                >
                  確定
                </button>
                <button
                  type="button"
                  onClick={() => setShapeProgress(null)}
                  className="h-7 px-2 rounded border text-slate-600 shrink-0"
                >
                  やめる
                </button>
              </>
            )}

            {/* 平行線: 基準線を選ぶ前 */}
            {mode === 'parallel' && !parallelBase && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">平行線</span>
                <span className="text-[11px] text-slate-500">
                  基準にする線 (または面の辺) をクリックしてください
                </span>
              </>
            )}

            {/* 平行線: 幅 / 本数 / 両側 */}
            {parallelBase && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">平行線</span>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">幅 (m)</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={parallelSpacing}
                    onChange={(ev) => setParallelSpacing(Number(ev.target.value))}
                    onKeyDown={(ev) => {
                      if (ev.key === 'Enter') commitParallel()
                    }}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">本数</span>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={parallelCount}
                    onChange={(ev) =>
                      setParallelCount(Math.max(1, Math.min(20, Number(ev.target.value))))
                    }
                    className="w-14 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 shrink-0 text-slate-700">
                  <input
                    type="checkbox"
                    checked={parallelBothSides}
                    onChange={(ev) => setParallelBothSides(ev.target.checked)}
                  />
                  両側
                </label>
                <span className="text-[11px] text-slate-500 shrink-0">
                  通過点をクリックしても決まります
                </span>
                <button
                  type="button"
                  onClick={commitParallel}
                  className="h-7 px-3 rounded bg-indigo-600 text-white shrink-0"
                >
                  確定
                </button>
                <button
                  type="button"
                  onClick={() => setParallelBase(null)}
                  className="h-7 px-2 rounded border text-slate-600 shrink-0"
                >
                  やめる
                </button>
              </>
            )}

            {/* 計測: 案内と結果 */}
            {isMeasureMode(mode) && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">
                  {mode === 'measure-dist' ? '距離' : mode === 'measure-area' ? '面積' : '垂線'}
                </span>
                {lastMeasure ? (
                  <span className="font-bold text-rose-600 tabular-nums">
                    {formatMeasure(lastMeasure)}
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">
                    {mode === 'measure-dist'
                      ? '2 点をクリック'
                      : mode === 'measure-area'
                        ? `頂点をクリック (${measurePoints.length}) → 最初の点をもう一度クリックで確定`
                        : '基準線の 2 点 → 対象の 1 点をクリック'}
                  </span>
                )}
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
                    className="h-7 px-3 rounded bg-rose-600 text-white shrink-0"
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
                  className="h-7 px-2 rounded border text-slate-600 shrink-0"
                >
                  クリア
                </button>
              </>
            )}

            {/* 選択: 選んだ図形の属性を後から変える */}
            {mode === 'select' && selectedStroke && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">
                  {KIND_LABEL[selectedStroke.kind]}
                </span>

                {selectedStroke.kind === 'text' && (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">文字</span>
                    <input
                      key={`text-${selectedStroke.id}`}
                      type="text"
                      defaultValue={selectedStroke.text ?? ''}
                      onBlur={(ev) => {
                        const v = ev.target.value.trim()
                        if (v && v !== selectedStroke.text) {
                          void updateStrokeAttrs(selectedStroke.id, { text: v })
                        }
                      }}
                      className="w-32 h-7 px-2 border rounded"
                    />
                  </label>
                )}

                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">レイヤ</span>
                  <input
                    key={`layer-${selectedStroke.id}`}
                    type="text"
                    defaultValue={selectedStroke.layer ?? '0'}
                    onBlur={(ev) => {
                      const v = ev.target.value.trim() || '0'
                      if (v !== selectedStroke.layer) {
                        void updateStrokeAttrs(selectedStroke.id, { layer: v })
                      }
                    }}
                    list="map-drawing-layers-inspector"
                    className="w-20 h-7 px-1 border rounded font-mono"
                  />
                </label>

                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">色</span>
                  <input
                    type="color"
                    value={selectedStroke.color}
                    onChange={(ev) =>
                      void updateStrokeAttrs(selectedStroke.id, { color: ev.target.value })
                    }
                    className="w-8 h-7 p-0 border rounded cursor-pointer"
                  />
                </label>

                {selectedStroke.kind !== 'text' && selectedStroke.kind !== 'point' && (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">線種</span>
                    <select
                      value={selectedStroke.line_style ?? 'solid'}
                      onChange={(ev) =>
                        void updateStrokeAttrs(selectedStroke.id, {
                          lineStyle: ev.target.value as LineStyle,
                        })
                      }
                      className="h-7 px-1 border rounded"
                    >
                      <option value="solid">実線</option>
                      <option value="dashed">破線</option>
                      <option value="dotted">点線</option>
                    </select>
                  </label>
                )}

                {selectedStroke.kind === 'text' && (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">角度</span>
                    <input
                      key={`rot-${selectedStroke.id}`}
                      type="number"
                      step="1"
                      defaultValue={selectedStroke.rotation_deg ?? 0}
                      onBlur={(ev) => {
                        const v = Number(ev.target.value) || 0
                        if (v !== selectedStroke.rotation_deg) {
                          void updateStrokeAttrs(selectedStroke.id, { rotationDeg: v })
                        }
                      }}
                      className="w-16 h-7 px-1 border rounded text-right font-mono"
                    />
                    <span className="text-[11px] text-slate-500">°</span>
                  </label>
                )}

                {selectedStroke.kind === 'text' ? (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">サイズ</span>
                    <input
                      type="range"
                      min={10}
                      max={48}
                      step={1}
                      value={selectedStroke.font_size ?? 14}
                      onChange={(ev) =>
                        void updateStrokeAttrs(selectedStroke.id, {
                          fontSize: Number(ev.target.value),
                        })
                      }
                      className="w-16"
                    />
                    <span className="font-mono text-[10px] w-6 text-right">
                      {selectedStroke.font_size ?? 14}
                    </span>
                  </label>
                ) : (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">太さ</span>
                    <input
                      type="range"
                      min={1}
                      max={20}
                      step={1}
                      value={selectedStroke.width_px}
                      onChange={(ev) =>
                        void updateStrokeAttrs(selectedStroke.id, {
                          widthPx: Number(ev.target.value),
                        })
                      }
                      className="w-16"
                    />
                    <span className="font-mono text-[10px] w-6 text-right">
                      {selectedStroke.width_px}
                    </span>
                  </label>
                )}

                <button
                  type="button"
                  onClick={() => {
                    void deleteStroke(selectedStroke.id)
                    setSelectedId(null)
                  }}
                  className="h-7 px-3 rounded border border-red-300 text-red-600 hover:bg-red-50 shrink-0"
                >
                  削除
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="h-7 px-2 rounded border text-slate-600 shrink-0"
                >
                  閉じる
                </button>

                <datalist id="map-drawing-layers-inspector">
                  {Array.from(
                    new Set([...DEFAULT_LAYERS, ...(existingLayers ?? []), '0']),
                  ).map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </>
            )}
          </>,
          commandBarEl,
        )}
    </Pane>
  )
}
