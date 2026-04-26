import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { PipeWiringGroup, PipeWiringRow } from '@/types/database'
import { useFarmStore } from './farmStore'

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
  mergeSystemIndex: number | null  // 集水合流タイプの接続先系統番号
  /**
   * collector_change 行で参照する集水管の頂点 index（任意）。
   * 一括設定で生成された collector_change 行に明示的に頂点を割り当てるため。
   * DB には保存しない（フロントエンドのみ）。
   */
  collectorVertexIdx?: number
}

// ローカル状態用のタブ型
export interface CollectorTab {
  id: string
  name: string
  rows: WiringRow[]
}

// 圃場IDを取得するヘルパー
const getCurrentFarmId = (): string | null => {
  return useFarmStore.getState().currentFarm?.id ?? null
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
  // 現在ロード済みのプロジェクトID（ページ遷移時の再フェッチ防止用）
  loadedFarmId: string | null
  // データ操作
  fetchWiring: (farmId: string, force?: boolean) => Promise<void>
  saveWiring: () => Promise<void>
  // タブ操作（関数も受け付ける）
  setCollectorTabs: (updater: TabsUpdater) => void
  setDirectRows: (updater: RowsUpdater) => void
  // 変更検知
  hasChanges: boolean
  setHasChanges: (value: boolean) => void
  // ストアをリセット（プロジェクト切り替え時用）
  resetStore: () => void
}

// 空の行を作成
function createEmptyRow(): WiringRow {
  return {
    id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
    rowType: null,
    absorptionPipes: [],
    collectorPipe: null,
    isMergePipe: false,
    mergeSystemIndex: null,
  }
}

// 保存処理の共通ロジック（farmIdを指定して保存）
async function saveWiringToDb(
  farmId: string,
  collectorTabs: CollectorTab[],
  directRows: WiringRow[]
): Promise<void> {
  console.log('[saveWiringToDb] Starting save for farmId:', farmId)
  console.log('[saveWiringToDb] collectorTabs:', collectorTabs)
  console.log('[saveWiringToDb] directRows:', directRows)

  // 既存データを削除
  const { error: deleteGroupError } = await supabase
    .from('pipe_wiring_groups')
    .delete()
    .eq('farm_id', farmId)

  if (deleteGroupError) {
    console.error('[saveWiringToDb] Delete error:', deleteGroupError)
    throw deleteGroupError
  }
  console.log('[saveWiringToDb] Existing data deleted')

  // 集水暗渠タブを保存
  for (let i = 0; i < collectorTabs.length; i++) {
    const tab = collectorTabs[i]

    // グループを挿入
    const { data: groupData, error: groupError } = await supabase
      .from('pipe_wiring_groups')
      .insert({
        farm_id: farmId,
        group_type: 'collector',
        name: tab.name,
        sort_order: i,
      } as never)
      .select()
      .single()

    if (groupError) throw groupError

    const groupId = (groupData as PipeWiringGroup).id
    console.log('[saveWiringToDb] Created collector group:', groupId, tab.name)

    // 行を挿入（空の行をフィルタリング）
    console.log('[saveWiringToDb] Tab rows before filter:', tab.rows)
    const nonEmptyRows = tab.rows.filter(row =>
      row.rowType || row.absorptionPipes.length > 0 || row.collectorPipe
    )
    console.log('[saveWiringToDb] Non-empty rows after filter:', nonEmptyRows)
    const rowsToInsert = nonEmptyRows.map((row, rowIndex) => {
      // collector_mergeタイプの場合、absorptionPipesには系統番号が入っている（UUIDではない）
      // merge_system_indexに系統番号を保存する
      const isCollectorMerge = row.rowType === 'collector_merge'
      const absorptionPipeIds = isCollectorMerge ? [] : row.absorptionPipes
      // collector_mergeの場合、absorptionPipes[0]に系統番号が文字列で入っている
      const mergeSystemIndex = isCollectorMerge && row.absorptionPipes.length > 0
        ? parseInt(row.absorptionPipes[0], 10)
        : row.mergeSystemIndex

      return {
        group_id: groupId,
        row_type: row.rowType,
        absorption_pipe_ids: absorptionPipeIds,
        collector_pipe_id: row.collectorPipe,
        is_merge_pipe: row.isMergePipe,
        merge_system_index: mergeSystemIndex,
        collector_vertex_idx: row.collectorVertexIdx ?? null,
        sort_order: rowIndex,
      }
    })

    if (rowsToInsert.length > 0) {
      console.log('[saveWiringToDb] Inserting rows for collector group:', rowsToInsert.length)
      const { error: rowError } = await supabase
        .from('pipe_wiring_rows')
        .insert(rowsToInsert as never)

      if (rowError) {
        console.error('[saveWiringToDb] Row insert error:', rowError)
        throw rowError
      }
    }
  }

  // 直落暗渠を保存
  const { data: directGroupData, error: directGroupError } = await supabase
    .from('pipe_wiring_groups')
    .insert({
      farm_id: farmId,
      group_type: 'direct',
      name: '直落暗渠',
      sort_order: collectorTabs.length,
    } as never)
    .select()
    .single()

  if (directGroupError) throw directGroupError

  const directGroupId = (directGroupData as PipeWiringGroup).id
  console.log('[saveWiringToDb] Created direct group:', directGroupId)

  // 空の行をフィルタリング
  const nonEmptyDirectRows = directRows.filter(row =>
    row.rowType || row.absorptionPipes.length > 0 || row.collectorPipe
  )
  const directRowsToInsert = nonEmptyDirectRows.map((row, rowIndex) => {
    const isCollectorMerge = row.rowType === 'collector_merge'
    const absorptionPipeIds = isCollectorMerge ? [] : row.absorptionPipes
    const mergeSystemIndex = isCollectorMerge && row.absorptionPipes.length > 0
      ? parseInt(row.absorptionPipes[0], 10)
      : row.mergeSystemIndex

    return {
      group_id: directGroupId,
      row_type: row.rowType,
      absorption_pipe_ids: absorptionPipeIds,
      collector_pipe_id: row.collectorPipe,
      is_merge_pipe: row.isMergePipe,
      merge_system_index: mergeSystemIndex,
      collector_vertex_idx: row.collectorVertexIdx ?? null,
      sort_order: rowIndex,
    }
  })

  if (directRowsToInsert.length > 0) {
    console.log('[saveWiringToDb] Inserting direct rows:', directRowsToInsert.length)
    const { error: directRowError } = await supabase
      .from('pipe_wiring_rows')
      .insert(directRowsToInsert as never)

    if (directRowError) {
      console.error('[saveWiringToDb] Direct row insert error:', directRowError)
      throw directRowError
    }
  }
  console.log('[saveWiringToDb] Save completed successfully')
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
  loadedFarmId: null,
  hasChanges: false,

  setCollectorTabs: (updater) => {
    const state = get()
    const newTabs = typeof updater === 'function' ? updater(state.collectorTabs) : updater
    console.log('[pipeWiringStore] setCollectorTabs called, setting hasChanges: true')
    set({ collectorTabs: newTabs, hasChanges: true })
  },

  setDirectRows: (updater) => {
    const state = get()
    const newRows = typeof updater === 'function' ? updater(state.directRows) : updater
    console.log('[pipeWiringStore] setDirectRows called, setting hasChanges: true')
    set({ directRows: newRows, hasChanges: true })
  },

  setHasChanges: (value) => {
    set({ hasChanges: value })
  },

  resetStore: () => {
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
      saving: false,
      error: null,
      loadedFarmId: null,
      hasChanges: false,
    })
  },

  fetchWiring: async (farmId: string, force?: boolean) => {
    const state = get()
    console.log('[pipeWiringStore] fetchWiring called', { farmId, force, loadedFarmId: state.loadedFarmId, hasChanges: state.hasChanges, saving: state.saving, loading: state.loading })

    // 保存中の場合はフェッチをスキップ（データ競合防止）
    if (state.saving) {
      console.log('[pipeWiringStore] Skipping fetch while saving')
      return
    }

    // 既に読み込み中の場合もスキップ
    if (state.loading) {
      console.log('[pipeWiringStore] Already loading, skipping fetch')
      return
    }

    // 同じプロジェクトのデータが既にロードされていて、強制リロードでなければスキップ
    if (!force && state.loadedFarmId === farmId) {
      console.log('[pipeWiringStore] Data already loaded for project, skipping fetch')
      return
    }

    // 未保存の変更がある場合はスキップ（強制リロードでない限り）
    if (!force && state.hasChanges) {
      console.log('[pipeWiringStore] Has unsaved changes, skipping fetch')
      return
    }

    // 強制リロードで未保存の変更がある場合は警告（自動保存しない）
    if (force && state.hasChanges) {
      console.log('[pipeWiringStore] Force reload requested but there are unsaved changes. They will be discarded.')
    }

    console.log('[pipeWiringStore] Proceeding with fetch...')

    set({ loading: true, error: null })
    try {
      // グループを取得
      const { data: groups, error: groupError } = await supabase
        .from('pipe_wiring_groups')
        .select('*')
        .eq('farm_id', farmId)
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
          loadedFarmId: farmId,
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
          .map(r => {
            // collector_mergeタイプの場合、merge_system_indexをabsorptionPipesに復元
            const isCollectorMerge = r.row_type === 'collector_merge'
            const absorptionPipes = isCollectorMerge && r.merge_system_index !== null
              ? [r.merge_system_index.toString()]  // 系統番号を文字列として復元
              : r.absorption_pipe_ids || []

            const dbRow = r as PipeWiringRow & { collector_vertex_idx?: number | null }
            return {
              id: r.id,
              rowType: r.row_type ?? null,
              absorptionPipes,
              collectorPipe: r.collector_pipe_id,
              isMergePipe: r.is_merge_pipe,
              mergeSystemIndex: r.merge_system_index ?? null,
              collectorVertexIdx: dbRow.collector_vertex_idx ?? undefined,
            }
          })

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
        loadedFarmId: farmId,
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
    const farmId = getCurrentFarmId()
    if (!farmId) {
      set({ error: '圃場が選択されていません' })
      return
    }

    const state = get()

    // 読み込み中または既に保存中の場合はスキップ
    if (state.loading) {
      console.log('[pipeWiringStore] Skipping save while loading')
      return
    }
    if (state.saving) {
      console.log('[pipeWiringStore] Already saving, skipping')
      return
    }

    // 変更がない場合はスキップ
    if (!state.hasChanges) {
      console.log('[pipeWiringStore] No changes to save')
      return
    }

    set({ saving: true, error: null })
    console.log('[pipeWiringStore] Saving wiring data...', { farmId, tabCount: state.collectorTabs.length, directRowCount: state.directRows.length })

    try {
      await saveWiringToDb(farmId, state.collectorTabs, state.directRows)
      console.log('[pipeWiringStore] Save completed successfully')
      set({ saving: false, hasChanges: false })

      // 保存後にDBから再読み込みしてIDを同期
      // loadedFarmIdをクリアして強制リロード
      set({ loadedFarmId: null })
      await get().fetchWiring(farmId)
      console.log('[pipeWiringStore] Reloaded after save')
    } catch (err) {
      console.error('[pipeWiringStore] Save failed:', err)
      set({
        error: err instanceof Error ? err.message : '管路設定の保存に失敗しました',
        saving: false,
      })
    }
  },
}))
