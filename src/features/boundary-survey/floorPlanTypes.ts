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

/**
 * 形状 を 作る 1 辺。 前 の 点 から の 相対距離 (m) で 持つ。
 *   v … 縦 (北 が 正)
 *   h … 横 (東 が 正)
 * 「2, 0」 なら 縦 に 2 進む、 の 意味。 図面 の 寸法 が そのまま 入る。
 */
export interface Move {
  v: number
  h: number
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
  /** 求積 の 記号 (イ・ロ・ハ…)。 区分 から 作った 行 に 付く */
  label?: string
  /** その 行 が 指す 区画 (建物 の 局所座標)。 図面 に 一点鎖線 で 描く */
  region?: Pt[]
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
  /** 形状。 原点 から 1 辺 ずつ の 相対距離 で 表す */
  moves: Move[]
  /** 1 階 に対する ずれ。 2 階 以降 を 1 階 の 点線 に 重ねて 描く ため */
  offset: Pt
  /** 求積表 */
  terms: AreaTerm[]
  /** 求積 の 区切り線 (折点 から 水平 / 垂直)。 手 で 分ける ときに 使う */
  cuts?: { id: string; v: number; dir: 'E' | 'W' | 'N' | 'S' }[]
}

export function newFigure(kind: FigureKind, floorNo: number, annexNo: number | null): FloorFigure {
  return {
    id: newId(),
    kind,
    annexNo,
    floorNo,
    moves: [],
    offset: { x: 0, y: 0 },
    terms: [],
    cuts: [],
  }
}

/**
 * 保存 されて いた 図形 を 今 の 形 に 揃える。
 * 初期 の 版 は 頂点 の 並び (outline) で 持って いた ので 辺 に 直す。
 * moves が 無い まま 画面 に 流す と for...of で 落ちる。
 */
export function normalizeFigure(raw: unknown): FloorFigure {
  const r = (raw ?? {}) as Record<string, unknown>
  let moves = Array.isArray(r.moves) ? (r.moves as Move[]) : []
  if (moves.length === 0 && Array.isArray(r.outline)) {
    const pts = r.outline as Pt[]
    moves = pts.map((p, i) => {
      const q = pts[(i + 1) % pts.length]
      return { v: (q?.y ?? 0) - (p?.y ?? 0), h: (q?.x ?? 0) - (p?.x ?? 0) }
    })
  }
  const off = (r.offset ?? {}) as Partial<Pt>
  return {
    id: String(r.id ?? newId()),
    kind: r.kind === 'annex' ? 'annex' : 'main',
    annexNo: typeof r.annexNo === 'number' ? r.annexNo : null,
    floorNo: typeof r.floorNo === 'number' ? r.floorNo : 1,
    moves: moves.map((m) => ({ v: Number(m?.v ?? 0), h: Number(m?.h ?? 0) })),
    offset: { x: Number(off.x ?? 0), y: Number(off.y ?? 0) },
    terms: Array.isArray(r.terms) ? (r.terms as AreaTerm[]) : [],
    // 初期 の 版 は 頂点 を 2 つ 結ぶ 形 だった ので 落とす
    cuts: Array.isArray(r.cuts)
      ? (r.cuts as FloorFigure['cuts'])!.filter((c) => c && 'dir' in c)
      : [],
  }
}

/**
 * 辺 の 並び から 多角形 の 頂点 を 作る。 原点 (0,0) から 順 に 足す。
 * 最後 が 原点 に 戻って いれば (= 閉合 して いれば) 重複 する 点 は 落とす。
 */
export function outlineFromMoves(moves: Move[]): Pt[] {
  const pts: Pt[] = [{ x: 0, y: 0 }]
  if (!Array.isArray(moves)) return pts
  for (const m of moves) {
    const last = pts[pts.length - 1]
    pts.push({ x: last.x + m.h, y: last.y + m.v })
  }
  const last = pts[pts.length - 1]
  if (pts.length > 1 && Math.abs(last.x) < 1e-9 && Math.abs(last.y) < 1e-9) pts.pop()
  return pts
}

/** 図形 の 頂点 */
export function figureOutline(f: FloorFigure): Pt[] {
  return outlineFromMoves(f.moves)
}

/** 閉合差。 (0, 0) なら 形 が 閉じて いる */
export function closureOf(moves: Move[]): Move {
  if (!Array.isArray(moves)) return { v: 0, h: 0 }
  return moves.reduce((a, m) => ({ v: a.v + m.v, h: a.h + m.h }), { v: 0, h: 0 })
}

/** 1 辺 の 長さ */
export const moveLength = (m: Move): number => Math.hypot(m.h, m.v)

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

/** 主である建物 の 1 階 */
export function groundFigure(figures: FloorFigure[]): FloorFigure | null {
  return figures.find((f) => f.kind === 'main' && f.floorNo === 1) ?? null
}

/**
 * 下敷き に する 図形。 2 階 以降 を 描く ときに 1 階 を 点線 で 添える。
 *
 * 附属建物 は 主である建物 とは 別棟 な ので、下敷き も 配置 も 別 に する。
 * 附属建物 の 2 階 は その 附属建物 の 1 階 を 下敷き に する。
 */
export function underlayOf(figures: FloorFigure[], f: FloorFigure): FloorFigure | null {
  if (f.floorNo === 1) return null
  return (
    figures.find(
      (x) => x.kind === f.kind && x.floorNo === 1 && (f.kind === 'main' || x.annexNo === f.annexNo),
    ) ?? null
  )
}

/** 棟 ごと の 区切り。 主である建物 は 'main'、附属建物 は 符号 ごと */
export function buildingKey(f: FloorFigure): string {
  return f.kind === 'annex' ? `annex:${f.annexNo ?? 1}` : 'main'
}

/** その 棟 の 1 階 */
export function groundOfBuilding(figures: FloorFigure[], key: string): FloorFigure | null {
  return figures.find((f) => buildingKey(f) === key && f.floorNo === 1) ?? null
}

/** 図面 に 出す 棟 の 一覧 (主である建物 → 附属建物 の 順) */
export function buildingKeys(figures: FloorFigure[]): string[] {
  const seen: string[] = []
  for (const f of sortFigures(figures)) {
    const k = buildingKey(f)
    if (!seen.includes(k)) seen.push(k)
  }
  return seen
}

/** 棟 の 見出し */
export function buildingLabel(key: string): string {
  return key === 'main' ? '主である建物' : `附属建物（符号${key.slice(6)}）`
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

/** 建物 を 据える やり方 */
export type PlacementMethod = 'three_point' | 'parallel' | 'manual'

export const PLACEMENT_METHOD_LABEL: Record<PlacementMethod, string> = {
  three_point: '3点指定',
  parallel: '1辺平行',
  manual: '数値で直接',
}

export interface SitePlan {
  /**
   * 敷地 の 地番。 建物 が 複数 の 土地 に またがる こと が ある ので 複数 持つ。
   * floor_plans.parcel_id は 先頭 を 代表 と して 写す (外部キー の ため)。
   */
  parcelIds: string[]
  /** 敷地 を 描く ため の 地番構成点 (design_coordinates の id) */
  parcelPointIds: string[]
  /**
   * 配置 が 済んで いる か。
   * 済む まで 建物 は 図 に 出さない。 敷地 は 平面直角座標 (数十万 m) に
   * ある のに 建物 は 原点 に いる ので、両方 を 囲む と 縮尺 が 桁違い に
   * 小さく なって 何も 見えなく なる ため。
   */
  placed: boolean
  /** 据え方。 offsetE / offsetN / rotationDeg は この 結果 と して 入る */
  method: PlacementMethod
  /** 3点指定: 建物 の 角 と 境界線 と 離れ の 組 */
  constraints: { id: string; vertexIndex: number; edgeIndex: number; distance: number }[]
  /** 1辺平行 */
  parallel: {
    buildingEdge: number
    siteEdge: number
    offset: number
    along: number
    /** 基点 を 境界線 の 終点 側 に する */
    fromEnd: boolean
    flip: boolean
  } | null
  /** 主である建物 の 基点 を 現地 の どこ に 置く か。 E=東 / N=北 */
  offsetE: number
  offsetN: number
  /** 主である建物 の 向き (度、反時計回り) */
  rotationDeg: number
  /**
   * 附属建物 の 据え付け。 棟 の 区切り ('annex:1' など) を 鍵 に する。
   * 別棟 な ので 主である建物 とは 別 に 置く。
   */
  annexPlacements?: Record<string, { offsetE: number; offsetN: number; rotationDeg: number; placed: boolean }>
  /**
   * 棟 ごと の 据え方 の 指定。 'main' は 従来 の constraints / parallel を 使う。
   * 棟 が 変われば 辺 の 番号 も 変わる ので、共有 して は いけない。
   */
  constraintsBy?: Record<string, { id: string; vertexIndex: number; edgeIndex: number; distance: number }[]>
  parallelBy?: Record<
    string,
    { buildingEdge: number; siteEdge: number; offset: number; along: number; fromEnd: boolean; flip: boolean }
  >
  /** 図面 の 上 を 真北 から 何度 振る か */
  northAngleDeg: number
  /**
   * 隣接地 の ヒゲ線。 敷地 に 接する 土地 の 境界線 を 外側 へ 少し 伸ばし、
   * その 地番 を 添える。 長さ は 用紙 の 上 の mm で 決める。
   */
  whisker?: { show: boolean; lengthMm: number }
  /** 隣地 の 地番 など の 注記 (手 で 足す 分) */
  notes: SiteNote[]
  /**
   * 敷地境界 から の 離れ。 図面 に 記入 する 寸法。
   *
   * 建物 の 辺 → その 辺 上 の 点 → 境界線 の 順 に 選ぶ と 距離 が 決まる。
   * 出た 値 は value に 入れる ので、手 で 直したい ときは auto を 外して
   * value を 打ち替える。
   */
  refDistances: {
    id: string
    label: string
    value: number
    /** true の 間 は 選んだ 3 つ から 計算 し直す */
    auto?: boolean
    /** どの 棟 の 辺 か */
    buildingKey?: string
    /** 建物 の 辺 (moves の index) */
    buildingEdge?: number
    /** その 辺 の どこ か。 0=始点 / 1=終点 / 途中 は 0〜1 */
    t?: number
    /** 境界線 (敷地 の 辺 の 通し番号) */
    siteEdge?: number
  }[]
}

export const DEFAULT_SITE: SitePlan = {
  parcelIds: [],
  whisker: { show: true, lengthMm: 10 },
  parcelPointIds: [],
  placed: false,
  method: 'three_point',
  constraints: [],
  parallel: null,
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
  /** 法人 の 場合 の 立場 */
  makerRole?: 'member' | 'representative'
  makerName: string
  applicantName: string
  /** 図枠 を 組んだ 後 の 手直し (要素 の 移動 / 大きさ / 角度、足した 線 と 文字) */
  overlay?: import('./floorPlanDraw').SheetOverlay
  /** 申請人 の 立て方。 個人 / 共有 (複数名) / 法人 */
  applicantKind?: 'individual' | 'joint' | 'corporate'
  /** 共有 の ときの 氏名。 individual / corporate では 使わない */
  applicantNames?: string[]
  /** 法人 の 名称 */
  applicantCorporation?: string
  /** 法人 の 代表者 の 肩書 (代表取締役 など) */
  applicantTitle?: string
  remarks: string
}

/** 申請人 欄 に 出す 行。 h は 文字 の 高さ (mm) */
export function applicantLines(f: FloorPlanFrame): { text: string; h: number }[] {
  const kind = f.applicantKind ?? 'individual'
  if (kind === 'corporate') {
    const head = (f.applicantCorporation ?? '').trim()
    const tail = [(f.applicantTitle ?? '').trim(), f.applicantName.trim()]
      .filter(Boolean)
      .join('　')
    return [
      ...(head ? [{ text: head, h: 3.0 }] : []),
      ...(tail ? [{ text: tail, h: 3.8 }] : []),
    ]
  }
  if (kind === 'joint') {
    const names = (f.applicantNames ?? []).map((n) => n.trim()).filter(Boolean)
    // 人数 が 増える ほど 小さく する (欄 の 高さ は 20mm しか ない)
    const h = names.length <= 2 ? 3.6 : names.length <= 3 ? 3.0 : names.length <= 5 ? 2.6 : 2.2
    return names.map((text) => ({ text, h }))
  }
  return f.applicantName.trim() ? [{ text: f.applicantName.trim(), h: 4.5 }] : []
}

/** 資格 は この 様式 では 固定 (個人 の 事務所 の 場合) */
export const MAKER_QUALIFICATION = '土地家屋調査士'

/**
 * 表題欄 の 氏名 の 左 に 出す 肩書。
 * 土地家屋調査士法人 の 場合 は 資格 では なく 立場 (社員 / 代表社員) を 書く。
 */
export function makerTitle(frame: FloorPlanFrame): string {
  if (!frame.makerCorporation.trim()) return MAKER_QUALIFICATION
  return frame.makerRole === 'representative' ? '代表社員' : '社員'
}

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

/** 1 棟 の 据え付け */
export interface BuildingPlacement {
  offsetE: number
  offsetN: number
  rotationDeg: number
  placed: boolean
}

/** 棟 の 据え付け を 取り出す */
export function placementOf(site: SitePlan, key: string): BuildingPlacement {
  if (key === 'main') {
    return {
      offsetE: site.offsetE,
      offsetN: site.offsetN,
      rotationDeg: site.rotationDeg,
      placed: site.placed,
    }
  }
  return (
    site.annexPlacements?.[key] ?? { offsetE: 0, offsetN: 0, rotationDeg: 0, placed: false }
  )
}

/** 棟 の 据え付け を 書き戻す */
export function withPlacement(
  site: SitePlan,
  key: string,
  p: Partial<BuildingPlacement>,
): SitePlan {
  if (key === 'main') return { ...site, ...p }
  const cur = placementOf(site, key)
  return {
    ...site,
    annexPlacements: { ...(site.annexPlacements ?? {}), [key]: { ...cur, ...p } },
  }
}

/** 棟 の 3点指定 */
export function constraintsOf(site: SitePlan, key: string) {
  return (key === 'main' ? site.constraints : site.constraintsBy?.[key]) ?? []
}
export function withConstraints(
  site: SitePlan,
  key: string,
  cs: SitePlan['constraints'],
): SitePlan {
  if (key === 'main') return { ...site, constraints: cs }
  return { ...site, constraintsBy: { ...(site.constraintsBy ?? {}), [key]: cs } }
}

/** 棟 の 1辺平行 */
export function parallelOf(site: SitePlan, key: string) {
  return (key === 'main' ? site.parallel : site.parallelBy?.[key]) ?? null
}
export function withParallel(
  site: SitePlan,
  key: string,
  p: NonNullable<SitePlan['parallel']>,
): SitePlan {
  if (key === 'main') return { ...site, parallel: p }
  return { ...site, parallelBy: { ...(site.parallelBy ?? {}), [key]: p } }
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
