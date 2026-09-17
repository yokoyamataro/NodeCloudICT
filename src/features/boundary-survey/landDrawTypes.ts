// 地積測量図 の 型 と 求積 の 計算。
//
// 用紙 は 建物図面 と 同じ B4。 作製者 / 申請人 / 図枠 の 手直し も 同じ 形 を
// 使い回す ので、ここ で は 地積測量図 に 固有 の 分 だけ 持つ。
//
// 求積 は 実物 に 合わせて 倍横距 法 で 出す。
//   各点 n に ついて  Xn ×（Yn+1 − Yn−1）を 足し、その 半分 が 面積。
// 図面 に は 途中 の 数字 も そのまま 載せる ので、行 ごと に 残す。

import type { FloorPlanFrame } from './floorPlanTypes'

/**
 * 境界標 の 種類。 用紙 上部 の 表 の 列 に なる。
 *
 * 現場 に よって 使う 種類 が 違う ので、列 は 足し引き でき、名前 も 選ぶ か
 * 直接 打つ か どちら でも よい ように する。
 */
export const MARKER_PRESETS = [
  'コンクリート杭',
  '金属標',
  '金属鋲',
  'プラスチック杭',
  '石杭',
  '木杭',
  '金属プレート',
  '刻印',
  '標識',
  'ビス',
  '既設構造物',
] as const

export interface MarkerColumn {
  id: string
  /** 種類 の 名前 */
  kind: string
  /** 既設 の 点名 */
  existing: string
  /** 新設 の 点名 */
  created: string
}

/** 既定 の 3 列 (実物 に よく 出る 並び) */
export function defaultMarkerColumns(): MarkerColumn[] {
  return ['コンクリート杭', '金属鋲', 'プラスチック杭'].map((kind, i) => ({
    id: `m${i + 1}`,
    kind,
    existing: '',
    created: '',
  }))
}

/** 選んだ 地番 から 表題 (地番 の 並び と 所在) を 作る */
export function headerFromParcels(
  picked: { label: string; location: string | null }[],
): { title: string; location: string } {
  const title = picked.map((p) => p.label).filter(Boolean).join(', ')
  // 所在 は 筆 に よらず 同じ の が 普通。 違う ときは 出て きた 順 に 並べる
  const locs: string[] = []
  for (const p of picked) {
    const l = (p.location ?? '').trim()
    if (l && !locs.includes(l)) locs.push(l)
  }
  return { title, location: locs.join('、') }
}

/** 境界標 の 表 を 作る ため の 筆界点 */
export interface MarkerSourcePoint {
  pointNumber: string
  /** 杭種 (design_coordinates.stake_type) */
  stakeType: string | null
  /** 設置状態 (design_coordinates.stake_status) */
  stakeStatus: string
}

/**
 * 選んだ 地番 の 筆界点 から 境界標 の 表 を 作る。
 *
 * 杭種 が 列 に なり、設置状態 が 既設 / 新設 の 行 を 決める。
 *   既設 … 'existing'
 *   新設 … 'new' / 'replaced' (入替 も 新たに 入れた もの な ので 新設)
 * それ以外 (未設置 / 仮杭 / 不設置 / 未指定) は 図面 に 載せない。
 *
 * 点名 は 現れた 順 に 並べ、同じ 点 は 1 度 だけ。
 */
export function markersFromPoints(points: MarkerSourcePoint[]): MarkerColumn[] {
  const order: string[] = []
  const byKind = new Map<string, { existing: string[]; created: string[] }>()

  for (const p of points) {
    const kind = (p.stakeType ?? '').trim()
    if (!kind) continue
    const row =
      p.stakeStatus === 'existing'
        ? 'existing'
        : p.stakeStatus === 'new' || p.stakeStatus === 'replaced'
        ? 'created'
        : null
    if (!row) continue
    if (!byKind.has(kind)) {
      byKind.set(kind, { existing: [], created: [] })
      order.push(kind)
    }
    const slot = byKind.get(kind)!
    if (!slot[row].includes(p.pointNumber)) slot[row].push(p.pointNumber)
  }

  return order.map((kind, i) => ({
    id: `auto-${i + 1}`,
    kind,
    existing: byKind.get(kind)!.existing.join(','),
    created: byKind.get(kind)!.created.join(','),
  }))
}

/** 与点 の 成果 の 1 行 */
export interface DatumRow {
  id: string
  /** 「点検に使用した基本三角点等」 など の 区分 */
  category: string
  name: string
  x: number
  y: number
  note: string
}

export interface LandDrawSpec {
  /** 対象 の 地番 (parcels.id)。 1 筆 でも 数筆 でも */
  parcelIds: string[]
  /** 使用 した 基準点 (design_coordinates.id) */
  controlPointIds: string[]
  /** 与点 の 成果 の 表。 基準点 から 作る が 手 で も 直せる */
  datums: DatumRow[]
  /** 地図番号 */
  mapNumber: string
  /** 境界標 の 種類 と 点名。 選んだ 地番 の 杭種 から 作る */
  markerColumns: MarkerColumn[]
  /**
   * true (既定) の 間 は 地番 を 変える たび に 境界標 を 取り直す。
   * 手 で 直した ら false に して、以後 は 触らない。
   */
  markerAuto?: boolean
  /**
   * true (既定) の 間 は 地番 を 変える たび に 表題 (地番 と 所在) を
   * 取り直す。 手 で 直した ら false。
   */
  headerAuto?: boolean
  /** 測量年月日 */
  surveyedOn: string | null
  /** 座標系 (平面直角 の 系番号) */
  zone: number
  /** 「与点の成果 世界測地系 測地成果2024」 の 見出し */
  datumTitle: string
  /** 座標変換 パラメータ の 注記 (TKY2JGD / PatchJGD) */
  paramNote: { tky2jgd: string; patchjgd: string }
  /** 観測 に ついて の 注記 */
  observationNote: string
  /** 図 に 添える 隣接地 の 地番 など */
  notes: { id: string; label: string; x: number; y: number }[]
  /** 隣接地 の ヒゲ線 */
  whisker?: { show: boolean; lengthMm: number }
}

export const DEFAULT_LAND_SPEC: LandDrawSpec = {
  parcelIds: [],
  controlPointIds: [],
  datums: [],
  mapNumber: '',
  markerColumns: defaultMarkerColumns(),
  markerAuto: true,
  headerAuto: true,
  surveyedOn: null,
  zone: 13,
  datumTitle: '与点の成果　世界測地系　測地成果2024',
  paramNote: { tky2jgd: '', patchjgd: '' },
  observationNote: '',
  notes: [],
  whisker: { show: true, lengthMm: 10 },
}

export interface LandSurveyDrawing {
  id: string
  farm_id: string
  title: string | null
  location: string | null
  spec: LandDrawSpec
  frame: FloorPlanFrame
  scale_denominator: number
  sheet_no: number
  sort_order: number
  created_at: string
  updated_at: string
}

/** 選べる 縮尺。 任意 は 数値 を 直接 入れる */
export const LAND_SCALES = [500, 1000, 2500] as const

// ========================================================================
// 求積 (倍横距 法)
// ========================================================================

export interface AreaCalcRow {
  /** 点名 */
  name: string
  x: number
  y: number
  /** Yn+1 − Yn−1 */
  dy: number
  /** Xn × dy */
  product: number
}

export interface ParcelAreaCalc {
  parcelLabel: string
  rows: AreaCalcRow[]
  /** 合計 (Σ Xn·dy) */
  sum: number
  /** 合計面積 = |合計| / 2 */
  area: number
  /** 地積 (1/100 ㎡ 未満 切り捨て) */
  registered: number
}

/**
 * 1 筆 の 求積。 点 は 地番 の 構成点 の 並び (閉じて いる 前提)。
 *
 * Yn+1 / Yn−1 は 環 と して 前後 を 取る。 実物 の 表 は この 形 で 並ぶ。
 */
export function calcParcelArea(
  parcelLabel: string,
  points: { pointNumber: string; x: number; y: number }[],
): ParcelAreaCalc {
  const n = points.length
  const rows: AreaCalcRow[] = []
  let sum = 0
  for (let i = 0; i < n; i += 1) {
    const p = points[i]
    const next = points[(i + 1) % n]
    const prev = points[(i - 1 + n) % n]
    const dy = next.y - prev.y
    const product = p.x * dy
    sum += product
    rows.push({ name: p.pointNumber, x: p.x, y: p.y, dy, product })
  }
  const area = Math.abs(sum) / 2
  return {
    parcelLabel,
    rows,
    sum,
    area,
    registered: Math.floor(area * 100) / 100,
  }
}

/** 図面 に 出す 桁。 座標 は 3 桁、途中 の 積 は 6 桁 */
export const n3 = (v: number) => v.toFixed(3)
export const n6 = (v: number) => v.toFixed(6)
export const n2 = (v: number) => v.toFixed(2)
