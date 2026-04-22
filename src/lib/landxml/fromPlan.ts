// 施工計画（PlanGroup[]）から中心線形（Alignment）を自動生成する。
// - 吸水管: 各 PlanRow の absorptionPoints を上流→下流で直線連結した 1 アライメント
// - 集水管: 各系統（groupIndex × systemIndex）の collectorPoint を順に直線連結した 1 アライメント

import type { PlanGroup, PlanRow, PlanPoint } from '@/stores/constructionPlanStore'
import type { Alignment, AlignmentSegment } from './types'

export interface DerivedAlignment extends Alignment {
  /** 由来情報（表示・区別用） */
  source: 'absorption' | 'collector'
  /** グループインデックス（集水の場合）・系統インデックス（集水）・吸水管ID（吸水）など */
  ref?: string
}

function dist2d(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

// Z（標高）は計画高を優先、未入力なら地盤高をフォールバック
function pickZ(p: PlanPoint): number | null {
  if (p.plannedHeight != null) return p.plannedHeight
  if (p.groundHeight != null) return p.groundHeight
  return null
}

function segmentsFromPoints(points: PlanPoint[]): AlignmentSegment[] {
  const segs: AlignmentSegment[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const len = dist2d(a, b)
    if (len < 1e-6) continue
    segs.push({
      type: 'line',
      startX: a.x,
      startY: a.y,
      startZ: pickZ(a),
      endX: b.x,
      endY: b.y,
      endZ: pickZ(b),
      length: len,
    })
  }
  return segs
}

// アライメント全体の Z 範囲を取得（セグメントから）
export function alignmentZRange(
  segments: AlignmentSegment[],
): { min: number; max: number; has3D: boolean } {
  const zs: number[] = []
  for (const s of segments) {
    if (s.startZ != null) zs.push(s.startZ)
    if (s.endZ != null) zs.push(s.endZ)
  }
  if (zs.length === 0) return { min: 0, max: 0, has3D: false }
  return { min: Math.min(...zs), max: Math.max(...zs), has3D: true }
}

function sumLength(segs: AlignmentSegment[]): number {
  return segs.reduce((s, seg) => s + seg.length, 0)
}

export function buildAlignmentsFromPlan(
  planGroups: PlanGroup[],
): DerivedAlignment[] {
  const out: DerivedAlignment[] = []

  for (let gi = 0; gi < planGroups.length; gi++) {
    const group = planGroups[gi]

    // --- 吸水管: 各行の absorptionPoints を線形化 ---
    for (const row of group.rows) {
      if (!row.absorptionPipeId || row.absorptionPoints.length < 2) continue
      const segments = segmentsFromPoints(row.absorptionPoints)
      if (segments.length === 0) continue
      out.push({
        id: `abs-${row.id}`,
        name: `${row.pipeNumber ?? row.absorptionPipeId} (吸水)`,
        staStart: 0,
        totalLength: sumLength(segments),
        segments,
        source: 'absorption',
        ref: row.absorptionPipeId,
      })
    }

    // --- 集水管: 系統ごとに行の collectorPoint を並べる ---
    const systemMap = new Map<number, PlanRow[]>()
    for (const r of group.rows) {
      const idx = r.systemIndex ?? 1
      const arr = systemMap.get(idx) ?? []
      arr.push(r)
      systemMap.set(idx, arr)
    }
    for (const [sysIdx, rows] of systemMap) {
      const points: PlanPoint[] = []
      for (const r of rows) {
        if (r.collectorPoint) points.push(r.collectorPoint)
      }
      if (points.length < 2) continue
      const segments = segmentsFromPoints(points)
      if (segments.length === 0) continue
      out.push({
        id: `col-${gi}-${sysIdx}`,
        name: `${group.name} 系統${sysIdx} (集水)`,
        staStart: 0,
        totalLength: sumLength(segments),
        segments,
        source: 'collector',
        ref: `${gi}-${sysIdx}`,
      })
    }
  }

  return out
}
