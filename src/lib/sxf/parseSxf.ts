// SXF (SFC / P21) を 画面表示用 に 読む。
//
// SXF には 2 つ の 物理形式 が ある:
//   * P21 … ISO 10303-21 の Part21 ファイル。 `#10=LINE_FEATURE(...);`
//   * SFC … フィーチャコメント形式。 同じ フィーチャ を コメント の 中 に 書く
// どちら も 中身 の 「フィーチャ」 の 名前 と 引数 の 並び は 共通 なので、
// 囲い の 構文 は 見ず に `xxx_feature( ... )` を 拾って 解釈 する。
// こう して おく と 両形式 を 1 本 の コード で 扱える。
//
// 出力 は DXF ビューア と 同じ DxfDocument。 描画 は そのまま 使い回す。
//
// 対応 フィーチャ: line / polyline / circle / arc / ellipse / text_string /
//   point_marker (点は 小さな 円)。 複合図形 (sfig) や スプライン は 未対応で、
//   その ぶん は 無視 する (読み込み 自体 は 失敗 させない)。

import type { DxfDocument, DxfShape, DxfLayerInfo } from '@/lib/dxfRender'

/** SXF の 既定色 (色番号 1..16)。 17 以降 は color_feature (ユーザ定義) */
const SXF_COLORS: string[] = [
  '#000000', // 1 黒 (画面では 黒。 用紙上は 白地 の 前提)
  '#ff0000', // 2 赤
  '#00ff00', // 3 緑
  '#0000ff', // 4 青
  '#ffff00', // 5 黄
  '#ff00ff', // 6 マゼンタ
  '#00ffff', // 7 シアン
  '#ffffff', // 8 白
  '#800000', // 9 茶
  '#ff8000', // 10 橙
  '#99ff99', // 11 明るい緑
  '#008000', // 12 深緑
  '#0080ff', // 13 空色
  '#000080', // 14 紺
  '#8000ff', // 15 紫
  '#808080', // 16 灰
]

/** 1 つ の フィーチャ */
interface Feature {
  name: string
  args: string[]
}

/**
 * `name_feature(...)` を 全部 拾う。
 * 文字列 (シングルクォート) の 中 の 括弧 / カンマ は 区切り に しない。
 */
function scanFeatures(text: string): Feature[] {
  const out: Feature[] = []
  // P21 は 大文字 (LINE_FEATURE)、SFC は 小文字 の ことが 多い ので 無視 する
  const re = /([A-Za-z_][A-Za-z0-9_]*_feature)\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const name = m[1].toLowerCase()
    let i = re.lastIndex
    let depth = 1
    let inStr = false
    let cur = ''
    const args: string[] = []
    for (; i < text.length; i += 1) {
      const c = text[i]
      if (inStr) {
        if (c === "'") {
          // '' は エスケープ された シングルクォート
          if (text[i + 1] === "'") {
            cur += "'"
            i += 1
          } else {
            inStr = false
          }
        } else {
          cur += c
        }
        continue
      }
      if (c === "'") {
        inStr = true
        continue
      }
      if (c === '(') {
        depth += 1
        cur += c
        continue
      }
      if (c === ')') {
        depth -= 1
        if (depth === 0) {
          args.push(cur.trim())
          break
        }
        cur += c
        continue
      }
      if (c === ',' && depth === 1) {
        args.push(cur.trim())
        cur = ''
        continue
      }
      cur += c
    }
    out.push({ name, args })
    re.lastIndex = i + 1
  }
  return out
}

const num = (s: string | undefined): number => {
  if (s == null) return NaN
  // 1.0E+2 / 1. などの STEP 表記 も Number で 読める
  const v = Number(s.replace(/\s/g, ''))
  return Number.isFinite(v) ? v : NaN
}
const int = (s: string | undefined): number => {
  const v = Math.trunc(num(s))
  return Number.isFinite(v) ? v : 0
}
/** 括弧 で 囲まれた 数値の 並び 「(1.,2.,3.)」 を 配列 に */
const numList = (s: string | undefined): number[] => {
  if (!s) return []
  const body = s.replace(/^\s*\(/, '').replace(/\)\s*$/, '')
  if (body.trim() === '') return []
  return body.split(',').map((t) => num(t))
}

/**
 * SXF (SFC / P21) の テキスト を 読む。
 * 読めた 図形 が 0 でも 例外 に せず 空 の ドキュメント を 返す
 * (呼び側 で 「表示できる 図形 が ありません」 と 出す)。
 */
export function parseSxf(text: string): DxfDocument {
  const feats = scanFeatures(text)

  // レイヤ と ユーザ定義色 は 出現順 が そのまま 番号 (1 始まり)
  const layerNames: string[] = []
  const userColors: string[] = []
  for (const f of feats) {
    if (f.name === 'layer_feature') layerNames.push(f.args[0] ?? '')
    else if (f.name === 'color_feature') {
      const r = int(f.args[0])
      const g = int(f.args[1])
      const b = int(f.args[2])
      const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
      userColors.push(`#${hex(r)}${hex(g)}${hex(b)}`)
    }
  }
  const layerOf = (code: number): string => layerNames[code - 1] ?? String(code || 0)
  const colorOf = (code: number): string => {
    if (code >= 1 && code <= SXF_COLORS.length) return SXF_COLORS[code - 1]
    const u = userColors[code - SXF_COLORS.length - 1]
    return u ?? '#000000'
  }

  const shapes: DxfShape[] = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const seen = new Set<string>()
  const bump = (x: number, y: number) => {
    if (Number.isFinite(x)) { if (x < minX) minX = x; if (x > maxX) maxX = x }
    if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  }

  for (const f of feats) {
    const a = f.args
    switch (f.name) {
      case 'line_feature': {
        // (layer, color, type, line_width, start_x, start_y, end_x, end_y)
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const x1 = num(a[4]), y1 = num(a[5]), x2 = num(a[6]), y2 = num(a[7])
        if (![x1, y1, x2, y2].every(Number.isFinite)) break
        seen.add(layer)
        shapes.push({ kind: 'line', layer, color, x1, y1, x2, y2 })
        bump(x1, y1); bump(x2, y2)
        break
      }
      case 'polyline_feature': {
        // (layer, color, type, line_width, number, (x...), (y...))
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const xs = numList(a[5])
        const ys = numList(a[6])
        const n = Math.min(xs.length, ys.length)
        if (n < 2) break
        const pts: { x: number; y: number }[] = []
        for (let i = 0; i < n; i += 1) {
          if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue
          pts.push({ x: xs[i], y: ys[i] })
          bump(xs[i], ys[i])
        }
        if (pts.length < 2) break
        seen.add(layer)
        shapes.push({ kind: 'polyline', layer, color, closed: false, pts })
        break
      }
      case 'circle_feature': {
        // (layer, color, type, line_width, center_x, center_y, radius)
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const cx = num(a[4]), cy = num(a[5]), r = num(a[6])
        if (![cx, cy, r].every(Number.isFinite)) break
        seen.add(layer)
        shapes.push({ kind: 'circle', layer, color, cx, cy, r })
        bump(cx - r, cy - r); bump(cx + r, cy + r)
        break
      }
      case 'arc_feature': {
        // (layer, color, type, line_width, center_x, center_y, radius,
        //  direction, start_angle, end_angle)  角度 は 度
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const cx = num(a[4]), cy = num(a[5]), r = num(a[6])
        const ccw = int(a[7]) !== 0
        let s = num(a[8])
        let e = num(a[9])
        if (![cx, cy, r, s, e].every(Number.isFinite)) break
        // ビューア は 反時計回り (start → end) 前提 な ので 向き を 揃える
        if (!ccw) { const t = s; s = e; e = t }
        seen.add(layer)
        shapes.push({ kind: 'arc', layer, color, cx, cy, r, startDeg: s, endDeg: e })
        bump(cx - r, cy - r); bump(cx + r, cy + r)
        break
      }
      case 'ellipse_feature': {
        // 楕円 は 円 で 近似 (長半径)。 表示用 なので これで 足りる
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const cx = num(a[4]), cy = num(a[5])
        const rx = num(a[6]), ry = num(a[7])
        const r = Math.max(rx, ry)
        if (![cx, cy, r].every(Number.isFinite)) break
        seen.add(layer)
        shapes.push({ kind: 'circle', layer, color, cx, cy, r })
        bump(cx - r, cy - r); bump(cx + r, cy + r)
        break
      }
      case 'point_marker_feature': {
        // (layer, color, marker_code, x, y, rotate_angle, scale)
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const x = num(a[3]), y = num(a[4])
        if (![x, y].every(Number.isFinite)) break
        seen.add(layer)
        shapes.push({ kind: 'circle', layer, color, cx: x, cy: y, r: 0.5 })
        bump(x, y)
        break
      }
      case 'text_string_feature': {
        // (layer, color, font, str, text_x, text_y, height, width, spc,
        //  angle, slant, b_pnt_h, b_pnt_v, direct)
        const layer = layerOf(int(a[0]))
        const color = colorOf(int(a[1]))
        const str = a[3] ?? ''
        const x = num(a[4]), y = num(a[5])
        const h = num(a[6])
        const angle = num(a[9])
        if (!str || ![x, y].every(Number.isFinite)) break
        const bh = int(a[11]) // 1=左 2=中 3=右
        const bv = int(a[12]) // 1=下 2=中 3=上
        seen.add(layer)
        shapes.push({
          kind: 'text',
          layer,
          color,
          x,
          y,
          height: Number.isFinite(h) && h > 0 ? h : 2.5,
          text: str,
          rotationDeg: Number.isFinite(angle) ? angle : 0,
          anchor: bh === 3 ? 'end' : bh === 2 ? 'middle' : 'start',
          baseline: bv === 3 ? 'hanging' : bv === 2 ? 'middle' : 'alphabetic',
        })
        bump(x, y)
        break
      }
      default:
        break
    }
  }

  const layers: DxfLayerInfo[] = layerNames
    .filter((n) => n !== '')
    .map((name) => ({ name, color: '#000000', visible: true }))
  for (const name of seen) {
    if (!layers.some((l) => l.name === name)) {
      layers.push({ name, color: '#000000', visible: true })
    }
  }
  layers.sort((a, b) => a.name.localeCompare(b.name))

  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100 }
  return { bounds: { minX, minY, maxX, maxY }, layers, shapes }
}
