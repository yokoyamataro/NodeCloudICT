// LandXMLエクスポート機能

import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { Point3D, Face } from './types'
import {
  generatePipeMesh,
  mergeMeshes,
  applyTransition,
  detectMergeConnections,
  insertMergePointsIntoCollector,
  trimAbsorptionToCollectorEdge,
  generateMergeTriangles,
} from './triangulation'
import { generateLandXML, downloadLandXML } from './generator'

// 施工計画データから配管の線形データを抽出
interface PipeLineData {
  pipeId: string
  pipeNumber: string
  pipeType: 'absorption' | 'collector'
  vertices: Point3D[]
  mergePointId: string | null // 合流先の配管ID（集水の場合）
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
  const pipeLines = extractPipeLines(planGroups)

  // 吸水管と集水管を分離
  const absorptionPipes = pipeLines.filter(p => p.pipeType === 'absorption')
  const collectorPipes = pipeLines.filter(p => p.pipeType === 'collector')

  // 合流接続を検出
  const mergeConnections = detectMergeConnections(
    absorptionPipes.map(p => ({ pipeId: p.pipeId, vertices: p.vertices })),
    collectorPipes.map(p => ({ pipeId: p.pipeId, vertices: p.vertices }))
  )

  // 各配管のメッシュを生成
  const meshes: { points: Point3D[]; faces: Face[] }[] = []

  // 集水管のメッシュを生成（合流点を挿入）
  for (const collector of collectorPipes) {
    if (collector.vertices.length < 2) continue

    // この集水管に関連する合流接続
    const relatedConnections = mergeConnections.filter(c => c.collectorPipeId === collector.pipeId)

    if (relatedConnections.length === 0) {
      // 合流点がない場合は通常のメッシュ生成
      const mesh = generatePipeMesh(collector.vertices, offsetDistance, collector.pipeId)
      meshes.push(mesh)
    } else {
      // 合流点を挿入してメッシュを生成
      const { vertices: insertedVertices, mergeOffsetPoints } = insertMergePointsIntoCollector(
        collector.vertices,
        relatedConnections,
        offsetDistance,
        collector.pipeId,
        pipeWidth // 吸水管の幅
      )

      const mesh = generatePipeMesh(insertedVertices, offsetDistance, collector.pipeId)
      meshes.push(mesh)

      // 合流部の処理
      for (const conn of relatedConnections) {
        const offsetPoints = mergeOffsetPoints.get(conn.absorptionPipeId)
        if (!offsetPoints) continue

        // 吸水管を探す
        const absorption = absorptionPipes.find(p => p.pipeId === conn.absorptionPipeId)
        if (!absorption || absorption.vertices.length < 2) continue

        // 吸水管の高さを合流点の高さに擦り付け
        const adjustedAbsVertices = applyTransition(
          absorption.vertices,
          conn.mergePoint.z,
          transitionDistance
        )

        // 吸水管の終端を集水管の端に合わせてトリミング
        const { trimmedVertices, transitionPoint, edgePoint } = trimAbsorptionToCollectorEdge(
          adjustedAbsVertices,
          conn,
          offsetPoints,
          offsetDistance,
          transitionDistance
        )

        // 吸水管のメッシュを生成（トリミング済み、5m手前まで）
        if (trimmedVertices.length >= 2) {
          const absMesh = generatePipeMesh(
            trimmedVertices.slice(0, -1), // 終端点を除く（合流部で処理）
            offsetDistance,
            absorption.pipeId
          )
          meshes.push(absMesh)
        }

        // 合流部の三角形メッシュを生成
        const mergeMesh = generateMergeTriangles(
          absorption.pipeId,
          transitionPoint,
          edgePoint,
          offsetPoints,
          conn.absorptionDirection,
          offsetDistance,
          conn.mergeFromLeft
        )
        meshes.push(mergeMesh)
      }
    }
  }

  // 合流しない吸水管のメッシュを生成
  const connectedAbsorptionIds = new Set(mergeConnections.map(c => c.absorptionPipeId))
  for (const absorption of absorptionPipes) {
    if (connectedAbsorptionIds.has(absorption.pipeId)) continue
    if (absorption.vertices.length < 2) continue

    const mesh = generatePipeMesh(absorption.vertices, offsetDistance, absorption.pipeId)
    meshes.push(mesh)
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
