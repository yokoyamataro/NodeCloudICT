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

  // 直落 group で 落口 (pipeType='outlet') として使われている物理管路は、
  // 「吸水 + 落口」を 1 plan row にまとめているため、
  // 通常の pipes ループの中で 配管番号ごとに 1 行 書き出す。
  // (集水 group の落口だけを 後段の outletPlanRows loop に任せる)
  const directOutletPipeIds = new Set<string>()
  for (const g of planGroups) {
    if (g.groupType !== 'direct') continue
    for (const r of g.rows) {
      if (r.systemEndType === 'outlet' && r.collectorPipeId) {
        directOutletPipeIds.add(r.collectorPipeId)
      }
    }
  }

  // 配管を数字でソート（頭文字・末尾文字を無視）。
  // 物理的な「落口」pipeType の管路は、後段で施工計画の outlet planRow から
  // 一括で書き出すためここでは除外する (複数落口がある場合に取りこぼしを防ぐ)。
  // ただし 直落 group で使われている落口管は 上記ループに含めて 出力する。
  //
  // 直落で 複数の吸水が 同じ番号の落口 (例: 2 本の O8 pipe) に流入する場合、
  // Excel には 1 行だけに集約するため 落口は 番号 (pipe.number) で dedup する。
  const seenOutletNumbers = new Set<string>()
  const sortedPipes = [...pipes]
    .filter((p) => p.pipeType !== 'outlet' || directOutletPipeIds.has(p.id))
    .filter((p) => {
      if (p.pipeType !== 'outlet') return true
      if (seenOutletNumbers.has(p.number)) return false
      seenOutletNumbers.add(p.number)
      return true
    })
    .sort((a, b) => comparePipeNumbers(a.number, b.number))

  // 全 planPoint (吸水 + 集水) を集めて 名前で引けるようにしておく。
  // 直落は 1 plan row に K2C..O1A が混ざって入っているため、
  // 各管の C/B/A は 配管番号ベースの名前で個別に引き出す。
  const allPlanPoints: PlanPoint[] = []
  for (const group of planGroups) {
    for (const row of group.rows) {
      allPlanPoints.push(...row.absorptionPoints)
      if (row.collectorPoint) allPlanPoints.push(row.collectorPoint)
    }
  }
  const findCbaByPipeNumber = (
    num: string,
  ): { c: PlanPoint | undefined; b: PlanPoint | undefined; a: PlanPoint | undefined } => {
    const numEsc = escapeRegExp(num)
    const c = allPlanPoints.find(
      (p) => p.pointName === `${num}C` || p.pointName.endsWith(` ${num}C`),
    )
    const a = allPlanPoints.find(
      (p) => p.pointName === `${num}A` || p.pointName.startsWith(`${num}A `),
    )
    const bPts = allPlanPoints.filter((p) =>
      new RegExp(`(^|\\s)${numEsc}B\\d+($|\\s)`).test(p.pointName),
    )
    const b = bPts.length > 0 ? bPts[Math.floor(bPts.length / 2)] : undefined
    return { c, b, a }
  }

  // ===== 出力行を 1 本に統合してから 配線番号順にソート =====
  // 旧実装は 吸水/集水 → 落口 の 2 段で書き出していたため、
  // Excel 上で 落口が末尾に固まっていた。
  // CAD 解析の連番 (O1, S2, S3, K4, ..., O25, S26, ...) と一致させるため
  // 全て 1 リストにまとめて comparePipeNumbers でソートする。

  // 落口: 施工計画の outlet planRow を全件収集。
  const outletPlanRows: {
    row: PlanRow
    pipe: PipeRow | null
    outletPipe: PipeRow | null
  }[] = []
  for (const group of planGroups) {
    // 直落 group の落口は sortedPipes 側 (directOutletPipeIds) で書き出すのでスキップ
    if (group.groupType === 'direct') continue
    for (const row of group.rows) {
      if (row.systemEndType !== 'outlet') continue
      const collectorPipe = pipes.find((p) => p.id === row.collectorPipeId) ?? null
      // 落口点の位置に最も近い pipeType='outlet' の管路を探す (あれば管番号を採用)
      let outletPipe: PipeRow | null = null
      const cp = row.collectorPoint
      if (cp) {
        let bestDist = 1.0 // 1m 以内
        for (const p of pipes) {
          if (p.pipeType !== 'outlet') continue
          for (const v of p.vertices) {
            const d = Math.hypot(v.x - cp.x, v.y - cp.y)
            if (d < bestDist) {
              bestDist = d
              outletPipe = p
            }
          }
        }
      }
      outletPlanRows.push({ row, pipe: collectorPipe, outletPipe })
    }
  }

  // 1 行分の書き込み手順を関数化して 統一する
  type OutputRow =
    | { kind: 'pipe'; sortNumber: string; pipe: PipeRow }
    | {
        kind: 'outletPlan'
        sortNumber: string
        row: PlanRow
        collectorPipe: PipeRow | null
        outletPipe: PipeRow | null
      }

  const outputRows: OutputRow[] = []
  for (const pipe of sortedPipes) {
    outputRows.push({ kind: 'pipe', sortNumber: pipe.number, pipe })
  }
  for (const opr of outletPlanRows) {
    // 落口 planRow の並び番号: outlet 管の番号 を優先。無ければ集水管の番号
    const num = opr.outletPipe?.number ?? opr.pipe?.number ?? ''
    outputRows.push({
      kind: 'outletPlan',
      sortNumber: num,
      row: opr.row,
      collectorPipe: opr.pipe,
      outletPipe: opr.outletPipe,
    })
  }
  // 配線番号 (O1, S2, S3, K4, ..., O25, S26, ...) で並べ替え
  outputRows.sort((a, b) => comparePipeNumbers(a.sortNumber, b.sortNumber))

  // 各行を 4 行ブロックに書き込み
  // i1 = 3 から開始 (旧マクロの配線表)、j = (i1-2)*4 + 7
  // i1=3 → j=11。以降 i1++ ごとに j が 4 ずつ増える。
  for (let excelIdx = 0; excelIdx < outputRows.length; excelIdx++) {
    const item = outputRows[excelIdx]
    const i1 = excelIdx + 3
    const j = (i1 - 2) * 4 + 7

    if (item.kind === 'pipe') {
      const pipe = item.pipe
      // 落口判定: pipeType が 'outlet' (直落 group で使われている落口管はここに来る)
      const isOutlet = pipe.pipeType === 'outlet'

      let cData: PointData = { groundHeight: null, cutDepth: null }
      let bData: PointData = { groundHeight: null, cutDepth: null }
      let aData: PointData = { groundHeight: null, cutDepth: null }
      let aPointRaw: PlanPoint | null = null

      // 配管番号ごとに C/B/A を 名前ベースで引く
      const { c: matchC, b: matchB, a: matchA } = findCbaByPipeNumber(pipe.number)
      cData = pointFromPlan(matchC)
      bData = pointFromPlan(matchB)
      aData = pointFromPlan(matchA)
      aPointRaw = matchA ?? null

      const pipeTypeLabel = isOutlet
        ? '落口'
        : pipe.pipeType
          ? PIPE_TYPE_NAMES[pipe.pipeType]
          : ''

      ws.getCell(j, 1).value = pipe.number                                         // A{j}: 渠番号
      ws.getCell(j + 2, 1).value = pipe.diameter ?? null                           // A{j+2}: 管径
      ws.getCell(j + 3, 1).value = pipeTypeLabel                                   // A{j+3}: 管種
      ws.getCell(j, 2).value =
        pipe.designLength != null ? Math.round(pipe.designLength) : null           // B{j}: 設計延長
      if (header.spacing != null && pipe.pipeType === 'branch') {
        ws.getCell(j, 4).value = header.spacing                                    // D{j}: 配線間隔
      }

      // 上流 C
      if (cData.groundHeight != null) {
        ws.getCell(j, 6).value = round(cData.groundHeight, 2)                     // F{j}
      }
      if (cData.cutDepth != null) {
        ws.getCell(j + 3, 8).value = round(cData.cutDepth, 3)                     // H{j+3}
      }

      // 中間 B
      if (bData.groundHeight != null) {
        ws.getCell(j, 11).value = round(bData.groundHeight, 2)                    // K{j}
      }
      if (bData.cutDepth != null) {
        ws.getCell(j + 3, 13).value = round(bData.cutDepth, 3)                    // M{j+3}
      }

      // 下流 A
      const vLast = pipe.vertices.length - 1
      if (isOutlet) {
        const aValue =
          aPointRaw?.plannedHeight ?? aData.groundHeight ?? pipe.vertices[vLast]?.z ?? null
        if (aValue != null) {
          ws.getCell(j + 3, 16).value = round(aValue, 2)                          // P{j+3}
        }
      } else {
        const aGround = aData.groundHeight ?? pipe.vertices[vLast]?.z ?? null
        if (aGround != null) {
          ws.getCell(j, 16).value = round(aGround, 2)                             // P{j}
        }
        if (aData.cutDepth != null) {
          ws.getCell(j + 3, 18).value = round(aData.cutDepth, 3)                  // R{j+3}
        }
      }
    } else {
      // 落口 planRow
      const showPipe = item.outletPipe ?? item.collectorPipe
      const cp = item.row.collectorPoint
      if (showPipe) {
        ws.getCell(j, 1).value = showPipe.number
        ws.getCell(j + 2, 1).value = showPipe.diameter ?? null
        ws.getCell(j, 2).value =
          showPipe.designLength != null ? Math.round(showPipe.designLength) : null
      }
      ws.getCell(j + 3, 1).value = '落口'
      const aValue =
        cp?.plannedHeight
        ?? cp?.groundHeight
        ?? (item.outletPipe && item.outletPipe.vertices.length > 0
          ? item.outletPipe.vertices[item.outletPipe.vertices.length - 1]?.z
          : null)
        ?? null
      if (aValue != null) {
        ws.getCell(j + 3, 16).value = round(aValue, 2)
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
