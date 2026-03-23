// LandXMLエクスポート機能

import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { Point3D, Face } from './types'
import {
  generatePipeMesh,
  mergeMeshes,
  detectMergeConnections,
  generateUpstreamMergeTriangles,
  generateCollectorWithMerges,
  generateAbsorptionMergeTriangles,
  type MergeConnection,
  type UpstreamMergeInfo,
  type MidMergeInfoWithSegment,
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
            // vertices[0]が最上流、vertices[length-1]が最下流（集水管接合点）
            for (const abs of [leftAbs, rightAbs]) {
              // 下流端（集水管接合点）からの累積距離を計算
              // 擦り付け点は下流端からtransitionDistance（5m）の位置
              let cumDist = 0
              let transitionIdx = -1

              // 下流から上流に向かって距離を累積
              for (let i = abs.vertices.length - 1; i > 0; i--) {
                cumDist += distance2D(abs.vertices[i], abs.vertices[i - 1])
                if (cumDist >= transitionDistance) {
                  transitionIdx = i - 1
                  break
                }
              }

              // 擦り付け点より上流の頂点を収集（vertices[0]からtransitionIdxまで）
              if (transitionIdx > 0) {
                const upperVertices = abs.vertices.slice(0, transitionIdx + 1)
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
      // 新アルゴリズム: 集水管メッシュを合流点で分割し、頂点を共有
      const midMergeInfos: MidMergeInfoWithSegment[] = []

      for (const mergeInfo of mergeInfos) {
        const { conn, segmentIndex, t } = mergeInfo
        const absorption = absorptionPipes.find(p => p.pipeId === conn.absorptionPipeId)
        if (!absorption || absorption.vertices.length < 2) continue
        if (processedAbsorptionIds.has(absorption.pipeId)) continue

        // 中間合流情報を構築
        // col1A: 下流側、col1B: 合流点、col1C: 上流側
        const col1A = collector.vertices[segmentIndex]
        const col1B = conn.mergePoint
        const col1C = collector.vertices[segmentIndex + 1]

        midMergeInfos.push({
          absorptionPipeId: absorption.pipeId,
          collectorPipeId: collector.pipeId,
          col1A,
          col1B,
          col1C,
          abs2A: absorption.vertices[absorption.vertices.length - 1], // 下流（集水管に近い側）
          abs2B: absorption.vertices[absorption.vertices.length - 2], // 上流側
          mergeFromLeft: conn.mergeFromLeft,
          mergeZ: conn.mergePoint.z,
          segmentIndex,
          t,
        })
      }

      // 中間合流のみの場合（最上流部合流がなかった場合）
      const hadUpstreamMerge = upstreamMerges.length >= 2

      if (midMergeInfos.length > 0) {
        // 中間合流がある場合、集水管メッシュを合流点対応で生成
        const collectorVertices = hadUpstreamMerge
          ? collector.vertices.slice(0, -1) // 最上流部は別処理済み
          : collector.vertices

        const { collectorMesh, mergeVertices } = generateCollectorWithMerges(
          collectorVertices,
          collector.pipeId,
          midMergeInfos,
          offsetDistance
        )
        meshes.push(collectorMesh)

        // 各吸水管の合流三角形と上流部メッシュを生成
        for (const midMerge of midMergeInfos) {
          const absorption = absorptionPipes.find(p => p.pipeId === midMerge.absorptionPipeId)
          if (!absorption || absorption.vertices.length < 2) continue

          const collMergeVerts = mergeVertices.get(midMerge.absorptionPipeId)
          if (!collMergeVerts) continue

          const {
            mergeTriangles,
            upperVertices,
            transitionPointLeft,
            transitionPointRight,
          } = generateAbsorptionMergeTriangles(
            absorption.vertices,
            absorption.pipeId,
            collMergeVerts,
            midMerge.mergeFromLeft,
            offsetDistance,
            transitionDistance
          )

          meshes.push(mergeTriangles)

          // 上流部分の通常メッシュを生成
          if (upperVertices.length >= 2) {
            const upperMesh = generatePipeMesh(upperVertices, offsetDistance, absorption.pipeId + '_upper')
            // 擦り付け点の頂点を上流メッシュの最終頂点と接続する三角形を追加
            const lastUpperLeftId = `${absorption.pipeId}_upper_L${upperVertices.length - 1}`
            const lastUpperRightId = `${absorption.pipeId}_upper_R${upperVertices.length - 1}`

            // 上流メッシュと擦り付け点を接続する三角形
            upperMesh.points.push(transitionPointLeft, transitionPointRight)
            upperMesh.faces.push({
              p1: lastUpperLeftId,
              p2: lastUpperRightId,
              p3: transitionPointLeft.id,
            })
            upperMesh.faces.push({
              p1: lastUpperRightId,
              p2: transitionPointRight.id,
              p3: transitionPointLeft.id,
            })

            meshes.push(upperMesh)
          }

          processedAbsorptionIds.add(absorption.pipeId)
        }
      } else if (!hadUpstreamMerge) {
        // 中間合流がなく、最上流部合流もない場合は集水管全体をメッシュ化
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
