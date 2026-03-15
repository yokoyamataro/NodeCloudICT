import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { PipeWiringGroup, PipeWiringRow } from '@/types/database'
import { useProjectStore } from './projectStore'

// 行タイプの定義
export type RowType =
  | 'absorption_end'      // 吸水端部（最上流の吸水）
  | 'absorption_merge'    // 吸水合流（吸水と集水が合流する点）
  | 'collector_merge'     // 集水合流（別系統の集水と合流する点）
  | 'collector_change'    // 集水変化点（吸水なしで折れ点/管径変化点）
  | 'collector_junction'  // 集水合流点（系統の最後）
  | 'outlet'              // 落口（系統の最後）

// ローカル状態用の行型
export interface WiringRow {
  id: string
  rowType: RowType | null    // 行タイプ
  absorptionPipes: string[]  // 吸水（複数選択可能）
  collectorPipe: string | null    // 集水（または落口）
  isMergePipe: boolean  // 集水合流管かどうか
}

// ローカル状態用のタブ型
export interface CollectorTab {
  id: string
  name: string
  rows: WiringRow[]
}

// プロジェクトIDを取得するヘルパー
const getCurrentProjectId = (): string | null => {
  return useProjectStore.getState().currentProject?.id ?? null
}

// アップデータ関数の型
type TabsUpdater = CollectorTab[] | ((prev: CollectorTab[]) => CollectorTab[])
type RowsUpdater = WiringRow[] | ((prev: WiringRow[]) => WiringRow[])

interface PipeWiringState {
  // 集水暗渠タブ（複数）
  collectorTabs: CollectorTab[]
  // 直落暗渠行
  directRows: WiringRow[]
  // 読み込み状態
  loading: boolean
  saving: boolean
  error: string | null
  // データ操作
  fetchWiring: (projectId: string) => Promise<void>
  saveWiring: () => Promise<void>
  // タブ操作（関数も受け付ける）
  setCollectorTabs: (updater: TabsUpdater) => void
  setDirectRows: (updater: RowsUpdater) => void
  // 変更検知
  hasChanges: boolean
  setHasChanges: (value: boolean) => void
}

// 空の行を作成
function createEmptyRow(): WiringRow {
  return {
    id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    rowType: null,
    absorptionPipes: [],
    collectorPipe: null,
    isMergePipe: false,
  }
}

export const usePipeWiringStore = create<PipeWiringState>()((set, get) => ({
  collectorTabs: [
    {
      id: 'collector-1',
      name: '集水暗渠1',
      rows: [createEmptyRow()],
    },
  ],
  directRows: [createEmptyRow()],
  loading: false,
  saving: false,
  error: null,
  hasChanges: false,

  setCollectorTabs: (updater) => {
    const state = get()
    const newTabs = typeof updater === 'function' ? updater(state.collectorTabs) : updater
    set({ collectorTabs: newTabs, hasChanges: true })
  },

  setDirectRows: (updater) => {
    const state = get()
    const newRows = typeof updater === 'function' ? updater(state.directRows) : updater
    set({ directRows: newRows, hasChanges: true })
  },

  setHasChanges: (value) => {
    set({ hasChanges: value })
  },

  fetchWiring: async (projectId: string) => {
    set({ loading: true, error: null })
    try {
      // グループを取得
      const { data: groups, error: groupError } = await supabase
        .from('pipe_wiring_groups')
        .select('*')
        .eq('project_id', projectId)
        .order('sort_order')

      if (groupError) throw groupError

      if (!groups || groups.length === 0) {
        // データがない場合は初期状態に
        set({
          collectorTabs: [
            {
              id: 'collector-1',
              name: '集水暗渠1',
              rows: [createEmptyRow()],
            },
          ],
          directRows: [createEmptyRow()],
          loading: false,
          hasChanges: false,
        })
        return
      }

      // 全グループの行を取得
      const groupIds = (groups as PipeWiringGroup[]).map(g => g.id)
      const { data: rows, error: rowError } = await supabase
        .from('pipe_wiring_rows')
        .select('*')
        .in('group_id', groupIds)
        .order('sort_order')

      if (rowError) throw rowError

      // グループごとに行を整理
      const collectorTabs: CollectorTab[] = []
      let directRows: WiringRow[] = []

      for (const group of groups as PipeWiringGroup[]) {
        const groupRows = (rows as PipeWiringRow[] || [])
          .filter(r => r.group_id === group.id)
          .map(r => ({
            id: r.id,
            rowType: r.row_type ?? null,
            absorptionPipes: r.absorption_pipe_ids || [],
            collectorPipe: r.collector_pipe_id,
            isMergePipe: r.is_merge_pipe,
          }))

        // 行がない場合は空の行を追加
        const finalRows = groupRows.length > 0 ? groupRows : [createEmptyRow()]

        if (group.group_type === 'collector') {
          collectorTabs.push({
            id: group.id,
            name: group.name,
            rows: finalRows,
          })
        } else if (group.group_type === 'direct') {
          directRows = finalRows
        }
      }

      // 集水暗渠タブがない場合は初期タブを追加
      if (collectorTabs.length === 0) {
        collectorTabs.push({
          id: 'collector-1',
          name: '集水暗渠1',
          rows: [createEmptyRow()],
        })
      }

      // 直落暗渠がない場合は空の行を追加
      if (directRows.length === 0) {
        directRows = [createEmptyRow()]
      }

      set({
        collectorTabs,
        directRows,
        loading: false,
        hasChanges: false,
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '管路設定の取得に失敗しました',
        loading: false,
      })
    }
  },

  saveWiring: async () => {
    const projectId = getCurrentProjectId()
    if (!projectId) {
      set({ error: 'プロジェクトが選択されていません' })
      return
    }

    const state = get()
    set({ saving: true, error: null })

    try {
      // 既存データを削除
      const { error: deleteGroupError } = await supabase
        .from('pipe_wiring_groups')
        .delete()
        .eq('project_id', projectId)

      if (deleteGroupError) throw deleteGroupError

      // 集水暗渠タブを保存
      for (let i = 0; i < state.collectorTabs.length; i++) {
        const tab = state.collectorTabs[i]

        // グループを挿入
        const { data: groupData, error: groupError } = await supabase
          .from('pipe_wiring_groups')
          .insert({
            project_id: projectId,
            group_type: 'collector',
            name: tab.name,
            sort_order: i,
          } as never)
          .select()
          .single()

        if (groupError) throw groupError

        const groupId = (groupData as PipeWiringGroup).id

        // 行を挿入
        const rowsToInsert = tab.rows.map((row, rowIndex) => ({
          group_id: groupId,
          row_type: row.rowType,
          absorption_pipe_ids: row.absorptionPipes,
          collector_pipe_id: row.collectorPipe,
          is_merge_pipe: row.isMergePipe,
          sort_order: rowIndex,
        }))

        if (rowsToInsert.length > 0) {
          const { error: rowError } = await supabase
            .from('pipe_wiring_rows')
            .insert(rowsToInsert as never)

          if (rowError) throw rowError
        }
      }

      // 直落暗渠を保存
      const { data: directGroupData, error: directGroupError } = await supabase
        .from('pipe_wiring_groups')
        .insert({
          project_id: projectId,
          group_type: 'direct',
          name: '直落暗渠',
          sort_order: state.collectorTabs.length,
        } as never)
        .select()
        .single()

      if (directGroupError) throw directGroupError

      const directGroupId = (directGroupData as PipeWiringGroup).id

      const directRowsToInsert = state.directRows.map((row, rowIndex) => ({
        group_id: directGroupId,
        row_type: row.rowType,
        absorption_pipe_ids: row.absorptionPipes,
        collector_pipe_id: row.collectorPipe,
        is_merge_pipe: row.isMergePipe,
        sort_order: rowIndex,
      }))

      if (directRowsToInsert.length > 0) {
        const { error: directRowError } = await supabase
          .from('pipe_wiring_rows')
          .insert(directRowsToInsert as never)

        if (directRowError) throw directRowError
      }

      set({ saving: false, hasChanges: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '管路設定の保存に失敗しました',
        saving: false,
      })
    }
  },
}))
