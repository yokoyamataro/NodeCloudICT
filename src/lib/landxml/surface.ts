// 3D TIN サーフェス生成ユーティリティ
// - 入力: 配管頂点（計画高 or 頂点 z）・測量点
// - 出力: Delaunay 三角形分割した TIN（点リストと三角形インデックス配列）
//
// 最小実装方針: 拘束なしの単純な 2D Delaunay。将来的に配管線を constrained edge として扱うことを想定。

import Delaunator from 'delaunator'
import type { PipeRow } from '@/stores/underdrainStore'
import type { SurveyDataRow } from '@/stores/surveyStore'
import type { PlanGroup, PlanPoint } from '@/stores/constructionPlanStore'

export interface TinPoint {
  x: number // 北
  y: number // 東
  z: number // 標高
  /** 由来の識別（debug / 将来の拘束エッジ用） */
  source: 'pipe' | 'survey' | 'plan'
  refId?: string | null
}

export interface TinTriangle {
  /** p0, p1, p2 のインデックス */
  a: number
  b: number
  c: number
}

export interface TinSurface {
  points: TinPoint[]
  triangles: TinTriangle[]
  /** 統計情報 */
  stats: {
    pointCount: number
    triangleCount: number
    zMin: number
    zMax: number
  }
}

// XY が同一または極めて近い点は重複として除外（Delaunay が破綻するため）
// 同一位置の場合は最後の z で上書きする想定
function dedupePoints(points: TinPoint[], tol = 0.01): TinPoint[] {
  const map = new Map<string, TinPoint>()
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
    const key = `${Math.round(p.x / tol)}_${Math.round(p.y / tol)}`
    // 既存があれば source の優先度で置き換え: plan > pipe > survey（plan は計画高確定点）
    const prev = map.get(key)
    if (!prev) {
      map.set(key, p)
    } else {
      const priority = { plan: 3, pipe: 2, survey: 1 }
      if (priority[p.source] > priority[prev.source]) map.set(key, p)
    }
  }
  return Array.from(map.values())
}

export interface BuildSurfaceOptions {
  pipes: PipeRow[]
  surveyData: SurveyDataRow[]
  planGroups?: PlanGroup[]
  includePipes?: boolean
  includeSurvey?: boolean
  includePlan?: boolean
}

export function buildTinSurface(opts: BuildSurfaceOptions): TinSurface {
  const {
    pipes,
    surveyData,
    planGroups = [],
    includePipes = true,
    includeSurvey = true,
    includePlan = true,
  } = opts

  const raw: TinPoint[] = []

  // 配管頂点: z があれば使う（地盤高として格納されている想定）
  if (includePipes) {
    for (const pipe of pipes) {
      for (const v of pipe.vertices) {
        if (v.z != null && Number.isFinite(v.z)) {
          raw.push({ x: v.x, y: v.y, z: v.z, source: 'pipe', refId: pipe.id })
        }
      }
    }
  }

  // 測量点
  if (includeSurvey) {
    for (const s of surveyData) {
      if (s.z != null && Number.isFinite(s.z)) {
        raw.push({ x: s.x, y: s.y, z: s.z, source: 'survey', refId: s.id })
      }
    }
  }

  // 施工計画点（計画高）: 配管頂点と同じ XY だが、z が計画高になる
  // plan point の xy は配管の頂点 xy なので、pipe 由来とは XY がほぼ一致する。
  // 重複除外の優先度で plan を優先するため、plan 由来は配管の地盤高より計画高を採用する効果がある
  if (includePlan) {
    const collect = (p: PlanPoint): void => {
      if (p.plannedHeight != null && Number.isFinite(p.plannedHeight)) {
        raw.push({ x: p.x, y: p.y, z: p.plannedHeight, source: 'plan', refId: p.id })
      }
    }
    for (const group of planGroups) {
      for (const row of group.rows) {
        for (const ap of row.absorptionPoints) collect(ap)
        if (row.collectorPoint) collect(row.collectorPoint)
      }
    }
  }

  const points = dedupePoints(raw)

  if (points.length < 3) {
    return {
      points,
      triangles: [],
      stats: {
        pointCount: points.length,
        triangleCount: 0,
        zMin: 0,
        zMax: 0,
      },
    }
  }

  // Delaunator は [x, y] の平坦化配列を入力とする
  const coords: number[] = new Array(points.length * 2)
  for (let i = 0; i < points.length; i++) {
    coords[i * 2] = points[i].x
    coords[i * 2 + 1] = points[i].y
  }
  const delaunay = new Delaunator(coords)
  const tri = delaunay.triangles

  const triangles: TinTriangle[] = []
  for (let i = 0; i < tri.length; i += 3) {
    triangles.push({ a: tri[i], b: tri[i + 1], c: tri[i + 2] })
  }

  let zMin = Number.POSITIVE_INFINITY
  let zMax = Number.NEGATIVE_INFINITY
  for (const p of points) {
    if (p.z < zMin) zMin = p.z
    if (p.z > zMax) zMax = p.z
  }
  if (!Number.isFinite(zMin)) zMin = 0
  if (!Number.isFinite(zMax)) zMax = 0

  return {
    points,
    triangles,
    stats: {
      pointCount: points.length,
      triangleCount: triangles.length,
      zMin,
      zMax,
    },
  }
}
