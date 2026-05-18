// 測定結果一覧表 Excel テンプレート出力
// 測定結果一覧表様式.xlsx（public/ 配下）を読み込み、
// 各管路の情報（配線番号・管種・管径・延長・C/B/A の地盤高・切深）を埋めて返す。

import ExcelJS from 'exceljs'
import { PIPE_TYPE_NAMES, type PipeRow } from '@/stores/underdrainStore'
import type { PlanGroup, PlanRow, PlanPoint } from '@/stores/constructionPlanStore'
import { comparePipeNumbers } from './pipeSort'

export interface MeasurementHeader {
  farmNumber: string // 工区番号 → B3
  area: string // 面積 → F3
  beneficiary: string // 受益者名 → J3
  /** 配線間隔（m）。各管路の D{j} セルに書き込む。10 または 12 を想定 */
  spacing: number | null
}

interface PointData {
  groundHeight: number | null
  cutDepth: number | null
}

// 吸水管 ID → その吸水管の PlanRow を返す（最初に見つかった行を採用）
function findAbsorptionRow(planGroups: PlanGroup[], pipeId: string): PlanRow | null {
  for (const group of planGroups) {
    for (const row of group.rows) {
      if (row.absorptionPipeId === pipeId && row.absorptionPoints.length > 0) {
        return row
      }
    }
  }
  return null
}

// 全 PlanRow の collectorPoint を集める（pipeId で絞らない）。
// 中間集水管の A 点は「次の集水管の C 点」と同じ位置で、次の管側の行に
// 「{prev}A {curr}C」形式で保存されているため、collectorPipeId で絞ると拾えない。
// 測点名で C/B/A を判定するため、全体を一括収集する。
function collectAllCollectorPoints(planGroups: PlanGroup[]): PlanPoint[] {
  const points: PlanPoint[] = []
  for (const group of planGroups) {
    for (const row of group.rows) {
      if (row.collectorPoint) {
        points.push(row.collectorPoint)
      }
    }
  }
  return points
}

function pointFromPlan(pp: PlanPoint | undefined | null): PointData {
  if (!pp) return { groundHeight: null, cutDepth: null }
  const ground = pp.groundHeight ?? null
  let cutDepth = pp.cutDepth ?? null
  // 切深が未計算でも、地盤高と計画高があれば算出
  if (cutDepth == null && ground != null && pp.plannedHeight != null) {
    cutDepth = ground - pp.plannedHeight
  }
  return { groundHeight: ground, cutDepth }
}

// 正規表現用エスケープ
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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

  // 各管路を 4 行ブロックに書き込み
  // i1 = 3 から開始（旧マクロの配線表）、j = (i1-2)*4 + 7
  // i1=3 → j=11。以降 i1++ ごとに j が 4 ずつ増える。
  for (let idx = 0; idx < sortedPipes.length; idx++) {
    const pipe = sortedPipes[idx]
    const i1 = idx + 3
    const j = (i1 - 2) * 4 + 7

    // 落口判定: pipeType が 'outlet'
    const isOutlet = pipe.pipeType === 'outlet'
    const isAbsorption = pipe.pipeType === 'branch'

    let cData: PointData = { groundHeight: null, cutDepth: null }
    let bData: PointData = { groundHeight: null, cutDepth: null }
    let aData: PointData = { groundHeight: null, cutDepth: null }
    // 落口の P{j+3} に計画高を出すために、A 点の元 PlanPoint も保持する
    let aPointRaw: PlanPoint | null = null

    if (isAbsorption) {
      // 吸水: 施工計画の絶対点 absorptionPoints をそのまま使用
      // pts[0] = C（最上流）, pts[N-1] = A（最下流）, 中間は B
      const row = findAbsorptionRow(planGroups, pipe.id)
      if (row && row.absorptionPoints.length > 0) {
        const pts = row.absorptionPoints
        const N = pts.length
        cData = pointFromPlan(pts[0])
        aData = pointFromPlan(pts[N - 1])
        aPointRaw = pts[N - 1]
        if (N >= 3) {
          // テンプレートは B が 1 列のみ。多点管では中央付近の点を採用。
          bData = pointFromPlan(pts[Math.floor((N - 1) / 2)])
        }
      }
    } else {
      // 集水・落口: 施工計画の全 collectorPoint から、測点名でマッチ。
      // 中間管の A 点は次の管の C 点と同じで、次の管側の行に
      // 「{prev}A {curr}C」形式で保存されているため pipeId で絞らない。
      // 名前は generatePointName と整合し:
      // - C: `{number}C` または `... {number}C` の末尾形式
      // - A: `{number}A` または `{number}A ...` の先頭形式（次管 C 点と共有）
      // - B: `{number}B{数字}`（中間点）
      const pts = collectAllCollectorPoints(planGroups)
      const num = pipe.number
      const numEsc = escapeRegExp(num)
      const matchC = pts.find(
        (p) => p.pointName === `${num}C` || p.pointName.endsWith(` ${num}C`),
      )
      const matchA = pts.find(
        (p) => p.pointName === `${num}A` || p.pointName.startsWith(`${num}A `),
      )
      const bPts = pts.filter((p) =>
        new RegExp(`(^|\\s)${numEsc}B\\d+($|\\s)`).test(p.pointName),
      )
      cData = pointFromPlan(matchC)
      aData = pointFromPlan(matchA)
      aPointRaw = matchA ?? null
      if (bPts.length > 0) {
        bData = pointFromPlan(bPts[Math.floor(bPts.length / 2)])
      }
    }

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
    const vLast = pipe.vertices.length - 1
    if (isOutlet) {
      // 落口: 旧マクロ仕様で、A 点の計画高（管底高）を P{j+3} に出力。
      // 計画高が無ければ地盤高、それも無ければ頂点 z にフォールバック。
      const aValue =
        aPointRaw?.plannedHeight ?? aData.groundHeight ?? pipe.vertices[vLast]?.z ?? null
      if (aValue != null) {
        ws.getCell(j + 3, 16).value = round(aValue, 2)                          // P{j+3}
      }
    } else {
      // 集水管の A 点: 施工計画に無ければ頂点 z を地盤高として転記
      const aGround =
        aData.groundHeight ?? pipe.vertices[vLast]?.z ?? null
      if (aGround != null) {
        ws.getCell(j, 16).value = round(aGround, 2)                             // P{j}: 地盤高
      }
      if (aData.cutDepth != null) {
        ws.getCell(j + 3, 18).value = round(aData.cutDepth, 3)                  // R{j+3}: 切深
      }
    }
  }

  // テンプレートが保持している定義済み名前 (Defined Names) を全削除する。
  // ExcelJS が #REF! を含む不正な参照式を round-trip で書き戻してしまい、
  // Excel が「削除されたレコード: 名前付き範囲」エラーを出すのを防ぐ。
  try {
    const wbAny = workbook as unknown as {
      definedNames?: { model?: { name: string }[]; remove?: (name: string) => void }
    }
    const dn = wbAny.definedNames
    if (dn) {
      const names: string[] = (dn.model ?? []).map((m) => m.name)
      for (const n of names) {
        try {
          dn.remove?.(n)
        } catch {
          // 一部の名前で remove が失敗してもエラーにしない
        }
      }
    }
  } catch {
    // ignore
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
