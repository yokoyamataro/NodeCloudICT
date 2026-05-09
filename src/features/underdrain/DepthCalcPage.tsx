import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
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
import { exportAllCrossSectionsDxf } from '@/lib/crossSectionDxfExport'

// 区間勾配の任意設定ダイアログ用ターゲット
interface SlopeEditTarget {
  segmentLabel: string // 例: "K13C → K13A"
  distance: number
  currentSlope: string | null
  upstream: { rowId: string; pointId: string; ph: number | null; label: string }
  downstream: { rowId: string; pointId: string; ph: number | null; label: string }
}

// 連続勾配の設定対象（複数区間にわたって一定勾配にする）
interface ContinuousSlopeRow {
  rowId: string
  pointId: string
  label: string
  ph: number | null
  cumulativeDistance: number // 始点からの累積距離（m）
}
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { usePipeWiringStore } from '@/stores/pipeWiringStore'
// generatePlanFromWiring は配管系統ストアの in-memory state を参照する。
// 未保存変更がある場合は saveWiring 後に再取得せず、そのまま生成対象にする。
import {
  useConstructionPlanStore,
  type PlanRow,
  type PlanPoint,
  type AutoCalcParams,
} from '@/stores/constructionPlanStore'
import { PipeMap } from '@/components/map/PipeMap'
import { CrossSectionChart } from '@/components/charts/CrossSectionChart'
import { parseLandXml, type ParsedSurface } from '@/lib/landxml/parser'

export function DepthCalcPage() {
  const { currentFarm } = useFarmStore()
  const { fetchPipes, pipes } = useUnderdrainStore()
  const { fetchSurveyData } = useSurveyStore()
  const { fetchWiring, saveWiring, hasChanges: hasWiringChanges } = usePipeWiringStore()

  // 管路ID → 管路番号のルックアップ
  const pipeNumberById = useMemo(() => {
    const map = new Map<string, string>()
    for (const p of pipes) map.set(p.id, p.number)
    return map
  }, [pipes])

  // 管路ID → 管径のルックアップ
  const pipeDiameterById = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of pipes) {
      if (p.diameter != null) map.set(p.id, p.diameter)
    }
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
    applyManualSlope,
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

  // 全系統 DXF 一括出力用の縦縮尺
  const [allDxfVScale, setAllDxfVScale] = useState<100 | 200 | 500 | 1000>(200)

  // 区間勾配の任意設定ダイアログ
  const [slopeEdit, setSlopeEdit] = useState<SlopeEditTarget | null>(null)

  // 連続勾配ダイアログ（現在アクティブな系統内で複数区間に適用）
  const [continuousOpen, setContinuousOpen] = useState(false)

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


  // 選択中の管路ID（地図フォーカス用 + 情報パネル表示）
  const [focusedPipeId, setFocusedPipeId] = useState<string | null>(null)

  // 上下／左右パネルのリサイズ状態（ドラッグで調整）
  const [tableWidthPct, setTableWidthPct] = useState(50)
  const [bottomHeightPx, setBottomHeightPx] = useState(280)
  const horizontalContainerRef = useRef<HTMLDivElement>(null)
  const mainContainerRef = useRef<HTMLDivElement>(null)
  // 表本文（行が並ぶスクロール領域）への参照。地図クリックでこの中をスクロール。
  const tableContentRef = useRef<HTMLDivElement | null>(null)

  // 確認ダイアログ
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showGenerateConfirm, setShowGenerateConfirm] = useState(false)

  // 選択中の系統（断面図表示用）
  const [selectedSystem, setSelectedSystem] = useState<{
    groupIndex: number
    systemIndex: number
  } | null>(null)

  // 断面図のスコープ（'collector' = 系統全体の集水 / number = 系統内 row index の吸水）
  const [chartScope, setChartScope] = useState<'collector' | number>('collector')
  // 系統が変わったら集水に戻す
  useEffect(() => { setChartScope('collector') }, [selectedSystem?.groupIndex, selectedSystem?.systemIndex])

  // 地図上の管路クリック: 該当の系統タブへ切替・断面スコープを切替・表をスクロール
  const handleMapPipeSelect = useCallback((pipeId: string) => {
    setFocusedPipeId(pipeId)
    // planGroups の中からこの管路を含む行を検索
    let foundGroupIndex = -1
    let foundSystemIndex: number | null = null
    let foundRowId: string | null = null
    let foundRowIdxInSystem = -1
    let foundAsAbsorption = false
    outer: for (let gi = 0; gi < planGroups.length; gi++) {
      const g = planGroups[gi]
      // システム別に行をまとめて、行 index を確実に拾う
      const bySystem = new Map<number, PlanRow[]>()
      for (const r of g.rows) {
        const sys = r.systemIndex ?? 1
        const arr = bySystem.get(sys) ?? []
        arr.push(r)
        bySystem.set(sys, arr)
      }
      // 吸水管としてのマッチを優先（個別の断面が見られる）
      for (const [sysIdx, rows] of bySystem) {
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].absorptionPipeId === pipeId) {
            foundGroupIndex = gi
            foundSystemIndex = sysIdx
            foundRowId = rows[i].id
            foundRowIdxInSystem = i
            foundAsAbsorption = true
            break outer
          }
        }
      }
      // 集水管としてのマッチ（系統全体の集水断面に合わせる）
      for (const [sysIdx, rows] of bySystem) {
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].collectorPipeId === pipeId) {
            foundGroupIndex = gi
            foundSystemIndex = sysIdx
            foundRowId = rows[i].id
            foundRowIdxInSystem = i
            foundAsAbsorption = false
            break outer
          }
        }
      }
    }

    if (foundGroupIndex >= 0 && foundSystemIndex !== null) {
      setSelectedSystem({ groupIndex: foundGroupIndex, systemIndex: foundSystemIndex })
      setChartScope(foundAsAbsorption ? foundRowIdxInSystem : 'collector')
      // 行へスクロール（タブ切替後の DOM 反映を待つ）
      if (foundRowId) {
        const rid = foundRowId
        setTimeout(() => {
          const container = tableContentRef.current
          if (!container) return
          const el = container.querySelector(
            `[data-row-id="${CSS.escape(rid)}"]`,
          ) as HTMLElement | null
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }, 50)
      }
    }
  }, [planGroups])

  // 地図でハイライト表示する管路 ID
  // - 吸水スコープのとき: その吸水管のみ
  // - 集水スコープのとき: 選択中の系統に含まれる全ての集水管・吸水管
  const mapHighlightPipeIds = useMemo<Set<string>>(() => {
    const set = new Set<string>()
    if (!selectedSystem) return set
    const group = planGroups[selectedSystem.groupIndex]
    if (!group) return set
    const rows = group.rows.filter((r) => (r.systemIndex ?? 1) === selectedSystem.systemIndex)
    if (typeof chartScope === 'number') {
      const r = rows[chartScope]
      if (r?.absorptionPipeId) set.add(r.absorptionPipeId)
      return set
    }
    // 系統全体
    for (const r of rows) {
      if (r.absorptionPipeId) set.add(r.absorptionPipeId)
      if (r.collectorPipeId) set.add(r.collectorPipeId)
    }
    return set
  }, [selectedSystem, chartScope, planGroups])

  // LandXML TIN サーフェス（縦断図に断面表示）
  const [tinSurface, setTinSurface] = useState<ParsedSurface | null>(null)
  const [tinSourceFile, setTinSourceFile] = useState<string | null>(null)
  const [tinError, setTinError] = useState<string | null>(null)
  const handleLandXmlLoad = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setTinError(null)
    try {
      const text = await file.text()
      const result = parseLandXml(text, file.name)
      if (result.surfaces.length === 0) {
        setTinError('LandXML 内に TIN サーフェスが見つかりません')
        setTinSurface(null)
        setTinSourceFile(null)
      } else {
        setTinSurface(result.surfaces[0])
        setTinSourceFile(file.name)
      }
    } catch (err) {
      setTinError(err instanceof Error ? err.message : 'LandXML 読込エラー')
    } finally {
      e.target.value = ''
    }
  }

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm) {
      fetchPipes(currentFarm.id)
      fetchSurveyData(currentFarm.id)
      fetchWiring(currentFarm.id)
      fetchPlan(currentFarm.id)
    }
  }, [currentFarm, fetchPipes, fetchSurveyData, fetchWiring, fetchPlan])


  // 施工計画を生成
  // 配管系統側に未保存変更がある場合は先に保存して DB と in-memory を一致させる。
  // generatePlanFromWiring は usePipeWiringStore の in-memory state を読むため、
  // 手動で調整した最新の系統内容が確実に反映される。
  const handleGenerate = async () => {
    setShowGenerateConfirm(false)
    if (hasWiringChanges) {
      await saveWiring()
    }
    await generatePlanFromWiring()
  }

  // 施工計画を削除
  const handleDelete = async () => {
    setShowDeleteConfirm(false)
    await deletePlan()
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
  }, [
    planGroups,
    getAbsorptionReverseIndices,
    isCollectorHigherThanAbsorption,
    isCollectorHigherThanPrev,
  ])

  // 集水の区間勾配を計算（現在の行と次の行の集水計画高の差）
  // 手動指定（manualSlope）があればそれを優先する。
  const calcCollectorSlope = (
    currentRow: PlanRow,
    nextRow: PlanRow | null
  ): string | null => {
    if (!currentRow.collectorPoint || !nextRow?.collectorPoint) return null
    if (currentRow.collectorPoint.manualSlope) {
      return currentRow.collectorPoint.manualSlope
    }
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
        <div
          key={row.id}
          data-row-id={row.id}
          data-absorption-pipe-id={row.absorptionPipeId ?? undefined}
          data-collector-pipe-id={row.collectorPipeId ?? undefined}
          className="border rounded-lg mb-2 bg-purple-50 overflow-x-auto"
        >
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
              <tr className="depth-row-ground">
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
                    <HeightInput
                      value={collector.groundHeight}
                      onCommit={(v) => updateGroundHeight(row.id, collector.id, v)}
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
              <tr className="depth-row-planned">
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
                    <HeightInput
                      value={collector.plannedHeight}
                      onCommit={(v) => updatePlannedHeight(row.id, collector.id, v)}
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
              <tr className="depth-row-cut">
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
                      {p.segmentDistance?.toFixed(1) ?? '-'}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
                <td className="border-0 bg-transparent"></td>
                <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                  {collector?.segmentDistance?.toFixed(1) ?? '-'}
                </td>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間距離</td>
              </tr>
              {/* 区間勾配 */}
              <tr className="depth-row-slope">
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間勾配</td>
                <td className="border-0 bg-transparent"></td>
                {refCount > 0 ? (
                  mergedLast3Points.map((p) => (
                    <td key={p.id} className="px-1.5 py-1 text-center border font-mono bg-slate-100 text-slate-500">
                      {p.manualSlope ?? p.segmentSlope ?? "-"}
                    </td>
                  ))
                ) : (
                  <td className="px-1.5 py-1 text-center border bg-slate-100 text-slate-400">-</td>
                )}
                <td className="border-0 bg-transparent"></td>
                <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                  {collector && nextRow?.collectorPoint && collector.segmentDistance && collector.segmentDistance > 0 ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSlopeEdit({
                          segmentLabel: `${collector.pointName || '集水'} → ${nextRow.collectorPoint?.pointName || '集水'}`,
                          distance: collector.segmentDistance!,
                          currentSlope: collectorSlope ?? null,
                          upstream: {
                            rowId: row.id,
                            pointId: collector.id,
                            ph: collector.plannedHeight,
                            label: collector.pointName || '集水',
                          },
                          downstream: {
                            rowId: nextRow.id,
                            pointId: nextRow.collectorPoint!.id,
                            ph: nextRow.collectorPoint!.plannedHeight,
                            label: nextRow.collectorPoint!.pointName || '集水',
                          },
                        })
                      }
                      className="w-full hover:bg-blue-50 rounded px-1 py-0.5 text-blue-700 hover:underline"
                      title="勾配を任意設定"
                    >
                      {collectorSlope ?? '-'}
                    </button>
                  ) : (
                    <span>{collectorSlope ?? '-'}</span>
                  )}
                </td>
                <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">区間勾配</td>
              </tr>
            </tbody>
          </table>
        </div>
      )
    }

    return (
      <div
        key={row.id}
        data-row-id={row.id}
        data-absorption-pipe-id={row.absorptionPipeId ?? undefined}
        data-collector-pipe-id={row.collectorPipeId ?? undefined}
        className="border rounded-lg mb-2 bg-white overflow-x-auto"
      >
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
                <tr className="depth-row-ground">
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    地盤高
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map(p => (
                    <td key={p.id} className="px-0.5 py-0.5 border">
                      <HeightInput
                        value={p.groundHeight}
                        onCommit={(v) => updateGroundHeight(row.id, p.id, v)}
                        className="w-full px-0.5 py-0.5 text-center font-mono text-xs border rounded bg-amber-50"
                        placeholder="-"
                      />
                    </td>
                  ))}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-0.5 py-0.5 border bg-green-50">
                    {collector ? (
                      <HeightInput
                        value={collector.groundHeight}
                        onCommit={(v) => updateGroundHeight(row.id, collector.id, v)}
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
                <tr className="depth-row-planned">
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
                        <HeightInput
                          value={p.plannedHeight}
                          onCommit={(v) => updatePlannedHeight(row.id, p.id, v)}
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
                      <HeightInput
                        value={collector.plannedHeight}
                        onCommit={(v) => updatePlannedHeight(row.id, collector.id, v)}
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
                <tr className="depth-row-cut">
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
                      {p.segmentDistance?.toFixed(1) ?? '-'}
                    </td>
                  ))}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                    {collector?.segmentDistance?.toFixed(1) ?? '-'}
                  </td>
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    区間距離
                  </td>
                </tr>

                {/* 区間勾配 */}
                <tr className="depth-row-slope">
                  <td className="px-1.5 py-1 font-medium border bg-slate-50 whitespace-nowrap">
                    区間勾配
                  </td>
                  <td className="border-0 bg-transparent"></td>
                  {row.absorptionPoints.map((p, idx) => {
                    const prevP = idx > 0 ? row.absorptionPoints[idx - 1] : null
                    const canEdit = prevP != null && p.segmentDistance != null && p.segmentDistance > 0
                    return (
                      <td
                        key={p.id}
                        className="px-1.5 py-1 text-center border font-mono text-slate-600"
                      >
                        {canEdit && prevP ? (
                          <button
                            type="button"
                            onClick={() =>
                              setSlopeEdit({
                                segmentLabel: `${prevP.pointName} → ${p.pointName}`,
                                distance: p.segmentDistance!,
                                currentSlope: p.segmentSlope ?? null,
                                upstream: {
                                  rowId: row.id,
                                  pointId: prevP.id,
                                  ph: prevP.plannedHeight,
                                  label: prevP.pointName,
                                },
                                downstream: {
                                  rowId: row.id,
                                  pointId: p.id,
                                  ph: p.plannedHeight,
                                  label: p.pointName,
                                },
                              })
                            }
                            className="w-full hover:bg-blue-50 rounded px-1 py-0.5 text-blue-700 hover:underline"
                            title="勾配を任意設定"
                          >
                            {p.manualSlope ?? p.segmentSlope ?? "-"}
                          </button>
                        ) : (
                          <span>{p.manualSlope ?? p.segmentSlope ?? "-"}</span>
                        )}
                      </td>
                    )
                  })}
                  <td className="border-0 bg-transparent"></td>
                  <td className="px-1.5 py-1 text-center border font-mono text-slate-600 bg-green-50">
                    {collector && nextRow?.collectorPoint && collector.segmentDistance && collector.segmentDistance > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          setSlopeEdit({
                            segmentLabel: `${collector.pointName || '集水'} → ${nextRow.collectorPoint?.pointName || '集水'}`,
                            distance: collector.segmentDistance!,
                            currentSlope: collectorSlope ?? null,
                            upstream: {
                              rowId: row.id,
                              pointId: collector.id,
                              ph: collector.plannedHeight,
                              label: collector.pointName || '集水',
                            },
                            downstream: {
                              rowId: nextRow.id,
                              pointId: nextRow.collectorPoint!.id,
                              ph: nextRow.collectorPoint!.plannedHeight,
                              label: nextRow.collectorPoint!.pointName || '集水',
                            },
                          })
                        }
                        className="w-full hover:bg-blue-50 rounded px-1 py-0.5 text-blue-700 hover:underline"
                        title="勾配を任意設定"
                      >
                        {collectorSlope ?? '-'}
                      </button>
                    ) : (
                      <span>{collectorSlope ?? '-'}</span>
                    )}
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

  // 全系統の縦断図を 1 つの DXF に一括出力（縦並び）
  const handleAllDxfExport = () => {
    if (flatTabs.length === 0) return
    exportAllCrossSectionsDxf({
      systems: flatTabs.map((t) => ({
        systemRows: t.rows,
        systemIndex: t.systemIndex,
        endType: t.endType,
        groupName: t.groupName,
      })),
      verticalScale: allDxfVScale,
      pipeNumberById,
      pipeDiameterById,
      allPlanGroups: planGroups,
      farmName: currentFarm?.name,
    })
  }

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
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50 whitespace-nowrap"
                    title="配管系統から系統を読み込み（地盤高は読み込まれません）"
                  >
                    <RefreshCw className="h-4 w-4" />
                    系統読込
                  </button>
                  {/* 地盤高読込 */}
                  <button
                    onClick={() => reloadGroundHeights()}
                    disabled={saving}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-sky-600 text-white rounded-lg hover:bg-sky-700 transition-colors disabled:opacity-50 whitespace-nowrap"
                    title="測量データから地盤高を読み込み"
                  >
                    <Mountain className="h-4 w-4" />
                    地盤高
                  </button>
                  {/* 自動計算設定 */}
                  <button
                    onClick={() => setShowCalcSettings(!showCalcSettings)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 border rounded-lg transition-colors ${
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
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50 whitespace-nowrap"
                    title="計画高を自動計算"
                  >
                    <Calculator className="h-4 w-4" />
                    自動計画
                  </button>
                  {/* 連続勾配 */}
                  <button
                    onClick={() => setContinuousOpen(true)}
                    disabled={saving || !selectedSystem}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-cyan-600 text-white rounded-lg hover:bg-cyan-700 transition-colors disabled:opacity-50 whitespace-nowrap"
                    title="複数区間にわたって一定の勾配を設定"
                  >
                    <Ruler className="h-4 w-4" />
                    連続勾配
                  </button>
                  {/* 水理計算出力 */}
                  <button
                    onClick={() => setShowHydraulicModal(true)}
                    disabled={saving || planGroups.length === 0}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 whitespace-nowrap"
                    title="水理計算書を作成"
                  >
                    <FileSpreadsheet className="h-4 w-4" />
                    水理計算
                  </button>
                  {/* 全系統 DXF 一括出力 */}
                  <div className="flex items-center gap-1 px-1.5 py-0.5 border rounded-lg whitespace-nowrap">
                    <span className="text-xs text-slate-600">縦尺</span>
                    <select
                      value={allDxfVScale}
                      onChange={(e) =>
                        setAllDxfVScale(parseInt(e.target.value, 10) as 100 | 200 | 500 | 1000)
                      }
                      className="px-1 py-0.5 text-xs border rounded bg-white"
                    >
                      <option value={100}>1/100</option>
                      <option value={200}>1/200</option>
                      <option value={500}>1/500</option>
                      <option value={1000}>1/1000</option>
                    </select>
                    <button
                      onClick={handleAllDxfExport}
                      disabled={saving || planGroups.length === 0}
                      className="flex items-center gap-1 px-2 py-1 bg-sky-600 text-white rounded hover:bg-sky-700 transition-colors disabled:opacity-50 text-sm"
                      title="全系統の縦断図を 1 つの DXF に縦並びで出力"
                    >
                      <FileSpreadsheet className="h-4 w-4" />
                      DXF
                    </button>
                  </div>
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

      {/* メインコンテンツ - 上下分割レイアウト（ドラッグでサイズ調整可） */}
      <div ref={mainContainerRef} className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* 上部: 表と地図（残りスペースを使用） */}
        <div
          ref={horizontalContainerRef}
          className="flex overflow-hidden min-h-0"
          style={{ flex: '1 1 0', minHeight: 0 }}
        >
          {/* 左側: 表 */}
          <div
            className={
              fullscreenPanel === 'table'
                ? 'fixed inset-0 z-[9999] bg-white p-4 overflow-auto'
                : 'overflow-auto p-4 border-r min-h-0 relative'
            }
            style={
              fullscreenPanel === 'table'
                ? undefined
                : { width: `${tableWidthPct}%`, flexShrink: 0 }
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
                  <div
                    ref={tableContentRef}
                    className="border border-t-0 rounded-b-lg bg-white shadow-sm p-2"
                  >
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

          {/* 縦スプリッタ（左右リサイズ） */}
          {fullscreenPanel === null && (
            <div
              role="separator"
              aria-orientation="vertical"
              onMouseDown={(e) => {
                e.preventDefault()
                const onMove = (ev: MouseEvent) => {
                  const rect = horizontalContainerRef.current?.getBoundingClientRect()
                  if (!rect) return
                  const p = ((ev.clientX - rect.left) / rect.width) * 100
                  setTableWidthPct(Math.max(20, Math.min(80, p)))
                }
                const onUp = () => {
                  window.removeEventListener('mousemove', onMove)
                  window.removeEventListener('mouseup', onUp)
                  document.body.style.cursor = ''
                  document.body.style.userSelect = ''
                }
                document.body.style.cursor = 'col-resize'
                document.body.style.userSelect = 'none'
                window.addEventListener('mousemove', onMove)
                window.addEventListener('mouseup', onUp)
              }}
              className="w-1 cursor-col-resize bg-slate-200 hover:bg-blue-400 active:bg-blue-500 flex-shrink-0 transition-colors"
              title="ドラッグで左右分割を調整"
            />
          )}

          {/* 右側: 地図 */}
          <div
            className={
              fullscreenPanel === 'map'
                ? 'fixed inset-0 z-[9999] bg-white'
                : 'flex-1 relative min-w-0'
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
              highlightPipeIds={mapHighlightPipeIds}
              focusedPipeId={null}
              showLabels={true}
              showDirection={true}
              onPipeSelect={(id) => handleMapPipeSelect(id)}
            />
          </div>
        </div>

        {/* 横スプリッタ（上下リサイズ） */}
        {fullscreenPanel === null && (
          <div
            role="separator"
            aria-orientation="horizontal"
            onMouseDown={(e) => {
              e.preventDefault()
              const onMove = (ev: MouseEvent) => {
                const rect = mainContainerRef.current?.getBoundingClientRect()
                if (!rect) return
                const newH = rect.bottom - ev.clientY
                setBottomHeightPx(Math.max(120, Math.min(rect.height - 120, newH)))
              }
              const onUp = () => {
                window.removeEventListener('mousemove', onMove)
                window.removeEventListener('mouseup', onUp)
                document.body.style.cursor = ''
                document.body.style.userSelect = ''
              }
              document.body.style.cursor = 'row-resize'
              document.body.style.userSelect = 'none'
              window.addEventListener('mousemove', onMove)
              window.addEventListener('mouseup', onUp)
            }}
            className="h-1 cursor-row-resize bg-slate-200 hover:bg-blue-400 active:bg-blue-500 flex-shrink-0 transition-colors"
            title="ドラッグで上下分割を調整"
          />
        )}

        {/* 下部: 断面図エリア */}
        <div
          className={
            fullscreenPanel === 'chart'
              ? 'fixed inset-0 z-[9999] bg-slate-50 flex flex-col'
              : 'flex-shrink-0 border-t bg-slate-50 flex flex-col relative'
          }
          style={fullscreenPanel === 'chart' ? undefined : { height: `${bottomHeightPx}px` }}
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

          {/* LandXML TIN 断面取込 */}
          <div className="absolute top-2 right-12 z-20 flex items-center gap-1">
            <label className="cursor-pointer">
              <input
                type="file"
                accept=".xml,.XML,.landxml,.LANDXML"
                onChange={handleLandXmlLoad}
                className="hidden"
              />
              <span
                className={`px-2 py-1 rounded border bg-white shadow-sm hover:bg-slate-50 text-xs ${tinSurface ? 'text-purple-700 border-purple-400' : ''}`}
                title={tinSurface ? `読込済み: ${tinSourceFile}（クリックで再選択）` : 'LandXML を読み込み TIN 断面を表示'}
              >
                LandXML 断面 {tinSurface ? '✓' : ''}
              </span>
            </label>
            {tinSurface && (
              <button
                type="button"
                onClick={() => { setTinSurface(null); setTinSourceFile(null) }}
                className="px-2 py-1 rounded border bg-white shadow-sm hover:bg-slate-50 text-xs"
                title="TIN 断面をクリア"
              >
                ×
              </button>
            )}
          </div>
          {tinError && (
            <div className="absolute top-12 right-2 z-20 text-xs text-red-600 bg-white border border-red-300 px-2 py-1 rounded shadow">
              {tinError}
            </div>
          )}

          {/* 断面図表示（タブは上部タブと連動） */}
          <div className="flex-1 overflow-hidden flex flex-col">
            {selectedSystem ? (
              (() => {
                const groupData = groupedBySystem[selectedSystem.groupIndex]
                const systemData = groupData?.systems.find(s => s.systemIndex === selectedSystem.systemIndex)
                if (!systemData) return <div className="flex items-center justify-center h-full text-slate-400">系統が見つかりません</div>

                // 吸水を含む行（吸水点が 2 点以上ある行）の一覧
                const absorptionRows = systemData.rows
                  .map((r, i) => ({ row: r, idx: i }))
                  .filter(({ row }) => row.absorptionPoints.length >= 2)

                // 吸水スコープの場合：absorptionPoints から擬似 PlanRow[] を生成して既存 CrossSectionChart に渡す
                let chartRows = systemData.rows
                let chartLabel: string | undefined
                let chartEndCollectorHeight: number | null = null
                if (typeof chartScope === 'number') {
                  const r = systemData.rows[chartScope]
                  if (r && r.absorptionPoints.length >= 2) {
                    // 吸水点の segmentDistance は「前点 → 自点」の距離だが、
                    // CrossSectionChart は collector 規約「自点 → 次点」を期待するため、
                    // 隣の点の segmentDistance を 1 行手前に詰めて渡す。
                    chartRows = r.absorptionPoints.map((p, i) => {
                      const nextPoint = r.absorptionPoints[i + 1]
                      const segDistToNext = nextPoint?.segmentDistance ?? null
                      return {
                        id: `abs-${r.id}-${i}`,
                        wiringRowId: '',
                        groupType: r.groupType,
                        groupIndex: r.groupIndex,
                        rowIndex: i,
                        systemIndex: r.systemIndex,
                        isSystemEnd: i === r.absorptionPoints.length - 1,
                        systemEndType: null,
                        absorptionPipeId: null,
                        collectorPipeId: r.absorptionPipeId,
                        pipeNumber: r.pipeNumber,
                        diameter: r.diameter,
                        designLength: r.designLength,
                        absorptionPoints: [],
                        collectorPoint: { ...p, segmentDistance: segDistToNext },
                        wiringRowType: null,
                      }
                    })
                    chartLabel = `吸水: ${r.pipeNumber ?? '?'}`
                    chartEndCollectorHeight = r.collectorPoint?.plannedHeight ?? null
                  }
                }

                // 断面の前/次ナビゲーション用に選択肢一覧を構築
                const scopeOptions: Array<{
                  value: 'collector' | number
                  label: string
                }> = [
                  {
                    value: 'collector',
                    label: `集水（系統 ${systemData.systemIndex}）`,
                  },
                  ...absorptionRows.map(({ row, idx }) => ({
                    value: idx as number,
                    label: `吸水: ${row.pipeNumber ?? '?'}`,
                  })),
                ]
                const currentIdx = scopeOptions.findIndex(
                  (o) => o.value === chartScope,
                )
                const goPrev = () => {
                  if (currentIdx <= 0) return
                  setChartScope(scopeOptions[currentIdx - 1].value)
                }
                const goNext = () => {
                  if (currentIdx < 0 || currentIdx >= scopeOptions.length - 1) return
                  setChartScope(scopeOptions[currentIdx + 1].value)
                }

                return (
                  <>
                    {/* 断面スコープ切替 */}
                    <div className="px-2 pt-1 pb-1 border-b bg-white flex items-center gap-1 text-xs flex-shrink-0">
                      <span className="text-slate-600 mr-1">断面:</span>
                      <button
                        type="button"
                        onClick={goPrev}
                        disabled={currentIdx <= 0}
                        className="px-2 py-0.5 border rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="前の断面へ"
                      >
                        ◀ 前
                      </button>
                      <select
                        value={typeof chartScope === 'number' ? `abs-${chartScope}` : 'collector'}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === 'collector') setChartScope('collector')
                          else if (v.startsWith('abs-')) setChartScope(parseInt(v.slice(4), 10))
                        }}
                        className="px-2 py-0.5 border rounded"
                      >
                        <option value="collector">集水（系統 {systemData.systemIndex}）</option>
                        {absorptionRows.map(({ row, idx }) => (
                          <option key={row.id} value={`abs-${idx}`}>
                            吸水: {row.pipeNumber ?? '?'}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={goNext}
                        disabled={currentIdx < 0 || currentIdx >= scopeOptions.length - 1}
                        className="px-2 py-0.5 border rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                        title="次の断面へ"
                      >
                        次 ▶
                      </button>
                      <span className="text-[10px] text-slate-400 ml-1">
                        {currentIdx >= 0 ? `${currentIdx + 1} / ${scopeOptions.length}` : ''}
                      </span>
                      {chartLabel && <span className="text-slate-500 ml-2">{chartLabel}</span>}
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <CrossSectionChart
                        key={typeof chartScope === 'number' ? `abs-${chartScope}` : 'collector'}
                        systemRows={chartRows}
                        systemIndex={systemData.systemIndex}
                        endType={typeof chartScope === 'number' ? null : systemData.endType}
                        chartHeight={fullscreenPanel === 'chart' ? window.innerHeight - 150 : 200}
                        pipeNumberById={pipeNumberById}
                        pipeDiameterById={pipeDiameterById}
                        allPlanGroups={planGroups}
                        farmName={currentFarm?.name}
                        tinSurface={tinSurface}
                        endCollectorPlannedHeight={chartEndCollectorHeight}
                      />
                    </div>
                  </>
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

      {/* 区間勾配 任意設定ダイアログ */}
      {slopeEdit && (
        <SlopeEditDialog
          target={slopeEdit}
          onClose={() => setSlopeEdit(null)}
          onApply={(side, newPh, slopeStr) => {
            // 勾配は「上流側 point の manualSlope」に保存（次区間の勾配を表す）
            // 調整した plannedHeight を該当側にセットしつつ、
            // 上流側 point の manualSlope に slopeStr を保持する。
            const upstream = slopeEdit.upstream
            if (side === 'upstream') {
              // 上流側を調整 → 上流の plannedHeight を更新 + manualSlope セット
              applyManualSlope(upstream.rowId, upstream.pointId, newPh, slopeStr)
            } else {
              // 下流側を調整 → 下流の plannedHeight を先に更新（manualSlope は無関係区間）
              updatePlannedHeight(slopeEdit.downstream.rowId, slopeEdit.downstream.pointId, newPh)
              // 続いて上流側の manualSlope を保存（plannedHeight は元のまま）
              applyManualSlope(
                upstream.rowId,
                upstream.pointId,
                upstream.ph,
                slopeStr,
              )
            }

            // 上流調整した結果、その上流側の集水点との間で逆勾配（前管点 < 現上流点）に
            // なった場合、続けて前段の区間を調整できるダイアログを開く。
            if (side === 'upstream' && activeTab) {
              const sysRows = activeTab.rows
              const upRowIdx = sysRows.findIndex((r) => r.id === upstream.rowId)
              if (upRowIdx > 0) {
                const prevRow = sysRows[upRowIdx - 1]
                const prevPoint = prevRow.collectorPoint
                const prevPh = prevPoint?.plannedHeight ?? null
                const prevDist = prevPoint?.segmentDistance ?? null
                if (
                  prevPoint &&
                  prevPh !== null &&
                  prevDist !== null &&
                  prevDist > 0 &&
                  prevPh < newPh - 1e-6 // 逆勾配（前管点が現上流点より低い）
                ) {
                  // 連続して上流側を調整するため、新しい slopeEdit ターゲットをセット
                  const upstreamLabel = prevPoint.pointName || '前管下流端'
                  const downstreamLabel = upstream.label
                  setSlopeEdit({
                    segmentLabel: `${upstreamLabel} → ${downstreamLabel}`,
                    distance: prevDist,
                    currentSlope: null,
                    upstream: {
                      rowId: prevRow.id,
                      pointId: prevPoint.id,
                      ph: prevPh,
                      label: upstreamLabel,
                    },
                    downstream: {
                      rowId: upstream.rowId,
                      pointId: upstream.pointId,
                      ph: newPh,
                      label: downstreamLabel,
                    },
                  })
                  return
                }
              }
            }

            setSlopeEdit(null)
          }}
        />
      )}

      {/* 連続勾配ダイアログ（現在の系統内の collector point に適用） */}
      {continuousOpen && activeTab && (
        <ContinuousSlopeDialog
          systemRows={activeTab.rows}
          onClose={() => setContinuousOpen(false)}
          onApply={(updates) => {
            for (const u of updates) {
              updatePlannedHeight(u.rowId, u.pointId, u.newPh)
            }
            setContinuousOpen(false)
          }}
        />
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

// 数値入力: フォーカス中はユーザーの生入力を保持し、blur 時にストアへ反映する
// これにより `toFixed(3)` による再フォーマットでカーソルがジャンプする問題を回避
function HeightInput({
  value,
  onCommit,
  className = '',
  title,
  placeholder,
}: {
  value: number | null
  onCommit: (v: number | null) => void
  className?: string
  title?: string
  placeholder?: string
}) {
  const [local, setLocal] = useState<string>(value === null || value === undefined ? '' : value.toFixed(3))
  const [focused, setFocused] = useState(false)

  // ストア値が外部更新された時（自動計算など）、非フォーカス時のみ同期
  useEffect(() => {
    if (!focused) {
      setLocal(value === null || value === undefined ? '' : value.toFixed(3))
    }
  }, [value, focused])

  const commit = () => {
    setFocused(false)
    if (local.trim() === '') {
      onCommit(null)
      return
    }
    const n = parseFloat(local)
    if (isNaN(n)) {
      // 不正な値: 元の値に戻す
      setLocal(value === null || value === undefined ? '' : value.toFixed(3))
      return
    }
    onCommit(n)
    setLocal(n.toFixed(3))
  }

  return (
    <input
      type="number"
      step="any"
      value={local}
      onChange={(e) => setLocal(e.target.value)}
      onFocus={(e) => {
        setFocused(true)
        // フォーカス時は末尾ゼロを取った生の値にして編集しやすく
        if (value !== null && value !== undefined) {
          setLocal(String(value))
        }
        e.target.select()
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          ;(e.target as HTMLInputElement).blur()
        }
      }}
      className={className}
      title={title}
      placeholder={placeholder}
    />
  )
}

// 区間勾配の任意設定ダイアログ
// 入力形式: "1/400" または "400"（= 1/400）。
// 上流/下流どちらを調整するか選んで Apply すると、選択側の計画高を再計算する。
function SlopeEditDialog({
  target,
  onClose,
  onApply,
}: {
  target: SlopeEditTarget
  onClose: () => void
  onApply: (side: 'upstream' | 'downstream', newPh: number, slopeStr: string) => void
}) {
  const [slopeInput, setSlopeInput] = useState<string>(
    target.currentSlope?.replace(/^1\//, '') ?? '',
  )
  const [side, setSide] = useState<'upstream' | 'downstream'>('downstream')

  // 勾配パース: "1/400" or "400" → 400（分母）を返す
  const parseDenominator = (input: string): number | null => {
    const t = input.trim()
    if (!t) return null
    const m = t.match(/^(?:1\s*\/\s*)?(-?\d+(?:\.\d+)?)$/)
    if (!m) return null
    const n = parseFloat(m[1])
    if (!Number.isFinite(n) || n === 0) return null
    return n
  }

  const denom = parseDenominator(slopeInput)
  const upPh = target.upstream.ph
  const downPh = target.downstream.ph

  // 新しい計画高を計算（勾配 1/denom、distance を使用。正の denom は下り）
  const previewNewPh = useMemo<number | null>(() => {
    if (denom === null) return null
    const drop = target.distance / denom
    if (side === 'upstream') {
      // 上流を調整: 下流 + drop
      if (downPh === null) return null
      return downPh + drop
    } else {
      if (upPh === null) return null
      return upPh - drop
    }
  }, [denom, side, upPh, downPh, target.distance])

  const canApply = previewNewPh !== null && Number.isFinite(previewNewPh)

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1600] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold mb-1">区間勾配の任意設定</h3>
        <div className="text-xs text-slate-500 mb-4">{target.segmentLabel}</div>

        <div className="grid grid-cols-2 gap-2 text-xs mb-4">
          <div>
            <div className="text-slate-500">区間距離</div>
            <div className="font-mono">{target.distance.toFixed(2)} m</div>
          </div>
          <div>
            <div className="text-slate-500">現在の勾配</div>
            <div className="font-mono">{target.currentSlope ?? '-'}</div>
          </div>
          <div>
            <div className="text-slate-500">上流: {target.upstream.label}</div>
            <div className="font-mono">
              {upPh !== null ? upPh.toFixed(3) : '-'} m
            </div>
          </div>
          <div>
            <div className="text-slate-500">下流: {target.downstream.label}</div>
            <div className="font-mono">
              {downPh !== null ? downPh.toFixed(3) : '-'} m
            </div>
          </div>
        </div>

        <div className="mb-3">
          <label className="block text-xs text-slate-600 mb-1">
            新しい勾配（例: 1/400 または 400）
          </label>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">1/</span>
            <input
              type="text"
              value={slopeInput.replace(/^1\s*\//, '')}
              onChange={(e) => setSlopeInput(e.target.value)}
              placeholder="400"
              autoFocus
              className="flex-1 px-2 py-1.5 border rounded text-sm font-mono"
            />
          </div>
        </div>

        <div className="mb-4">
          <div className="text-xs text-slate-600 mb-1">調整する側</div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSide('upstream')}
              className={`flex-1 px-3 py-2 rounded border text-sm ${
                side === 'upstream'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              上流側を調整（{target.upstream.label}）
            </button>
            <button
              type="button"
              onClick={() => setSide('downstream')}
              className={`flex-1 px-3 py-2 rounded border text-sm ${
                side === 'downstream'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              下流側を調整（{target.downstream.label}）
            </button>
          </div>
        </div>

        <div className="mb-4 p-2 bg-slate-50 rounded text-xs">
          <div className="text-slate-600">適用後の計画高（{side === 'upstream' ? '上流' : '下流'}）</div>
          <div className="font-mono text-base font-bold text-blue-700">
            {canApply ? `${previewNewPh!.toFixed(3)} m` : '—'}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => {
              if (canApply && denom !== null) onApply(side, previewNewPh!, `1/${Math.abs(denom)}`)
            }}
            className={`px-4 py-2 text-sm rounded ${
              canApply
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            }`}
          >
            適用
          </button>
        </div>
      </div>
    </div>
  )
}

// 連続勾配の設定ダイアログ
//   現在の系統内の集水点を 2 つ選び（始点・終点）、その区間に一定の勾配を
//   適用する。中間の各点の計画高は線形補間で計算される。
function ContinuousSlopeDialog({
  systemRows,
  onClose,
  onApply,
}: {
  systemRows: PlanRow[]
  onClose: () => void
  onApply: (updates: Array<{ rowId: string; pointId: string; newPh: number }>) => void
}) {
  // collector point のある行を上流→下流順に列挙
  const points = useMemo<ContinuousSlopeRow[]>(() => {
    const out: ContinuousSlopeRow[] = []
    let cum = 0
    for (let i = 0; i < systemRows.length; i++) {
      const r = systemRows[i]
      if (!r.collectorPoint) continue
      // 累積距離: 前行までの segmentDistance の合計（前行の segmentDistance が
      // 「前→当該」の距離を意味する）
      if (i > 0) {
        const prev = systemRows[i - 1]
        const segDist = prev.collectorPoint?.segmentDistance ?? null
        if (segDist != null) cum += segDist
      }
      out.push({
        rowId: r.id,
        pointId: r.collectorPoint.id,
        label: r.collectorPoint.pointName || `行${i + 1}`,
        ph: r.collectorPoint.plannedHeight,
        cumulativeDistance: cum,
      })
    }
    return out
  }, [systemRows])

  const [startIdx, setStartIdx] = useState(0)
  const [endIdx, setEndIdx] = useState(Math.min(1, points.length - 1))
  const [slopeInput, setSlopeInput] = useState<string>('')

  const startPoint = points[startIdx] ?? null
  const endPoint = points[endIdx] ?? null

  const distance = useMemo(() => {
    if (!startPoint || !endPoint || endIdx <= startIdx) return 0
    return endPoint.cumulativeDistance - startPoint.cumulativeDistance
  }, [startPoint, endPoint, startIdx, endIdx])

  // 勾配パース: "1/400" or "400" → 400
  const parseDenominator = (input: string): number | null => {
    const t = input.trim()
    if (!t) return null
    const m = t.match(/^(?:1\s*\/\s*)?(-?\d+(?:\.\d+)?)$/)
    if (!m) return null
    const n = parseFloat(m[1])
    if (!Number.isFinite(n) || n === 0) return null
    return n
  }

  const denom = parseDenominator(slopeInput)

  // 始点 ph がある + 勾配指定がある → 区間の各点の補間計画高をプレビュー
  const preview = useMemo(() => {
    if (!startPoint || startPoint.ph == null || !endPoint || endIdx <= startIdx || denom === null)
      return [] as Array<{ rowId: string; pointId: string; label: string; oldPh: number | null; newPh: number }>
    const startPh = startPoint.ph
    const out: Array<{ rowId: string; pointId: string; label: string; oldPh: number | null; newPh: number }> = []
    for (let i = startIdx + 1; i <= endIdx; i++) {
      const p = points[i]
      const dDist = p.cumulativeDistance - startPoint.cumulativeDistance
      const newPh = startPh - dDist / denom
      out.push({ rowId: p.rowId, pointId: p.pointId, label: p.label, oldPh: p.ph, newPh })
    }
    return out
  }, [startPoint, endPoint, startIdx, endIdx, denom, points])

  const canApply = preview.length > 0 && preview.every((p) => Number.isFinite(p.newPh))

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1600] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold mb-1">連続勾配の設定</h3>
        <div className="text-xs text-slate-500 mb-4">
          選択した区間（始点〜終点）の各点の計画高を、指定した勾配で線形に再計算します。
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4 text-xs">
          <div>
            <label className="block text-slate-600 mb-1">始点</label>
            <select
              value={startIdx}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10)
                setStartIdx(v)
                if (v >= endIdx) setEndIdx(Math.min(v + 1, points.length - 1))
              }}
              className="w-full px-2 py-1.5 border rounded font-mono"
            >
              {points.map((p, i) => (
                <option key={p.pointId} value={i}>
                  {p.label}（{p.cumulativeDistance.toFixed(2)} m / {p.ph != null ? p.ph.toFixed(3) : '-'} m）
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-slate-600 mb-1">終点</label>
            <select
              value={endIdx}
              onChange={(e) => setEndIdx(parseInt(e.target.value, 10))}
              className="w-full px-2 py-1.5 border rounded font-mono"
            >
              {points.map((p, i) => (
                <option key={p.pointId} value={i} disabled={i <= startIdx}>
                  {p.label}（{p.cumulativeDistance.toFixed(2)} m / {p.ph != null ? p.ph.toFixed(3) : '-'} m）
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="text-xs mb-3 text-slate-700">
          区間距離: <span className="font-mono">{distance.toFixed(2)} m</span>
          {startPoint?.ph != null && endPoint?.ph != null && distance > 0 && endIdx > startIdx && (
            <span className="ml-3">
              現在の落差:{' '}
              <span className="font-mono">{(startPoint.ph - endPoint.ph).toFixed(3)} m</span>
            </span>
          )}
        </div>

        <div className="mb-4">
          <label className="block text-xs text-slate-600 mb-1">適用する勾配（例: 1/400 または 400）</label>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">1/</span>
            <input
              type="text"
              value={slopeInput.replace(/^1\s*\//, '')}
              onChange={(e) => setSlopeInput(e.target.value)}
              placeholder="400"
              autoFocus
              className="flex-1 px-2 py-1.5 border rounded text-sm font-mono"
            />
          </div>
        </div>

        {preview.length > 0 && (
          <div className="mb-4 border rounded max-h-40 overflow-auto">
            <table className="w-full text-[11px]">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-2 py-1 font-medium">点名</th>
                  <th className="text-right px-2 py-1 font-medium">現在</th>
                  <th className="text-right px-2 py-1 font-medium">新しい計画高</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.pointId} className="border-t">
                    <td className="px-2 py-0.5 font-mono">{p.label}</td>
                    <td className="px-2 py-0.5 text-right font-mono text-slate-500">
                      {p.oldPh != null ? p.oldPh.toFixed(3) : '-'}
                    </td>
                    <td className="px-2 py-0.5 text-right font-mono text-blue-700">
                      {p.newPh.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border rounded hover:bg-slate-50 text-sm"
          >
            キャンセル
          </button>
          <button
            type="button"
            disabled={!canApply}
            onClick={() => onApply(preview.map((p) => ({ rowId: p.rowId, pointId: p.pointId, newPh: p.newPh })))}
            className="px-4 py-2 bg-cyan-600 text-white rounded hover:bg-cyan-700 disabled:opacity-50 text-sm"
          >
            適用
          </button>
        </div>
      </div>
    </div>
  )
}
