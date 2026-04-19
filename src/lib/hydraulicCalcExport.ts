import ExcelJS from 'exceljs'
import type { PlanGroup, PlanRow } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
import type { Farm } from '@/stores/farmStore'

export interface HydraulicCalcSettings {
  plannedFlow: number
  pipeInterval: 10 | 12
  absorptionPipeType: 1 | 2
  collectorPipeType: 1 | 2
  lengthDecimals: 0 | 1 | 2
}

interface ExportArgs {
  settings: HydraulicCalcSettings
  planGroups: PlanGroup[]
  pipes: PipeRow[]
  farm: Farm | null
}

// 数値を指定桁数で丸める
const roundTo = (value: number, decimals: number): number => {
  const m = Math.pow(10, decimals)
  return Math.round(value * m) / m
}

// 管の実延長（頂点間の合計距離）を計算
const calculatePipeLength = (pipe: PipeRow): number => {
  if (pipe.measuredLength != null) return pipe.measuredLength
  if (pipe.designLength != null) return pipe.designLength
  // 頂点から再計算
  let total = 0
  for (let i = 1; i < pipe.vertices.length; i++) {
    const dx = pipe.vertices[i].x - pipe.vertices[i - 1].x
    const dy = pipe.vertices[i].y - pipe.vertices[i - 1].y
    total += Math.sqrt(dx * dx + dy * dy)
  }
  return total
}

// rowType 判定（連絡渠・落口は pipeType で判断）
const isOutletOrConnector = (pipe: PipeRow | null | undefined): boolean => {
  if (!pipe) return false
  return pipe.pipeType === 'outlet' || pipe.pipeType === 'connection'
}

export async function exportHydraulicCalcSheet({
  settings,
  planGroups,
  pipes,
  farm,
}: ExportArgs): Promise<void> {
  const { plannedFlow, pipeInterval, absorptionPipeType, collectorPipeType, lengthDecimals } = settings

  // テンプレート読込
  const response = await fetch('/水理計算書様式.xlsx')
  if (!response.ok) {
    throw new Error(`テンプレートの取得に失敗しました (${response.status})`)
  }
  const arrayBuffer = await response.arrayBuffer()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(arrayBuffer)

  const ws = workbook.worksheets[0]
  if (!ws) throw new Error('テンプレートにシートが見つかりません')

  // 外部ワークブック参照の定義名を削除
  // （テンプレートに `[10]3.延長調書!$B$62` のような外部参照が残っており、
  //  Excel が開く際に解決できず「修復されたブック」警告を出すため）
  try {
    const definedNames = (workbook as unknown as {
      definedNames?: {
        model?: Array<{ name: string; ranges?: string[] }>
        matrixMap?: Record<string, unknown>
      }
    }).definedNames
    if (definedNames) {
      // model を空配列に（removeAllNames は外部参照解決でエラーになるため直接操作）
      definedNames.model = []
      if (definedNames.matrixMap) {
        for (const key of Object.keys(definedNames.matrixMap)) {
          delete definedNames.matrixMap[key]
        }
      }
    }
  } catch {
    // 失敗しても続行
  }

  // タイトル行
  ws.getCell('E3').value = farm?.name ?? ''
  ws.getCell('U3').value = plannedFlow
  ws.getCell('AJ3').value = pipeInterval

  // pipes ルックアップ
  const pipeById = new Map<string, PipeRow>()
  for (const p of pipes) pipeById.set(p.id, p)

  // 集水暗渠のみ処理（direct は別途必要なら追加）
  const collectorGroups = planGroups.filter((g) => g.groupType === 'collector')

  // 系統ごとにグループ化
  interface SystemData {
    groupIndex: number
    systemIndex: number
    rows: PlanRow[]
  }
  const systems: SystemData[] = []
  for (const group of collectorGroups) {
    const map = new Map<number, PlanRow[]>()
    for (const row of group.rows) {
      const sysIdx = row.systemIndex || 1
      if (!map.has(sysIdx)) map.set(sysIdx, [])
      map.get(sysIdx)!.push(row)
    }
    for (const [systemIndex, rows] of Array.from(map.entries()).sort((a, b) => a[0] - b[0])) {
      systems.push({ groupIndex: group.groupIndex, systemIndex, rows })
    }
  }

  // 書き込み
  let currentRow = 8
  for (let sysIdx = 0; sysIdx < systems.length; sysIdx++) {
    const system = systems[sysIdx]

    // 全行（集水合流も含めて）を順序保持で取得
    const dataRows = system.rows

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i]
      const isFirstInSystem = i === 0
      const isLastInSystem = i === dataRows.length - 1
      const nextRow = dataRows[i + 1]
      const isMergeRow = row.mergeSystemIndex != null

      // 系統の最後の行は配管がないため全て転記しない（行送りだけ進める）
      if (isLastInSystem) {
        currentRow += 2
        continue
      }

      const absorptionPipe = row.absorptionPipeId ? pipeById.get(row.absorptionPipeId) : null
      const collectorPipe = row.collectorPipeId ? pipeById.get(row.collectorPipeId) : null

      // === 吸水側 ===（集水合流行では吸水側は転記しない）
      if (absorptionPipe && !isMergeRow) {
        // A: 吸水番号
        ws.getCell(`A${currentRow}`).value = absorptionPipe.number
        // B: 管種
        ws.getCell(`B${currentRow}`).value = absorptionPipeType
        // E: 管径（cm）— 元が mm 想定なので /10、null なら空
        if (absorptionPipe.diameter != null) {
          ws.getCell(`E${currentRow}`).value = absorptionPipe.diameter / 10
        }
        // F: 延長（実測または設計長を丸め）
        const actualLen = calculatePipeLength(absorptionPipe)
        ws.getCell(`F${currentRow}`).value = roundTo(actualLen, lengthDecimals)
        // G: 接続補正(-) — 最初の端部は空、それ以外は 配線間隔/2
        //   系統内で最初の吸水行かどうかで判断
        const isFirstAbsorption =
          dataRows.slice(0, i).filter((r) => r.absorptionPipeId).length === 0
        if (!isFirstAbsorption) {
          ws.getCell(`G${currentRow}`).value = pipeInterval / 2
        }
        // H: 端部補正(+) = 配線間隔/4（全行）
        ws.getCell(`H${currentRow}`).value = pipeInterval / 4
        // K: 勾配 = 実延長 / (上流端計画高 - 下流端計画高)
        const absPts = row.absorptionPoints
        if (absPts.length >= 2) {
          const up = absPts[0].plannedHeight
          const down = absPts[absPts.length - 1].plannedHeight
          if (up != null && down != null && up !== down) {
            const slope = actualLen / (up - down)
            ws.getCell(`K${currentRow}`).value = Math.round(slope)
          }
        }
      }

      // === 集水側 ===
      // 系統の最初の行は集水を転記しない（1行目と2行目は同じ集水管の区間になるため）
      if (!isFirstInSystem && collectorPipe) {
        // S: 集水番号
        ws.getCell(`S${currentRow}`).value = collectorPipe.number
        // T: 管種（1 行下に転記。連絡渠・落口なら 3、それ以外は設定）
        ws.getCell(`T${currentRow + 1}`).value = isOutletOrConnector(collectorPipe)
          ? 3
          : collectorPipeType
        // W: 管径（cm）— 1 行下に転記
        if (collectorPipe.diameter != null) {
          ws.getCell(`W${currentRow + 1}`).value = collectorPipe.diameter / 10
        }
        // X: 実延長（次の管までの区間延長）
        if (row.collectorPoint?.segmentDistance != null) {
          ws.getCell(`X${currentRow}`).value = roundTo(
            row.collectorPoint.segmentDistance,
            lengthDecimals,
          )
        }
        // Y: 補正 — 集水合流行のみ -配線間隔/2
        // Z: 累加距離 — 集水合流行のみ =上のセル(Z) + 2つ左(X) + 1つ左(Y)
        if (isMergeRow) {
          ws.getCell(`Y${currentRow}`).value = -(pipeInterval / 2)
          ws.getCell(`Z${currentRow}`).value = {
            formula: `Z${currentRow - 2}+X${currentRow}+Y${currentRow}`,
          }
        }
        // AB: 集水勾配 — 次の行の集水計画高との差分から算出
        //   segmentSlope は表示時計算のためストア上は null。ここで再計算する。
        const curH = row.collectorPoint?.plannedHeight
        const nextH = nextRow?.collectorPoint?.plannedHeight
        const dist = row.collectorPoint?.segmentDistance
        if (curH != null && nextH != null && dist != null && curH !== nextH) {
          const slope = Math.abs(dist / (curH - nextH))
          ws.getCell(`AB${currentRow}`).value = Math.round(slope)
        }
      }

      currentRow += 2
    }

    // 系統の末尾は 2 行余分に空ける
    if (sysIdx < systems.length - 1) {
      currentRow += 2
    }
  }

  // ダウンロード
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer as ArrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const fname = `水理計算書_${farm?.name ?? 'farm'}.xlsx`
  a.download = fname
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
