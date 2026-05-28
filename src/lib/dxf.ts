// 最小限の DXF(R2000/AC1015) 書き出し。POINT / LINE / CIRCLE / ARC / TEXT に対応。
// 入力は CAD 慣例の DXF座標系 (X=東, Y=北) で受け取り、そのまま出力する。

export type DxfEntity =
  | { type: 'POINT'; x: number; y: number; layer?: string }
  | { type: 'LINE'; x1: number; y1: number; x2: number; y2: number; layer?: string }
  | { type: 'CIRCLE'; cx: number; cy: number; r: number; layer?: string }
  | {
      type: 'ARC'
      cx: number
      cy: number
      r: number
      startAngleDeg: number
      endAngleDeg: number
      layer?: string
    }
  | { type: 'TEXT'; x: number; y: number; text: string; height?: number; layer?: string }

function header(out: string[]) {
  // AC1015 = AutoCAD 2000 形式（広く互換性あり）
  out.push('0', 'SECTION', '2', 'HEADER')
  out.push('9', '$ACADVER', '1', 'AC1015')
  out.push('0', 'ENDSEC')
}

function entitiesStart(out: string[]) {
  out.push('0', 'SECTION', '2', 'ENTITIES')
}
function entitiesEnd(out: string[]) {
  out.push('0', 'ENDSEC')
  out.push('0', 'EOF')
}

function pushCommon(out: string[], layer: string) {
  out.push('8', layer) // レイヤ
}

export function buildDxf(entities: DxfEntity[]): string {
  const out: string[] = []
  header(out)
  entitiesStart(out)

  for (const e of entities) {
    const layer = e.layer ?? '0'
    switch (e.type) {
      case 'POINT':
        out.push('0', 'POINT')
        pushCommon(out, layer)
        out.push('10', String(e.x), '20', String(e.y), '30', '0')
        break
      case 'LINE':
        out.push('0', 'LINE')
        pushCommon(out, layer)
        out.push('10', String(e.x1), '20', String(e.y1), '30', '0')
        out.push('11', String(e.x2), '21', String(e.y2), '31', '0')
        break
      case 'CIRCLE':
        out.push('0', 'CIRCLE')
        pushCommon(out, layer)
        out.push('10', String(e.cx), '20', String(e.cy), '30', '0', '40', String(e.r))
        break
      case 'ARC':
        out.push('0', 'ARC')
        pushCommon(out, layer)
        out.push('10', String(e.cx), '20', String(e.cy), '30', '0', '40', String(e.r))
        out.push('50', String(e.startAngleDeg), '51', String(e.endAngleDeg))
        break
      case 'TEXT':
        out.push('0', 'TEXT')
        pushCommon(out, layer)
        out.push('10', String(e.x), '20', String(e.y), '30', '0', '40', String(e.height ?? 0.5))
        out.push('1', e.text)
        break
    }
  }

  entitiesEnd(out)
  return out.join('\n')
}

export function downloadDxf(text: string, filename: string): void {
  // 多くのCADがUTF-8(BOM付き)を受け付ける。Shift-JISが要る環境では適宜変換すること
  const blob = new Blob(['﻿' + text], { type: 'application/dxf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.dxf') ? filename : `${filename}.dxf`
  a.click()
  URL.revokeObjectURL(url)
}
