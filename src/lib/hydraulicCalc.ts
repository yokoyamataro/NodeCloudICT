// 水理計算用ユーティリティ
// - 各吸水渠の支配延長
// - 各集水行の累加延長

import type { PipeRow } from '@/stores/underdrainStore'
import type { PlanGroup, PlanRow } from '@/stores/constructionPlanStore'

/** 吸水管の実延長（設計延長があればそれ、無ければ頂点距離合計）。 */
export function actualLengthOfPipe(pipe: PipeRow): number {
  if (pipe.designLength != null && Number.isFinite(pipe.designLength)) {
    return pipe.designLength
  }
  let total = 0
  for (let i = 1; i < pipe.vertices.length; i++) {
    const a = pipe.vertices[i - 1]
    const b = pipe.vertices[i]
    total += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return total
}

/**
 * 吸水渠 1 本の支配延長 (m)。
 *
 * 支配延長 = 実延長 + 端部補正 (+配線間隔/4) - 接続補正 (-配線間隔/2)
 *  ・端部補正は吸水管すべてに常に +配線間隔/4
 *  ・接続補正は系統内の最初の吸水管のみ 0、それ以外は +配線間隔/2
 */
export function computeAbsorptionDominantLength(
  actualLength: number,
  isFirstAbsorptionInSystem: boolean,
  pipeInterval: number,
): number {
  const endCorrection = pipeInterval / 4
  const connectionCorrection = isFirstAbsorptionInSystem ? 0 : pipeInterval / 2
  return actualLength + endCorrection - connectionCorrection
}

/** 集水行 1 行分の入力（累加延長計算用）。 */
export interface CumRowInput {
  /** PlanRow 由来の識別子 */
  rowId: string
  /** 行タイプ。'collector_merge' のとき pattern 1（合流）。 */
  rowType: string | null
  /** この行の吸水合計支配延長（吸水なし行は 0） */
  absorptionDominantLength: number
  /** この行の collector pipe から次の collector point までの距離（あれば）。
   *  PlanRow.collectorPoint.segmentDistance（自点 → 次点）と同じ規約。 */
  collectorSegmentToNext: number | null
  /** 集水管の管種（'main' | 'outlet' | 'connection' | ...）。null も許容 */
  collectorPipeType: string | null
  /** 'collector_merge' 行のとき、合流先系統の最終累加延長 */
  mergeSystemFinalCum?: number | null
}

/**
 * 1 系統分の累加延長を計算する。返り値は CumRowInput[] と同じ長さの number|null 配列。
 *
 * 規則:
 *  - 0 行目: null（先頭は空）
 *  - 1 行目: row[0].abs + row[1].abs + 集水区間延長（row[0]→row[1]）
 *  - 2 行目以降:
 *    - 集水合流: 前行 cum + 該当系統 cum - 配線間隔/2
 *    - それ以外: 前行 cum + 当該行の吸水支配延長 + 集水区間延長
 *      例外: 前行の集水管種が outlet / connection の時、その区間延長を加算しない
 */
export function computeCumulativeLengths(
  rows: CumRowInput[],
  pipeInterval: number,
): (number | null)[] {
  const cum: (number | null)[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (i === 0) {
      cum.push(null)
      continue
    }
    if (r.rowType === 'collector_merge' && r.mergeSystemFinalCum != null) {
      const prev = cum[i - 1] ?? 0
      cum.push(prev + r.mergeSystemFinalCum - pipeInterval / 2)
      continue
    }
    const prevRow = rows[i - 1]
    const prevSegRaw = prevRow.collectorSegmentToNext ?? 0
    const prevIsOutletOrConn =
      prevRow.collectorPipeType === 'outlet' || prevRow.collectorPipeType === 'connection'
    const seg = prevIsOutletOrConn ? 0 : prevSegRaw
    if (i === 1) {
      // 1 行目（系統 2 番目）: 0 行目の吸水も含める
      cum.push(
        (prevRow.absorptionDominantLength ?? 0) +
          (r.absorptionDominantLength ?? 0) +
          seg,
      )
      continue
    }
    const prev = cum[i - 1] ?? 0
    cum.push(prev + (r.absorptionDominantLength ?? 0) + seg)
  }
  return cum
}

/** 1 圃場の全プラングループから、各行の支配延長 / 累加延長を一括算出する。 */
export interface SystemCalcResult {
  /** wiringRowId → 当該行の吸水支配延長（吸水なしは null） */
  dominantByWiringId: Map<string, number | null>
  /** wiringRowId → 当該行の累加延長（系統先頭は null） */
  cumulativeByWiringId: Map<string, number | null>
}

export function computeAllHydraulicLengths(
  planGroups: PlanGroup[],
  pipes: PipeRow[],
  pipeInterval: number,
): SystemCalcResult {
  const pipeById = new Map<string, PipeRow>()
  for (const p of pipes) pipeById.set(p.id, p)

  // groupKey + systemIndex でまとめる
  const systemKey = (g: PlanGroup, sysIdx: number) =>
    `${g.groupType}-${g.groupIndex}-${sysIdx}`
  const systemRows = new Map<string, PlanRow[]>()
  for (const g of planGroups) {
    const bySys = new Map<number, PlanRow[]>()
    for (const r of g.rows) {
      const k = r.systemIndex ?? 0
      const arr = bySys.get(k) ?? []
      arr.push(r)
      bySys.set(k, arr)
    }
    for (const [sysIdx, rows] of bySys) {
      systemRows.set(systemKey(g, sysIdx), rows)
    }
  }

  // 各行の吸水支配延長
  const dominantByWiringId = new Map<string, number | null>()
  for (const rows of systemRows.values()) {
    let firstAbsorptionConsumed = false
    for (const r of rows) {
      const absId = r.absorptionPipeId
      if (!absId) {
        if (r.wiringRowId) dominantByWiringId.set(r.wiringRowId, null)
        continue
      }
      const pipe = pipeById.get(absId)
      if (!pipe) {
        if (r.wiringRowId) dominantByWiringId.set(r.wiringRowId, null)
        continue
      }
      const isFirst = !firstAbsorptionConsumed
      firstAbsorptionConsumed = true
      const actual = actualLengthOfPipe(pipe)
      const dom = computeAbsorptionDominantLength(actual, isFirst, pipeInterval)
      if (r.wiringRowId) dominantByWiringId.set(r.wiringRowId, dom)
    }
  }

  // 系統 → 最終累加（merge 用）
  // 反復: collector_merge は他系統の最終 cum を要求するため、最大数回ループしながら解決。
  const finalCumByKey = new Map<string, number | null>()
  const cumulativeByWiringId = new Map<string, number | null>()
  const maxIter = 6

  // 各系統の入力を作る
  const inputsByKey = new Map<string, { row: PlanRow; input: CumRowInput }[]>()
  for (const [key, rows] of systemRows) {
    const arr: { row: PlanRow; input: CumRowInput }[] = []
    for (const r of rows) {
      const dom = r.wiringRowId ? dominantByWiringId.get(r.wiringRowId) ?? 0 : 0
      const collectorPipe = r.collectorPipeId ? pipeById.get(r.collectorPipeId) : null
      arr.push({
        row: r,
        input: {
          rowId: r.id,
          rowType: r.wiringRowType ?? null,
          absorptionDominantLength: dom ?? 0,
          collectorSegmentToNext: r.collectorPoint?.segmentDistance ?? null,
          collectorPipeType: collectorPipe?.pipeType ?? null,
          mergeSystemFinalCum: null,
        },
      })
    }
    inputsByKey.set(key, arr)
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false
    for (const [key, items] of inputsByKey) {
      // collector_merge 行に他系統の最終 cum を供給
      for (let i = 0; i < items.length; i++) {
        const r = items[i].row
        if (r.wiringRowType === 'collector_merge' && r.mergeSystemIndex != null) {
          // 同じ groupType / groupIndex の中で systemIndex を探す
          // r が属する系統の (groupType, groupIndex) と同一の他系統
          const myParts = key.split('-')
          const targetKey = `${myParts[0]}-${myParts[1]}-${r.mergeSystemIndex}`
          const tFinal = finalCumByKey.get(targetKey) ?? null
          if (items[i].input.mergeSystemFinalCum !== tFinal) {
            items[i].input.mergeSystemFinalCum = tFinal
            changed = true
          }
        }
      }
      const cumArr = computeCumulativeLengths(
        items.map((x) => x.input),
        pipeInterval,
      )
      const last = cumArr.length > 0 ? cumArr[cumArr.length - 1] : null
      if (finalCumByKey.get(key) !== last) {
        finalCumByKey.set(key, last)
        changed = true
      }
      for (let i = 0; i < items.length; i++) {
        const r = items[i].row
        if (r.wiringRowId) cumulativeByWiringId.set(r.wiringRowId, cumArr[i])
      }
    }
    if (!changed) break
  }

  return { dominantByWiringId, cumulativeByWiringId }
}
