// 測定結果一覧表 Excel テンプレート出力
// 測定結果一覧表様式.xlsx（public/ 配下）を読み込み、
// 各管路の情報（配線番号・管種・管径・延長・C/B/A の地盤高・切深）を埋めて返す。

import ExcelJS from 'exceljs'
import { PIPE_TYPE_NAMES, type PipeRow } from '@/stores/underdrainStore'
import type { PlanGroup, PlanPoint } from '@/stores/constructionPlanStore'
import { comparePipeNumbers } from './pipeSort'

export interface MeasurementHeader {
  farmNumber: string // 圃場番号 → B3
  area: string // 面積 → F3
  beneficiary: string // 受益者名 → J3
  /** 配線間隔（m）。各管路の D{j} セルに書き込む。10 または 12 を想定 */
  spacing: number | null
}

interface PointData {
  groundHeight: number | null
  cutDepth: number | null
}

// 配管ID × 頂点インデックス → PlanPoint のルックアップを構築
function buildPlanLookup(
  planGroups: PlanGroup[],
  pipes: PipeRow[],
): Map<string, Map<number, PlanPoint>> {
  const map = new Map<string, Map<number, PlanPoint>>()
  const EPS = 1e-4
  for (const group of planGroups) {
    for (const row of group.rows) {
      // 吸水管: 順に対応
      if (row.absorptionPipeId) {
        const pipe = pipes.find((p) => p.id === row.absorptionPipeId)
        if (pipe) {
          const inner = map.get(row.absorptionPipeId) ?? new Map<number, PlanPoint>()
          const limit = Math.min(row.absorptionPoints.length, pipe.vertices.length)
          for (let i = 0; i < limit; i++) {
            inner.set(i, row.absorptionPoints[i])
          }
          map.set(row.absorptionPipeId, inner)
        }
      }
      // 集水管: 座標マッチで頂点を検出
      if (row.collectorPipeId && row.collectorPoint) {
        const pipe = pipes.find((p) => p.id === row.collectorPipeId)
        if (pipe) {
          const inner = map.get(row.collectorPipeId) ?? new Map<number, PlanPoint>()
          for (let i = 0; i < pipe.vertices.length; i++) {
            const v = pipe.vertices[i]
            if (
              Math.abs(v.x - row.collectorPoint.x) < EPS &&
              Math.abs(v.y - row.collectorPoint.y) < EPS
            ) {
              inner.set(i, row.collectorPoint)
              break
            }
          }
          map.set(row.collectorPipeId, inner)
        }
      }
    }
  }
  return map
}

function pointFromPlan(pp: PlanPoint | undefined | null): PointData {
  if (!pp) return { groundHeight: null, cutDepth: null }
  return {
    groundHeight: pp.groundHeight ?? null,
    cutDepth: pp.cutDepth ?? null,
  }
}

// 測定結果一覧表 Excel 生成
export async function exportMeasurementResult({
  pipes,
  planGroups,
  header,
  farmName,
}: {
  pipes: PipeRow[]
  planGroups: PlanGroup[]
  header: MeasurementHeader
  farmName?: string
}): Promise<void> {
  const response = await fetch('/測定結果一覧表様式.xlsx')
  if (!response.ok) throw new Error('測定結果一覧表様式.xlsx の読み込みに失敗しました')
  const arrayBuffer = await response.arrayBuffer()

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(arrayBuffer)

  const ws = workbook.worksheets[0]
  if (!ws) throw new Error('Excel シートが見つかりません')

  // ヘッダ
  ws.getCell('B3').value = header.farmNumber
  ws.getCell('F3').value = header.area
  ws.getCell('J3').value = header.beneficiary

  // 配管を数字でソート（頭文字・末尾文字を無視）
  const sortedPipes = [...pipes].sort((a, b) => comparePipeNumbers(a.number, b.number))

  // 施工計画ルックアップ
  const lookup = buildPlanLookup(planGroups, pipes)

  // 各管路を 4 行ブロックに書き込み
  // i1 = 3 から開始（旧マクロの配線表）、j = (i1-2)*4 + 7
  // i1=3 → j=11。以降 i1++ ごとに j が 4 ずつ増える。
  for (let idx = 0; idx < sortedPipes.length; idx++) {
    const pipe = sortedPipes[idx]
    const i1 = idx + 3
    const j = (i1 - 2) * 4 + 7

    const pipeLookup = lookup.get(pipe.id)
    const vLast = pipe.vertices.length - 1
    const cData = pointFromPlan(pipeLookup?.get(0))
    const aData = pointFromPlan(pipeLookup?.get(vLast))
    // 中間点は B として扱う（vertex 1 を採用、なければ null）
    const hasMiddle = pipe.vertices.length > 2
    const bData: PointData = hasMiddle
      ? pointFromPlan(pipeLookup?.get(Math.floor(pipe.vertices.length / 2)))
      : { groundHeight: null, cutDepth: null }

    // 落口判定: pipeType が 'outlet'
    const isOutlet = pipe.pipeType === 'outlet'

    // 管種ラベル
    const pipeTypeLabel = isOutlet
      ? '落口'
      : pipe.pipeType
        ? PIPE_TYPE_NAMES[pipe.pipeType]
        : ''

    // 書き込み
    ws.getCell(j, 1).value = pipe.number                                         // A{j}: 渠番号
    ws.getCell(j + 2, 1).value = pipe.diameter ?? null                           // A{j+2}: 管径
    ws.getCell(j + 3, 1).value = pipeTypeLabel                                   // A{j+3}: 管種
    // B{j}: 設計延長（CAD解析の「設計延長」を整数丸めで転記）
    ws.getCell(j, 2).value =
      pipe.designLength != null ? Math.round(pipe.designLength) : null
    // D{j}: 配線間隔（管種が「吸水」の場合のみ出力）
    if (header.spacing != null && pipe.pipeType === 'branch') {
      ws.getCell(j, 4).value = header.spacing
    }

    // 上流 C
    if (cData.groundHeight != null) {
      ws.getCell(j, 6).value = round(cData.groundHeight, 2)                     // F{j}: 地盤高
    }
    if (cData.cutDepth != null) {
      ws.getCell(j + 3, 8).value = round(cData.cutDepth, 3)                     // H{j+3}: 切深
    }

    // 中間 B
    if (bData.groundHeight != null) {
      ws.getCell(j, 11).value = round(bData.groundHeight, 2)                    // K{j}: 地盤高
    }
    if (bData.cutDepth != null) {
      ws.getCell(j + 3, 13).value = round(bData.cutDepth, 3)                    // M{j+3}: 切深
    }

    // 下流 A
    if (isOutlet) {
      // 落口: 管種セルに「落口」既に書き込み済み。
      // PtA(2)（旧マクロ）の相当値として、A の頂点 z（地盤高）があればそれを P{j+3} に転記。
      const aZ = pipe.vertices[vLast]?.z
      if (aZ != null) {
        ws.getCell(j + 3, 16).value = round(aZ, 2)                              // P{j+3}
      }
    } else {
      if (aData.groundHeight != null) {
        ws.getCell(j, 16).value = round(aData.groundHeight, 2)                  // P{j}: 地盤高
      }
      if (aData.cutDepth != null) {
        ws.getCell(j + 3, 18).value = round(aData.cutDepth, 3)                  // R{j+3}: 切深
      }
    }
  }

  // ダウンロード
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer as unknown as BlobPart], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `測定結果一覧表_${farmName ?? 'farm'}.xlsx`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function round(v: number, digits: number): number {
  const k = Math.pow(10, digits)
  return Math.round(v * k) / k
}
