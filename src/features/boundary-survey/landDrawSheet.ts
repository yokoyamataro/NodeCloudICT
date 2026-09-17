// 地積測量図 の 用紙 を 「描く もの の 並び」 に する。
//
// 用紙 は 建物図面 と 同じ B4 (364 × 257mm)。 罫線 の 位置 は
// doc/地積測量図3.tif (400dpi / 5732 × 4047px) を 画素 から 拾って mm に
// 直した もの。
//
// 左 が 計算書 (与点 の 成果 と 求積表)、右 が 図。 間 に 仕切り の 線 は 無い。
// 出力 (p21 / tif / pdf) は 建物図面 と 同じ 仕組み を そのまま 使う。

import {
  SHEET,
  type DrawItem,
  type DrawText,
} from './floorPlanDraw'
import {
  applicantLineHeight,
  applicantLines,
  makerTitle,
  placeOutline,
  warekiCreatedText,
  type FloorPlanFrame,
  type Pt,
} from './floorPlanTypes'
import { buildWhiskers } from './floorPlanWhisker'
import {
  calcParcelArea,
  n2,
  n3,
  n6,
  type LandDrawSpec,
  type LandSurveyDrawing,
} from './landDrawTypes'

/** 罫線 の 位置 (mm)。 実測値 */
export const LSHEET = {
  left: 25.08,
  right: 338.84,
  /** 枠 の 上端 と 下端 (左右 で 段違い) */
  frameTop: 9.78,
  frameBottom: 246.51,
  /** ヘッダ の 横罫 */
  headTop: 9.97,
  headMid: 20.45,
  headBottom: 31.05,
  /** 境界標 の 表 の 行 (種類 / 既設 / 新設) */
  markerRow1: 15.18,
  markerRow3: 25.78,
  /** 境界標 の 表 の 左右 */
  markerLeft: 55.88,
  markerRight: 172.15,
  /** 種類 の ラベル 列 の 右端 */
  markerLabelRight: 65.09,
  /** ヘッダ の 縦罫 (全高) */
  hx: [55.88, 172.09, 191.83, 218.06] as const,
  /** 地番 の 値 の 右端 (上段 だけ)。 ここ から 右上 は 枠 の 外 */
  hnValueRight: 262.13,
  /** 表題欄 */
  titleTop: 231.33,
  titleBottom: 246.38,
  tx: [25.08, 45.85, 172.09, 191.83, 211.9, 303.85, 314.07, 338.84] as const,
  /** 本体。 左 が 計算書、右 が 図 */
  bodyTop: 31.05,
  bodyBottom: 231.33,
  calcRight: 196.0,
} as const

const LW = 0.13
const LW_FIG = 0.25

const L = {
  frame: '図枠',
  title: '文字',
  calc: '計算書',
  site: '地番',
  dim: '寸法',
} as const

export interface LandParcelForDraw {
  label: string
  /** 平面直角座標 の 構成点 (X=北 / Y=東) */
  points: { id: string; pointNumber: string; x: number; y: number }[]
}

export interface ControlPointForDraw {
  id: string
  pointNumber: string
  x: number
  y: number
}

/** 用紙 1 枚 を 描く もの の 並び に する */
export function buildLandSheet(
  plan: LandSurveyDrawing,
  parcels: LandParcelForDraw[],
  neighbors: LandParcelForDraw[] = [],
  controls: ControlPointForDraw[] = [],
): DrawItem[] {
  const out: DrawItem[] = []
  const line: LineFn = (x1, y1, x2, y2, w = LW, layer = L.frame) => {
    out.push({ kind: 'line', x1, y1, x2, y2, w, layer })
  }
  const text: TextFn = (x, y, t, h, anchor = 'start', opts = {}) => {
    if (!t) return
    out.push({
      kind: 'text',
      id: opts.id,
      x,
      y,
      text: t,
      h,
      anchor,
      rot: opts.rot ?? 0,
      pitch: opts.pitch,
      bold: opts.bold,
      layer: opts.layer ?? L.title,
    })
  }

  drawFrame(out, line, text, plan)
  drawCalc(out, text, line, plan, parcels, controls)
  drawMap(out, plan, parcels, neighbors)
  drawTitleBlock(out, text, plan.frame, plan.scale_denominator)

  return out
}

// ========================================================================
// 図枠
// ========================================================================

type LineFn = (x1: number, y1: number, x2: number, y2: number, w?: number, layer?: string) => void
type TextFn = (
  x: number,
  y: number,
  t: string,
  h: number,
  anchor?: DrawText['anchor'],
  opts?: { rot?: number; pitch?: number; bold?: boolean; layer?: string; id?: string },
) => void

function drawFrame(out: DrawItem[], line: LineFn, text: TextFn, plan: LandSurveyDrawing) {
  const S = LSHEET
  const spec = plan.spec

  // 横罫。 一番上 は 地番 の 値 の 右端 で 止まる (そこ から 右上 は 枠 の 外)
  line(S.left, S.headTop, S.hnValueRight, S.headTop)
  line(S.left, S.headMid, S.right, S.headMid)
  line(S.left, S.headBottom, S.right, S.headBottom)
  line(S.left, S.titleTop, S.right, S.titleTop)
  line(S.left, S.titleBottom, S.right, S.titleBottom)
  // 境界標 の 表 の 行 (表題 の 下 / 既設 の 下)
  line(S.markerLeft, S.markerRow1, S.markerRight, S.markerRow1)
  line(S.markerLeft, S.markerRow3, S.markerRight, S.markerRow3)

  // 縦罫。 左 は 通し、右 は 段違い の ぶん 下 から
  line(S.left, S.frameTop, S.left, S.frameBottom)
  line(S.right, S.headMid, S.right, S.frameBottom)
  for (const x of S.hx) line(x, S.frameTop, x, S.headBottom)
  // 種類 の 列 の 仕切り は 表題 の 行 を 跨がない
  for (const x of markerDividers(spec)) line(x, S.markerRow1, x, S.headBottom)

  // 表題欄 の 仕切り
  for (const x of S.tx) line(x, S.titleTop, x, S.titleBottom)

  // ---- ヘッダ の 中身 ----
  const mapNoCx = (S.left + S.hx[0]) / 2
  text(mapNoCx, 16.5, '地図番号', 2.8, 'middle', { pitch: 3.4, id: 'land:mapNoLabel' })
  text(mapNoCx, 27.5, spec.mapNumber, 3.4, 'middle', { id: 'land:mapNo' })

  text((S.markerLeft + S.markerRight) / 2, 13.6, '境界標の種類及び筆界点の記号または点名', 2.4,
    'middle', { id: 'land:markerTitle' })

  const rowY = [S.markerRow1, S.headMid, S.markerRow3, S.headBottom]
  ;['種類', '既設', '新設'].forEach((lab, i) => {
    text((S.markerLeft + S.markerLabelRight) / 2, (rowY[i] + rowY[i + 1]) / 2 + 1.0, lab, 2.4,
      'middle', { id: `land:markerRow${i}` })
  })
  const cols = spec.markerColumns
  const edges = markerEdges(spec)
  cols.forEach((c, i) => {
    const cx = (edges[i] + edges[i + 1]) / 2
    text(cx, (rowY[0] + rowY[1]) / 2 + 1.0, c.kind, 2.4, 'middle', {
      id: `land:markerKind:${c.id}`,
    })
    text(cx, (rowY[1] + rowY[2]) / 2 + 1.0, c.existing, 2.6, 'middle', {
      id: `land:markerExisting:${c.id}`,
    })
    text(cx, (rowY[2] + rowY[3]) / 2 + 1.0, c.created, 2.6, 'middle', {
      id: `land:markerCreated:${c.id}`,
    })
  })

  const labelCx = (S.hx[2] + S.hx[3]) / 2
  text(labelCx, 16.5, '地番', 2.8, 'middle', { pitch: 5.0, id: 'land:parcelLabel' })
  text(labelCx, 27.5, '土地の所在', 2.8, 'middle', { pitch: 3.4, id: 'land:locLabel' })
  text(S.hx[3] + 3, 17.0, parcelNumbersOf(plan), 3.4, 'start', { id: 'land:parcelNo' })
  text(S.hx[3] + 3, 28.0, plan.location ?? '', 3.4, 'start', { id: 'land:location' })

  // 用紙 の 見出し は 枠 の 外
  text(268.0, 19.0, '地積測量図', 5.4, 'start', { pitch: 13.5, id: 'land:title' })

  void out
}

/** 境界標 の 表 の 列 の 境目 (左端 から 右端 まで) */
function markerEdges(spec: LandDrawSpec): number[] {
  const S = LSHEET
  const n = Math.max(spec.markerColumns.length, 1)
  const w = (S.markerRight - S.markerLabelRight) / n
  return Array.from({ length: n + 1 }, (_, i) => S.markerLabelRight + w * i)
}

/** 列 を 分ける 縦罫 (両端 は 枠 の 線 な ので 除く) */
function markerDividers(spec: LandDrawSpec): number[] {
  return markerEdges(spec).slice(1, -1)
}

/** ヘッダ に 出す 地番 の 並び */
function parcelNumbersOf(plan: LandSurveyDrawing): string {
  return plan.title?.trim() ? plan.title.trim() : ''
}

// ========================================================================
// 左: 計算書
// ========================================================================

/**
 * 表 を 1 つ 引く。 外枠 と 行 / 列 の 仕切り、中身 の 文字 を まとめて 出す。
 * 桁 は 実物 に 合わせて 列 の 位置 を 絶対値 で 渡す。
 */
interface TCell {
  text: string
  align?: 'start' | 'middle' | 'end'
  /** 2 段 に 書く とき の 2 行目 */
  sub?: string
  h?: number
  /** 右 へ 何 列 ぶん 伸ばす か (仕切り を 引かない) */
  span?: number
  id?: string
}

function drawTable(
  out: DrawItem[],
  text: TextFn,
  xs: number[],
  yTop: number,
  rows: { h: number; cells: TCell[] }[],
  layer: string,
): number {
  const x0 = xs[0]
  const x1 = xs[xs.length - 1]
  let y = yTop
  const ys = [y]
  for (const r of rows) {
    y += r.h
    ys.push(y)
  }
  // 外枠 と 行 の 仕切り
  for (const yy of ys) out.push({ kind: 'line', x1: x0, y1: yy, x2: x1, y2: yy, w: LW, layer })
  // 列 の 仕切り。 まとめた セル の 所 は 引かない
  for (let c = 0; c < xs.length; c += 1) {
    const x = xs[c]
    let from: number | null = null
    for (let r = 0; r <= rows.length; r += 1) {
      const inner = c > 0 && c < xs.length - 1
      const merged =
        inner && r < rows.length ? coveredBySpan(rows[r].cells, c) : false
      if (!merged) {
        if (from == null) from = ys[r]
      } else if (from != null) {
        out.push({ kind: 'line', x1: x, y1: from, x2: x, y2: ys[r], w: LW, layer })
        from = null
      }
    }
    if (from != null) {
      out.push({ kind: 'line', x1: x, y1: from, x2: x, y2: ys[ys.length - 1], w: LW, layer })
    }
  }
  // 中身
  rows.forEach((r, ri) => {
    let ci = 0
    for (const cell of r.cells) {
      const span = cell.span ?? 1
      const left = xs[ci]
      const right = xs[Math.min(ci + span, xs.length - 1)]
      const align = cell.align ?? 'middle'
      const tx = align === 'start' ? left + 1.2 : align === 'end' ? right - 1.2 : (left + right) / 2
      const h = cell.h ?? 2.2
      if (cell.sub) {
        text(tx, ys[ri] + r.h / 2 - 0.3, cell.text, h, align, { layer, id: cell.id })
        text(tx, ys[ri] + r.h / 2 + h + 0.4, cell.sub, h, align, { layer })
      } else {
        text(tx, ys[ri] + r.h / 2 + h * 0.38, cell.text, h, align, { layer, id: cell.id })
      }
      ci += span
    }
  })
  return ys[ys.length - 1]
}

/** そのセル境界 が まとめた セル の 内側 か */
function coveredBySpan(cells: TCell[], col: number): boolean {
  let ci = 0
  for (const c of cells) {
    const span = c.span ?? 1
    if (col > ci && col < ci + span) return true
    ci += span
  }
  return false
}

/**
 * 左 の 計算書。 表 の 左右 と 列 の 位置 は 実物 の 実測値。
 * 行 の 数 は 中身 で 変わる ので 高さ だけ 流す。
 */
function drawCalc(
  out: DrawItem[],
  text: TextFn,
  line: LineFn,
  plan: LandSurveyDrawing,
  parcels: LandParcelForDraw[],
  controls: ControlPointForDraw[],
) {
  const spec = plan.spec
  const ROW = 3.49

  // ---- 座標変換 の パラメータ ----
  let y = 41.76
  if (spec.paramNote.tky2jgd || spec.paramNote.patchjgd) {
    y = drawTable(
      out,
      text,
      [48.51, 65.47, 85.47, 105.47],
      y,
      [
        {
          h: 6.99,
          cells: [
            { text: '' },
            { text: 'TKY2JGD', sub: spec.paramNote.tky2jgd, id: 'land:param:1' },
            { text: 'PatchJGD', sub: spec.paramNote.patchjgd, id: 'land:param:2' },
          ],
        },
        { h: 3.55, cells: [{ text: '基準点' }, { text: '－' }, { text: '－' }] },
        { h: 3.50, cells: [{ text: '筆界点' }, { text: '－' }, { text: '－' }] },
      ],
      L.calc,
    )
    y += 6.5
  } else {
    y = 55.8 + 6.5
  }

  // ---- 与点 の 成果 ----
  text(48.7, y, spec.datumTitle, 3.0, 'start', { id: 'land:datumTitle' })
  y += 7.1

  const datums = spec.datums.length > 0 ? spec.datums : datumsFromControls(controls)
  const datumRows: { h: number; cells: TCell[] }[] = [
    {
      h: 3.5,
      cells: [
        { text: '' },
        { text: '点 名' },
        { text: 'X座標' },
        { text: 'Y座標' },
        { text: '備 考' },
      ],
    },
  ]
  for (const d of datums) {
    // 備考 は 改行 で 2 行 に できる (実物 も 「ネットワーク型RTK法 / による単点観測法」)
    const note = (d.note ?? '').split('\n')
    datumRows.push({
      h: (ROW + 0.06) * Math.max(note.length, 1),
      cells: [
        { text: d.category, align: 'start', id: `land:datum:${d.id}:c` },
        { text: d.name, align: 'start', id: `land:datum:${d.id}:n` },
        { text: n3(d.x), align: 'end', id: `land:datum:${d.id}:x` },
        { text: n3(d.y), align: 'end', id: `land:datum:${d.id}:y` },
        {
          text: note[0] ?? '',
          sub: note[1],
          align: 'start',
          id: `land:datum:${d.id}:r`,
        },
      ],
    })
  }
  y = drawTable(out, text, [48.7, 76.26, 104.71, 129.22, 153.73, 178.24], y, datumRows, L.calc)

  if (spec.observationNote) {
    y += 4
    text(48.7, y, spec.observationNote, 2.2, 'start', { id: 'land:obsNote' })
  }

  // ---- 求積表 ----
  y += 6.5
  text(103.4, y, '求積表', 3.2, 'middle', { bold: true, id: 'land:areaTitle' })
  y += 6.1

  const xs = [48.39, 65.34, 85.34, 105.35, 125.35, 158.37]
  let total = 0
  parcels.forEach((p, pi) => {
    const calc = calcParcelArea(p.label, p.points)
    total += calc.area

    const rows: { h: number; cells: TCell[] }[] = [
      // 地番 の 行。 実物 は ここ も 枠 の 中
      {
        h: 3.32,
        cells: [
          { text: '地 番', align: 'start', h: 2.4, id: `land:area:${pi}:label` },
          {
            text: `${circled(pi + 1)} ${p.label}`,
            align: 'start',
            h: 2.6,
            span: 4,
            id: `land:area:${pi}:no`,
          },
        ],
      },
      {
        h: 3.5,
        cells: [
          { text: 'NO', align: 'start' },
          { text: 'Xn', align: 'end' },
          { text: 'Yn', align: 'end' },
          { text: 'Yn+1-Yn-1', align: 'end' },
          { text: 'Xn・(Yn+1-Yn-1)', align: 'end' },
        ],
      },
    ]
    for (const r of calc.rows) {
      rows.push({
        h: ROW,
        cells: [
          { text: r.name, align: 'start', id: `land:area:${pi}:${r.name}:n` },
          { text: n3(r.x), align: 'end', id: `land:area:${pi}:${r.name}:x` },
          { text: n3(r.y), align: 'end', id: `land:area:${pi}:${r.name}:y` },
          { text: n3(r.dy), align: 'end', id: `land:area:${pi}:${r.name}:d` },
          { text: n6(r.product), align: 'end', id: `land:area:${pi}:${r.name}:p` },
        ],
      })
    }
    rows.push({
      h: 3.55,
      cells: [
        { text: '合 計', align: 'end', span: 4 },
        { text: n6(calc.sum), align: 'end', id: `land:area:${pi}:sum` },
      ],
    })
    rows.push({
      h: 3.49,
      cells: [
        { text: '合 計 面 積', align: 'end', span: 4 },
        { text: n6(calc.area), align: 'end', id: `land:area:${pi}:area` },
      ],
    })
    rows.push({
      h: 3.49,
      cells: [
        { text: '地 積', align: 'end', span: 4 },
        { text: `${n2(calc.registered)} ㎡`, align: 'end', id: `land:area:${pi}:reg` },
      ],
    })
    y = drawTable(out, text, xs, y, rows, L.calc) + 3.5
  })

  if (parcels.length > 1) {
    y += 3.5
    y = drawTable(
      out,
      text,
      [48.39, 118.36, 158.37],
      y,
      [
        {
          h: 5.02,
          cells: [
            { text: '総合計面積', h: 2.6, id: 'land:grandLabel' },
            { text: `${n6(total)} ㎡`, align: 'end', h: 2.6, id: 'land:grand' },
          ],
        },
      ],
      L.calc,
    )
  }

  // ---- 測量年月日 / 座標系 ----
  y += 7
  drawTable(
    out,
    text,
    [48.39, 75.37, 125.35],
    y,
    [
      {
        h: 4.0,
        cells: [
          { text: '測量年月日', h: 2.4 },
          { text: warekiDate(spec.surveyedOn), h: 2.4, id: 'land:surveyed' },
        ],
      },
      {
        h: 4.0,
        cells: [
          { text: '座 標 系', h: 2.4 },
          { text: `${romanZone(spec.zone)}系`, h: 2.4, id: 'land:zone' },
        ],
      },
    ],
    L.calc,
  )

  void line
}

/** 丸 で 囲んだ 数字 (①②…)。 図面 の 地番 の 通し番号 */
function circled(n: number): string {
  const C = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
  return n >= 1 && n <= C.length ? C[n - 1] : String(n)
}

/** 基準点 から 与点 の 成果 の 行 を 作る */
export function datumsFromControls(controls: ControlPointForDraw[]) {
  return controls.map((c) => ({
    id: c.id,
    category: '',
    name: c.pointNumber,
    x: c.x,
    y: c.y,
    note: '',
  }))
}

/** 「令和8年 7月31日」 */
function warekiDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  if (y < 2019) return `${y}年${d.getMonth() + 1}月${d.getDate()}日`
  const r = y - 2018
  return `令和${r === 1 ? '元' : r}年${d.getMonth() + 1}月${d.getDate()}日`
}

/** 系番号 を ローマ数字 に (図面 は 「XIII系」 の 書き方) */
function romanZone(z: number): string {
  const R = [
    '', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X',
    'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX',
  ]
  return R[z] ?? String(z)
}

// ========================================================================
// 右: 図
// ========================================================================

function drawMap(
  out: DrawItem[],
  plan: LandSurveyDrawing,
  parcels: LandParcelForDraw[],
  neighbors: LandParcelForDraw[],
) {
  const S = LSHEET
  const bx = S.calcRight + 4
  const by = S.bodyTop + 6
  const bw = S.right - S.calcRight - 10
  const bh = S.bodyBottom - S.bodyTop - 14
  const mmPerM = 1000 / Math.max(plan.scale_denominator, 1)

  const rings = parcels
    .filter((p) => p.points.length >= 3)
    .map((p) => ({ label: p.label, pts: p.points.map((q) => ({ e: q.y, n: q.x })) }))
  if (rings.length === 0) return

  const wk = plan.spec.whisker ?? { show: true, lengthMm: 10 }
  const whisker = wk.show
    ? buildWhiskers(parcels, neighbors, (wk.lengthMm * plan.scale_denominator) / 1000)
    : { stubs: [], labels: [] }

  const all = [
    ...rings.flatMap((r) => r.pts),
    ...whisker.stubs.flatMap((s) => [s.a, s.b]),
    ...whisker.labels.map((l) => l.at),
    ...plan.spec.notes.map((n) => ({ e: n.x, n: n.y })),
  ]
  const ce = all.reduce((s, p) => s + p.e, 0) / all.length
  const cn = all.reduce((s, p) => s + p.n, 0) / all.length
  const toSheet = (e: number, n: number): Pt => ({
    x: bx + bw / 2 + (e - ce) * mmPerM,
    y: by + bh / 2 - (n - cn) * mmPerM,
  })

  for (const r of rings) {
    out.push({
      kind: 'poly',
      pts: r.pts.map((p) => toSheet(p.e, p.n)),
      closed: true,
      w: LW_FIG,
      layer: L.site,
    })
    // 地番名
    const c = {
      e: r.pts.reduce((s, p) => s + p.e, 0) / r.pts.length,
      n: r.pts.reduce((s, p) => s + p.n, 0) / r.pts.length,
    }
    const p = toSheet(c.e, c.n)
    out.push({
      kind: 'text',
      id: `land:map:parcel:${r.label}`,
      x: p.x,
      y: p.y,
      text: r.label,
      h: 2.8,
      anchor: 'middle',
      rot: 0,
      layer: L.site,
    })
  }

  // 筆界点 の 点名 と 辺長
  for (const r of rings) {
    const n = r.pts.length
    for (let i = 0; i < n; i += 1) {
      const a = r.pts[i]
      const b = r.pts[(i + 1) % n]
      const sa = toSheet(a.e, a.n)
      const sb = toSheet(b.e, b.n)
      const len = Math.hypot(b.e - a.e, b.n - a.n)
      let deg = (-Math.atan2(sb.y - sa.y, sb.x - sa.x) * 180) / Math.PI
      if (deg > 90 || deg < -90) deg += 180
      const rad = (-deg * Math.PI) / 180
      out.push({
        kind: 'text',
        x: (sa.x + sb.x) / 2 + Math.sin(rad) * 1.0,
        y: (sa.y + sb.y) / 2 - Math.cos(rad) * 1.0,
        text: n3(len),
        h: 1.9,
        anchor: 'middle',
        rot: deg,
        layer: L.dim,
      })
    }
  }
  for (const p of parcels) {
    for (const q of p.points) {
      const s = toSheet(q.y, q.x)
      out.push({ kind: 'circle', cx: s.x, cy: s.y, r: 0.5, w: LW, layer: L.site })
      out.push({
        kind: 'text',
        x: s.x + 1.0,
        y: s.y - 1.0,
        text: q.pointNumber,
        h: 2.0,
        anchor: 'start',
        rot: 0,
        layer: L.site,
      })
    }
  }

  // 隣接地 の ヒゲ線 と 地番
  for (const st of whisker.stubs) {
    const a = toSheet(st.a.e, st.a.n)
    const b = toSheet(st.b.e, st.b.n)
    out.push({ kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y, w: LW, layer: L.site })
  }
  for (const lb of whisker.labels) {
    const p = toSheet(lb.at.e, lb.at.n)
    out.push({
      kind: 'text',
      id: `land:whisker:${lb.text}`,
      x: p.x,
      y: p.y,
      text: lb.text,
      h: 2.4,
      anchor: 'middle',
      rot: 0,
      layer: L.site,
    })
  }
  for (const n of plan.spec.notes) {
    if (!n.label) continue
    const p = toSheet(n.x, n.y)
    out.push({
      kind: 'text',
      id: `land:note:${n.id}`,
      x: p.x,
      y: p.y,
      text: n.label,
      h: 2.4,
      anchor: 'middle',
      rot: 0,
      layer: L.site,
    })
  }

  // 方位 (真北 が 上)
  const nx = S.right - 12
  const ny = S.bodyTop + 14
  out.push({ kind: 'line', x1: nx, y1: ny + 9, x2: nx, y2: ny - 9, w: LW_FIG, layer: L.site })
  out.push({
    kind: 'poly',
    pts: [
      { x: nx, y: ny - 12 },
      { x: nx - 1.6, y: ny - 7 },
      { x: nx + 1.6, y: ny - 7 },
    ],
    closed: true,
    w: LW_FIG,
    layer: L.site,
  })
  void placeOutline
}

// ========================================================================
// 表題欄
// ========================================================================

function drawTitleBlock(
  out: DrawItem[],
  text: TextFn,
  frame: FloorPlanFrame,
  scale: number,
) {
  const S = LSHEET
  const [tA, tB, , tD, tE, tF, tG, tH] = S.tx
  const midY = (S.titleTop + S.titleBottom) / 2

  // 見出し
  text((tA + tB) / 2, midY + 1.2, '作 製 者', 3.0, 'middle', { id: 'land:makerLabel' })
  text((tD + tE) / 2, midY + 1.2, '申 請 人', 3.0, 'middle', { id: 'land:applicantLabel' })
  text((tF + tG) / 2, midY + 1.2, '縮 尺', 2.6, 'middle', { id: 'land:scaleLabel' })
  text((tG + tH) / 2, midY + 1.6, `1/${scale}`, 3.6, 'middle', { id: 'land:scale' })

  // 作製者: 作製年月日 / 住所 / 肩書 氏名
  const corp = frame.makerCorporation.trim()
  text(tB + 12, S.titleTop + 3.6, warekiCreatedText(frame.createdOn), 2.4, 'start', {
    id: 'land:maker:date',
  })
  text((tB + tD) / 2, S.titleTop + 7.6, frame.makerAddress, 2.6, 'middle', {
    id: 'land:maker:address',
  })
  if (corp) {
    text((tB + tD) / 2, S.titleTop + 10.8, corp, 2.6, 'middle', { id: 'land:maker:corp' })
  }
  const title = makerTitle(frame)
  const titleH = 2.4
  const nameH = 4.0
  const yName = corp ? S.titleTop + 14.4 : S.titleTop + 12.6
  const nameChars = Math.max(Array.from(frame.makerName).length, 1)
  const pitch = 8.0
  const nameW = pitch * (nameChars - 1) + nameH
  const nameStart = Math.min(tD - 6 - nameW, (tB + tD) / 2 - nameW / 2 + 6)
  text(Math.max(tB + 2, nameStart - Array.from(title).length * titleH - 2.5), yName, title, titleH)
  text(nameStart, yName, frame.makerName, nameH, 'start', { pitch, id: 'land:maker:name' })

  // 申請人
  const lines = applicantLines(frame)
  if (lines.length > 0) {
    const gap = 1.2
    const cellCx = (tE + tF) / 2
    const namePitch = 6.0
    let blockW = 0
    for (const l of lines) {
      if (l.kind === 'left') blockW = Math.max(blockW, Array.from(l.text).length * l.h)
      else if (l.kind === 'titled') {
        const n = Math.max(Array.from(l.name).length, 1)
        blockW = Math.max(
          blockW,
          Array.from(l.title).length * l.titleH + 3.5 + namePitch * (n - 1) + l.nameH,
        )
      }
    }
    const leftX = Math.max(tE + 3, cellCx - Math.min(blockW, tF - tE - 8) / 2)
    const total = lines.reduce((acc, l) => acc + applicantLineHeight(l) + gap, -gap)
    let y = midY - total / 2 + applicantLineHeight(lines[0])
    lines.forEach((l, i) => {
      if (l.kind === 'center') {
        text(cellCx, y, l.text, l.h, 'middle', {
          pitch: l.h > 4 ? 6.1 : undefined,
          id: `land:applicant:${i}`,
        })
      } else if (l.kind === 'left') {
        text(leftX, y, l.text, l.h, 'start', { id: `land:applicant:${i}` })
      } else {
        text(leftX, y, l.title, l.titleH, 'start', { id: `land:applicant:${i}:title` })
        const nameLeft = leftX + Array.from(l.title).length * l.titleH + 3.5
        text(nameLeft, y, l.name, l.nameH, 'start', {
          pitch: namePitch,
          id: `land:applicant:${i}:name`,
        })
      }
      y += applicantLineHeight(l) + gap
    })
  }

  void out
  void SHEET
}

export type { LandDrawSpec }
