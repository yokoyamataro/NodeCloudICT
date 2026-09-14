// STEP AP202 (ISO 10303-21 / ASSOCIATIVE_DRAUGHTING) を 画面表示用 に 読む。
//
// SXF の P21 には 2 通り の 中身 が ある:
//   * feature_mode … SXF 独自 の line_feature(...) 等   → parseSxf.ts
//   * AP202_mode   … 素 の STEP 図形 (cartesian_point / line / trimmed_curve …)
// ヘッダ の FILE_DESCRIPTION に どちら か 書いて ある。 こちら は 後者。
//
// 対応: line (trimmed_curve 経由) / circle / arc / ellipse / polyline /
//   b_spline (制御点 の 折れ線 で 近似) / composite_curve / text。
// 色 は styled_item → curve_style/text_style → colour_rgb か 既定色名。
// レイヤ は presentation_layer_assignment。

import type { DxfDocument, DxfShape, DxfLayerInfo } from '@/lib/dxfRender'

/** 1 インスタンス。 複合エンティティ (#10=(A()B())) は types に 複数 入る */
interface Inst {
  id: number
  /** 小文字 の 型名。 複合 の 場合 は 並び 順 */
  types: string[]
  /** 型ごと の 引数。 単純 エンティティ は [0] だけ */
  argsByType: string[][]
}

/** ISO 10303-21 の 拡張文字列 (\X2\....\X0\ など) を 復号 */
export function decodeStepString(raw: string): string {
  let s = raw.replace(/''/g, "'")
  // \X2\<UTF-16BE hex>\X0\
  s = s.replace(/\\X2\\([0-9A-Fa-f]+)\\X0\\/g, (_m, hex: string) => {
    let out = ''
    for (let i = 0; i + 3 < hex.length; i += 4) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    }
    return out
  })
  // \X4\<UTF-32 hex>\X0\
  s = s.replace(/\\X4\\([0-9A-Fa-f]+)\\X0\\/g, (_m, hex: string) => {
    let out = ''
    for (let i = 0; i + 7 < hex.length; i += 8) {
      out += String.fromCodePoint(parseInt(hex.slice(i, i + 8), 16))
    }
    return out
  })
  // \X\xx (1 バイト)
  s = s.replace(/\\X\\([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  )
  // \S\c → 上位ビット付き 1 文字 (ほぼ 使われない)
  s = s.replace(/\\S\\(.)/g, (_m, c: string) => String.fromCharCode(c.charCodeAt(0) + 128))
  return s
}

/** 引数文字列 を 1 段 だけ 分解 (文字列 / 括弧 の 中 の カンマ は 無視) */
function splitArgs(src: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let cur = ''
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]
    if (inStr) {
      cur += c
      if (c === "'") {
        if (src[i + 1] === "'") {
          cur += "'"
          i += 1
        } else {
          inStr = false
        }
      }
      continue
    }
    if (c === "'") {
      inStr = true
      cur += c
      continue
    }
    if (c === '(') depth += 1
    if (c === ')') depth -= 1
    if (c === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

/** DATA セクション を インスタンス の 表 に する */
function parseInstances(text: string): Map<number, Inst> {
  const map = new Map<number, Inst>()
  const dataIdx = text.indexOf('DATA;')
  const body = dataIdx >= 0 ? text.slice(dataIdx + 5) : text

  // #id = 中身 ;  (文字列 の 中 の ; は 無視)
  let i = 0
  while (i < body.length) {
    const hash = body.indexOf('#', i)
    if (hash < 0) break
    const m = /^#(\d+)\s*=\s*/.exec(body.slice(hash))
    if (!m) {
      i = hash + 1
      continue
    }
    const id = Number(m[1])
    let j = hash + m[0].length
    let depth = 0
    let inStr = false
    const start = j
    for (; j < body.length; j += 1) {
      const c = body[j]
      if (inStr) {
        if (c === "'") {
          if (body[j + 1] === "'") j += 1
          else inStr = false
        }
        continue
      }
      if (c === "'") { inStr = true; continue }
      if (c === '(') { depth += 1; continue }
      if (c === ')') { depth -= 1; continue }
      if (c === ';' && depth === 0) break
    }
    const raw = body.slice(start, j).trim()
    i = j + 1

    const types: string[] = []
    const argsByType: string[][] = []
    if (raw.startsWith('(')) {
      // 複合エンティティ: ( A(...) B(...) )
      const inner = raw.slice(1, raw.lastIndexOf(')'))
      const re = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g
      let mm: RegExpExecArray | null
      while ((mm = re.exec(inner)) !== null) {
        let k = re.lastIndex
        let d = 1
        let str = false
        const s0 = k
        for (; k < inner.length; k += 1) {
          const c = inner[k]
          if (str) {
            if (c === "'") {
              if (inner[k + 1] === "'") k += 1
              else str = false
            }
            continue
          }
          if (c === "'") { str = true; continue }
          if (c === '(') { d += 1; continue }
          if (c === ')') { d -= 1; if (d === 0) break; continue }
        }
        types.push(mm[1].toLowerCase())
        argsByType.push(splitArgs(inner.slice(s0, k)))
        re.lastIndex = k + 1
      }
    } else {
      const mm = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(raw)
      if (!mm) continue
      types.push(mm[1].toLowerCase())
      argsByType.push(splitArgs(raw.slice(mm[0].length, raw.lastIndexOf(')'))))
    }
    if (types.length > 0) map.set(id, { id, types, argsByType })
  }
  return map
}

const refId = (s: string | undefined): number | null => {
  if (!s) return null
  const m = /^#(\d+)$/.exec(s.trim())
  return m ? Number(m[1]) : null
}
const refList = (s: string | undefined): number[] => {
  if (!s) return []
  return Array.from(s.matchAll(/#(\d+)/g)).map((m) => Number(m[1]))
}
const numOf = (s: string | undefined): number => {
  if (!s) return NaN
  const v = Number(s.trim())
  return Number.isFinite(v) ? v : NaN
}
const numList = (s: string | undefined): number[] => {
  if (!s) return []
  const body = s.trim().replace(/^\(/, '').replace(/\)$/, '')
  if (body.trim() === '') return []
  return body.split(',').map((t) => numOf(t))
}
const strOf = (s: string | undefined): string => {
  if (!s) return ''
  const t = s.trim()
  if (!t.startsWith("'")) return ''
  return decodeStepString(t.slice(1, t.lastIndexOf("'")))
}

type XY = { x: number; y: number }

/** 既定色名 → RGB (AP202 draughting_pre_defined_colour) */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  yellow: '#ffff00',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#000000', // 白地 に 白 は 見えない ので 黒 に 倒す
}

export interface StepParseResult extends DxfDocument {
  tokens: { name: string; count: number }[]
}

export function parseStepAp202(text: string): StepParseResult {
  const insts = parseInstances(text)
  const get = (id: number | null): Inst | null => (id == null ? null : insts.get(id) ?? null)
  /** 型 t の 引数 を 取り出す (複合エンティティ にも 対応) */
  const argsOf = (inst: Inst | null, t: string): string[] | null => {
    if (!inst) return null
    const i = inst.types.indexOf(t)
    return i >= 0 ? inst.argsByType[i] : null
  }

  // ---- 幾何 の 取り出し ----
  const pointOf = (id: number | null): XY | null => {
    const a = argsOf(get(id), 'cartesian_point')
    if (!a) return null
    const c = numList(a[1])
    if (c.length < 2 || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null
    return { x: c[0], y: c[1] }
  }
  const dirOf = (id: number | null): XY | null => {
    const a = argsOf(get(id), 'direction')
    if (!a) return null
    const c = numList(a[1])
    if (c.length < 2) return null
    return { x: c[0], y: c[1] }
  }

  // ---- 色 / レイヤ ----
  const colorOfStyleItem = (itemId: number): string | undefined => {
    const styled = styledByItem.get(itemId)
    if (styled == null) return undefined
    return colorOfStyled(styled)
  }
  const colorFromColourEntity = (id: number | null): string | undefined => {
    const inst = get(id)
    if (!inst) return undefined
    const rgb = argsOf(inst, 'colour_rgb')
    if (rgb) {
      const to = (v: string) => {
        const n = numOf(v)
        const b = Math.round((Number.isFinite(n) ? n : 0) * 255)
        return Math.max(0, Math.min(255, b)).toString(16).padStart(2, '0')
      }
      return `#${to(rgb[1])}${to(rgb[2])}${to(rgb[3])}`
    }
    const pre = argsOf(inst, 'draughting_pre_defined_colour')
    if (pre) {
      const name = strOf(pre[0]).toLowerCase()
      return NAMED_COLORS[name]
    }
    return undefined
  }
  const colorOfStyled = (styledId: number): string | undefined => {
    const a = argsOf(get(styledId), 'styled_item')
    if (!a) return undefined
    for (const psaId of refList(a[1])) {
      const psa = argsOf(get(psaId), 'presentation_style_assignment')
      if (!psa) continue
      for (const styleId of refList(psa[0])) {
        const st = get(styleId)
        const cs = argsOf(st, 'curve_style')
        if (cs) {
          const c = colorFromColourEntity(refId(cs[3]))
          if (c) return c
        }
        const ts = argsOf(st, 'text_style')
          ?? argsOf(st, 'text_style_with_box_characteristics')
          ?? argsOf(st, 'text_style_with_spacing')
        if (ts) {
          // text_style(name, character_appearance) → text_style_for_defined_font(colour)
          const tf = argsOf(get(refId(ts[1])), 'text_style_for_defined_font')
          if (tf) {
            const c = colorFromColourEntity(refId(tf[0]))
            if (c) return c
          }
        }
        const fs = argsOf(st, 'fill_area_style')
        if (fs) {
          for (const fid of refList(fs[1])) {
            const fc = argsOf(get(fid), 'fill_area_style_colour')
            if (fc) {
              const c = colorFromColourEntity(refId(fc[1]))
              if (c) return c
            }
          }
        }
      }
    }
    return undefined
  }

  // item id → styled_item id
  const styledByItem = new Map<number, number>()
  // item id → レイヤ名
  const layerByItem = new Map<number, string>()
  const layerNames = new Set<string>()
  for (const inst of insts.values()) {
    const sa = argsOf(inst, 'styled_item')
    if (sa) {
      const target = refId(sa[2])
      if (target != null) styledByItem.set(target, inst.id)
    }
    const la =
      argsOf(inst, 'presentation_layer_assignment') ??
      argsOf(inst, 'presentation_layer_usage')
    if (la) {
      const name = strOf(la[0])
      if (name) {
        layerNames.add(name)
        for (const item of refList(la[2] ?? la[1])) layerByItem.set(item, name)
      }
    }
  }
  /** styled_item 経由 で 図形 に レイヤ が 付く ことが 多い ので 両方 見る */
  const layerOfItem = (itemId: number): string => {
    const direct = layerByItem.get(itemId)
    if (direct) return direct
    const styled = styledByItem.get(itemId)
    if (styled != null) {
      const viaStyle = layerByItem.get(styled)
      if (viaStyle) return viaStyle
    }
    return '0'
  }

  // ---- 図形 ----
  const shapes: DxfShape[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const bump = (x: number, y: number) => {
    if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  }
  const usedAsBasis = new Set<number>()
  for (const inst of insts.values()) {
    const tc = argsOf(inst, 'trimmed_curve')
    if (tc) {
      const b = refId(tc[1])
      if (b != null) usedAsBasis.add(b)
    }
    const cc = argsOf(inst, 'composite_curve_segment')
    if (cc) {
      const b = refId(cc[3])
      if (b != null) usedAsBasis.add(b)
    }
  }

  /**
   * 2 次元 の アフィン 変換。 x' = a x + c y + e / y' = b x + d y + f
   *
   * 図面 は 記号 や 部品 を 「別 の 座標系 で 1 回 定義 して、置きたい 場所 に
   * 何度も 貼る」 作り に なって いる (representation_map + mapped_item)。
   * 貼る ときの 変換 を 掛けない と、その 中身 が 原点 付近 に 出て しまい、
   * 文字 が 変な 位置 に 出たり 図面 全体 の 範囲 が 狂ったり する。
   */
  interface Xf { a: number; b: number; c: number; d: number; e: number; f: number }
  const ID: Xf = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  const apply = (t: Xf, p: XY): XY => ({
    x: t.a * p.x + t.c * p.y + t.e,
    y: t.b * p.x + t.d * p.y + t.f,
  })
  /** t2 を 掛けて から t1 を 掛ける 合成 */
  const mul = (t1: Xf, t2: Xf): Xf => ({
    a: t1.a * t2.a + t1.c * t2.b,
    b: t1.b * t2.a + t1.d * t2.b,
    c: t1.a * t2.c + t1.c * t2.d,
    d: t1.b * t2.c + t1.d * t2.d,
    e: t1.a * t2.e + t1.c * t2.f + t1.e,
    f: t1.b * t2.e + t1.d * t2.f + t1.f,
  })
  /** 拡大率 (半径 / 文字高 に 掛ける)。 回転 だけ なら 1 */
  const scaleOf = (t: Xf): number => Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) || 1
  /** 回転角 [度] (円弧 の 開始 / 終了 角 と 文字 の 傾き に 足す) */
  const rotOf = (t: Xf): number => (Math.atan2(t.b, t.a) * 180) / Math.PI

  /** 角度 の 値 を 度 に 揃える (ラジアン で 書く CAD も ある) */
  const toDeg = (v: number): number => (Math.abs(v) <= Math.PI * 2 + 1e-9 ? (v * 180) / Math.PI : v)

  const emitTrimmed = (inst: Inst, a: string[], xf: Xf) => {
    const basis = get(refId(a[1]))
    if (!basis) return
    const layer = layerOfItem(inst.id)
    const color = colorOfStyleItem(inst.id) ?? colorOfStyleItem(basis.id) ?? '#000000'

    const lineArgs = argsOf(basis, 'line')
    if (lineArgs) {
      const p0 = pointOf(refId(lineArgs[1]))
      const vecArgs = argsOf(get(refId(lineArgs[2])), 'vector')
      const d = dirOf(refId(vecArgs?.[1] ?? ''))
      const mag = numOf(vecArgs?.[2] ?? '')
      if (!p0 || !d) return
      const at = (trim: string): XY | null => {
        const pid = refId((/#\d+/.exec(trim) ?? [''])[0])
        const p = pointOf(pid)
        if (p) return p
        const pm = /parameter_value\s*\(\s*([-0-9.eE+]+)\s*\)/i.exec(trim)
        if (pm) {
          const t = Number(pm[1])
          const m = Number.isFinite(mag) ? mag : 1
          return { x: p0.x + d.x * m * t, y: p0.y + d.y * m * t }
        }
        return null
      }
      const s0 = at(a[2] ?? '')
      const e0 = at(a[3] ?? '')
      if (!s0 || !e0) return
      const s = apply(xf, s0)
      const e = apply(xf, e0)
      shapes.push({ kind: 'line', layer, color, x1: s.x, y1: s.y, x2: e.x, y2: e.y })
      bump(s.x, s.y); bump(e.x, e.y)
      return
    }

    const circArgs = argsOf(basis, 'circle')
    if (circArgs) {
      const pl = argsOf(get(refId(circArgs[1])), 'axis2_placement_2d')
      const c0 = pointOf(refId(pl?.[1] ?? ''))
      const r0 = numOf(circArgs[2])
      if (!c0 || !Number.isFinite(r0)) return
      const c = apply(xf, c0)
      const r = r0 * scaleOf(xf)
      const ref = dirOf(refId(pl?.[2] ?? '')) ?? { x: 1, y: 0 }
      const base = (Math.atan2(ref.y, ref.x) * 180) / Math.PI
      const ang = (trim: string): number | null => {
        const pid = refId((/#\d+/.exec(trim) ?? [''])[0])
        const p = pointOf(pid)
        if (p) return (Math.atan2(p.y - c0.y, p.x - c0.x) * 180) / Math.PI
        const pm = /parameter_value\s*\(\s*([-0-9.eE+]+)\s*\)/i.exec(trim)
        if (pm) return base + toDeg(Number(pm[1]))
        return null
      }
      let s = ang(a[2] ?? '')
      let e = ang(a[3] ?? '')
      if (s == null || e == null) return
      // sense_agreement=.F. なら 向き が 逆
      if (/\.F\./i.test(a[4] ?? '')) { const t = s; s = e; e = t }
      // 貼り付け の 回転 を 足す
      const rot = rotOf(xf)
      s += rot
      e += rot
      shapes.push({ kind: 'arc', layer, color, cx: c.x, cy: c.y, r, startDeg: s, endDeg: e })
      bump(c.x - r, c.y - r); bump(c.x + r, c.y + r)
    }
  }

  /** 1 つ の item を 変換 xf を 掛けて 図形 に する */
  const emitItem = (inst: Inst, xf: Xf) => {
    // --- 円 (トリム されて いない もの だけ) ---
    const ci = argsOf(inst, 'circle')
    if (ci && !usedAsBasis.has(inst.id)) {
      const pl = argsOf(get(refId(ci[1])), 'axis2_placement_2d')
      const c = pointOf(refId(pl?.[1] ?? ''))
      const r = numOf(ci[2])
      if (c && Number.isFinite(r)) {
        const p = apply(xf, c)
        const rr = r * scaleOf(xf)
        shapes.push({
          kind: 'circle',
          layer: layerOfItem(inst.id),
          color: colorOfStyleItem(inst.id) ?? '#000000',
          cx: p.x, cy: p.y, r: rr,
        })
        bump(p.x - rr, p.y - rr); bump(p.x + rr, p.y + rr)
      }
      return
    }
    // --- 楕円 (長半径 の 円 で 近似) ---
    const el = argsOf(inst, 'ellipse')
    if (el && !usedAsBasis.has(inst.id)) {
      const pl = argsOf(get(refId(el[1])), 'axis2_placement_2d')
      const c = pointOf(refId(pl?.[1] ?? ''))
      const r = Math.max(numOf(el[2]), numOf(el[3]))
      if (c && Number.isFinite(r)) {
        const p = apply(xf, c)
        const rr = r * scaleOf(xf)
        shapes.push({
          kind: 'circle',
          layer: layerOfItem(inst.id),
          color: colorOfStyleItem(inst.id) ?? '#000000',
          cx: p.x, cy: p.y, r: rr,
        })
        bump(p.x - rr, p.y - rr); bump(p.x + rr, p.y + rr)
      }
      return
    }
    // --- 折れ線 ---
    const po = argsOf(inst, 'polyline')
    if (po) {
      const pts: XY[] = []
      for (const pid of refList(po[1])) {
        const p0 = pointOf(pid)
        if (p0) { const p = apply(xf, p0); pts.push(p); bump(p.x, p.y) }
      }
      if (pts.length >= 2) {
        shapes.push({
          kind: 'polyline',
          layer: layerOfItem(inst.id),
          color: colorOfStyleItem(inst.id) ?? '#000000',
          closed: false,
          pts,
        })
      }
      return
    }
    // --- スプライン は 制御点 の 折れ線 で 近似 ---
    const bs =
      argsOf(inst, 'b_spline_curve_with_knots') ??
      argsOf(inst, 'b_spline_curve') ??
      argsOf(inst, 'bezier_curve')
    if (bs) {
      const pts: XY[] = []
      for (const pid of refList(bs[2] ?? bs[1])) {
        const p0 = pointOf(pid)
        if (p0) { const p = apply(xf, p0); pts.push(p); bump(p.x, p.y) }
      }
      if (pts.length >= 2) {
        shapes.push({
          kind: 'polyline',
          layer: layerOfItem(inst.id),
          color: colorOfStyleItem(inst.id) ?? '#000000',
          closed: false,
          pts,
        })
      }
      return
    }
    // --- トリム曲線 (直線 / 円弧) ---
    const tc = argsOf(inst, 'trimmed_curve')
    if (tc) {
      emitTrimmed(inst, tc, xf)
      return
    }
    // --- 文字 ---
    const tl =
      argsOf(inst, 'text_literal_with_extent') ??
      argsOf(inst, 'text_literal_with_associated_curves') ??
      argsOf(inst, 'text_literal')
    if (tl) {
      const str = strOf(tl[1])
      const pl = argsOf(get(refId(tl[2])), 'axis2_placement_2d')
      const p0 = pointOf(refId(pl?.[1] ?? ''))
      if (!str || !p0) return
      const p = apply(xf, p0)
      const d = dirOf(refId(pl?.[2] ?? '')) ?? { x: 1, y: 0 }
      const rot = (Math.atan2(d.y, d.x) * 180) / Math.PI + rotOf(xf)
      // planar_extent(name, size_in_x, size_in_y) の y が 文字高
      const ex = argsOf(get(refId(tl[6] ?? '')), 'planar_extent')
      const h = numOf(ex?.[2] ?? '')
      const align = (tl[3] ?? '').toLowerCase()
      shapes.push({
        kind: 'text',
        layer: layerOfItem(inst.id),
        color: colorOfStyleItem(inst.id) ?? '#000000',
        x: p.x,
        y: p.y,
        height: (Number.isFinite(h) && h > 0 ? h : 2.5) * scaleOf(xf),
        text: str,
        rotationDeg: rot,
        anchor: align.includes('right') ? 'end' : align.includes('cent') ? 'middle' : 'start',
        baseline: 'alphabetic',
      })
      bump(p.x, p.y)
      return
    }
  }

  // ---- 記号 / 部品 の 貼り付け (representation_map + mapped_item) ----
  //
  // representation('名前',(中身...),文脈) を representation_map が 指し、
  // mapped_item が 「どこに 貼るか」 を 持つ。 貼られる 側 の 中身 を
  // その場 で 描く と 原点 付近 に 出て しまう ので、
  //   ・貼られる 側 の item は 単独 では 描かない
  //   ・mapped_item ごと に 変換 を 掛けて 描く
  // と する。
  const REP_TYPES = [
    'representation',
    'shape_representation',
    'symbol_representation',
    'annotation_symbol_representation',
    'draughting_subfigure_representation',
    'annotation_occurrence_relationship',
  ]
  /** representation id → 中身 の item id */
  const repItems = new Map<number, number[]>()
  for (const inst of insts.values()) {
    for (const t of REP_TYPES) {
      const a = argsOf(inst, t)
      if (a && a.length >= 2) {
        const ids = refList(a[1])
        if (ids.length > 0) repItems.set(inst.id, ids)
        break
      }
    }
  }

  /** 置き方 (axis2_placement_2d / 変換演算子) を アフィン に する */
  const xfOfPlacement = (id: number | null): Xf => {
    const inst = get(id)
    if (!inst) return ID
    const pl = argsOf(inst, 'axis2_placement_2d')
    if (pl) {
      const o = pointOf(refId(pl[1])) ?? { x: 0, y: 0 }
      const d = dirOf(refId(pl[2] ?? '')) ?? { x: 1, y: 0 }
      const len = Math.hypot(d.x, d.y) || 1
      const c = d.x / len
      const sn = d.y / len
      return { a: c, b: sn, c: -sn, d: c, e: o.x, f: o.y }
    }
    const op =
      argsOf(inst, 'cartesian_transformation_operator_2d') ??
      argsOf(inst, 'cartesian_transformation_operator')
    if (op) {
      const o = pointOf(refId(op[3])) ?? { x: 0, y: 0 }
      const d = dirOf(refId(op[1] ?? '')) ?? { x: 1, y: 0 }
      const k = Number.isFinite(numOf(op[4])) ? numOf(op[4]) : 1
      const len = Math.hypot(d.x, d.y) || 1
      const c = (d.x / len) * k
      const sn = (d.y / len) * k
      return { a: c, b: sn, c: -sn, d: c, e: o.x, f: o.y }
    }
    return ID
  }
  /** アフィン の 逆 */
  const invert = (t: Xf): Xf => {
    const det = t.a * t.d - t.b * t.c
    if (!det) return ID
    const ia = t.d / det
    const ib = -t.b / det
    const ic = -t.c / det
    const id2 = t.a / det
    return { a: ia, b: ib, c: ic, d: id2, e: -(ia * t.e + ic * t.f), f: -(ib * t.e + id2 * t.f) }
  }

  // 貼られる 側 (= representation_map が 指す 先) の item は 単独 では 描かない
  const mappedItemIds = new Set<number>()
  const mapTargets = new Map<number, { repId: number; origin: number | null }>()
  for (const inst of insts.values()) {
    const rm = argsOf(inst, 'representation_map')
    if (!rm) continue
    const repId = refId(rm[1])
    mapTargets.set(inst.id, { repId: repId ?? -1, origin: refId(rm[0]) })
    if (repId != null) {
      for (const id of repItems.get(repId) ?? []) mappedItemIds.add(id)
    }
  }

  /** representation の 中身 を 変換 を 掛けて 描く (入れ子 も 辿る) */
  const emitRep = (repId: number, xf: Xf, depth: number) => {
    if (depth > 8) return
    for (const id of repItems.get(repId) ?? []) {
      const child = get(id)
      if (!child) continue
      const mi = argsOf(child, 'mapped_item')
      if (mi) {
        emitMapped(mi, xf, depth + 1)
        continue
      }
      emitItem(child, xf)
    }
  }
  /** mapped_item 1 つ を 描く */
  const emitMapped = (a: string[], parent: Xf, depth: number) => {
    if (depth > 8) return
    const src = mapTargets.get(refId(a[1]) ?? -1)
    if (!src || src.repId < 0) return
    // 元 の 原点 を 打ち消して から 置き先 へ
    const xf = mul(parent, mul(xfOfPlacement(refId(a[2])), invert(xfOfPlacement(src.origin))))
    emitRep(src.repId, xf, depth)
  }

  // まず 貼り付け を 描く
  for (const inst of insts.values()) {
    const mi = argsOf(inst, 'mapped_item')
    if (mi) emitMapped(mi, ID, 0)
  }
  // 貼られる 側 に 属さない item を そのまま 描く
  for (const inst of insts.values()) {
    if (mappedItemIds.has(inst.id)) continue
    if (argsOf(inst, 'mapped_item')) continue
    emitItem(inst, ID)
  }

  const layers: DxfLayerInfo[] = Array.from(layerNames).map((name) => ({
    name,
    color: '#000000',
    visible: true,
  }))
  const used = new Set(shapes.map((s) => s.layer))
  for (const name of used) {
    if (!layers.some((l) => l.name === name)) {
      layers.push({ name, color: '#000000', visible: true })
    }
  }
  layers.sort((a, b) => a.name.localeCompare(b.name))

  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100 }

  const counts = new Map<string, number>()
  for (const inst of insts.values()) {
    for (const t of inst.types) counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const tokens = Array.from(counts, ([name, count]) => ({ name, count })).sort(
    (a, b) => b.count - a.count,
  )

  return { bounds: { minX, minY, maxX, maxY }, layers, shapes, tokens }
}
