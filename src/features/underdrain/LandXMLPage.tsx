import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  FileCode,
  Download,
  Loader2,
  AlertTriangle,
  Eye,
  Settings,
} from 'lucide-react'
import { useProjectStore } from '@/stores/projectStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { LandXMLViewer } from '@/components/viewers/LandXMLViewer'
import {
  generateLandXMLFromPlan,
  downloadLandXML,
} from '@/utils/landxml'
import type { Point3D, Face } from '@/utils/landxml/types'
import {
  generatePipeMesh,
  mergeMeshes,
  detectMergeConnections,
  generateUpstreamMergeTriangles,
  generateCollectorWithMerges,
  generateAbsorptionMergeTriangles,
  type UpstreamMergeInfo,
  type MergeConnection,
  type MidMergeInfoWithSegment,
} from '@/utils/landxml/triangulation'
import { distance2D } from '@/utils/landxml/geometry'

export function LandXMLPage() {
  const { currentProject } = useProjectStore()
  const {
    planGroups,
    loading: planLoading,
    hasData,
    fetchPlan,
  } = useConstructionPlanStore()

  // 設定
  const [pipeWidth, setPipeWidth] = useState(0.6)
  const [transitionDistance, setTransitionDistance] = useState(5.0)
  const [showSettings, setShowSettings] = useState(false)

  // プレビューデータ
  const [previewData, setPreviewData] = useState<{
    points: Map<string, Point3D>
    faces: Face[]
  } | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPlan(currentProject.id)
    }
  }, [currentProject, fetchPlan])

  // プレビューデータを生成
  const generatePreview = useCallback(() => {
    if (!hasData || planGroups.length === 0) {
      setError('施工計画データがありません。先に施工計画を作成してください。')
      return
    }

    setGenerating(true)
    setError(null)

    try {
      const offsetDistance = pipeWidth / 2

      // 配管線形を抽出
      interface PipeLineData {
        pipeId: string
        pipeNumber: string
        pipeType: 'absorption' | 'collector'
        vertices: Point3D[]
        mergePointId: string | null
        systemIndex: number // 系統番号
      }
      const pipeLines: PipeLineData[] = []

      for (const group of planGroups) {
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
                mergePointId: row.collectorPipeId,
                systemIndex,
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
        for (const [sysIdx, system] of systemCollectorMap) {
          if (system.vertices.length >= 2) {
            pipeLines.push({
              pipeId: `collector_system_${group.groupIndex}_${sysIdx}`,
              pipeNumber: `集水${group.groupIndex + 1}-系統${sysIdx}`,
              pipeType: 'collector',
              vertices: system.vertices,
              mergePointId: null,
              systemIndex: sysIdx,
            })
          }
        }
      }

      if (pipeLines.length === 0) {
        setError('計画高が設定された配管データがありません。施工計画で計画高を入力してください。')
        setGenerating(false)
        return
      }

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

      // 施工計画順で各集水管に合流する吸水管をグループ化（最初の2本が最上流部）
      const absorptionsByCollector = new Map<string, PipeLineData[]>()
      for (const abs of absorptionPipes) {
        if (abs.mergePointId) {
          const list = absorptionsByCollector.get(abs.mergePointId) || []
          list.push(abs)
          absorptionsByCollector.set(abs.mergePointId, list)
        }
      }

      // 処理済みの吸水管IDを記録
      const processedAbsorptionIds = new Set<string>()

      // 三管合流の処理回数カウンタ
      let upstreamMergeCount = 0

      // デバッグ: 集水管と吸水管のID対応を確認
      const debugInfo = {
        collectorPipeIds: collectorPipes.map(c => c.pipeId),
        absorptionMergePointIds: absorptionPipes.map(a => ({ pipeId: a.pipeId, mergePointId: a.mergePointId, systemIndex: a.systemIndex })),
        absorptionsByCollectorKeys: Array.from(absorptionsByCollector.keys()),
      }
      alert(`デバッグ情報:\n集水管ID: ${debugInfo.collectorPipeIds.join(', ')}\n\n吸水管mergePointId: ${debugInfo.absorptionMergePointIds.map(a => a.mergePointId).join(', ')}\n\nabsorptionsByCollectorキー: ${debugInfo.absorptionsByCollectorKeys.join(', ')}`)

      // 集水管のメッシュを生成
      for (const collector of collectorPipes) {
        if (collector.vertices.length < 2) continue

        const relatedConnections = connectionsByCollector.get(collector.pipeId) || []
        const relatedAbsorptions = absorptionsByCollector.get(collector.pipeId) || []

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

          // 最上流部: 同じsystemIndexの最初の2本の吸水管を三管合流として処理
          // 集水管のsystemIndexと同じ吸水管をフィルタリング
          const sameSystemAbsorptions = relatedAbsorptions.filter(a => a.systemIndex === collector.systemIndex)
          const upstreamAbsorptions = sameSystemAbsorptions.slice(0, 2)
          let hadUpstreamMerge = false

          if (upstreamAbsorptions.length >= 2) {
            // 最初の2本の吸水管IDを取得
            const upstreamAbsIds = new Set(upstreamAbsorptions.map(a => a.pipeId))
            // 対応するmergeInfoを取得
            const upstreamMergeInfos = mergeInfos.filter(m => upstreamAbsIds.has(m.conn.absorptionPipeId))

            // 左右の吸水管を判別
            const leftMerge = upstreamMergeInfos.find(m => m.conn.mergeFromLeft)
            const rightMerge = upstreamMergeInfos.find(m => !m.conn.mergeFromLeft)

            if (leftMerge && rightMerge) {
              const leftAbs = absorptionPipes.find(p => p.pipeId === leftMerge.conn.absorptionPipeId)
              const rightAbs = absorptionPipes.find(p => p.pipeId === rightMerge.conn.absorptionPipeId)

              if (leftAbs && leftAbs.vertices.length >= 2 && rightAbs && rightAbs.vertices.length >= 2) {
                upstreamMergeCount++
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
                for (const m of upstreamMergeInfos) {
                  const idx = mergeInfos.indexOf(m)
                  if (idx >= 0) mergeInfos.splice(idx, 1)
                }
                hadUpstreamMerge = true
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
            const col1A = collector.vertices[segmentIndex]
            const col1B = conn.mergePoint
            const col1C = collector.vertices[segmentIndex + 1]

            midMergeInfos.push({
              absorptionPipeId: absorption.pipeId,
              collectorPipeId: collector.pipeId,
              col1A,
              col1B,
              col1C,
              abs2A: absorption.vertices[absorption.vertices.length - 1],
              abs2B: absorption.vertices[absorption.vertices.length - 2],
              mergeFromLeft: conn.mergeFromLeft,
              mergeZ: conn.mergePoint.z,
              segmentIndex,
              t,
            })
          }

          if (midMergeInfos.length > 0) {
            // 中間合流がある場合、集水管メッシュを合流点対応で生成
            const collectorVertices = hadUpstreamMerge
              ? collector.vertices.slice(0, -1)
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

      alert(`[LandXML] 三管合流処理: ${upstreamMergeCount}回`)

      setPreviewData({
        points: surface.points,
        faces: surface.faces,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'プレビューの生成に失敗しました')
    } finally {
      setGenerating(false)
    }
  }, [planGroups, hasData, pipeWidth, transitionDistance])

  // 施工計画データが変更されたらプレビューをリセット
  useEffect(() => {
    setPreviewData(null)
  }, [planGroups])

  // LandXMLをエクスポート
  const handleExport = () => {
    if (!previewData) return

    const projectName = currentProject?.name || 'construction_plan'
    const filename = `${projectName}_landxml.xml`
    const xml = generateLandXMLFromPlan(planGroups, {
      pipeWidth,
      transitionDistance,
      projectName,
    })
    downloadLandXML(xml, filename)
  }

  // デバッグ用: 施工計画データをJSONでダウンロード
  const handleExportDebugData = () => {
    const debugData = {
      planGroups: planGroups.map(group => ({
        id: group.id,
        name: group.name,
        groupType: group.groupType,
        groupIndex: group.groupIndex,
        rows: group.rows.map(row => ({
          rowIndex: row.rowIndex,
          pipeNumber: row.pipeNumber,
          absorptionPipeId: row.absorptionPipeId,
          collectorPipeId: row.collectorPipeId,
          systemIndex: row.systemIndex,
          absorptionPoints: row.absorptionPoints.map(p => ({
            pointIndex: p.pointIndex,
            x: p.x,
            y: p.y,
            plannedHeight: p.plannedHeight,
          })),
          collectorPoint: row.collectorPoint ? {
            x: row.collectorPoint.x,
            y: row.collectorPoint.y,
            plannedHeight: row.collectorPoint.plannedHeight,
          } : null,
        })),
      })),
      pipeWidth,
      transitionDistance,
    }

    const blob = new Blob([JSON.stringify(debugData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'landxml_debug_data.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  // 統計情報
  const stats = useMemo(() => {
    if (!previewData) return null

    let minZ = Infinity, maxZ = -Infinity
    for (const p of previewData.points.values()) {
      minZ = Math.min(minZ, p.z)
      maxZ = Math.max(maxZ, p.z)
    }

    return {
      pointCount: previewData.points.size,
      faceCount: previewData.faces.length,
      minZ: minZ === Infinity ? 0 : minZ,
      maxZ: maxZ === -Infinity ? 0 : maxZ,
    }
  }, [previewData])

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <FileCode className="h-5 w-5" />
            LandXML出力
          </h1>
          <p className="text-sm text-muted-foreground">
            施工計画データからLandXML形式のTINサーフェスを生成
          </p>
        </div>
        <div className="flex items-center gap-2">
          {planLoading ? (
            <div className="flex items-center gap-2 px-4 py-2 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              読み込み中...
            </div>
          ) : (
            <>
              <button
                onClick={handleExportDebugData}
                disabled={!hasData}
                className="flex items-center gap-2 px-3 py-2 border rounded-lg text-slate-600 hover:bg-slate-50 transition-colors disabled:opacity-50"
                title="デバッグデータ出力"
              >
                デバッグ出力
              </button>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${
                  showSettings
                    ? 'bg-amber-100 border-amber-300 text-amber-700'
                    : 'text-slate-600 hover:bg-slate-50'
                }`}
                title="設定"
              >
                <Settings className="h-4 w-4" />
              </button>
              <button
                onClick={generatePreview}
                disabled={generating || !hasData}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {generating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
                {generating ? '生成中...' : 'プレビュー生成'}
              </button>
              <button
                onClick={handleExport}
                disabled={!previewData}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors disabled:opacity-50"
              >
                <Download className="h-4 w-4" />
                XMLエクスポート
              </button>
            </>
          )}
        </div>
      </div>

      {/* 設定パネル */}
      {showSettings && (
        <div className="px-4 py-3 border-b bg-amber-50 flex items-center gap-6 text-sm">
          <span className="font-medium text-amber-800">生成設定:</span>
          <div className="flex items-center gap-2">
            <label className="text-slate-600">配管幅:</label>
            <input
              type="number"
              step="0.1"
              value={pipeWidth}
              onChange={e => setPipeWidth(parseFloat(e.target.value) || 0.6)}
              className="w-16 px-2 py-1 border rounded text-center font-mono"
            />
            <span className="text-slate-500">m</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-slate-600">擦り付け距離:</label>
            <input
              type="number"
              step="0.5"
              value={transitionDistance}
              onChange={e => setTransitionDistance(parseFloat(e.target.value) || 5.0)}
              className="w-16 px-2 py-1 border rounded text-center font-mono"
            />
            <span className="text-slate-500">m</span>
          </div>
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 3Dビューアー */}
        <div className="flex-1 p-4 flex flex-col items-center justify-center bg-slate-100">
          {!hasData ? (
            <div className="text-center text-slate-500">
              <FileCode className="h-16 w-16 mx-auto mb-4 text-slate-300" />
              <p className="text-lg font-medium mb-2">施工計画データがありません</p>
              <p className="text-sm">
                先に「施工計画」ページで計画高を設定してください
              </p>
            </div>
          ) : !previewData ? (
            <div className="text-center text-slate-500">
              <Eye className="h-16 w-16 mx-auto mb-4 text-slate-300" />
              <p className="text-lg font-medium mb-2">プレビューを生成</p>
              <p className="text-sm mb-4">
                「プレビュー生成」ボタンをクリックして面データを確認してください
              </p>
              <button
                onClick={generatePreview}
                disabled={generating}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {generating ? '生成中...' : 'プレビュー生成'}
              </button>
            </div>
          ) : (
            <LandXMLViewer
              points={previewData.points}
              faces={previewData.faces}
              width={700}
              height={500}
            />
          )}
        </div>

        {/* 右側: 統計情報 */}
        <div className="w-64 border-l bg-white p-4">
          <h3 className="font-medium text-sm mb-4">サーフェス情報</h3>

          {previewData && stats ? (
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-600">点数:</span>
                <span className="font-mono">{stats.pointCount.toLocaleString()}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600">面数:</span>
                <span className="font-mono">{stats.faceCount.toLocaleString()}</span>
              </div>
              <div className="border-t pt-3 mt-3">
                <div className="flex justify-between mb-1">
                  <span className="text-slate-600">最低高:</span>
                  <span className="font-mono">{stats.minZ.toFixed(3)} m</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600">最高高:</span>
                  <span className="font-mono">{stats.maxZ.toFixed(3)} m</span>
                </div>
              </div>

              <div className="border-t pt-3 mt-3">
                <h4 className="font-medium text-xs text-slate-500 mb-2">配管情報</h4>
                <div className="space-y-1 text-xs">
                  {planGroups.map(group => (
                    <div key={group.id} className="flex justify-between">
                      <span className="text-slate-600">{group.name}:</span>
                      <span>{group.rows.length} 本</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t pt-3 mt-3">
                <h4 className="font-medium text-xs text-slate-500 mb-2">生成設定</h4>
                <div className="space-y-1 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-600">配管幅:</span>
                    <span>{pipeWidth} m</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-600">擦り付け距離:</span>
                    <span>{transitionDistance} m</span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              プレビューを生成すると情報が表示されます
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
