// 3D TIN サーフェス生成ユーティリティ
// - 入力: 配管頂点（計画高 or 頂点 z）・測量点
// - 出力: Delaunay 三角形分割した TIN（点リストと三角形インデックス配列）
//
// 最小実装方針: 拘束なしの単純な 2D Delaunay。将来的に配管線を constrained edge として扱うことを想定。

import Delaunator from 'delaunator'
import type { PipeRow } from '@/stores/underdrainStore'
import type { SurveyDataRow } from '@/stores/surveyStore'
import type { PlanGroup, PlanPoint, PlanRow } from '@/stores/constructionPlanStore'

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

// ============================================================
// 床掘 TIN 生成
//   中心線から左右にオフセットした帯（ribbon）を三角形分割する。
//   Z は各頂点の計画高（plannedHeight）を採用。各リボンは独立。
// ============================================================

interface CenterlineVertex {
  x: number
  y: number
  z: number
}

export interface TrenchTinOptions {
  planGroups: PlanGroup[]
  /** 中心線から片側のオフセット幅（m）。デフォルト 0.25 = 幅 50cm */
  halfWidth?: number
  /** 吸水を含めるか */
  includeAbsorption?: boolean
  /** 集水を含めるか */
  includeCollector?: boolean
  /** 擦り付け処理を行うか */
  applyTransition?: boolean
  /** 縦断変化点までの距離（m）。デフォルト 5m */
  transitionDistance?: number
  /** 集水/合流側の縁からのクリアランス（m）。デフォルト 0.10 = 10cm */
  trimClearance?: number
}

/**
 * 中心線 centerPts に沿って左右 halfWidth だけオフセットした帯を追加する。
 * 各頂点では前後セグメントの法線を平均した「miter normal」方向に offset する。
 */
function addRibbon(
  points: TinPoint[],
  triangles: TinTriangle[],
  centerPts: CenterlineVertex[],
  halfWidth: number,
  source: TinPoint['source'],
  refId?: string | null,
): void {
  if (centerPts.length < 2) return

  const leftIdx: number[] = []
  const rightIdx: number[] = []

  // 各頂点の miter normal (長さ 1 単位、法線方向)
  for (let i = 0; i < centerPts.length; i++) {
    const curr = centerPts[i]
    // 前後のセグメント方向（正規化）
    const tangents: Array<{ tx: number; ty: number }> = []
    if (i > 0) {
      const prev = centerPts[i - 1]
      const dx = curr.x - prev.x
      const dy = curr.y - prev.y
      const l = Math.hypot(dx, dy)
      if (l > 1e-9) tangents.push({ tx: dx / l, ty: dy / l })
    }
    if (i < centerPts.length - 1) {
      const next = centerPts[i + 1]
      const dx = next.x - curr.x
      const dy = next.y - curr.y
      const l = Math.hypot(dx, dy)
      if (l > 1e-9) tangents.push({ tx: dx / l, ty: dy / l })
    }
    if (tangents.length === 0) continue

    // 平均接線ベクトル
    const avgTx = tangents.reduce((s, t) => s + t.tx, 0) / tangents.length
    const avgTy = tangents.reduce((s, t) => s + t.ty, 0) / tangents.length
    const avgLen = Math.hypot(avgTx, avgTy)
    if (avgLen < 1e-9) continue
    const tx = avgTx / avgLen
    const ty = avgTy / avgLen

    // 法線（左手方向）: tangent を +90° 回転 = (-ty, tx)
    const nx = -ty
    const ny = tx

    // 両端以外は miter scale（尖った角でオフセットを一定に保つ）
    // miter scale = 1 / cos(angle/2)
    //   cos(angle/2) = 平均接線と片方の接線の内積のうち非負側
    let miter = 1
    if (tangents.length === 2) {
      const cosHalf = Math.abs(tangents[0].tx * tx + tangents[0].ty * ty)
      if (cosHalf > 1e-3) miter = 1 / cosHalf
      // 極端な鋭角は上限を設ける（暴走防止）
      miter = Math.min(miter, 4)
    }

    const offset = halfWidth * miter
    const leftX = curr.x + nx * offset
    const leftY = curr.y + ny * offset
    const rightX = curr.x - nx * offset
    const rightY = curr.y - ny * offset

    leftIdx.push(points.length)
    points.push({ x: leftX, y: leftY, z: curr.z, source, refId })
    rightIdx.push(points.length)
    points.push({ x: rightX, y: rightY, z: curr.z, source, refId })
  }

  // セグメントごとに 2 三角形（quad）を生成
  for (let i = 0; i < leftIdx.length - 1; i++) {
    const L0 = leftIdx[i]
    const L1 = leftIdx[i + 1]
    const R0 = rightIdx[i]
    const R1 = rightIdx[i + 1]
    // Triangle 1: L0, R0, L1
    triangles.push({ a: L0, b: R0, c: L1 })
    // Triangle 2: R0, R1, L1
    triangles.push({ a: R0, b: R1, c: L1 })
  }
}

function planPointsToCenterline(points: PlanPoint[]): CenterlineVertex[] {
  const out: CenterlineVertex[] = []
  for (const p of points) {
    const z = p.plannedHeight ?? p.groundHeight
    if (z == null) continue
    out.push({ x: p.x, y: p.y, z })
  }
  return out
}

// 中心線の終点から distance[m] 上流の点を返す。途中に頂点があればその位置、無ければ補間。
// 戻り値の keepLastIndex は「この点より手前の既存頂点」の最終インデックス（この位置で切り詰める）。
function findPointUpstreamFromEnd(
  pts: CenterlineVertex[],
  distance: number,
): { pos: CenterlineVertex; keepLastIndex: number } | null {
  if (pts.length < 2 || distance <= 0) return null
  let remaining = distance
  for (let i = pts.length - 1; i > 0; i--) {
    const p1 = pts[i]
    const p0 = pts[i - 1]
    const segLen = Math.hypot(p1.x - p0.x, p1.y - p0.y)
    if (remaining <= segLen + 1e-9) {
      const t = (segLen - remaining) / segLen
      return {
        pos: {
          x: p0.x + (p1.x - p0.x) * t,
          y: p0.y + (p1.y - p0.y) * t,
          z: p0.z + (p1.z - p0.z) * t,
        },
        keepLastIndex: i - 1,
      }
    }
    remaining -= segLen
  }
  // 距離が線形全長より長い: 始点を返す
  return { pos: pts[0], keepLastIndex: -1 }
}

interface EndJunctionOptions {
  transitionDistance: number
  /** 相手側（合流先）の片側幅 */
  halfWidthTarget: number
  /** 自分側（合流してくる配管）の片側幅 */
  halfWidthSelf: number
  /** クリアランス（相手縁からの余裕） */
  clearance: number
  /** 合流先の中心線方向（正規化ベクトル）。斜め合流の補正に使用。未指定時は直交と仮定 */
  targetDir?: { dx: number; dy: number } | null
}

/**
 * 中心線の下流端で「擦り付け処理」を行う。
 *  - 終点（junction）の Z を junctionZ に置き換え
 *  - そこから transitionDistance[m] 上流に「縦断変化点」を挿入（元の Z を維持）
 *  - 相手幅 + クリアランス + 斜め合流補正で終点を上流側に戻し、Z は線形補間
 *
 * 斜め合流補正: 合流角 θ（自分の中心線 vs 相手の中心線）において、
 *   自分の床掘の最も相手寄りの角が「相手中心線からの垂直距離 ≥ halfWidthTarget + clearance」
 *   を満たす最小の trim 距離 d は:
 *     d = (halfWidthTarget + clearance + halfWidthSelf * |cos θ|) / |sin θ|
 *   θ=90°（直交）の場合は halfWidthTarget + clearance に一致する。
 */
function applyEndJunctionTransition(
  center: CenterlineVertex[],
  junctionZ: number,
  opts: EndJunctionOptions,
): CenterlineVertex[] {
  if (center.length < 2) return center
  const { transitionDistance, halfWidthTarget, halfWidthSelf, clearance, targetDir } = opts

  const last = center[center.length - 1]
  const secondLast = center[center.length - 2]
  const endDx = last.x - secondLast.x
  const endDy = last.y - secondLast.y
  const endSegLen = Math.hypot(endDx, endDy)
  if (endSegLen < 1e-9) return center
  const dirX = endDx / endSegLen
  const dirY = endDy / endSegLen

  // トリム距離を算出（斜め合流補正あり）
  const baseTrim = halfWidthTarget + clearance
  let trimDistance = baseTrim
  if (targetDir) {
    const tdLen = Math.hypot(targetDir.dx, targetDir.dy)
    if (tdLen > 1e-9) {
      const tx = targetDir.dx / tdLen
      const ty = targetDir.dy / tdLen
      const cosTheta = Math.abs(dirX * tx + dirY * ty)
      const sinTheta = Math.abs(dirX * ty - dirY * tx)
      if (sinTheta > 0.05) {
        trimDistance = (halfWidthTarget + clearance + halfWidthSelf * cosTheta) / sinTheta
      }
    }
  }
  // 変化点距離を超えないよう 80% でクランプ
  if (trimDistance >= transitionDistance) trimDistance = transitionDistance * 0.8

  // 縦断変化点（transitionDistance m 上流）
  const trans = findPointUpstreamFromEnd(center, transitionDistance)
  if (!trans) return center

  // 新しい終点: junction から trimDistance 戻した位置
  const ratio = (transitionDistance - trimDistance) / transitionDistance
  const newEndZ = trans.pos.z + (junctionZ - trans.pos.z) * ratio
  const newEnd: CenterlineVertex = {
    x: last.x - dirX * trimDistance,
    y: last.y - dirY * trimDistance,
    z: newEndZ,
  }

  const result: CenterlineVertex[] = []
  for (let i = 0; i <= trans.keepLastIndex; i++) result.push(center[i])
  if (
    result.length === 0 ||
    Math.hypot(
      result[result.length - 1].x - trans.pos.x,
      result[result.length - 1].y - trans.pos.y,
    ) > 1e-6
  ) {
    result.push(trans.pos)
  }
  result.push(newEnd)
  return result
}

export function buildTrenchTin(opts: TrenchTinOptions): TinSurface {
  const {
    planGroups,
    halfWidth = 0.25,
    includeAbsorption = true,
    includeCollector = true,
    applyTransition = true,
    transitionDistance = 5.0,
    trimClearance = 0.10,
  } = opts

  const points: TinPoint[] = []
  const triangles: TinTriangle[] = []

  for (const group of planGroups) {
    // グループ内の系統別 collector 点列と、各 collectorPoint.id → 方向ベクトルを事前計算
    const systemMap = new Map<number, PlanRow[]>()
    for (const r of group.rows) {
      const idx = r.systemIndex ?? 1
      const arr = systemMap.get(idx) ?? []
      arr.push(r)
      systemMap.set(idx, arr)
    }
    const collectorDirById = new Map<string, { dx: number; dy: number }>()
    const collectorPointsBySystem = new Map<number, PlanPoint[]>()
    for (const [sysIdx, rows] of systemMap) {
      const cps: PlanPoint[] = []
      for (const r of rows) {
        if (r.collectorPoint) cps.push(r.collectorPoint)
      }
      collectorPointsBySystem.set(sysIdx, cps)
      for (let i = 0; i < cps.length; i++) {
        let dx = 0
        let dy = 0
        if (i > 0 && i < cps.length - 1) {
          dx = cps[i + 1].x - cps[i - 1].x
          dy = cps[i + 1].y - cps[i - 1].y
        } else if (i === 0 && cps.length > 1) {
          dx = cps[i + 1].x - cps[i].x
          dy = cps[i + 1].y - cps[i].y
        } else if (i === cps.length - 1 && cps.length > 1) {
          dx = cps[i].x - cps[i - 1].x
          dy = cps[i].y - cps[i - 1].y
        }
        const len = Math.hypot(dx, dy)
        if (len > 1e-9) collectorDirById.set(cps[i].id, { dx: dx / len, dy: dy / len })
      }
    }

    // 吸水管: 各行ごと。下流端で集水との合流擦り付け
    if (includeAbsorption) {
      for (const row of group.rows) {
        if (!row.absorptionPipeId) continue
        const center = planPointsToCenterline(row.absorptionPoints)
        if (center.length < 2) continue

        let adjusted = center
        if (applyTransition && row.collectorPoint?.plannedHeight != null) {
          const targetDir = collectorDirById.get(row.collectorPoint.id) ?? null
          adjusted = applyEndJunctionTransition(
            center,
            row.collectorPoint.plannedHeight,
            {
              transitionDistance,
              halfWidthTarget: halfWidth,
              halfWidthSelf: halfWidth,
              clearance: trimClearance,
              targetDir,
            },
          )
        }
        addRibbon(points, triangles, adjusted, halfWidth, 'plan', row.absorptionPipeId)
      }
    }

    // 集水管: 系統ごとに collectorPoint を連結。系統合流端で擦り付け
    if (includeCollector) {
      for (const [sysIdx, rows] of systemMap) {
        const cps = collectorPointsBySystem.get(sysIdx) ?? []
        const center = planPointsToCenterline(cps)
        if (center.length < 2) continue

        let adjusted = center
        const lastRow = rows[rows.length - 1]
        if (
          applyTransition &&
          lastRow?.systemEndType === 'merge' &&
          lastRow.collectorPoint?.plannedHeight != null
        ) {
          // 合流先系統（mergeSystemIndex）の collector 方向を探す
          let targetDir: { dx: number; dy: number } | null = null
          if (lastRow.mergeSystemIndex != null) {
            // 同じグループ内か、別グループも含めて mergeSystemIndex のシステムを探す
            const otherSys = systemMap.get(lastRow.mergeSystemIndex)
            if (otherSys) {
              // 合流点座標に最も近い collector 点の方向を採用
              const mergePt = lastRow.collectorPoint
              let best: { id: string; d: number } | null = null
              for (const r of otherSys) {
                if (!r.collectorPoint) continue
                const d = Math.hypot(
                  r.collectorPoint.x - mergePt.x,
                  r.collectorPoint.y - mergePt.y,
                )
                if (!best || d < best.d) best = { id: r.collectorPoint.id, d }
              }
              if (best) targetDir = collectorDirById.get(best.id) ?? null
            }
            // 別グループも探索
            if (!targetDir) {
              for (const otherGroup of planGroups) {
                if (otherGroup === group) continue
                for (const r of otherGroup.rows) {
                  if (r.systemIndex !== lastRow.mergeSystemIndex) continue
                  if (!r.collectorPoint) continue
                  const d = Math.hypot(
                    r.collectorPoint.x - lastRow.collectorPoint.x,
                    r.collectorPoint.y - lastRow.collectorPoint.y,
                  )
                  if (d < 0.5) {
                    // 近傍の点を見つけたので、その周辺から方向を取る
                    const idx = otherGroup.rows.indexOf(r)
                    const prev = otherGroup.rows[idx - 1]?.collectorPoint
                    const next = otherGroup.rows[idx + 1]?.collectorPoint
                    if (prev && next) {
                      const ddx = next.x - prev.x
                      const ddy = next.y - prev.y
                      const len = Math.hypot(ddx, ddy)
                      if (len > 1e-9) targetDir = { dx: ddx / len, dy: ddy / len }
                    }
                    break
                  }
                }
                if (targetDir) break
              }
            }
          }
          adjusted = applyEndJunctionTransition(center, lastRow.collectorPoint.plannedHeight, {
            transitionDistance,
            halfWidthTarget: halfWidth,
            halfWidthSelf: halfWidth,
            clearance: trimClearance,
            targetDir,
          })
        }
        addRibbon(points, triangles, adjusted, halfWidth, 'plan', `col-${sysIdx}`)
      }
    }
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
