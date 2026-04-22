// 縦断図の DXF エクスポート
// 横縮尺 1/1000 固定、縦縮尺は 1/100 ～ 1/1000 から選択。
// 用紙座標は mm 単位（1m 実距離 → 1mm 用紙 × 1000/縮尺）。

import type { PlanRow, PlanGroup } from '@/stores/constructionPlanStore'
import Encoding from 'encoding-japanese'

export interface CrossSectionDxfOptions {
  systemRows: PlanRow[]
  systemIndex: number
  endType: 'outlet' | 'merge' | null
  verticalScale: 100 | 200 | 500 | 1000
  pipeNumberById?: Map<string, string>
  allPlanGroups?: PlanGroup[]
  farmName?: string
}

interface SectionPoint {
  distance: number // m
  groundHeight: number | null
  plannedHeight: number | null
  pointName: string
  absorptionPipeNumber: string | null
  absorptionPlannedHeight: number | null
  collectorPipeId: string | null
  collectorPipeNumber: string | null
}

const HORIZONTAL_SCALE = 1000

function resolveMergeTargetPipeNumber(
  mergeSystemIndex: number,
  allPlanGroups: PlanGroup[] | undefined,
  pipeNumberById: Map<string, string> | undefined,
): string | null {
  if (!allPlanGroups || !pipeNumberById) return null
  for (const g of allPlanGroups) {
    const targetRows = g.rows.filter(
      (r) => r.systemIndex === mergeSystemIndex && r.mergeSystemIndex == null,
    )
    if (targetRows.length === 0) continue
    for (let i = targetRows.length - 1; i >= 0; i--) {
      const tr = targetRows[i]
      if (tr.collectorPipeId) {
        return pipeNumberById.get(tr.collectorPipeId) ?? null
      }
    }
    return null
  }
  return null
}

function buildSectionData(
  systemRows: PlanRow[],
  pipeNumberById: Map<string, string> | undefined,
  allPlanGroups: PlanGroup[] | undefined,
): SectionPoint[] {
  const points: SectionPoint[] = []
  let cumulativeDistance = 0

  for (let rowIdx = 0; rowIdx < systemRows.length; rowIdx++) {
    const row = systemRows[rowIdx]
    if (!row.collectorPoint) continue

    if (rowIdx > 0) {
      const prev = systemRows[rowIdx - 1]
      if (prev.collectorPoint?.segmentDistance != null) {
        cumulativeDistance += prev.collectorPoint.segmentDistance
      }
    }

    const absorptionDownstreamHeight =
      row.absorptionPoints.length > 0
        ? row.absorptionPoints[row.absorptionPoints.length - 1].plannedHeight
        : null

    let flagPipeNumber: string | null = null
    if (row.absorptionPipeId) {
      flagPipeNumber = row.pipeNumber
    } else if (row.mergeSystemIndex != null) {
      flagPipeNumber = resolveMergeTargetPipeNumber(
        row.mergeSystemIndex,
        allPlanGroups,
        pipeNumberById,
      )
    }

    const collectorPipeNumber = row.collectorPipeId
      ? pipeNumberById?.get(row.collectorPipeId) ?? null
      : null

    points.push({
      distance: cumulativeDistance,
      groundHeight: row.collectorPoint.groundHeight,
      plannedHeight: row.collectorPoint.plannedHeight,
      pointName: row.collectorPoint.pointName,
      absorptionPipeNumber: flagPipeNumber,
      absorptionPlannedHeight: absorptionDownstreamHeight,
      collectorPipeId: row.collectorPipeId,
      collectorPipeNumber,
    })
  }

  return points
}

// DXF ビルダ
class DxfBuilder {
  private entities: string[] = []
  private layers = new Set<string>()

  addLayer(name: string, color: number = 7) {
    // color は AutoCAD カラーインデックス (1=赤, 2=黄, 3=緑, 4=シアン, 5=青, 6=マゼンタ, 7=白/黒)
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

  text(layer: string, x: number, y: number, height: number, text: string, hAlign = 0) {
    this.push('0', 'TEXT')
    this.push('8', layer)
    this.push('10', x)
    this.push('20', y)
    this.push('30', 0)
    this.push('40', height)
    this.push('1', text)
    if (hAlign !== 0) {
      // 中央揃えの場合は 72 と 11 を使う
      this.push('72', hAlign)
      this.push('11', x)
      this.push('21', y)
      this.push('31', 0)
    }
  }

  build(): string {
    const out: string[] = []

    // HEADER
    out.push('0', 'SECTION', '2', 'HEADER')
    out.push('9', '$ACADVER', '1', 'AC1009')
    out.push('9', '$INSUNITS', '70', '4') // 4 = millimeters
    out.push('0', 'ENDSEC')

    // TABLES - レイヤー定義
    out.push('0', 'SECTION', '2', 'TABLES')
    out.push('0', 'TABLE', '2', 'LAYER', '70', String(this.layers.size))
    for (const layer of this.layers) {
      const [name, color] = layer.split('|')
      out.push('0', 'LAYER')
      out.push('2', name)
      out.push('70', '0') // flags
      out.push('62', color) // color
      out.push('6', 'CONTINUOUS') // linetype
    }
    out.push('0', 'ENDTAB')
    out.push('0', 'ENDSEC')

    // ENTITIES
    out.push('0', 'SECTION', '2', 'ENTITIES')
    out.push(...this.entities)
    out.push('0', 'ENDSEC')

    // EOF
    out.push('0', 'EOF')
    return out.join('\r\n') + '\r\n'
  }

  private push(...pairs: (string | number)[]) {
    for (const p of pairs) this.entities.push(String(p))
  }
}

function toShiftJIS(text: string): Uint8Array {
  const unicodeArray = Encoding.stringToCode(text)
  const sjisArray = Encoding.convert(unicodeArray, {
    to: 'SJIS',
    from: 'UNICODE',
  })
  return new Uint8Array(sjisArray)
}

export function exportCrossSectionDxf(opts: CrossSectionDxfOptions): void {
  const sectionData = buildSectionData(
    opts.systemRows,
    opts.pipeNumberById,
    opts.allPlanGroups,
  )

  if (sectionData.length === 0) {
    alert('集水点データがありません')
    return
  }

  const hFactor = 1000 / HORIZONTAL_SCALE // 1m → 1mm (1/1000)
  const vFactor = 1000 / opts.verticalScale // 1m → 10mm (1/100), 5mm (1/200), etc.

  // 最小・最大標高を計算（1m 刻みで切り上げ・切り下げ）
  const heights = sectionData
    .flatMap((p) => [p.groundHeight, p.plannedHeight, p.absorptionPlannedHeight])
    .filter((h): h is number => h !== null)
  if (heights.length === 0) {
    alert('標高データがありません')
    return
  }
  const rawMin = Math.min(...heights)
  const rawMax = Math.max(...heights)
  const minH = Math.floor(rawMin - 0.5)
  const maxH = Math.ceil(rawMax + 0.5)

  // マージン (mm)
  const marginLeft = 40
  const marginBottom = 60
  const leftEdge = marginLeft
  const bottomEdge = marginBottom

  const xP = (distM: number) => leftEdge + distM * hFactor
  const yP = (elevM: number) => bottomEdge + (elevM - minH) * vFactor

  const maxDist = sectionData[sectionData.length - 1].distance
  const chartWidth = maxDist * hFactor
  const chartHeight = (maxH - minH) * vFactor

  const b = new DxfBuilder()

  // レイヤー定義
  b.addLayer('FRAME', 7) // 白/黒
  b.addLayer('GROUND', 1) // 赤（現況線）
  b.addLayer('PLANNED', 5) // 青（計画線）
  b.addLayer('AXIS', 8) // グレー
  b.addLayer('TEXT_POINT', 7)
  b.addLayer('TEXT_HEIGHT', 7)
  b.addLayer('SLOPE', 5)
  b.addLayer('FLAG', 3) // 緑（吸水）

  // 枠
  b.line('FRAME', leftEdge, bottomEdge, leftEdge + chartWidth, bottomEdge)
  b.line('FRAME', leftEdge, bottomEdge + chartHeight, leftEdge + chartWidth, bottomEdge + chartHeight)
  b.line('FRAME', leftEdge, bottomEdge, leftEdge, bottomEdge + chartHeight)
  b.line('FRAME', leftEdge + chartWidth, bottomEdge, leftEdge + chartWidth, bottomEdge + chartHeight)

  // Y 軸目盛（1m ごと）
  for (let h = minH; h <= maxH; h++) {
    const py = yP(h)
    b.line('AXIS', leftEdge - 2, py, leftEdge, py)
    b.text('AXIS', leftEdge - 8, py - 1, 2.5, h.toFixed(2))
  }

  // 現況線 & 計画線
  for (let i = 1; i < sectionData.length; i++) {
    const p1 = sectionData[i - 1]
    const p2 = sectionData[i]
    if (p1.groundHeight !== null && p2.groundHeight !== null) {
      b.line('GROUND', xP(p1.distance), yP(p1.groundHeight), xP(p2.distance), yP(p2.groundHeight))
    }
    if (p1.plannedHeight !== null && p2.plannedHeight !== null) {
      b.line(
        'PLANNED',
        xP(p1.distance),
        yP(p1.plannedHeight),
        xP(p2.distance),
        yP(p2.plannedHeight),
      )
    }
  }

  // 点マーカー
  for (const p of sectionData) {
    const px = xP(p.distance)
    if (p.groundHeight !== null) {
      b.circle('GROUND', px, yP(p.groundHeight), 0.6)
    }
    if (p.plannedHeight !== null) {
      b.circle('PLANNED', px, yP(p.plannedHeight), 0.6)
    }
    if (p.absorptionPlannedHeight !== null) {
      b.circle('FLAG', px, yP(p.absorptionPlannedHeight), 0.6)
    }
  }

  // 垂直ガイド線 + 累加距離 + 測点名
  for (const p of sectionData) {
    const px = xP(p.distance)
    // 垂直線（軸下に少し伸ばす）
    b.line('AXIS', px, bottomEdge - 2, px, bottomEdge)
    // 累加距離 (mm単位のラベル位置)
    b.text('TEXT_HEIGHT', px, bottomEdge - 6, 2, `${p.distance.toFixed(2)}`, 1)
    // 測点名（さらに下）
    b.text('TEXT_POINT', px, bottomEdge - 12, 2.5, p.pointName, 1)
  }

  // 勾配ラベル
  for (let i = 1; i < sectionData.length; i++) {
    const p1 = sectionData[i - 1]
    const p2 = sectionData[i]
    if (p1.plannedHeight == null || p2.plannedHeight == null) continue
    const dist = p2.distance - p1.distance
    const diff = p1.plannedHeight - p2.plannedHeight
    if (dist <= 0) continue
    const midX = xP((p1.distance + p2.distance) / 2)
    const midY = (yP(p1.plannedHeight) + yP(p2.plannedHeight)) / 2
    const slopeText =
      diff === 0 ? '水平' : `1/${Math.round(Math.abs(dist / diff))}`
    b.text('SLOPE', midX, midY + 3, 2.5, slopeText, 1)
    b.text('SLOPE', midX, midY, 1.8, `(${dist.toFixed(1)})`, 1)
  }

  // 吸水旗上げ（上部）
  const FLAG_HEIGHT_OFFSET = 6
  const FLAG_TOP_Y = bottomEdge + chartHeight + FLAG_HEIGHT_OFFSET
  for (const p of sectionData) {
    if (!p.absorptionPipeNumber) continue
    const px = xP(p.distance)
    const leaderEndY =
      p.absorptionPlannedHeight !== null
        ? yP(p.absorptionPlannedHeight)
        : p.plannedHeight !== null
          ? yP(p.plannedHeight)
          : bottomEdge
    // リーダー線
    b.line('FLAG', px, leaderEndY, px, FLAG_TOP_Y)
    // 旗
    b.text('FLAG', px, FLAG_TOP_Y + 2, 3, p.absorptionPipeNumber, 1)
  }

  // 集水番号の帯（X軸下）
  const bandTop = bottomEdge - 18
  const bandHeight = 5
  let bandStart = 0
  for (let i = 1; i <= sectionData.length; i++) {
    const prev = sectionData[i - 1]
    const cur = i < sectionData.length ? sectionData[i] : null
    if (!cur || cur.collectorPipeId !== prev.collectorPipeId || !cur.collectorPipeNumber) {
      if (prev.collectorPipeNumber) {
        const nextStartDist =
          cur && cur.collectorPipeNumber ? cur.distance : sectionData[i - 1].distance
        const x1 = xP(sectionData[bandStart].distance)
        const x2 = xP(nextStartDist)
        // 矩形（4 本の線）
        b.line('AXIS', x1, bandTop, x2, bandTop)
        b.line('AXIS', x1, bandTop - bandHeight, x2, bandTop - bandHeight)
        b.line('AXIS', x1, bandTop, x1, bandTop - bandHeight)
        b.line('AXIS', x2, bandTop, x2, bandTop - bandHeight)
        b.text('AXIS', (x1 + x2) / 2, bandTop - bandHeight / 2 - 1, 2.5, prev.collectorPipeNumber, 1)
      }
      bandStart = i
    }
  }

  // タイトル
  const title = `系統 ${opts.systemIndex} 集水渠断面図 (H=1/${HORIZONTAL_SCALE}, V=1/${opts.verticalScale})`
  b.text('FRAME', leftEdge, bottomEdge + chartHeight + 30, 4, title)

  // 出力
  const content = b.build()
  const sjis = toShiftJIS(content)
  const buf = sjis.slice().buffer
  const blob = new Blob([buf], { type: 'application/dxf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${opts.farmName ?? 'farm'}_縦断図_系統${opts.systemIndex}.dxf`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
