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
  MARKER_KIND_LABEL,
  calcParcelArea,
  n2,
  n3,
  n6,
  type LandDrawSpec,
  type LandSurveyDrawing,
  type MarkerKind,
} from './landDrawTypes'

/** 罫線 の 位置 (mm)。 実測値 */
export const LSHEET = {
  left: 24.9,
  right: 338.8,
  /** ヘッダ */
  headTop: 9.8,
  headMid: 20.4,
  headBottom: 31.0,
  /** 上段 の 表 の 行 (境界標) */
  markerRow1: 15.1,
  markerRow2: 20.4,
  markerRow3: 25.7,
  /** ヘッダ の 縦罫 */
  hx: [24.9, 55.9, 64.9, 99.9, 134.9, 171.9, 191.8, 217.9] as const,
  /** 地番 の 値 の 右端 (上段 だけ) */
  hnValueRight: 261.9,
  /** 表題欄 */
  titleTop: 231.3,
  titleBottom: 246.3,
  tx: [24.9, 45.8, 171.9, 191.8, 211.8, 303.8, 313.9, 338.8] as const,
  /** 本体。 左 が 計算書、右 が 図 */
  bodyTop: 31.0,
  bodyBottom: 231.3,
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

  // 外枠
  line(S.left, S.headTop, S.hnValueRight, S.headTop)
  line(S.left, S.headTop, S.left, S.titleBottom)
  line(S.right, S.headMid, S.right, S.titleBottom)
  line(S.left, S.headMid, S.right, S.headMid)
  line(S.left, S.headBottom, S.right, S.headBottom)
  line(S.left, S.titleTop, S.right, S.titleTop)
  line(S.left, S.titleBottom, S.right, S.titleBottom)

  // ヘッダ の 縦罫
  for (const x of S.hx) line(x, S.headTop, x, S.headBottom)
  line(S.hnValueRight, S.headTop, S.hnValueRight, S.headMid)

  // 境界標 の 表 (種類 / 既設 / 新設)
  line(S.hx[1], S.markerRow1, S.hx[5], S.markerRow1)
  line(S.hx[1], S.markerRow3, S.hx[5], S.markerRow3)

  // ---- ヘッダ の 中身 ----
  text(40.4, 16.5, '地図番号', 2.8, 'middle', { pitch: 3.4, id: 'land:mapNoLabel' })
  text(40.4, 27.5, spec.mapNumber, 3.4, 'middle', { id: 'land:mapNo' })

  text(113.9, 13.6, '境界標の種類及び筆界点の記号または点名', 2.4, 'middle', {
    id: 'land:markerTitle',
  })
  const rowY = [S.markerRow1, S.markerRow2, S.markerRow3, S.headBottom]
  const rowLabel = ['種類', '既設', '新設']
  rowLabel.forEach((lab, i) => {
    text((S.hx[1] + S.hx[2]) / 2, (rowY[i] + rowY[i + 1]) / 2 + 1.0, lab, 2.4, 'middle', {
      id: `land:markerRow${i}`,
    })
  })
  const kinds: MarkerKind[] = ['concrete', 'metal', 'plastic']
  kinds.forEach((k, i) => {
    const cx = (S.hx[2 + i] + S.hx[3 + i]) / 2
    text(cx, (rowY[0] + rowY[1]) / 2 + 1.0, MARKER_KIND_LABEL[k], 2.4, 'middle', {
      id: `land:markerKind:${k}`,
    })
    text(cx, (rowY[1] + rowY[2]) / 2 + 1.0, spec.markers[k].existing, 2.6, 'middle', {
      id: `land:markerExisting:${k}`,
    })
    text(cx, (rowY[2] + rowY[3]) / 2 + 1.0, spec.markers[k].created, 2.6, 'middle', {
      id: `land:markerCreated:${k}`,
    })
  })

  text((S.hx[6] + S.hx[7]) / 2, 16.5, '地番', 2.8, 'middle', { pitch: 5.0, id: 'land:parcelLabel' })
  text((S.hx[6] + S.hx[7]) / 2, 27.5, '土地の所在', 2.8, 'middle', {
    pitch: 3.4,
    id: 'land:locLabel',
  })
  text(S.hx[7] + 3, 17.0, parcelNumbersOf(plan), 3.4, 'start', { id: 'land:parcelNo' })
  text(S.hx[7] + 3, 28.0, plan.location ?? '', 3.4, 'start', { id: 'land:location' })

  // 用紙 の 見出し は 枠 の 外
  text(268.0, 19.0, '地積測量図', 5.4, 'start', { pitch: 13.5, id: 'land:title' })

  void out
}

/** ヘッダ に 出す 地番 の 並び */
function parcelNumbersOf(plan: LandSurveyDrawing): string {
  return plan.title?.trim() ? plan.title.trim() : ''
}

// ========================================================================
// 左: 計算書
// ========================================================================

function drawCalc(
  out: DrawItem[],
  text: TextFn,
  line: LineFn,
  plan: LandSurveyDrawing,
  parcels: LandParcelForDraw[],
  controls: ControlPointForDraw[],
) {
  const S = LSHEET
  const spec = plan.spec
  const x0 = S.left + 12
  let y = S.bodyTop + 8

  // ---- 座標変換 の パラメータ ----
  if (spec.paramNote.tky2jgd || spec.paramNote.patchjgd) {
    text(x0 + 60, y, 'TKY2JGD', 2.2, 'middle', { id: 'land:param:h1' })
    text(x0 + 100, y, 'PatchJGD', 2.2, 'middle', { id: 'land:param:h2' })
    y += 3.6
    text(x0 + 60, y, spec.paramNote.tky2jgd, 2.2, 'middle', { id: 'land:param:v1' })
    text(x0 + 100, y, spec.paramNote.patchjgd, 2.2, 'middle', { id: 'land:param:v2' })
    y += 4.5
    text(x0, y, '基準点', 2.2, 'start', { id: 'land:param:l1' })
    y += 3.4
    text(x0, y, '筆界点', 2.2, 'start', { id: 'land:param:l2' })
    y += 6
  }

  // ---- 与点 の 成果 ----
  text(x0, y, spec.datumTitle, 3.0, 'start', { id: 'land:datumTitle' })
  y += 5
  const dc = [x0 + 34, x0 + 74, x0 + 108, x0 + 122]
  text(dc[0], y, '点 名', 2.4, 'middle', { id: 'land:datum:h0' })
  text(dc[1], y, 'X座標', 2.4, 'end', { id: 'land:datum:h1' })
  text(dc[2], y, 'Y座標', 2.4, 'end', { id: 'land:datum:h2' })
  text(dc[3], y, '備 考', 2.4, 'start', { id: 'land:datum:h3' })
  y += 4

  const rows = spec.datums.length > 0 ? spec.datums : datumsFromControls(controls)
  for (const d of rows) {
    if (d.category) text(x0, y, d.category, 2.2, 'start', { id: `land:datum:${d.id}:c` })
    text(dc[0], y, d.name, 2.4, 'middle', { id: `land:datum:${d.id}:n` })
    text(dc[1], y, n3(d.x), 2.4, 'end', { id: `land:datum:${d.id}:x` })
    text(dc[2], y, n3(d.y), 2.4, 'end', { id: `land:datum:${d.id}:y` })
    if (d.note) text(dc[3], y, d.note, 2.2, 'start', { id: `land:datum:${d.id}:r` })
    y += 3.8
  }
  if (spec.observationNote) {
    y += 1.5
    text(x0, y, spec.observationNote, 2.2, 'start', { id: 'land:obsNote' })
    y += 5
  } else {
    y += 4
  }

  // ---- 求積表 ----
  text(x0 + 45, y, '求積表', 3.2, 'middle', { bold: true, id: 'land:areaTitle' })
  y += 6

  const cx = [x0 + 6, x0 + 30, x0 + 58, x0 + 84, x0 + 128]
  let total = 0
  parcels.forEach((p, pi) => {
    const calc = calcParcelArea(p.label, p.points)
    total += calc.area

    text(x0, y, '地 番', 2.4, 'start', { id: `land:area:${pi}:label` })
    text(x0 + 16, y, `${pi + 1}  ${p.label}`, 2.6, 'start', { id: `land:area:${pi}:no` })
    y += 4.2
    text(cx[0], y, 'NO', 2.2, 'start', { id: `land:area:${pi}:h0` })
    text(cx[1], y, 'Xn', 2.2, 'end', { id: `land:area:${pi}:h1` })
    text(cx[2], y, 'Yn', 2.2, 'end', { id: `land:area:${pi}:h2` })
    text(cx[3], y, 'Yn+1 - Yn-1', 2.2, 'end', { id: `land:area:${pi}:h3` })
    text(cx[4], y, 'Xn・(Yn+1 - Yn-1)', 2.2, 'end', { id: `land:area:${pi}:h4` })
    y += 3.6

    for (const r of calc.rows) {
      text(cx[0], y, r.name, 2.2, 'start', { id: `land:area:${pi}:${r.name}:n` })
      text(cx[1], y, n3(r.x), 2.2, 'end', { id: `land:area:${pi}:${r.name}:x` })
      text(cx[2], y, n3(r.y), 2.2, 'end', { id: `land:area:${pi}:${r.name}:y` })
      text(cx[3], y, n3(r.dy), 2.2, 'end', { id: `land:area:${pi}:${r.name}:d` })
      text(cx[4], y, n6(r.product), 2.2, 'end', { id: `land:area:${pi}:${r.name}:p` })
      y += 3.5
    }
    line(cx[3] - 16, y - 2.4, cx[4], y - 2.4, LW, L.calc)
    text(cx[3], y, '合 計', 2.2, 'end', { id: `land:area:${pi}:sum:l` })
    text(cx[4], y, n6(calc.sum), 2.2, 'end', { id: `land:area:${pi}:sum` })
    y += 3.5
    text(cx[3], y, '合 計 面 積', 2.2, 'end', { id: `land:area:${pi}:area:l` })
    text(cx[4], y, n6(calc.area), 2.2, 'end', { id: `land:area:${pi}:area` })
    y += 3.5
    text(cx[3], y, '地 積', 2.2, 'end', { id: `land:area:${pi}:reg:l` })
    text(cx[4], y, `${n2(calc.registered)} ㎡`, 2.2, 'end', { id: `land:area:${pi}:reg` })
    y += 7
  })

  if (parcels.length > 1) {
    text(x0 + 30, y, '総合計面積', 2.6, 'start', { id: 'land:grandLabel' })
    text(cx[4], y, n6(total), 2.6, 'end', { id: 'land:grand' })
    y += 8
  }

  // ---- 測量年月日 / 座標系 ----
  text(x0 + 10, y, '測量年月日', 2.4, 'start', { id: 'land:surveyedLabel' })
  text(x0 + 52, y, warekiDate(plan.spec.surveyedOn), 2.4, 'start', { id: 'land:surveyed' })
  y += 4.2
  text(x0 + 10, y, '座　標　系', 2.4, 'start', { id: 'land:zoneLabel' })
  text(x0 + 52, y, `${romanZone(plan.spec.zone)}系`, 2.4, 'start', { id: 'land:zone' })

  void out
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
