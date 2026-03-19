// LandXMLエクスポート機能

import type { PlanGroup, PlanRow, PlanPoint } from '@/stores/constructionPlanStore'
import type { Point3D, TINSurface, Face } from './types'
import { distance2D } from './geometry'
import { generatePipeMesh, mergeMeshes, applyTransition } from './triangulation'
import { generateLandXML, downloadLandXML } from './generator'

// 施工計画データから配管の線形データを抽出
interface PipeLineData {
  pipeId: string
  pipeNumber: string
  pipeType: 'absorption' | 'collector'
  vertices: Point3D[]
  mergePointId: string | null // 合流先の配管ID（集水の場合）
}

// 合流点情報
interface MergeInfo {
  x: number
  y: number
  z: number // 最も低い計画高
  connectedPipes: string[] // 合流する配管ID
}

// 施工計画データから配管線形を抽出
function extractPipeLines(planGroups: PlanGroup[]): PipeLineData[] {
  const pipeLines: PipeLineData[] = []

  for (const group of planGroups) {
    // 系統ごとに集水線形を構築
    const systemCollectorMap = new Map<number, {
      vertices: Point3D[]
      pipeIds: string[]
    }>()

    for (const row of group.rows) {
      const systemIndex = row.systemIndex || 1

      // 吸水線形を追加
      if (row.absorptionPoints.length > 0 && row.absorptionPipeId) {
        const absVertices: Point3D[] = row.absorptionPoints
          .filter(p => p.plannedHeight !== null)
          .map(p => ({
            id: `abs_${row.absorptionPipeId}_${p.pointIndex}`,
            x: p.x,
            y: p.y,
            z: p.plannedHeight!,
          }))

        if (absVertices.length >= 2) {
          pipeLines.push({
            pipeId: row.absorptionPipeId,
            pipeNumber: row.pipeNumber || '',
            pipeType: 'absorption',
            vertices: absVertices,
            mergePointId: row.collectorPipeId, // 集水管への接続
          })
        }
      }

      // 集水点を系統ごとに収集
      if (row.collectorPoint && row.collectorPoint.plannedHeight !== null && row.collectorPipeId) {
        if (!systemCollectorMap.has(systemIndex)) {
          systemCollectorMap.set(systemIndex, {
            vertices: [],
            pipeIds: [],
          })
        }

        const system = systemCollectorMap.get(systemIndex)!
        system.vertices.push({
          id: `col_${row.collectorPipeId}_${row.rowIndex}`,
          x: row.collectorPoint.x,
          y: row.collectorPoint.y,
          z: row.collectorPoint.plannedHeight,
        })
        if (!system.pipeIds.includes(row.collectorPipeId)) {
          system.pipeIds.push(row.collectorPipeId)
        }
      }
    }

    // 系統ごとの集水線形を追加
    for (const [systemIndex, system] of systemCollectorMap) {
      if (system.vertices.length >= 2) {
        pipeLines.push({
          pipeId: `collector_system_${group.groupIndex}_${systemIndex}`,
          pipeNumber: `集水${group.groupIndex + 1}-系統${systemIndex}`,
          pipeType: 'collector',
          vertices: system.vertices,
          mergePointId: null,
        })
      }
    }
  }

  return pipeLines
}

// 合流点を検出
function detectMergePoints(
  pipeLines: PipeLineData[],
  tolerance: number = 0.5
): MergeInfo[] {
  const mergePoints: MergeInfo[] = []

  // 全ての終端点（下流端）を収集
  const endPoints: { pipeId: string; point: Point3D }[] = []

  for (const pipe of pipeLines) {
    if (pipe.vertices.length > 0) {
      const lastVertex = pipe.vertices[pipe.vertices.length - 1]
      endPoints.push({ pipeId: pipe.pipeId, point: lastVertex })
    }
  }

  // 近接する終端点をグループ化
  const processed = new Set<string>()

  for (let i = 0; i < endPoints.length; i++) {
    if (processed.has(endPoints[i].pipeId)) continue

    const nearby: typeof endPoints = [endPoints[i]]
    processed.add(endPoints[i].pipeId)

    for (let j = i + 1; j < endPoints.length; j++) {
      if (processed.has(endPoints[j].pipeId)) continue

      const dist = distance2D(endPoints[i].point, endPoints[j].point)
      if (dist < tolerance) {
        nearby.push(endPoints[j])
        processed.add(endPoints[j].pipeId)
      }
    }

    if (nearby.length > 1) {
      // 最も低い計画高を採用
      const minZ = Math.min(...nearby.map(e => e.point.z))
      const avgX = nearby.reduce((sum, e) => sum + e.point.x, 0) / nearby.length
      const avgY = nearby.reduce((sum, e) => sum + e.point.y, 0) / nearby.length

      mergePoints.push({
        x: avgX,
        y: avgY,
        z: minZ,
        connectedPipes: nearby.map(e => e.pipeId),
      })
    }
  }

  // 吸水と集水の接続点も検出
  for (const pipe of pipeLines) {
    if (pipe.pipeType === 'absorption' && pipe.mergePointId && pipe.vertices.length > 0) {
      const endPoint = pipe.vertices[pipe.vertices.length - 1]

      // 接続先の集水線形を探す
      const collectorPipe = pipeLines.find(
        p => p.pipeType === 'collector' && p.pipeId.includes(pipe.mergePointId!)
      )

      if (collectorPipe && collectorPipe.vertices.length > 0) {
        // 最も近い集水点を探す
        let nearestVertex: Point3D | null = null
        let nearestDist = Infinity

        for (const v of collectorPipe.vertices) {
          const dist = distance2D(endPoint, v)
          if (dist < nearestDist) {
            nearestDist = dist
            nearestVertex = v
          }
        }

        if (nearestVertex && nearestDist < tolerance) {
          // 既存の合流点に追加またはの新規作成
          const existingMerge = mergePoints.find(
            m => distance2D(m, nearestVertex!) < tolerance
          )

          if (existingMerge) {
            if (!existingMerge.connectedPipes.includes(pipe.pipeId)) {
              existingMerge.connectedPipes.push(pipe.pipeId)
            }
            // 低い方の高さを採用
            existingMerge.z = Math.min(existingMerge.z, endPoint.z, nearestVertex.z)
          } else {
            const minZ = Math.min(endPoint.z, nearestVertex.z)
            mergePoints.push({
              x: nearestVertex.x,
              y: nearestVertex.y,
              z: minZ,
              connectedPipes: [pipe.pipeId],
            })
          }
        }
      }
    }
  }

  return mergePoints
}

// 合流点で擦り付け処理を適用
function applyMergeTransitions(
  pipeLines: PipeLineData[],
  mergePoints: MergeInfo[],
  transitionDistance: number = 5.0
): PipeLineData[] {
  const result: PipeLineData[] = []

  for (const pipe of pipeLines) {
    let vertices = [...pipe.vertices]

    // この配管に関係する合流点を探す
    for (const merge of mergePoints) {
      if (!merge.connectedPipes.includes(pipe.pipeId)) continue

      if (vertices.length > 0) {
        const endPoint = vertices[vertices.length - 1]
        const distToMerge = distance2D(endPoint, merge)

        if (distToMerge < 0.5) {
          // この配管の終端が合流点に近い
          if (endPoint.z > merge.z + 0.001) {
            // 計画高が高い場合、擦り付けを適用
            vertices = applyTransition(vertices, merge.z, transitionDistance)
          }
        }
      }
    }

    result.push({
      ...pipe,
      vertices,
    })
  }

  return result
}

// 施工計画データからLandXMLを生成
export function generateLandXMLFromPlan(
  planGroups: PlanGroup[],
  options: {
    pipeWidth?: number // 配管幅（デフォルト: 0.6m）
    transitionDistance?: number // 擦り付け距離（デフォルト: 5m）
    projectName?: string
  } = {}
): string {
  const {
    pipeWidth = 0.6,
    transitionDistance = 5.0,
    projectName = 'Construction Plan',
  } = options

  const offsetDistance = pipeWidth / 2

  // 配管線形を抽出
  let pipeLines = extractPipeLines(planGroups)

  // 合流点を検出
  const mergePoints = detectMergePoints(pipeLines)

  // 擦り付け処理を適用
  pipeLines = applyMergeTransitions(pipeLines, mergePoints, transitionDistance)

  // 各配管のメッシュを生成
  const meshes: { points: Point3D[]; faces: Face[] }[] = []

  for (const pipe of pipeLines) {
    if (pipe.vertices.length >= 2) {
      const mesh = generatePipeMesh(pipe.vertices, offsetDistance, pipe.pipeId)
      meshes.push(mesh)
    }
  }

  // メッシュを統合
  const surface = mergeMeshes(meshes)
  surface.name = projectName

  // LandXMLを生成
  return generateLandXML(surface, projectName)
}

// 施工計画データからLandXMLをエクスポート
export function exportLandXML(
  planGroups: PlanGroup[],
  filename: string = 'construction_plan.xml',
  options: {
    pipeWidth?: number
    transitionDistance?: number
    projectName?: string
  } = {}
): void {
  const xml = generateLandXMLFromPlan(planGroups, options)
  downloadLandXML(xml, filename)
}

// エクスポート
export * from './types'
export * from './geometry'
export * from './triangulation'
export * from './generator'
