// LandXMLエクスポート機能

import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { Point3D, Face } from './types'
import {
  generatePipeMesh,
  mergeMeshes,
  detectMergeConnections,
  generateMidMergeTrianglesNew,
  generateUpstreamMergeTriangles,
  type MergeConnection,
  type MidMergeInfo,
  type UpstreamMergeInfo,
} from './triangulation'
import { distance2D } from './geometry'
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

  // 合流接続を集水管ごとにグループ化
  const connectionsByCollector = new Map<string, MergeConnection[]>()
  for (const conn of mergeConnections) {
    const list = connectionsByCollector.get(conn.collectorPipeId) || []
    list.push(conn)
    connectionsByCollector.set(conn.collectorPipeId, list)
  }

  // 処理済みの吸水管IDを記録
  const processedAbsorptionIds = new Set<string>()

  // 集水管のメッシュを生成
  for (const collector of collectorPipes) {
    if (collector.vertices.length < 2) continue

    const relatedConnections = connectionsByCollector.get(collector.pipeId) || []

    if (relatedConnections.length === 0) {
      // 合流点がない場合は通常のメッシュ生成
      const mesh = generatePipeMesh(collector.vertices, offsetDistance, collector.pipeId)
      meshes.push(mesh)
    } else {
      // 合流部の処理（新アルゴリズム）
      // 集水管の各セグメントで合流を検出し処理

      // 集水管の合流点位置を特定
      const mergeInfos: {
        conn: MergeConnection
        segmentIndex: number
        t: number // セグメント上の位置
      }[] = []

      for (const conn of relatedConnections) {
        // 合流点がどのセグメントにあるか探す
        for (let i = 0; i < collector.vertices.length - 1; i++) {
          const segStart = collector.vertices[i]
          const segEnd = collector.vertices[i + 1]
          const segLen = distance2D(segStart, segEnd)
          if (segLen < 0.001) continue

          const dx = conn.mergePoint.x - segStart.x
          const dy = conn.mergePoint.y - segStart.y
          const segDirX = (segEnd.x - segStart.x) / segLen
          const segDirY = (segEnd.y - segStart.y) / segLen
          const t = (dx * segDirX + dy * segDirY) / segLen

          if (t >= -0.01 && t <= 1.01) {
            const projX = segStart.x + t * (segEnd.x - segStart.x)
            const projY = segStart.y + t * (segEnd.y - segStart.y)
            const dist = Math.sqrt((conn.mergePoint.x - projX) ** 2 + (conn.mergePoint.y - projY) ** 2)

            if (dist < 0.5) {
              mergeInfos.push({ conn, segmentIndex: i, t: Math.max(0, Math.min(1, t)) })
              break
            }
          }
        }
      }

      // 最上流部（集水管の最後のセグメント端）での合流を検出
      const upstreamMerges = mergeInfos.filter(
        m => m.segmentIndex === collector.vertices.length - 2 && m.t > 0.9
      )

      if (upstreamMerges.length >= 2) {
        // 最上流部で2本以上の吸水管が合流（3管合流）
        // 左右の吸水管を判別
        const leftMerge = upstreamMerges.find(m => m.conn.mergeFromLeft)
        const rightMerge = upstreamMerges.find(m => !m.conn.mergeFromLeft)

        if (leftMerge && rightMerge) {
          const leftAbs = absorptionPipes.find(p => p.pipeId === leftMerge.conn.absorptionPipeId)
          const rightAbs = absorptionPipes.find(p => p.pipeId === rightMerge.conn.absorptionPipeId)

          if (leftAbs && leftAbs.vertices.length >= 2 && rightAbs && rightAbs.vertices.length >= 2) {
            const col1A = collector.vertices[collector.vertices.length - 2]
            const col1B = collector.vertices[collector.vertices.length - 1]

            const upstreamInfo: UpstreamMergeInfo = {
              collectorPipeId: collector.pipeId,
              col1A,
              col1B,
              abs2PipeId: leftAbs.pipeId,
              abs2A: leftAbs.vertices[leftAbs.vertices.length - 1],
              abs2B: leftAbs.vertices[leftAbs.vertices.length - 2],
              abs3PipeId: rightAbs.pipeId,
              abs3A: rightAbs.vertices[rightAbs.vertices.length - 1],
              abs3B: rightAbs.vertices[rightAbs.vertices.length - 2],
              mergeZ: col1B.z,
            }

            const upstreamMesh = generateUpstreamMergeTriangles(
              upstreamInfo,
              offsetDistance,
              transitionDistance
            )
            meshes.push(upstreamMesh)

            processedAbsorptionIds.add(leftAbs.pipeId)
            processedAbsorptionIds.add(rightAbs.pipeId)

            // 集水管の最上流部以外をメッシュ化
            if (collector.vertices.length > 2) {
              const collectorWithoutUpstream = collector.vertices.slice(0, -1)
              const mesh = generatePipeMesh(collectorWithoutUpstream, offsetDistance, collector.pipeId)
              meshes.push(mesh)
            }

            // 吸水管の擦り付け点より上流をメッシュ化
            for (const abs of [leftAbs, rightAbs]) {
              const totalLen = abs.vertices.reduce((sum, v, i) => {
                if (i === 0) return 0
                return sum + distance2D(abs.vertices[i - 1], v)
              }, 0)

              if (totalLen > transitionDistance) {
                // 擦り付け点より上流の頂点を収集
                let cumDist = 0
                const upperVertices: Point3D[] = []
                for (let i = abs.vertices.length - 1; i >= 0; i--) {
                  if (i < abs.vertices.length - 1) {
                    cumDist += distance2D(abs.vertices[i], abs.vertices[i + 1])
                  }
                  if (cumDist >= transitionDistance) {
                    upperVertices.unshift(abs.vertices[i])
                  }
                }
                if (upperVertices.length >= 2) {
                  const mesh = generatePipeMesh(upperVertices, offsetDistance, abs.pipeId + '_upper')
                  meshes.push(mesh)
                }
              }
            }

            // 最上流部で処理した合流をリストから除外
            for (const m of upstreamMerges) {
              const idx = mergeInfos.indexOf(m)
              if (idx >= 0) mergeInfos.splice(idx, 1)
            }
          }
        }
      }

      // 残りの中間合流部を処理
      for (const mergeInfo of mergeInfos) {
        const { conn, segmentIndex } = mergeInfo
        const absorption = absorptionPipes.find(p => p.pipeId === conn.absorptionPipeId)
        if (!absorption || absorption.vertices.length < 2) continue
        if (processedAbsorptionIds.has(absorption.pipeId)) continue

        // 集水管の3点（1A, 1B, 1C）を取得
        const col1B = collector.vertices[segmentIndex + 1] // 合流点に最も近い集水管頂点
        const col1A = collector.vertices[segmentIndex] // 下流側
        const col1C = collector.vertices[Math.min(segmentIndex + 2, collector.vertices.length - 1)] // 上流側

        const midMergeInfo: MidMergeInfo = {
          absorptionPipeId: absorption.pipeId,
          collectorPipeId: collector.pipeId,
          col1A,
          col1B,
          col1C,
          abs2A: absorption.vertices[absorption.vertices.length - 1], // 下流（集水管に近い側）
          abs2B: absorption.vertices[absorption.vertices.length - 2], // 上流側
          mergeFromLeft: conn.mergeFromLeft,
          mergeZ: conn.mergePoint.z,
        }

        const midMergeMesh = generateMidMergeTrianglesNew(
          midMergeInfo,
          offsetDistance,
          transitionDistance
        )
        meshes.push(midMergeMesh)

        processedAbsorptionIds.add(absorption.pipeId)

        // 吸水管の擦り付け点より上流をメッシュ化
        const totalLen = absorption.vertices.reduce((sum, v, i) => {
          if (i === 0) return 0
          return sum + distance2D(absorption.vertices[i - 1], v)
        }, 0)

        if (totalLen > transitionDistance) {
          let cumDist = 0
          const upperVertices: Point3D[] = []
          for (let i = absorption.vertices.length - 1; i >= 0; i--) {
            if (i < absorption.vertices.length - 1) {
              cumDist += distance2D(absorption.vertices[i], absorption.vertices[i + 1])
            }
            if (cumDist >= transitionDistance) {
              upperVertices.unshift(absorption.vertices[i])
            }
          }
          if (upperVertices.length >= 2) {
            const mesh = generatePipeMesh(upperVertices, offsetDistance, absorption.pipeId + '_upper')
            meshes.push(mesh)
          }
        }
      }

      // 合流がない場合、または中間合流の場合は集水管全体をメッシュ化
      if (mergeInfos.length === relatedConnections.length) {
        // すべて中間合流の場合
        const mesh = generatePipeMesh(collector.vertices, offsetDistance, collector.pipeId)
        meshes.push(mesh)
      }
    }
  }

  // 合流しない吸水管のメッシュを生成
  for (const absorption of absorptionPipes) {
    if (processedAbsorptionIds.has(absorption.pipeId)) continue
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
