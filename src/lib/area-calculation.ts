/**
 * 面積計算ユーティリティ
 * 直角座標法（Coordinate Method / Shoelace Formula）による面積計算
 */

import type { AreaCalculationRow, AreaCalculationSheet } from '@/types/database'

export interface Point {
  id?: string
  pointNumber: string
  x: number
  y: number
}

/**
 * 直角座標法による面積計算
 *
 * 計算式:
 * 2S = Σ(Xi × Yi+1 - Xi+1 × Yi)
 * S = |2S| / 2
 *
 * @param points 座標点の配列（閉じた多角形、最後の点は最初の点と同じでなくてよい）
 * @returns 面積計算結果
 */
export function calculateAreaByCoordinateMethod(points: Point[]): {
  rows: AreaCalculationRow[]
  totalDoubleArea: number
  areaSqm: number
  areaHa: number
  perimeterM: number
} {
  if (points.length < 3) {
    return {
      rows: [],
      totalDoubleArea: 0,
      areaSqm: 0,
      areaHa: 0,
      perimeterM: 0,
    }
  }

  const rows: AreaCalculationRow[] = []
  let totalDoubleArea = 0
  let perimeter = 0

  for (let i = 0; i < points.length; i++) {
    const current = points[i]
    const next = points[(i + 1) % points.length]

    const xi = current.x
    const yi = current.y
    const xi1 = next.x
    const yi1 = next.y

    // Xi × Yi+1
    const xiYi1 = xi * yi1
    // Xi+1 × Yi
    const xi1Yi = xi1 * yi
    // 倍面積（符号付き）
    const doubleArea = xiYi1 - xi1Yi

    totalDoubleArea += doubleArea

    // 周長計算（辺の長さ）
    const dx = xi1 - xi
    const dy = yi1 - yi
    perimeter += Math.sqrt(dx * dx + dy * dy)

    rows.push({
      point_number: current.pointNumber,
      x: xi,
      y: yi,
      xi_yi1: xiYi1,
      xi1_yi: xi1Yi,
      double_area: doubleArea,
    })
  }

  // 面積は倍面積の絶対値の半分
  const areaSqm = Math.abs(totalDoubleArea) / 2

  return {
    rows,
    totalDoubleArea,
    areaSqm,
    areaHa: areaSqm / 10000, // m² → ha
    perimeterM: perimeter,
  }
}

/**
 * 面積計算簿を生成
 */
export function generateAreaCalculationSheet(
  zoneId: string,
  zoneNumber: string,
  zoneName: string,
  points: Point[]
): AreaCalculationSheet {
  const { rows, totalDoubleArea, areaSqm, areaHa, perimeterM } =
    calculateAreaByCoordinateMethod(points)

  return {
    zone_id: zoneId,
    zone_number: zoneNumber,
    zone_name: zoneName,
    rows,
    total_double_area: totalDoubleArea,
    area_sqm: areaSqm,
    area_ha: areaHa,
    perimeter_m: perimeterM,
    calculated_at: new Date().toISOString(),
  }
}

/**
 * 面積計算簿をCSV形式で出力
 */
export function exportAreaCalculationToCSV(sheet: AreaCalculationSheet): string {
  const header = [
    '面積計算簿',
    `区域番号: ${sheet.zone_number}`,
    `区域名: ${sheet.zone_name}`,
    `計算日時: ${new Date(sheet.calculated_at).toLocaleString('ja-JP')}`,
    '',
    '点番号,X座標(m),Y座標(m),Xi×Yi+1,Xi+1×Yi,倍面積',
  ].join('\n')

  const dataRows = sheet.rows.map(row =>
    [
      row.point_number,
      row.x.toFixed(3),
      row.y.toFixed(3),
      row.xi_yi1.toFixed(3),
      row.xi1_yi.toFixed(3),
      row.double_area.toFixed(3),
    ].join(',')
  ).join('\n')

  const summary = [
    '',
    `倍面積合計,,,,,${sheet.total_double_area.toFixed(3)}`,
    `面積(m²),${sheet.area_sqm.toFixed(3)},,,,`,
    `面積(ha),${sheet.area_ha.toFixed(6)},,,,`,
    `周長(m),${sheet.perimeter_m.toFixed(3)},,,,`,
  ].join('\n')

  return `${header}\n${dataRows}\n${summary}`
}

/**
 * 座標点の順序が時計回りかどうかを判定
 * @returns true = 時計回り, false = 反時計回り
 */
export function isClockwise(points: Point[]): boolean {
  const { totalDoubleArea } = calculateAreaByCoordinateMethod(points)
  // 倍面積が負なら時計回り（日本の平面直角座標系ではX=北、Y=東）
  return totalDoubleArea < 0
}

/**
 * 座標点の順序を反転
 */
export function reversePointOrder<T extends Point>(points: T[]): T[] {
  return [...points].reverse()
}

/**
 * 重心を計算
 */
export function calculateCentroid(points: Point[]): { x: number; y: number } {
  if (points.length === 0) {
    return { x: 0, y: 0 }
  }

  const sumX = points.reduce((sum, p) => sum + p.x, 0)
  const sumY = points.reduce((sum, p) => sum + p.y, 0)

  return {
    x: sumX / points.length,
    y: sumY / points.length,
  }
}
