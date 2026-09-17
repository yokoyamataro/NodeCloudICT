// 用紙 の 中身 を 「描く もの の 並び」 に する。
//
// 画面 の 下絵 も、p21 / tif / pdf も、全部 ここ から 作る。 こう して おけば
// 見えて いる もの と 出る もの が ずれない。
//
// 座標 は 用紙 の mm。 左上 が 原点 で y は 下向き (SVG と 同じ)。
// p21 に 出す ときだけ y を 반転 する。
//
// 図形 は 実尺 で 置く。 1/250 なら 1 m が 4 mm。 法定図面 な ので 画面 に
// 収まる ように 勝手 に 縮める こと は しない。

import { polyArea, polyCentroid } from './floorPlanRegion'
import { buildWhiskers } from './floorPlanWhisker'
import {
  buildingKeys,
  groundOfBuilding,
  placementOf,
  underlayOf,
  figureFloorArea,
  figureLabel,
  figureOutline,
  figureSum,
  floorAreaText,
  moveLength,
  outlineExtent,
  placeOutline,
  sortFigures,
  termFormula,
  termValue,
  termValueText,
  warekiCreatedText,
  makerTitle,
  type FloorFigure,
  type FloorPlan,
  type Pt,
} from './floorPlanTypes'

/** 線 の 種類。 一点鎖線 は 求積 の 区切り に 使う */
export type LineStyle = 'solid' | 'dash' | 'dashdot'

export interface DrawLine {
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  layer: string
  style?: LineStyle
}
export interface DrawPoly {
  kind: 'poly'
  pts: Pt[]
  closed: boolean
  w: number
  layer: string
  style?: LineStyle
}

export interface DrawCircle {
  kind: 'circle'
  cx: number
  cy: number
  r: number
  w: number
  layer: string
}
export interface DrawText {
  kind: 'text'
  x: number
  y: number
  text: string
  /** 文字 の 高さ (mm) */
  h: number
  anchor: 'start' | 'middle' | 'end'
  /** 度。 反時計回り */
  rot: number
  layer: string
  /** 字間 を 空ける とき の 1 文字 あたり の 送り (mm) */
  pitch?: number
  bold?: boolean
}
export type DrawItem = DrawLine | DrawPoly | DrawCircle | DrawText

/** 用紙 (B4 横) と 罫線 の 位置。 doc/tatemono1.tif の 実測値 */
export const SHEET = {
  w: 364,
  h: 257,
  left: 25.0,
  right: 340.9,
  topLeft: 19.9,
  centerX: 182.0,
  centerTick: 8.1,
  midX: 191.0,
  /** 「家屋番号」「建物の所在」 の 見出し と 値 を 分ける 縦罫。
   *  見出し は 4〜5 文字 収まれば よい ので 詰め、値 の 側 を 広く 取る */
  hnLabelRight: 215.0,
  hnTop: 9.8,
  hnRight: 266.1,
  hnBottom: 24.9,
  locBottom: 34.9,
  bodyBottom: 219.8,
  titleBottom: 239.9,
  tlLeft: [25.0, 33.9, 128.0, 136.0, 156.9],
  tlRight: [206.9, 215.9, 310.9, 319.9, 340.9],
} as const

/** 罫線 の 太さ (mm)。 実物 は 400dpi で 2px */
const LW = 0.13
/** 図形 の 線 */
const LW_FIG = 0.25

const L = {
  frame: '図枠',
  title: '文字',
  figure: '建物',
  dim: '寸法',
  region: '求積区分',
  site: '敷地',
} as const

export interface SitePointForDraw {
  id: string
  pointNumber: string
  x: number
  y: number
}

/** 敷地 の 1 筆。 複数筆 に またがる 建物 が ある ので 筆 ごと に 持つ */
export interface SiteParcelForDraw {
  label: string
  points: SitePointForDraw[]
}

/**
 * 用紙 1 枚 を 描く もの の 並び に する。
 * neighbors は 敷地 以外 の 地番。 接して いる もの から ヒゲ線 を 作る。
 */
export function buildSheet(
  plan: FloorPlan,
  parcels: SiteParcelForDraw[],
  neighbors: SiteParcelForDraw[] = [],
): DrawItem[] {
  const S = SHEET
  const out: DrawItem[] = []
  const line = (x1: number, y1: number, x2: number, y2: number, w = LW) =>
    out.push({ kind: 'line', x1, y1, x2, y2, w, layer: L.frame })
  const text = (
    x: number,
    y: number,
    t: string,
    h: number,
    anchor: DrawText['anchor'] = 'start',
    opts: { rot?: number; pitch?: number; bold?: boolean; layer?: string } = {},
  ) => {
    if (!t) return
    out.push({
      kind: 'text',
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

  // ---- 図枠 ----
  line(S.left, S.topLeft, S.midX, S.topLeft)
  line(S.left, S.topLeft, S.left, S.titleBottom)
  line(S.right, S.hnBottom, S.right, S.titleBottom)
  line(S.left, S.bodyBottom, S.right, S.bodyBottom)
  // 用紙 中心 の 合わせ印
  line(S.centerX, S.topLeft, S.centerX, S.topLeft + S.centerTick)
  line(S.centerX, S.bodyBottom - S.centerTick, S.centerX, S.bodyBottom)
  // 家屋番号 / 所在
  line(S.midX, S.hnTop, S.hnRight, S.hnTop)
  line(S.midX, S.hnTop, S.midX, S.locBottom)
  line(S.hnRight, S.hnTop, S.hnRight, S.hnBottom)
  line(S.midX, S.hnBottom, S.right, S.hnBottom)
  line(S.midX, S.locBottom, S.right, S.locBottom)
  line(S.hnLabelRight, S.hnTop, S.hnLabelRight, S.locBottom)
  // 表題欄
  for (const arr of [S.tlLeft, S.tlRight]) {
    line(arr[0], S.titleBottom, arr[4], S.titleBottom)
    for (const x of arr) line(x, S.bodyBottom, x, S.titleBottom)
  }

  // ---- 見出し ----
  text(80.4, 17.2, '各階平面図', 5.4, 'start', { pitch: 11.0 })
  text(280.7, 21.5, '建物図面', 5.4, 'start', { pitch: 13.1 })
  // 見出し は 罫線 の 手前 まで 字間 を 広げる
  const hnLabelX = S.midX + 2.5
  const hnLabelW = S.hnLabelRight - 1.5 - hnLabelX
  const hnValueX = S.hnLabelRight + 2.0
  text(hnLabelX, 19.4, '家屋番号', 2.8, 'start', { pitch: (hnLabelW - 2.8) / 3 })
  text(hnValueX, 19.4, plan.house_number ?? '', 3.0)
  text(hnLabelX, 30.7, '建物の所在', 2.8, 'start', { pitch: (hnLabelW - 2.8) / 4 })
  text(hnValueX, 30.7, plan.location ?? '', 3.0)

  // ---- 左: 各階平面図 ----
  const figures = sortFigures(plan.figures)
  const mmPerM = 1000 / Math.max(plan.plan_scale, 1)

  const cols = 2
  const shown = figures.slice(0, 6)
  const rows = Math.max(1, Math.ceil(shown.length / cols))
  const cw = (S.centerX - S.left) / cols
  const ch = (S.bodyBottom - S.topLeft) / rows

  shown.forEach((f, i) => {
    const cx = S.left + cw * (i % cols) + 3
    const cy = S.topLeft + ch * Math.floor(i / cols) + 3
    const iw = cw - 6
    const ih = ch * 0.5
    text(cx, cy + 3, figureLabel(f), 3.0, 'start', { bold: true })
    drawFigure(out, f, underlayOf(plan.figures, f), cx, cy + 5, iw, ih, mmPerM)
    drawAreaTable(out, f, cx, cy + ih + 10, iw)
  })

  // ---- 右: 建物図面 ----
  drawSite(out, plan, parcels, neighbors)

  // ---- 表題欄 の 中身 ----
  const [tlA, tlB, tlC, tlD, tlE] = S.tlLeft
  const [trA, trB, trC, trD, trE] = S.tlRight
  vertical(out, '作製者', (tlA + tlB) / 2, S.bodyBottom + 2.8, S.titleBottom - 3.3, 3.1)
  text(38.7, 225.1, warekiCreatedText(plan.frame.createdOn), 2.3)

  const corp = plan.frame.makerCorporation.trim()
  const yAddress = corp ? 228.8 : 229.7
  const yName = corp ? 237.6 : 236.5
  text((tlB + tlC) / 2, yAddress, plan.frame.makerAddress, 2.1, 'middle')
  if (corp) text((tlB + tlC) / 2, 232.6, corp, 2.6, 'middle')
  // 法人 の 場合 は 資格 では なく 立場 (社員 / 代表社員)
  const title = makerTitle(plan.frame)
  text(tlB + 6.5, yName - 4.2, title.slice(0, 4), 1.8)
  text(tlB + 6.5, yName - 1.9, title.slice(4), 1.8)
  const nameChars = Math.max(Array.from(plan.frame.makerName).length, 1)
  text(tlB + 27.2, yName, plan.frame.makerName, 3.8, 'start', { pitch: 48.5 / nameChars })
  vertical(out, '縮尺', (tlC + tlD) / 2, S.bodyBottom + 3.4, S.titleBottom - 4.0, 2.8)
  scaleCell(out, tlD, tlE, plan.plan_scale)

  vertical(out, '申請人', (trA + trB) / 2, S.bodyBottom + 2.8, S.titleBottom - 3.3, 3.1)
  text((trB + trC) / 2, 232.2, plan.frame.applicantName, 4.5, 'middle', { pitch: 6.1 })
  vertical(out, '縮尺', (trC + trD) / 2, S.bodyBottom + 3.4, S.titleBottom - 4.0, 2.8)
  scaleCell(out, trD, trE, plan.site_scale)

  return out
}

/** 縦書き の 見出し */
function vertical(
  out: DrawItem[],
  t: string,
  cx: number,
  top: number,
  bottom: number,
  h: number,
) {
  const chars = Array.from(t)
  const step = (bottom - top) / chars.length
  chars.forEach((c, i) => {
    out.push({
      kind: 'text',
      x: cx,
      y: top + step * (i + 0.5) + h * 0.36,
      text: c,
      h,
      anchor: 'middle',
      rot: 0,
      layer: L.title,
    })
  })
}

/** 表題欄 の 縮尺 欄 */
function scaleCell(out: DrawItem[], x0: number, x1: number, scale: number) {
  out.push({
    kind: 'text',
    x: x0 + 2.3,
    y: SHEET.bodyBottom + 11.2,
    text: '1／',
    h: 2.6,
    anchor: 'start',
    rot: 0,
    layer: L.title,
  })
  out.push({
    kind: 'text',
    x: x1 - 3.9,
    y: SHEET.bodyBottom + 15.1,
    text: String(scale),
    h: 4.6,
    anchor: 'end',
    rot: 0,
    layer: L.title,
  })
}

/** 1 つ の 図形 を 枠 の 中 に 実尺 で 置く */
function drawFigure(
  out: DrawItem[],
  f: FloorFigure,
  underlay: FloorFigure | null,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  mmPerM: number,
) {
  const pts = figureOutline(f)
  if (pts.length < 3) return
  const under = underlay ? figureOutline(underlay) : []

  // 枠 の 真ん中 に 置く。 建物 の x=東 / y=北 を 用紙 の x 右 / y 下 に 直す
  let ext = outlineExtent([
    ...pts.map((p) => ({ x: p.x + f.offset.x, y: p.y + f.offset.y })),
    ...under,
  ])
  if (!ext) ext = { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  const cx0 = (ext.minX + ext.maxX) / 2
  const cy0 = (ext.minY + ext.maxY) / 2
  const toSheet = (p: Pt): Pt => ({
    x: bx + bw / 2 + (p.x - cx0) * mmPerM,
    y: by + bh / 2 - (p.y - cy0) * mmPerM,
  })

  if (under.length >= 3) {
    out.push({
      kind: 'poly',
      pts: under.map(toSheet),
      closed: true,
      w: LW,
      layer: L.figure,
      style: 'dash',
    })
  }
  const sheetPts = pts.map((p) => toSheet({ x: p.x + f.offset.x, y: p.y + f.offset.y }))
  out.push({ kind: 'poly', pts: sheetPts, closed: true, w: LW_FIG, layer: L.figure })

  drawRegions(out, f, toSheet, mmPerM)

  // 辺 の 寸法。 打った 値 を そのまま
  f.moves.forEach((m, i) => {
    const len = moveLength(m)
    if (len < 0.001) return
    const a = sheetPts[i]
    const b = sheetPts[(i + 1) % sheetPts.length]
    if (!a || !b) return
    let deg = (-Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
    if (deg > 90 || deg < -90) deg += 180
    const rad = (-deg * Math.PI) / 180
    // 線 の 外 へ 少し 逃がす
    const off = 1.0
    out.push({
      kind: 'text',
      x: (a.x + b.x) / 2 + Math.sin(rad) * off,
      y: (a.y + b.y) / 2 - Math.cos(rad) * off,
      text: len.toFixed(3),
      h: 1.8,
      anchor: 'middle',
      rot: deg,
      layer: L.dim,
    })
  })
}

/**
 * 求積 の 区分。 区画 の 境目 (外形 に 無い 辺) を 一点鎖線 で 引き、
 * 真ん中 に 丸 で 囲んだ 記号 を 置く。 どの 式 が どこ か が 分かる。
 */
function drawRegions(
  out: DrawItem[],
  f: FloorFigure,
  toSheet: (p: Pt) => Pt,
  mmPerM: number,
) {
  const withRegion = f.terms.filter((t) => t.region && t.region.length >= 3)
  if (withRegion.length === 0) return

  // 外形 の 辺 (どちら 向き でも 同じ もの と 見る)
  const pts = figureOutline(f)
  const key = (a: Pt, b: Pt) => {
    const k = (p: Pt) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`
    return [k(a), k(b)].sort().join('/')
  }
  const onOutline = new Set<string>()
  for (let i = 0; i < pts.length; i += 1) {
    onOutline.add(key(pts[i], pts[(i + 1) % pts.length]))
  }

  const drawn = new Set<string>()
  for (const t of withRegion) {
    const rp = t.region!
    for (let i = 0; i < rp.length; i += 1) {
      const a = rp[i]
      const b = rp[(i + 1) % rp.length]
      const k = key(a, b)
      if (onOutline.has(k) || drawn.has(k)) continue
      drawn.add(k)
      const sa = toSheet({ x: a.x + f.offset.x, y: a.y + f.offset.y })
      const sb = toSheet({ x: b.x + f.offset.x, y: b.y + f.offset.y })
      out.push({
        kind: 'line',
        x1: sa.x,
        y1: sa.y,
        x2: sb.x,
        y2: sb.y,
        w: LW,
        layer: L.region,
        style: 'dashdot',
      })
    }
    if (!t.label) continue
    const c = polyCentroid(rp)
    const sc = toSheet({ x: c.x + f.offset.x, y: c.y + f.offset.y })
    // 区画 が 小さい ときは 丸 も 小さく する
    const r = Math.min(2.0, Math.max(1.1, Math.sqrt(polyArea(rp)) * mmPerM * 0.12))
    out.push({ kind: 'circle', cx: sc.x, cy: sc.y, r, w: LW, layer: L.region })
    out.push({
      kind: 'text',
      x: sc.x,
      y: sc.y + r * 0.62,
      text: t.label,
      h: r * 1.25,
      anchor: 'middle',
      rot: 0,
      layer: L.region,
    })
  }
}

/** 求積表 */
function drawAreaTable(out: DrawItem[], f: FloorFigure, bx: number, by: number, bw: number) {
  const t = (x: number, y: number, s: string, h: number, anchor: DrawText['anchor'], bold = false) =>
    out.push({ kind: 'text', x, y, text: s, h, anchor, rot: 0, layer: L.title, bold })

  t(bx + bw / 2, by, '求積表', 3.2, 'middle', true)
  const rows = f.terms.slice(0, 5)
  const hasLabel = rows.some((r) => r.label)
  rows.forEach((term, j) => {
    const y = by + 5 + j * 3.8
    if (term.label) {
      // 記号 は 丸 で 囲む (図 の 中 の 印 と 揃える)
      const cx = bx + 2.9
      const cy = y - 0.85
      out.push({ kind: 'circle', cx, cy, r: 1.6, w: LW, layer: L.title })
      t(cx, cy + 0.8, term.label, 2.2, 'middle')
    }
    t(bx + (hasLabel ? 6.5 : 4), y, termFormula(term), 2.8, 'start')
    t(bx + bw - 2, y, `= ${termValueText(termValue(term))}`, 2.8, 'end')
  })
  let y = by + 6.5 + rows.length * 3.8
  if (f.terms.length > 1) {
    out.push({ kind: 'line', x1: bx + 4, y1: y, x2: bx + bw - 2, y2: y, w: LW, layer: L.frame })
    y += 4
    t(bx + bw - 24, y, '計', 2.8, 'end')
    t(bx + bw - 2, y, termValueText(figureSum(f)), 2.8, 'end')
    y += 4.5
  } else {
    y += 4
  }
  t(bx + bw - 24, y, '床面積', 2.8, 'end')
  t(bx + bw - 2, y, `${floorAreaText(figureFloorArea(f))} ㎡`, 2.8, 'end')
}

/** 用紙 右半分 の 建物図面 */
function drawSite(
  out: DrawItem[],
  plan: FloorPlan,
  parcels: SiteParcelForDraw[],
  neighbors: SiteParcelForDraw[],
) {
  const S = SHEET
  const bx = S.centerX + 4
  const by = S.locBottom + 4
  const bw = S.right - S.centerX - 8
  const bh = S.bodyBottom - S.locBottom - 8
  const mmPerM = 1000 / Math.max(plan.site_scale, 1)

  // 敷地 (X=北 / Y=東) と 建物 を E/N に 揃える
  const rings = parcels
    .filter((pc) => pc.points.length >= 3)
    .map((pc) => ({
      label: pc.label,
      pts: pc.points.map((p) => ({ e: p.y, n: p.x })),
    }))
  const site = rings.flatMap((r) => r.pts)

  // 附属建物 は 別棟 な ので 棟 ごと に 据えた もの を 全部 描く
  const buildings: { key: string; pts: { e: number; n: number }[] }[] = []
  for (const key of buildingKeys(plan.figures)) {
    const g = groundOfBuilding(plan.figures, key)
    const pl = placementOf(plan.site, key)
    if (!g || !pl.placed) continue
    const pts = placeOutline(figureOutline(g), pl.offsetE, pl.offsetN, pl.rotationDeg)
    if (pts.length >= 3) buildings.push({ key, pts })
  }

  // 隣接地 の ヒゲ線。 伸ばす 長さ は 用紙 の mm を 現地 の m に 直す
  const wk = plan.site.whisker ?? { show: true, lengthMm: 10 }
  const whisker =
    wk.show && parcels.length > 0
      ? buildWhiskers(parcels, neighbors, (wk.lengthMm * plan.site_scale) / 1000)
      : { stubs: [], labels: [] }

  const all = [
    ...site,
    ...buildings.flatMap((b) => b.pts),
    ...whisker.stubs.flatMap((s2) => [s2.a, s2.b]),
    ...whisker.labels.map((l) => l.at),
    ...plan.site.notes.map((n) => ({ e: n.x, n: n.y })),
  ]
  if (all.length === 0) return
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
    // 敷地 の 地番名 を 筆 の 真ん中 に
    if (!r.label) continue
    const c = {
      e: r.pts.reduce((s2, p) => s2 + p.e, 0) / r.pts.length,
      n: r.pts.reduce((s2, p) => s2 + p.n, 0) / r.pts.length,
    }
    const p = toSheet(c.e, c.n)
    out.push({
      kind: 'text',
      x: p.x,
      y: p.y,
      text: r.label,
      h: 2.6,
      anchor: 'middle',
      rot: 0,
      layer: L.site,
    })
  }
  for (const b of buildings) {
    out.push({
      kind: 'poly',
      pts: b.pts.map((p) => toSheet(p.e, p.n)),
      closed: true,
      w: LW_FIG * 1.6,
      layer: L.figure,
    })
    // 附属建物 は 符号 を 添える
    if (b.key !== 'main') {
      const c = {
        e: b.pts.reduce((s2, p) => s2 + p.e, 0) / b.pts.length,
        n: b.pts.reduce((s2, p) => s2 + p.n, 0) / b.pts.length,
      }
      const p = toSheet(c.e, c.n)
      out.push({
        kind: 'text',
        x: p.x,
        y: p.y,
        text: b.key.slice(6),
        h: 2.4,
        anchor: 'middle',
        rot: 0,
        layer: L.title,
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
      x: p.x,
      y: p.y,
      text: lb.text,
      h: 2.2,
      anchor: 'middle',
      rot: 0,
      layer: L.site,
    })
  }

  for (const n of plan.site.notes) {
    if (!n.label) continue
    const p = toSheet(n.x, n.y)
    out.push({
      kind: 'text',
      x: p.x,
      y: p.y,
      text: n.label,
      h: 2.2,
      anchor: 'middle',
      rot: 0,
      layer: L.title,
    })
  }

  // 方位
  const nx = bx + bw - 8
  const ny = by + 10
  const rad = ((-plan.site.northAngleDeg + 90) * Math.PI) / 180
  const ax = nx + Math.cos(rad) * 7
  const ay = ny - Math.sin(rad) * 7
  out.push({ kind: 'line', x1: nx, y1: ny, x2: ax, y2: ay, w: LW_FIG, layer: L.site })
  out.push({
    kind: 'text',
    x: ax,
    y: ay - 1.2,
    text: 'N',
    h: 2.4,
    anchor: 'middle',
    rot: 0,
    layer: L.title,
  })
}
