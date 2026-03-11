import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  coordinate_zone: number
  created_at: string
  updated_at: string
}

interface ProjectState {
  // プロジェクト一覧
  projects: Project[]
  loading: boolean
  error: string | null

  // 現在のプロジェクト
  currentProject: Project | null
  setCurrentProject: (project: Project | null) => void

  // CRUD操作
  fetchProjects: () => Promise<void>
  createProject: (name: string, description?: string, coordinateZone?: number) => Promise<Project | null>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'coordinate_zone'>>) => Promise<void>
  deleteProject: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  loading: false,
  error: null,
  currentProject: null,

  setCurrentProject: (project) => set({ currentProject: project }),

  fetchProjects: async () => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('design_projects')
        .select('*')
        .order('updated_at', { ascending: false })

      if (error) throw error
      set({ projects: data || [], loading: false })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの取得に失敗しました', loading: false })
    }
  },

  createProject: async (name, description, coordinateZone = 6) => {
    set({ loading: true, error: null })
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('ログインが必要です')

      const insertData = {
        user_id: user.id,
        name,
        description: description || null,
        coordinate_zone: coordinateZone,
      }

      const { data, error } = await supabase
        .from('design_projects')
        .insert(insertData as never)
        .select()
        .single()

      if (error) throw error

      set((state) => ({
        projects: [data, ...state.projects],
        loading: false,
      }))

      return data
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの作成に失敗しました', loading: false })
      return null
    }
  },

  updateProject: async (id, updates) => {
    set({ loading: true, error: null })
    try {
      const { error } = await supabase
        .from('design_projects')
        .update(updates as never)
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        projects: state.projects.map((p) =>
          p.id === id ? { ...p, ...updates } : p
        ),
        currentProject: state.currentProject?.id === id
          ? { ...state.currentProject, ...updates }
          : state.currentProject,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの更新に失敗しました', loading: false })
    }
  },

  deleteProject: async (id) => {
    set({ loading: true, error: null })
    try {
      const { error } = await supabase
        .from('design_projects')
        .delete()
        .eq('id', id)

      if (error) throw error

      set((state) => ({
        projects: state.projects.filter((p) => p.id !== id),
        currentProject: state.currentProject?.id === id ? null : state.currentProject,
        loading: false,
      }))
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの削除に失敗しました', loading: false })
    }
  },
}))
