import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'

export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  coordinate_zone: number
  created_at: string
  updated_at: string
}

// プロジェクトの先頭座標情報
export interface ProjectLocation {
  projectId: string
  lat: number
  lng: number
  pointNumber: string
}

interface ProjectState {
  // プロジェクト一覧
  projects: Project[]
  loading: boolean
  error: string | null

  // プロジェクトの位置情報（先頭座標）
  projectLocations: Map<string, ProjectLocation>

  // 現在のプロジェクト
  currentProject: Project | null
  setCurrentProject: (project: Project | null) => void

  // CRUD操作
  fetchProjects: () => Promise<void>
  fetchProjectLocations: () => Promise<void>
  createProject: (name: string, description?: string, coordinateZone?: number) => Promise<Project | null>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'coordinate_zone'>>) => Promise<void>
  deleteProject: (id: string) => Promise<void>
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  projects: [],
  loading: false,
  error: null,
  currentProject: null,
  projectLocations: new Map(),

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

      // 位置情報も取得
      get().fetchProjectLocations()
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの取得に失敗しました', loading: false })
    }
  },

  fetchProjectLocations: async () => {
    const { projects } = get()
    if (projects.length === 0) return

    try {
      // 各プロジェクトの先頭座標を取得
      const { data, error } = await supabase
        .from('design_coordinates')
        .select('id, project_id, point_number, x, y')
        .in('project_id', projects.map(p => p.id))
        .order('point_number')

      if (error) throw error

      // プロジェクトごとに先頭の座標を取得
      const locations = new Map<string, ProjectLocation>()
      const coordData = data as Array<{
        id: string
        project_id: string
        point_number: string
        x: number
        y: number
      }> | null

      for (const project of projects) {
        const coords = (coordData || []).filter(c => c.project_id === project.id)
        if (coords.length > 0) {
          const firstCoord = coords[0]
          const converter = new CoordinateConverter(project.coordinate_zone)
          const { lat, lng } = converter.toLatLng(firstCoord.x, firstCoord.y)
          locations.set(project.id, {
            projectId: project.id,
            lat,
            lng,
            pointNumber: firstCoord.point_number,
          })
        }
      }

      set({ projectLocations: locations })
    } catch (err) {
      console.error('位置情報の取得に失敗:', err)
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
