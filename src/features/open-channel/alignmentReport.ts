// 路線線形 の 計算書 (A4 横) を 組む。
//
// 出す もの は 3 種類。 実物 (doc/02_線形計算書/) の 桁 と 並び に 合わせて いる。
//   route       … IP法 入力データプリント + 主要点計算書
//   station     … 中間点計算書
//   widthStake  … 幅杭計算書
//
// 中身 は 画面 / TIFF / PDF で 共用 して いる DrawItem (用紙 mm、左上 原点、y 下向き)
// で 組み、renderToCanvas → canvasesToPdf で 紙 に する。 日本語 の 字形 を
// 埋め込む 手間 を 避ける ため、文字 も 含めて 画像 に して しまう。
//
// 座標系 は 平面直角 (x=北 / y=東)。 方向角 は 北 を 0 と した 時計回り な ので
// atan2(Δy, Δx) が そのまま 方向角 に なる。

import type { DrawItem } from '@/features/boundary-survey/floorPlanDraw'
import {
  getCurveMarkers,
  getIpCornerGuides,
  pointAtDistance,
  tangentAtDistance,
  totalLength,
  type AlignmentSegment,
  type AlignmentVertex,
} from '@/lib/openChannel/alignment'

/** 用紙 は A4 横 */
export const REPORT_SHEET = { w: 297, h: 210 }

/** 線 の 太さ (mm)。 実物 の 罫線 に 近い 細さ */
const LW = 0.18
const LAYER = 'CALC'

/**
 * 杭 No の 刻み (m)。 実物 の 成果 は 100 m 区切り で No を 振って いる
 * (例: 追加距離 4940.000 → 49 + 40.000)。
 */
const STAKE_PITCH_M = 100

export type AlignmentReportKind = 'route' | 'station' | 'widthStake'

export const REPORT_LABEL: Record<AlignmentReportKind, string> = {
  route: '線形データ計算書',
  station: '中間点計算書',
  widthStake: '幅杭計算書',
}

export interface AlignmentReportInput {
  /** 現場名 (工区名) */
  siteName: string
  /** 路線名 (線形名) */
  routeName: string
  /** BP に 割り当てた SP 値。 追加距離 = BP からの 距離 + これ */
  spOffset: number
  /** 線形点 (BP → IP → EP)。 座標 は 解決済み */
  vertices: AlignmentVertex[]
  /** 点名。 vertices と 同じ 並び */
  vertexNames: string[]
  segments: AlignmentSegment[]
  /** 中間点。 distance は BP からの 内部距離 */
  stations: { label: string; distance: number }[]
  /** 幅杭。 offset は 右 +/左 - */
  widthStakes: { distance: number; offset: number; note?: string }[]
  /** 右上 に 出す 測地系 の 但し書き */
  datumNote?: string
}

// ========================================================================
// 数値 の 体裁
// ========================================================================

const f3 = (v: number): string => v.toFixed(3)

/** 度 を 「86-09-40」 の 形 に。 360 で 丸めて から 度分秒 に する */
export function formatDms(deg: number): string {
  let d = deg % 360
  if (d < 0) d += 360
  let sec = Math.round(d * 3600)
  const dd = Math.floor(sec / 3600)
  sec -= dd * 3600
  const mm = Math.floor(sec / 60)
  const ss = sec - mm * 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${dd}-${p2(mm)}-${p2(ss)}`
}

/** 方向角 (度)。 x=北 / y=東 な ので atan2(Δy, Δx) が そのまま 方位 */
function azimuthDeg(dx: number, dy: number): number {
  const a = (Math.atan2(dy, dx) * 180) / Math.PI
  return a < 0 ? a + 360 : a
}

/** 追加距離 (SP) を 「49 + 40.000」 に */
export function formatStation(sp: number): string {
  const no = Math.floor(sp / STAKE_PITCH_M)
  const rest = sp - no * STAKE_PITCH_M
  return `${no} + ${rest.toFixed(3)}`
}

// ========================================================================
// 描く ための 小物
// ========================================================================

function text(
  out: DrawItem[],
  x: number,
  y: number,
  s: string,
  h: number,
  anchor: 'start' | 'middle' | 'end' = 'start',
  bold = false,
): void {
  if (!s) return
  out.push({ kind: 'text', x, y, text: s, h, anchor, rot: 0, layer: LAYER, bold })
}

function line(out: DrawItem[], x1: number, y1: number, x2: number, y2: number): void {
  out.push({ kind: 'line', x1, y1, x2, y2, w: LW, layer: LAYER })
}

/** 表 の 1 列 */
interface Col {
  label: string
  /** 幅 (mm) */
  w: number
  align?: 'start' | 'middle' | 'end'
}

/** 表 の 1 マス。 文字 だけ の とき は 文字列 で よい */
type Cell = string | { t: string; align?: 'start' | 'middle' | 'end'; span?: number }

const cellText = (c: Cell): string => (typeof c === 'string' ? c : c.t)
const cellSpan = (c: Cell): number => (typeof c === 'string' ? 1 : (c.span ?? 1))

/**
 * 罫線付き の 表 を 1 つ 引く。 見出し 行 は 省略 可。
 * 戻り値 は 表 の 下端 (mm)。
 */
function drawTable(
  out: DrawItem[],
  x0: number,
  yTop: number,
  cols: Col[],
  rows: Cell[][],
  opt?: { rowH?: number; headH?: number; fs?: number; noHead?: boolean },
): number {
  const rowH = opt?.rowH ?? 4.6
  const headH = opt?.headH ?? (opt?.noHead ? 0 : 5.0)
  const fs = opt?.fs ?? 2.5
  // 列 の 境目
  const xs: number[] = [x0]
  for (const c of cols) xs.push(xs[xs.length - 1] + c.w)
  const x1 = xs[xs.length - 1]

  // 行 の 上端
  const ys: number[] = [yTop]
  if (headH > 0) ys.push(yTop + headH)
  for (let i = 0; i < rows.length; i += 1) ys.push(ys[ys.length - 1] + rowH)
  const yBottom = ys[ys.length - 1]

  // 横罫
  for (const y of ys) line(out, x0, y, x1, y)
  // 縦罫。 まとめた マス の 内側 は 引かない
  for (let c = 0; c < xs.length; c += 1) {
    const x = xs[c]
    let from: number | null = null
    const rowCount = ys.length - 1
    for (let r = 0; r <= rowCount; r += 1) {
      const inner = c > 0 && c < xs.length - 1
      const rowIdx = headH > 0 ? r - 1 : r
      const merged =
        inner && rowIdx >= 0 && rowIdx < rows.length ? coveredBySpan(rows[rowIdx], c) : false
      if (!merged) {
        if (from == null) from = ys[r]
      } else if (from != null) {
        line(out, x, from, x, ys[r])
        from = null
      }
    }
    if (from != null) line(out, x, from, x, yBottom)
  }

  // 見出し
  if (headH > 0) {
    cols.forEach((c, i) => {
      text(out, (xs[i] + xs[i + 1]) / 2, yTop + headH / 2 + fs * 0.38, c.label, fs, 'middle', true)
    })
  }
  // 中身
  rows.forEach((row, ri) => {
    const yMid = ys[(headH > 0 ? 1 : 0) + ri] + rowH / 2 + fs * 0.38
    let ci = 0
    for (const cell of row) {
      const span = cellSpan(cell)
      const left = xs[ci]
      const right = xs[Math.min(ci + span, xs.length - 1)]
      const align =
        (typeof cell === 'string' ? undefined : cell.align) ?? cols[ci]?.align ?? 'middle'
      const tx = align === 'start' ? left + 1.0 : align === 'end' ? right - 1.0 : (left + right) / 2
      text(out, tx, yMid, cellText(cell), fs, align)
      ci += span
    }
  })
  return yBottom
}

function coveredBySpan(row: Cell[], col: number): boolean {
  let ci = 0
  for (const c of row) {
    const span = cellSpan(c)
    if (col > ci && col < ci + span) return true
    ci += span
  }
  return false
}

/** どの ページ にも 出す 見出し。 戻り値 は 本文 を 始められる y */
function pageHeader(
  out: DrawItem[],
  input: AlignmentReportInput,
  title: string,
  pageNo: number,
): number {
  const S = REPORT_SHEET
  text(out, S.w - 14, 14, input.datumNote ?? '世界測地系（測地成果2024）', 2.6, 'end')
  text(out, S.w / 2, 22.5, title, 5.0, 'middle', true)
  text(out, 14, 31.5, `現場名：${input.siteName}`, 3.2)
  text(out, 14, 37.0, `路線名：${input.routeName}`, 3.2)
  text(out, S.w / 2, S.h - 10, `－\u3000${pageNo}\u3000－`, 2.8, 'middle')
  return 42
}

// ========================================================================
// 線形データ計算書 (IP法 入力データプリント + 主要点計算書)
// ========================================================================

/** BP からの 内部距離 での 座標 と 接線方向角 */
function at(segments: AlignmentSegment[], d: number) {
  const p = pointAtDistance(segments, d)
  const t = tangentAtDistance(segments, d)
  return {
    x: p?.x ?? NaN,
    y: p?.y ?? NaN,
    az: t ? azimuthDeg(t.x, t.y) : NaN,
  }
}

function buildRoutePages(input: AlignmentReportInput): DrawItem[][] {
  const { vertices, vertexNames, segments, spOffset } = input
  const pages: DrawItem[][] = []

  // ---- 1 枚目: IP法 入力データプリント
  const p1: DrawItem[] = []
  let y = pageHeader(p1, input, 'ＩＰ法\u3000入力データプリント', 1)
  const total = totalLength(segments)
  text(
    p1,
    14,
    y + 2.5,
    `BP点杭No＋L：\u3000${formatStation(spOffset)}\u3000\u3000追加距離：\u3000${f3(spOffset)}` +
      `\u3000\u3000杭ピッチ：\u3000${f3(STAKE_PITCH_M)}\u3000\u3000路線長：\u3000${f3(total)}`,
    2.8,
  )
  y += 6.5

  // TL (IP から 曲線 の 始点 まで) は 緩和曲線 込み の 実際 の 位置 から 測る
  const guides = new Map<number, { ts: { x: number; y: number } }>()
  for (const g of getIpCornerGuides(vertices)) guides.set(g.vertexIndex, { ts: g.ts })

  const ipCols: Col[] = [
    { label: 'IP', w: 10 },
    { label: '点番', w: 11 },
    { label: '点\u3000名', w: 26, align: 'start' },
    { label: 'Ｘ座標', w: 22, align: 'end' },
    { label: 'Ｙ座標', w: 22, align: 'end' },
    { label: '距\u3000離', w: 18, align: 'end' },
    { label: '方\u3000向\u3000角', w: 20 },
    { label: 'IA', w: 18 },
    { label: 'タイプ', w: 18 },
    { label: 'R1', w: 15, align: 'end' },
    { label: 'R2', w: 15, align: 'end' },
    { label: 'A1', w: 13, align: 'end' },
    { label: 'A2', w: 13, align: 'end' },
    { label: 'A3', w: 13, align: 'end' },
    { label: 'TL', w: 15, align: 'end' },
  ]
  let ipNo = 0
  const ipRows: Cell[][] = vertices.map((v, i) => {
    const next = vertices[i + 1]
    const prev = vertices[i - 1]
    const dist = next ? Math.hypot(next.x - v.x, next.y - v.y) : NaN
    const az = next ? azimuthDeg(next.x - v.x, next.y - v.y) : NaN
    // 交角 IA = 入って くる 向き と 出て いく 向き の 差 (0〜180)
    let ia = NaN
    if (prev && next) {
      const azIn = azimuthDeg(v.x - prev.x, v.y - prev.y)
      const azOut = azimuthDeg(next.x - v.x, next.y - v.y)
      let d = Math.abs(azOut - azIn) % 360
      if (d > 180) d = 360 - d
      ia = d
    }
    const ts = guides.get(i)?.ts
    const tl = ts ? Math.hypot(v.x - ts.x, v.y - ts.y) : NaN
    if (v.kind === 'ip') ipNo += 1
    return [
      v.kind === 'ip' ? String(ipNo) : '',
      String(i + 1),
      { t: vertexNames[i] ?? '', align: 'start' },
      { t: f3(v.x), align: 'end' },
      { t: f3(v.y), align: 'end' },
      { t: Number.isFinite(dist) ? f3(dist) : '', align: 'end' },
      Number.isFinite(az) ? formatDms(az) : '',
      Number.isFinite(ia) ? formatDms(ia) : '',
      v.kind === 'bp' ? 'BP点' : v.kind === 'ep' ? 'EP点' : 'IP点',
      { t: v.radius ? f3(v.radius) : '', align: 'end' },
      '',
      { t: v.spiralAIn ? f3(v.spiralAIn) : '', align: 'end' },
      { t: v.spiralAOut ? f3(v.spiralAOut) : '', align: 'end' },
      '',
      { t: Number.isFinite(tl) ? f3(tl) : '', align: 'end' },
    ]
  })
  drawTable(p1, 14, y, ipCols, ipRows)
  pages.push(p1)

  // ---- 2 枚目: 主要点計算書
  const p2: DrawItem[] = []
  y = pageHeader(p2, input, '主\u3000要\u3000点\u3000計\u3000算\u3000書', 2)

  // IP ごと の 1 行 ボックス
  const boxCols: Col[] = [
    { label: '', w: 16 },
    { label: '', w: 20 },
    { label: '', w: 16 },
    { label: '', w: 14 },
    { label: '', w: 18 },
    { label: '', w: 14 },
    { label: '', w: 18 },
    { label: '', w: 32, align: 'start' },
    { label: '', w: 16 },
    { label: '', w: 24, align: 'end' },
    { label: '', w: 16 },
    { label: '', w: 24, align: 'end' },
    { label: '', w: 41 },
  ]
  // 箱 が 増える と 表 の 場所 が 無くなる ので、半分 より 下 に は 置かない
  const BOX_LIMIT_Y = REPORT_SHEET.h * 0.5
  let boxesShown = 0
  vertices.forEach((v, i) => {
    if (y + 5.2 > BOX_LIMIT_Y) return
    boxesShown += 1
    const rows: Cell[][] = [
      [
        'IPタイプ',
        v.kind === 'bp' ? 'BP' : v.kind === 'ep' ? 'EP' : 'IP',
        'IPNo.',
        '',
        'IP点番',
        { t: String(i + 1), align: 'end' },
        'IP点名',
        { t: vertexNames[i] ?? '', align: 'start' },
        'Ｘ座標',
        { t: f3(v.x), align: 'end' },
        'Ｙ座標',
        { t: f3(v.y), align: 'end' },
        '',
      ],
    ]
    y = drawTable(p2, 14, y, boxCols, rows, { noHead: true, rowH: 5.2 }) + 2.4
  })

  // 全長 と 交角
  const lenCols: Col[] = [
    { label: '', w: 16 },
    { label: '', w: 22, align: 'end' },
    { label: '', w: 22 },
    { label: '', w: 22, align: 'end' },
    { label: '', w: 12 },
    { label: '', w: 20, align: 'end' },
  ]
  if (boxesShown < vertices.length) {
    text(p2, 14, y + 2.4, `※ 線形点 は 全 ${vertices.length} 点。 残り は 下 の 表 を 参照`, 2.4)
    y += 4.4
  }
  const ipSpan =
    vertices.length >= 2
      ? Math.hypot(
          vertices[vertices.length - 1].x - vertices[0].x,
          vertices[vertices.length - 1].y - vertices[0].y,
        )
      : 0
  y =
    drawTable(
      p2,
      14,
      y + 1.5,
      lenCols,
      [['L=', { t: f3(total), align: 'end' }, 'IP間距離=', { t: f3(ipSpan), align: 'end' }, 'IA=', '']],
      { noHead: true, rowH: 5.2 },
    ) + 4.0

  // 主要点 (BP / BC / EC / TS / SC / CS / ST / EP)
  const mainCols: Col[] = [
    { label: '点番', w: 12 },
    { label: '点\u3000\u3000名', w: 34, align: 'start' },
    { label: 'ステーション', w: 30 },
    { label: '単距離', w: 20, align: 'end' },
    { label: '追加距離', w: 22, align: 'end' },
    { label: 'Ｘ座標', w: 24, align: 'end' },
    { label: 'Ｙ座標', w: 24, align: 'end' },
    { label: '接線方向角', w: 24 },
    { label: '横断方向角', w: 24 },
    { label: '中\u3000心\u3000角', w: 25 },
  ]
  const MARKER_LABEL: Record<string, string> = {
    bc: 'BC',
    ec: 'EC',
    ts: 'TS',
    sc: 'SC',
    cs: 'CS',
    st: 'ST',
  }
  const mains: { name: string; d: number; center?: number }[] = []
  mains.push({ name: vertexNames[0] ?? 'BP', d: 0 })
  for (const m of getCurveMarkers(segments)) {
    mains.push({ name: MARKER_LABEL[m.kind] ?? m.kind.toUpperCase(), d: m.distance })
  }
  // 円弧 の 中心角 は EC 行 に 添える
  let acc = 0
  for (const sgm of segments) {
    if (sgm.kind === 'arc') {
      const dEnd = acc + sgm.length
      const hit = mains.find((r) => Math.abs(r.d - dEnd) < 1e-6)
      if (hit) hit.center = (Math.abs(sgm.dA) * 180) / Math.PI
    }
    acc += sgm.length
  }
  mains.push({ name: vertexNames[vertices.length - 1] ?? 'EP', d: total })
  mains.sort((a, b) => a.d - b.d)

  const mainRows: Cell[][] = mains.map((r, i) => {
    const g = at(segments, r.d)
    const prev = i > 0 ? mains[i - 1].d : null
    return [
      String(i + 1),
      { t: r.name, align: 'start' },
      formatStation(r.d + spOffset),
      { t: prev == null ? '' : f3(r.d - prev), align: 'end' },
      { t: f3(r.d + spOffset), align: 'end' },
      { t: f3(g.x), align: 'end' },
      { t: f3(g.y), align: 'end' },
      Number.isFinite(g.az) ? formatDms(g.az) : '',
      Number.isFinite(g.az) ? formatDms(g.az + 90) : '',
      r.center != null ? formatDms(r.center) : '',
    ]
  })
  const cap = rowCapacity(y)
  drawTable(p2, 14, y, mainCols, mainRows.slice(0, cap))
  pages.push(p2)
  // 溢れ た 分 は 見出し だけ の ページ に 続ける
  for (let i = cap; i < mainRows.length; i += ROWS_PER_PAGE) {
    const pn: DrawItem[] = []
    const y2 = pageHeader(pn, input, '主\u3000要\u3000点\u3000計\u3000算\u3000書', pages.length + 1)
    drawTable(pn, 14, y2, mainCols, mainRows.slice(i, i + ROWS_PER_PAGE))
    pages.push(pn)
  }

  return pages
}

// ========================================================================
// 中間点計算書
// ========================================================================

/** 本文 の 下端 (ページ番号 の 上) */
const BODY_BOTTOM = REPORT_SHEET.h - 16

/** y から 下 に 何 行 入る か (見出し 行 を 含めて 数える) */
function rowCapacity(y: number, rowH = 4.6, headH = 5.0): number {
  return Math.max(1, Math.floor((BODY_BOTTOM - y - headH) / rowH))
}

/** 1 枚 に 収まる 行 数 (本文 が y=42 から 始まる とき) */
const ROWS_PER_PAGE = rowCapacity(42)

function buildStationPages(input: AlignmentReportInput): DrawItem[][] {
  const { segments, spOffset, stations, vertices, vertexNames } = input
  const total = totalLength(segments)

  // BP / EP は 中間点 に 無ければ 端 に 足す (計算書 は 端 から 並べる)
  const rows: { name: string; d: number }[] = stations
    .map((s) => ({ name: s.label, d: s.distance }))
    .sort((a, b) => a.d - b.d)
  if (!rows.some((r) => Math.abs(r.d) < 1e-6)) {
    rows.unshift({ name: vertexNames[0] ?? 'BP', d: 0 })
  }
  if (!rows.some((r) => Math.abs(r.d - total) < 1e-6)) {
    rows.push({ name: vertexNames[vertices.length - 1] ?? 'EP', d: total })
  }

  const cols: Col[] = [
    { label: '点\u3000番', w: 13 },
    { label: '点\u3000\u3000\u3000名', w: 34, align: 'start' },
    { label: 'ステーション', w: 28 },
    { label: '単距離', w: 18, align: 'end' },
    { label: '追加距離', w: 20, align: 'end' },
    { label: 'Ｘ座標', w: 23, align: 'end' },
    { label: 'Ｙ座標', w: 23, align: 'end' },
    { label: '接線方向角', w: 21 },
    { label: '弦方向角', w: 21 },
    { label: '弦\u3000長', w: 17, align: 'end' },
    { label: '横\u3000断\u3000角', w: 21 },
    { label: '横断方向角', w: 21 },
  ]

  const all: Cell[][] = rows.map((r, i) => {
    const g = at(segments, r.d)
    const prev = i > 0 ? rows[i - 1] : null
    const next = i < rows.length - 1 ? rows[i + 1] : null
    // 弦 は 次 の 点 まで。 最後 の 行 は 空
    let chordLen = NaN
    let chordAz = NaN
    if (next) {
      const gn = at(segments, next.d)
      chordLen = Math.hypot(gn.x - g.x, gn.y - g.y)
      chordAz = azimuthDeg(gn.x - g.x, gn.y - g.y)
    }
    const crossAz = g.az + 90
    return [
      String(i + 1),
      { t: r.name, align: 'start' },
      formatStation(r.d + spOffset),
      { t: prev ? f3(r.d - prev.d) : '', align: 'end' },
      { t: f3(r.d + spOffset), align: 'end' },
      { t: f3(g.x), align: 'end' },
      { t: f3(g.y), align: 'end' },
      Number.isFinite(g.az) ? formatDms(g.az) : '',
      Number.isFinite(chordAz) ? formatDms(chordAz) : '',
      { t: Number.isFinite(chordLen) ? f3(chordLen) : '', align: 'end' },
      Number.isFinite(chordAz) ? formatDms(crossAz - chordAz) : '',
      Number.isFinite(g.az) ? formatDms(crossAz) : '',
    ]
  })

  return paginate(all, (chunk, pageNo) => {
    const out: DrawItem[] = []
    const y = pageHeader(out, input, '中\u3000間\u3000点\u3000計\u3000算\u3000書', pageNo)
    drawTable(out, 14, y, cols, chunk)
    return out
  })
}

// ========================================================================
// 幅杭計算書
// ========================================================================

function buildWidthStakePages(input: AlignmentReportInput): DrawItem[][] {
  const { segments, spOffset, widthStakes, stations } = input

  // センター の 距離 ごと に まとめ、左 / 右 の 2 行 に 割る
  const byDistance = new Map<number, { left?: number; right?: number; note: Map<number, string> }>()
  for (const w of widthStakes) {
    const key = Math.round(w.distance * 1000) / 1000
    const g = byDistance.get(key) ?? { note: new Map<number, string>() }
    if (w.offset < 0) g.left = Math.abs(w.offset)
    else if (w.offset > 0) g.right = w.offset
    if (w.note) g.note.set(Math.sign(w.offset), w.note)
    byDistance.set(key, g)
  }
  const centers = Array.from(byDistance.keys()).sort((a, b) => a - b)

  // 合計 267mm。 A4 横 の 使える 幅 (297 − 余白 14×2 = 269) に 収める
  const cols: Col[] = [
    { label: 'センター点番', w: 18 },
    { label: '点\u3000\u3000名', w: 26, align: 'start' },
    { label: 'ステーション', w: 26 },
    { label: '追加距離', w: 20, align: 'end' },
    { label: 'Ｘ座標', w: 22, align: 'end' },
    { label: 'Ｙ座標', w: 22, align: 'end' },
    { label: '接線方向角', w: 21 },
    { label: '左右', w: 11 },
    { label: '巾', w: 16, align: 'end' },
    { label: '点番', w: 13 },
    { label: '点\u3000\u3000名', w: 28, align: 'start' },
    { label: 'Ｘ座標', w: 22, align: 'end' },
    { label: 'Ｙ座標', w: 22, align: 'end' },
  ]

  /** 中心線 から 直角 に offset (右 +) だけ 出た 点 */
  const sidePoint = (d: number, offset: number) => {
    const p = pointAtDistance(segments, d)
    const t = tangentAtDistance(segments, d)
    if (!p || !t) return null
    // 進行方向 の 右手 は CCW 90° = (-t.y, t.x)
    return { x: p.x + offset * -t.y, y: p.y + offset * t.x }
  }

  let stakeNo = 0
  const all: Cell[][] = []
  centers.forEach((d, i) => {
    const g = at(segments, d)
    const grp = byDistance.get(d)
    const st = stations.find((s) => Math.abs(s.distance - d) < 1e-6)
    const centerName = st?.label ?? `SP${f3(d + spOffset)}`
    const sides: ('left' | 'right')[] = ['left', 'right']
    sides.forEach((side, k) => {
      const width = side === 'left' ? grp?.left : grp?.right
      const signed = width == null ? null : side === 'left' ? -width : width
      const pt = signed == null ? null : sidePoint(d, signed)
      if (pt) stakeNo += 1
      // センター の 情報 は 上 の 行 (左) にだけ 出す
      const head: Cell[] =
        k === 0
          ? [
              String(i + 1),
              { t: centerName, align: 'start' },
              formatStation(d + spOffset),
              { t: f3(d + spOffset), align: 'end' },
              { t: f3(g.x), align: 'end' },
              { t: f3(g.y), align: 'end' },
              Number.isFinite(g.az) ? formatDms(g.az) : '',
            ]
          : ['', '', '', '', '', '', '']
      all.push([
        ...head,
        side === 'left' ? '左' : '右',
        { t: width == null ? '' : f3(width), align: 'end' },
        pt ? String(stakeNo) : '',
        {
          t: pt ? (grp?.note.get(side === 'left' ? -1 : 1) ?? `${centerName}${side === 'left' ? 'L' : 'R'}${width}`) : '',
          align: 'start',
        },
        { t: pt ? f3(pt.x) : '', align: 'end' },
        { t: pt ? f3(pt.y) : '', align: 'end' },
      ])
    })
  })

  // 左 / 右 の 2 行 で 1 つ の センター な ので、偶数 行 で 切る
  return paginate(
    all,
    (chunk, pageNo) => {
      const out: DrawItem[] = []
      const y = pageHeader(out, input, '幅\u3000杭\u3000計\u3000算\u3000書', pageNo)
      drawTable(out, 14, y, cols, chunk)
      return out
    },
    ROWS_PER_PAGE - (ROWS_PER_PAGE % 2),
  )
}

// ========================================================================

/** 行 を 1 枚 分 ずつ 切って ページ に する */
function paginate(
  rows: Cell[][],
  render: (chunk: Cell[][], pageNo: number) => DrawItem[],
  perPage = ROWS_PER_PAGE,
): DrawItem[][] {
  if (rows.length === 0) return [render([], 1)]
  const pages: DrawItem[][] = []
  for (let i = 0; i < rows.length; i += perPage) {
    pages.push(render(rows.slice(i, i + perPage), pages.length + 1))
  }
  return pages
}

/** 計算書 を 組む。 1 要素 = 1 ページ */
export function buildAlignmentReportPages(
  kind: AlignmentReportKind,
  input: AlignmentReportInput,
): DrawItem[][] {
  if (kind === 'route') return buildRoutePages(input)
  if (kind === 'station') return buildStationPages(input)
  return buildWidthStakePages(input)
}
