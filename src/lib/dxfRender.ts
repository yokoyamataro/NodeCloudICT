// DXF (AutoCAD 2010 ASCII 想定) を dxf-parser で パースし、SVG レンダリング 向けの
// 「レイヤ別 エンティティ 配列」に 正規化する ヘルパ。
//
// - Shift-JIS で 出力された DXF (日本の 土木 CAD で 多い) は 呼び出し側で
//   Uint8Array → TextDecoder('shift-jis') で 文字列化して 渡す。
// - LINE / LWPOLYLINE / POLYLINE / TEXT / MTEXT / ATTRIB / ATTDEF / CIRCLE / ARC /
//   INSERT (ブロック参照。 中身を 変換して 展開) を サポート。
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
  type IInsertEntity,
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
  | {
      kind: 'text'
      layer: string
      color: string
      x: number
      y: number
      height: number
      text: string
      rotationDeg: number
      /** SVG text-anchor。 DXF の 水平位置合わせ (group 72 / MTEXT の 挿入点) 由来 */
      anchor: 'start' | 'middle' | 'end'
      /** SVG dominant-baseline。 DXF の 垂直位置合わせ (group 73 / attachmentPoint) 由来 */
      baseline: 'alphabetic' | 'middle' | 'hanging'
    }
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

  // INSERT (ブロック参照) の 展開に 使う 相似変換。
  // world = 挿入点 + R(rot) * S(scale) * (p - ブロック基点)
  interface Xform {
    ox: number
    oy: number
    sx: number
    sy: number
    cos: number
    sin: number
    rotDeg: number
    /** 文字高さ / 半径 に かける 代表スケール */
    s: number
  }
  const IDENTITY: Xform = { ox: 0, oy: 0, sx: 1, sy: 1, cos: 1, sin: 0, rotDeg: 0, s: 1 }
  const apply = (t: Xform, x: number, y: number) => ({
    x: t.ox + (x * t.sx) * t.cos - (y * t.sy) * t.sin,
    y: t.oy + (x * t.sx) * t.sin + (y * t.sy) * t.cos,
  })

  const blocks = parsed.blocks ?? {}

  const pushEntities = (entities: IEntity[], t: Xform, depth: number) => {
    // 自己参照 ブロック で 無限再帰 しない よう 深さ を 制限
    if (depth > 8) return
    for (const ent of entities) {
      const layer = ent.layer ?? '0'
      layerNames.add(layer)
      const color = resolveColor(ent, layer)
      if (ent.type === 'LINE') {
        const e = ent as ILineEntity
        const v0 = e.vertices?.[0]
        const v1 = e.vertices?.[1]
        if (!v0 || !v1) continue
        const p0 = apply(t, v0.x, v0.y)
        const p1 = apply(t, v1.x, v1.y)
        shapes.push({ kind: 'line', layer, color, x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y })
        updateBounds(p0.x, p0.y); updateBounds(p1.x, p1.y)
      } else if (ent.type === 'LWPOLYLINE' || ent.type === 'POLYLINE') {
        const e = ent as ILwpolylineEntity | IPolylineEntity
        const vs = e.vertices ?? []
        if (vs.length < 2) continue
        const pts = vs.map((v) => apply(t, v.x, v.y))
        const closed = Boolean((e as { shape?: boolean }).shape)
        shapes.push({ kind: 'polyline', layer, color, closed, pts })
        for (const p of pts) updateBounds(p.x, p.y)
      } else if (ent.type === 'CIRCLE') {
        const e = ent as ICircleEntity
        const c = apply(t, e.center.x, e.center.y)
        const r = e.radius * t.s
        shapes.push({ kind: 'circle', layer, color, cx: c.x, cy: c.y, r })
        updateBounds(c.x - r, c.y - r)
        updateBounds(c.x + r, c.y + r)
      } else if (ent.type === 'ARC') {
        const e = ent as IArcEntity
        const c = apply(t, e.center.x, e.center.y)
        const r = e.radius * t.s
        shapes.push({
          kind: 'arc', layer, color,
          cx: c.x, cy: c.y, r,
          startDeg: e.startAngle * (180 / Math.PI) + t.rotDeg,
          endDeg: e.endAngle * (180 / Math.PI) + t.rotDeg,
        })
        updateBounds(c.x - r, c.y - r)
        updateBounds(c.x + r, c.y + r)
      } else if (ent.type === 'INSERT') {
        const e = ent as IInsertEntity
        const blk = blocks[e.name]
        if (!blk?.entities?.length) continue
        const rot = ((e.rotation ?? 0) * Math.PI) / 180
        const sx = e.xScale ?? 1
        const sy = e.yScale ?? 1
        const cos = Math.cos(rot)
        const sin = Math.sin(rot)
        const base = blk.position ?? { x: 0, y: 0 }
        // 行列 と 行列 の 合成 (親 t の 上に 今回の 変換 を 積む)
        const cols = Math.max(1, e.columnCount ?? 1)
        const rows = Math.max(1, e.rowCount ?? 1)
        const cSp = e.columnSpacing ?? 0
        const rSp = e.rowSpacing ?? 0
        for (let ci = 0; ci < cols; ci++) {
          for (let ri = 0; ri < rows; ri++) {
            // ブロック ローカル 座標 p に 対して
            //   local = R*S*(p - base) + 挿入点(+ 配列オフセット)
            // これを 親 t で さらに 変換 する
            const insX = (e.position?.x ?? 0) + ci * cSp
            const insY = (e.position?.y ?? 0) + ri * rSp
            // 合成後 の 原点 = t(挿入点 - R*S*base)
            const localOx = insX - (base.x * sx * cos - base.y * sy * sin)
            const localOy = insY - (base.x * sx * sin + base.y * sy * cos)
            const o = apply(t, localOx, localOy)
            const child: Xform = {
              ox: o.x,
              oy: o.y,
              sx: t.sx * sx,
              sy: t.sy * sy,
              cos: Math.cos(rot + (t.rotDeg * Math.PI) / 180),
              sin: Math.sin(rot + (t.rotDeg * Math.PI) / 180),
              rotDeg: t.rotDeg + (e.rotation ?? 0),
              s: t.s * (Math.abs(sx) + Math.abs(sy)) / 2,
            }
            pushEntities(blk.entities, child, depth + 1)
          }
        }
      } else if (
        ent.type === 'TEXT' ||
        ent.type === 'MTEXT' ||
        ent.type === 'ATTRIB' ||
        ent.type === 'ATTDEF'
      ) {
        const isM = ent.type === 'MTEXT'
        const e = ent as ITextEntity | IMtextEntity
        // TEXT / ATTRIB は 位置合わせ が 「左下」以外 の とき、実際の 基準点 が
        // group 11 (endPoint) に 入る。 group 10 は 0,0 のまま の CAD が 多く、
        // ここを 見落とすと 文字が 原点に 積み上がって 画面外 に 消える。
        const halign = (e as { halign?: number }).halign ?? 0
        const valign = (e as { valign?: number }).valign ?? 0
        const startPoint = (e as ITextEntity).startPoint
        const endPoint = (e as ITextEntity).endPoint
        const pos = isM
          ? (e as IMtextEntity).position
          : (halign !== 0 || valign !== 0) && endPoint
            ? endPoint
            : startPoint ?? endPoint
        if (!pos) continue
        const rawText = (e as { text?: string }).text ?? ''
        const height =
          (e as { textHeight?: number }).textHeight ??
          (e as { height?: number }).height ??
          2.5
        const rot = (e as { rotation?: number }).rotation ?? 0
        // MTEXT は 挿入点 の 意味 が attachmentPoint (1..9) で 決まる
        const ap = (e as IMtextEntity).attachmentPoint ?? 1
        const anchor: 'start' | 'middle' | 'end' = isM
          ? ap % 3 === 1 ? 'start' : ap % 3 === 2 ? 'middle' : 'end'
          : halign === 1 || halign === 4 ? 'middle' : halign === 2 ? 'end' : 'start'
        const baseline: 'alphabetic' | 'middle' | 'hanging' = isM
          ? ap <= 3 ? 'hanging' : ap <= 6 ? 'middle' : 'alphabetic'
          : valign === 3 ? 'hanging' : valign === 2 ? 'middle' : 'alphabetic'
        const lines = decodeDxfText(rawText, isM)
        if (lines.length === 0) continue
        const h = height * t.s
        const p = apply(t, pos.x, pos.y)
        // 複数行 (MTEXT の \P) は 行送り 1.2 倍 で 下 に 積む
        const dirRad = ((rot + t.rotDeg) * Math.PI) / 180
        lines.forEach((line, li) => {
          if (!line) return
          // 行送り は 文字の 「下」方向 = 回転後の -Y 側
          const off = li * h * 1.2
          const lx = p.x + off * Math.sin(dirRad)
          const ly = p.y - off * Math.cos(dirRad)
          shapes.push({
            kind: 'text', layer, color,
            x: lx, y: ly, height: h, text: line,
            rotationDeg: rot + t.rotDeg,
            anchor, baseline,
          })
          updateBounds(lx, ly)
        })
      }
    }
  }

  pushEntities(parsed.entities ?? [], IDENTITY, 0)

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

/**
 * DXF の 文字列 を 表示用 に 整える。
 *
 * - TEXT: %%d → °、%%c → ⌀、%%p → ± の 特殊コード だけ 置換 する。
 * - MTEXT: フォーマットコード (\fMS Gothic|b0; や \H0.7x; \A1; と それを 囲む
 *   波括弧) を 落とし、\P を 改行 として 行 に 分ける。 これを しないと 制御
 *   コード が そのまま 出て 読めない。
 *
 * 戻り値 は 行 の 配列 (TEXT は 常に 1 行)。
 */
export function decodeDxfText(raw: string, isMText: boolean): string[] {
  if (!raw) return []
  let t = raw
  if (isMText) {
    t = t.replace(/\\P/g, '\n')
    // \f フォント指定、\H 文字高、\W 幅、\Q 傾き、\A 位置、\C/\c 色、\T 字間、\p 段落
    t = t.replace(/\\[fF][^;]*;/g, '')
    t = t.replace(/\\[HWQATCcpL][^;]*;/g, '')
    // 分数/積み文字 は 中身 だけ 残す
    t = t.replace(/\\S([^;]*);/g, '$1')
    t = t.replace(/\\~/g, ' ')
    // 書式グループ の 波括弧 を 外し、最後に エスケープ を 解除
    t = t.replace(/[{}]/g, '')
    t = t.replace(/\\\\/g, '\\')
  }
  t = t.replace(/%%[dD]/g, '°').replace(/%%[cC]/g, '⌀').replace(/%%[pP]/g, '±')
  // %%123 形式 (ASCII コード 指定)
  t = t.replace(/%%(\d{1,3})/g, (_m, n: string) => String.fromCharCode(Number(n)))
  const lines = isMText ? t.split('\n') : [t]
  return lines.map((l) => l.trimEnd())
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
