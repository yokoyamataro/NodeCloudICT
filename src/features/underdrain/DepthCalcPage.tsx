import { useState, useEffect, useMemo } from 'react'
import {
  Ruler,
  RefreshCw,
  Save,
  Loader2,
  AlertTriangle,
  Trash2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { useProjectStore } from '@/stores/projectStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { usePipeWiringStore } from '@/stores/pipeWiringStore'
import {
  useConstructionPlanStore,
  type PlanGroup,
  type PlanRow,
  type PlanPoint,
} from '@/stores/constructionPlanStore'

export function DepthCalcPage() {
  const { currentProject } = useProjectStore()
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { fetchSurveyData } = useSurveyStore()
  const { fetchWiring, hasChanges: wiringHasChanges } = usePipeWiringStore()
  const {
    planGroups,
    loading,
    saving,
    error,
    hasData,
    fetchPlan,
    generatePlanFromWiring,
    savePlan,
    deletePlan,
    updatePlannedHeight,
  } = useConstructionPlanStore()

  // 展開状態
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // 確認ダイアログ
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false)

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPipes(currentProject.id)
      fetchSurveyData(currentProject.id)
      fetchWiring(currentProject.id)
      fetchPlan(currentProject.id)
    }
  }, [currentProject, fetchPipes, fetchSurveyData, fetchWiring, fetchPlan])

  // 全グループを展開
  useEffect(() => {
    if (planGroups.length > 0) {
      setExpandedGroups(new Set(planGroups.map(g => g.id)))
    }
  }, [planGroups])

  // グループの展開/折りたたみ
  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const newSet = new Set(prev)
      if (newSet.has(groupId)) {
        newSet.delete(groupId)
      } else {
        newSet.add(groupId)
      }
      return newSet
    })
  }

  // 行の展開/折りたたみ
  const toggleRow = (rowId: string) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev)
      if (newSet.has(rowId)) {
        newSet.delete(rowId)
      } else {
        newSet.add(rowId)
      }
      return newSet
    })
  }

  // 計画高の変更ハンドラ
  const handlePlannedHeightChange = (
    rowId: string,
    pointId: string,
    value: string
  ) => {
    const numValue = value === '' ? null : parseFloat(value)
    if (value !== '' && isNaN(numValue!)) return
    updatePlannedHeight(rowId, pointId, numValue)
  }

  // 施工計画を生成
  const handleGenerate = async () => {
    setShowGenerateConfirm(false)
    await generatePlanFromWiring()
  }

  // 施工計画を削除
  const handleDelete = async () => {
    setShowDeleteConfirm(false)
    await deletePlan()
  }

  // 行のレンダリング
  const renderRow = (row: PlanRow, groupId: string) => {
    const isExpanded = expandedRows.has(row.id)

    return (
      <div key={row.id} className="border rounded-lg mb-2 bg-white">
        {/* 行ヘッダー */}
        <div
          className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-slate-50"
          onClick={() => toggleRow(row.id)}
        >
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-slate-400" />
          )}
          <div className="flex-1">
            <span className="font-medium text-blue-700">吸水</span>
            <span className="ml-2 font-mono">{row.pipeNumber || '-'}</span>
            {row.diameter && (
              <span className="ml-2 text-sm text-slate-500">
                管径: {row.diameter}mm
              </span>
            )}
            {row.designLength && (
              <span className="ml-2 text-sm text-slate-500">
                設計延長: {row.designLength.toFixed(1)}m
              </span>
            )}
          </div>
        </div>

        {/* 行の詳細（展開時） */}
        {isExpanded && (
          <div className="border-t px-4 py-3 overflow-x-auto">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="bg-slate-100">
                  <th className="px-2 py-1.5 text-left font-medium border">項目</th>
                  {row.absorptionPoints.map(p => (
                    <th
                      key={p.id}
                      className="px-2 py-1.5 text-center font-medium border min-w-[80px]"
                    >
                      {p.pointName}
                    </th>
                  ))}
                  {row.collectorPoint && (
                    <th className="px-2 py-1.5 text-center font-medium border min-w-[80px] bg-green-50">
                      {row.collectorPoint.pointName}
                      <div className="text-xs text-green-600 font-normal">
                        (集水)
                      </div>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {/* 地盤高 */}
                <tr>
                  <td className="px-2 py-1.5 font-medium border bg-slate-50">
                    地盤高
                  </td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className="px-2 py-1.5 text-center border font-mono"
                    >
                      {p.groundHeight?.toFixed(3) ?? '-'}
                    </td>
                  ))}
                  {row.collectorPoint && (
                    <td className="px-2 py-1.5 text-center border font-mono bg-green-50">
                      {row.collectorPoint.groundHeight?.toFixed(3) ?? '-'}
                    </td>
                  )}
                </tr>

                {/* 計画高 */}
                <tr>
                  <td className="px-2 py-1.5 font-medium border bg-slate-50">
                    計画高
                  </td>
                  {row.absorptionPoints.map(p => (
                    <td key={p.id} className="px-1 py-1 border">
                      <input
                        type="number"
                        step="0.001"
                        value={p.plannedHeight ?? ''}
                        onChange={e =>
                          handlePlannedHeightChange(row.id, p.id, e.target.value)
                        }
                        className="w-full px-1 py-0.5 text-center font-mono text-sm border rounded"
                        placeholder="-"
                      />
                    </td>
                  ))}
                  {row.collectorPoint && (
                    <td className="px-1 py-1 border bg-green-50">
                      <input
                        type="number"
                        step="0.001"
                        value={row.collectorPoint.plannedHeight ?? ''}
                        onChange={e =>
                          handlePlannedHeightChange(
                            row.id,
                            row.collectorPoint!.id,
                            e.target.value
                          )
                        }
                        className="w-full px-1 py-0.5 text-center font-mono text-sm border rounded"
                        placeholder="-"
                      />
                    </td>
                  )}
                </tr>

                {/* 切深 */}
                <tr>
                  <td className="px-2 py-1.5 font-medium border bg-slate-50">
                    切深
                  </td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className={`px-2 py-1.5 text-center border font-mono ${
                        p.cutDepth !== null
                          ? p.cutDepth < 0
                            ? 'text-red-600 bg-red-50'
                            : ''
                          : 'text-slate-400'
                      }`}
                    >
                      {p.cutDepth?.toFixed(3) ?? '-'}
                    </td>
                  ))}
                  {row.collectorPoint && (
                    <td
                      className={`px-2 py-1.5 text-center border font-mono bg-green-50 ${
                        row.collectorPoint.cutDepth !== null &&
                        row.collectorPoint.cutDepth < 0
                          ? 'text-red-600'
                          : ''
                      }`}
                    >
                      {row.collectorPoint.cutDepth?.toFixed(3) ?? '-'}
                    </td>
                  )}
                </tr>

                {/* 区間距離 */}
                <tr>
                  <td className="px-2 py-1.5 font-medium border bg-slate-50">
                    区間距離
                  </td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className="px-2 py-1.5 text-center border font-mono text-slate-600"
                    >
                      {p.segmentDistance?.toFixed(2) ?? '-'}
                    </td>
                  ))}
                  {row.collectorPoint && (
                    <td className="px-2 py-1.5 text-center border font-mono text-slate-600 bg-green-50">
                      {row.collectorPoint.segmentDistance?.toFixed(2) ?? '-'}
                    </td>
                  )}
                </tr>

                {/* 区間勾配 */}
                <tr>
                  <td className="px-2 py-1.5 font-medium border bg-slate-50">
                    区間勾配
                  </td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className="px-2 py-1.5 text-center border font-mono text-slate-600"
                    >
                      {p.segmentSlope ?? '-'}
                    </td>
                  ))}
                  {row.collectorPoint && (
                    <td className="px-2 py-1.5 text-center border font-mono text-slate-600 bg-green-50">
                      {row.collectorPoint.segmentSlope ?? '-'}
                    </td>
                  )}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
    )
  }

  // グループのレンダリング
  const renderGroup = (group: PlanGroup) => {
    const isExpanded = expandedGroups.has(group.id)

    return (
      <div key={group.id} className="mb-4">
        {/* グループヘッダー */}
        <div
          className={`flex items-center gap-3 px-4 py-3 rounded-lg cursor-pointer ${
            group.groupType === 'collector'
              ? 'bg-blue-100 hover:bg-blue-200'
              : 'bg-orange-100 hover:bg-orange-200'
          }`}
          onClick={() => toggleGroup(group.id)}
        >
          {isExpanded ? (
            <ChevronDown className="h-5 w-5" />
          ) : (
            <ChevronRight className="h-5 w-5" />
          )}
          <span className="font-bold text-lg">{group.name}</span>
          <span className="text-sm text-slate-600">
            ({group.rows.length}本)
          </span>
        </div>

        {/* グループの内容 */}
        {isExpanded && (
          <div className="mt-2 pl-4">
            {group.rows.map(row => renderRow(row, group.id))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Ruler className="h-5 w-5" />
            施工計画
          </h1>
          <p className="text-sm text-muted-foreground">
            配管系統から施工計画を作成し、計画高と切深を設定
          </p>
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <div className="flex items-center gap-2 px-4 py-2 text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              読み込み中...
            </div>
          ) : (
            <>
              {hasData ? (
                <>
                  <button
                    onClick={() => currentProject && fetchPlan(currentProject.id)}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 text-slate-600 border rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                    title="データを再読み込み"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                  <button
                    onClick={savePlan}
                    disabled={saving}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {saving ? '保存中...' : '保存'}
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 text-red-600 border border-red-300 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50"
                    title="施工計画を削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowGenerateConfirm(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                  <RefreshCw className="h-4 w-4" />
                  配管系統から生成
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* エラー表示 */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-auto p-4">
        {!hasData ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-500">
            <Ruler className="h-16 w-16 mb-4 text-slate-300" />
            <p className="text-lg font-medium mb-2">施工計画がありません</p>
            <p className="text-sm mb-4">
              配管系統で設定したデータから施工計画を生成します
            </p>
            <button
              onClick={() => setShowGenerateConfirm(true)}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
              配管系統から生成
            </button>
          </div>
        ) : (
          <div>
            {planGroups.map(group => renderGroup(group))}
          </div>
        )}
      </div>

      {/* 生成確認ダイアログ */}
      {showGenerateConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[420px]">
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="h-6 w-6 text-yellow-500" />
              <h3 className="text-lg font-bold">施工計画を生成</h3>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              配管系統で設定したデータから施工計画を生成します。
            </p>
            {hasData && (
              <p className="text-sm text-red-600 mb-4">
                ※ 既存の施工計画データは削除されます
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowGenerateConfirm(false)}
                className="px-4 py-2 border rounded-lg hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleGenerate}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                生成する
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 削除確認ダイアログ */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[420px]">
            <div className="flex items-center gap-3 mb-4">
              <AlertTriangle className="h-6 w-6 text-red-500" />
              <h3 className="text-lg font-bold">施工計画を削除</h3>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              施工計画を削除しますか？この操作は取り消せません。
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-4 py-2 border rounded-lg hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleDelete}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
