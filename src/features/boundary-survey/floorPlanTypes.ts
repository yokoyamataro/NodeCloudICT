// 建物図面・各階平面図 の 型 と 計算。
//
// doc/tatemono1.tif が 目指す 実物。 B4 1 枚 に
//   左 … 各階平面図 (図形 + 求積表)  縮尺 1/250
//   右 … 建物図面   (敷地 + 配置)    縮尺 1/500
// が 並ぶ。
//
// 座標 は 図面 の 中 だけ の 話 な ので、平面直角座標 (X=北 / Y=東) とは 分けて
// 「x=東 / y=北 の メートル」 で 持つ。 敷地 に 載せる ときに だけ
// site.offsetE / offsetN で 現地 の 座標 に 移す。

export interface Pt {
  x: number
  y: number
}

// ========================================================================
// 求積表
// ========================================================================

/**
 * 求積表 の 1 行。 実物 に 出て くる 形 は 3 つ:
 *   rect      2.120 × 0.300                = 0.636000
 *   trapezoid (1.220 + 1.820) × 0.300 / 2  = 0.456000
 *   triangle  3.640 × 0.910 / 2            = 1.656200
 * どれ にも 当てはまらない 場合 の ため に manual (式 を 自分 で 書く) を 置く。
 */
export type TermKind = 'rect' | 'trapezoid' | 'triangle' | 'manual'

export const TERM_KIND_LABEL: Record<TermKind, string> = {
  rect: '長方形',
  trapezoid: '台形',
  triangle: '三角形',
  manual: '自由入力',
}

export interface AreaTerm {
  id: string
  kind: TermKind
  /** rect: 横 / trapezoid: 上底 / triangle: 底辺 */
  a: number
  /** rect: 縦 / trapezoid: 下底 / triangle: 高さ */
  b: number
  /** trapezoid: 高さ (他 では 使わない) */
  h: number
  /** manual の とき の 面積 */
  manual: number
  /** manual の とき に 図面 へ 出す 式 */
  note: string
}

export function newTerm(kind: TermKind = 'rect'): AreaTerm {
  return { id: newId(), kind, a: 0, b: 0, h: 0, manual: 0, note: '' }
}

export function termValue(t: AreaTerm): number {
  switch (t.kind) {
    case 'rect':
      return t.a * t.b
    case 'trapezoid':
      return ((t.a + t.b) * t.h) / 2
    case 'triangle':
      return (t.a * t.b) / 2
    case 'manual':
      return t.manual
  }
}

/** 寸法 は 3 桁。 図面 も その 書き方 */
const d3 = (v: number) => v.toFixed(3)

/** 求積表 に 出す 式 の 文字列 */
export function termFormula(t: AreaTerm): string {
  switch (t.kind) {
    case 'rect':
      return `${d3(t.a)} × ${d3(t.b)}`
    case 'trapezoid':
      return `(${d3(t.a)} + ${d3(t.b)}) × ${d3(t.h)} / 2`
    case 'triangle':
      return `${d3(t.a)} × ${d3(t.b)} / 2`
    case 'manual':
      return t.note
  }
}

/** 求積 の 途中 は 6 桁 まで 出す (実物 が そう なって いる) */
export const termValueText = (v: number) => v.toFixed(6)

// ========================================================================
// 図形 (主である建物 の 各階 / 附属建物)
// ========================================================================

export type FigureKind = 'main' | 'annex'

export interface FloorFigure {
  id: string
  kind: FigureKind
  /** 附属建物 の 符号。 kind === 'annex' の とき だけ 使う */
  annexNo: number | null
  /** 階。 地下 は 負 の 数 */
  floorNo: number
  /** 形状 (m)。 多角形 の 頂点 を 反時計回り に */
  outline: Pt[]
  /** 1 階 に対する ずれ。 2 階 以降 を 1 階 の 点線 に 重ねて 描く ため */
  offset: Pt
  /** 求積表 */
  terms: AreaTerm[]
}

export function newFigure(kind: FigureKind, floorNo: number, annexNo: number | null): FloorFigure {
  return { id: newId(), kind, annexNo, floorNo, outline: [], offset: { x: 0, y: 0 }, terms: [] }
}

/** 「主である建物1階」「附属建物（符号1）」 */
export function figureLabel(f: FloorFigure): string {
  if (f.kind === 'annex') {
    const head = `附属建物（符号${f.annexNo ?? 1}）`
    // 附属建物 が 2 階建 の ときだけ 階 を 添える
    return f.floorNo === 1 ? head : `${head}${floorText(f.floorNo)}`
  }
  return `主である建物${floorText(f.floorNo)}`
}

function floorText(n: number): string {
  return n < 0 ? `地下${Math.abs(n)}階` : `${n}階`
}

/** 求積表 の 「計」 */
export function figureSum(f: FloorFigure): number {
  return f.terms.reduce((s, t) => s + termValue(t), 0)
}

/** 床面積。 登記 は 1/100 ㎡ 未満 切り捨て */
export function figureFloorArea(f: FloorFigure): number {
  return Math.floor(figureSum(f) * 100) / 100
}

export const floorAreaText = (v: number) => v.toFixed(2)

/** 多角形 の 面積 (座標法)。 求積表 と 合って いる か の 照合 に 使う */
export function polygonArea(pts: Pt[]): number {
  if (pts.length < 3) return 0
  let s = 0
  for (let i = 0; i < pts.length; i += 1) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

/** 辺 の 長さ。 i 番目 の 点 から 次 の 点 まで */
export function edgeLength(pts: Pt[], i: number): number {
  if (pts.length < 2) return 0
  const a = pts[i]
  const b = pts[(i + 1) % pts.length]
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 図形 の 外接矩形 */
export function outlineExtent(
  pts: Pt[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (pts.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** 建物 の 外形 を 現地 の 座標 に 載せる (回転 → 移動) */
export function placeOutline(
  outline: Pt[],
  offsetE: number,
  offsetN: number,
  rotationDeg: number,
): { e: number; n: number }[] {
  const t = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(t)
  const sin = Math.sin(t)
  return outline.map((p) => ({
    e: offsetE + p.x * cos - p.y * sin,
    n: offsetN + p.x * sin + p.y * cos,
  }))
}

/** 一覧 の 見出し用 に 使う、図形 の 大きさ の 短い 説明 */
export function outlineSummary(pts: Pt[]): string {
  const ext = outlineExtent(pts)
  if (!ext) return '形状 未入力'
  return `${(ext.maxX - ext.minX).toFixed(3)} × ${(ext.maxY - ext.minY).toFixed(3)} m`
}

/** 矩形 から 始める ため の 4 点 (反時計回り) */
export function rectOutline(w: number, h: number): Pt[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ]
}

/** 延べ床面積 (主である建物 の 各階 の 合計) */
export function totalMainArea(figures: FloorFigure[]): number {
  return figures.filter((f) => f.kind === 'main').reduce((s, f) => s + figureFloorArea(f), 0)
}

/** 図形 の 並び。 主である建物 → 附属建物、 それぞれ 階順 */
export function sortFigures(figures: FloorFigure[]): FloorFigure[] {
  return [...figures].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'main' ? -1 : 1
    if (a.kind === 'annex' && (a.annexNo ?? 0) !== (b.annexNo ?? 0)) {
      return (a.annexNo ?? 0) - (b.annexNo ?? 0)
    }
    return a.floorNo - b.floorNo
  })
}

/** 1 階 (下敷き に 使う)。 主である建物 の 1 階 */
export function groundFigure(figures: FloorFigure[]): FloorFigure | null {
  return figures.find((f) => f.kind === 'main' && f.floorNo === 1) ?? null
}

// ========================================================================
// 地番 の 選択肢
// ========================================================================

/**
 * 図面 に 結びつける 地番。
 *
 * 地番 は design_work_areas (構成点 を 持つ) と parcels (地籍属性 を 持つ) の
 * 2 枚 に 分かれて いる。 floor_plans.parcel_id が 指す のは parcels の 方 な ので、
 * 画面 では 両方 を 束ねた この 形 で 扱う。
 */
export interface ParcelOption {
  /** parcels.id。 まだ 地籍属性 の 行 が 無い 地番 は null */
  parcelId: string | null
  /** design_work_areas.id */
  workAreaId: string
  label: string
  /** 敷地 を 描く 構成点 (確定境界 が あれば そちら) */
  points: { id: string; pointNumber: string; x: number; y: number }[]
  pointIds: string[]
}

// ========================================================================
// 建物図面 (用紙 の 右半分)
// ========================================================================

/** 隣地 の 地番 など、図 に 添える 注記 */
export interface SiteNote {
  id: string
  label: string
  /** 注記 を 置く 位置 (現地 の 座標、E/N の m) */
  x: number
  y: number
}

export interface SitePlan {
  /** 敷地 を 描く ため の 地番構成点 (design_coordinates の id) */
  parcelPointIds: string[]
  /** 建物 の 基点 を 現地 の どこ に 置く か。 E=東 / N=北 */
  offsetE: number
  offsetN: number
  /** 建物 の 向き (度、反時計回り) */
  rotationDeg: number
  /** 図面 の 上 を 真北 から 何度 振る か */
  northAngleDeg: number
  /** 隣地 の 地番 など の 注記 */
  notes: SiteNote[]
  /** 敷地境界 から の 離れ。 図面 に 記入 する 寸法 */
  refDistances: { id: string; label: string; value: number }[]
}

export const DEFAULT_SITE: SitePlan = {
  parcelPointIds: [],
  offsetE: 0,
  offsetN: 0,
  rotationDeg: 0,
  northAngleDeg: 0,
  notes: [],
  refDistances: [],
}

// ========================================================================
// 図枠 (表題欄)
// ========================================================================

export interface FloorPlanFrame {
  /** 作製年月日。 表題欄 は 「（令和5年11月15日作製）」 と 出す */
  createdOn: string | null
  makerAddress: string
  /** 土地家屋調査士法人 の 場合 の 名称。 空 なら 個人 と して 氏名 だけ 出す */
  makerCorporation: string
  makerName: string
  applicantName: string
  remarks: string
}

/** 資格 は この 様式 では 固定 */
export const MAKER_QUALIFICATION = '土地家屋調査士'

export const DEFAULT_FRAME: FloorPlanFrame = {
  createdOn: null,
  makerAddress: '',
  makerCorporation: '',
  makerName: '',
  applicantName: '',
  remarks: '',
}

/** 表題欄 の 「（令和5年11月15日作製）」 */
export function warekiCreatedText(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  // 令和 は 2019 年 が 元年。 それ 以前 は 西暦 の まま 出す
  if (y < 2019) return `（${y}年${d.getMonth() + 1}月${d.getDate()}日作製）`
  const r = y - 2018
  return `（令和${r === 1 ? '元' : r}年${d.getMonth() + 1}月${d.getDate()}日作製）`
}

// ========================================================================

export interface FloorPlan {
  id: string
  farm_id: string
  title: string | null
  location: string | null
  parcel_number: string | null
  house_number: string | null
  building_kind: string | null
  building_structure: string | null
  parcel_id: string | null
  figures: FloorFigure[]
  site: SitePlan
  frame: FloorPlanFrame
  plan_scale: number
  site_scale: number
  sheet_no: number
  sort_order: number
  created_at: string
  updated_at: string
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
