import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { Project } from '@/types/database'

interface ProjectListState {
  projects: Project[]
  currentProject: Project | null
  loading: boolean
  error: string | null

  // データ取得
  fetchProjects: () => Promise<void>

  // プロジェクト操作
  createProject: (name: string, description?: string) => Promise<Project | null>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'description'>>) => Promise<void>
  deleteProject: (id: string) => Promise<void>

  // 選択
  setCurrentProject: (project: Project | null) => void
}

export const useProjectListStore = create<ProjectListState>()((set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,
  error: null,

  fetchProjects: async () => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) throw error

      set({ projects: (data || []) as Project[], loading: false })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'プロジェクトの取得に失敗しました',
        loading: false,
      })
    }
  },

  createProject: async (name, description) => {
    set({ error: null })
    try {
      const { data: userData } = await supabase.auth.getUser()
      if (!userData.user) {
        set({ error: 'ログインが必要です' })
        return null
      }

      const { data, error } = await supabase
        .from('projects')
        .insert({
          user_id: userData.user.id,
          name,
          description: description || null,
        } as never)
        .select()
        .single()

      if (error) throw error

      const project = data as Project
      set((state) => ({
        projects: [project, ...state.projects],
      }))

      return project
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの作成に失敗しました' })
      return null
    }
  },

  updateProject: async (id, updates) => {
    const state = get()
    const existing = state.projects.find((p) => p.id === id)
    if (!existing) return

    // ローカル状態を即座に更新
    set({
      projects: state.projects.map((p) => (p.id === id ? { ...p, ...updates } : p)),
      currentProject:
        state.currentProject?.id === id ? { ...state.currentProject, ...updates } : state.currentProject,
    })

    try {
      const { error } = await supabase
        .from('projects')
        .update(updates as never)
        .eq('id', id)

      if (error) throw error
    } catch (err) {
      // エラー時は元に戻す
      set({
        projects: state.projects,
        currentProject: state.currentProject,
        error: err instanceof Error ? err.message : 'プロジェクトの更新に失敗しました',
      })
    }
  },

  deleteProject: async (id) => {
    const state = get()
    try {
      const { error } = await supabase.from('projects').delete().eq('id', id)

      if (error) throw error

      set({
        projects: state.projects.filter((p) => p.id !== id),
        currentProject: state.currentProject?.id === id ? null : state.currentProject,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの削除に失敗しました' })
    }
  },

  setCurrentProject: (project) => {
    set({ currentProject: project })
  },
}))
