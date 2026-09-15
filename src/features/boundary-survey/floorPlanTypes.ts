// 各階平面図 の 型 と 小道具。
//
// 座標 の 向き は 図面 の 中 だけ の 話 な ので、平面直角座標 (X=北 / Y=東) とは
// 分けて 「x=東 / y=北 の メートル」 で 持つ。 地番 へ 重ねる ときに だけ
// placement.offsetE / offsetN で 現地 の 座標 に 載せる。

/** 階 の 形 を 作る 矩形 (m)。 w=横 / h=縦 */
export interface FloorRect {
  x: number
  y: number
  w: number
  h: number
}

/** 1 つ の 階 */
export interface FloorSpec {
  id: string
  /** 表示名。 '1階' '2階' '地下1階' など */
  name: string
  rects: FloorRect[]
  /** 床面積 (㎡)。 null なら rects から 算出 */
  areaSqm: number | null
  /** true の 間 は areaSqm を 手入力 の まま 保つ */
  areaOverride: boolean
}

/** 地番 に対する 建物 の 置き方 */
export interface FloorPlanPlacement {
  /** 敷地 を 描く ため の 地番構成点 (design_coordinates の id) */
  parcelPointIds: string[]
  /** 1 階 の 原点 を 現地 の どこ に 置く か (m)。 E=東 / N=北 */
  offsetE: number
  offsetN: number
  /** 建物 の 向き (度、反時計回り) */
  rotationDeg: number
  /** 敷地境界 から の 離れ。 図面 に 記入 する 寸法 */
  refDistances: { id: string; label: string; value: number }[]
}

/** 図枠 に 入れる 文字 */
export interface FloorPlanFrame {
  sheetSize: 'B4'
  createdOn: string | null
  applicantName: string
  surveyorName: string
  surveyorOffice: string
  /** 図面 の 上 を 真北 から 何度 振る か */
  northAngleDeg: number
  drawingNumber: string
  remarks: string
}

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
  floors: FloorSpec[]
  placement: FloorPlanPlacement
  frame: FloorPlanFrame
  scale_denominator: number
  sort_order: number
  created_at: string
  updated_at: string
}

export const DEFAULT_PLACEMENT: FloorPlanPlacement = {
  parcelPointIds: [],
  offsetE: 0,
  offsetN: 0,
  rotationDeg: 0,
  refDistances: [],
}

export const DEFAULT_FRAME: FloorPlanFrame = {
  sheetSize: 'B4',
  createdOn: null,
  applicantName: '',
  surveyorName: '',
  surveyorOffice: '',
  northAngleDeg: 0,
  drawingNumber: '',
  remarks: '',
}

export function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 矩形 の 合計 面積 (重なり は 考えない) */
export function rectsArea(rects: FloorRect[]): number {
  return rects.reduce((s, r) => s + Math.abs(r.w) * Math.abs(r.h), 0)
}

/** 表示 に 使う 床面積。 手入力 が あれば それ、 なければ 矩形 の 合計 */
export function floorArea(f: FloorSpec): number {
  if (f.areaOverride && f.areaSqm != null) return f.areaSqm
  return rectsArea(f.rects)
}

/** 全階 の 床面積 の 合計 */
export function totalArea(floors: FloorSpec[]): number {
  return floors.reduce((s, f) => s + floorArea(f), 0)
}

/** 登記 の 面積 は 切り捨て (居宅 は 1/100 ㎡ 未満 切り捨て) */
export function floorAreaText(v: number): string {
  return (Math.floor(v * 100) / 100).toFixed(2)
}

/** 階 の 外接矩形。 空 なら null */
export function floorExtent(
  f: FloorSpec,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (f.rects.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const r of f.rects) {
    const x1 = Math.min(r.x, r.x + r.w)
    const x2 = Math.max(r.x, r.x + r.w)
    const y1 = Math.min(r.y, r.y + r.h)
    const y2 = Math.max(r.y, r.y + r.h)
    if (x1 < minX) minX = x1
    if (x2 > maxX) maxX = x2
    if (y1 < minY) minY = y1
    if (y2 > maxY) maxY = y2
  }
  return { minX, minY, maxX, maxY }
}

/** 既定 の 階名。 1階 から 順 に */
export function defaultFloorName(index: number): string {
  return `${index + 1}階`
}

/** 一覧 の 見出し用 に 使う、階 の 大きさ の 短い 説明 */
export function floorSizeSummary(f: FloorSpec): string {
  const ext = floorExtent(f)
  if (!ext) return '未入力'
  const w = ext.maxX - ext.minX
  const h = ext.maxY - ext.minY
  return `${w.toFixed(2)} × ${h.toFixed(2)} m / ${rectsArea(f.rects).toFixed(2)} ㎡`
}
