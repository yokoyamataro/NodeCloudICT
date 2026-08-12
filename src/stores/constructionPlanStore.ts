import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from './farmStore'
import { usePipeWiringStore } from './pipeWiringStore'
import { useUnderdrainStore } from './underdrainStore'
import type { PipeVertex, ConstructionPlanRow, ConstructionPlanPoint } from '@/types/database'

// 施工計画の測点データ
export interface PlanPoint {
  id: string
  pointType: 'absorption' | 'collector' // 吸水測点か集水合流点か
  pointIndex: number // 点の順番（上流から）
  pointName: string // 点名
  x: number
  y: number
  groundHeight: number | null // 地盤高
  plannedHeight: number | null // 計画高（ユーザー入力）
  cutDepth: number | null // 切深（自動計算）
  segmentDistance: number | null // 区間距離
  segmentSlope: string | null // 区間勾配（1/xxx形式、自動計算の値）
  /**
   * ユーザーが勾配ダイアログで明示的に指定した勾配（1/N 形式）。
   * 指定がある間は表示でも segmentSlope より優先する。
   * フロントエンドのみ（DB には保存しない）。
   */
  manualSlope?: string | null
  /**
   * 区間ごとの管径 (mm) オーバーライド。
   * null の場合は所属パイプの design_pipes.diameter を使用する。
   * 施工計画表の管径セル (ダブルクリック) で編集可。
   */
  segmentDiameter: number | null
}

// 施工計画の行データ（吸水1本分）
export interface PlanRow {
  id: string
  wiringRowId: string // 元のpipe_wiring_rowのID
  groupType: 'collector' | 'direct'
  groupIndex: number
  rowIndex: number
  systemIndex: number // 系統インデックス（1から開始）
  isSystemEnd: boolean // 系統の終端かどうか（落口/合流）
  systemEndType: 'outlet' | 'merge' | null // 系統終端タイプ
  absorptionPipeId: string | null
  collectorPipeId: string | null
  // 吸水管の情報
  pipeNumber: string | null
  diameter: number | null
  designLength: number | null
  // 測点データ
  absorptionPoints: PlanPoint[] // 吸水の測点（上流から順）
  collectorPoint: PlanPoint | null // 集水との合流点
  // 集水合流の参照先系統（別系統の集水計画高を参照する行）
  mergeSystemIndex?: number | null
  // 配管系統で設定された行タイプ（吸水端部 / 吸水合流 / 集水合流点 等）
  wiringRowType?: string | null
}

// グループ（集水暗渠タブまたは直落暗渠）
export interface PlanGroup {
  id: string
  groupType: 'collector' | 'direct'
  groupIndex: number
  name: string
  rows: PlanRow[]
}

// 自動計画高計算パラメータ
export interface AutoCalcParams {
  kh: number // 吸水渠標準切深 (m) デフォルト: 0.80
  sh: number // 集水渠標準切深 (m) デフォルト: 0.90
  imin: number // 最低勾配 (1/imin) デフォルト: 600
  istd: number // 推奨勾配 (1/istd) デフォルト: 550
}

interface ConstructionPlanState {
  // 施工計画データ
  planGroups: PlanGroup[]
  loading: boolean
  saving: boolean
  error: string | null
  hasData: boolean // 施工計画データが存在するか
  hasChanges: boolean // 未保存の変更があるか

  // データ取得・生成
  fetchPlan: (farmId: string) => Promise<void>
  /** 配管系統から施工計画を生成（地盤高は読み込まない）。
   *  includedKeys を指定すると 対象系統だけを再生成し、それ以外は既存 planGroups を維持する。
   *  キー形式: 'collector:<tabIndex>' / 'direct' */
  generatePlanFromWiring: (includedKeys?: Set<string>) => Promise<void>
  reloadGroundHeights: () => Promise<void> // 測量データから地盤高のみを読み込み適用
  savePlan: () => Promise<void>
  deletePlan: () => Promise<void>

  // 計画高の更新
  updatePlannedHeight: (rowId: string, pointId: string, plannedHeight: number | null) => void
  /**
   * 勾配ダイアログから呼び出される、計画高の更新と勾配の手動指定を同時に行う。
   * manualSlope は表示優先で利用される。
   */
  applyManualSlope: (
    rowId: string,
    pointId: string,
    plannedHeight: number | null,
    manualSlope: string,
  ) => void

  // 地盤高の更新
  updateGroundHeight: (rowId: string, pointId: string, groundHeight: number | null) => void
  updateSegmentDiameter: (rowId: string, pointId: string, diameter: number | null) => void

  // 自動計算
  recalculateCutDepthAndSlope: () => void

  // 自動計画高計算。scope 未指定時は全グループ・全系統を対象。
  // scope を渡すと指定グループの指定系統のみ計算する。
  autoCalculatePlannedHeights: (
    params: AutoCalcParams,
    scope?: { groupIndex: number; systemIndex: number },
  ) => void

  // 変更フラグのクリア
  markSaved: () => void
}

// 工区IDを取得するヘルパー
const getCurrentFarmId = (): string | null => {
  return useFarmStore.getState().currentFarm?.id ?? null
}

// 指定桁数で四捨五入
const roundTo = (v: number, decimals: number): number => {
  const k = Math.pow(10, decimals)
  return Math.round(v * k) / k
}

// 2点間の距離を計算（施工計画では小数1桁に丸めて保存・表示・勾配計算に使用）
const calcDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }): number => {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  return roundTo(Math.sqrt(dx * dx + dy * dy), 1)
}

// 勾配を計算して "1/xxx" 形式で返す
// distance は小数1桁、heightDiff は小数3桁の前提（呼び出し側で丸め済みを期待）
const calcSlope = (distance: number, heightDiff: number): string | null => {
  if (distance === 0 || heightDiff === 0) return null
  const slope = Math.abs(distance / heightDiff)
  return `1/${Math.round(slope)}`
}

export const useConstructionPlanStore = create<ConstructionPlanState>()((set, get) => ({
  planGroups: [],
  loading: false,
  saving: false,
  hasChanges: false,
  error: null,
  hasData: false,

  fetchPlan: async (farmId: string) => {
    set({ loading: true, error: null })
    try {
      // 施工計画行を取得
      const { data: rows, error: rowError } = await supabase
        .from('construction_plan_rows')
        .select('*')
        .eq('farm_id', farmId)
        .order('group_type')
        .order('group_index')
        .order('row_index')

      if (rowError) throw rowError

      if (!rows || rows.length === 0) {
        set({ planGroups: [], hasData: false, loading: false, hasChanges: false })
        return
      }

      // 型キャスト
      const typedRows = rows as ConstructionPlanRow[]

      // 各行の測点を取得
      const rowIds = typedRows.map(r => r.id)
      const { data: points, error: pointError } = await supabase
        .from('construction_plan_points')
        .select('*')
        .in('row_id', rowIds)
        .order('point_type')
        .order('point_index')

      if (pointError) throw pointError

      // 型キャスト
      const typedPoints = (points || []) as ConstructionPlanPoint[]

      // 管路情報を取得
      const pipes = useUnderdrainStore.getState().pipes

      // 配管系統データから wiringRowId → {mergeSystemIndex, rowType} のルックアップを作成
      const wiringState = usePipeWiringStore.getState()
      const mergeInfoByWiringRowId = new Map<string, number>()
      const rowTypeByWiringRowId = new Map<string, string>()
      const allWiringRows = [
        ...wiringState.collectorTabs.flatMap((t) => t.rows),
        ...wiringState.directRows,
      ]
      for (const wr of allWiringRows) {
        if (wr.rowType === 'collector_merge' && wr.mergeSystemIndex !== null) {
          mergeInfoByWiringRowId.set(wr.id, wr.mergeSystemIndex)
        }
        if (wr.rowType) {
          rowTypeByWiringRowId.set(wr.id, wr.rowType)
        }
      }

      // データを整形
      const groupMap = new Map<string, PlanGroup>()

      for (const row of typedRows) {
        const groupKey = `${row.group_type}-${row.group_index}`

        if (!groupMap.has(groupKey)) {
          groupMap.set(groupKey, {
            id: groupKey,
            groupType: row.group_type,
            groupIndex: row.group_index,
            name: row.group_type === 'collector'
              ? `集水暗渠${row.group_index + 1}`
              : '直落暗渠',
            rows: [],
          })
        }

        // 吸水管が無い場合は集水管側の情報を使う（集水合流点・落口などの行用）
        const pipe = row.absorption_pipe_id
          ? pipes.find(p => p.id === row.absorption_pipe_id)
          : row.collector_pipe_id
            ? pipes.find(p => p.id === row.collector_pipe_id)
            : null

        const rowPoints = typedPoints.filter(p => p.row_id === row.id)
        const absorptionPoints: PlanPoint[] = rowPoints
          .filter(p => p.point_type === 'absorption')
          .map(p => ({
            id: p.id,
            pointType: 'absorption' as const,
            pointIndex: p.point_index,
            pointName: p.point_name,
            x: p.x,
            y: p.y,
            groundHeight: p.ground_height,
            plannedHeight: p.planned_height,
            cutDepth: p.cut_depth,
            segmentDistance: p.segment_distance,
            segmentSlope: p.segment_slope,
            segmentDiameter: p.segment_diameter ?? null,
          }))

        const collectorPointData = rowPoints.find(p => p.point_type === 'collector')
        const collectorPoint: PlanPoint | null = collectorPointData ? {
          id: collectorPointData.id,
          pointType: 'collector',
          pointIndex: 0,
          pointName: collectorPointData.point_name,
          x: collectorPointData.x,
          y: collectorPointData.y,
          groundHeight: collectorPointData.ground_height,
          plannedHeight: collectorPointData.planned_height,
          cutDepth: collectorPointData.cut_depth,
          segmentDistance: collectorPointData.segment_distance,
          segmentSlope: collectorPointData.segment_slope,
          segmentDiameter: collectorPointData.segment_diameter ?? null,
        } : null

        const planRow: PlanRow = {
          id: row.id,
          wiringRowId: row.wiring_row_id,
          groupType: row.group_type,
          groupIndex: row.group_index,
          rowIndex: row.row_index,
          systemIndex: (row as { system_index?: number }).system_index ?? 1,
          isSystemEnd: (row as { is_system_end?: boolean }).is_system_end ?? false,
          systemEndType: (row as { system_end_type?: 'outlet' | 'merge' | null }).system_end_type ?? null,
          absorptionPipeId: row.absorption_pipe_id,
          collectorPipeId: row.collector_pipe_id,
          pipeNumber: pipe?.number || null,
          diameter: pipe?.diameter || null,
          designLength: pipe?.designLength || null,
          absorptionPoints,
          collectorPoint,
          mergeSystemIndex: mergeInfoByWiringRowId.get(row.wiring_row_id) ?? null,
          wiringRowType: rowTypeByWiringRowId.get(row.wiring_row_id) ?? null,
        }

        groupMap.get(groupKey)!.rows.push(planRow)
      }

      const planGroups = Array.from(groupMap.values())
      set({ planGroups, hasData: true, loading: false, hasChanges: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の取得に失敗しました',
        loading: false,
      })
    }
  },

  generatePlanFromWiring: async (includedKeys?: Set<string>) => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return
    }

    set({ loading: true, error: null })

    try {
      // 配管系統データを取得
      const { collectorTabs, directRows } = usePipeWiringStore.getState()
      const pipes = useUnderdrainStore.getState().pipes

      // 部分再生成モード時は既存 planGroups から「対象外の系統」を残す。
      // 対象キーが未指定 (=全部再生成) なら 既存を全削除して再構築するのは従来通り。
      const currentPlanGroups = get().planGroups
      const isPartial = includedKeys !== undefined
      const isIncluded = (key: string): boolean =>
        includedKeys ? includedKeys.has(key) : true

      // 既存の施工計画を削除
      await supabase
        .from('construction_plan_rows')
        .delete()
        .eq('farm_id', farmId)

      const planGroups: PlanGroup[] = []

      // 地盤高は後で「地盤高読込」ボタンで当てるため、生成時点では常に null を返す
      const getGroundHeightByCoordinate = (_x: number, _y: number, _threshold: number = 0.5): number | null => {
        return null
      }

      // 管路の頂点から測点名を生成するヘルパー
      // vertexIndex=0 → C（最上流）/ 最後 → A（最下流）/ 中間 → B{i}（下流起点、座標計算ページと整合）
      const generatePointName = (pipeNumber: string, vertexIndex: number, totalVertices: number): string => {
        if (vertexIndex === 0) {
          return `${pipeNumber}C`
        } else if (vertexIndex === totalVertices - 1) {
          return `${pipeNumber}A`
        } else {
          const middleIndex = totalVertices - 1 - vertexIndex
          return `${pipeNumber}B${middleIndex}`
        }
      }

      // 前の管の下流端と一致する、次の管の頂点インデックスを検出
      // 一致が見つからなければ 0（従来どおりの C）を返す
      const findMatchingVertexIndex = (
        nextPipe: { vertices: PipeVertex[] },
        endVertex: PipeVertex,
      ): number => {
        if (nextPipe.vertices.length === 0) return 0
        const EPS = 1e-4
        for (let i = 0; i < nextPipe.vertices.length; i++) {
          const v = nextPipe.vertices[i]
          if (Math.abs(v.x - endVertex.x) < EPS && Math.abs(v.y - endVertex.y) < EPS) {
            return i
          }
        }
        return 0
      }

      // 系統情報を計算するヘルパー（行ごとの系統インデックスと終端情報を返す）
      const calculateSystemInfo = (rows: typeof collectorTabs[0]['rows']) => {
        const systemInfo: Map<string, { systemIndex: number; isSystemEnd: boolean; systemEndType: 'outlet' | 'merge' | null }> = new Map()
        let currentSystemIndex = 1

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]

          // 系統終端行（吸水が空で集水がある rowType=outlet/collector_junction の行）の場合
          // ※ collector_change は系統途中の変化点であり、系統終端ではないため除外する
          // - rowType='outlet' → 落口で系統終端
          // - rowType='collector_junction' → 集水合流点で系統終端（merge）
          if (
            row.absorptionPipes.length === 0
            && row.collectorPipe
            && !row.isMergePipe
            && (row.rowType === 'outlet' || row.rowType === 'collector_junction')
          ) {
            const endType: 'outlet' | 'merge' =
              row.rowType === 'collector_junction' ? 'merge' : 'outlet'
            // 前の行があれば、それを系統終端としてマーク
            if (i > 0) {
              const prevRow = rows[i - 1]
              if (!prevRow.isMergePipe && prevRow.absorptionPipes.length > 0) {
                systemInfo.set(prevRow.id, { systemIndex: currentSystemIndex, isSystemEnd: true, systemEndType: endType })
              }
            }
            // この collector-only 行自身も現在の系統の終端として登録（次系統に漏らさない）
            systemInfo.set(row.id, { systemIndex: currentSystemIndex, isSystemEnd: true, systemEndType: endType })
            currentSystemIndex++
            continue
          }

          // 合流管行の場合
          if (row.isMergePipe) {
            // 前の行があれば、それを系統終端としてマーク
            if (i > 0) {
              const prevRow = rows[i - 1]
              if (!prevRow.isMergePipe && prevRow.absorptionPipes.length > 0) {
                systemInfo.set(prevRow.id, { systemIndex: currentSystemIndex, isSystemEnd: true, systemEndType: 'merge' })
              }
            }
            // 合流管行も現在の系統の一部としてマーク（後の処理でスキップされるが、混入防止）
            systemInfo.set(row.id, { systemIndex: currentSystemIndex, isSystemEnd: true, systemEndType: 'merge' })
            currentSystemIndex++
            continue
          }

          // 通常の行（まだ終端でない）
          if (!systemInfo.has(row.id)) {
            systemInfo.set(row.id, { systemIndex: currentSystemIndex, isSystemEnd: false, systemEndType: null })
          }
        }

        return systemInfo
      }

      // rowType と前の集水管IDから、集水測点の位置・名前を決定するヘルパー
      // PipeWiringPage.tsx の getCollectorPointName と同じロジック
      type CollectorPointInfo = { x: number; y: number; z: number | null; name: string } | null
      const resolveCollectorPointByRowType = (
        rowType: string | null,
        collectorPipeId: string | null,
        prevCollectorPipeId: string | null
      ): CollectorPointInfo => {
        if (!collectorPipeId) return null
        const collectorPipe = pipes.find((p) => p.id === collectorPipeId)
        if (!collectorPipe || collectorPipe.vertices.length === 0) return null

        // 吸水端部: 集水管の最上流点（C）
        if (rowType === 'absorption_end') {
          const v = collectorPipe.vertices[0]
          return {
            x: v.x,
            y: v.y,
            z: v.z,
            name: generatePointName(collectorPipe.number, 0, collectorPipe.vertices.length),
          }
        }

        // 落口・集水合流点: 集水管の下流端（A）
        if (rowType === 'outlet' || rowType === 'collector_junction') {
          const lastIdx = collectorPipe.vertices.length - 1
          const v = collectorPipe.vertices[lastIdx]
          return {
            x: v.x,
            y: v.y,
            z: v.z,
            name: generatePointName(collectorPipe.number, lastIdx, collectorPipe.vertices.length),
          }
        }

        // 吸水合流・集水合流・集水変化点
        if (
          rowType === 'absorption_merge' ||
          rowType === 'collector_merge' ||
          rowType === 'collector_change'
        ) {
          // 管が変わる場合: 前管の下流端と一致する、新集水管の頂点を接続点とする
          // （CAD解析で測点を分割した場合に C 以外の中間頂点と接続し得る）
          if (prevCollectorPipeId && prevCollectorPipeId !== collectorPipeId) {
            const prevPipe = pipes.find((p) => p.id === prevCollectorPipeId)
            const prevEndVertex = prevPipe && prevPipe.vertices.length > 0
              ? prevPipe.vertices[prevPipe.vertices.length - 1]
              : null
            const idx = prevEndVertex ? findMatchingVertexIndex(collectorPipe, prevEndVertex) : 0
            const v = collectorPipe.vertices[idx]
            // 配管系統と整合: 新集水管の上流端 (vertex 0) で接続する場合は
            // 「PrevA CurrC」形式（例: S26A S27C）に結合
            let name = generatePointName(collectorPipe.number, idx, collectorPipe.vertices.length)
            if (idx === 0 && prevPipe && prevPipe.vertices.length > 0) {
              const prevEndName = generatePointName(
                prevPipe.number,
                prevPipe.vertices.length - 1,
                prevPipe.vertices.length,
              )
              name = `${prevEndName} ${name}`
            }
            return { x: v.x, y: v.y, z: v.z, name }
          }
          // 管が変わらない場合: 測点なし
          return null
        }

        return null
      }

      // 集水暗渠タブを処理
      for (let tabIndex = 0; tabIndex < collectorTabs.length; tabIndex++) {
        const tab = collectorTabs[tabIndex]
        const key = `collector:${tabIndex}`
        // 部分再生成モードで 対象外の系統は 既存 planGroups を維持
        if (isPartial && !isIncluded(key)) {
          const existing = currentPlanGroups.find(
            (g) => g.groupType === 'collector' && g.groupIndex === tabIndex,
          )
          if (existing) planGroups.push(existing)
          continue
        }
        const group: PlanGroup = {
          id: `collector-${tabIndex}`,
          groupType: 'collector',
          groupIndex: tabIndex,
          name: tab.name,
          rows: [],
        }

        // 系統情報を計算
        const systemInfo = calculateSystemInfo(tab.rows)

        for (let rowIndex = 0; rowIndex < tab.rows.length; rowIndex++) {
          const wiringRow = tab.rows[rowIndex]

          // isMergePipe=true の行は「集水合流点（系統の最後）」を表すため、
          // 吸水は空でも集水点は施工計画の行として必ず出力する。

          // 集水管情報を取得
          const collectorPipe = wiringRow.collectorPipe
            ? pipes.find(p => p.id === wiringRow.collectorPipe)
            : null

          // 前の wiring 行の集水管ID（管切替判定用）
          const prevWiringRow = rowIndex > 0 ? tab.rows[rowIndex - 1] : null
          const prevCollectorPipeId = prevWiringRow?.collectorPipe ?? null

          // 集水合流行: 吸水は別系統管理・集水は合流点（新集水管の上流端）を測点として生成
          if (wiringRow.rowType === 'collector_merge' && wiringRow.mergeSystemIndex !== null) {
            const rowSystemInfo = systemInfo.get(wiringRow.id) || {
              systemIndex: 1,
              isSystemEnd: false,
              systemEndType: null,
            }
            let mergeCollectorPoint: PlanPoint | null = null
            if (collectorPipe && collectorPipe.vertices.length > 0) {
              // 合流点 = 前の集水管の下流端と一致する、新しい集水管の頂点
              // （CAD解析で測点分割した場合は必ずしも C ではない）
              const prevPipe = prevCollectorPipeId
                ? pipes.find((p) => p.id === prevCollectorPipeId)
                : null
              const prevEndVertex = prevPipe && prevPipe.vertices.length > 0
                ? prevPipe.vertices[prevPipe.vertices.length - 1]
                : null
              const newStartIdx = prevEndVertex
                ? findMatchingVertexIndex(collectorPipe, prevEndVertex)
                : 0
              const v = collectorPipe.vertices[newStartIdx]
              const newStartName = generatePointName(
                collectorPipe.number,
                newStartIdx,
                collectorPipe.vertices.length,
              )
              // 前の集水管が異なる場合は「prevA newStart」形式の名前に
              let pointName = newStartName
              if (prevCollectorPipeId && prevCollectorPipeId !== wiringRow.collectorPipe) {
                if (prevPipe && prevPipe.vertices.length > 0) {
                  const prevEndName = generatePointName(
                    prevPipe.number,
                    prevPipe.vertices.length - 1,
                    prevPipe.vertices.length,
                  )
                  pointName = `${prevEndName} ${newStartName}`
                }
              }
              mergeCollectorPoint = {
                id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                pointType: 'collector',
                pointIndex: 0,
                pointName,
                x: v.x,
                y: v.y,
                groundHeight: getGroundHeightByCoordinate(v.x, v.y) ?? v.z,
                plannedHeight: null,
                cutDepth: null,
                segmentDistance: null,
                segmentSlope: null,
                segmentDiameter: null,
              }
            }
            const planRow: PlanRow = {
              id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              wiringRowId: wiringRow.id,
              groupType: 'collector',
              groupIndex: tabIndex,
              rowIndex: group.rows.length,
              systemIndex: rowSystemInfo.systemIndex,
              isSystemEnd: rowSystemInfo.isSystemEnd,
              systemEndType: rowSystemInfo.systemEndType,
              absorptionPipeId: null,
              collectorPipeId: wiringRow.collectorPipe,
              pipeNumber: collectorPipe?.number ?? null,
              diameter: collectorPipe?.diameter ?? null,
              designLength: collectorPipe?.designLength ?? null,
              absorptionPoints: [],
              collectorPoint: mergeCollectorPoint,
              mergeSystemIndex: wiringRow.mergeSystemIndex,
              wiringRowType: wiringRow.rowType ?? null,
            }
            group.rows.push(planRow)
            continue
          }

          // 吸水管がある行の処理
          if (wiringRow.absorptionPipes.length > 0) {
            for (const absorptionPipeId of wiringRow.absorptionPipes) {
              const absorptionPipe = pipes.find(p => p.id === absorptionPipeId)
              if (!absorptionPipe) continue

              // 吸水管の測点を生成（上流から順）
              const absorptionPoints: PlanPoint[] = absorptionPipe.vertices.map((vertex, idx) => {
                const pointName = generatePointName(
                  absorptionPipe.number,
                  idx,
                  absorptionPipe.vertices.length
                )
                return {
                  id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                  pointType: 'absorption' as const,
                  pointIndex: idx,
                  pointName,
                  x: vertex.x,
                  y: vertex.y,
                  groundHeight: getGroundHeightByCoordinate(vertex.x, vertex.y) ?? vertex.z,
                  plannedHeight: null,
                  cutDepth: null,
                  segmentDistance: null,
                  segmentSlope: null,
                  segmentDiameter: null,
                }
              })

              // 区間距離を計算（最初の点以外）
              for (let i = 1; i < absorptionPoints.length; i++) {
                absorptionPoints[i].segmentDistance = calcDistance(
                  absorptionPoints[i - 1],
                  absorptionPoints[i]
                )
              }

              // 集水との合流点（rowType と前の集水管に基づいて決定）
              // 吸水管が集水管に接続する行は、測点名が無くても集水列を保持する
              let collectorPoint: PlanPoint | null = null
              if (collectorPipe) {
                const info = resolveCollectorPointByRowType(
                  wiringRow.rowType,
                  wiringRow.collectorPipe,
                  prevCollectorPipeId
                )
                if (info) {
                  collectorPoint = {
                    id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                    pointType: 'collector',
                    pointIndex: 0,
                    pointName: info.name,
                    x: info.x,
                    y: info.y,
                    groundHeight: getGroundHeightByCoordinate(info.x, info.y) ?? info.z,
                    plannedHeight: null,
                    cutDepth: null,
                    segmentDistance: null,
                    segmentSlope: null,
                    segmentDiameter: null,
                  }
                } else if (absorptionPipe.vertices.length > 0) {
                  // 吸水合流（同一集水管）などで名前なしの集水測点を作成。
                  // 位置・地盤高は吸水管の下流端（集水管との接続点）に合わせる。
                  const downstream = absorptionPipe.vertices[absorptionPipe.vertices.length - 1]
                  collectorPoint = {
                    id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                    pointType: 'collector',
                    pointIndex: 0,
                    pointName: '',
                    x: downstream.x,
                    y: downstream.y,
                    groundHeight: getGroundHeightByCoordinate(downstream.x, downstream.y) ?? downstream.z,
                    plannedHeight: null,
                    cutDepth: null,
                    segmentDistance: null,
                    segmentSlope: null,
                    segmentDiameter: null,
                  }
                }
              }

              // 系統情報を取得
              const rowSystemInfo = systemInfo.get(wiringRow.id) || { systemIndex: 1, isSystemEnd: false, systemEndType: null }

              const planRow: PlanRow = {
                id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                wiringRowId: wiringRow.id,
                groupType: 'collector',
                groupIndex: tabIndex,
                rowIndex: group.rows.length,
                systemIndex: rowSystemInfo.systemIndex,
                isSystemEnd: rowSystemInfo.isSystemEnd,
                systemEndType: rowSystemInfo.systemEndType,
                absorptionPipeId,
                collectorPipeId: wiringRow.collectorPipe,
                pipeNumber: absorptionPipe.number,
                diameter: absorptionPipe.diameter,
                designLength: absorptionPipe.designLength,
                absorptionPoints,
                collectorPoint,
                wiringRowType: wiringRow.rowType ?? null,
              }

              group.rows.push(planRow)
            }
          } else if (collectorPipe) {
            // 吸水管がない行（collector_change, collector_junction, outlet など）
            const rowType = wiringRow.rowType

            let targetVertex: PipeVertex | null = null
            let resolvedIdx = -1

            if (collectorPipe.vertices.length > 0) {
              if (rowType === 'collector_change' || rowType === 'collector_merge') {
                // ★ 配管系統側で保存された collectorVertexIdx があればそれを最優先で使う
                const explicitIdx = (wiringRow as { collectorVertexIdx?: number }).collectorVertexIdx
                if (
                  explicitIdx !== undefined &&
                  explicitIdx !== null &&
                  explicitIdx >= 0 &&
                  explicitIdx < collectorPipe.vertices.length
                ) {
                  targetVertex = collectorPipe.vertices[explicitIdx]
                  resolvedIdx = explicitIdx
                }
                // フォールバック: 前の行の集水点の次の頂点
                if (!targetVertex) {
                  const prevRows = group.rows.filter(r => r.collectorPipeId === wiringRow.collectorPipe)
                  if (prevRows.length > 0 && collectorPipe.vertices.length > 1) {
                    const lastRow = prevRows[prevRows.length - 1]
                    if (lastRow.collectorPoint) {
                      const prevX = lastRow.collectorPoint.x
                      const prevY = lastRow.collectorPoint.y
                      for (let i = 0; i < collectorPipe.vertices.length; i++) {
                        const v = collectorPipe.vertices[i]
                        const dist = calcDistance({ x: v.x, y: v.y }, { x: prevX, y: prevY })
                        if (dist < 0.5) {
                          if (i + 1 < collectorPipe.vertices.length) {
                            targetVertex = collectorPipe.vertices[i + 1]
                            resolvedIdx = i + 1
                          }
                          break
                        }
                      }
                    }
                  }
                }
                if (!targetVertex) {
                  // 管変更の場合: 前 wiring 行の集水管下流端と一致する頂点を接続点とする
                  const prevPipe = prevCollectorPipeId
                    ? pipes.find((p) => p.id === prevCollectorPipeId)
                    : null
                  const prevEndVertex = prevPipe && prevPipe.vertices.length > 0
                    ? prevPipe.vertices[prevPipe.vertices.length - 1]
                    : null
                  const idx = prevEndVertex
                    ? findMatchingVertexIndex(collectorPipe, prevEndVertex)
                    : 0
                  targetVertex = collectorPipe.vertices[idx]
                  resolvedIdx = idx
                }
              } else {
                // outlet / collector_junction / rowType未設定: 集水管の最下流点
                const lastIdx = collectorPipe.vertices.length - 1
                targetVertex = collectorPipe.vertices[lastIdx]
                resolvedIdx = lastIdx
              }
            }

            // 測点名: 解決した頂点が新しい集水管の上流端 (vertex 0) で、
            // 前 wiring 行が別の集水管を使っていた場合は「PrevA CurrC」形式に結合する
            // （配管系統の表示と整合）
            let collectorPointName = ''
            if (targetVertex && resolvedIdx >= 0) {
              collectorPointName = generatePointName(
                collectorPipe.number,
                resolvedIdx,
                collectorPipe.vertices.length,
              )
              if (
                resolvedIdx === 0 &&
                prevCollectorPipeId &&
                prevCollectorPipeId !== wiringRow.collectorPipe
              ) {
                const prevPipe = pipes.find((p) => p.id === prevCollectorPipeId)
                if (prevPipe && prevPipe.vertices.length > 0) {
                  const prevEndName = generatePointName(
                    prevPipe.number,
                    prevPipe.vertices.length - 1,
                    prevPipe.vertices.length,
                  )
                  collectorPointName = `${prevEndName} ${collectorPointName}`
                }
              }
            }

            if (targetVertex) {
              const collectorPoint: PlanPoint = {
                id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                pointType: 'collector',
                pointIndex: 0,
                pointName: collectorPointName,
                x: targetVertex.x,
                y: targetVertex.y,
                groundHeight: getGroundHeightByCoordinate(targetVertex.x, targetVertex.y) ?? targetVertex.z,
                plannedHeight: null,
                cutDepth: null,
                segmentDistance: null,
                segmentSlope: null,
                segmentDiameter: null,
              }

              // 系統情報を取得
              const rowSystemInfo = systemInfo.get(wiringRow.id) || { systemIndex: 1, isSystemEnd: false, systemEndType: null }

              const planRow: PlanRow = {
                id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                wiringRowId: wiringRow.id,
                groupType: 'collector',
                groupIndex: tabIndex,
                rowIndex: group.rows.length,
                systemIndex: rowSystemInfo.systemIndex,
                isSystemEnd: rowSystemInfo.isSystemEnd,
                systemEndType: rowSystemInfo.systemEndType,
                absorptionPipeId: null,
                collectorPipeId: wiringRow.collectorPipe,
                pipeNumber: collectorPipe.number, // 集水管の番号を使用
                diameter: collectorPipe.diameter,
                designLength: collectorPipe.designLength,
                absorptionPoints: [], // 吸水点なし
                collectorPoint,
                wiringRowType: wiringRow.rowType ?? null,
              }

              group.rows.push(planRow)
            }
          }
        }

        if (group.rows.length > 0) {
          planGroups.push(group)
        }
      }

      // 直落暗渠を処理
      //
      // 直落暗渠は「吸水管 → 落口管」の 1 対で 1 系統。集水欄は使わず
      // 吸水欄に 吸水管の C~A + 落口管の C~A を続けて並べる (1 行)。
      //   例: K3→O3 の直落 → 吸水点: K3C, K3A, O3C, O3A (集水点なし)
      // 配管系統から追加されるパターンは
      //   [absorption_end (K3, collectorPipe=O3), outlet (—, collectorPipe=O3)]
      // で必ず対になる。この 2 行を 1 planRow にまとめる。
      const directKey = 'direct'
      if (isPartial && !isIncluded(directKey)) {
        // 対象外: 既存 直落 group を維持して 生成をスキップ
        const existingDirect = currentPlanGroups.find((g) => g.groupType === 'direct')
        if (existingDirect) planGroups.push(existingDirect)
      } else {
      const directGroup: PlanGroup = {
        id: 'direct-0',
        groupType: 'direct',
        groupIndex: 0,
        name: '直落暗渠',
        rows: [],
      }

      let directSystemIndex = 1
      for (let rowIndex = 0; rowIndex < directRows.length; rowIndex++) {
        const wiringRow = directRows[rowIndex]
        const nextRow = directRows[rowIndex + 1]

        // absorption_end + 直後の outlet (同じ落口管) をペア扱いで統合。
        // 吸水管は 1 本以上 の直列連鎖 (例: [K3, O3, O4, ..., K7-1]) を許す。
        const isPairStart =
          wiringRow.rowType === 'absorption_end' &&
          wiringRow.absorptionPipes.length >= 1 &&
          !!wiringRow.collectorPipe &&
          nextRow?.rowType === 'outlet' &&
          nextRow.absorptionPipes.length === 0 &&
          nextRow.collectorPipe === wiringRow.collectorPipe

        if (isPairStart) {
          const absorptionPipeIds = wiringRow.absorptionPipes
          const absorptionPipesInOrder = absorptionPipeIds
            .map((id) => pipes.find((p) => p.id === id))
            .filter((p): p is NonNullable<typeof p> => !!p)
          const outletPipe = pipes.find((p) => p.id === wiringRow.collectorPipe)
          if (absorptionPipesInOrder.length === 0 || !outletPipe) {
            rowIndex++ // ペア outlet 行をスキップ
            continue
          }

          const buildPoints = (
            pipe: typeof outletPipe,
            offset: number,
          ): PlanPoint[] =>
            pipe.vertices.map((vertex, idx) => ({
              id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              pointType: 'absorption' as const,
              // pointIndex は 行内で一意 (0..len-1)。DB 保存後の順序復元に使うため、
              // 各管の 0..N-1 ではなく 行全体を通した連番を渡す。
              pointIndex: offset + idx,
              pointName: generatePointName(pipe.number, idx, pipe.vertices.length),
              x: vertex.x,
              y: vertex.y,
              groundHeight: getGroundHeightByCoordinate(vertex.x, vertex.y) ?? vertex.z,
              plannedHeight: null,
              cutDepth: null,
              segmentDistance: null,
              segmentSlope: null,
              segmentDiameter: null,
            }))

          // 吸水管 (直列で複数) + 落口管 の頂点を続けて並べる
          const rawCombinedPoints: PlanPoint[] = []
          let offset = 0
          for (const p of absorptionPipesInOrder) {
            rawCombinedPoints.push(...buildPoints(p, offset))
            offset += p.vertices.length
          }
          rawCombinedPoints.push(...buildPoints(outletPipe, offset))
          // 連続する 同一位置 の点 (管の接続部: K6A と O5C 等) を 1 点に統合。
          // pointName は "K6A O5C" のように 連結して両方の測点名を残す。
          // これで 表 (施工計画) は 1 カラム 1 入力、
          // 平面図 (SFC) は 各管の pipe ループから "K6A" と "O5C" が
          // それぞれ 座標一致で lookup されて 併記される (同位置は shift)。
          const combinedPoints: PlanPoint[] = []
          const EPS_POS = 1e-4
          for (const p of rawCombinedPoints) {
            const prev = combinedPoints[combinedPoints.length - 1]
            if (
              prev &&
              Math.abs(prev.x - p.x) < EPS_POS &&
              Math.abs(prev.y - p.y) < EPS_POS
            ) {
              prev.pointName = prev.pointName ? `${prev.pointName} ${p.pointName}` : p.pointName
            } else {
              combinedPoints.push(p)
            }
          }
          // pointIndex を dedup 後の連番に振り直す
          for (let i = 0; i < combinedPoints.length; i++) {
            combinedPoints[i].pointIndex = i
          }
          // 区間距離を再計算 (最上流を除く各点)
          for (let i = 1; i < combinedPoints.length; i++) {
            combinedPoints[i].segmentDistance = calcDistance(
              combinedPoints[i - 1],
              combinedPoints[i],
            )
          }

          const headAbsorption = absorptionPipesInOrder[0]
          const planRow: PlanRow = {
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            wiringRowId: wiringRow.id,
            groupType: 'direct',
            groupIndex: 0,
            rowIndex: directGroup.rows.length,
            systemIndex: directSystemIndex,
            isSystemEnd: true,
            systemEndType: 'outlet',
            absorptionPipeId: headAbsorption.id,
            collectorPipeId: wiringRow.collectorPipe,
            pipeNumber: headAbsorption.number,
            diameter: headAbsorption.diameter,
            designLength: headAbsorption.designLength,
            absorptionPoints: combinedPoints,
            collectorPoint: null, // 直落暗渠は集水欄なし
            wiringRowType: wiringRow.rowType ?? null,
          }
          directGroup.rows.push(planRow)
          directSystemIndex++
          rowIndex++ // ペア outlet 行をスキップ
          continue
        }

        // ペアで扱えない孤立行 (ユーザーが手動で崩した場合など) は
        // 従来通り 吸水管ごとに 1 行、落口だけの行は集水点として 1 行、
        // として生成しておく (最小限のフォールバック)。
        const collectorPipe = wiringRow.collectorPipe
          ? pipes.find((p) => p.id === wiringRow.collectorPipe)
          : null
        if (wiringRow.absorptionPipes.length > 0) {
          for (const absorptionPipeId of wiringRow.absorptionPipes) {
            const absorptionPipe = pipes.find((p) => p.id === absorptionPipeId)
            if (!absorptionPipe) continue
            const absorptionPoints: PlanPoint[] = absorptionPipe.vertices.map((vertex, idx) => ({
              id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              pointType: 'absorption' as const,
              pointIndex: idx,
              pointName: generatePointName(absorptionPipe.number, idx, absorptionPipe.vertices.length),
              x: vertex.x,
              y: vertex.y,
              groundHeight: getGroundHeightByCoordinate(vertex.x, vertex.y) ?? vertex.z,
              plannedHeight: null,
              cutDepth: null,
              segmentDistance: null,
              segmentSlope: null,
              segmentDiameter: null,
            }))
            for (let i = 1; i < absorptionPoints.length; i++) {
              absorptionPoints[i].segmentDistance = calcDistance(
                absorptionPoints[i - 1],
                absorptionPoints[i],
              )
            }
            directGroup.rows.push({
              id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
              wiringRowId: wiringRow.id,
              groupType: 'direct',
              groupIndex: 0,
              rowIndex: directGroup.rows.length,
              systemIndex: directSystemIndex,
              isSystemEnd: false,
              systemEndType: null,
              absorptionPipeId,
              collectorPipeId: wiringRow.collectorPipe,
              pipeNumber: absorptionPipe.number,
              diameter: absorptionPipe.diameter,
              designLength: absorptionPipe.designLength,
              absorptionPoints,
              collectorPoint: null,
              wiringRowType: wiringRow.rowType ?? null,
            })
          }
          directSystemIndex++
        } else if (collectorPipe && wiringRow.rowType === 'outlet') {
          // 単独 outlet 行: 落口管の C~A を 吸水点として並べる (集水は空)
          const points: PlanPoint[] = collectorPipe.vertices.map((vertex, idx) => ({
            id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            pointType: 'absorption' as const,
            pointIndex: idx,
            pointName: generatePointName(collectorPipe.number, idx, collectorPipe.vertices.length),
            x: vertex.x,
            y: vertex.y,
            groundHeight: getGroundHeightByCoordinate(vertex.x, vertex.y) ?? vertex.z,
            plannedHeight: null,
            cutDepth: null,
            segmentDistance: null,
            segmentSlope: null,
            segmentDiameter: null,
          }))
          for (let i = 1; i < points.length; i++) {
            points[i].segmentDistance = calcDistance(points[i - 1], points[i])
          }
          directGroup.rows.push({
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            wiringRowId: wiringRow.id,
            groupType: 'direct',
            groupIndex: 0,
            rowIndex: directGroup.rows.length,
            systemIndex: directSystemIndex,
            isSystemEnd: true,
            systemEndType: 'outlet',
            absorptionPipeId: null,
            collectorPipeId: wiringRow.collectorPipe,
            pipeNumber: collectorPipe.number,
            diameter: collectorPipe.diameter,
            designLength: collectorPipe.designLength,
            absorptionPoints: points,
            collectorPoint: null,
            wiringRowType: wiringRow.rowType ?? null,
          })
          directSystemIndex++
        }
      }

      if (directGroup.rows.length > 0) {
        planGroups.push(directGroup)
      }
      } // else (direct-included) 閉じ

      // 系統内の集水点の区間距離を計算（現在の行と次の行の集水点間の距離）
      for (const group of planGroups) {
        // 系統ごとにグループ化
        const systemMap: Record<number, PlanRow[]> = {}
        for (const row of group.rows) {
          const sysIdx = row.systemIndex || 1
          if (!systemMap[sysIdx]) systemMap[sysIdx] = []
          systemMap[sysIdx].push(row)
        }

        // 各系統内で集水点の区間距離を計算
        for (const sysIdx in systemMap) {
          const rows = systemMap[sysIdx]
          for (let i = 0; i < rows.length; i++) {
            const currentRow = rows[i]
            const nextRow = i < rows.length - 1 ? rows[i + 1] : null

            if (currentRow.collectorPoint && nextRow?.collectorPoint) {
              // 次の行の集水点との距離を計算
              currentRow.collectorPoint.segmentDistance = calcDistance(
                currentRow.collectorPoint,
                nextRow.collectorPoint
              )
            }
          }
        }
      }

      set({ planGroups, hasData: planGroups.length > 0, loading: false, hasChanges: true })

      // DBに保存
      await get().savePlan()
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の生成に失敗しました',
        loading: false,
      })
    }
  },

  savePlan: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return
    }

    const state = get()
    set({ saving: true, error: null })

    try {
      // 既存データを削除
      await supabase
        .from('construction_plan_rows')
        .delete()
        .eq('farm_id', farmId)

      // 行を挿入
      for (const group of state.planGroups) {
        for (const row of group.rows) {
          const { data: rowData, error: rowError } = await supabase
            .from('construction_plan_rows')
            .insert({
              farm_id: farmId,
              wiring_row_id: row.wiringRowId,
              group_type: row.groupType,
              group_index: row.groupIndex,
              row_index: row.rowIndex,
              system_index: row.systemIndex,
              is_system_end: row.isSystemEnd,
              system_end_type: row.systemEndType,
              absorption_pipe_id: row.absorptionPipeId,
              collector_pipe_id: row.collectorPipeId,
            } as never)
            .select()
            .single()

          if (rowError) throw rowError

          const rowId = (rowData as { id: string }).id

          // 測点を挿入
          const pointsToInsert = [
            ...row.absorptionPoints.map(p => ({
              row_id: rowId,
              point_type: 'absorption',
              point_index: p.pointIndex,
              point_name: p.pointName,
              x: p.x,
              y: p.y,
              ground_height: p.groundHeight,
              planned_height: p.plannedHeight,
              cut_depth: p.cutDepth,
              segment_distance: p.segmentDistance,
              segment_slope: p.segmentSlope,
              segment_diameter: p.segmentDiameter,
            })),
            ...(row.collectorPoint ? [{
              row_id: rowId,
              point_type: 'collector',
              point_index: 0,
              point_name: row.collectorPoint.pointName,
              x: row.collectorPoint.x,
              y: row.collectorPoint.y,
              ground_height: row.collectorPoint.groundHeight,
              planned_height: row.collectorPoint.plannedHeight,
              cut_depth: row.collectorPoint.cutDepth,
              segment_distance: row.collectorPoint.segmentDistance,
              segment_slope: row.collectorPoint.segmentSlope,
              segment_diameter: row.collectorPoint.segmentDiameter,
            }] : []),
          ]

          if (pointsToInsert.length > 0) {
            const { error: pointError } = await supabase
              .from('construction_plan_points')
              .insert(pointsToInsert as never)

            if (pointError) throw pointError
          }
        }
      }

      set({ saving: false, hasChanges: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の保存に失敗しました',
        saving: false,
      })
    }
  },

  deletePlan: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) return

    set({ loading: true, error: null })

    try {
      await supabase
        .from('construction_plan_rows')
        .delete()
        .eq('farm_id', farmId)

      set({ planGroups: [], hasData: false, loading: false, hasChanges: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の削除に失敗しました',
        loading: false,
      })
    }
  },

  reloadGroundHeights: async () => {
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '工区が選択されていません' })
      return
    }

    set({ loading: true, error: null })

    try {
      // Z 補正: DB (design_survey_calibration.dz_offset) を優先し、
      // 未マイグレーション環境等で取得できなければ localStorage をフォールバック。
      // StakingRecordsPage 側で編集された値が PC/スマホ間で共有される。
      let zOffset = 0
      let gotFromDb = false
      try {
        const { data } = await supabase
          .from('design_survey_calibration')
          .select('dz_offset')
          .eq('farm_id', farmId)
          .maybeSingle()
        const row = data as { dz_offset: number | string } | null
        if (row?.dz_offset != null) {
          const v = Number(row.dz_offset)
          if (Number.isFinite(v)) {
            zOffset = v
            gotFromDb = true
          }
        }
      } catch {
        /* noop */
      }
      if (!gotFromDb) {
        try {
          const raw = typeof localStorage !== 'undefined'
            ? localStorage.getItem(`staking:zOffset:${farmId}`)
            : null
          const v = raw != null ? parseFloat(raw) : 0
          zOffset = Number.isFinite(v) ? v : 0
        } catch {
          zOffset = 0
        }
      }

      // 起工測量の実測記録 (staking_records) を取得。
      // 出来形 (asbuilt) は含めず、起工 (initial) のみを地盤高の元とする。
      const { data: recordsRaw } = await supabase
        .from('staking_records')
        .select(
          'id, measured_x, measured_y, measured_z, target_name, survey_category',
        )
        .eq('farm_id', farmId)
        .eq('survey_category', 'initial')

      const validSurvey = ((recordsRaw || []) as Array<{
        id: string
        measured_x: number | string
        measured_y: number | string
        measured_z: number | string | null
        target_name: string | null
      }>)
        .map((row) => {
          const z = row.measured_z != null ? Number(row.measured_z) : null
          // 0 は「未計測」を意味する。北海道の暗渠現場は 20m 以上の標高が
          // 通常のため、0 を有効値として取り込むと切深に大きな誤差を生む。
          if (z == null || !Number.isFinite(z) || z === 0) return null
          const x = Number(row.measured_x)
          const y = Number(row.measured_y)
          if (!Number.isFinite(x) || !Number.isFinite(y)) return null
          return {
            id: row.id,
            x,
            y,
            z: z + zOffset, // 補正 Z
            pointNumber: row.target_name ?? '',
          }
        })
        .filter(
          (r): r is { id: string; x: number; y: number; z: number; pointNumber: string } =>
            r !== null,
        )

      const findGroundHeight = (x: number, y: number, threshold = 0.5): number | null => {
        let nearest: (typeof validSurvey)[number] | null = null
        let nearestDistance = Infinity
        for (const s of validSurvey) {
          const dx = s.x - x
          const dy = s.y - y
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < nearestDistance && dist < threshold) {
            nearestDistance = dist
            nearest = s
          }
        }
        // 地盤高は小数点2桁に丸めて適用
        return nearest ? Math.round(nearest.z * 100) / 100 : null
      }

      const newGroups = get().planGroups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => {
          const newAbsorption = row.absorptionPoints.map((p) => {
            const gh = findGroundHeight(p.x, p.y)
            if (gh === null) return p
            const cutDepth = p.plannedHeight !== null ? gh - p.plannedHeight : p.cutDepth
            return { ...p, groundHeight: gh, cutDepth }
          })
          let newCollector = row.collectorPoint
          if (newCollector) {
            const gh = findGroundHeight(newCollector.x, newCollector.y)
            if (gh !== null) {
              const cutDepth =
                newCollector.plannedHeight !== null ? gh - newCollector.plannedHeight : newCollector.cutDepth
              newCollector = { ...newCollector, groundHeight: gh, cutDepth }
            }
          }
          return { ...row, absorptionPoints: newAbsorption, collectorPoint: newCollector }
        }),
      }))

      set({ planGroups: newGroups, loading: false, hasChanges: true })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '地盤高の読込に失敗しました',
        loading: false,
      })
    }
  },

  updatePlannedHeight: (rowId: string, pointId: string, plannedHeight: number | null) => {
    // 計画高は小数3桁に丸めて保存（勾配計算でも同じ値を使用）
    const ph = plannedHeight != null ? roundTo(plannedHeight, 3) : null
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          if (row.id !== rowId) return row

          return {
            ...row,
            absorptionPoints: row.absorptionPoints.map(p => {
              if (p.id !== pointId) return p
              const cutDepth = p.groundHeight !== null && ph !== null
                ? roundTo(p.groundHeight - ph, 3)
                : null
              // 直接編集された場合は手動勾配指定を解除（自動再計算を再開）
              return { ...p, plannedHeight: ph, cutDepth, manualSlope: null }
            }),
            collectorPoint: row.collectorPoint?.id === pointId
              ? {
                  ...row.collectorPoint,
                  plannedHeight: ph,
                  cutDepth: row.collectorPoint.groundHeight !== null && ph !== null
                    ? roundTo(row.collectorPoint.groundHeight - ph, 3)
                    : null,
                  manualSlope: null,
                }
              : row.collectorPoint,
          }
        }),
      }))

      return { planGroups: newGroups, hasChanges: true }
    })

    // 勾配を再計算
    get().recalculateCutDepthAndSlope()
  },

  applyManualSlope: (rowId, pointId, plannedHeight, manualSlope) => {
    const ph = plannedHeight != null ? roundTo(plannedHeight, 3) : null
    set((state) => {
      const newGroups = state.planGroups.map((group) => ({
        ...group,
        rows: group.rows.map((row) => {
          if (row.id !== rowId) return row
          return {
            ...row,
            absorptionPoints: row.absorptionPoints.map((p) => {
              if (p.id !== pointId) return p
              const cutDepth =
                p.groundHeight !== null && ph !== null
                  ? roundTo(p.groundHeight - ph, 3)
                  : null
              return { ...p, plannedHeight: ph, cutDepth, manualSlope }
            }),
            collectorPoint:
              row.collectorPoint?.id === pointId
                ? {
                    ...row.collectorPoint,
                    plannedHeight: ph,
                    cutDepth:
                      row.collectorPoint.groundHeight !== null && ph !== null
                        ? roundTo(row.collectorPoint.groundHeight - ph, 3)
                        : null,
                    manualSlope,
                  }
                : row.collectorPoint,
          }
        }),
      }))
      return { planGroups: newGroups, hasChanges: true }
    })
    // recalc は segmentSlope のみ更新する（manualSlope は保持される）
    get().recalculateCutDepthAndSlope()
  },

  updateSegmentDiameter: (rowId: string, pointId: string, diameter: number | null) => {
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          if (row.id !== rowId) return row
          return {
            ...row,
            absorptionPoints: row.absorptionPoints.map(p =>
              p.id === pointId ? { ...p, segmentDiameter: diameter } : p,
            ),
            collectorPoint:
              row.collectorPoint?.id === pointId
                ? { ...row.collectorPoint, segmentDiameter: diameter }
                : row.collectorPoint,
          }
        }),
      }))
      return { planGroups: newGroups, hasChanges: true }
    })
  },

  updateGroundHeight: (rowId: string, pointId: string, groundHeight: number | null) => {
    // 地盤高は 2 桁、切深は 3 桁で保存
    const gh = groundHeight != null ? roundTo(groundHeight, 2) : null
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          if (row.id !== rowId) return row

          return {
            ...row,
            absorptionPoints: row.absorptionPoints.map(p => {
              if (p.id !== pointId) return p
              const cutDepth = gh !== null && p.plannedHeight !== null
                ? roundTo(gh - p.plannedHeight, 3)
                : null
              return { ...p, groundHeight: gh, cutDepth }
            }),
            collectorPoint: row.collectorPoint?.id === pointId
              ? {
                  ...row.collectorPoint,
                  groundHeight: gh,
                  cutDepth: gh !== null && row.collectorPoint.plannedHeight !== null
                    ? roundTo(gh - row.collectorPoint.plannedHeight, 3)
                    : null,
                }
              : row.collectorPoint,
          }
        }),
      }))

      return { planGroups: newGroups, hasChanges: true }
    })
  },

  recalculateCutDepthAndSlope: () => {
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          const newAbsorptionPoints = row.absorptionPoints.map((p, idx) => {
            // 切深（丸め 3 桁）
            const cutDepth = p.groundHeight !== null && p.plannedHeight !== null
              ? roundTo(p.groundHeight - p.plannedHeight, 3)
              : null

            // 区間勾配（最初の点以外）
            // 距離は既に 1 桁、計画高は 3 桁で保存されているので、丸め済みの値で計算する
            let segmentSlope: string | null = null
            if (idx > 0) {
              const prevPoint = row.absorptionPoints[idx - 1]
              if (prevPoint.plannedHeight !== null && p.plannedHeight !== null && p.segmentDistance) {
                const heightDiff = roundTo(prevPoint.plannedHeight - p.plannedHeight, 3)
                segmentSlope = calcSlope(p.segmentDistance, heightDiff)
              }
            }

            return { ...p, cutDepth, segmentSlope }
          })

          // 集水点の計算
          let newCollectorPoint = row.collectorPoint
          if (newCollectorPoint) {
            const cutDepth = newCollectorPoint.groundHeight !== null && newCollectorPoint.plannedHeight !== null
              ? roundTo(newCollectorPoint.groundHeight - newCollectorPoint.plannedHeight, 3)
              : null

            newCollectorPoint = { ...newCollectorPoint, cutDepth }
          }

          return {
            ...row,
            absorptionPoints: newAbsorptionPoints,
            collectorPoint: newCollectorPoint,
          }
        }),
      }))

      return { planGroups: newGroups }
    })
  },

  autoCalculatePlannedHeights: (params: AutoCalcParams, scope) => {
    const { kh, sh, istd } = params

    set(state => {
      const newGroups = state.planGroups.map((group, gi) => {
        // scope 指定時、対象外グループはそのまま返す
        if (scope && gi !== scope.groupIndex) return group

        // 系統ごとにグループ化
        const systemMap: Record<number, PlanRow[]> = {}
        for (const row of group.rows) {
          const sysIdx = row.systemIndex || 1
          if (!systemMap[sysIdx]) systemMap[sysIdx] = []
          systemMap[sysIdx].push(row)
        }

        // 各系統ごとに計算
        const updatedRows = [...group.rows]

        for (const sysIdx in systemMap) {
          // scope 指定時、対象外系統はスキップ
          if (scope && parseInt(sysIdx) !== scope.systemIndex) continue
          const systemRows = systemMap[sysIdx]

          // 系統内の行を上流から下流の順で処理
          for (let rowIdx = 0; rowIdx < systemRows.length; rowIdx++) {
            const row = systemRows[rowIdx]
            const rowInGroup = updatedRows.find(r => r.id === row.id)
            if (!rowInGroup) continue

            // 吸水点の計画高を計算（上流から順に計算し、直前に計算した計画高を次点で参照）
            const newAbsorptionPoints: PlanPoint[] = []
            for (let pointIdx = 0; pointIdx < rowInGroup.absorptionPoints.length; pointIdx++) {
              const point = rowInGroup.absorptionPoints[pointIdx]
              if (point.groundHeight === null) {
                newAbsorptionPoints.push(point)
                continue
              }

              let plannedHeight: number

              if (pointIdx === 0) {
                // 最上流点: 地盤高 - kh
                plannedHeight = point.groundHeight - kh
              } else {
                // それ以外: min(地盤高 - kh, 上流点計画高 - 距離 / 推奨勾配)
                const prevPoint = newAbsorptionPoints[pointIdx - 1]
                const standardHeight = point.groundHeight - kh

                if (prevPoint.plannedHeight !== null && point.segmentDistance !== null) {
                  const slopeHeight = prevPoint.plannedHeight - (point.segmentDistance / istd)
                  plannedHeight = Math.min(standardHeight, slopeHeight)
                } else {
                  plannedHeight = standardHeight
                }
              }

              const phRounded = roundTo(plannedHeight, 3)
              const cutDepth = roundTo(point.groundHeight - phRounded, 3)
              newAbsorptionPoints.push({ ...point, plannedHeight: phRounded, cutDepth })
            }

            // 集水点の計画高を計算
            let newCollectorPoint = rowInGroup.collectorPoint
            if (newCollectorPoint && newCollectorPoint.groundHeight !== null) {
              // 接続する吸水下流部の計画高を取得
              const absorptionDownstreamHeight = newAbsorptionPoints.length > 0
                ? newAbsorptionPoints[newAbsorptionPoints.length - 1].plannedHeight
                : null

              // 標準切深による計画高
              const standardHeight = newCollectorPoint.groundHeight - sh

              // 計画高の候補
              const candidates: number[] = [standardHeight]

              // 吸水下流部の計画高を追加
              if (absorptionDownstreamHeight !== null) {
                candidates.push(absorptionDownstreamHeight)
              }

              // 前の行の集水点計画高からの勾配による計画高
              if (rowIdx > 0) {
                const prevRow = systemRows[rowIdx - 1]
                const prevRowInGroup = updatedRows.find(r => r.id === prevRow.id)
                if (prevRowInGroup &&
                    prevRowInGroup.collectorPoint &&
                    prevRowInGroup.collectorPoint.plannedHeight !== null &&
                    prevRowInGroup.collectorPoint.segmentDistance !== null) {
                  const slopeHeight = prevRowInGroup.collectorPoint.plannedHeight -
                    (prevRowInGroup.collectorPoint.segmentDistance / istd)
                  candidates.push(slopeHeight)
                }
              }

              // 最小値を計画高とする
              const plannedHeight = roundTo(Math.min(...candidates), 3)
              const cutDepth = roundTo(newCollectorPoint.groundHeight - plannedHeight, 3)

              newCollectorPoint = { ...newCollectorPoint, plannedHeight, cutDepth }
            }

            // 行を更新
            const rowIndex = updatedRows.findIndex(r => r.id === row.id)
            if (rowIndex !== -1) {
              updatedRows[rowIndex] = {
                ...updatedRows[rowIndex],
                absorptionPoints: newAbsorptionPoints,
                collectorPoint: newCollectorPoint,
              }
            }
          }
        }

        return { ...group, rows: updatedRows }
      })

      return { planGroups: newGroups, hasChanges: true }
    })

    // 勾配を再計算
    get().recalculateCutDepthAndSlope()
  },

  markSaved: () => {
    set({ hasChanges: false })
  },
}))
