import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Ruler,
  RefreshCw,
  Save,
  Loader2,
  AlertTriangle,
  Trash2,
  ChevronDown,
  ChevronRight,
  Map,
  Settings,
  Calculator,
} from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { usePipeWiringStore } from '@/stores/pipeWiringStore'
import {
  useConstructionPlanStore,
  type PlanGroup,
  type PlanRow,
  type AutoCalcParams,
} from '@/stores/constructionPlanStore'
import { PipeMap } from '@/components/map/PipeMap'
import { CrossSectionChart } from '@/components/charts/CrossSectionChart'

export function DepthCalcPage() {
  const { currentFarm } = useFarmStore()
  const { fetchPipes } = useUnderdrainStore()
  const { fetchSurveyData } = useSurveyStore()
  const { fetchWiring } = usePipeWiringStore()
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
    updateGroundHeight,
    autoCalculatePlannedHeights,
  } = useConstructionPlanStore()

  // 自動計画高計算パラメータ
  const [calcParams, setCalcParams] = useState<AutoCalcParams>({
    kh: 0.80,  // 吸水渠標準切深
    sh: 0.90,  // 集水渠標準切深
    imin: 600, // 最低勾配
    istd: 550, // 推奨勾配
  })

  // 設定パネルの表示状態
  const [showCalcSettings, setShowCalcSettings] = useState(false)

  // 自動計算実行
  const handleAutoCalculate = useCallback(() => {
    autoCalculatePlannedHeights(calcParams)
  }, [autoCalculatePlannedHeights, calcParams])

  // 展開状態
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())

  // 行ごとの折りたたみ状態（地盤高より下の行を隠す）
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set())

  const toggleRowCollapsed = (rowId: string) => {
    setCollapsedRows((prev) => {
      const next = new Set(prev)
      if (next.has(rowId)) {
        next.delete(rowId)
      } else {
        next.add(rowId)
      }
      return next
    })
  }

  // グループごとのアクティブ系統インデックス
  const [activeSystemByGroup, setActiveSystemByGroup] = useState<Record<string, number>>({})

  // 選択中の管路ID（地図フォーカス用）
  const [focusedPipeId] = useState<string | null>(null)

  // 確認ダイアログ
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false)

  // 選択中の系統（断面図表示用）
  const [selectedSystem, setSelectedSystem] = useState<{
    groupIndex: number
    systemIndex: number
  } | null>(null)

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm) {
      fetchPipes(currentFarm.id)
      fetchSurveyData(currentFarm.id)
      fetchWiring(currentFarm.id)
      fetchPlan(currentFarm.id)
    }
  }, [currentFarm, fetchPipes, fetchSurveyData, fetchWiring, fetchPlan])

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

  // 地盤高の変更ハンドラ
  const handleGroundHeightChange = (
    rowId: string,
    pointId: string,
    value: string
  ) => {
    const numValue = value === '' ? null : parseFloat(value)
    if (value !== '' && isNaN(numValue!)) return
    updateGroundHeight(rowId, pointId, numValue)
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

  // 計画高を3桁で表示するフォーマッタ
  const formatPlannedHeight = (height: number | null): string => {
    if (height === null) return ''
    return height.toFixed(3)
  }

  // 集水の区間勾配を計算（現在の行と次の行の集水計画高の差）
  const calcCollectorSlope = (
    currentRow: PlanRow,
    nextRow: PlanRow | null
  ): string | null => {
    if (!currentRow.collectorPoint || !nextRow?.collectorPoint) return null
    const currentHeight = currentRow.collectorPoint.plannedHeight
    const nextHeight = nextRow.collectorPoint.plannedHeight
    const distance = currentRow.collectorPoint.segmentDistance
    if (currentHeight === null || nextHeight === null || !distance) return null
    const heightDiff = currentHeight - nextHeight
    if (heightDiff === 0) return null
    const slope = Math.abs(distance / heightDiff)
    return `1/${Math.round(slope)}`
  }

  // 行のレンダリング（系統内の行リストと現在のインデックスを受け取る）
  const renderRow = (row: PlanRow, systemRows: PlanRow[], rowIndexInSystem: number) => {
    const nextRow = rowIndexInSystem < systemRows.length - 1 ? systemRows[rowIndexInSystem + 1] : null
    const collectorSlope = calcCollectorSlope(row, nextRow)
    const collector = row.collectorPoint
    const isCollapsed = collapsedRows.has(row.id)

    return (
      <div key={row.id} className="border rounded-lg mb-2 bg-white overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <colgroup>
            <col className="w-[60px]" />
            <col />
            {row.absorptionPoints.map((p) => (
              <col key={p.id} className="w-[70px]" />
            ))}
            <col className="w-3" />
            <col className="w-[90px]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-100">
              <th className="px-1.5 py-1 text-left font-medium border whitespace-nowrap text-blue-700">
                <button
                  type="button"
                  onClick={() => toggleRowCollapsed(row.id)}
                  className="inline-flex items-center gap-1 hover:text-blue-900"
                  title={isCollapsed ? '展開' : '折りたたみ'}
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  {row.pipeNumber || '-'}
                </button>
              </th>
              <th className="border-0 bg-transparent"></th>
              {row.absorptionPoints.map(p => (
                <th
                  key={p.id}
                  className="px-1.5 py-1 text-center font-medium border"
                >
                  {p.pointName}
                </th>
              ))}
              <th className="border-0 bg-transparent"></th>
              <th className="px-1.5 py-1 text-center font-medium border bg-green-50">
                {collector?.pointName || ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {!isCollapsed && (
              <>
                {/* 地盤高 */}
                <tr>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    地盤高
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map(p => (
                    <td key={p.id} className="px-0.5 py-0.5 border">
                      <input
                        type="number"
                        step="0.001"
                        value={p.groundHeight ?? ''}
                        onChange={e =>
                          handleGroundHeightChange(row.id, p.id, e.target.value)
                        }
                        className="w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded bg-amber-50"
                        placeholder="-"
                      />
                    </td>
                  ))}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-0.5 py-0.5 border bg-green-50">
                    {collector ? (
                      <input
                        type="number"
                        step="0.001"
                        value={collector.groundHeight ?? ''}
                        onChange={e =>
                          handleGroundHeightChange(row.id, collector.id, e.target.value)
                        }
                        className="w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded bg-amber-50"
                        placeholder="-"
                      />
                    ) : (
                      <div className="px-0.5 py-0.5 text-center font-mono text-xs text-slate-400">-</div>
                    )}
                  </td>
                </tr>

                {/* 計画高 */}
                <tr>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    計画高
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map(p => (
                    <td key={p.id} className="px-0.5 py-0.5 border">
                      <input
                        type="number"
                        step="0.001"
                        value={formatPlannedHeight(p.plannedHeight)}
                        onChange={e =>
                          handlePlannedHeightChange(row.id, p.id, e.target.value)
                        }
                        className="w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded"
                        placeholder="-"
                      />
                    </td>
                  ))}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-0.5 py-0.5 border bg-green-50">
                    {collector ? (
                      <input
                        type="number"
                        step="0.001"
                        value={formatPlannedHeight(collector.plannedHeight)}
                        onChange={e =>
                          handlePlannedHeightChange(row.id, collector.id, e.target.value)
                        }
                        className="w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded"
                        placeholder="-"
                      />
                    ) : (
                      <div className="px-0.5 py-0.5 text-center font-mono text-xs text-slate-400">-</div>
                    )}
                  </td>
                </tr>

                {/* 切深 */}
                <tr>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    切深
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className={`px-1.5 py-1 text-center border font-mono ${
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
                  <td className="border-0 bg-transparent"></td>
                  <td
                    className={`px-1.5 py-1 text-center border font-mono bg-green-50 ${
                      collector?.cutDepth !== null && collector?.cutDepth !== undefined && collector.cutDepth < 0
                        ? 'text-red-600'
                        : ''
                    }`}
                  >
                    {collector?.cutDepth?.toFixed(3) ?? '-'}
                  </td>
                </tr>

                {/* 区間距離 */}
                <tr>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    区間距離
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className="px-1.5 py-1 text-center border font-mono text-slate-600"
                    >
                      {p.segmentDistance?.toFixed(2) ?? '-'}
                    </td>
                  ))}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                    {collector?.segmentDistance?.toFixed(2) ?? '-'}
                  </td>
                </tr>

                {/* 区間勾配 */}
                <tr>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    区間勾配
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map(p => (
                    <td
                      key={p.id}
                      className="px-1.5 py-1 text-center border font-mono text-slate-600"
                    >
                      {p.segmentSlope ?? '-'}
                    </td>
                  ))}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                    {collectorSlope ?? '-'}
                  </td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    )
  }

  // 系統データ型
  interface SystemData {
    systemIndex: number
    rows: PlanRow[]
    endType: 'outlet' | 'merge' | null
  }

  // 系統ごとにグループ化されたデータを計算
  const groupedBySystem = useMemo(() => {
    return planGroups.map(group => {
      // 系統インデックスごとに行をグループ化
      const systemMap: Record<number, { rows: PlanRow[]; endType: 'outlet' | 'merge' | null }> = {}

      for (const row of group.rows) {
        const systemIndex = row.systemIndex || 1
        if (!systemMap[systemIndex]) {
          systemMap[systemIndex] = { rows: [], endType: null }
        }
        systemMap[systemIndex].rows.push(row)
        if (row.isSystemEnd && row.systemEndType) {
          systemMap[systemIndex].endType = row.systemEndType
        }
      }

      const systems: SystemData[] = Object.entries(systemMap).map(([index, data]) => ({
        systemIndex: parseInt(index),
        rows: data.rows,
        endType: data.endType,
      }))

      return {
        ...group,
        systems,
      }
    })
  }, [planGroups])

  // グループのレンダリング
  const renderGroup = (group: PlanGroup, groupIndex: number) => {
    const isExpanded = expandedGroups.has(group.id)
    const groupData = groupedBySystem[groupIndex]

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
            ({group.rows.length}本 / {groupData?.systems.length || 0}系統)
          </span>
        </div>

        {/* グループの内容（系統ごとにタブ表示） */}
        {isExpanded && groupData && groupData.systems.length > 0 && (() => {
          const activeIdx = activeSystemByGroup[group.id] ?? groupData.systems[0].systemIndex
          const activeSystem =
            groupData.systems.find((s) => s.systemIndex === activeIdx) ?? groupData.systems[0]

          return (
            <div className="mt-2 pl-4">
              {/* タブバー */}
              <div className="flex items-end gap-1 border-b border-slate-200 overflow-x-auto">
                {groupData.systems.map((system) => {
                  const isActive = system.systemIndex === activeSystem.systemIndex
                  const endLabel =
                    system.endType === 'outlet'
                      ? '落口'
                      : system.endType === 'merge'
                        ? '合流'
                        : null
                  return (
                    <button
                      key={`tab-${system.systemIndex}`}
                      type="button"
                      onClick={() =>
                        setActiveSystemByGroup((prev) => ({ ...prev, [group.id]: system.systemIndex }))
                      }
                      className={`flex items-center gap-2 px-3 py-2 text-sm rounded-t-lg border border-b-0 whitespace-nowrap transition-colors ${
                        isActive
                          ? system.endType === 'outlet'
                            ? 'bg-orange-100 border-orange-300 text-orange-800 font-medium'
                            : system.endType === 'merge'
                              ? 'bg-purple-100 border-purple-300 text-purple-800 font-medium'
                              : 'bg-slate-100 border-slate-300 text-slate-700 font-medium'
                          : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                      }`}
                    >
                      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white text-xs font-bold border">
                        {system.systemIndex}
                      </span>
                      <span>
                        系統 {system.systemIndex}
                        {endLabel && ` （${endLabel}）`}
                      </span>
                      <span className="text-xs text-slate-500">({system.rows.length})</span>
                    </button>
                  )
                })}
              </div>

              {/* アクティブ系統の内容 */}
              <div className="border border-t-0 rounded-b-lg bg-white shadow-sm p-2">
                {activeSystem.rows.map((row, idx) => renderRow(row, activeSystem.rows, idx))}
              </div>
            </div>
          )
        })()}
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
                  {/* 自動計算設定 */}
                  <button
                    onClick={() => setShowCalcSettings(!showCalcSettings)}
                    className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${
                      showCalcSettings
                        ? 'bg-amber-100 border-amber-300 text-amber-700'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                    title="自動計算設定"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                  {/* 自動計算ボタン */}
                  <button
                    onClick={handleAutoCalculate}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50"
                    title="計画高を自動計算"
                  >
                    <Calculator className="h-4 w-4" />
                    自動計算
                  </button>
                  <div className="w-px h-6 bg-slate-300" />
                  <button
                    onClick={() => setShowGenerateConfirm(true)}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                    title="配管系統から再生成（現在のデータを上書き）"
                  >
                    <RefreshCw className="h-4 w-4" />
                    配管系統から再生成
                  </button>
                  <button
                    onClick={() => currentFarm && fetchPlan(currentFarm.id)}
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

      {/* 自動計算設定パネル */}
      {showCalcSettings && hasData && (
        <div className="px-4 py-3 border-b bg-amber-50 flex items-center gap-6 text-sm">
          <span className="font-medium text-amber-800">自動計算パラメータ:</span>
          <div className="flex items-center gap-2">
            <label className="text-slate-600">吸水切深 kh:</label>
            <input
              type="number"
              step="0.01"
              value={calcParams.kh}
              onChange={e => setCalcParams(prev => ({ ...prev, kh: parseFloat(e.target.value) || 0 }))}
              className="w-16 px-2 py-1 border rounded text-center font-mono"
            />
            <span className="text-slate-500">m</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-slate-600">集水切深 sh:</label>
            <input
              type="number"
              step="0.01"
              value={calcParams.sh}
              onChange={e => setCalcParams(prev => ({ ...prev, sh: parseFloat(e.target.value) || 0 }))}
              className="w-16 px-2 py-1 border rounded text-center font-mono"
            />
            <span className="text-slate-500">m</span>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-slate-600">最低勾配:</label>
            <span className="text-slate-500">1/</span>
            <input
              type="number"
              step="1"
              value={calcParams.imin}
              onChange={e => setCalcParams(prev => ({ ...prev, imin: parseInt(e.target.value) || 1 }))}
              className="w-16 px-2 py-1 border rounded text-center font-mono"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-slate-600">推奨勾配:</label>
            <span className="text-slate-500">1/</span>
            <input
              type="number"
              step="1"
              value={calcParams.istd}
              onChange={e => setCalcParams(prev => ({ ...prev, istd: parseInt(e.target.value) || 1 }))}
              className="w-16 px-2 py-1 border rounded text-center font-mono"
            />
          </div>
        </div>
      )}

      {/* エラー表示 */}
      {error && (
        <div className="mx-4 mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* メインコンテンツ - 上下分割レイアウト */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* 上部: 表と地図（残りスペースを使用） */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* 左側: 表 */}
          <div className="flex-1 overflow-auto p-4 border-r min-h-0">
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
                {planGroups.map((group, index) => renderGroup(group, index))}
              </div>
            )}
          </div>

          {/* 右側: 地図 */}
          <div className="flex-1 relative">
            <div className="absolute top-2 left-2 z-10 bg-white/90 px-2 py-1 rounded shadow text-sm font-medium flex items-center gap-1">
              <Map className="h-4 w-4" />
              管路マップ
            </div>
            <PipeMap
              selectedPipeId={focusedPipeId}
              focusedPipeId={focusedPipeId}
              showLabels={true}
              showDirection={true}
            />
          </div>
        </div>

        {/* 下部: 断面図エリア（固定高さ） */}
        <div className="h-[280px] flex-shrink-0 border-t bg-slate-50 flex flex-col">
          {/* 系統選択タブ */}
          <div className="flex items-center gap-1 px-2 py-1 bg-slate-100 border-b overflow-x-auto">
            <span className="text-xs text-slate-500 mr-2 whitespace-nowrap">断面図:</span>
            {groupedBySystem.map((group, groupIdx) => (
              group.systems.map(system => (
                <button
                  key={`${groupIdx}-${system.systemIndex}`}
                  onClick={() => setSelectedSystem({ groupIndex: groupIdx, systemIndex: system.systemIndex })}
                  className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${
                    selectedSystem?.groupIndex === groupIdx && selectedSystem?.systemIndex === system.systemIndex
                      ? system.endType === 'outlet'
                        ? 'bg-orange-500 text-white'
                        : system.endType === 'merge'
                          ? 'bg-purple-500 text-white'
                          : 'bg-blue-500 text-white'
                      : system.endType === 'outlet'
                        ? 'bg-orange-100 text-orange-700 hover:bg-orange-200'
                        : system.endType === 'merge'
                          ? 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                          : 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                  }`}
                >
                  {group.name} 系統{system.systemIndex}
                  {system.endType === 'outlet' && '(落口)'}
                  {system.endType === 'merge' && '(合流)'}
                </button>
              ))
            ))}
            {groupedBySystem.length === 0 && (
              <span className="text-xs text-slate-400">系統データがありません</span>
            )}
          </div>

          {/* 断面図表示 */}
          <div className="flex-1 overflow-hidden">
            {selectedSystem ? (
              (() => {
                const groupData = groupedBySystem[selectedSystem.groupIndex]
                const systemData = groupData?.systems.find(s => s.systemIndex === selectedSystem.systemIndex)
                if (!systemData) return <div className="flex items-center justify-center h-full text-slate-400">系統が見つかりません</div>
                return (
                  <CrossSectionChart
                    systemRows={systemData.rows}
                    systemIndex={systemData.systemIndex}
                    endType={systemData.endType}
                  />
                )
              })()
            ) : (
              <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                上のタブから系統を選択して断面図を表示
              </div>
            )}
          </div>
        </div>
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
