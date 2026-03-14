import { useMemo } from 'react'
import type { PlanRow } from '@/stores/constructionPlanStore'

interface CrossSectionChartProps {
  systemRows: PlanRow[] // 系統内の行（rowIndex順）
  systemIndex: number
  endType: 'outlet' | 'merge' | null
}

// 断面図の点データ
interface SectionPoint {
  distance: number // 累積距離（左からの位置）
  groundHeight: number | null // 現況高（地盤高）
  plannedHeight: number | null // 計画高
  pointName: string // 測点名
  pipeNumber: string | null // 管番号
  isCollectorPoint: boolean // 集水接続点かどうか
  absorptionPlannedHeight: number | null // 接続している吸水下流部の計画高
}

export function CrossSectionChart({ systemRows, systemIndex, endType }: CrossSectionChartProps) {
  // 系統の全測点を累積距離で配置
  // 集水渠断面図: 最上流（左）→ 最下流（右）
  // 系統の行は rowIndex 順で、最上流行が最初
  const sectionData = useMemo(() => {
    const points: SectionPoint[] = []
    let cumulativeDistance = 0

    // 行を順に処理（最上流から最下流へ）
    for (let rowIdx = 0; rowIdx < systemRows.length; rowIdx++) {
      const row = systemRows[rowIdx]
      const prevRow = rowIdx > 0 ? systemRows[rowIdx - 1] : null

      // 前の行の集水点から現在の行の最初の吸水点までの距離を加算
      // （同じ系統内で連続する行の間の距離）
      if (rowIdx > 0 && prevRow?.collectorPoint && row.absorptionPoints.length > 0) {
        // 前の集水点と現在の吸水上流点の間は、集水管上の距離
        // 実際には設計データから計算すべきだが、ここでは簡略化
        cumulativeDistance += 2 // 仮の接続距離
      }

      // 吸水測点を追加（上流から下流の順）
      for (let pIdx = 0; pIdx < row.absorptionPoints.length; pIdx++) {
        const point = row.absorptionPoints[pIdx]

        // 最初の点以外は区間距離を加算
        if (pIdx > 0 && point.segmentDistance !== null) {
          cumulativeDistance += point.segmentDistance
        }

        points.push({
          distance: cumulativeDistance,
          groundHeight: point.groundHeight,
          plannedHeight: point.plannedHeight,
          pointName: point.pointName,
          pipeNumber: row.pipeNumber,
          isCollectorPoint: false,
          absorptionPlannedHeight: null,
        })
      }

      // 集水接続点を追加
      if (row.collectorPoint) {
        // 吸水下流点から集水接続点への距離
        if (row.collectorPoint.segmentDistance !== null) {
          cumulativeDistance += row.collectorPoint.segmentDistance
        } else if (row.absorptionPoints.length > 0) {
          // 区間距離がない場合は、最後の吸水点から少し離す
          cumulativeDistance += 1
        }

        // 吸水下流部の計画高を取得
        const absorptionDownstreamHeight = row.absorptionPoints.length > 0
          ? row.absorptionPoints[row.absorptionPoints.length - 1].plannedHeight
          : null

        points.push({
          distance: cumulativeDistance,
          groundHeight: row.collectorPoint.groundHeight,
          plannedHeight: row.collectorPoint.plannedHeight,
          pointName: row.collectorPoint.pointName,
          pipeNumber: row.pipeNumber,
          isCollectorPoint: true,
          absorptionPlannedHeight: absorptionDownstreamHeight,
        })
      }
    }

    return points
  }, [systemRows])

  // 描画範囲を計算
  const { minHeight, maxHeight, totalDistance, padding, chartWidth, chartHeight } = useMemo(() => {
    const heights = sectionData
      .flatMap(p => [p.groundHeight, p.plannedHeight, p.absorptionPlannedHeight])
      .filter((h): h is number => h !== null)

    if (heights.length === 0) {
      return {
        minHeight: 0,
        maxHeight: 10,
        totalDistance: 100,
        padding: { top: 30, right: 50, bottom: 50, left: 60 },
        chartWidth: 600,
        chartHeight: 200,
      }
    }

    const min = Math.min(...heights)
    const max = Math.max(...heights)
    const range = max - min || 1
    const heightPadding = range * 0.2

    const dist = sectionData.length > 0 ? sectionData[sectionData.length - 1].distance : 100

    return {
      minHeight: min - heightPadding,
      maxHeight: max + heightPadding,
      totalDistance: dist || 100,
      padding: { top: 30, right: 50, bottom: 50, left: 60 },
      chartWidth: Math.max(600, dist * 4 + 120), // 距離に応じて幅を調整
      chartHeight: 200,
    }
  }, [sectionData])

  // 座標変換関数
  const xScale = (distance: number) => {
    return padding.left + (distance / totalDistance) * (chartWidth - padding.left - padding.right)
  }

  const yScale = (height: number) => {
    const range = maxHeight - minHeight
    return padding.top + (1 - (height - minHeight) / range) * (chartHeight - padding.top - padding.bottom)
  }

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

  if (sectionData.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-slate-400 text-sm">
        データがありません
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
          系統 {systemIndex} 断面図
          {endType === 'outlet' && ' （落口）'}
          {endType === 'merge' && ' （合流）'}
        </span>
        <span className="text-xs text-slate-500 ml-2">
          ← 上流　｜　下流 →
        </span>
      </div>

      {/* SVG断面図 */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden bg-white">
        <svg
          width={chartWidth}
          height={chartHeight}
          className="min-w-full"
        >
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
                  className="fill-slate-600 text-[10px]"
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
              className="fill-slate-600 text-xs font-medium"
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

          {/* 測点マーカーとラベル */}
          {sectionData.map((point, idx) => {
            const x = xScale(point.distance)

            return (
              <g key={idx}>
                {/* 現況点マーカー */}
                {point.groundHeight !== null && (
                  <circle
                    cx={x}
                    cy={yScale(point.groundHeight)}
                    r={4}
                    fill="#92400e"
                    stroke="white"
                    strokeWidth="1"
                  />
                )}

                {/* 計画点マーカー */}
                {point.plannedHeight !== null && (
                  <circle
                    cx={x}
                    cy={yScale(point.plannedHeight)}
                    r={4}
                    fill="#2563eb"
                    stroke="white"
                    strokeWidth="1"
                  />
                )}

                {/* 吸水接続マーク（三角形） - 集水接続点に吸水下流部の計画高を表示 */}
                {point.isCollectorPoint && point.absorptionPlannedHeight !== null && (
                  <g>
                    <polygon
                      points={`${x},${yScale(point.absorptionPlannedHeight) - 10} ${x - 7},${yScale(point.absorptionPlannedHeight) + 2} ${x + 7},${yScale(point.absorptionPlannedHeight) + 2}`}
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
                        strokeWidth="1"
                        strokeDasharray="3,2"
                      />
                    )}
                  </g>
                )}

                {/* 測点名ラベル */}
                <text
                  x={x}
                  y={chartHeight - padding.bottom + 14}
                  textAnchor="middle"
                  className={`text-[9px] ${point.isCollectorPoint ? 'fill-green-700 font-medium' : 'fill-slate-600'}`}
                >
                  {point.pointName}
                </text>

                {/* 管番号（集水点の場合） */}
                {point.isCollectorPoint && point.pipeNumber && (
                  <text
                    x={x}
                    y={chartHeight - padding.bottom + 26}
                    textAnchor="middle"
                    className="fill-slate-400 text-[8px]"
                  >
                    (集水)
                  </text>
                )}

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

          {/* 凡例 */}
          <g transform={`translate(${chartWidth - padding.right - 140}, ${padding.top})`}>
            <rect x="0" y="0" width="130" height="72" fill="white" stroke="#e2e8f0" rx="4" />

            {/* 現況線 */}
            <line x1="10" y1="14" x2="28" y2="14" stroke="#92400e" strokeWidth="2" />
            <circle cx="19" cy="14" r="3" fill="#92400e" />
            <text x="35" y="14" dominantBaseline="middle" className="fill-slate-700 text-[10px]">現況高</text>

            {/* 計画線 */}
            <line x1="10" y1="30" x2="28" y2="30" stroke="#2563eb" strokeWidth="2" />
            <circle cx="19" cy="30" r="3" fill="#2563eb" />
            <text x="35" y="30" dominantBaseline="middle" className="fill-slate-700 text-[10px]">計画高</text>

            {/* 吸水接続 */}
            <polygon points="19,40 13,50 25,50" fill="#16a34a" />
            <text x="35" y="46" dominantBaseline="middle" className="fill-slate-700 text-[10px]">吸水下流部</text>

            {/* 接続線 */}
            <line x1="10" y1="60" x2="28" y2="60" stroke="#16a34a" strokeWidth="1" strokeDasharray="3,2" />
            <text x="35" y="60" dominantBaseline="middle" className="fill-slate-700 text-[10px]">接続</text>
          </g>
        </svg>
      </div>
    </div>
  )
}
