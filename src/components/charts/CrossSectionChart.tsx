import { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import type { PlanRow, PlanGroup } from '@/stores/constructionPlanStore'
import { exportCrossSectionDxf } from '@/lib/crossSectionDxfExport'
import type { ParsedSurface } from '@/lib/landxml/parser'
import { indexTin, queryZ } from '@/lib/landxml/tinInterpolation'

interface CrossSectionChartProps {
  systemRows: PlanRow[] // 系統内の行（rowIndex順）
  systemIndex: number
  endType: 'outlet' | 'merge' | null
  chartHeight?: number // SVG チャート高さ（px）。未指定時は 220
  pipeNumberById?: Map<string, string> // 管路ID → 管路番号
  pipeDiameterById?: Map<string, number> // 管路ID → 管径
  allPlanGroups?: PlanGroup[] // 合流先系統の参照用
  farmName?: string // DXF 出力ファイル名用
  // LandXML から読み込んだ TIN サーフェス。指定時は alignment に沿った断面を表示
  tinSurface?: ParsedSurface | null
  // 吸水断面で右端（集水合流位置）に集水管の計画高を点で重ねる場合に指定
  endCollectorPlannedHeight?: number | null
  // 計画高の編集コールバック。pointId（PlanPoint.id）と新しい計画高を受け取る。
  // 未指定時は計画点が編集不可（マウス操作なし）。
  onPlannedHeightChange?: (pointId: string, newHeight: number) => void
  // 受け側集水の各行に対して、流入してくる他系統の最終集水点情報。
  // rowId をキーに、複数の流入を配列で持つ（1 点に複数系統が合流するケース対応）。
  mergeInflowsByRowId?: Map<string, Array<{ height: number; systemLabel: string; isReverseSlope: boolean }>>
}

// 断面図の点データ（集水管の点のみ）
interface SectionPoint {
  distance: number // 累積距離（左からの位置）
  groundHeight: number | null // 現況高（地盤高）
  plannedHeight: number | null // 計画高
  pointName: string // 測点名
  rowIndex: number // 元の行インデックス
  // 編集用に PlanPoint.id を保持（onPlannedHeightChange に渡す）
  pointId: string
  // mergeInflows の検索用に PlanRow.id を保持
  rowId: string
  // 吸水接続情報
  // 合流行の場合は「合流先系統の末端集水管の番号」（例: S4）を入れる
  absorptionPipeNumber: string | null
  absorptionPlannedHeight: number | null // 吸水下流部の計画高
  absorptionUpstreamPlannedHeight: number | null // 吸水上流部（C 点）の計画高
  // 集水帯表示用
  collectorPipeId: string | null
  collectorPipeNumber: string | null
}

export function CrossSectionChart({
  systemRows,
  systemIndex,
  endType,
  chartHeight: chartHeightProp,
  pipeNumberById,
  pipeDiameterById,
  allPlanGroups,
  farmName,
  tinSurface,
  endCollectorPlannedHeight,
  onPlannedHeightChange,
  mergeInflowsByRowId,
}: CrossSectionChartProps) {
  // 標高スケールのズーム倍率（1.0が基準、大きいほど拡大）
  const [heightScale, setHeightScale] = useState(1.0)
  // 横（距離）スケールのズーム倍率
  const [widthScale, setWidthScale] = useState(1.0)

  // 勾配表示の切り替え
  const [showSlope, setShowSlope] = useState(true)

  // DXF 出力用の縦縮尺
  const [dxfVScale, setDxfVScale] = useState<100 | 200 | 500 | 1000>(200)

  // ホバー中の測点インデックス（緑の縦線にカーソルを合わせたとき）
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null)

  const handleDxfExport = useCallback(() => {
    exportCrossSectionDxf({
      systemRows,
      systemIndex,
      endType,
      verticalScale: dxfVScale,
      pipeNumberById,
      pipeDiameterById,
      allPlanGroups,
      farmName,
    })
  }, [systemRows, systemIndex, endType, dxfVScale, pipeNumberById, pipeDiameterById, allPlanGroups, farmName])

  // マウスホイールでスケールを変更（Shift 押下で横、それ以外は縦）
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    const delta = e.deltaY > 0 ? -0.1 : 0.1
    if (e.shiftKey) {
      setWidthScale((prev) => Math.max(0.2, Math.min(10.0, prev + delta)))
    } else {
      setHeightScale((prev) => Math.max(0.2, Math.min(5.0, prev + delta)))
    }
  }, [])

  // スケールリセット
  const resetScale = useCallback(() => {
    setHeightScale(1.0)
    setWidthScale(1.0)
  }, [])

  // 合流先系統の末端集水管の番号を取得。
  // systemIndex はグループごとにローカル連番なので、必ず合流元の行と「同じグループ」内で
  // 検索する。例: 集水暗渠2 系統3 の合流先 1/2 は 集水暗渠2 の 系統1/2 を指す。
  const resolveMergeTargetPipeNumber = useMemo(() => {
    return (sourceRow: PlanRow): string | null => {
      if (!allPlanGroups || !pipeNumberById) return null
      if (sourceRow.mergeSystemIndex == null) return null
      const g = allPlanGroups.find(
        (grp) =>
          grp.groupType === sourceRow.groupType &&
          grp.groupIndex === sourceRow.groupIndex,
      )
      if (!g) return null
      const targetRows = g.rows.filter(
        (r) =>
          r.systemIndex === sourceRow.mergeSystemIndex &&
          r.mergeSystemIndex == null,
      )
      for (let i = targetRows.length - 1; i >= 0; i--) {
        const tr = targetRows[i]
        if (tr.collectorPipeId) {
          return pipeNumberById.get(tr.collectorPipeId) ?? null
        }
      }
      return null
    }
  }, [allPlanGroups, pipeNumberById])

  // 集水管の断面を構成
  // 系統内の各行の集水点を累積距離で配置（上流から下流へ）
  const sectionData = useMemo(() => {
    const points: SectionPoint[] = []
    let cumulativeDistance = 0

    // 行を順に処理（最上流から最下流へ）
    for (let rowIdx = 0; rowIdx < systemRows.length; rowIdx++) {
      const row = systemRows[rowIdx]

      // 集水点がない場合はスキップ
      if (!row.collectorPoint) continue

      // 最初の点以外は、前の行の集水点から現在の行の集水点までの距離を加算
      // これは前の行のcollectorPoint.segmentDistanceに格納されている
      if (rowIdx > 0) {
        const prevRow = systemRows[rowIdx - 1]
        if (prevRow.collectorPoint?.segmentDistance !== null && prevRow.collectorPoint?.segmentDistance !== undefined) {
          cumulativeDistance += prevRow.collectorPoint.segmentDistance
        }
      }

      // 吸水下流部・上流部の計画高を取得
      const absorptionDownstreamHeight = row.absorptionPoints.length > 0
        ? row.absorptionPoints[row.absorptionPoints.length - 1].plannedHeight
        : null
      const absorptionUpstreamHeight = row.absorptionPoints.length > 0
        ? row.absorptionPoints[0].plannedHeight
        : null

      // 旗上げラベル:
      // - 合流行（mergeSystemIndex あり）: 合流先系統の末端集水管（例: R2, S19）
      // - 系統終端のみの行（落口/合流点 = 吸水なし・isSystemEnd）: 旗上げなし
      // - それ以外（吸水行・集水変化点など）: 配線番号（吸水管 K8 / 集水管 S2 等）
      let flagPipeNumber: string | null = null
      if (row.mergeSystemIndex != null) {
        flagPipeNumber = resolveMergeTargetPipeNumber(row) ?? row.pipeNumber
      } else if (
        row.isSystemEnd &&
        row.absorptionPoints.length === 0 &&
        (row.systemEndType === 'outlet' || row.systemEndType === 'merge')
      ) {
        flagPipeNumber = null
      } else {
        flagPipeNumber = row.pipeNumber
      }

      // 集水帯用: 集水管番号
      const collectorPipeNumber = row.collectorPipeId
        ? pipeNumberById?.get(row.collectorPipeId) ?? null
        : null

      points.push({
        distance: cumulativeDistance,
        groundHeight: row.collectorPoint.groundHeight,
        plannedHeight: row.collectorPoint.plannedHeight,
        pointName: row.collectorPoint.pointName,
        rowIndex: rowIdx,
        pointId: row.collectorPoint.id,
        rowId: row.id,
        absorptionPipeNumber: flagPipeNumber,
        absorptionPlannedHeight: absorptionDownstreamHeight,
        absorptionUpstreamPlannedHeight: absorptionUpstreamHeight,
        collectorPipeId: row.collectorPipeId,
        collectorPipeNumber,
      })
    }

    return points
  }, [systemRows, resolveMergeTargetPipeNumber, pipeNumberById])

  // TIN サーフェスから alignment に沿った断面サンプルを生成（約 1m 間隔）
  const tinProfile = useMemo<{ distance: number; z: number | null }[]>(() => {
    if (!tinSurface) return []
    const idx = indexTin(tinSurface)
    const samples: { distance: number; z: number | null }[] = []
    let cumDist = 0
    const sampleStep = 1.0 // m
    for (let i = 0; i < systemRows.length; i++) {
      const row = systemRows[i]
      if (!row.collectorPoint) continue
      // この点でサンプル
      samples.push({ distance: cumDist, z: queryZ(idx, row.collectorPoint.x, row.collectorPoint.y) })
      // 次の集水点までセグメント上で密にサンプル
      const nextRow = systemRows[i + 1]
      const segLen = row.collectorPoint.segmentDistance
      if (nextRow?.collectorPoint && segLen != null && segLen > sampleStep) {
        const dx = nextRow.collectorPoint.x - row.collectorPoint.x
        const dy = nextRow.collectorPoint.y - row.collectorPoint.y
        const segXY = Math.hypot(dx, dy)
        const numSteps = Math.floor(segLen / sampleStep)
        for (let s = 1; s < numSteps; s++) {
          const t = s / numSteps
          const x = row.collectorPoint.x + dx * t
          const y = row.collectorPoint.y + dy * t
          samples.push({ distance: cumDist + segLen * t, z: queryZ(idx, x, y) })
          // segXY は使っていないが lint 警告抑制のため参照
          void segXY
        }
        cumDist += segLen
      } else if (segLen != null) {
        cumDist += segLen
      }
    }
    return samples
  }, [tinSurface, systemRows])

  // 旗上げ設定
  const FLAG_ROW_HEIGHT = 24
  const FLAG_WIDTH = 80
  const BASE_TOP_PADDING = 16
  const BASE_BOTTOM_PADDING = 80

  // 描画範囲を計算（heightScaleを考慮）
  const {
    minHeight,
    maxHeight,
    totalDistance,
    padding,
    chartWidth,
    chartHeight,
    flagRowByIndex,
  } = useMemo(() => {
    const heights = [
      ...sectionData.flatMap(p => [p.groundHeight, p.plannedHeight, p.absorptionPlannedHeight, p.absorptionUpstreamPlannedHeight]),
      ...tinProfile.map(p => p.z),
      endCollectorPlannedHeight ?? null,
    ].filter((h): h is number => h !== null)

    const effectiveHeight = chartHeightProp ?? 220
    if (heights.length === 0) {
      return {
        minHeight: 0,
        maxHeight: 10,
        totalDistance: 100,
        padding: { top: BASE_TOP_PADDING + FLAG_ROW_HEIGHT, right: 60, bottom: BASE_BOTTOM_PADDING, left: 80 },
        chartWidth: 600,
        chartHeight: effectiveHeight,
        flagRowByIndex: new Map<number, number>(),
        numFlagRows: 0,
      }
    }

    const min = Math.min(...heights)
    const max = Math.max(...heights)
    const range = max - min || 1
    const center = (min + max) / 2

    // スケールに応じて表示範囲を調整（大きいほど狭い範囲=拡大）
    const scaledRange = range / heightScale
    const heightPadding = scaledRange * 0.2

    const dist = sectionData.length > 0 ? sectionData[sectionData.length - 1].distance : 100

    // 標高値の桁数に応じて左パディングを調整（18px フォント基準）
    const maxDigits = Math.max(
      (center + scaledRange / 2).toFixed(2).length,
      (center - scaledRange / 2).toFixed(2).length
    )
    const leftPadding = Math.max(80, maxDigits * 12 + 30)
    const rightPadding = 60
    const computedTotalDistance = dist || 100
    const computedChartWidth = Math.max(600, dist * 5 * widthScale + 160)

    // 吸水旗上げの行配置（重ならないよう段組み）
    const absorptionIndices = sectionData
      .map((p, i) => ({ p, idx: i }))
      .filter(({ p }) => !!p.absorptionPipeNumber)
      .sort((a, b) => a.p.distance - b.p.distance)

    const scaleXProvisional = (d: number) => {
      if (computedTotalDistance === 0) return leftPadding
      return leftPadding + (d / computedTotalDistance) * (computedChartWidth - leftPadding - rightPadding)
    }

    const rowRightEdges: number[] = []
    const flagRowByIndex = new Map<number, number>()
    for (const { p, idx } of absorptionIndices) {
      const x = scaleXProvisional(p.distance)
      const leftEdge = x - FLAG_WIDTH / 2
      const rightEdge = x + FLAG_WIDTH / 2
      let assigned = -1
      for (let r = 0; r < rowRightEdges.length; r++) {
        if (leftEdge >= rowRightEdges[r] + 4) {
          assigned = r
          break
        }
      }
      if (assigned === -1) {
        rowRightEdges.push(rightEdge)
        assigned = rowRightEdges.length - 1
      } else {
        rowRightEdges[assigned] = rightEdge
      }
      flagRowByIndex.set(idx, assigned)
    }
    const numFlagRows = rowRightEdges.length
    const topPadding = BASE_TOP_PADDING + Math.max(1, numFlagRows) * FLAG_ROW_HEIGHT

    return {
      minHeight: center - scaledRange / 2 - heightPadding,
      maxHeight: center + scaledRange / 2 + heightPadding,
      totalDistance: computedTotalDistance,
      padding: { top: topPadding, right: rightPadding, bottom: BASE_BOTTOM_PADDING, left: leftPadding },
      chartWidth: computedChartWidth,
      chartHeight: effectiveHeight + Math.max(0, numFlagRows - 1) * FLAG_ROW_HEIGHT,
      flagRowByIndex,
      numFlagRows,
    }
  }, [sectionData, tinProfile, heightScale, widthScale, chartHeightProp, endCollectorPlannedHeight])

  // 座標変換関数
  const xScale = (distance: number) => {
    if (totalDistance === 0) return padding.left
    return padding.left + (distance / totalDistance) * (chartWidth - padding.left - padding.right)
  }

  const yScale = (height: number) => {
    const range = maxHeight - minHeight
    if (range === 0) return chartHeight / 2
    return padding.top + (1 - (height - minHeight) / range) * (chartHeight - padding.top - padding.bottom)
  }

  // yScale の逆関数（pixel → 標高）。ドラッグ操作で計画高を更新する際に使う。
  const yToHeight = useCallback(
    (yPixel: number): number => {
      const range = maxHeight - minHeight
      if (range === 0) return minHeight
      const usable = chartHeight - padding.top - padding.bottom
      const ratio = 1 - (yPixel - padding.top) / usable
      return minHeight + range * ratio
    },
    [maxHeight, minHeight, chartHeight, padding.top, padding.bottom],
  )

  // SVG 要素への ref（マウス座標を SVG 座標に変換するため）
  const svgRef = useRef<SVGSVGElement | null>(null)
  // スクロールコンテナへの ref（背景ドラッグでの横スクロールに使用）
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  // 背景ドラッグでパン中の状態
  const panRef = useRef<{ startX: number; startScrollLeft: number } | null>(null)
  const [isPanning, setIsPanning] = useState(false)

  // 背景ドラッグでのパン: マウスダウン時、対象が SVG / グリッド線 / TIN パスなど
  // 「背景」要素であればパンを開始する。マーカー類は stopPropagation していて
  // ここまで来ない。
  const handlePanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return // 左クリックのみ
    if (!scrollContainerRef.current) return
    panRef.current = {
      startX: e.clientX,
      startScrollLeft: scrollContainerRef.current.scrollLeft,
    }
    setIsPanning(true)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!panRef.current || !scrollContainerRef.current) return
      const dx = e.clientX - panRef.current.startX
      scrollContainerRef.current.scrollLeft = panRef.current.startScrollLeft - dx
    }
    const onUp = () => {
      if (!panRef.current) return
      panRef.current = null
      setIsPanning(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  // ドラッグ中の点（再描画トリガ用に state も持つ）
  const dragRef = useRef<{ pointId: string } | null>(null)
  const [draggingPointId, setDraggingPointId] = useState<string | null>(null)
  // ドラッグ後の click を抑制するためのフラグ（mousemove で true になり、次の click で消費）
  const suppressNextClickRef = useRef(false)

  // クリックで開く計画高の編集ポップアップ
  const [editPopup, setEditPopup] = useState<{
    pointId: string
    x: number
    y: number
    initialHeight: number
  } | null>(null)
  const [editValue, setEditValue] = useState('')

  // 凡例の最小化状態。localStorage に永続化。
  const LEGEND_COLLAPSED_KEY = 'nodecloud_chart_legend_collapsed'
  const [legendCollapsed, setLegendCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(LEGEND_COLLAPSED_KEY) === '1'
  })
  const toggleLegendCollapsed = () => {
    setLegendCollapsed((v) => {
      const next = !v
      try {
        window.localStorage.setItem(LEGEND_COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }

  // 凡例の位置オフセット（top, right からの相対 px）。localStorage に永続化。
  const LEGEND_STORAGE_KEY = 'nodecloud_chart_legend_offset'
  const [legendOffset, setLegendOffset] = useState<{ top: number; right: number }>(() => {
    if (typeof window === 'undefined') return { top: 8, right: 8 }
    try {
      const saved = window.localStorage.getItem(LEGEND_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as { top: number; right: number }
        if (
          Number.isFinite(parsed.top) &&
          Number.isFinite(parsed.right)
        ) {
          return parsed
        }
      }
    } catch {
      // ignore
    }
    return { top: 8, right: 8 }
  })
  const legendDragRef = useRef<{
    startMouseX: number
    startMouseY: number
    startTop: number
    startRight: number
  } | null>(null)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!legendDragRef.current) return
      const dx = e.clientX - legendDragRef.current.startMouseX
      const dy = e.clientY - legendDragRef.current.startMouseY
      // 右端基準なので、マウスが右に動いたら right が小さくなる
      const next = {
        top: Math.max(0, legendDragRef.current.startTop + dy),
        right: Math.max(0, legendDragRef.current.startRight - dx),
      }
      setLegendOffset(next)
    }
    const onUp = () => {
      if (!legendDragRef.current) return
      legendDragRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        window.localStorage.setItem(LEGEND_STORAGE_KEY, JSON.stringify(legendOffset))
      } catch {
        // ignore
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [legendOffset])

  // SVG 内のローカル Y 座標を取得
  const getSvgY = useCallback((clientY: number): number | null => {
    if (!svgRef.current) return null
    const rect = svgRef.current.getBoundingClientRect()
    return clientY - rect.top
  }, [])

  // 最新値を保持する ref（useEffect の依存をマウント 1 回に絞るため）
  const onPlannedHeightChangeRef = useRef(onPlannedHeightChange)
  useEffect(() => {
    onPlannedHeightChangeRef.current = onPlannedHeightChange
  }, [onPlannedHeightChange])
  const yToHeightRef = useRef(yToHeight)
  useEffect(() => {
    yToHeightRef.current = yToHeight
  }, [yToHeight])
  const minMaxRef = useRef({ min: minHeight, max: maxHeight })
  useEffect(() => {
    minMaxRef.current = { min: minHeight, max: maxHeight }
  }, [minHeight, maxHeight])

  // ドラッグ中のグローバル mousemove / mouseup ハンドラ（マウント時に 1 度だけ登録）
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const cb = onPlannedHeightChangeRef.current
      if (!cb) return
      suppressNextClickRef.current = true
      const y = getSvgY(e.clientY)
      if (y == null) return
      const { min, max } = minMaxRef.current
      const h = Math.max(min, Math.min(max, yToHeightRef.current(y)))
      cb(dragRef.current.pointId, h)
    }
    const onUp = () => {
      if (!dragRef.current) return
      dragRef.current = null
      setDraggingPointId(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [getSvgY])

  // パスデータを生成（現況線）
  const groundPath = useMemo(() => {
    const validPoints = sectionData.filter(p => p.groundHeight !== null)
    if (validPoints.length < 2) return ''

    return validPoints
      .map((p, i) => {
        const x = xScale(p.distance)
        const y = yScale(p.groundHeight!)
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
      })
      .join(' ')
  }, [sectionData, totalDistance, chartWidth, padding, minHeight, maxHeight])

  // パスデータを生成（計画線）
  const plannedPath = useMemo(() => {
    const validPoints = sectionData.filter(p => p.plannedHeight !== null)
    if (validPoints.length < 2) return ''

    return validPoints
      .map((p, i) => {
        const x = xScale(p.distance)
        const y = yScale(p.plannedHeight!)
        return `${i === 0 ? 'M' : 'L'} ${x} ${y}`
      })
      .join(' ')
  }, [sectionData, totalDistance, chartWidth, padding, minHeight, maxHeight])

  // パスデータを生成（LandXML TIN 断面）
  const tinPath = useMemo(() => {
    if (tinProfile.length < 2) return ''
    // 連続する有効点ごとに M/L で接続。途中で z=null になったら一旦切る
    const segments: string[] = []
    let inSegment = false
    for (const p of tinProfile) {
      if (p.z == null) {
        inSegment = false
        continue
      }
      const cmd = inSegment ? 'L' : 'M'
      segments.push(`${cmd} ${xScale(p.distance)} ${yScale(p.z)}`)
      inSegment = true
    }
    return segments.join(' ')
  }, [tinProfile, totalDistance, chartWidth, padding, minHeight, maxHeight]) // eslint-disable-line react-hooks/exhaustive-deps

  // Y軸の目盛りを計算
  const yTicks = useMemo(() => {
    const range = maxHeight - minHeight
    const step = range <= 0.5 ? 0.05 : range <= 1 ? 0.1 : range <= 2 ? 0.2 : range <= 5 ? 0.5 : 1
    const ticks: number[] = []
    let tick = Math.ceil(minHeight / step) * step
    while (tick <= maxHeight) {
      ticks.push(tick)
      tick += step
    }
    return ticks
  }, [minHeight, maxHeight])

  // 各スパンの勾配を計算
  const slopeData = useMemo(() => {
    const slopes: { startIdx: number; endIdx: number; slope: string; distance: number }[] = []

    for (let i = 0; i < sectionData.length - 1; i++) {
      const p1 = sectionData[i]
      const p2 = sectionData[i + 1]

      if (p1.plannedHeight !== null && p2.plannedHeight !== null) {
        const distance = p2.distance - p1.distance
        const heightDiff = p1.plannedHeight - p2.plannedHeight // 上流から下流への落差

        if (distance > 0 && heightDiff !== 0) {
          const slopeValue = Math.abs(distance / heightDiff)
          slopes.push({
            startIdx: i,
            endIdx: i + 1,
            slope: `1/${Math.round(slopeValue)}`,
            distance,
          })
        } else if (distance > 0 && heightDiff === 0) {
          slopes.push({
            startIdx: i,
            endIdx: i + 1,
            slope: '水平',
            distance,
          })
        }
      }
    }

    return slopes
  }, [sectionData])

  if (sectionData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        集水点データがありません
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* 系統タイトル */}
      <div className={`px-3 py-1.5 text-sm font-medium flex items-center gap-2 border-b ${
        endType === 'outlet'
          ? 'bg-orange-50 text-orange-800'
          : endType === 'merge'
            ? 'bg-purple-50 text-purple-800'
            : 'bg-slate-50 text-slate-700'
      }`}>
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white text-xs font-bold border">
          {systemIndex}
        </span>
        <span>
          系統 {systemIndex} 集水渠断面図
          {endType === 'outlet' && ' （落口）'}
          {endType === 'merge' && ' （合流）'}
        </span>
        <span className="text-xs text-slate-500 ml-2">
          ← 上流　｜　下流 →
        </span>
        <span className="ml-auto text-xs text-slate-500 flex items-center gap-2">
          <button
            onClick={() => setShowSlope(!showSlope)}
            className={`px-2 py-0.5 text-[18px] rounded transition-colors ${
              showSlope
                ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                : 'bg-slate-200 text-slate-600 hover:bg-slate-300'
            }`}
          >
            勾配{showSlope ? '表示' : '非表示'}
          </button>
          <span className="text-slate-400">|</span>
          <span className="flex items-center gap-1">
            縦:
            <input
              type="range"
              min={0.2}
              max={5.0}
              step={0.1}
              value={heightScale}
              onChange={(e) => setHeightScale(parseFloat(e.target.value))}
              className="w-20"
            />
            <span className="w-10 text-right">{(heightScale * 100).toFixed(0)}%</span>
          </span>
          <span className="flex items-center gap-1">
            横:
            <input
              type="range"
              min={0.2}
              max={10.0}
              step={0.1}
              value={widthScale}
              onChange={(e) => setWidthScale(parseFloat(e.target.value))}
              className="w-20"
            />
            <span className="w-10 text-right">{(widthScale * 100).toFixed(0)}%</span>
          </span>
          {(heightScale !== 1.0 || widthScale !== 1.0) && (
            <button
              onClick={resetScale}
              className="px-1.5 py-0.5 text-[18px] bg-slate-200 hover:bg-slate-300 rounded"
            >
              リセット
            </button>
          )}
          <span className="text-slate-400">（ホイール:縦 / Shift+ホイール:横）</span>
          <span className="text-slate-400">|</span>
          <span className="flex items-center gap-1">
            DXF 縦尺:
            <select
              value={dxfVScale}
              onChange={(e) => setDxfVScale(parseInt(e.target.value, 10) as 100 | 200 | 500 | 1000)}
              className="px-1 py-0.5 text-[14px] border rounded bg-white"
            >
              <option value={100}>1/100</option>
              <option value={200}>1/200</option>
              <option value={500}>1/500</option>
              <option value={1000}>1/1000</option>
            </select>
            <button
              onClick={handleDxfExport}
              className="px-2 py-0.5 text-[14px] bg-emerald-600 text-white rounded hover:bg-emerald-700"
              title="縦断図を DXF 形式で出力（横 1/1000 固定）"
            >
              DXF 出力
            </button>
          </span>
        </span>
      </div>

      {/* SVG断面図（凡例はスクロール外に固定表示） */}
      <div className="flex-1 relative overflow-hidden bg-white">
        {/* 凡例（ドラッグで移動可能・位置は localStorage に保存） */}
        <div
          className="absolute z-10 bg-white border border-slate-200 rounded shadow-sm text-[14px] select-none"
          style={{ top: legendOffset.top, right: legendOffset.right }}
        >
          {/* ドラッグハンドル + 最小化ボタン */}
          <div
            className={`px-2 py-0.5 bg-slate-100 border-slate-200 rounded-t text-[10px] text-slate-500 flex items-center justify-between gap-2 ${
              legendCollapsed ? 'rounded-b' : 'border-b'
            }`}
          >
            <div
              className="flex-1 cursor-move"
              onMouseDown={(e) => {
                e.preventDefault()
                legendDragRef.current = {
                  startMouseX: e.clientX,
                  startMouseY: e.clientY,
                  startTop: legendOffset.top,
                  startRight: legendOffset.right,
                }
                document.body.style.cursor = 'move'
                document.body.style.userSelect = 'none'
              }}
              title="ドラッグで凡例を移動"
            >
              ≡ 凡例
            </div>
            <button
              type="button"
              onClick={toggleLegendCollapsed}
              className="px-1 hover:bg-slate-200 rounded text-slate-600"
              title={legendCollapsed ? '凡例を展開' : '凡例を最小化'}
            >
              {legendCollapsed ? '▢' : '−'}
            </button>
          </div>
          {!legendCollapsed && (
          <div className="p-2 space-y-1 pointer-events-none">
          <div className="flex items-center gap-2">
            <svg width="24" height="10" className="flex-shrink-0">
              <line x1="2" y1="5" x2="22" y2="5" stroke="#92400e" strokeWidth="2" />
              <circle cx="12" cy="5" r="3" fill="#92400e" />
            </svg>
            <span className="text-slate-700">現況高</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="24" height="10" className="flex-shrink-0">
              <line x1="2" y1="5" x2="22" y2="5" stroke="#2563eb" strokeWidth="2" />
              <circle cx="12" cy="5" r="3" fill="#2563eb" />
            </svg>
            <span className="text-slate-700">計画高（集水）</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="24" height="10" className="flex-shrink-0">
              <circle cx="12" cy="5" r="3" fill="#16a34a" />
            </svg>
            <span className="text-slate-700">吸水下流部</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="24" height="10" className="flex-shrink-0">
              <polygon points="6,1 18,1 12,9" fill="#16a34a" stroke="white" strokeWidth="1" />
            </svg>
            <span className="text-slate-700">吸水上流部</span>
          </div>
          <div className="flex items-center gap-2">
            <svg width="24" height="10" className="flex-shrink-0">
              <line x1="2" y1="5" x2="22" y2="5" stroke="#16a34a" strokeWidth="1.5" strokeDasharray="4,3" />
            </svg>
            <span className="text-slate-700">吸水接続</span>
          </div>
          </div>
          )}
        </div>

        <div
          ref={scrollContainerRef}
          className="absolute inset-0 overflow-x-auto overflow-y-hidden"
          onWheel={handleWheel}
        >
        <svg
          ref={svgRef}
          width={chartWidth}
          height={chartHeight}
          className={`min-w-full ${isPanning ? 'cursor-grabbing' : 'cursor-grab'}`}
        >
          {/* パン操作用の透明背景。SVG 要素そのものは visiblePainted のため空白で
             イベントを受けないため、全面に透明 rect を敷く。マーカー類はこれより後に
             描画されるので、操作優先度はマーカー > 背景パンとなる。 */}
          <rect
            x={0}
            y={0}
            width={chartWidth}
            height={chartHeight}
            fill="transparent"
            onMouseDown={handlePanStart}
          />
          {/* 背景グリッド */}
          <g className="grid">
            {yTicks.map(tick => (
              <line
                key={tick}
                x1={padding.left}
                y1={yScale(tick)}
                x2={chartWidth - padding.right}
                y2={yScale(tick)}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
            ))}
          </g>

          {/* Y軸 */}
          <g className="y-axis">
            <line
              x1={padding.left}
              y1={padding.top}
              x2={padding.left}
              y2={chartHeight - padding.bottom}
              stroke="#94a3b8"
              strokeWidth="1"
            />
            {yTicks.map(tick => (
              <g key={tick}>
                <line
                  x1={padding.left - 5}
                  y1={yScale(tick)}
                  x2={padding.left}
                  y2={yScale(tick)}
                  stroke="#94a3b8"
                  strokeWidth="1"
                />
                <text
                  x={padding.left - 8}
                  y={yScale(tick)}
                  textAnchor="end"
                  dominantBaseline="middle"
                  className="fill-slate-600 text-[18px]"
                >
                  {tick.toFixed(2)}
                </text>
              </g>
            ))}
            <text
              x={15}
              y={chartHeight / 2}
              textAnchor="middle"
              dominantBaseline="middle"
              transform={`rotate(-90, 15, ${chartHeight / 2})`}
              className="fill-slate-600 text-base font-medium"
            >
              標高 (m)
            </text>
          </g>

          {/* X軸 */}
          <g className="x-axis">
            <line
              x1={padding.left}
              y1={chartHeight - padding.bottom}
              x2={chartWidth - padding.right}
              y2={chartHeight - padding.bottom}
              stroke="#94a3b8"
              strokeWidth="1"
            />
          </g>

          {/* 現況線（茶色） */}
          {groundPath && (
            <path
              d={groundPath}
              fill="none"
              stroke="#92400e"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* 計画線（青） */}
          {plannedPath && (
            <path
              d={plannedPath}
              fill="none"
              stroke="#2563eb"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* LandXML TIN 断面（紫の点線） */}
          {tinPath && (
            <path
              d={tinPath}
              fill="none"
              stroke="#9333ea"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* 勾配ラベル */}
          {showSlope && slopeData.map((slope, idx) => {
            const p1 = sectionData[slope.startIdx]
            const p2 = sectionData[slope.endIdx]
            if (p1.plannedHeight === null || p2.plannedHeight === null) return null

            const x1 = xScale(p1.distance)
            const x2 = xScale(p2.distance)
            const y1 = yScale(p1.plannedHeight)
            const y2 = yScale(p2.plannedHeight)

            // ラベルの位置（線分の中点、計画線の下に描画）
            const midX = (x1 + x2) / 2
            const midY = (y1 + y2) / 2 + 16

            return (
              <g key={idx}>
                {/* 勾配ラベル背景 */}
                <rect
                  x={midX - 22}
                  y={midY - 8}
                  width={44}
                  height={28}
                  fill="white"
                  fillOpacity={0.85}
                  rx={2}
                />
                {/* 勾配ラベルテキスト */}
                <text
                  x={midX}
                  y={midY}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-blue-700 text-[16px] font-medium"
                >
                  {slope.slope}
                </text>
                {/* 区間距離（小数1桁、括弧書き） */}
                <text
                  x={midX}
                  y={midY + 14}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-slate-600 text-[12px]"
                >
                  ({slope.distance.toFixed(1)})
                </text>
              </g>
            )
          })}

          {/* 吸水旗上げ（上部） */}
          {sectionData.map((point, idx) => {
            if (!point.absorptionPipeNumber) return null
            const x = xScale(point.distance)
            const row = flagRowByIndex.get(idx) ?? 0
            const flagTop = BASE_TOP_PADDING + row * FLAG_ROW_HEIGHT
            const flagBottom = flagTop + FLAG_ROW_HEIGHT - 4
            const leaderEndY = point.absorptionPlannedHeight !== null
              ? yScale(point.absorptionPlannedHeight)
              : point.plannedHeight !== null
                ? yScale(point.plannedHeight)
                : chartHeight - padding.bottom
            return (
              <g key={`flag-${idx}`}>
                {/* リーダー線（旗 → 点） */}
                <line
                  x1={x}
                  y1={flagBottom}
                  x2={x}
                  y2={leaderEndY}
                  stroke="#16a34a"
                  strokeWidth="1"
                  strokeDasharray="2,2"
                />
                {/* 旗の枠 */}
                <rect
                  x={x - FLAG_WIDTH / 2}
                  y={flagTop}
                  width={FLAG_WIDTH}
                  height={FLAG_ROW_HEIGHT - 4}
                  fill="white"
                  stroke="#16a34a"
                  strokeWidth="1"
                  rx={3}
                />
                {/* 旗のテキスト */}
                <text
                  x={x}
                  y={flagTop + (FLAG_ROW_HEIGHT - 4) / 2 + 1}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className="fill-green-700 text-[16px] font-semibold"
                >
                  {point.absorptionPipeNumber}
                </text>
              </g>
            )
          })}

          {/* 測点マーカーとラベル */}
          {sectionData.map((point, idx) => {
            const x = xScale(point.distance)

            return (
              <g key={idx}>
                {/* ホバー検出用の透明な太い縦線（マーカー類より「下」に配置して、
                   マーカーへの mousedown / click を奪わないようにする） */}
                <line
                  x1={x}
                  y1={padding.top - 4}
                  x2={x}
                  y2={chartHeight - padding.bottom + 4}
                  stroke="transparent"
                  strokeWidth="20"
                  style={{ cursor: 'pointer' }}
                  onMouseEnter={() => setHoveredIdx(idx)}
                  onMouseLeave={() => setHoveredIdx((cur) => (cur === idx ? null : cur))}
                />
                {/* ホバー時のハイライト縦線 */}
                {hoveredIdx === idx && (
                  <line
                    x1={x}
                    y1={padding.top - 4}
                    x2={x}
                    y2={chartHeight - padding.bottom + 4}
                    stroke="#16a34a"
                    strokeWidth="1.5"
                    strokeDasharray="3,3"
                    pointerEvents="none"
                  />
                )}

                {/* 現況点マーカー */}
                {point.groundHeight !== null && (
                  <>
                    <circle
                      cx={x}
                      cy={yScale(point.groundHeight)}
                      r={5}
                      fill="#92400e"
                      stroke="white"
                      strokeWidth="1.5"
                    />
                    <text
                      x={x + 7}
                      y={yScale(point.groundHeight) - 6}
                      className="fill-amber-800 text-[11px] font-medium"
                      style={{
                        paintOrder: 'stroke',
                        stroke: 'white',
                        strokeWidth: 3,
                        strokeLinejoin: 'round',
                      }}
                    >
                      {point.groundHeight.toFixed(3)}
                    </text>
                  </>
                )}

                {/* 切深ラベル（地盤高 - 計画高）。地盤と計画の中間に縦書き表示 */}
                {point.groundHeight !== null && point.plannedHeight !== null && (() => {
                  const gy = yScale(point.groundHeight)
                  const py = yScale(point.plannedHeight)
                  const cutDepth = point.groundHeight - point.plannedHeight
                  if (Math.abs(py - gy) < 22) return null // 重なるほど近い場合は省略
                  const midY = (gy + py) / 2
                  return (
                    <text
                      x={x - 4}
                      y={midY + 4}
                      textAnchor="end"
                      className="fill-cyan-700 text-[11px] font-semibold"
                      style={{
                        paintOrder: 'stroke',
                        stroke: 'white',
                        strokeWidth: 3,
                        strokeLinejoin: 'round',
                        pointerEvents: 'none',
                      }}
                    >
                      {cutDepth.toFixed(3)}
                    </text>
                  )
                })()}

                {/* 計画点マーカー（編集コールバック有効時はドラッグ + 左クリックで編集） */}
                {point.plannedHeight !== null && (() => {
                  const editable = !!onPlannedHeightChange
                  const isDragging =
                    editable && draggingPointId === point.pointId
                  const cy = yScale(point.plannedHeight)
                  // 編集可: マーカーを少し大きくして、自身が直接マウスイベントを受ける
                  const r = editable ? (isDragging ? 9 : 7) : 5
                  return (
                    <>
                      <circle
                        cx={x}
                        cy={cy}
                        r={r}
                        fill={isDragging ? '#1d4ed8' : '#2563eb'}
                        stroke="white"
                        strokeWidth="1.5"
                        style={editable ? { cursor: 'ns-resize' } : undefined}
                        onMouseDown={
                          editable
                            ? (e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                suppressNextClickRef.current = false
                                dragRef.current = { pointId: point.pointId }
                                setDraggingPointId(point.pointId)
                                document.body.style.cursor = 'ns-resize'
                                document.body.style.userSelect = 'none'
                              }
                            : undefined
                        }
                        onClick={
                          editable
                            ? (e) => {
                                if (suppressNextClickRef.current) {
                                  suppressNextClickRef.current = false
                                  return
                                }
                                e.stopPropagation()
                                const rect = svgRef.current?.getBoundingClientRect()
                                if (!rect) return
                                setEditPopup({
                                  pointId: point.pointId,
                                  x: e.clientX - rect.left,
                                  y: cy - 8,
                                  initialHeight: point.plannedHeight!,
                                })
                                setEditValue(point.plannedHeight!.toFixed(3))
                              }
                            : undefined
                        }
                      >
                        {editable && (
                          <title>上下ドラッグで計画高変更 / クリックで数値入力</title>
                        )}
                      </circle>
                      <text
                        x={x + 7}
                        y={cy + 14}
                        className="fill-blue-700 text-[11px] font-medium"
                        style={{
                          paintOrder: 'stroke',
                          stroke: 'white',
                          strokeWidth: 3,
                          strokeLinejoin: 'round',
                          pointerEvents: 'none',
                        }}
                      >
                        {point.plannedHeight.toFixed(3)}
                      </text>
                    </>
                  )
                })()}

                {/* 吸水接続マーク（丸） */}
                {point.absorptionPlannedHeight !== null && (
                  <g pointerEvents="none">
                    <circle
                      cx={x}
                      cy={yScale(point.absorptionPlannedHeight)}
                      r={5}
                      fill="#16a34a"
                      stroke="white"
                      strokeWidth="1.5"
                    />
                    {/* 吸水接続点から計画線への垂直点線 */}
                    {point.plannedHeight !== null && (
                      <line
                        x1={x}
                        y1={yScale(point.absorptionPlannedHeight)}
                        x2={x}
                        y2={yScale(point.plannedHeight)}
                        stroke="#16a34a"
                        strokeWidth="1.5"
                        strokeDasharray="4,3"
                      />
                    )}
                    <text
                      x={x - 7}
                      y={yScale(point.absorptionPlannedHeight) + 4}
                      textAnchor="end"
                      className="fill-green-700 text-[11px] font-medium"
                      style={{
                        paintOrder: 'stroke',
                        stroke: 'white',
                        strokeWidth: 3,
                        strokeLinejoin: 'round',
                      }}
                    >
                      {point.absorptionPlannedHeight.toFixed(3)}
                    </text>
                  </g>
                )}

                {/* 流入する他系統の合流点計画高（受け側集水のとき） */}
                {(() => {
                  const inflows = mergeInflowsByRowId?.get(point.rowId)
                  if (!inflows || inflows.length === 0) return null
                  return inflows.map((inflow, j) => {
                    const cy = yScale(inflow.height)
                    const size = 6
                    const fill = inflow.isReverseSlope ? '#dc2626' : '#7c3aed'
                    const labelColor = inflow.isReverseSlope
                      ? 'fill-red-700'
                      : 'fill-purple-700'
                    // 複数流入時は y 方向にずらして重ね合いを避ける
                    const yOffset = j * 14
                    return (
                      <g key={`inflow-${j}`} pointerEvents="none">
                        <polygon
                          points={`${x - size},${cy - size} ${x + size},${cy - size} ${x},${cy + size}`}
                          fill={fill}
                          stroke="white"
                          strokeWidth="1.5"
                        />
                        <text
                          x={x - 9}
                          y={cy - 8 - yOffset}
                          textAnchor="end"
                          className={`${labelColor} text-[11px] font-semibold`}
                          style={{
                            paintOrder: 'stroke',
                            stroke: 'white',
                            strokeWidth: 3,
                            strokeLinejoin: 'round',
                          }}
                        >
                          {inflow.isReverseSlope ? '⚠ 逆勾配 ' : '流入 '}
                          {inflow.systemLabel} {inflow.height.toFixed(3)}m
                        </text>
                      </g>
                    )
                  })
                })()}

                {/* 吸水上流部マーク（▼ 三角形） */}
                {point.absorptionUpstreamPlannedHeight !== null && (
                  <g pointerEvents="none">
                    {(() => {
                      const cx = x
                      const cy = yScale(point.absorptionUpstreamPlannedHeight)
                      const size = 8
                      // 下向き三角 ▼: 上辺 (cx-size, cy-size), (cx+size, cy-size) と頂点 (cx, cy+size*0.6)
                      // 頂点が上流計画高の位置に来るよう、頂点を下端ではなく中心に置く
                      const points = `${cx - size},${cy - size} ${cx + size},${cy - size} ${cx},${cy + size}`
                      return (
                        <polygon
                          points={points}
                          fill="#16a34a"
                          stroke="white"
                          strokeWidth="1.5"
                        />
                      )
                    })()}
                    <text
                      x={x - 10}
                      y={yScale(point.absorptionUpstreamPlannedHeight) - 8}
                      textAnchor="end"
                      className="fill-green-700 text-[11px] font-medium"
                      style={{
                        paintOrder: 'stroke',
                        stroke: 'white',
                        strokeWidth: 3,
                        strokeLinejoin: 'round',
                      }}
                    >
                      {point.absorptionUpstreamPlannedHeight.toFixed(3)}
                    </text>
                  </g>
                )}

                {/* 累加距離 */}
                <text
                  x={x}
                  y={chartHeight - padding.bottom + 22}
                  textAnchor="middle"
                  className="fill-slate-500 text-[16px]"
                >
                  {point.distance.toFixed(2)}m
                </text>

                {/* 垂直線（点線） */}
                <line
                  x1={x}
                  y1={chartHeight - padding.bottom}
                  x2={x}
                  y2={chartHeight - padding.bottom + 5}
                  stroke="#94a3b8"
                  strokeWidth="1"
                />

              </g>
            )
          })}

          {/* 右端に集水管の計画高（吸水断面で集水合流位置 / 集水断面で合流先系統を示す）*/}
          {endCollectorPlannedHeight != null && sectionData.length > 0 && (() => {
            const last = sectionData[sectionData.length - 1]
            const x = xScale(last.distance)
            const y = yScale(endCollectorPlannedHeight)
            // 同じ x にある計画高ラベル（x+7, plannedY+14）と重ならないよう、
            // 合流先ラベルはマーカーの左側に配置する。
            return (
              <g>
                <circle
                  cx={x}
                  cy={y}
                  r={6}
                  fill="#dc2626"
                  stroke="white"
                  strokeWidth="1.5"
                />
                <text
                  x={x - 9}
                  y={y - 6}
                  textAnchor="end"
                  className="fill-red-700 text-[12px] font-semibold"
                  style={{
                    paintOrder: 'stroke',
                    stroke: 'white',
                    strokeWidth: 3,
                    strokeLinejoin: 'round',
                  }}
                >
                  合流先 {endCollectorPlannedHeight.toFixed(3)}m
                </text>
              </g>
            )
          })()}

          {/* ホバー時のツールチップ（最後に描画して最前面に） */}
          {hoveredIdx !== null && sectionData[hoveredIdx] && (() => {
            const point = sectionData[hoveredIdx]
            const x = xScale(point.distance)
            // ツールチップ位置: 右側なら左寄せ、左側なら右寄せ
            const tipWidth = 200
            const tipHeight = 100
            const isRightHalf = x > chartWidth / 2
            const tipX = isRightHalf ? x - tipWidth - 10 : x + 10
            const tipY = padding.top + 4
            return (
              <g pointerEvents="none">
                <rect
                  x={tipX}
                  y={tipY}
                  width={tipWidth}
                  height={tipHeight}
                  fill="rgba(255,255,255,0.97)"
                  stroke="#16a34a"
                  strokeWidth="1.5"
                  rx={4}
                />
                <text x={tipX + 8} y={tipY + 18} className="text-[13px] font-semibold fill-slate-800">
                  {point.pointName}（{point.distance.toFixed(2)} m）
                </text>
                <text x={tipX + 8} y={tipY + 38} className="text-[12px] fill-amber-800">
                  地盤高: {point.groundHeight !== null ? `${point.groundHeight.toFixed(3)} m` : '-'}
                </text>
                <text x={tipX + 8} y={tipY + 56} className="text-[12px] fill-blue-700">
                  計画高: {point.plannedHeight !== null ? `${point.plannedHeight.toFixed(3)} m` : '-'}
                </text>
                <text x={tipX + 8} y={tipY + 74} className="text-[12px] fill-green-700">
                  吸水下流計画高: {point.absorptionPlannedHeight !== null ? `${point.absorptionPlannedHeight.toFixed(3)} m` : '-'}
                </text>
                <text x={tipX + 8} y={tipY + 92} className="text-[12px] fill-green-700">
                  吸水上流計画高: {point.absorptionUpstreamPlannedHeight !== null ? `${point.absorptionUpstreamPlannedHeight.toFixed(3)} m` : '-'}
                </text>
              </g>
            )
          })()}

          {/* 集水帯（X軸下、各区間ごと）。バンド開始点の測点名を表示する。 */}
          {(() => {
            if (sectionData.length === 0) return null
            const bands: Array<{
              startIdx: number
              endIdx: number
              label: string
            }> = []
            let bandStart = 0
            for (let i = 1; i <= sectionData.length; i++) {
              const prev = sectionData[i - 1]
              const cur = i < sectionData.length ? sectionData[i] : null
              if (
                !cur ||
                cur.collectorPipeId !== prev.collectorPipeId ||
                !cur.collectorPipeNumber
              ) {
                // バンド確定
                if (prev.collectorPipeNumber) {
                  // バンド開始点の測点名（例: O1C.S2A）。空ならフォールバックで集水管番号。
                  const startPoint = sectionData[bandStart]
                  const label =
                    startPoint.pointName && startPoint.pointName.trim() !== ''
                      ? startPoint.pointName
                      : prev.collectorPipeNumber
                  bands.push({
                    startIdx: bandStart,
                    endIdx: i - 1,
                    label,
                  })
                }
                bandStart = i
              }
            }
            const bandTop = chartHeight - padding.bottom + 40
            const bandHeight = 22
            return bands.map((b, idx) => {
              // 帯の右端は次の変化点（次のバンドの開始位置）まで伸ばす。
              // 最後のバンドは自身の末端まで。
              const nextBand = idx + 1 < bands.length ? bands[idx + 1] : null
              const endDistance = nextBand
                ? sectionData[nextBand.startIdx].distance
                : sectionData[b.endIdx].distance
              const x1 = xScale(sectionData[b.startIdx].distance)
              const x2 = xScale(endDistance)
              const width = Math.max(x2 - x1, 2)
              const cx = (x1 + x2) / 2
              return (
                <g key={`band-${idx}`}>
                  <rect
                    x={x1}
                    y={bandTop}
                    width={width}
                    height={bandHeight}
                    fill="#dbeafe"
                    stroke="#2563eb"
                    strokeWidth="1"
                    rx={2}
                  />
                  <text
                    x={cx}
                    y={bandTop + bandHeight / 2 + 1}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    className="fill-blue-800 text-[14px] font-semibold"
                  >
                    {b.label}
                  </text>
                </g>
              )
            })
          })()}

        </svg>
        {/* 計画高 編集ポップアップ */}
        {editPopup && onPlannedHeightChange && (() => {
          const commit = () => {
            const v = parseFloat(editValue)
            if (Number.isFinite(v)) {
              onPlannedHeightChange(editPopup.pointId, v)
            }
            setEditPopup(null)
          }
          return (
            <div
              className="absolute z-20 bg-white border border-blue-400 rounded shadow-lg px-2 py-1 flex items-center gap-1"
              style={{
                left: Math.max(4, editPopup.x - 80),
                top: Math.max(4, editPopup.y - 40),
              }}
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <span className="text-[11px] text-slate-500">計画高</span>
              <input
                type="number"
                step={0.001}
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                  if (e.key === 'Escape') setEditPopup(null)
                }}
                onWheel={(e) => e.currentTarget.blur()}
                autoFocus
                className="w-24 px-1.5 py-0.5 text-sm border rounded text-right font-mono"
              />
              <button
                onClick={commit}
                className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                OK
              </button>
              <button
                onClick={() => setEditPopup(null)}
                className="px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100 rounded"
              >
                ×
              </button>
            </div>
          )
        })()}
        </div>
      </div>
    </div>
  )
}
