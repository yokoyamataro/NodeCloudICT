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
  pipeDiameterById?: Map<string, number>
  allPlanGroups?: PlanGroup[]
  farmName?: string
}

interface SectionPoint {
  distance: number // m
  groundHeight: number | null
  plannedHeight: number | null
  cutDepth: number | null
  pointName: string
  absorptionPipeNumber: string | null
  absorptionPlannedHeight: number | null
  collectorPipeId: string | null
  collectorPipeNumber: string | null
  collectorPipeDiameter: number | null
  isCollectorMidpoint: boolean
}

const HORIZONTAL_SCALE = 1000

// systemIndex はグループ（集水暗渠1, 2, ...）ごとにローカル連番なので、
// 合流元の行と同じグループ (groupType, groupIndex) 内のみで合流先系統を検索する。
function resolveMergeTargetPipeNumber(
  sourceRow: PlanRow,
  allPlanGroups: PlanGroup[] | undefined,
  pipeNumberById: Map<string, string> | undefined,
): string | null {
  if (!allPlanGroups || !pipeNumberById) return null
  if (sourceRow.mergeSystemIndex == null) return null
  const g = allPlanGroups.find(
    (grp) =>
      grp.groupType === sourceRow.groupType &&
      grp.groupIndex === sourceRow.groupIndex,
  )
  if (!g) return null
  const targetRows = g.rows.filter(
    (r) =>
      r.systemIndex === sourceRow.mergeSystemIndex &&
      r.mergeSystemIndex == null,
  )
  for (let i = targetRows.length - 1; i >= 0; i--) {
    const tr = targetRows[i]
    if (tr.collectorPipeId) {
      return pipeNumberById.get(tr.collectorPipeId) ?? null
    }
  }
  return null
}

function buildSectionData(
  systemRows: PlanRow[],
  pipeNumberById: Map<string, string> | undefined,
  pipeDiameterById: Map<string, number> | undefined,
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
        row,
        allPlanGroups,
        pipeNumberById,
      )
    }

    const collectorPipeNumber = row.collectorPipeId
      ? pipeNumberById?.get(row.collectorPipeId) ?? null
      : null
    const collectorPipeDiameter = row.collectorPipeId
      ? pipeDiameterById?.get(row.collectorPipeId) ?? null
      : null

    // 中間点：吸水合流ではなく集水管の中間頂点（B1, B2 など）
    const isCollectorMidpoint =
      row.wiringRowType === 'collector_change' && !flagPipeNumber

    points.push({
      distance: cumulativeDistance,
      groundHeight: row.collectorPoint.groundHeight,
      plannedHeight: row.collectorPoint.plannedHeight,
      cutDepth: row.collectorPoint.cutDepth,
      pointName: row.collectorPoint.pointName,
      absorptionPipeNumber: flagPipeNumber,
      absorptionPlannedHeight: absorptionDownstreamHeight,
      collectorPipeId: row.collectorPipeId,
      collectorPipeNumber,
      collectorPipeDiameter,
      isCollectorMidpoint,
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

// ひとつの系統のタイルを DxfBuilder に描画し、使用した縦方向サイズ (mm) を返す
// yBase: タイル下端の Y 座標（mm）
interface DrawTileResult {
  totalHeight: number // mm（このタイルが使用した縦方向サイズ）
}

function drawSystemTile(
  b: DxfBuilder,
  sectionData: SectionPoint[],
  systemIndex: number,
  endType: 'outlet' | 'merge' | null,
  yBase: number,
  verticalScale: number,
): DrawTileResult {
  const hFactor = 1000 / HORIZONTAL_SCALE
  const vFactor = 1000 / verticalScale

  const heights = sectionData
    .flatMap((p) => [p.groundHeight, p.plannedHeight, p.absorptionPlannedHeight])
    .filter((h): h is number => h !== null)
  if (heights.length === 0) {
    return { totalHeight: 0 }
  }
  const rawMin = Math.min(...heights)
  const rawMax = Math.max(...heights)
  const minH = Math.floor(rawMin - 0.5)
  const maxH = Math.ceil(rawMax + 0.5)

  // タイルレイアウト:
  //  [yBase + 0]                                  タイル下端
  //  [yBase + bandSpace ~]                        集水番号帯（管径付き）
  //  [yBase + labelsSpace] = bandTop              数値ラベル（4行 × 10mm）下端
  //  [yBase + marginBottom] = bottomEdge          チャート下端
  // 数値ラベルは上から「地盤高 / 計画高 / 切深 / 累加距離」（各 10mm 間隔・縦書き）
  const ROW_INTERVAL = 10
  const numericRowsCount = 4
  const numericRowsHeight = ROW_INTERVAL * numericRowsCount // 40
  const pointNameHeight = 5 // 測点名（横書き）
  const gapAboveBand = 1
  const bandSpace = 10 // 集水番号帯
  const labelsSpace = numericRowsHeight + pointNameHeight + gapAboveBand // 46
  const marginBottom = labelsSpace + bandSpace + 4 // 下側総余白 = 60
  const flagSpace = 14 // 吸水旗上げ
  const titleSpace = 10 // タイトル
  const topPadding = 6

  const marginLeft = 40
  const leftEdge = marginLeft
  const bottomEdge = yBase + marginBottom

  // 数値ラベル行の中心 Y 位置（上から下へ）
  const ROW_GROUND_Y = bottomEdge - ROW_INTERVAL * 0.5 // 地盤高
  const ROW_PLAN_Y = bottomEdge - ROW_INTERVAL * 1.5 // 計画高
  const ROW_CUT_Y = bottomEdge - ROW_INTERVAL * 2.5 // 切深
  const ROW_DIST_Y = bottomEdge - ROW_INTERVAL * 3.5 // 累加距離
  const POINT_NAME_Y = bottomEdge - numericRowsHeight - pointNameHeight + 1.5 // 測点名（横書き）

  const xP = (distM: number) => leftEdge + distM * hFactor
  const yP = (elevM: number) => bottomEdge + (elevM - minH) * vFactor

  const maxDist = sectionData[sectionData.length - 1].distance
  const chartWidth = maxDist * hFactor
  const chartHeight = (maxH - minH) * vFactor

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
    if (p.groundHeight !== null) b.circle('GROUND', px, yP(p.groundHeight), 0.6)
    if (p.plannedHeight !== null) b.circle('PLANNED', px, yP(p.plannedHeight), 0.6)
    if (p.absorptionPlannedHeight !== null)
      b.circle('FLAG', px, yP(p.absorptionPlannedHeight), 0.6)
  }

  // 左端の見出し列：地盤高 / 計画高 / 切深 / 累加距離（横書き、右寄せ）
  const HEADER_X = leftEdge - 2
  b.text('TEXT_HEIGHT', HEADER_X, ROW_GROUND_Y - 1, 2.5, '地盤高', 2)
  b.text('TEXT_HEIGHT', HEADER_X, ROW_PLAN_Y - 1, 2.5, '計画高', 2)
  b.text('TEXT_HEIGHT', HEADER_X, ROW_CUT_Y - 1, 2.5, '切深', 2)
  b.text('TEXT_HEIGHT', HEADER_X, ROW_DIST_Y - 1, 2.5, '累加距離', 2)

  // 各点の数値ラベル：上から 地盤高 / 計画高 / 切深 / 累加距離（縦書き、行間 10mm）
  // 行内訳：上 1mm 縦線セグメント + 8mm 数値領域 + 1mm 縦線セグメント
  for (const p of sectionData) {
    const px = xP(p.distance)
    b.line('AXIS', px, bottomEdge - 2, px, bottomEdge)
    if (p.groundHeight !== null) {
      b.text('TEXT_HEIGHT', px, ROW_GROUND_Y, 2, p.groundHeight.toFixed(3), 1, 90)
    }
    if (p.plannedHeight !== null) {
      b.text('TEXT_HEIGHT', px, ROW_PLAN_Y, 2, p.plannedHeight.toFixed(3), 1, 90)
    }
    if (p.cutDepth !== null) {
      b.text('TEXT_HEIGHT', px, ROW_CUT_Y, 2, p.cutDepth.toFixed(3), 1, 90)
    }
    b.text('TEXT_HEIGHT', px, ROW_DIST_Y, 2, p.distance.toFixed(2), 1, 90)
    b.text('TEXT_POINT', px, POINT_NAME_Y, 2.5, p.pointName, 1)
  }

  // 緑の旗上げ位置（吸水合流 + 集水中間点）には数値軸に縦線を描画
  // 各行 10mm の上下 1mm に短いセグメントを描画し、中央 8mm（数値領域）は空ける
  for (const p of sectionData) {
    const hasFlag = !!p.absorptionPipeNumber || p.isCollectorMidpoint
    if (!hasFlag) continue
    const px = xP(p.distance)
    for (let r = 0; r < numericRowsCount; r++) {
      const rowTopY = bottomEdge - r * ROW_INTERVAL
      const rowBotY = bottomEdge - (r + 1) * ROW_INTERVAL
      b.line('FLAG', px, rowTopY, px, rowTopY - 1)
      b.line('FLAG', px, rowBotY + 1, px, rowBotY)
    }
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
    const slopeText = diff === 0 ? '水平' : `1/${Math.round(Math.abs(dist / diff))}`
    b.text('SLOPE', midX, midY + 3, 2.5, slopeText, 1)
    b.text('SLOPE', midX, midY, 1.8, `(${dist.toFixed(1)})`, 1)
  }

  // 旗上げ（上部）：吸水合流＝吸水管番号、集水中間点＝測点名
  const FLAG_HEIGHT_OFFSET = 6
  const FLAG_TOP_Y = bottomEdge + chartHeight + FLAG_HEIGHT_OFFSET
  for (const p of sectionData) {
    const px = xP(p.distance)
    if (p.absorptionPipeNumber) {
      const leaderEndY =
        p.absorptionPlannedHeight !== null
          ? yP(p.absorptionPlannedHeight)
          : p.plannedHeight !== null
            ? yP(p.plannedHeight)
            : bottomEdge
      b.line('FLAG', px, leaderEndY, px, FLAG_TOP_Y)
      b.text('FLAG', px, FLAG_TOP_Y + 2, 3, p.absorptionPipeNumber, 1)
    } else if (p.isCollectorMidpoint) {
      const leaderEndY = p.plannedHeight !== null ? yP(p.plannedHeight) : bottomEdge
      b.line('FLAG', px, leaderEndY, px, FLAG_TOP_Y)
      b.text('FLAG', px, FLAG_TOP_Y + 2, 3, p.pointName, 1)
    }
  }

  // 集水番号の帯
  const bandTop = bottomEdge - labelsSpace
  const bandHeight = bandSpace - 2
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
        b.line('AXIS', x1, bandTop, x2, bandTop)
        b.line('AXIS', x1, bandTop - bandHeight, x2, bandTop - bandHeight)
        b.line('AXIS', x1, bandTop, x1, bandTop - bandHeight)
        b.line('AXIS', x2, bandTop, x2, bandTop - bandHeight)
        const bandLabel =
          prev.collectorPipeDiameter !== null
            ? `${prev.collectorPipeNumber} φ${prev.collectorPipeDiameter}`
            : prev.collectorPipeNumber
        b.text('AXIS', (x1 + x2) / 2, bandTop - bandHeight / 2 - 1, 2.5, bandLabel, 1)
      }
      bandStart = i
    }
  }

  // タイトル
  const endLabel = endType === 'outlet' ? '（落口）' : endType === 'merge' ? '（合流）' : ''
  const title = `系統 ${systemIndex} 集水渠断面図${endLabel} (H=1/${HORIZONTAL_SCALE}, V=1/${verticalScale})`
  b.text('FRAME', leftEdge, bottomEdge + chartHeight + flagSpace + 2, 4, title)

  const totalHeight = marginBottom + chartHeight + flagSpace + titleSpace + topPadding
  return { totalHeight }
}

function registerLayers(b: DxfBuilder): void {
  b.addLayer('FRAME', 7)
  b.addLayer('GROUND', 1) // 赤
  b.addLayer('PLANNED', 5) // 青
  b.addLayer('AXIS', 8)
  b.addLayer('TEXT_POINT', 7)
  b.addLayer('TEXT_HEIGHT', 7)
  b.addLayer('SLOPE', 5)
  b.addLayer('FLAG', 3) // 緑
}

function downloadDxf(content: string, filename: string): void {
  const sjis = toShiftJIS(content)
  const buf = sjis.slice().buffer
  const blob = new Blob([buf], { type: 'application/dxf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// 単一系統の DXF 出力
export function exportCrossSectionDxf(opts: CrossSectionDxfOptions): void {
  const sectionData = buildSectionData(
    opts.systemRows,
    opts.pipeNumberById,
    opts.pipeDiameterById,
    opts.allPlanGroups,
  )

  if (sectionData.length === 0) {
    alert('集水点データがありません')
    return
  }

  const b = new DxfBuilder()
  registerLayers(b)
  drawSystemTile(b, sectionData, opts.systemIndex, opts.endType, 0, opts.verticalScale)

  downloadDxf(b.build(), `${opts.farmName ?? 'farm'}_縦断図_系統${opts.systemIndex}.dxf`)
}

// 複数系統の一括 DXF 出力（縦並び）
export interface MultipleExportOptions {
  systems: Array<{
    systemRows: PlanRow[]
    systemIndex: number
    endType: 'outlet' | 'merge' | null
    groupName?: string // 集水暗渠1 / 直落暗渠 など（タイトル補助）
  }>
  verticalScale: 100 | 200 | 500 | 1000
  pipeNumberById?: Map<string, string>
  pipeDiameterById?: Map<string, number>
  allPlanGroups?: PlanGroup[]
  farmName?: string
}

const TILE_GAP = 20 // 系統間の縦余白 (mm)

export function exportAllCrossSectionsDxf(opts: MultipleExportOptions): void {
  const b = new DxfBuilder()
  registerLayers(b)

  let yCurrent = 0
  let drawnCount = 0

  for (const sys of opts.systems) {
    const sectionData = buildSectionData(
      sys.systemRows,
      opts.pipeNumberById,
      opts.pipeDiameterById,
      opts.allPlanGroups,
    )
    if (sectionData.length === 0) continue
    const { totalHeight } = drawSystemTile(
      b,
      sectionData,
      sys.systemIndex,
      sys.endType,
      yCurrent,
      opts.verticalScale,
    )
    if (totalHeight > 0) {
      yCurrent += totalHeight + TILE_GAP
      drawnCount++
    }
  }

  if (drawnCount === 0) {
    alert('出力できる集水点データがありません')
    return
  }

  downloadDxf(b.build(), `${opts.farmName ?? 'farm'}_縦断図_全系統.dxf`)
}
