import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { COORDINATE_TYPE_NAMES } from '@/lib/coordinates'

// プロジェクトごとのカスタム座標点種
// 既定（control/boundary/current）に加えてユーザが任意で追加できる。
export interface CoordinatePointType {
  id: string
  projectId: string
  code: string
  label: string
  sortOrder: number
}

interface State {
  // プロジェクトID → そのプロジェクトのカスタム点種一覧
  byProject: Map<string, CoordinatePointType[]>
  loading: boolean
  error: string | null

  fetchForProject: (projectId: string) => Promise<void>
  addType: (projectId: string, code: string, label: string) => Promise<void>
  updateType: (id: string, code: string, label: string) => Promise<void>
  removeType: (id: string) => Promise<void>
}

export const useCoordinatePointTypeStore = create<State>((set, get) => ({
  byProject: new Map(),
  loading: false,
  error: null,

  fetchForProject: async (projectId) => {
    set({ loading: true, error: null })
    try {
      // Database 型に未登録のテーブルのため `from(...)` を string キャストで呼び出す
      const { data, error } = await (
        supabase.from('coordinate_point_types' as never) as unknown as {
          select: (cols: string) => {
            eq: (col: string, val: string) => {
              order: (col: string, opts: { ascending: boolean }) => {
                order: (col: string, opts: { ascending: boolean }) => Promise<{
                  data: RawPointTypeRow[] | null
                  error: { message: string } | null
                }>
              }
            }
          }
        }
      )
        .select('id, project_id, code, label, sort_order')
        .eq('project_id', projectId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true })
      if (error) throw error
      const rows: CoordinatePointType[] = (data ?? []).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        code: r.code,
        label: r.label,
        sortOrder: r.sort_order,
      }))
      const next = new Map(get().byProject)
      next.set(projectId, rows)
      set({ byProject: next, loading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '点種の取得に失敗しました',
        loading: false,
      })
    }
  },

  addType: async (projectId, code, label) => {
    const trimmedCode = code.trim()
    const trimmedLabel = label.trim()
    if (!trimmedCode || !trimmedLabel) throw new Error('コードと表示名を入力してください')
    if (trimmedCode in COORDINATE_TYPE_NAMES) {
      throw new Error('既定の点種コードと重複しています')
    }
    const existing = get().byProject.get(projectId) ?? []
    if (existing.some((t) => t.code === trimmedCode)) {
      throw new Error('同じコードの点種が既に存在します')
    }
    const nextOrder = existing.length > 0
      ? Math.max(...existing.map((t) => t.sortOrder)) + 1
      : 0
    const payload = {
      project_id: projectId,
      code: trimmedCode,
      label: trimmedLabel,
      sort_order: nextOrder,
    }
    const { data, error } = await (
      supabase.from('coordinate_point_types' as never) as unknown as {
        insert: (row: typeof payload) => {
          select: (cols: string) => {
            single: () => Promise<{
              data: RawPointTypeRow | null
              error: { message: string } | null
            }>
          }
        }
      }
    )
      .insert(payload)
      .select('id, project_id, code, label, sort_order')
      .single()
    if (error) throw error
    if (!data) throw new Error('追加結果を取得できませんでした')
    const row: CoordinatePointType = {
      id: data.id,
      projectId: data.project_id,
      code: data.code,
      label: data.label,
      sortOrder: data.sort_order,
    }
    const next = new Map(get().byProject)
    next.set(projectId, [...existing, row])
    set({ byProject: next })
  },

  updateType: async (id, code, label) => {
    const trimmedCode = code.trim()
    const trimmedLabel = label.trim()
    if (!trimmedCode || !trimmedLabel) throw new Error('コードと表示名を入力してください')
    const payload = { code: trimmedCode, label: trimmedLabel }
    const { data, error } = await (
      supabase.from('coordinate_point_types' as never) as unknown as {
        update: (row: typeof payload) => {
          eq: (col: string, val: string) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: RawPointTypeRow | null
                error: { message: string } | null
              }>
            }
          }
        }
      }
    )
      .update(payload)
      .eq('id', id)
      .select('id, project_id, code, label, sort_order')
      .single()
    if (error) throw error
    if (!data) throw new Error('更新結果を取得できませんでした')
    const projectId: string = data.project_id
    const list = get().byProject.get(projectId) ?? []
    const updated = list.map((t) =>
      t.id === id
        ? { ...t, code: data.code, label: data.label, sortOrder: data.sort_order }
        : t,
    )
    const next = new Map(get().byProject)
    next.set(projectId, updated)
    set({ byProject: next })
  },

  removeType: async (id) => {
    const { data: existing } = await (
      supabase.from('coordinate_point_types' as never) as unknown as {
        select: (cols: string) => {
          eq: (col: string, val: string) => {
            single: () => Promise<{
              data: { project_id: string } | null
              error: { message: string } | null
            }>
          }
        }
      }
    )
      .select('project_id')
      .eq('id', id)
      .single()
    const { error } = await (
      supabase.from('coordinate_point_types' as never) as unknown as {
        delete: () => {
          eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>
        }
      }
    )
      .delete()
      .eq('id', id)
    if (error) throw error
    if (existing?.project_id) {
      const list = get().byProject.get(existing.project_id) ?? []
      const next = new Map(get().byProject)
      next.set(
        existing.project_id,
        list.filter((t) => t.id !== id),
      )
      set({ byProject: next })
    }
  },
}))

interface RawPointTypeRow {
  id: string
  project_id: string
  code: string
  label: string
  sort_order: number
}

// プロジェクトの全点種オプション（既定 + カスタム）を返す
export function getCoordinateTypeOptions(
  projectId: string | null,
  byProject: Map<string, CoordinatePointType[]>,
): { code: string; label: string; builtIn: boolean }[] {
  const out = Object.entries(COORDINATE_TYPE_NAMES).map(([code, label]) => ({
    code,
    label,
    builtIn: true,
  }))
  if (!projectId) return out
  const custom = byProject.get(projectId) ?? []
  for (const t of custom) {
    out.push({ code: t.code, label: t.label, builtIn: false })
  }
  return out
}

// code → label のルックアップ（既定 + カスタム）
export function getCoordinateTypeLabel(
  code: string,
  projectId: string | null,
  byProject: Map<string, CoordinatePointType[]>,
): string {
  const builtIn = (COORDINATE_TYPE_NAMES as Record<string, string>)[code]
  if (builtIn) return builtIn
  if (projectId) {
    const custom = byProject.get(projectId) ?? []
    const hit = custom.find((t) => t.code === code)
    if (hit) return hit.label
  }
  return code
}
