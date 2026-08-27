// 地番属性 (parcel_attribute_types) ストア。
// プロジェクト単位で fetch + CRUD。組み込み (target/adjacent/road/river/other) は
// 削除不可、label/color は編集可。ユーザーは任意コードで追加可能。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { ParcelAttributeType } from '@/types/database'

/** 未指定 (未選択) のプレースホルダ表示に使う */
export const UNSELECTED_ATTRIBUTE = {
  code: '',
  label: '未選択',
  color: '#e5e7eb',
} as const

/** zustand セレクタで「未 fetch」時に返す安定参照。毎回 `[]` を返すと
 *  React が state 変化と誤認して無限ループ (React error #185) になる。
 *  各 caller は `s.byProject.get(projectId) ?? EMPTY_ATTRIBUTES` の形で使うこと。 */
export const EMPTY_ATTRIBUTES: ReadonlyArray<ParcelAttributeType> = Object.freeze([])

interface State {
  /** projectId -> attribute types (sort_order 順) */
  byProject: Map<string, ParcelAttributeType[]>
  /** loading フラグ (projectId 単位) */
  loadingProjects: Set<string>
  error: string | null

  fetchForProject: (projectId: string) => Promise<void>
  /** オフライン スナップショット (parcel_attribute_types の 生行) から 復元する */
  hydrateForProject: (projectId: string, rows: unknown[]) => void
  /** 属性コード -> 属性 (未選択なら undefined)。fetch 済み前提。 */
  getByCode: (projectId: string, code: string | null | undefined) => ParcelAttributeType | undefined

  createAttribute: (
    projectId: string,
    fields: { code: string; label: string; color: string; sort_order?: number },
  ) => Promise<ParcelAttributeType | null>
  updateAttribute: (
    id: string,
    patch: Partial<Pick<ParcelAttributeType, 'label' | 'color' | 'sort_order'>>,
  ) => Promise<void>
  deleteAttribute: (id: string) => Promise<void>
}

export const useParcelAttributeTypesStore = create<State>((set, get) => ({
  byProject: new Map(),
  loadingProjects: new Set(),
  error: null,

  hydrateForProject: (projectId, rows) => {
    if (!projectId) return
    const map = new Map(get().byProject)
    map.set(projectId, (rows ?? []) as ParcelAttributeType[])
    set({ byProject: map })
  },

  fetchForProject: async (projectId) => {
    if (!projectId) return
    const loading = new Set(get().loadingProjects)
    if (loading.has(projectId)) return
    loading.add(projectId)
    set({ loadingProjects: loading })
    try {
      const { data, error } = await supabase
        .from('parcel_attribute_types')
        .select('*')
        .eq('project_id', projectId)
        .order('sort_order', { ascending: true })
      if (error) throw error
      const map = new Map(get().byProject)
      map.set(projectId, (data ?? []) as ParcelAttributeType[])
      set({ byProject: map })
    } catch (err) {
      console.error('[parcelAttributeTypesStore] fetch failed', err, { projectId })
      set({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      const next = new Set(get().loadingProjects)
      next.delete(projectId)
      set({ loadingProjects: next })
    }
  },

  getByCode: (projectId, code) => {
    if (!code) return undefined
    const list = get().byProject.get(projectId) ?? []
    return list.find((t) => t.code === code)
  },

  createAttribute: async (projectId, fields) => {
    try {
      const { data, error } = await supabase
        .from('parcel_attribute_types')
        .insert({
          project_id: projectId,
          code: fields.code,
          label: fields.label,
          color: fields.color,
          sort_order: fields.sort_order ?? 100,
          is_builtin: false,
        } as never)
        .select()
        .single()
      if (error) throw error
      const created = data as ParcelAttributeType
      const map = new Map(get().byProject)
      const list = [...(map.get(projectId) ?? []), created].sort(
        (a, b) => a.sort_order - b.sort_order,
      )
      map.set(projectId, list)
      set({ byProject: map })
      return created
    } catch (err) {
      console.error('[parcelAttributeTypesStore] create failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
      return null
    }
  },

  updateAttribute: async (id, patch) => {
    try {
      const { data, error } = await supabase
        .from('parcel_attribute_types')
        .update(patch as never)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      const updated = data as ParcelAttributeType
      const map = new Map(get().byProject)
      const list = (map.get(updated.project_id) ?? []).map((t) =>
        t.id === id ? updated : t,
      )
      list.sort((a, b) => a.sort_order - b.sort_order)
      map.set(updated.project_id, list)
      set({ byProject: map })
    } catch (err) {
      console.error('[parcelAttributeTypesStore] update failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  deleteAttribute: async (id) => {
    // 組み込みは DB 側 RLS で拒否されるが、事前チェックしてもよい
    try {
      // 楽観削除のため、まず projectId を特定
      let projectIdOfDeleted: string | null = null
      for (const [pid, list] of get().byProject.entries()) {
        if (list.some((t) => t.id === id)) {
          projectIdOfDeleted = pid
          break
        }
      }
      const { error } = await supabase
        .from('parcel_attribute_types')
        .delete()
        .eq('id', id)
      if (error) throw error
      if (projectIdOfDeleted) {
        const map = new Map(get().byProject)
        map.set(
          projectIdOfDeleted,
          (map.get(projectIdOfDeleted) ?? []).filter((t) => t.id !== id),
        )
        set({ byProject: map })
      }
    } catch (err) {
      console.error('[parcelAttributeTypesStore] delete failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },
}))
