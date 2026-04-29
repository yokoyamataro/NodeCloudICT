// 帯置計画の DXF 出力
// 座標系：入力は XY 平面直角座標（x=北, y=東）。
// DXF は標準的な CAD 慣習（X=東, Y=北）に合わせて軸を入れ替えて出力する。

import Encoding from 'encoding-japanese'
import { bufferPolyline, polylineLength, polylineMidpoint, truckDividers, type XY } from './stripPlanGeometry'

export interface StripPlanLine {
  vertices: XY[]
  number: number
  length: number // m（参考表示用）
  trucks: number
}

export interface StripPlanDxfOptions {
  areaPolygonXY: XY[]
  strips: StripPlanLine[]
  halfWidth: number // m
  lengthPerTruck?: number // v/CA (m)。指定時は台数分割線を出力
  farmName?: string
}

class DxfBuilder {
  private entities: string[] = []
  private layers = new Set<string>()

  addLayer(name: string, color = 7) {
    this.layers.add(`${name}|${color}`)
  }

  line(layer: string, x1: number, y1: number, x2: number, y2: number) {
    this.push('0', 'LINE')
    this.push('8', layer)
    this.push('10', x1)
    this.push('20', y1)
    this.push('30', 0)
    this.push('11', x2)
    this.push('21', y2)
    this.push('31', 0)
  }

  circle(layer: string, x: number, y: number, r: number) {
    this.push('0', 'CIRCLE')
    this.push('8', layer)
    this.push('10', x)
    this.push('20', y)
    this.push('30', 0)
    this.push('40', r)
  }

  text(
    layer: string,
    x: number,
    y: number,
    height: number,
    text: string,
    hAlign = 0,
    rotation = 0,
  ) {
    this.push('0', 'TEXT')
    this.push('8', layer)
    this.push('10', x)
    this.push('20', y)
    this.push('30', 0)
    this.push('40', height)
    this.push('1', text)
    if (rotation !== 0) {
      this.push('50', rotation)
    }
    if (hAlign !== 0) {
      this.push('72', hAlign)
      this.push('11', x)
      this.push('21', y)
      this.push('31', 0)
    }
  }

  build(): string {
    const out: string[] = []
    out.push('0', 'SECTION', '2', 'HEADER')
    out.push('9', '$ACADVER', '1', 'AC1009')
    out.push('9', '$INSUNITS', '70', '6') // 6 = meters
    out.push('0', 'ENDSEC')

    out.push('0', 'SECTION', '2', 'TABLES')
    out.push('0', 'TABLE', '2', 'LAYER', '70', String(this.layers.size))
    for (const layer of this.layers) {
      const [name, color] = layer.split('|')
      out.push('0', 'LAYER')
      out.push('2', name)
      out.push('70', '0')
      out.push('62', color)
      out.push('6', 'CONTINUOUS')
    }
    out.push('0', 'ENDTAB')
    out.push('0', 'ENDSEC')

    out.push('0', 'SECTION', '2', 'ENTITIES')
    out.push(...this.entities)
    out.push('0', 'ENDSEC')

    out.push('0', 'EOF')
    return out.join('\r\n') + '\r\n'
  }

  private push(...pairs: (string | number)[]) {
    for (const p of pairs) this.entities.push(String(p))
  }
}

function toShiftJIS(text: string): Uint8Array {
  const unicodeArray = Encoding.stringToCode(text)
  const sjisArray = Encoding.convert(unicodeArray, { to: 'SJIS', from: 'UNICODE' })
  return new Uint8Array(sjisArray)
}

function downloadDxf(content: string, filename: string): void {
  const sjis = toShiftJIS(content)
  const blob = new Blob([sjis.slice().buffer], { type: 'application/dxf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// 入力の XY (x=北, y=東) を DXF (X=東, Y=北) に変換
const tx = (p: XY): { x: number; y: number } => ({ x: p.y, y: p.x })

// 中点と DXF 用回転角（度、CCW、X 軸 = 東 を基準）
function midAndDxfAngle(line: XY[]): { mid: XY; angleDeg: number } | null {
  if (line.length < 2) return null
  const total = polylineLength(line)
  if (total < 1e-9) return null
  const target = total / 2
  let acc = 0
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]
    const b = line[i]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const segLen = Math.hypot(dx, dy)
    if (acc + segLen >= target) {
      const t = segLen > 0 ? (target - acc) / segLen : 0
      const mid = { x: a.x + dx * t, y: a.y + dy * t }
      // DXF 角度: x_dxf = y, y_dxf = x → 方向 (dy, dx) → atan2(dx, dy)
      let angleDeg = (Math.atan2(dx, dy) * 180) / Math.PI
      // テキスト上下逆を防ぐ
      while (angleDeg > 90) angleDeg -= 180
      while (angleDeg < -90) angleDeg += 180
      return { mid, angleDeg }
    }
    acc += segLen
  }
  const last = line[line.length - 1]
  return { mid: last, angleDeg: 0 }
}

export function exportStripPlanDxf(opts: StripPlanDxfOptions): void {
  const b = new DxfBuilder()
  b.addLayer('AREA', 8) // 区域：グレー
  b.addLayer('CENTERLINE', 5) // 中心線：青
  b.addLayer('BUFFER', 4) // 帯ポリゴン：シアン
  b.addLayer('DIVIDER', 6) // 台数分割線：マゼンタ
  b.addLayer('NUMBER', 1) // 番号：赤
  b.addLayer('DETAIL', 7) // 詳細テキスト：黒/白

  // 区域ポリゴン
  if (opts.areaPolygonXY.length >= 3) {
    for (let i = 0; i < opts.areaPolygonXY.length; i++) {
      const a = tx(opts.areaPolygonXY[i])
      const c = tx(opts.areaPolygonXY[(i + 1) % opts.areaPolygonXY.length])
      b.line('AREA', a.x, a.y, c.x, c.y)
    }
  }

  // 帯
  const numberRadius = Math.max(0.6, opts.halfWidth * 0.5)
  const detailHeight = Math.max(0.6, opts.halfWidth * 0.4)
  for (const strip of opts.strips) {
    // 中心線
    for (let i = 1; i < strip.vertices.length; i++) {
      const a = tx(strip.vertices[i - 1])
      const c = tx(strip.vertices[i])
      b.line('CENTERLINE', a.x, a.y, c.x, c.y)
    }
    // 帯ポリゴン
    const buf = bufferPolyline(strip.vertices, opts.halfWidth)
    if (buf) {
      for (let i = 0; i < buf.length; i++) {
        const a = tx(buf[i])
        const c = tx(buf[(i + 1) % buf.length])
        b.line('BUFFER', a.x, a.y, c.x, c.y)
      }
    }
    // 台数分割線
    if (opts.lengthPerTruck && opts.lengthPerTruck > 0) {
      const divs = truckDividers(strip.vertices, opts.lengthPerTruck, opts.halfWidth)
      for (const [s, e] of divs) {
        const ts = tx(s)
        const te = tx(e)
        b.line('DIVIDER', ts.x, ts.y, te.x, te.y)
      }
    }
    // 番号と詳細
    const ma = midAndDxfAngle(strip.vertices)
    if (ma) {
      const m = tx(ma.mid)
      b.circle('NUMBER', m.x, m.y, numberRadius)
      // 番号テキスト：円の中央
      b.text('NUMBER', m.x, m.y - detailHeight / 2, detailHeight, String(strip.number), 1)
      // 詳細：中点から少し離れた位置に、帯と平行に回転表示
      const sin = Math.sin((ma.angleDeg * Math.PI) / 180)
      const cos = Math.cos((ma.angleDeg * Math.PI) / 180)
      const off = numberRadius + detailHeight + 0.3
      // perpendicular offset: 帯方向に対して垂直（DXF: 帯方向(cos, sin) → 垂直(-sin, cos)）
      const ox = m.x - sin * off
      const oy = m.y + cos * off
      b.text(
        'DETAIL',
        ox,
        oy,
        detailHeight,
        `${strip.length.toFixed(1)}m / ${strip.trucks.toFixed(1)}台`,
        1,
        ma.angleDeg,
      )
    }
  }

  // ファイル名
  const safeName = (opts.farmName ?? 'farm').replace(/[\\/:*?"<>|]/g, '_')
  downloadDxf(b.build(), `${safeName}_帯置計画.dxf`)
}

// 折れ線中点ヘルパー（旧式互換用に再エクスポート）
export const _polylineMidpoint = polylineMidpoint
