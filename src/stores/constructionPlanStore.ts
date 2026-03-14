import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { useProjectStore } from './projectStore'
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
  segmentSlope: string | null // 区間勾配（1/xxx形式）
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
}

// グループ（集水暗渠タブまたは直落暗渠）
export interface PlanGroup {
  id: string
  groupType: 'collector' | 'direct'
  groupIndex: number
  name: string
  rows: PlanRow[]
}

interface ConstructionPlanState {
  // 施工計画データ
  planGroups: PlanGroup[]
  loading: boolean
  saving: boolean
  error: string | null
  hasData: boolean // 施工計画データが存在するか

  // データ取得・生成
  fetchPlan: (projectId: string) => Promise<void>
  generatePlanFromWiring: () => Promise<void> // 配管系統から施工計画を生成
  savePlan: () => Promise<void>
  deletePlan: () => Promise<void>

  // 計画高の更新
  updatePlannedHeight: (rowId: string, pointId: string, plannedHeight: number | null) => void

  // 地盤高の更新
  updateGroundHeight: (rowId: string, pointId: string, groundHeight: number | null) => void

  // 自動計算
  recalculateCutDepthAndSlope: () => void
}

// プロジェクトIDを取得するヘルパー
const getCurrentProjectId = (): string | null => {
  return useProjectStore.getState().currentProject?.id ?? null
}

// 2点間の距離を計算
const calcDistance = (p1: { x: number; y: number }, p2: { x: number; y: number }): number => {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  return Math.sqrt(dx * dx + dy * dy)
}

// 勾配を計算して "1/xxx" 形式で返す
const calcSlope = (distance: number, heightDiff: number): string | null => {
  if (distance === 0 || heightDiff === 0) return null
  const slope = Math.abs(distance / heightDiff)
  return `1/${Math.round(slope)}`
}

export const useConstructionPlanStore = create<ConstructionPlanState>()((set, get) => ({
  planGroups: [],
  loading: false,
  saving: false,
  error: null,
  hasData: false,

  fetchPlan: async (projectId: string) => {
    set({ loading: true, error: null })
    try {
      // 施工計画行を取得
      const { data: rows, error: rowError } = await supabase
        .from('construction_plan_rows')
        .select('*')
        .eq('project_id', projectId)
        .order('group_type')
        .order('group_index')
        .order('row_index')

      if (rowError) throw rowError

      if (!rows || rows.length === 0) {
        set({ planGroups: [], hasData: false, loading: false })
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

        const pipe = row.absorption_pipe_id
          ? pipes.find(p => p.id === row.absorption_pipe_id)
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
        }

        groupMap.get(groupKey)!.rows.push(planRow)
      }

      const planGroups = Array.from(groupMap.values())
      set({ planGroups, hasData: true, loading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の取得に失敗しました',
        loading: false,
      })
    }
  },

  generatePlanFromWiring: async () => {
    const projectId = getCurrentProjectId()
    if (!projectId) {
      set({ error: 'プロジェクトが選択されていません' })
      return
    }

    set({ loading: true, error: null })

    try {
      // 配管系統データを取得
      const { collectorTabs, directRows } = usePipeWiringStore.getState()
      const pipes = useUnderdrainStore.getState().pipes

      // 測量データを直接Supabaseから取得（ストアのデータが古い可能性があるため）
      const { data: surveyDataRaw } = await supabase
        .from('design_survey_data')
        .select('*')
        .eq('project_id', projectId)

      const surveyData = (surveyDataRaw || []).map((row: {
        id: string
        x: number
        y: number
        z: number | null
        category: string
        point_number: string
      }) => ({
        id: row.id,
        x: row.x,
        y: row.y,
        z: row.z,
        category: row.category,
        pointNumber: row.point_number,
      }))

      // 既存の施工計画を削除
      await supabase
        .from('construction_plan_rows')
        .delete()
        .eq('project_id', projectId)

      const planGroups: PlanGroup[] = []

      // 座標から最も近い測量データの地盤高を取得するヘルパー
      // z値を持つ測量データのみ対象
      const getGroundHeightByCoordinate = (x: number, y: number, threshold: number = 0.5): number | null => {
        const validSurvey = surveyData.filter(s => s.z !== null)
        if (validSurvey.length === 0) return null

        let nearestSurvey: typeof validSurvey[0] | null = null
        let nearestDistance = Infinity

        for (const survey of validSurvey) {
          const dx = survey.x - x
          const dy = survey.y - y
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance < nearestDistance && distance < threshold) {
            nearestDistance = distance
            nearestSurvey = survey
          }
        }

        return nearestSurvey?.z ?? null
      }

      // 管路の頂点から測点名を生成するヘルパー
      const generatePointName = (pipeNumber: string, vertexIndex: number, totalVertices: number): string => {
        if (vertexIndex === 0) {
          return `${pipeNumber}C` // 最上流
        } else if (vertexIndex === totalVertices - 1) {
          return `${pipeNumber}A` // 最下流
        } else {
          // 中間点: B1, B2, ...（上流から順）
          return `${pipeNumber}B${vertexIndex}`
        }
      }

      // 系統情報を計算するヘルパー（行ごとの系統インデックスと終端情報を返す）
      const calculateSystemInfo = (rows: typeof collectorTabs[0]['rows']) => {
        const systemInfo: Map<string, { systemIndex: number; isSystemEnd: boolean; systemEndType: 'outlet' | 'merge' | null }> = new Map()
        let currentSystemIndex = 1

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]

          // 落口行（吸水が空で集水がある行）の場合
          if (row.absorptionPipes.length === 0 && row.collectorPipe && !row.isMergePipe) {
            // 前の行があれば、それを系統終端としてマーク
            if (i > 0) {
              const prevRow = rows[i - 1]
              if (!prevRow.isMergePipe && prevRow.absorptionPipes.length > 0) {
                systemInfo.set(prevRow.id, { systemIndex: currentSystemIndex, isSystemEnd: true, systemEndType: 'outlet' })
              }
            }
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

      // 集水暗渠タブを処理
      for (let tabIndex = 0; tabIndex < collectorTabs.length; tabIndex++) {
        const tab = collectorTabs[tabIndex]
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

          // 合流管行はスキップ
          if (wiringRow.isMergePipe) continue

          // 落口行（吸水が空）はスキップ
          if (wiringRow.absorptionPipes.length === 0) continue

          // 吸水管が設定されている行のみ処理
          for (const absorptionPipeId of wiringRow.absorptionPipes) {
            const absorptionPipe = pipes.find(p => p.id === absorptionPipeId)
            if (!absorptionPipe) continue

            const collectorPipe = wiringRow.collectorPipe
              ? pipes.find(p => p.id === wiringRow.collectorPipe)
              : null

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
              }
            })

            // 区間距離を計算（最初の点以外）
            for (let i = 1; i < absorptionPoints.length; i++) {
              absorptionPoints[i].segmentDistance = calcDistance(
                absorptionPoints[i - 1],
                absorptionPoints[i]
              )
            }

            // 集水との合流点（常に接続元の下流端末番号を使用）
            let collectorPoint: PlanPoint | null = null
            if (collectorPipe && absorptionPipe.vertices.length > 0) {
              const downstreamVertex = absorptionPipe.vertices[absorptionPipe.vertices.length - 1]

              // 測点名は常に吸水管の下流端末番号を使用
              const collectorPointName = generatePointName(
                absorptionPipe.number,
                absorptionPipe.vertices.length - 1,
                absorptionPipe.vertices.length
              )

              collectorPoint = {
                id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                pointType: 'collector',
                pointIndex: 0,
                pointName: collectorPointName,
                x: downstreamVertex.x,
                y: downstreamVertex.y,
                groundHeight: getGroundHeightByCoordinate(downstreamVertex.x, downstreamVertex.y) ?? downstreamVertex.z,
                plannedHeight: null,
                cutDepth: null,
                segmentDistance: null,
                segmentSlope: null,
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
            }

            group.rows.push(planRow)
          }
        }

        if (group.rows.length > 0) {
          planGroups.push(group)
        }
      }

      // 直落暗渠を処理
      const directGroup: PlanGroup = {
        id: 'direct-0',
        groupType: 'direct',
        groupIndex: 0,
        name: '直落暗渠',
        rows: [],
      }

      for (let rowIndex = 0; rowIndex < directRows.length; rowIndex++) {
        const wiringRow = directRows[rowIndex]

        if (wiringRow.isMergePipe) continue

        for (const absorptionPipeId of wiringRow.absorptionPipes) {
          const absorptionPipe = pipes.find(p => p.id === absorptionPipeId)
          if (!absorptionPipe) continue

          const collectorPipe = wiringRow.collectorPipe
            ? pipes.find(p => p.id === wiringRow.collectorPipe)
            : null

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
            }
          })

          for (let i = 1; i < absorptionPoints.length; i++) {
            absorptionPoints[i].segmentDistance = calcDistance(
              absorptionPoints[i - 1],
              absorptionPoints[i]
            )
          }

          let collectorPoint: PlanPoint | null = null
          if (collectorPipe && absorptionPipe.vertices.length > 0) {
            const downstreamVertex = absorptionPipe.vertices[absorptionPipe.vertices.length - 1]

            let nearestCollectorPoint: PipeVertex | null = null
            let nearestDistance = Infinity

            for (const vertex of collectorPipe.vertices) {
              const dist = calcDistance(downstreamVertex, vertex)
              if (dist < nearestDistance) {
                nearestDistance = dist
                nearestCollectorPoint = vertex
              }
            }

            if (nearestCollectorPoint) {
              let collectorPointName = ''
              for (let i = 0; i < collectorPipe.vertices.length; i++) {
                const v = collectorPipe.vertices[i]
                if (v.x === nearestCollectorPoint.x && v.y === nearestCollectorPoint.y) {
                  collectorPointName = generatePointName(
                    collectorPipe.number,
                    i,
                    collectorPipe.vertices.length
                  )
                  break
                }
              }

              collectorPoint = {
                id: `point-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
                pointType: 'collector',
                pointIndex: 0,
                pointName: collectorPointName || collectorPipe.number,
                x: nearestCollectorPoint.x,
                y: nearestCollectorPoint.y,
                groundHeight: absorptionPoints.length > 0
                  ? absorptionPoints[absorptionPoints.length - 1].groundHeight
                  : nearestCollectorPoint.z,
                plannedHeight: null,
                cutDepth: null,
                segmentDistance: null,
                segmentSlope: null,
              }
            }
          }

          const planRow: PlanRow = {
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            wiringRowId: wiringRow.id,
            groupType: 'direct',
            groupIndex: 0,
            rowIndex: directGroup.rows.length,
            systemIndex: 1, // 直落暗渠は系統分けしない
            isSystemEnd: false,
            systemEndType: null,
            absorptionPipeId,
            collectorPipeId: wiringRow.collectorPipe,
            pipeNumber: absorptionPipe.number,
            diameter: absorptionPipe.diameter,
            designLength: absorptionPipe.designLength,
            absorptionPoints,
            collectorPoint,
          }

          directGroup.rows.push(planRow)
        }
      }

      if (directGroup.rows.length > 0) {
        planGroups.push(directGroup)
      }

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

      set({ planGroups, hasData: planGroups.length > 0, loading: false })

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
    const projectId = getCurrentProjectId()
    if (!projectId) {
      set({ error: 'プロジェクトが選択されていません' })
      return
    }

    const state = get()
    set({ saving: true, error: null })

    try {
      // 既存データを削除
      await supabase
        .from('construction_plan_rows')
        .delete()
        .eq('project_id', projectId)

      // 行を挿入
      for (const group of state.planGroups) {
        for (const row of group.rows) {
          const { data: rowData, error: rowError } = await supabase
            .from('construction_plan_rows')
            .insert({
              project_id: projectId,
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

      set({ saving: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の保存に失敗しました',
        saving: false,
      })
    }
  },

  deletePlan: async () => {
    const projectId = getCurrentProjectId()
    if (!projectId) return

    set({ loading: true, error: null })

    try {
      await supabase
        .from('construction_plan_rows')
        .delete()
        .eq('project_id', projectId)

      set({ planGroups: [], hasData: false, loading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '施工計画の削除に失敗しました',
        loading: false,
      })
    }
  },

  updatePlannedHeight: (rowId: string, pointId: string, plannedHeight: number | null) => {
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          if (row.id !== rowId) return row

          return {
            ...row,
            absorptionPoints: row.absorptionPoints.map(p => {
              if (p.id !== pointId) return p
              const cutDepth = p.groundHeight !== null && plannedHeight !== null
                ? p.groundHeight - plannedHeight
                : null
              return { ...p, plannedHeight, cutDepth }
            }),
            collectorPoint: row.collectorPoint?.id === pointId
              ? {
                  ...row.collectorPoint,
                  plannedHeight,
                  cutDepth: row.collectorPoint.groundHeight !== null && plannedHeight !== null
                    ? row.collectorPoint.groundHeight - plannedHeight
                    : null,
                }
              : row.collectorPoint,
          }
        }),
      }))

      return { planGroups: newGroups }
    })

    // 勾配を再計算
    get().recalculateCutDepthAndSlope()
  },

  updateGroundHeight: (rowId: string, pointId: string, groundHeight: number | null) => {
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          if (row.id !== rowId) return row

          return {
            ...row,
            absorptionPoints: row.absorptionPoints.map(p => {
              if (p.id !== pointId) return p
              const cutDepth = groundHeight !== null && p.plannedHeight !== null
                ? groundHeight - p.plannedHeight
                : null
              return { ...p, groundHeight, cutDepth }
            }),
            collectorPoint: row.collectorPoint?.id === pointId
              ? {
                  ...row.collectorPoint,
                  groundHeight,
                  cutDepth: groundHeight !== null && row.collectorPoint.plannedHeight !== null
                    ? groundHeight - row.collectorPoint.plannedHeight
                    : null,
                }
              : row.collectorPoint,
          }
        }),
      }))

      return { planGroups: newGroups }
    })
  },

  recalculateCutDepthAndSlope: () => {
    set(state => {
      const newGroups = state.planGroups.map(group => ({
        ...group,
        rows: group.rows.map(row => {
          const newAbsorptionPoints = row.absorptionPoints.map((p, idx) => {
            // 切深
            const cutDepth = p.groundHeight !== null && p.plannedHeight !== null
              ? p.groundHeight - p.plannedHeight
              : null

            // 区間勾配（最初の点以外）
            let segmentSlope: string | null = null
            if (idx > 0) {
              const prevPoint = row.absorptionPoints[idx - 1]
              if (prevPoint.plannedHeight !== null && p.plannedHeight !== null && p.segmentDistance) {
                const heightDiff = prevPoint.plannedHeight - p.plannedHeight
                segmentSlope = calcSlope(p.segmentDistance, heightDiff)
              }
            }

            return { ...p, cutDepth, segmentSlope }
          })

          // 集水点の計算
          let newCollectorPoint = row.collectorPoint
          if (newCollectorPoint) {
            const cutDepth = newCollectorPoint.groundHeight !== null && newCollectorPoint.plannedHeight !== null
              ? newCollectorPoint.groundHeight - newCollectorPoint.plannedHeight
              : null

            // 集水点の区間勾配は、同じグループ内の次の行の集水点との差で計算
            // TODO: グループ内の次の集水点との距離・勾配計算

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
}))
