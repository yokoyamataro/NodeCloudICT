import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Ruler,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Trash2,
  ChevronDown,
  ChevronRight,
  Map as MapIcon,
  Settings,
  Calculator,
  Maximize2,
  X,
  FileSpreadsheet,
  Mountain,
} from 'lucide-react'
import { HydraulicCalcModal } from './HydraulicCalcModal'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { usePipeWiringStore } from '@/stores/pipeWiringStore'
import {
  useConstructionPlanStore,
  type PlanRow,
  type PlanPoint,
  type AutoCalcParams,
} from '@/stores/constructionPlanStore'
import { PipeMap } from '@/components/map/PipeMap'
import { CrossSectionChart } from '@/components/charts/CrossSectionChart'

export function DepthCalcPage() {
  const { currentFarm } = useFarmStore()
  const { fetchPipes, pipes } = useUnderdrainStore()
  const { fetchSurveyData } = useSurveyStore()
  const { fetchWiring } = usePipeWiringStore()

  // 管路ID → 管路番号のルックアップ
  const pipeNumberById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pipes) map.set(p.id, p.number)
    return map
  }, [pipes])
  const {
    planGroups,
    loading,
    saving,
    error,
    hasData,
    fetchPlan,
    generatePlanFromWiring,
    reloadGroundHeights,
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

  // 行ごとの折りたたみ状態（地盤高より下の行を隠す）
  const [collapsedRows, setCollapsedRows] = useState<Set<string>>(new Set())

  // 全画面表示パネル
  const [fullscreenPanel, setFullscreenPanel] = useState<'table' | 'map' | 'chart' | null>(null)

  // 水理計算書モーダル
  const [showHydraulicModal, setShowHydraulicModal] = useState(false)

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

  // --- 逆勾配チェック ---

  // 吸水の逆勾配インデックス: 隣接する2点 (i, i+1) で上流(i)の計画高が下流(i+1)より低い場合、
  // 両方のインデックスをエラーとして返す。
  const getAbsorptionReverseIndices = useCallback((points: PlanPoint[]): Set<number> => {
    const errs = new Set<number>()
    for (let i = 0; i < points.length - 1; i++) {
      const up = points[i].plannedHeight
      const dn = points[i + 1].plannedHeight
      if (up === null || dn === null) continue
      if (up < dn) {
        errs.add(i)
        errs.add(i + 1)
      }
    }
    return errs
  }, [])

  // 合流点（行内）逆勾配: 集水側の計画高が吸水下流端の計画高より高い場合 true
  const isCollectorHigherThanAbsorption = useCallback((row: PlanRow): boolean => {
    if (!row.collectorPoint || row.collectorPoint.plannedHeight === null) return false
    if (row.absorptionPoints.length === 0) return false
    const last = row.absorptionPoints[row.absorptionPoints.length - 1]
    if (last.plannedHeight === null) return false
    return row.collectorPoint.plannedHeight > last.plannedHeight
  }, [])

  // 系統内・集水行間の逆勾配: 現在の集水計画高が、同一系統の前行の集水計画高より高い場合 true
  const isCollectorHigherThanPrev = useCallback((row: PlanRow, prevRow: PlanRow | null): boolean => {
    if (!row.collectorPoint || row.collectorPoint.plannedHeight === null) return false
    if (!prevRow?.collectorPoint || prevRow.collectorPoint.plannedHeight === null) return false
    if (row.systemIndex !== prevRow.systemIndex) return false
    return row.collectorPoint.plannedHeight > prevRow.collectorPoint.plannedHeight
  }, [])

  // 全行の逆勾配エラー件数（ヘッダ表示用）
  const reverseSlopeErrorCount = useMemo(() => {
    let count = 0
    for (const group of planGroups) {
      // 系統ごとに行を整理（直落暗渠は1系統扱い）
      const bySystem = new Map<number, PlanRow[]>()
      for (const r of group.rows) {
        const arr = bySystem.get(r.systemIndex) ?? []
        arr.push(r)
        bySystem.set(r.systemIndex, arr)
      }
      for (const rows of bySystem.values()) {
        let prev: PlanRow | null = null
        for (const r of rows) {
          // 吸水逆勾配（隣接ペアごとに 1 件カウント）
          for (let i = 0; i < r.absorptionPoints.length - 1; i++) {
            const up = r.absorptionPoints[i].plannedHeight
            const dn = r.absorptionPoints[i + 1].plannedHeight
            if (up !== null && dn !== null && up < dn) count++
          }
          if (isCollectorHigherThanAbsorption(r)) count++
          if (isCollectorHigherThanPrev(r, prev)) count++
          prev = r
        }
      }
    }
    return count
  }, [planGroups, getAbsorptionReverseIndices, isCollectorHigherThanAbsorption, isCollectorHigherThanPrev])

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

  // 行タイプの日本語ラベル
  const ROW_TYPE_LABELS: Record<string, string> = {
    absorption_end: '吸水端部',
    absorption_merge: '吸水合流',
    collector_merge: '集水合流',
    collector_change: '集水変化点',
    collector_junction: '集水合流点',
    outlet: '落口',
  }

  // 行のレンダリング（系統内の行リストと現在のインデックスを受け取る）
  const renderRow = (row: PlanRow, systemRows: PlanRow[], rowIndexInSystem: number) => {
    const nextRow = rowIndexInSystem < systemRows.length - 1 ? systemRows[rowIndexInSystem + 1] : null
    const prevRow = rowIndexInSystem > 0 ? systemRows[rowIndexInSystem - 1] : null
    const collectorSlope = calcCollectorSlope(row, nextRow)
    const collector = row.collectorPoint
    const isCollapsed = collapsedRows.has(row.id)

    // 逆勾配エラー判定
    const absorptionReverseIdxs = getAbsorptionReverseIndices(row.absorptionPoints)
    const collectorMergeError = isCollectorHigherThanAbsorption(row)
    const collectorPrevError = isCollectorHigherThanPrev(row, prevRow)
    const collectorHasError = collectorMergeError || collectorPrevError
    const collectorPipeNumber = row.collectorPipeId
      ? pipeNumberById.get(row.collectorPipeId) ?? ''
      : ''
    const typeLabel = row.wiringRowType ? ROW_TYPE_LABELS[row.wiringRowType] ?? null : null

    // 系統の終端行（吸水なし）では、配線番号欄に「合流点」「落口」を表示
    const isTerminalCollectorRow = row.isSystemEnd && row.absorptionPoints.length === 0
    const terminalLabel = isTerminalCollectorRow
      ? row.systemEndType === 'merge'
        ? '合流点'
        : row.systemEndType === 'outlet'
          ? '落口'
          : null
      : null

    // 集水合流行の場合、合流先系統の最下流 3 点と末尾集水管の番号を取得
    const isMergeRow = row.mergeSystemIndex !== null && row.mergeSystemIndex !== undefined
    const mergedLast3Points: PlanPoint[] = []
    let refEndPipeNumber: string | null = null
    if (isMergeRow && row.mergeSystemIndex !== null && row.mergeSystemIndex !== undefined) {
      for (const g of planGroups) {
        const targetRows = g.rows.filter(
          (r) => r.systemIndex === row.mergeSystemIndex && r.mergeSystemIndex == null
        )
        if (targetRows.length === 0) continue
        const allCollectorPoints: PlanPoint[] = []
        for (const tr of targetRows) {
          if (tr.collectorPoint) allCollectorPoints.push(tr.collectorPoint)
        }
        if (allCollectorPoints.length === 0) continue
        mergedLast3Points.push(...allCollectorPoints.slice(-3))
        // 合流先系統の末尾集水管番号を取得
        for (let i = targetRows.length - 1; i >= 0; i--) {
          const tr = targetRows[i]
          if (tr.collectorPipeId) {
            refEndPipeNumber = pipeNumberById.get(tr.collectorPipeId) ?? null
            break
          }
        }
        break
      }
    }

    // 集水合流行: 吸水列に合流先系統の最下流 3 点を読み取り専用で表示。集水列は通常編集可。
    if (isMergeRow) {
      const refCount = mergedLast3Points.length
      return (
        <div key={row.id} className="border rounded-lg mb-2 bg-purple-50 overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <colgroup>
              <col className="w-[60px]" />
              <col />
              {mergedLast3Points.map((p) => (
                <col key={p.id} className="w-[70px]" />
              ))}
              <col className="w-3" />
              <col className="w-[90px]" />
              <col className="w-[70px]" />
            </colgroup>
            <thead>
              <tr className="bg-purple-100">
                <th
                  className="px-1.5 py-1 text-left font-medium border whitespace-nowrap text-purple-700"
                  colSpan={refCount > 0 ? 1 : 1}
                >
                  {refEndPipeNumber || row.pipeNumber || '-'}
                  <div className="mt-0.5 text-[10px] text-purple-600 font-normal">集水合流</div>
                </th>
                <th className="border-0 bg-transparent"></th>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <th
                      key={p.id}
                      className="px-1.5 py-1 text-center font-medium border bg-slate-100 text-slate-500 whitespace-nowrap"
                      title={`別系統管理（系統${row.mergeSystemIndex}）`}
                    >
                      {p.pointName || '-'}
                    </th>
                  ))
                ) : (
                  <th className="px-1.5 py-1 text-center font-medium border bg-slate-100 text-slate-400 whitespace-nowrap">
                    別系統管理（系統{row.mergeSystemIndex}）
                  </th>
                )}
                <th className="border-0 bg-transparent"></th>
                <th className="px-1.5 py-1 text-center font-medium border bg-green-50">
                  {collector?.pointName || ''}
                </th>
                <th className="px-1.5 py-1 text-left font-medium border whitespace-nowrap text-emerald-700 bg-green-50">
                  {collectorPipeNumber || '-'}
                </th>
              </tr>
            </thead>
            <tbody>
              {/* 地盤高 */}
              <tr>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">地盤高</td>
                <td className="border-0 bg-transparent"></td>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <td key={p.id} className="px-1.5 py-1 text-center border font-mono bg-slate-100 text-slate-500">
                      {p.groundHeight !== null ? p.groundHeight.toFixed(3) : '-'}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
                <td className="border-0 bg-transparent"></td>
                <td className="px-0.5 py-0.5 border bg-green-50">
                  {collector ? (
                    <input
                      type="number"
                      step="0.001"
                      value={collector.groundHeight ?? ''}
                      onChange={(e) => handleGroundHeightChange(row.id, collector.id, e.target.value)}
                      className="w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded bg-amber-50"
                      placeholder="-"
                    />
                  ) : (
                    <div className="px-0.5 py-0.5 text-center font-mono text-xs text-slate-400">-</div>
                  )}
                </td>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">地盤高</td>
              </tr>
              {/* 計画高 */}
              <tr>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">計画高</td>
                <td className="border-0 bg-transparent"></td>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <td key={p.id} className="px-1.5 py-1 text-center border font-mono bg-slate-100 text-slate-700 font-semibold">
                      {p.plannedHeight !== null ? p.plannedHeight.toFixed(3) : '-'}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
                <td className="border-0 bg-transparent"></td>
                <td
                  className={`px-0.5 py-0.5 border ${collectorHasError ? 'bg-red-100' : 'bg-green-50'}`}
                  title={
                    collectorPrevError ? '逆勾配（集水側の計画高が前の行の集水側より高い）' : undefined
                  }
                >
                  {collector ? (
                    <input
                      type="number"
                      step="0.001"
                      value={formatPlannedHeight(collector.plannedHeight)}
                      onChange={(e) => handlePlannedHeightChange(row.id, collector.id, e.target.value)}
                      className={`w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded ${
                        collectorHasError ? 'text-red-700 border-red-400' : ''
                      }`}
                      placeholder="-"
                    />
                  ) : (
                    <div className="px-0.5 py-0.5 text-center font-mono text-xs text-slate-400">-</div>
                  )}
                </td>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">計画高</td>
              </tr>
              {/* 切深 */}
              <tr>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">切深</td>
                <td className="border-0 bg-transparent"></td>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <td key={p.id} className="px-1.5 py-1 text-center border font-mono bg-slate-100 text-slate-500">
                      {p.cutDepth !== null ? p.cutDepth.toFixed(3) : '-'}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
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
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">切深</td>
              </tr>
              {/* 区間距離 */}
              <tr>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間距離</td>
                <td className="border-0 bg-transparent"></td>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <td key={p.id} className="px-1.5 py-1 text-center border font-mono bg-slate-100 text-slate-500">
                      {p.segmentDistance?.toFixed(2) ?? '-'}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
                <td className="border-0 bg-transparent"></td>
                <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                  {collector?.segmentDistance?.toFixed(2) ?? '-'}
                </td>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間距離</td>
              </tr>
              {/* 区間勾配 */}
              <tr>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間勾配</td>
                <td className="border-0 bg-transparent"></td>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <td key={p.id} className="px-1.5 py-1 text-center border font-mono bg-slate-100 text-slate-500">
                      {p.segmentSlope ?? '-'}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
                <td className="border-0 bg-transparent"></td>
                <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                  {collectorSlope ?? '-'}
                </td>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間勾配</td>
              </tr>
            </tbody>
          </table>
        </div>
      )
    }

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
            <col className="w-[70px]" />
          </colgroup>
          <thead>
            <tr className="bg-slate-100">
              <th
                className={`px-1.5 py-1 text-left font-medium border whitespace-nowrap ${
                  terminalLabel
                    ? row.systemEndType === 'outlet'
                      ? 'text-orange-700'
                      : 'text-purple-700'
                    : 'text-blue-700'
                }`}
              >
                <button
                  type="button"
                  onClick={() => toggleRowCollapsed(row.id)}
                  className="inline-flex items-center gap-1 hover:opacity-80"
                  title={isCollapsed ? '展開' : '折りたたみ'}
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3 w-3" />
                  ) : (
                    <ChevronDown className="h-3 w-3" />
                  )}
                  {terminalLabel ?? row.pipeNumber ?? '-'}
                </button>
                {typeLabel && !terminalLabel && (
                  <div className="mt-0.5 text-[10px] text-slate-500 font-normal">
                    {typeLabel}
                  </div>
                )}
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
              <th
                className={`px-1.5 py-1 text-left font-medium border whitespace-nowrap bg-green-50 ${
                  terminalLabel
                    ? row.systemEndType === 'outlet'
                      ? 'text-orange-700'
                      : 'text-purple-700'
                    : 'text-emerald-700'
                }`}
              >
                {terminalLabel ?? collectorPipeNumber ?? '-'}
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
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    地盤高
                  </td>
                </tr>

                {/* 計画高 */}
                <tr>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    計画高
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map((p, idx) => {
                    const hasError = absorptionReverseIdxs.has(idx)
                    return (
                      <td
                        key={p.id}
                        className={`px-0.5 py-0.5 border ${hasError ? 'bg-red-100' : ''}`}
                        title={hasError ? '逆勾配（上流側の計画高が下流側より低い）' : undefined}
                      >
                        <input
                          type="number"
                          step="0.001"
                          value={formatPlannedHeight(p.plannedHeight)}
                          onChange={e =>
                            handlePlannedHeightChange(row.id, p.id, e.target.value)
                          }
                          className={`w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded ${
                            hasError ? 'text-red-700 border-red-400' : ''
                          }`}
                          placeholder="-"
                        />
                      </td>
                    )
                  })}
                  <td className="border-0 bg-transparent"></td>
                  <td
                    className={`px-0.5 py-0.5 border ${collectorHasError ? 'bg-red-100' : 'bg-green-50'}`}
                    title={
                      collectorMergeError
                        ? '逆勾配（集水側の計画高が吸水側の下流端より高い）'
                        : collectorPrevError
                          ? '逆勾配（集水側の計画高が前の行の集水側より高い）'
                          : undefined
                    }
                  >
                    {collector ? (
                      <input
                        type="number"
                        step="0.001"
                        value={formatPlannedHeight(collector.plannedHeight)}
                        onChange={e =>
                          handlePlannedHeightChange(row.id, collector.id, e.target.value)
                        }
                        className={`w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded ${
                          collectorHasError ? 'text-red-700 border-red-400' : ''
                        }`}
                        placeholder="-"
                      />
                    ) : (
                      <div className="px-0.5 py-0.5 text-center font-mono text-xs text-slate-400">-</div>
                    )}
                  </td>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    計画高
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
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    切深
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
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    区間距離
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
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    区間勾配
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

  // 全グループ × 全系統のフラットなタブリストを計算
  const flatTabs = useMemo(() => {
    const tabs: Array<{
      key: string
      groupIndex: number
      systemIndex: number
      groupName: string
      groupType: 'collector' | 'direct'
      endType: 'outlet' | 'merge' | null
      rows: PlanRow[]
    }> = []
    groupedBySystem.forEach((group, gi) => {
      group.systems.forEach((system) => {
        tabs.push({
          key: `${gi}-${system.systemIndex}`,
          groupIndex: gi,
          systemIndex: system.systemIndex,
          groupName: group.name,
          groupType: group.groupType,
          endType: system.endType,
          rows: system.rows,
        })
      })
    })
    return tabs
  }, [groupedBySystem])

  // タブが読み込まれたら最初のタブをアクティブに（未選択時のみ）
  useEffect(() => {
    if (flatTabs.length === 0) return
    const exists =
      selectedSystem &&
      flatTabs.some(
        (t) =>
          t.groupIndex === selectedSystem.groupIndex && t.systemIndex === selectedSystem.systemIndex
      )
    if (!exists) {
      setSelectedSystem({
        groupIndex: flatTabs[0].groupIndex,
        systemIndex: flatTabs[0].systemIndex,
      })
    }
  }, [flatTabs, selectedSystem])

  // 現在アクティブなタブ
  const activeTab =
    flatTabs.find(
      (t) =>
        selectedSystem != null &&
        t.groupIndex === selectedSystem.groupIndex &&
        t.systemIndex === selectedSystem.systemIndex,
    ) ?? null

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Ruler className="h-5 w-5" />
            施工計画
            {reverseSlopeErrorCount > 0 && (
              <span
                className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full bg-red-100 text-red-700 border border-red-300"
                title="計画高の逆勾配エラーがあります（赤セルを確認してください）"
              >
                <AlertTriangle className="h-3 w-3" />
                逆勾配 {reverseSlopeErrorCount} 件
              </span>
            )}
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
                  {/* 配管系統から系統読込 */}
                  <button
                    onClick={() => setShowGenerateConfirm(true)}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50"
                    title="配管系統から系統を読み込み（地盤高は読み込まれません）"
                  >
                    <RefreshCw className="h-4 w-4" />
                    配管系統から系統読込
                  </button>
                  {/* 地盤高読込 */}
                  <button
                    onClick={() => reloadGroundHeights()}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 bg-sky-600 text-white rounded-lg hover:bg-sky-700 transition-colors disabled:opacity-50"
                    title="測量データから地盤高を読み込み"
                  >
                    <Mountain className="h-4 w-4" />
                    地盤高読込
                  </button>
                  {/* 自動計算設定 */}
                  <button
                    onClick={() => setShowCalcSettings(!showCalcSettings)}
                    className={`flex items-center gap-2 px-3 py-2 border rounded-lg transition-colors ${
                      showCalcSettings
                        ? 'bg-amber-100 border-amber-300 text-amber-700'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                    title="自動切深計画設定"
                  >
                    <Settings className="h-4 w-4" />
                  </button>
                  {/* 自動切深計画 */}
                  <button
                    onClick={handleAutoCalculate}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50"
                    title="計画高を自動計算"
                  >
                    <Calculator className="h-4 w-4" />
                    自動切深計画
                  </button>
                  {/* 水理計算出力 */}
                  <button
                    onClick={() => setShowHydraulicModal(true)}
                    disabled={saving || planGroups.length === 0}
                    className="flex items-center gap-2 px-3 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50"
                    title="水理計算書を作成"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    水理計算出力
                  </button>
                  <div className="w-px h-6 bg-slate-300" />
                  <button
                    onClick={() => currentFarm && fetchPlan(currentFarm.id)}
                    disabled={saving}
                    className="flex items-center gap-2 px-3 py-2 text-slate-600 border rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                    title="データを再読み込み"
                  >
                    <RefreshCw className="h-4 w-4" />
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
                  配管系統から系統読込
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
          <div
            className={
              fullscreenPanel === 'table'
                ? 'fixed inset-0 z-[9999] bg-white p-4 overflow-auto'
                : 'flex-1 overflow-auto p-4 border-r min-h-0 relative'
            }
          >
            {/* 全画面トグルボタン */}
            <button
              type="button"
              onClick={() => setFullscreenPanel(fullscreenPanel === 'table' ? null : 'table')}
              className="absolute top-2 right-2 z-20 p-1.5 rounded border bg-white shadow-sm hover:bg-slate-50"
              title={fullscreenPanel === 'table' ? '全画面を閉じる' : '全画面表示'}
            >
              {fullscreenPanel === 'table' ? (
                <X className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
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
                {/* 1段目: 集水暗渠/直落暗渠タブ */}
                <div className="flex items-end gap-1 border-b border-slate-300 overflow-x-auto">
                  {groupedBySystem.map((group, gi) => {
                    const isActive = selectedSystem?.groupIndex === gi
                    return (
                      <button
                        key={`grp-${gi}`}
                        type="button"
                        onClick={() => {
                          const firstSystem = group.systems[0]
                          if (firstSystem) {
                            setSelectedSystem({
                              groupIndex: gi,
                              systemIndex: firstSystem.systemIndex,
                            })
                          }
                        }}
                        className={`px-4 py-2 text-sm rounded-t-lg border border-b-0 whitespace-nowrap transition-colors ${
                          isActive
                            ? group.groupType === 'direct'
                              ? 'bg-amber-100 border-amber-400 text-amber-900 font-bold'
                              : 'bg-blue-100 border-blue-400 text-blue-900 font-bold'
                            : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-50'
                        }`}
                      >
                        {group.name}
                      </button>
                    )
                  })}
                </div>

                {/* 2段目: 系統タブ */}
                {selectedSystem && groupedBySystem[selectedSystem.groupIndex] && (
                  <div className="flex items-end gap-1 border-b border-slate-200 overflow-x-auto px-2 py-1 bg-slate-50">
                    {groupedBySystem[selectedSystem.groupIndex].systems.map((system) => {
                      const isActive = selectedSystem.systemIndex === system.systemIndex
                      const endLabel =
                        system.endType === 'outlet'
                          ? '落口'
                          : system.endType === 'merge'
                            ? '合流'
                            : null
                      return (
                        <button
                          key={`sys-${system.systemIndex}`}
                          type="button"
                          onClick={() =>
                            setSelectedSystem({
                              groupIndex: selectedSystem.groupIndex,
                              systemIndex: system.systemIndex,
                            })
                          }
                          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-t-lg border border-b-0 whitespace-nowrap transition-colors ${
                            isActive
                              ? system.endType === 'outlet'
                                ? 'bg-orange-100 border-orange-300 text-orange-800 font-medium'
                                : system.endType === 'merge'
                                  ? 'bg-purple-100 border-purple-300 text-purple-800 font-medium'
                                  : 'bg-white border-slate-300 text-slate-800 font-medium'
                              : 'bg-white border-slate-200 text-slate-500 hover:bg-slate-100'
                          }`}
                        >
                          <span>
                            系統{system.systemIndex}
                            {endLabel && `（${endLabel}）`}
                          </span>
                          <span className="text-xs text-slate-500">({system.rows.length})</span>
                        </button>
                      )
                    })}
                  </div>
                )}

                {/* アクティブなタブの内容 */}
                {activeTab ? (
                  <div className="border border-t-0 rounded-b-lg bg-white shadow-sm p-2">
                    {activeTab.rows.map((row, idx) => renderRow(row, activeTab.rows, idx))}
                  </div>
                ) : (
                  <div className="p-8 text-center text-slate-400 text-sm">
                    タブを選択してください
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 右側: 地図 */}
          <div
            className={
              fullscreenPanel === 'map'
                ? 'fixed inset-0 z-[9999] bg-white'
                : 'flex-1 relative'
            }
          >
            <div className="absolute top-2 left-2 z-10 bg-white/90 px-2 py-1 rounded shadow text-sm font-medium flex items-center gap-1">
              <MapIcon className="h-4 w-4" />
              管路マップ
            </div>
            <button
              type="button"
              onClick={() => setFullscreenPanel(fullscreenPanel === 'map' ? null : 'map')}
              className="absolute top-2 right-2 z-20 p-1.5 rounded border bg-white shadow-sm hover:bg-slate-50"
              title={fullscreenPanel === 'map' ? '全画面を閉じる' : '全画面表示'}
            >
              {fullscreenPanel === 'map' ? (
                <X className="h-4 w-4" />
              ) : (
                <Maximize2 className="h-4 w-4" />
              )}
            </button>
            <PipeMap
              selectedPipeId={focusedPipeId}
              focusedPipeId={focusedPipeId}
              showLabels={true}
              showDirection={true}
            />
          </div>
        </div>

        {/* 下部: 断面図エリア */}
        <div
          className={
            fullscreenPanel === 'chart'
              ? 'fixed inset-0 z-[9999] bg-slate-50 flex flex-col'
              : 'h-[280px] flex-shrink-0 border-t bg-slate-50 flex flex-col relative'
          }
        >
          <button
            type="button"
            onClick={() => setFullscreenPanel(fullscreenPanel === 'chart' ? null : 'chart')}
            className="absolute top-2 right-2 z-20 p-1.5 rounded border bg-white shadow-sm hover:bg-slate-50"
            title={fullscreenPanel === 'chart' ? '全画面を閉じる' : '全画面表示'}
          >
            {fullscreenPanel === 'chart' ? (
              <X className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          {/* 断面図表示（タブは上部タブと連動） */}
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
                    chartHeight={fullscreenPanel === 'chart' ? window.innerHeight - 120 : 220}
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

      {/* 水理計算書モーダル */}
      <HydraulicCalcModal
        open={showHydraulicModal}
        onClose={() => setShowHydraulicModal(false)}
        planGroups={planGroups}
        pipes={pipes}
        farm={currentFarm}
      />
    </div>
  )
}
