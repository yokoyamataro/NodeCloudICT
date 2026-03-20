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
import { generatePipeMesh, mergeMeshes, applyTransition } from '@/utils/landxml/triangulation'
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
      const pipeLines: {
        pipeId: string
        pipeNumber: string
        pipeType: 'absorption' | 'collector'
        vertices: Point3D[]
        mergePointId: string | null
      }[] = []

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

      if (pipeLines.length === 0) {
        setError('計画高が設定された配管データがありません。施工計画で計画高を入力してください。')
        setGenerating(false)
        return
      }

      // 合流点を検出
      const mergePoints: { x: number; y: number; z: number; connectedPipes: string[] }[] = []
      const endPoints: { pipeId: string; point: Point3D }[] = []

      for (const pipe of pipeLines) {
        if (pipe.vertices.length > 0) {
          const lastVertex = pipe.vertices[pipe.vertices.length - 1]
          endPoints.push({ pipeId: pipe.pipeId, point: lastVertex })
        }
      }

      const processed = new Set<string>()
      for (let i = 0; i < endPoints.length; i++) {
        if (processed.has(endPoints[i].pipeId)) continue

        const nearby: typeof endPoints = [endPoints[i]]
        processed.add(endPoints[i].pipeId)

        for (let j = i + 1; j < endPoints.length; j++) {
          if (processed.has(endPoints[j].pipeId)) continue

          const dist = distance2D(endPoints[i].point, endPoints[j].point)
          if (dist < 0.5) {
            nearby.push(endPoints[j])
            processed.add(endPoints[j].pipeId)
          }
        }

        if (nearby.length > 1) {
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

      // 擦り付け処理を適用
      const adjustedPipeLines = pipeLines.map(pipe => {
        let vertices = [...pipe.vertices]

        for (const merge of mergePoints) {
          if (!merge.connectedPipes.includes(pipe.pipeId)) continue

          if (vertices.length > 0) {
            const endPoint = vertices[vertices.length - 1]
            const distToMerge = distance2D(endPoint, merge)

            if (distToMerge < 0.5 && endPoint.z > merge.z + 0.001) {
              vertices = applyTransition(vertices, merge.z, transitionDistance)
            }
          }
        }

        return { ...pipe, vertices }
      })

      // 吸水管の終端を集水管の幅分だけ手前で止める（重なり防止）
      // 吸水管は集水管に接続するため、集水管の幅の半分だけ手前で終端する
      const trimmedPipeLines = adjustedPipeLines.map(pipe => {
        if (pipe.pipeType !== 'absorption' || pipe.vertices.length < 2) {
          return pipe
        }

        // 終端点を確認
        const lastIdx = pipe.vertices.length - 1
        const lastVertex = pipe.vertices[lastIdx]
        const prevVertex = pipe.vertices[lastIdx - 1]

        // 集水管との接続点を探す
        const connectedCollector = adjustedPipeLines.find(
          p => p.pipeType === 'collector' &&
            p.vertices.some(v => distance2D(v, lastVertex) < 0.5)
        )

        if (!connectedCollector) {
          return pipe
        }

        // 吸水管の最後のセグメントの方向
        const segmentLen = distance2D(prevVertex, lastVertex)
        if (segmentLen < offsetDistance * 2) {
          return pipe
        }

        // 終端を集水管の幅分（offsetDistance）だけ手前に移動
        const ratio = (segmentLen - offsetDistance) / segmentLen
        const newLastVertex: Point3D = {
          id: lastVertex.id,
          x: prevVertex.x + (lastVertex.x - prevVertex.x) * ratio,
          y: prevVertex.y + (lastVertex.y - prevVertex.y) * ratio,
          z: prevVertex.z + (lastVertex.z - prevVertex.z) * ratio,
        }

        const newVertices = [...pipe.vertices]
        newVertices[lastIdx] = newLastVertex

        return { ...pipe, vertices: newVertices }
      })

      // 各配管のメッシュを生成
      const meshes: { points: Point3D[]; faces: Face[] }[] = []

      for (const pipe of trimmedPipeLines) {
        if (pipe.vertices.length >= 2) {
          const mesh = generatePipeMesh(pipe.vertices, offsetDistance, pipe.pipeId)
          meshes.push(mesh)
        }
      }

      // メッシュを統合
      const surface = mergeMeshes(meshes)

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
