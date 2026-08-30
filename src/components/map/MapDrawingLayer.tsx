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
//   ・'rect'    長方形。縦横をメートルで入れ、開始点 → 向きの点 の 2 クリックで置く。
//               保存は 4 頂点の polygon なので、あとから頂点も動かせる。
//   ・'perp'    垂線。基準線をクリック → 通過点をクリック → 延長を入れるか終点をクリック。
//               基準線への垂線の足を起点に、通過点の側へ伸ばす。
//   ・'text'    先に内容と書き方 (水平文字 / 線上文字) を決め、地図をクリックして置く。
//               クリック前はカーソルに仮表示が付いてくる (置いた時と同じ見え方)。
//               線上文字は 始点 → 向きの点 の 2 クリックで方位に合わせる。
//   ・'point'   タップした点に点を置く。registerCoordinate が true なら
//               onAddCoordinate も呼び、座標管理にも登録する。
//   ・'select'  図形を選ぶ。選び方は 点 / 線 / 長方形 / 多角形 の 4 通り。
//               点は 1 つずつ (Shift か Ctrl で 足し引き)、他は 囲った形に
//               かかった図形を まとめて 選ぶ。
//               選んだものは「移動」「コピー」で 始点 → 終点 の 2 クリックで
//               平行移動 / 複製 できる。
//               1 つだけ選んだときは 青ハンドルをドラッグで頂点移動 / 長押しで削除 /
//               辺の中点の「+」タップで頂点追加 (直線・円・円弧は追加/削除不可、位置移動のみ)。
//               属性 (レイヤ / 色 / 線種 / 線幅 / 矢印) は 左パネルの「描画の設定」
//               (モバイルは ツールバー) で 変える。何も選んでいなければ
//               これから描くものの 設定として 働く。
//               連続線は 端点の少し上に出る 橙ハンドル (↔) で 伸縮できる
//               (端点そのものは 青い移動ハンドルのまま。重ならないよう離す)。
//               長さ / 増減 (＋で伸び −で縮む) を入れるか、対象の線・円をクリックして
//               その延長線との 交点まで、あるいは 何もない所をクリックして そこまで。
//               交点が 複数のときは 青い候補点で 残す側を選ぶ。
//               連続線と 円弧は 端部を 矢印 (なし / 始点 / 終点 / 両端) にもできる。
//               操作ハンドルは 線より上のペインに出す (線の裏に回らないように)。
//   ・'eraser'  アイテムをクリックで削除。
//   ・'measure-dist' / 'measure-area' / 'measure-perp'
//               計測。結果は保存せず、モードを抜けるまで地図上に表示する。
//               距離は 2 点を指す / 既存の線をまるごと選ぶ の 2 通り。値は線の
//               向きに沿わせて出す。連続線は 各辺 / 合計 を チェックで 選べる。
//               「文字として保存」で、同じ位置・向きの文字要素として残せる。
//
// ピック (snapEnabled): 単点 / 交点 / 中心点 / 線上 に吸着する (snapTypes で選ぶ)。
// 相手は ペイントの図形に加えて、extraSnapPoints (測点・区域の頂点) と
// extraSegments (区域の辺) も 含む。
// 判定は画面 px なので、縮尺が変わっても指の感覚は変わらない。吸着先の座標は
// メートル座標で出すので、交点・線上でも測量に使える精度が残る。
// 描くときだけでなく、選択して頂点をドラッグするときも吸着する。
// フリーハンドは吸着しない (全点を吸わせると線が壊れるため)。
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
  DEFAULT_SNAP_TYPES,
  KIND_LABEL,
  type ArrowStyle,
  type SnapType,
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
  | 'rect'
  | 'parallel'
  | 'perp'
  | 'text'
  | 'point'
  | 'select'
  | 'eraser'
  | 'measure-dist'
  | 'measure-area'
  | 'measure-perp'

/** 計測モードかどうか */
/** 選択の仕方 */
export type SelectMethod = 'point' | 'line' | 'rect' | 'polygon'

export const SELECT_METHOD_LABEL: Record<SelectMethod, string> = {
  point: '点',
  line: '線',
  rect: '長方形',
  polygon: '多角形',
}

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
  /** 吸着させる対象の種類。未指定なら既定 (単点 / 交点 / 中心点) */
  snapTypes?: SnapType[]
  /** 図形以外のスナップ候補 (座標管理の点・区域の頂点など) */
  extraSnapPoints?: Array<[number, number]>
  /**
   * 図形以外の 線分 (区域ポリゴンの辺など)。
   * 交点 / 線上の ピックで ペイントの線と 同じように 相手にする。
   */
  extraSegments?: Array<[LL, LL]>
  /**
   * 'point' で 点を置いた時に 座標管理へも 登録する。
   * 未指定なら 登録機能そのものを 出さない (この画面に 座標管理が無い場合)
   */
  onAddCoordinate?: (lat: number, lng: number) => void
  /** 'point' で 座標管理にも 登録するか (チェックボックスの状態) */
  registerCoordinate?: boolean
  /** true のとき既存のペイントを地図に出さない (道具の入力受付は継続) */
  hidden?: boolean
  /**
   * レイヤの重ね順。先頭ほど 上に 描く。
   * 一覧に無いレイヤは 一番下に 回す。未指定なら 作成順のまま。
   */
  layerOrder?: string[]
  /** これから引く線に付ける 端部の矢印 */
  arrow?: ArrowStyle
  /** 選択の仕方。点で 1 つずつ / 線・長方形・多角形で まとめて */
  selectMethod?: SelectMethod
  /** 選択が変わったら 呼ぶ。左パネルで まとめて属性を 変えるために使う */
  onSelectionChange?: (ids: string[]) => void
  /** 表示しないレイヤ */
  hiddenLayers?: string[]
  /**
   * レイヤごとの重ね順 (Leaflet の pane zIndex)。
   * 渡されたレイヤは 専用ペインに入るので、地図の他の要素 (測点 / 写真 …) と
   * 間に 挟むように 並べられる。未指定なら 全部 既定のペインに 描く。
   */
  layerZIndex?: Record<string, number>
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
  html: '<div style="width:18px;height:18px;border-radius:50%;background:#22c55e;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.6);color:white;font-size:13px;font-weight:bold;line-height:14px;text-align:center;">+</div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

/**
 * ハンドル: 端部の伸縮用 (橙の両矢印)。
 * 端点そのものには 青い移動ハンドルが 乗っているので、真上に ずらして描く。
 * ずらした先が 当たり判定になるので、両方 別々に 掴める。
 */
const STRETCH_ICON = L.divIcon({
  className: 'map-drawing-stretch',
  html: '<div style="width:22px;height:22px;border-radius:4px;background:#f97316;border:2px solid white;box-shadow:0 0 5px rgba(0,0,0,0.6);color:white;font-size:13px;font-weight:bold;line-height:18px;text-align:center;">↔</div>',
  iconSize: [26, 26],
  iconAnchor: [13, 38],
})

/** ハンドル: 伸縮の候補点 (どこまで伸ばすかを選ばせる) */
const CANDIDATE_ICON = L.divIcon({
  className: 'map-drawing-candidate',
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#0ea5e9;border:2px solid white;box-shadow:0 0 5px rgba(0,0,0,0.6);"></div>',
  iconSize: [20, 20],
  iconAnchor: [10, 10],
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
  /** m または m²。距離のときは 全体の合計 */
  value: number
  /** 値を表示する位置 */
  labelAt: LL
  /** 垂線の足 (perp のときのみ) */
  foot?: LL
  /**
   * 距離のときの 各辺。2 点を測ったときは 1 本、連続線を測ったときは その本数。
   * 各辺を出すか / 合計を出すか / 両方かを 切り替えられるようにするため、
   * 表示用の 文字は 持たず、素の値だけを 残す。
   */
  segments?: Array<{ a: LL; b: LL; value: number }>
}

/** 地図に出す 1 つのラベル (線の向きに沿わせる) */
interface MeasureLabel {
  at: LL
  /** 回転角 [度]。反時計回りが正 */
  angle: number
  text: string
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

/** 長さの表示文字列 */
function formatLength(v: number): string {
  if (v < 1) return `${(v * 100).toFixed(1)} cm`
  return `${v.toFixed(3)} m`
}

/** 計測値の表示文字列 */
export function formatMeasure(m: MeasureResult): string {
  if (m.kind === 'area') {
    return `${m.value.toFixed(2)} m² (${(m.value / 10000).toFixed(4)} ha)`
  }
  return formatLength(m.value)
}

/**
 * 計測値のラベル (地図上に置く白フキダシ)。
 * 線の向きに沿わせたいので、回転角を受け取れるようにする。
 */
function makeMeasureLabelIcon(text: string, color: string, rotationDeg = 0): L.DivIcon {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // CSS の rotate は時計回りが正なので符号を反転する
  const rot = rotationDeg ? ` rotate(${-rotationDeg}deg)` : ''
  return L.divIcon({
    className: 'map-measure-label',
    html: `<div style="
      background:rgba(255,255,255,.92);border:1px solid ${color};color:${color};
      font-size:12px;font-weight:700;padding:1px 5px;border-radius:3px;
      white-space:nowrap;transform:translate(-50%,-50%)${rot};box-shadow:0 1px 2px rgba(0,0,0,.2)
    ">${esc}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  })
}

/** 頂点列を 辺ごとの長さに 分解する */
function buildSegments(
  verts: LL[],
  c?: CoordinateConverter,
): Array<{ a: LL; b: LL; value: number }> {
  const out: Array<{ a: LL; b: LL; value: number }> = []
  for (let i = 0; i < verts.length - 1; i += 1) {
    out.push({ a: verts[i], b: verts[i + 1], value: measureDist(c, verts[i], verts[i + 1]) })
  }
  return out
}

/** 2 点の中点 */
function midLL(a: LL, b: LL): LL {
  return { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }
}

/**
 * 線の端部に付ける矢印。地図の縮尺で 大きさが 変わらないよう、
 * メートルの図形ではなく 画面固定サイズの divIcon で 描く。
 * rotationDeg は 反時計回りが正 (東が 0)。
 */
function makeArrowIcon(color: string, widthPx: number, rotationDeg: number): L.DivIcon {
  const len = Math.max(10, 8 + widthPx * 1.6)
  const half = Math.max(4, 3 + widthPx * 0.7)
  const box = Math.ceil(len * 2 + 4)
  const cx = box / 2
  const cy = box / 2
  // 東向き (+x) の三角を作り、CSS で回す。CSS は時計回りが正なので符号を反転
  const pts = `${cx + len},${cy} ${cx - len * 0.2},${cy - half} ${cx - len * 0.2},${cy + half}`
  return L.divIcon({
    className: 'map-drawing-arrow',
    html: `<svg width="${box}" height="${box}" viewBox="0 0 ${box} ${box}" style="transform:rotate(${-rotationDeg}deg);overflow:visible">
      <polygon points="${pts}" fill="${color}" />
    </svg>`,
    iconSize: [box, box],
    iconAnchor: [cx, cy],
  })
}

/** 矢印を出す端の一覧 */
function arrowEnds(arrow: ArrowStyle | null | undefined): Array<'start' | 'end'> {
  if (arrow === 'start') return ['start']
  if (arrow === 'end') return ['end']
  if (arrow === 'both') return ['start', 'end']
  return []
}

// ---- まとめて選択 ----
//
// 点で 1 つずつ選ぶほかに、線 / 長方形 / 多角形で 囲って まとめて選べるようにする。
// 当たり判定は 画面座標で行う。縮尺に関係なく 見たとおりに 掴めるため。

/** 図形を 画面座標の 折れ線と 単独点に ばらす */
function itemScreenGeometry(
  map: L.Map,
  s: MapDrawingStroke,
): { lines: L.Point[][]; points: L.Point[] } {
  const toPx = (p: LL) => map.latLngToContainerPoint([p.lat, p.lng])
  const pts = s.points
  if (pts.length === 0) return { lines: [], points: [] }

  if (s.kind === 'text' || s.kind === 'point') {
    return { lines: [], points: [toPx(pts[0])] }
  }
  if (s.kind === 'circle') {
    if (pts.length < 2) return { lines: [], points: [] }
    const c = toPx(pts[0])
    const r = c.distanceTo(toPx(pts[1]))
    // 円は 32 角形で 近似する
    const ring: L.Point[] = []
    for (let i = 0; i <= 32; i += 1) {
      const t = (i / 32) * Math.PI * 2
      ring.push(L.point(c.x + r * Math.cos(t), c.y + r * Math.sin(t)))
    }
    return { lines: [ring], points: [] }
  }
  if (s.kind === 'arc') {
    if (pts.length < 3) return { lines: [], points: [] }
    const arc = arcThroughPoints(pts[0], pts[1], pts[2])
    return { lines: [arc.map(([lat, lng]) => toPx(({ lat, lng })))], points: [] }
  }
  const line = pts.map(toPx)
  if (s.kind === 'polygon' && line.length >= 3) line.push(line[0])
  return { lines: [line], points: [] }
}

/** 線分 ab と cd が 交わるか (画面座標) */
function segCross(a: L.Point, b: L.Point, c: L.Point, d: L.Point): boolean {
  const cross = (p: L.Point, q: L.Point, r: L.Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  const d1 = cross(a, b, c)
  const d2 = cross(a, b, d)
  const d3 = cross(c, d, a)
  const d4 = cross(c, d, b)
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))
}

/** 点が 多角形の中に あるか (画面座標) */
function pointInPolygonPx(p: L.Point, poly: L.Point[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

/** 図形が 線分に 触れているか */
function hitByLinePx(
  geom: { lines: L.Point[][]; points: L.Point[] },
  a: L.Point,
  b: L.Point,
): boolean {
  for (const line of geom.lines) {
    for (let i = 0; i < line.length - 1; i += 1) {
      if (segCross(line[i], line[i + 1], a, b)) return true
    }
  }
  // 単独の点は 線から 近ければ 拾う
  for (const p of geom.points) {
    if (distancePointToSegmentPx(p, a, b) < PICK_LINE_RADIUS_PX) return true
  }
  return false
}

/** 図形が 多角形 (長方形も含む) に かかっているか */
function hitByPolygonPx(
  geom: { lines: L.Point[][]; points: L.Point[] },
  poly: L.Point[],
): boolean {
  if (poly.length < 3) return false
  for (const p of geom.points) if (pointInPolygonPx(p, poly)) return true
  for (const line of geom.lines) {
    // 頂点が 中に入っていれば 選ぶ (完全に囲まれた図形)
    for (const v of line) if (pointInPolygonPx(v, poly)) return true
    // 辺が 交差していれば 選ぶ (またいでいる図形)
    for (let i = 0; i < line.length - 1; i += 1) {
      for (let j = 0, k = poly.length - 1; j < poly.length; k = j, j += 1) {
        if (segCross(line[i], line[i + 1], poly[k], poly[j])) return true
      }
    }
  }
  return false
}

/** Shift / Ctrl (Mac は Cmd) 押しなら 選択に 足し引きする */
function isAdditiveClick(ev: L.LeafletMouseEvent): boolean {
  const oe = ev.originalEvent as MouseEvent | undefined
  return Boolean(oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey))
}

/** 2 点から 長方形の 4 頂点 (画面座標) */
function rectFromCorners(a: L.Point, b: L.Point): L.Point[] {
  return [L.point(a.x, a.y), L.point(b.x, a.y), L.point(b.x, b.y), L.point(a.x, b.y)]
}

/** ピックの吸着範囲 [画面 px]。指でも届き、隣の点を誤って掴まない程度 */
const SNAP_RADIUS_PX = 18
/** 交点 / 線上を探すときに、相手にする線分を絞る広さ [画面 px] */
const SNAP_SEARCH_PX = 40

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

/** a → b の向き [度]。東を 0 とした反時計回り。丸めをしない生の値 */
function bearingRawDeg(a: LL, b: LL, c?: CoordinateConverter): number {
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
  return (Math.atan2(north, east) * 180) / Math.PI
}

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

/** メートルの東西/南北ずれから 緯度経度を作る (短距離なので平面近似で足りる) */
function offsetLL(from: LL, eastM: number, northM: number, c?: CoordinateConverter): LL {
  if (c) {
    const p = c.toXY(from.lat, from.lng)
    return c.toLatLng(p.x + northM, p.y + eastM)
  }
  const k = Math.cos((from.lat * Math.PI) / 180)
  return {
    lat: from.lat + northM / M_PER_DEG_LAT,
    lng: from.lng + eastM / (M_PER_DEG_LAT * k),
  }
}

/** a → b の 東西/南北 成分 [m] */
function deltaM(a: LL, b: LL, c?: CoordinateConverter): { east: number; north: number } {
  if (c) {
    const A = c.toXY(a.lat, a.lng)
    const B = c.toXY(b.lat, b.lng)
    return { east: B.y - A.y, north: B.x - A.x }
  }
  const k = Math.cos(((a.lat + b.lat) / 2 / 180) * Math.PI)
  return {
    east: (b.lng - a.lng) * M_PER_DEG_LAT * k,
    north: (b.lat - a.lat) * M_PER_DEG_LAT,
  }
}

/**
 * 長方形の 4 頂点。start を 1 つの角にし、start → toward の向きを「横」、
 * その左 90 度を「縦」とする。
 */
function rectPoints(
  start: LL,
  toward: LL,
  widthM: number,
  heightM: number,
  c?: CoordinateConverter,
): LL[] | null {
  const d = deltaM(start, toward, c)
  const len = Math.hypot(d.east, d.north)
  if (len < 1e-6 || widthM <= 0 || heightM <= 0) return null
  // 横方向の単位ベクトルと、その左 90 度 (縦方向)
  const ux = d.east / len
  const uy = d.north / len
  const vx = -uy
  const vy = ux
  const p1 = start
  const p2 = offsetLL(start, ux * widthM, uy * widthM, c)
  const p3 = offsetLL(start, ux * widthM + vx * heightM, uy * widthM + vy * heightM, c)
  const p4 = offsetLL(start, vx * heightM, vy * heightM, c)
  return [p1, p2, p3, p4]
}

/**
 * 垂線の形。基準線への垂線の足を起点に、通過点の側へ lengthM だけ伸ばす。
 * 通過点が 基準線の上に乗っていて 向きが決まらないときは、基準線の左 90 度に取る。
 */
function perpGeometry(
  base: [LL, LL],
  through: LL,
  lengthM: number,
  c?: CoordinateConverter,
): { foot: LL; end: LL; ux: number; uy: number } | null {
  const { foot } = measurePerp(c, base[0], base[1], through)
  let d = deltaM(foot, through, c)
  let len = Math.hypot(d.east, d.north)
  if (len < 1e-6) {
    // 通過点が線上 → 基準線の左 90 度を向きにする
    const ab = deltaM(base[0], base[1], c)
    const abLen = Math.hypot(ab.east, ab.north)
    if (abLen < 1e-6) return null
    d = { east: -ab.north / abLen, north: ab.east / abLen }
    len = 1
  }
  const ux = d.east / len
  const uy = d.north / len
  return { foot, end: offsetLL(foot, ux * lengthM, uy * lengthM, c), ux, uy }
}

// ---- 端部の伸縮 ----
//
// 端点を、その端の線分の向き (直線) の上で 前後に動かす。行き先は
//   ・長さを 数値で 入れる
//   ・他の要素 (線 / 円) を クリックして、その要素との 交点まで
// の 2 通り。交点が 複数あるときは、どれにするかを 選ばせる。
//
// 対象は 線分そのものではなく その延長線と 交わらせる。ab の b を伸ばすとき、
// cd が 実際にぶつかっていなくても cd の延長線上まで 伸ばせる (CAD と同じ)。
// どこまで延ばしたかが 分かるよう、対象の延長は 灰色の点線で 見せる。
//
// 計算は 起点 (動かさない側の隣の頂点) を 原点にした メートル座標で行う。

/**
 * 原点から 単位方向 (ux, uy) に伸びる直線と、a-b を通る直線の交点までの距離 [m]。
 * 平行なときは null。
 *
 * a-b の「線分の中」に限定しないのが要点。ab の b を伸ばすとき、cd が
 * 実際にぶつかっていなくても cd の延長線上まで 伸ばせるようにする。
 * どの要素を 対象にするかは、クリック位置で 先に 絞ってある。
 */
function intersectLineThrough(
  origin: LL,
  ux: number,
  uy: number,
  a: LL,
  b: LL,
  c?: CoordinateConverter,
): number | null {
  const A = deltaM(origin, a, c)
  const B = deltaM(origin, b, c)
  const dx = B.east - A.east
  const dy = B.north - A.north
  const det = dx * uy - ux * dy
  if (Math.abs(det) < 1e-9) return null
  return (dx * A.north - dy * A.east) / det
}

/** 同じく、中心 center / 半径 r の円との交点までの距離 [m] (0〜2 個) */
function intersectCircle(
  origin: LL,
  ux: number,
  uy: number,
  center: LL,
  radiusM: number,
  c?: CoordinateConverter,
): number[] {
  const C = deltaM(origin, center, c)
  const proj = C.east * ux + C.north * uy
  const disc = proj * proj - (C.east * C.east + C.north * C.north - radiusM * radiusM)
  if (disc < 0) return []
  if (disc === 0) return [proj]
  const root = Math.sqrt(disc)
  return [proj - root, proj + root]
}

/**
 * 線分 [a, b] を、点 p の位置まで届くように 延ばした 2 点を返す。
 * 「実際にはぶつかっていない相手まで伸ばした」ことを 見せるための 補助線に使う。
 */
function extendThrough(seg: [LL, LL], p: LL, c?: CoordinateConverter): [LL, LL] {
  const [a, b] = seg
  const ab = deltaM(a, b, c)
  const len = Math.hypot(ab.east, ab.north)
  if (len < 1e-6) return seg
  const ux = ab.east / len
  const uy = ab.north / len
  const ap = deltaM(a, p, c)
  const t = ap.east * ux + ap.north * uy
  // a を 0、b を len としたときの、p の射影位置 t を含む範囲まで広げる
  const lo = Math.min(0, len, t)
  const hi = Math.max(0, len, t)
  return [offsetLL(a, ux * lo, uy * lo, c), offsetLL(a, ux * hi, uy * hi, c)]
}

/** 3 点を通る円の中心。3 点が一直線なら null */
function circumcenterLL(a: LL, b: LL, c: LL, conv?: CoordinateConverter): LL | null {
  const B = deltaM(a, b, conv)
  const C = deltaM(a, c, conv)
  const d = 2 * (B.east * C.north - B.north * C.east)
  if (Math.abs(d) < 1e-9) return null
  const b2 = B.east * B.east + B.north * B.north
  const c2 = C.east * C.east + C.north * C.north
  const east = (C.north * b2 - B.north * c2) / d
  const north = (B.east * c2 - C.east * b2) / d
  return offsetLL(a, east, north, conv)
}

/** 線分 ab の上で、p に一番近い点 */
function closestOnSegment(a: LL, b: LL, p: LL, conv?: CoordinateConverter): LL {
  const ab = deltaM(a, b, conv)
  const ap = deltaM(a, p, conv)
  const len2 = ab.east * ab.east + ab.north * ab.north
  if (len2 < 1e-12) return a
  let t = (ap.east * ab.east + ap.north * ab.north) / len2
  t = Math.max(0, Math.min(1, t))
  return offsetLL(a, ab.east * t, ab.north * t, conv)
}

/** 線分どうしの交点。どちらかの外に出るなら null (延長線上は取らない) */
function segmentIntersection(
  s1: [LL, LL],
  s2: [LL, LL],
  conv?: CoordinateConverter,
): LL | null {
  const origin = s1[0]
  const r = deltaM(origin, s1[1], conv)
  const q = deltaM(origin, s2[0], conv)
  const q2 = deltaM(origin, s2[1], conv)
  const sVec = { east: q2.east - q.east, north: q2.north - q.north }
  const denom = r.east * sVec.north - r.north * sVec.east
  if (Math.abs(denom) < 1e-9) return null
  const t = (q.east * sVec.north - q.north * sVec.east) / denom
  const u = (q.east * r.north - q.north * r.east) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return offsetLL(origin, r.east * t, r.north * t, conv)
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

/**
 * 数値入力。既に入っている値を 選び直さずに 打てるようにする。
 *
 * 素の controlled input だと、消した瞬間に Number('') = 0 で 0 に戻り、
 * 「0 が残っていて 数字が打てない」状態になる。入力中は 文字列のまま持ち、
 * 数値として読めたときだけ 親へ返す。フォーカス時に 全選択もする。
 */
function NumberField({
  value,
  onChange,
  onEnter,
  step = '0.1',
  min,
  max,
  className = '',
}: {
  value: number
  onChange: (v: number) => void
  onEnter?: () => void
  step?: string
  min?: number
  max?: number
  className?: string
}) {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <input
      type="number"
      inputMode="decimal"
      step={step}
      min={min}
      max={max}
      value={draft ?? String(value)}
      onFocus={(e) => {
        setDraft(String(value))
        e.currentTarget.select()
      }}
      onChange={(e) => {
        const raw = e.target.value
        setDraft(raw)
        if (raw === '' || raw === '-') return
        const n = Number(raw)
        if (!Number.isFinite(n)) return
        let next = n
        if (min !== undefined) next = Math.max(min, next)
        if (max !== undefined) next = Math.min(max, next)
        onChange(next)
      }}
      onBlur={() => setDraft(null)}
      onKeyDown={(e) => {
        // ここで blur しない。入力欄に居るうちは グローバルの Enter が
        // 素通りするので、確定が 二重に 走らない
        if (e.key === 'Enter') onEnter?.()
      }}
      className={className}
    />
  )
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
  snapTypes = DEFAULT_SNAP_TYPES,
  extraSnapPoints,
  extraSegments,
  onAddCoordinate,
  registerCoordinate = false,
  hidden = false,
  layerOrder,
  arrow = 'none',
  selectMethod = 'point',
  onSelectionChange,
  hiddenLayers,
  layerZIndex,
}: Props) {
  const map = useMap()
  const allItems = useMapDrawingStore((s) =>
    farmId ? s.byFarm.get(farmId) ?? EMPTY_STROKES : EMPTY_STROKES,
  )

  // レイヤの重ね順に 並べ替える。Leaflet は 後から足したものが 上に来るので、
  // 一覧で 上にあるレイヤほど 後ろに 回す。非表示レイヤは ここで 落とす。
  const items = useMemo(() => {
    const hiddenSet = hiddenLayers && hiddenLayers.length > 0 ? new Set(hiddenLayers) : null
    const visible = hiddenSet
      ? allItems.filter((it) => !hiddenSet.has(it.layer ?? '0'))
      : allItems
    if (!layerOrder || layerOrder.length === 0) return visible
    const rank = new Map(layerOrder.map((l, i) => [l, i]))
    const bottom = layerOrder.length
    // 元の並び (作成順) を 崩さないよう、安定ソートで レイヤ順だけ 入れ替える
    return [...visible].sort(
      (a, b) =>
        (rank.get(b.layer ?? '0') ?? bottom) - (rank.get(a.layer ?? '0') ?? bottom),
    )
  }, [allItems, layerOrder, hiddenLayers])
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
  /** 長方形: 縦横 [m] と、決めた開始点 (角) */
  const [rectWidth, setRectWidth] = useState(10)
  const [rectHeight, setRectHeight] = useState(5)
  const [rectStart, setRectStart] = useState<LL | null>(null)
  /** 垂線: 基準線 / 通過点 / 延長 [m] */
  const [perpBase, setPerpBase] = useState<[LL, LL] | null>(null)
  const [perpThrough, setPerpThrough] = useState<LL | null>(null)
  const [perpLength, setPerpLength] = useState(10)
  /** 端部の伸縮: どちらの端を動かしているか。null なら伸縮していない */
  const [stretchEnd, setStretchEnd] = useState<'start' | 'end' | null>(null)
  const stretching = stretchEnd !== null
  /** 端部の伸縮: 起点から端点までの長さ [m] */
  const [stretchLength, setStretchLength] = useState(0)
  /** 端部の伸縮: 交点が複数あるときの候補 (起点からの距離 [m]) */
  const [stretchCandidates, setStretchCandidates] = useState<number[]>([])
  /** 端部の伸縮: 対象に選んだ線分。延長線を見せるために覚えておく */
  const [stretchTarget, setStretchTarget] = useState<[LL, LL] | null>(null)
  /** 長方形・垂線でカーソルを追うための位置 (仮表示に使う) */
  const [shapeHover, setShapeHover] = useState<LL | null>(null)
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
  // 吸着先は 4 種類。どれを使うかは snapTypes で 切り替える。
  //   ・単点   … 作図の頂点 + 外から渡された点 (測点・区域の頂点)
  //   ・交点   … 近くにある 線分どうしの 交点 (区域の辺も 相手にする)
  //   ・中心点 … 円 / 円弧の 中心
  //   ・線上   … 近くの線分の 上で 一番近い点 (区域の辺も 相手にする)
  //
  // 「近いかどうか」は 画面上の距離で 判定する (縮尺が変わっても 指の感覚が
  // 変わらないため)。吸着先の 座標そのものは メートル座標で 出すので、
  // 交点・線上でも 測量に使える精度が 残る。
  //
  // 同じ距離に 複数あるときは 単点 > 交点 > 中心点 > 線上 の順で 拾う。
  const snap = useCallback(
    (ll: { lat: number; lng: number }, excludeStrokeId?: string): LL => {
      const raw: LL = { lat: ll.lat, lng: ll.lng }
      if (!snapEnabled || snapTypes.length === 0) return raw
      const target = map.latLngToContainerPoint([ll.lat, ll.lng])
      const toPx = (p: LL) => map.latLngToContainerPoint([p.lat, p.lng])

      let best: LL | null = null
      let bestRank = Number.MAX_SAFE_INTEGER
      let bestPx = SNAP_RADIUS_PX
      const consider = (p: LL, rank: number) => {
        const px = toPx(p).distanceTo(target)
        if (px >= SNAP_RADIUS_PX) return
        // 種類の優先順が先。同じ種類なら 近い方
        if (rank > bestRank) return
        if (rank === bestRank && px >= bestPx) return
        best = p
        bestRank = rank
        bestPx = px
      }

      // 単点
      if (snapTypes.includes('vertex')) {
        for (const it of items) {
          if (it.id === excludeStrokeId) continue
          for (const p of it.points) consider(p, 0)
        }
        if (extraSnapPoints) {
          for (const [lat, lng] of extraSnapPoints) consider({ lat, lng }, 0)
        }
      }

      // 中心点 (円は 1 点目、円弧は 3 点の外接円の中心)
      if (snapTypes.includes('center')) {
        for (const it of items) {
          if (it.id === excludeStrokeId) continue
          if (it.kind === 'circle' && it.points[0]) consider(it.points[0], 2)
          if (it.kind === 'arc' && it.points.length >= 3) {
            const cc = circumcenterLL(it.points[0], it.points[1], it.points[2], converter)
            if (cc) consider(cc, 2)
          }
        }
      }

      // 交点 / 線上 は、カーソルの近くにある線分だけを 相手にする。
      // ペイントの線に加えて、外から渡された線分 (区域の辺など) も 相手にする
      if (snapTypes.includes('intersection') || snapTypes.includes('edge')) {
        const near: Array<[LL, LL]> = []
        const considerSeg = (a: LL, b: LL) => {
          if (distancePointToSegmentPx(target, toPx(a), toPx(b)) < SNAP_SEARCH_PX) {
            near.push([a, b])
          }
        }
        for (const it of items) {
          if (it.id === excludeStrokeId) continue
          if (!isLineLike(it.kind)) continue
          const pts = it.points
          const last = it.kind === 'polygon' ? pts.length : pts.length - 1
          for (let i = 0; i < last; i += 1) {
            considerSeg(pts[i], pts[(i + 1) % pts.length])
          }
        }
        if (extraSegments) {
          for (const [a, b] of extraSegments) considerSeg(a, b)
        }
        if (snapTypes.includes('intersection')) {
          for (let i = 0; i < near.length; i += 1) {
            for (let j = i + 1; j < near.length; j += 1) {
              const x = segmentIntersection(near[i], near[j], converter)
              if (x) consider(x, 1)
            }
          }
        }
        if (snapTypes.includes('edge')) {
          for (const seg of near) consider(closestOnSegment(seg[0], seg[1], raw, converter), 3)
        }
      }

      return best ?? raw
    },
    [snapEnabled, snapTypes, items, extraSnapPoints, extraSegments, converter, map],
  )

  /** 吸着先が近くにあるか (カーソル位置に印を出すため) */
  const [snapHint, setSnapHint] = useState<LL | null>(null)
  useEffect(() => {
    // 直前の実行のクリーンアップで印は消えるので、ここでは購読しないだけでよい
    if (!snapEnabled || mode === 'off') return
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
  /** 距離: 2 点を指すか、既存の線要素を選ぶか */
  const [distPickElement, setDistPickElement] = useState(false)
  /** 距離: 各辺を出す / 合計を出す (連続線のときに効く。両方 ON も可) */
  const [distShowEach, setDistShowEach] = useState(true)
  const [distShowTotal, setDistShowTotal] = useState(true)

  // 選択モードの状態
  // まとめて選べるので 配列で 持つ。頂点ハンドルや 伸縮は 1 つだけ選んだ時に出す
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selectedId = selectedIds.length === 1 ? selectedIds[0] : null
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
  // 選択の変化を 親へ伝える。左パネルの「描画の設定」を 選択に効かせるため
  useEffect(() => {
    onSelectionChange?.(selectedIds)
  }, [selectedIds, onSelectionChange])
  /** 線 / 長方形 / 多角形で 囲っている途中の 頂点 */
  const [selectShape, setSelectShape] = useState<LL[]>([])
  /** 選択したものを 平行移動 / 複製する。始点 → 終点 の 2 クリックで ずらす量を決める */
  const [transformMode, setTransformMode] = useState<'move' | 'copy' | null>(null)
  const [transformFrom, setTransformFrom] = useState<LL | null>(null)
  const transforming = transformMode !== null
  /** 平行移動の 仮表示に使う カーソル位置 */
  const [transformHover, setTransformHover] = useState<LL | null>(null)
  /** 囲って選ぶ途中の カーソル位置 (仮の形を 追従させる) */
  const [selectHover, setSelectHover] = useState<LL | null>(null)
  const toggleSelected = useCallback((id: string, additive: boolean) => {
    setSelectedIds((prev) => {
      if (!additive) return prev.length === 1 && prev[0] === id ? [] : [id]
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    })
  }, [])
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

  // 囲って選ぶ間は カーソルを 追う。線 / 長方形 / 多角形の 仮の形を 出すため
  useEffect(() => {
    if (mode !== 'select' || selectMethod === 'point' || transforming) return
    const onMove = (e: L.LeafletMouseEvent) => setSelectHover(snap(e.latlng))
    const onOut = () => setSelectHover(null)
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
    return () => {
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      setSelectHover(null)
    }
  }, [map, mode, selectMethod, transforming, snap])

  // 平行移動 / 複製の 始点を 置いたあと、カーソルを 追って 仮表示を出す
  useEffect(() => {
    if (!transformFrom) return
    const onMove = (e: L.LeafletMouseEvent) => setTransformHover(snap(e.latlng))
    const onOut = () => setTransformHover(null)
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
    return () => {
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      setTransformHover(null)
    }
  }, [map, transformFrom, snap])

  // 長方形・垂線の間だけ カーソルを 追う (仮表示の向きに使う)
  useEffect(() => {
    if (mode !== 'rect' && mode !== 'perp') return
    const onMove = (e: L.LeafletMouseEvent) => setShapeHover(snap(e.latlng))
    const onOut = () => setShapeHover(null)
    map.on('mousemove', onMove)
    map.on('mouseout', onOut)
    return () => {
      map.off('mousemove', onMove)
      map.off('mouseout', onOut)
      setShapeHover(null)
    }
  }, [map, mode, snap])

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
    setSelectedIds([])
    setDragPreview(null)
  }, [farmId, fetchByFarm])

  // モード変更時にモードに合わない状態をクリア
  useEffect(() => {
    if (mode !== 'circle' && mode !== 'arc' && mode !== 'polygon' && mode !== 'line') {
      setShapeProgress(null)
    }
    if (mode !== 'parallel') setParallelBase(null)
    if (mode !== 'rect') setRectStart(null)
    if (mode !== 'perp') {
      setPerpBase(null)
      setPerpThrough(null)
    }
    if (mode !== 'text') setTextLineStart(null)
    if (mode !== 'select') {
      setSelectedIds([])
      setSelectShape([])
      setTransformMode(null)
      setTransformFrom(null)
      setDragPreview(null)
      setStretchEnd(null)
      setStretchCandidates([])
      setStretchTarget(null)
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
      mode === 'rect' ||
      mode === 'perp' ||
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

  // 選択中のストローク (端点ハンドル用)
  const selectedStroke = useMemo(
    () =>
      mode === 'select' && selectedId
        ? items.find((s) => s.id === selectedId) ?? null
        : null,
    [items, mode, selectedId],
  )
  /** 端部の伸縮で動かす端点まわりの情報 (起点 / 単位方向 / 現在の長さ) */
  const stretchAxis = useMemo(() => {
    if (!selectedStroke || selectedStroke.kind !== 'stroke' || !stretchEnd) return null
    const pts = selectedStroke.points
    if (pts.length < 2) return null
    // 動かさない側の隣の頂点を起点にする
    const origin = stretchEnd === 'end' ? pts[pts.length - 2] : pts[1]
    const tip = stretchEnd === 'end' ? pts[pts.length - 1] : pts[0]
    const d = deltaM(origin, tip, converter)
    const len = Math.hypot(d.east, d.north)
    if (len < 1e-6) return null
    return { origin, tip, ux: d.east / len, uy: d.north / len, current: len }
  }, [selectedStroke, stretchEnd, converter])

  /** 伸縮後の端点 */
  const stretchTip = useMemo(() => {
    if (!stretchAxis) return null
    return offsetLL(
      stretchAxis.origin,
      stretchAxis.ux * stretchLength,
      stretchAxis.uy * stretchLength,
      converter,
    )
  }, [stretchAxis, stretchLength, converter])

  /** 伸縮を確定して保存する */
  const commitStretch = useCallback(() => {
    if (!selectedStroke || !stretchEnd || !stretchTip) return
    const pts = [...selectedStroke.points]
    if (stretchEnd === 'end') pts[pts.length - 1] = stretchTip
    else pts[0] = stretchTip
    void updateStrokePoints(selectedStroke.id, pts)
    setStretchEnd(null)
    setStretchCandidates([])
    setStretchTarget(null)
  }, [selectedStroke, stretchEnd, stretchTip, updateStrokePoints])

  // タップ式描画 + text 追加: useMapEvents
  useMapEvents({
    click: (e) => {
      // ピックが ON なら、以降はすべて吸着後の座標で扱う
      const at = snap(e.latlng)

      // 計測は保存しないので farmId を必要としない
      if (isMeasureMode(mode)) {
        const pts = [...measurePoints, at]

        if (mode === 'measure-dist') {
          // 線要素を選んで測るモード: クリックした線の 全辺を測る
          if (distPickElement) {
            const stroke = pickStroke(e.latlng)
            if (!stroke) return
            const verts =
              stroke.kind === 'polygon' ? [...stroke.points, stroke.points[0]] : stroke.points
            const segs = buildSegments(verts, converter)
            if (segs.length === 0) return
            setLastMeasure({
              kind: 'dist',
              points: verts,
              value: segs.reduce((sum, sg) => sum + sg.value, 0),
              labelAt: centroid(verts),
              segments: segs,
            })
            setMeasurePoints([])
            return
          }
          if (pts.length < 2) {
            setMeasurePoints(pts)
            return
          }
          const segs = buildSegments(pts, converter)
          setLastMeasure({
            kind: 'dist',
            points: pts,
            value: segs.reduce((sum, sg) => sum + sg.value, 0),
            labelAt: centroid(pts),
            segments: segs,
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
      // 平行移動 / 複製: 始点 → 終点 の 2 クリック
      if (mode === 'select' && transformMode) {
        if (!transformFrom) {
          setTransformFrom(at)
          return
        }
        runTransform(transformFrom, at, transformMode)
        setTransformFrom(null)
        // 移動は 1 回で 終わり、複製は 続けて 置けるように そのまま
        if (transformMode === 'move') setTransformMode(null)
        return
      }

      // 囲って選ぶ (線 / 長方形 / 多角形)。点で選ぶ時は 図形側の click で拾う
      if (mode === 'select' && selectMethod !== 'point' && !stretchAxis && !transformMode) {
        const pts = [...selectShape, at]
        const need = selectMethod === 'polygon' ? Infinity : 2
        if (pts.length < need) {
          setSelectShape(pts)
          return
        }
        applySelection(pts, isAdditiveClick(e))
        setSelectShape([])
        setSelectHover(null)
        return
      }

      // 端部の伸縮中: 対象の線 / 円をクリックすると、その要素との交点まで伸縮する
      if (mode === 'select' && stretchAxis) {
        const clickPx = map.latLngToContainerPoint(e.latlng)
        const hits: number[] = []
        let target: [LL, LL] | null = null
        for (const it of items) {
          if (it.id === selectedStroke?.id) continue
          if (it.kind === 'circle') {
            const [center, edge] = it.points
            if (!center || !edge) continue
            const px = map.latLngToContainerPoint([center.lat, center.lng]).distanceTo(clickPx)
            const r = circleRadiusMeters(center, edge)
            // 円周の近くをクリックしたときだけ対象にする
            const rPx =
              map
                .latLngToContainerPoint([center.lat, center.lng])
                .distanceTo(map.latLngToContainerPoint([edge.lat, edge.lng]))
            if (Math.abs(px - rPx) > PICK_LINE_RADIUS_PX) continue
            hits.push(
              ...intersectCircle(stretchAxis.origin, stretchAxis.ux, stretchAxis.uy, center, r, converter),
            )
            continue
          }
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
            if (px > PICK_LINE_RADIUS_PX) continue
            const t = intersectLineThrough(stretchAxis.origin, stretchAxis.ux, stretchAxis.uy, a, b, converter)
            if (t !== null) {
              hits.push(t)
              target = [a, b]
            }
          }
        }
        // 起点より手前 (線が裏返る側) は捨てる。近い順に並べる
        const usable = hits
          .filter((t) => t > 0.01)
          .sort((a, b) => Math.abs(a - stretchLength) - Math.abs(b - stretchLength))
        if (usable.length === 0) {
          // 相手が 見つからなければ、クリックした位置を 伸縮の向きに 射影して
          // そこまで 伸ばす / 詰める
          const d = deltaM(stretchAxis.origin, at, converter)
          const t = d.east * stretchAxis.ux + d.north * stretchAxis.uy
          if (t > 0.01) {
            setStretchLength(Math.round(t * 100) / 100)
            setStretchCandidates([])
            setStretchTarget(null)
          }
          return
        }
        setStretchTarget(target)
        if (usable.length === 1) {
          setStretchLength(Math.round(usable[0] * 100) / 100)
          setStretchCandidates([])
        } else {
          // どこまで伸ばす / 詰めるかを選ばせる
          setStretchCandidates(usable)
        }
        return
      }

      if (mode === 'parallel') {
        if (parallelBase) return
        const best = pickBaseLine(e.latlng)
        if (best) setParallelBase(best)
        return
      }

      if (mode === 'perp') {
        // ① 基準線 → ② 通過点 → ③ 終点 (または延長を数値で入れて確定)
        if (!perpBase) {
          const best = pickBaseLine(e.latlng)
          if (best) setPerpBase(best)
          return
        }
        if (!perpThrough) {
          setPerpThrough(at)
          // 足から通過点までの長さを 延長の初期値にしておく
          const { value } = measurePerp(converter, perpBase[0], perpBase[1], at)
          if (value > 0) setPerpLength(Math.round(value * 100) / 100)
          return
        }
        // 3 回目のクリック = 終点。垂線の向きに射影した長さを採用する
        const geom = perpGeometry(perpBase, perpThrough, perpLength, converter)
        if (geom) {
          const d = deltaM(geom.foot, at, converter)
          const len = d.east * geom.ux + d.north * geom.uy
          if (Math.abs(len) > 0.01) setPerpLength(Math.round(Math.abs(len) * 100) / 100)
        }
        return
      }

      if (mode === 'rect') {
        if (!rectStart) {
          setRectStart(at)
          return
        }
        const pts = rectPoints(rectStart, at, rectWidth, rectHeight, converter)
        if (pts) {
          void addStroke({
            farmId,
            kind: 'polygon',
            color,
            widthPx,
            lineStyle,
            points: pts,
            layer,
          })
        }
        setRectStart(null)
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
            arrow,
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

  /** 選択中の図形を まとめて ずらす (移動 or 複製) */
  const runTransform = useCallback(
    (from: LL, to: LL, kindOfMove: 'move' | 'copy') => {
      if (!farmId || selectedIds.length === 0) return
      const d = deltaM(from, to, converter)
      if (Math.hypot(d.east, d.north) < 1e-6) return
      const shift = (p: LL) => offsetLL(p, d.east, d.north, converter)
      for (const id of selectedIds) {
        const it = items.find((x) => x.id === id)
        if (!it) continue
        const moved = it.points.map(shift)
        if (kindOfMove === 'move') {
          void updateStrokePoints(it.id, moved)
          continue
        }
        // 複製: 属性を そのまま 引き継いで 新しく作る
        if (it.kind === 'text') {
          void addText({
            farmId,
            color: it.color,
            widthPx: it.width_px,
            lat: moved[0].lat,
            lng: moved[0].lng,
            text: it.text ?? '',
            layer: it.layer,
            fontSize: it.font_size ?? undefined,
            rotationDeg: it.rotation_deg,
          })
        } else if (it.kind === 'point') {
          void addPoint({
            farmId,
            color: it.color,
            widthPx: it.width_px,
            lat: moved[0].lat,
            lng: moved[0].lng,
            layer: it.layer,
          })
        } else {
          void addStroke({
            farmId,
            kind: it.kind,
            color: it.color,
            widthPx: it.width_px,
            lineStyle: (it.line_style ?? 'solid') as LineStyle,
            points: moved,
            layer: it.layer,
            arrow: it.arrow,
          })
        }
      }
      // 複製したら 元の選択のままにしておく (続けて 何枚も 置けるように)
      if (kindOfMove === 'move') setSelectedIds([])
    },
    [farmId, selectedIds, items, converter, updateStrokePoints, addStroke, addText, addPoint],
  )

  /** 囲った形に かかっている図形を 選ぶ */
  const applySelection = useCallback(
    (shape: LL[], additive: boolean) => {
      const px = shape.map((p) => map.latLngToContainerPoint([p.lat, p.lng]))
      const hit: string[] = []
      for (const it of items) {
        const geom = itemScreenGeometry(map, it)
        const ok =
          selectMethod === 'line'
            ? hitByLinePx(geom, px[0], px[1])
            : hitByPolygonPx(
                geom,
                selectMethod === 'rect' ? rectFromCorners(px[0], px[1]) : px,
              )
        if (ok) hit.push(it.id)
      }
      setSelectedIds((prev) => (additive ? [...new Set([...prev, ...hit])] : hit))
    },
    [map, items, selectMethod],
  )

  /** クリック位置に一番近い 線 / 面の図形そのものを拾う (計測で 1 本まるごと測る用) */
  const pickStroke = useCallback(
    (latlng: L.LatLng): MapDrawingStroke | null => {
      const clickPx = map.latLngToContainerPoint(latlng)
      let best: MapDrawingStroke | null = null
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
            best = it
          }
        }
      }
      return best
    },
    [map, items],
  )

  /** クリック位置に一番近い既存の線分 (線 / 面の辺) を基準線として拾う */
  const pickBaseLine = useCallback(
    (latlng: L.LatLng): [LL, LL] | null => {
      const clickPx = map.latLngToContainerPoint(latlng)
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
      return best
    },
    [map, items],
  )

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
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points, layer, arrow })
      setShapeProgress(null)
      return
    }
    if (kind === 'polygon' && points.length >= 3) {
      void addStroke({ farmId, kind: 'polygon', color, widthPx, lineStyle, points, layer })
      setShapeProgress(null)
    }
  }, [farmId, shapeProgress, color, widthPx, lineStyle, layer, arrow, addStroke])


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
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points: geo, layer, arrow })
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
  }, [mode, map, farmId, color, widthPx, lineStyle, layer, arrow, snap, addStroke])

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

  // 頂点ハンドル用の points (ドラッグ中はプレビュー)
  const handlePoints =
    selectedStroke && selectedStroke.kind !== 'text'
      ? dragPreview?.strokeId === selectedStroke.id
        ? dragPreview.points
        : selectedStroke.points
      : null

  // 既存アイテムの描画
  const renderItem = useCallback(
    (s: MapDrawingStroke) => {
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
                  : isSelect && !stretching && !transforming && selectMethod === 'point'
                    ? {
                        click: (ev: L.LeafletMouseEvent) =>
                          toggleSelected(s.id, isAdditiveClick(ev)),
                      }
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
              icon={makePointIcon(s.color, s.width_px, isSelect && selectedSet.has(s.id))}
              interactive={isEraser || isSelect}
              eventHandlers={
                isEraser
                  ? { click: () => void deleteStroke(s.id) }
                  : isSelect && !stretching && !transforming && selectMethod === 'point'
                    ? {
                        click: (ev: L.LeafletMouseEvent) =>
                          toggleSelected(s.id, isAdditiveClick(ev)),
                      }
                    : undefined
              }
            />
          )
        }

        // ドラッグ中は preview の points を採用してリアルタイム反映
        const pointsForRender =
          dragPreview?.strokeId === s.id ? dragPreview.points : s.points
        const isSelected = mode === 'select' && selectedSet.has(s.id)
        const dash = dashArrayFor(
          (s.line_style ?? 'solid') as LineStyle,
          s.width_px,
        )
        const clickHandlers =
          mode === 'eraser'
            ? { click: () => void deleteStroke(s.id) }
            : mode === 'select'
              ? // 伸縮中のクリックは「どこまで伸ばすか」の指定、囲って選ぶ最中は
                // 地図クリックが 頂点の指定なので、どちらも 図形側では 拾わない
                stretching || selectMethod !== 'point' || transforming
                ? undefined
                : {
                    click: (ev: L.LeafletMouseEvent) =>
                      toggleSelected(s.id, isAdditiveClick(ev)),
                  }
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
              {/* 端部の矢印。円弧は 近似ポリラインの 端 2 点で 接線の向きを取る */}
              {arrowEnds(s.arrow).map((which) => {
                const n = arcPts.length
                if (n < 2) return null
                const tip = which === 'end' ? arcPts[n - 1] : arcPts[0]
                const prev = which === 'end' ? arcPts[n - 2] : arcPts[1]
                const tipLL = { lat: tip[0], lng: tip[1] }
                const prevLL = { lat: prev[0], lng: prev[1] }
                return (
                  <Marker
                    key={`arrow-${s.id}-${which}`}
                    position={tip}
                    icon={makeArrowIcon(s.color, s.width_px, bearingRawDeg(prevLL, tipLL))}
                    interactive={false}
                  />
                )
              })}
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
            {/* 端部の矢印。向きは その端の線分に 合わせる */}
            {arrowEnds(s.arrow).map((which) => {
              const n = pointsForRender.length
              const tip = which === 'end' ? pointsForRender[n - 1] : pointsForRender[0]
              const prev = which === 'end' ? pointsForRender[n - 2] : pointsForRender[1]
              if (!tip || !prev) return null
              return (
                <Marker
                  key={`arrow-${s.id}-${which}`}
                  position={[tip.lat, tip.lng]}
                  icon={makeArrowIcon(s.color, s.width_px, bearingRawDeg(prev, tip))}
                  interactive={false}
                />
              )
            })}
          </Fragment>
        )
    },
    [
      mode,
      deleteStroke,
      selectedSet,
      toggleSelected,
      dragPreview,
      stretching,
      transforming,
      selectMethod,
    ],
  )

  /**
   * レイヤごとに 別の pane へ 分けて描く。
   * レイヤパネルで 測点や写真の 間に ペイントのレイヤを 差し込めるようにするため。
   * zIndex が 渡されていないレイヤは まとめて 既定の pane に置く。
   */
  const rendered = useMemo(() => {
    if (!layerZIndex || Object.keys(layerZIndex).length === 0) {
      return <>{items.map(renderItem)}</>
    }
    const groups = new Map<number | null, MapDrawingStroke[]>()
    for (const it of items) {
      const z = layerZIndex[it.layer ?? '0'] ?? null
      const list = groups.get(z)
      if (list) list.push(it)
      else groups.set(z, [it])
    }
    return (
      <>
        {[...groups.entries()].map(([z, list]) =>
          z === null ? (
            <Fragment key="layer-default">{list.map(renderItem)}</Fragment>
          ) : (
            <Pane key={`layer-z${z}`} name={`map-drawing-z${z}`} style={{ zIndex: z }}>
              {list.map(renderItem)}
            </Pane>
          ),
        )}
      </>
    )
  }, [items, renderItem, layerZIndex])

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

  /**
   * 計測結果を 地図に出すラベル。距離は 線の向きに 沿わせる。
   * 各辺 / 合計 の どちらを出すかは チェックで 切り替える (両方も可)。
   */
  const measureLabels = useMemo<MeasureLabel[]>(() => {
    if (!lastMeasure) return []
    if (lastMeasure.kind !== 'dist') {
      return [{ at: lastMeasure.labelAt, angle: 0, text: formatMeasure(lastMeasure) }]
    }
    const segs = lastMeasure.segments ?? []
    const out: MeasureLabel[] = []
    if (distShowEach) {
      for (const sg of segs) {
        out.push({
          at: midLL(sg.a, sg.b),
          angle: bearingDeg(sg.a, sg.b, converter),
          text: formatLength(sg.value),
        })
      }
    }
    // 合計は 辺が 2 本以上のときだけ (1 本なら 各辺と同じ値になる)
    if (distShowTotal && segs.length > 1) {
      const first = lastMeasure.points[0]
      const last = lastMeasure.points[lastMeasure.points.length - 1]
      out.push({
        at: lastMeasure.labelAt,
        angle: bearingDeg(first, last, converter),
        text: `計 ${formatLength(lastMeasure.value)}`,
      })
    }
    // どちらも外していると 何も出ないので、その時は 合計だけ出す
    if (out.length === 0) {
      out.push({ at: lastMeasure.labelAt, angle: 0, text: formatLength(lastMeasure.value) })
    }
    return out
  }, [lastMeasure, distShowEach, distShowTotal, converter])

  /** 計測結果を 文字要素として 保存する (ラベルと同じ位置・向きで置く) */
  const saveMeasureAsText = useCallback(() => {
    if (!farmId || measureLabels.length === 0) return
    for (const lb of measureLabels) {
      void addText({
        farmId,
        color,
        widthPx,
        lat: lb.at.lat,
        lng: lb.at.lng,
        text: lb.text,
        layer,
        fontSize,
        rotationDeg: lb.angle,
      })
    }
    setLastMeasure(null)
    setMeasurePoints([])
  }, [farmId, measureLabels, color, widthPx, layer, fontSize, addText])

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
        {measureLabels.map((lb, i) => (
          <Marker
            key={`measure-label-${i}`}
            position={[lb.at.lat, lb.at.lng]}
            icon={makeMeasureLabelIcon(lb.text, MEASURE_COLOR, lb.angle)}
            interactive={false}
          />
        ))}
      </>
    )
  }, [mode, measurePoints, lastMeasure, measureLabels])

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
      void addStroke({ farmId, kind: 'stroke', color, widthPx, lineStyle, points: line, layer, arrow })
    }
    setParallelBase(null)
  }, [farmId, parallelLines, color, widthPx, lineStyle, layer, arrow, addStroke])

  /** 垂線の確定形 (通過点まで決まっていれば作れる) */
  const perpShape = useMemo(() => {
    if (!perpBase || !perpThrough) return null
    return perpGeometry(perpBase, perpThrough, perpLength, converter)
  }, [perpBase, perpThrough, perpLength, converter])

  // 長方形・垂線の仮表示。どちらも点線で、確定するまで保存しない
  const constructPreview = useMemo(() => {
    const dash: L.PathOptions = { color, weight: widthPx, opacity: 0.8, dashArray: '6,4' }
    const guide: L.PathOptions = { color: '#6366f1', weight: widthPx + 4, opacity: 0.35 }

    if (mode === 'rect') {
      if (!rectStart) return null
      const pts = shapeHover
        ? rectPoints(rectStart, shapeHover, rectWidth, rectHeight, converter)
        : null
      return (
        <>
          <Marker
            position={[rectStart.lat, rectStart.lng]}
            icon={FIRST_VERTEX_ICON}
            interactive={false}
          />
          {pts && (
            <LeafletPolygon
              positions={pts.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{ ...dash, fillColor: color, fillOpacity: 0.1 }}
              interactive={false}
            />
          )}
        </>
      )
    }

    if (mode === 'perp') {
      if (!perpBase) return null
      return (
        <>
          <Polyline
            positions={perpBase.map((p) => [p.lat, p.lng] as [number, number])}
            pathOptions={guide}
            interactive={false}
          />
          {perpThrough && (
            <Marker
              position={[perpThrough.lat, perpThrough.lng]}
              icon={FIRST_VERTEX_ICON}
              interactive={false}
            />
          )}
          {perpShape && (
            <>
              <Polyline
                positions={[
                  [perpShape.foot.lat, perpShape.foot.lng],
                  [perpShape.end.lat, perpShape.end.lng],
                ]}
                pathOptions={dash}
                interactive={false}
              />
              <Marker
                position={[perpShape.foot.lat, perpShape.foot.lng]}
                icon={HANDLE_ICON}
                interactive={false}
              />
            </>
          )}
        </>
      )
    }
    return null
  }, [
    mode,
    rectStart,
    shapeHover,
    rectWidth,
    rectHeight,
    perpBase,
    perpThrough,
    perpShape,
    converter,
    color,
    widthPx,
  ])

  /** 垂線を保存する */
  const commitPerp = useCallback(() => {
    if (!farmId || !perpShape) return
    void addStroke({
      farmId,
      kind: 'stroke',
      color,
      widthPx,
      lineStyle,
      points: [perpShape.foot, perpShape.end],
      layer,
      arrow,
    })
    setPerpBase(null)
    setPerpThrough(null)
  }, [farmId, perpShape, color, widthPx, lineStyle, layer, arrow, addStroke])

  // 進行中の描画・計測のキーボード操作
  //   Backspace / Delete … 直前の頂点を取り消す
  //   Enter              … 確定する
  //   Escape             … まるごと取り消す
  useEffect(() => {
    if (
      !shapeProgress &&
      selectShape.length === 0 &&
      !parallelBase &&
      !perpBase &&
      !stretching &&
      measurePoints.length === 0 &&
      !lastMeasure
    ) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      // 文字入力中のキーは拾わない
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return

      if (e.key === 'Escape') {
        setShapeProgress(null)
        setSelectShape([])
        setSelectHover(null)
        setTransformMode(null)
        setTransformFrom(null)
        setParallelBase(null)
        setRectStart(null)
        setStretchEnd(null)
        setStretchCandidates([])
        setStretchTarget(null)
        setPerpBase(null)
        setPerpThrough(null)
        setTextLineStart(null)
        setMeasurePoints([])
        setLastMeasure(null)
        return
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        // ブラウザの「前のページへ戻る」を止める
        e.preventDefault()
        if (selectShape.length > 0) {
          setSelectShape(selectShape.slice(0, -1))
        } else if (shapeProgress) {
          const next = shapeProgress.points.slice(0, -1)
          setShapeProgress(next.length === 0 ? null : { ...shapeProgress, points: next })
        } else if (measurePoints.length > 0) {
          setMeasurePoints(measurePoints.slice(0, -1))
        }
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        // 進行中のものから 順に 確定する
        if (selectMethod === 'polygon' && selectShape.length >= 3) {
          applySelection(selectShape, false)
          setSelectShape([])
          setSelectHover(null)
          return
        }
        if (stretchAxis) return commitStretch()
        if (perpShape) return commitPerp()
        if (parallelBase) return commitParallel()
        if (shapeProgress?.kind === 'circle') return commitCircle()
        commitVertexShape()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    shapeProgress,
    selectShape,
    selectMethod,
    applySelection,
    parallelBase,
    perpBase,
    stretching,
    stretchAxis,
    perpShape,
    measurePoints,
    lastMeasure,
    commitVertexShape,
    commitStretch,
    commitPerp,
    commitParallel,
    commitCircle,
  ])

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
      {constructPreview}
      {/* 平行移動 / 複製の 仮表示。始点 → カーソル の 矢印と、ずらした先の 形 */}
      {transformFrom && (
        <>
          <Marker
            position={[transformFrom.lat, transformFrom.lng]}
            icon={FIRST_VERTEX_ICON}
            interactive={false}
          />
          {transformHover && (
            <>
              <Polyline
                positions={[
                  [transformFrom.lat, transformFrom.lng],
                  [transformHover.lat, transformHover.lng],
                ]}
                pathOptions={{ color: '#3b82f6', weight: 2, dashArray: '6,4' }}
                interactive={false}
              />
              {(() => {
                const d = deltaM(transformFrom, transformHover, converter)
                return items
                  .filter((it) => selectedSet.has(it.id))
                  .map((it) => {
                    const pts = it.points.map((p) => offsetLL(p, d.east, d.north, converter))
                    if (pts.length < 2) {
                      return (
                        <Marker
                          key={`tf-${it.id}`}
                          position={[pts[0].lat, pts[0].lng]}
                          icon={HANDLE_ICON}
                          interactive={false}
                        />
                      )
                    }
                    const positions = pts.map((p) => [p.lat, p.lng] as [number, number])
                    if (it.kind === 'polygon') positions.push(positions[0])
                    return (
                      <Polyline
                        key={`tf-${it.id}`}
                        positions={positions}
                        pathOptions={{
                          color: it.color,
                          weight: it.width_px,
                          opacity: 0.7,
                          dashArray: '6,4',
                        }}
                        interactive={false}
                      />
                    )
                  })
              })()}
            </>
          )}
        </>
      )}

      {/* 囲って選ぶ途中の 仮表示。カーソルを 最後の頂点として 扱い、
          線は 線、長方形と 多角形は 塗り潰した形で 追従させる */}
      {selectShape.length > 0 && (
        <>
          {selectShape.map((p, i) => (
            <Marker
              key={`sel-v-${i}`}
              position={[p.lat, p.lng]}
              icon={i === 0 ? FIRST_VERTEX_ICON : HANDLE_ICON}
              interactive={false}
            />
          ))}
          {(() => {
            const pts = selectHover ? [...selectShape, selectHover] : selectShape
            const opts: L.PathOptions = {
              color: '#3b82f6',
              weight: 2,
              dashArray: '6,4',
              fillColor: '#3b82f6',
              fillOpacity: 0.12,
            }
            if (selectMethod === 'line') {
              if (pts.length < 2) return null
              return (
                <Polyline
                  positions={pts.slice(0, 2).map((p) => [p.lat, p.lng] as [number, number])}
                  pathOptions={{ ...opts, fill: false }}
                  interactive={false}
                />
              )
            }
            if (selectMethod === 'rect') {
              if (pts.length < 2) return null
              const [a, b] = pts
              return (
                <LeafletPolygon
                  positions={[
                    [a.lat, a.lng],
                    [a.lat, b.lng],
                    [b.lat, b.lng],
                    [b.lat, a.lng],
                  ]}
                  pathOptions={opts}
                  interactive={false}
                />
              )
            }
            if (pts.length < 3) {
              return pts.length >= 2 ? (
                <Polyline
                  positions={pts.map((p) => [p.lat, p.lng] as [number, number])}
                  pathOptions={{ ...opts, fill: false }}
                  interactive={false}
                />
              ) : null
            }
            return (
              <LeafletPolygon
                positions={pts.map((p) => [p.lat, p.lng] as [number, number])}
                pathOptions={opts}
                interactive={false}
              />
            )
          })()}
        </>
      )}
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
      {/* 操作ハンドルは 線より上に出す。同じペインだと 線の SVG が上に来て
          中点の「+」が 押しにくくなるため、専用ペイン (zIndex 650) に分ける */}
      <Pane name="map-drawing-handles" style={{ zIndex: 650 }}>
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
                // ドラッグ中も 吸着させる。自分自身には 吸い付かないよう
                // 動かしているストロークは 候補から 外す
                const marker = e.target as L.Marker
                const at = snap(marker.getLatLng(), selectedStroke.id)
                const nextPoints = selectedStroke.points.map((pp, i) =>
                  i === idx ? at : pp,
                )
                setDragPreview({
                  strokeId: selectedStroke.id,
                  points: nextPoints,
                })
              },
              dragend: (e) => {
                const marker = e.target as L.Marker
                const at = snap(marker.getLatLng(), selectedStroke.id)
                const nextPoints = selectedStroke.points.map((pp, i) =>
                  i === idx ? at : pp,
                )
                // 吸着先へ 見た目も 合わせる
                marker.setLatLng([at.lat, at.lng])
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
      {/* 端部の伸縮ハンドル (連続線のみ)。押すと その端が 伸縮の対象になる */}
      {selectedStroke &&
        selectedStroke.kind === 'stroke' &&
        !dragPreview &&
        !transforming &&
        selectedStroke.points.length >= 2 &&
        (['start', 'end'] as const).map((which) => {
          const pts = selectedStroke.points
          const p = which === 'end' ? pts[pts.length - 1] : pts[0]
          // 端点ハンドルと重ならないよう、少しだけ外側に出す
          return (
            <Marker
              key={`stretch-${selectedStroke.id}-${which}`}
              position={[p.lat, p.lng]}
              icon={STRETCH_ICON}
              zIndexOffset={1000}
              eventHandlers={{
                click: () => {
                  // 今の端の長さを 初期値にする
                  const origin = which === 'end' ? pts[pts.length - 2] : pts[1]
                  const d = deltaM(origin, p, converter)
                  setStretchLength(Math.round(Math.hypot(d.east, d.north) * 100) / 100)
                  setStretchCandidates([])
                  setStretchTarget(null)
                  setStretchEnd(which)
                },
              }}
            />
          )
        })}

      {/* 対象の延長線。実際にはぶつかっていない相手まで伸ばしたことが
          分かるよう、対象の線分を 伸縮後の端点まで 灰色の点線で 延ばして見せる */}
      {stretchTarget && stretchTip && (
        <Polyline
          positions={extendThrough(stretchTarget, stretchTip, converter).map(
            (p) => [p.lat, p.lng] as [number, number],
          )}
          pathOptions={{ color: '#64748b', weight: 1.5, opacity: 0.9, dashArray: '4,4' }}
          interactive={false}
        />
      )}

      {/* 伸縮の仮表示 (起点 → 伸縮後の端点) */}
      {stretchAxis && stretchTip && (
        <Polyline
          positions={[
            [stretchAxis.origin.lat, stretchAxis.origin.lng],
            [stretchTip.lat, stretchTip.lng],
          ]}
          pathOptions={{ color: '#f97316', weight: widthPx + 2, opacity: 0.9, dashArray: '6,4' }}
          interactive={false}
        />
      )}

      {/* 交点が複数あるとき: どこまでにするかを選ばせる */}
      {stretchAxis &&
        stretchCandidates.map((t, i) => {
          const at = offsetLL(stretchAxis.origin, stretchAxis.ux * t, stretchAxis.uy * t, converter)
          return (
            <Marker
              key={`stretch-candidate-${i}`}
              position={[at.lat, at.lng]}
              icon={CANDIDATE_ICON}
              zIndexOffset={1100}
              eventHandlers={{
                click: () => {
                  setStretchLength(Math.round(t * 100) / 100)
                  setStretchCandidates([])
                },
              }}
            />
          )
        })}

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
      </Pane>
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
                    <NumberField
                      step="1"
                      value={textAngle}
                      onChange={setTextAngle}
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
                  <NumberField
                    value={circleRadius}
                    onChange={setCircleRadius}
                    onEnter={commitCircle}
                    min={0}
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
                  確定 (Enter)
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

            {/* 長方形: 縦横を入れ、開始点 → 向きの点 の 2 クリックで置く */}
            {mode === 'rect' && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">長方形</span>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">横 (m)</span>
                  <NumberField
                    value={rectWidth}
                    onChange={setRectWidth}
                    min={0}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">縦 (m)</span>
                  <NumberField
                    value={rectHeight}
                    onChange={setRectHeight}
                    min={0}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <span className="text-[11px] text-slate-500">
                  {rectStart
                    ? '横の向きをクリック (縦はその左 90 度)'
                    : '開始点 (角) をクリック → 横の向きをクリック'}
                </span>
                {rectStart && (
                  <button
                    type="button"
                    onClick={() => setRectStart(null)}
                    className="h-7 px-2 rounded border text-slate-600 shrink-0"
                  >
                    やり直す
                  </button>
                )}
              </>
            )}

            {/* 垂線: 基準線 → 通過点 → 延長 (数値 or 終点クリック) */}
            {mode === 'perp' && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">垂線</span>
                {perpThrough && (
                  <label className="flex items-center gap-1 shrink-0">
                    <span className="text-[11px] text-slate-600">延長 (m)</span>
                    <NumberField
                      value={perpLength}
                      onChange={setPerpLength}
                      onEnter={commitPerp}
                      min={0}
                      className="w-20 h-7 px-2 border rounded text-right font-mono"
                    />
                  </label>
                )}
                <span className="text-[11px] text-slate-500">
                  {!perpBase
                    ? '基準にする線 (または面の辺) をクリック'
                    : !perpThrough
                      ? '通過点をクリック'
                      : '延長を入れるか、終点をクリック → 確定'}
                </span>
                {perpShape && (
                  <button
                    type="button"
                    onClick={commitPerp}
                    className="h-7 px-3 rounded bg-indigo-600 text-white shrink-0"
                  >
                    確定 (Enter)
                  </button>
                )}
                {perpBase && (
                  <button
                    type="button"
                    onClick={() => {
                      setPerpBase(null)
                      setPerpThrough(null)
                    }}
                    className="h-7 px-2 rounded border text-slate-600 shrink-0"
                  >
                    やり直す
                  </button>
                )}
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
                  <NumberField
                    value={parallelSpacing}
                    onChange={setParallelSpacing}
                    onEnter={commitParallel}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">本数</span>
                  <NumberField
                    step="1"
                    min={1}
                    max={20}
                    value={parallelCount}
                    onChange={setParallelCount}
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
                  確定 (Enter)
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
                {/* 距離: 2 点で測るか、既存の線を選んで測るか */}
                {mode === 'measure-dist' && (
                  <div className="flex items-center rounded border overflow-hidden shrink-0">
                    {([false, true] as const).map((byElement) => (
                      <button
                        key={String(byElement)}
                        type="button"
                        onClick={() => {
                          setDistPickElement(byElement)
                          setMeasurePoints([])
                          setLastMeasure(null)
                        }}
                        className={`h-7 px-2 ${
                          distPickElement === byElement
                            ? 'bg-rose-600 text-white'
                            : 'bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {byElement ? '線を選択' : '2 点'}
                      </button>
                    ))}
                  </div>
                )}

                {lastMeasure ? (
                  <span className="font-bold text-rose-600 tabular-nums">
                    {formatMeasure(lastMeasure)}
                    {lastMeasure.kind === 'dist' &&
                      (lastMeasure.segments?.length ?? 0) > 1 &&
                      ` (${lastMeasure.segments?.length} 辺)`}
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">
                    {mode === 'measure-dist'
                      ? distPickElement
                        ? '測りたい線 (または面) をクリック'
                        : '2 点をクリック'
                      : mode === 'measure-area'
                        ? `頂点をクリック (${measurePoints.length}) → 最初の点をもう一度クリックで確定`
                        : '基準線の 2 点 → 対象の 1 点をクリック'}
                  </span>
                )}

                {/* 連続線のとき、各辺 / 合計 の どちらを出すか (両方も可) */}
                {mode === 'measure-dist' && (lastMeasure?.segments?.length ?? 0) > 1 && (
                  <>
                    <label className="flex items-center gap-1 shrink-0 text-slate-700">
                      <input
                        type="checkbox"
                        checked={distShowEach}
                        onChange={(ev) => setDistShowEach(ev.target.checked)}
                      />
                      各辺
                    </label>
                    <label className="flex items-center gap-1 shrink-0 text-slate-700">
                      <input
                        type="checkbox"
                        checked={distShowTotal}
                        onChange={(ev) => setDistShowTotal(ev.target.checked)}
                      />
                      合計
                    </label>
                  </>
                )}

                {/* 計測値を そのまま 文字として 残す */}
                {lastMeasure && (
                  <button
                    type="button"
                    onClick={saveMeasureAsText}
                    className="h-7 px-3 rounded bg-blue-600 text-white shrink-0"
                    title="表示している計測値を、同じ位置・向きの文字として保存する"
                  >
                    文字として保存
                  </button>
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

            {/* 端部の伸縮: 長さを入れるか、対象の線・円をクリックして交点まで */}
            {mode === 'select' && stretchAxis && (
              <>
                <span className="font-semibold text-orange-600 shrink-0">
                  {stretchEnd === 'end' ? '終点' : '始点'}を伸縮
                </span>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">長さ (m)</span>
                  <NumberField
                    value={stretchLength}
                    onChange={setStretchLength}
                    onEnter={commitStretch}
                    min={0}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <label className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] text-slate-600">増減 (m)</span>
                  <NumberField
                    value={Math.round((stretchLength - stretchAxis.current) * 100) / 100}
                    onChange={(v) => setStretchLength(Math.max(0, stretchAxis.current + v))}
                    onEnter={commitStretch}
                    className="w-20 h-7 px-2 border rounded text-right font-mono"
                  />
                </label>
                <span className="text-[11px] text-slate-500">
                  {stretchCandidates.length > 0
                    ? '交点が複数あります。残す側の青い点をクリック'
                    : '＋で伸び、−で縮む / 対象の線・円をクリックでその交点まで / 何もない所をクリックでそこまで'}
                </span>
                <button
                  type="button"
                  onClick={commitStretch}
                  className="h-7 px-3 rounded bg-orange-600 text-white shrink-0"
                >
                  確定 (Enter)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStretchEnd(null)
                    setStretchCandidates([])
                    setStretchTarget(null)
                  }}
                  className="h-7 px-2 rounded border text-slate-600 shrink-0"
                >
                  やめる
                </button>
              </>
            )}

            {/* 選択の仕方。点で 1 つずつ / 線・長方形・多角形で まとめて */}
            {mode === 'select' && !stretchAxis && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">
                  選択 ({SELECT_METHOD_LABEL[selectMethod]})
                </span>
                {selectedIds.length > 0 ? (
                  <span className="text-[11px] text-blue-700 font-semibold shrink-0">
                    {selectedIds.length} 個選択中
                  </span>
                ) : (
                  <span className="text-[11px] text-slate-500">
                    {selectMethod === 'point'
                      ? '図形をクリック (Shift で追加)'
                      : selectMethod === 'line'
                        ? '2 点をクリック → 線に触れた図形を選ぶ'
                        : selectMethod === 'rect'
                          ? '対角の 2 点をクリック'
                          : `頂点をクリック (${selectShape.length}) → Enter で確定`}
                  </span>
                )}
                {selectedIds.length > 0 && (
                  <>
                    {/* 平行移動 / 複製。始点 → 終点 の 2 クリックで ずらす量を決める */}
                    {(['move', 'copy'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setTransformMode(transformMode === m ? null : m)
                          setTransformFrom(null)
                        }}
                        className={`h-7 px-3 rounded border shrink-0 ${
                          transformMode === m
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        {m === 'move' ? '移動' : 'コピー'}
                      </button>
                    ))}
                    {transformMode && (
                      <span className="text-[11px] text-slate-500">
                        {transformFrom ? '終点をクリック' : '始点をクリック'}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedIds([])
                        setTransformMode(null)
                        setTransformFrom(null)
                      }}
                      className="h-7 px-2 rounded border text-slate-600 shrink-0"
                    >
                      選択解除
                    </button>
                  </>
                )}
              </>
            )}

            {/* まとめて選んだときは 削除だけ ここに置く。
                レイヤ / 色 / 線種 / 線幅 / 矢印は 左パネルの「描画の設定」で変える */}
            {mode === 'select' && selectedIds.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`${selectedIds.length} 個の図形を削除しますか？`)) return
                  for (const id of selectedIds) void deleteStroke(id)
                  setSelectedIds([])
                }}
                className="h-7 px-3 rounded border border-red-300 text-red-600 hover:bg-red-50 shrink-0"
              >
                削除
              </button>
            )}

            {/* 1 つだけ選んだとき。共通の属性 (レイヤ / 色 / 線種 / 線幅 / 矢印) は
                左パネルの「描画の設定」で変えるので、ここには 文字だけに ある
                項目 (内容 / 角度 / サイズ) と 削除を 置く */}
            {mode === 'select' && selectedStroke && !stretchAxis && (
              <>
                <span className="font-semibold text-slate-700 shrink-0">
                  {KIND_LABEL[selectedStroke.kind]}
                </span>

                {selectedStroke.kind === 'text' && (
                  <>
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
                    <label className="flex items-center gap-1 shrink-0">
                      <span className="text-[11px] text-slate-600">角度</span>
                      <NumberField
                        key={`rot-${selectedStroke.id}`}
                        step="1"
                        value={selectedStroke.rotation_deg ?? 0}
                        onChange={(v) =>
                          void updateStrokeAttrs(selectedStroke.id, { rotationDeg: v })
                        }
                        className="w-16 h-7 px-1 border rounded text-right font-mono"
                      />
                      <span className="text-[11px] text-slate-500">°</span>
                    </label>
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
                  </>
                )}

                <span className="text-[11px] text-slate-500 shrink-0">
                  レイヤ / 色 / 線種 / 線幅 / 矢印は左パネルで
                </span>

                <button
                  type="button"
                  onClick={() => {
                    void deleteStroke(selectedStroke.id)
                    setSelectedIds([])
                  }}
                  className="h-7 px-3 rounded border border-red-300 text-red-600 hover:bg-red-50 shrink-0"
                >
                  削除
                </button>
              </>
            )}
          </>,
          commandBarEl,
        )}
    </Pane>
  )
}
