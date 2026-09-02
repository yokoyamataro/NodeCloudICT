// DXF (AutoCAD 2010 ASCII 想定) を dxf-parser で パースし、SVG レンダリング 向けの
// 「レイヤ別 エンティティ 配列」に 正規化する ヘルパ。
//
// - Shift-JIS で 出力された DXF (日本の 土木 CAD で 多い) は 呼び出し側で
//   Uint8Array → TextDecoder('shift-jis') で 文字列化して 渡す。
// - LINE / LWPOLYLINE / POLYLINE / TEXT / MTEXT / CIRCLE / ARC を サポート。
//   その他 は 現状 スキップ (後で 必要に なったら 拡張)。
// - 色は 「DXF ACI カラーインデックス → RGB」で 解決。 ByLayer (256) は レイヤの 色を 使う。
//   True Color (420 group) や ByBlock (0) は 現状 未対応 (適当な 黒に フォールバック)。

import DxfParser, {
  type IEntity,
  type ILayer,
  type ILineEntity,
  type ILwpolylineEntity,
  type IPolylineEntity,
  type ITextEntity,
  type IMtextEntity,
  type ICircleEntity,
  type IArcEntity,
} from 'dxf-parser'

/** AutoCAD カラーインデックス (ACI) の 標準 RGB マップ。 1..255 のみ 収録。 */
const ACI_PALETTE: Record<number, string> = (() => {
  // 主要な 数色 (7=白 は Black に 出す のが 一般的、印刷向け)
  const base: Record<number, string> = {
    1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff',
    5: '#0000ff', 6: '#ff00ff', 7: '#000000', 8: '#404040',
    9: '#808080',
  }
  // 10 以降は 大まかな 補間。 完全一致は 必要になったら 差替
  for (let i = 10; i <= 255; i++) {
    const t = (i - 10) / 245
    const r = Math.round(255 * (1 - t))
    const g = Math.round(128 * t)
    const b = Math.round(255 * t)
    base[i] = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
  }
  return base
})()

export interface DxfBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export type DxfShape =
  | { kind: 'line'; layer: string; color: string; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'polyline'; layer: string; color: string; closed: boolean; pts: { x: number; y: number }[] }
  | { kind: 'text'; layer: string; color: string; x: number; y: number; height: number; text: string; rotationDeg: number }
  | { kind: 'circle'; layer: string; color: string; cx: number; cy: number; r: number }
  | { kind: 'arc'; layer: string; color: string; cx: number; cy: number; r: number; startDeg: number; endDeg: number }

export interface DxfLayerInfo {
  name: string
  color: string
  visible: boolean
}

export interface DxfDocument {
  bounds: DxfBounds
  layers: DxfLayerInfo[]
  shapes: DxfShape[]
}

/** Shift-JIS デコード対応の DXF 読み込み (File / ArrayBuffer から)。 */
export async function readDxfFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  return decodeDxfBytes(buf)
}

/**
 * バイト列 → 文字列。 CAD (特に AutoCAD 系) の DXF は $DWGCODEPAGE=ANSI_932 が
 * 多く CP932 / Shift-JIS。ブラウザ TextDecoder に fatal:true を渡して 「途中で
 * 不正バイトを 出したら 却下」判定で 複数 label を 順に 試し、最初に 通ったもの を 採用。
 * label 名の 揺れ ('shift_jis' vs 'shift-jis' vs 'windows-31j' など) を 全部 試すことで、
 * ブラウザ側の エイリアス解決の 差に 巻き込まれない ように する。
 */
export function decodeDxfBytes(buf: ArrayBuffer): string {
  // Shift-JIS 系を 先に (ASCII は 全 label で 通るので、CJK バイトが 混ざる 場合
  // Shift-JIS が 通れば それが 正解、 通らなければ UTF-8 に フォールバック)
  const labels = ['shift_jis', 'shift-jis', 'windows-31j', 'ms932', 'utf-8']
  for (const label of labels) {
    try {
      const dec = new TextDecoder(label, { fatal: true })
      return dec.decode(buf)
    } catch {
      /* 次 label を 試す */
    }
  }
  // どれも 通らない (混合 encoding など) → non-fatal で 最も それらしい 出力に
  // 使う encoding は 「日本 DXF なら 大抵 Shift-JIS」の 前提で。
  try {
    return new TextDecoder('shift_jis', { fatal: false }).decode(buf)
  } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(buf)
  }
}

/** DXF 文字列を パースして 描画用の 正規化データ に 変換。 */
export function parseDxf(dxfText: string): DxfDocument {
  const parser = new DxfParser()
  const parsed = parser.parseSync(dxfText)
  if (!parsed) throw new Error('DXF の パースに 失敗しました')

  const layerMap: Record<string, ILayer> = parsed.tables?.layer?.layers ?? {}
  const layerColor = (name: string): string => {
    const l = layerMap[name]
    if (!l) return '#000000'
    return aciToRgb(l.color ?? 7)
  }

  const layerNames = new Set<string>()
  const shapes: DxfShape[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const updateBounds = (x: number, y: number) => {
    if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  }

  const resolveColor = (ent: IEntity, layer: string): string => {
    const raw = (ent as { color?: number }).color
    // ByLayer は 通常 未定義 or 256。エンティティに 色が あれば ACI として 解決。
    if (typeof raw === 'number' && raw > 0 && raw < 256) return aciToRgb(raw)
    return layerColor(layer)
  }

  for (const ent of parsed.entities ?? []) {
    const layer = ent.layer ?? '0'
    layerNames.add(layer)
    const color = resolveColor(ent, layer)
    if (ent.type === 'LINE') {
      const e = ent as ILineEntity
      const v0 = e.vertices?.[0]
      const v1 = e.vertices?.[1]
      if (!v0 || !v1) continue
      shapes.push({ kind: 'line', layer, color, x1: v0.x, y1: v0.y, x2: v1.x, y2: v1.y })
      updateBounds(v0.x, v0.y); updateBounds(v1.x, v1.y)
    } else if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
      const e = ent as ILwpolylineEntity | IPolylineEntity
      const vs = e.vertices ?? []
      if (vs.length < 2) continue
      const pts = vs.map((v) => ({ x: v.x, y: v.y }))
      const closed = Boolean((e as { shape?: boolean }).shape)
      shapes.push({ kind: 'polyline', layer, color, closed, pts })
      for (const p of pts) updateBounds(p.x, p.y)
    } else if (ent.type === 'CIRCLE') {
      const e = ent as ICircleEntity
      shapes.push({ kind: 'circle', layer, color, cx: e.center.x, cy: e.center.y, r: e.radius })
      updateBounds(e.center.x - e.radius, e.center.y - e.radius)
      updateBounds(e.center.x + e.radius, e.center.y + e.radius)
    } else if (ent.type === 'ARC') {
      const e = ent as IArcEntity
      shapes.push({
        kind: 'arc', layer, color,
        cx: e.center.x, cy: e.center.y, r: e.radius,
        startDeg: e.startAngle * (180 / Math.PI),
        endDeg: e.endAngle * (180 / Math.PI),
      })
      updateBounds(e.center.x - e.radius, e.center.y - e.radius)
      updateBounds(e.center.x + e.radius, e.center.y + e.radius)
    } else if (ent.type === 'TEXT' || ent.type === 'MTEXT') {
      const e = ent as ITextEntity | IMtextEntity
      const pos = (e as ITextEntity).startPoint ?? (e as IMtextEntity).position
      if (!pos) continue
      const text = (e as { text?: string; string?: string }).text
        ?? (e as { string?: string }).string
        ?? ''
      const height = (e as { textHeight?: number; height?: number }).textHeight
        ?? (e as { height?: number }).height
        ?? 2.5
      const rot = (e as { rotation?: number }).rotation ?? 0
      shapes.push({
        kind: 'text', layer, color,
        x: pos.x, y: pos.y, height, text, rotationDeg: rot,
      })
      updateBounds(pos.x, pos.y)
    }
  }

  // レイヤ 情報 (パース側の 定義順)
  const layers: DxfLayerInfo[] = Object.values(layerMap)
    .map((l) => ({
      name: l.name,
      color: aciToRgb(l.color ?? 7),
      visible: l.visible !== false,
    }))
  // エンティティ に 現れた けど layer table に 無い ものも 補完
  for (const name of layerNames) {
    if (!layers.some((l) => l.name === name)) {
      layers.push({ name, color: '#000000', visible: true })
    }
  }
  layers.sort((a, b) => a.name.localeCompare(b.name))

  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100 }
  return { bounds: { minX, minY, maxX, maxY }, layers, shapes }
}

function aciToRgb(idx: number): string {
  if (idx === 256 || idx === 0) return '#000000' // ByLayer / ByBlock
  return ACI_PALETTE[idx] ?? '#000000'
}

/**
 * スナップ 候補点 (端部 / 頂点 / 交点)。
 *   kind: 'end' 端点、'vertex' polyline 頂点、'inter' 線分交点
 */
export interface SnapTarget {
  x: number
  y: number
  kind: 'end' | 'vertex' | 'inter'
}

/** 線分 (LINE / polyline 分割後) の 内部 表現 (交点計算用) */
interface Seg { x1: number; y1: number; x2: number; y2: number; layer: string }

function segIntersect(a: Seg, b: Seg): { x: number; y: number } | null {
  const { x1, y1, x2, y2 } = a
  const { x1: x3, y1: y3, x2: x4, y2: y4 } = b
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(denom) < 1e-9) return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom
  const EPS = 1e-6
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1) }
}

function bboxOverlap(a: Seg, b: Seg): boolean {
  const ax0 = Math.min(a.x1, a.x2), ax1 = Math.max(a.x1, a.x2)
  const ay0 = Math.min(a.y1, a.y2), ay1 = Math.max(a.y1, a.y2)
  const bx0 = Math.min(b.x1, b.x2), bx1 = Math.max(b.x1, b.x2)
  const by0 = Math.min(b.y1, b.y2), by1 = Math.max(b.y1, b.y2)
  return !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0)
}

/**
 * DXF から スナップ 候補点を 抽出:
 *   - LINE / polyline の 各 端点 と 頂点
 *   - LINE 対 LINE の 交点 (segment 実際に 交わるもの のみ、bbox で 事前フィルタ)
 * 大量の 線が ある 図面でも 現実的な 時間で 終わるように bbox で 枝刈り。
 */
export function computeSnapTargets(doc: DxfDocument): SnapTarget[] {
  const out: SnapTarget[] = []
  const segs: Seg[] = []
  for (const s of doc.shapes) {
    if (s.kind === 'line') {
      out.push({ x: s.x1, y: s.y1, kind: 'end' })
      out.push({ x: s.x2, y: s.y2, kind: 'end' })
      segs.push({ x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2, layer: s.layer })
    } else if (s.kind === 'polyline') {
      for (const p of s.pts) out.push({ x: p.x, y: p.y, kind: 'vertex' })
      for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1], b = s.pts[i]
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, layer: s.layer })
      }
    } else if (s.kind === 'circle' || s.kind === 'arc') {
      out.push({ x: s.cx, y: s.cy, kind: 'end' }) // 中心 を 端点扱い (ざっくり)
    }
  }
  // 交点: 全ペア は O(n²)。 bbox で 弾いて 実質 O(n log n) 程度に。
  // 数万 セグメント だと それでも 遅いので 上限を 設ける。
  const maxSegForIntersect = 2000
  const N = Math.min(segs.length, maxSegForIntersect)
  const interSet = new Map<string, { x: number; y: number }>()
  for (let i = 0; i < N; i++) {
    const a = segs[i]
    for (let j = i + 1; j < N; j++) {
      const b = segs[j]
      if (!bboxOverlap(a, b)) continue
      const p = segIntersect(a, b)
      if (!p) continue
      // 端点 完全一致 は 端点として 既に 入っているので 除外 (誤差 10μm)
      const key = `${Math.round(p.x * 1e5)}:${Math.round(p.y * 1e5)}`
      if (!interSet.has(key)) interSet.set(key, p)
    }
  }
  for (const p of interSet.values()) {
    out.push({ x: p.x, y: p.y, kind: 'inter' })
  }
  return out
}

/**
 * 与えた 世界座標 (wx, wy) に 最も近い スナップ 候補を 返す。
 * threshold: 世界座標 での 半径。 これ以内 に 無ければ null。
 */
export function findNearestSnap(
  targets: SnapTarget[],
  wx: number,
  wy: number,
  threshold: number,
): SnapTarget | null {
  let best: SnapTarget | null = null
  let bestDist = threshold
  for (const t of targets) {
    const d = Math.hypot(t.x - wx, t.y - wy)
    if (d < bestDist) {
      bestDist = d
      best = t
    }
  }
  return best
}

/**
 * カーソル (wx, wy) に 最も近い 「指定方向 (h=水平 / v=垂直) の 線」の 座標を 返す。
 * DL 選択 (h) → その y を、中心線 選択 (v) → その x を 返す。
 * LINE / LWPOLYLINE の 水平/垂直 セグメント を 対象。 threshold は 世界座標 半径。
 * 該当なし は null。
 */
export function findNearestOrientedLine(
  shapes: DxfShape[],
  wx: number,
  wy: number,
  orientation: 'h' | 'v',
  threshold: number,
): number | null {
  let bestCoord: number | null = null
  let bestDist = threshold
  const consider = (x1: number, y1: number, x2: number, y2: number) => {
    if (orientation === 'h') {
      if (Math.abs(y1 - y2) > 0.1) return // 水平でない
      const y = (y1 + y2) / 2
      const d = Math.abs(y - wy)
      if (d < bestDist) { bestDist = d; bestCoord = y }
    } else {
      if (Math.abs(x1 - x2) > 0.1) return // 垂直でない
      const x = (x1 + x2) / 2
      const d = Math.abs(x - wx)
      if (d < bestDist) { bestDist = d; bestCoord = x }
    }
  }
  for (const s of shapes) {
    if (s.kind === 'line') {
      consider(s.x1, s.y1, s.x2, s.y2)
    } else if (s.kind === 'polyline') {
      for (let i = 1; i < s.pts.length; i++) {
        const a = s.pts[i - 1], b = s.pts[i]
        consider(a.x, a.y, b.x, b.y)
      }
    }
  }
  return bestCoord
}
