import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '@/lib/supabase'
import type { Project, ProjectMember, ProjectMemberRole } from '@/types/database'

interface ProjectListState {
  projects: Project[]
  currentProject: Project | null
  loading: boolean
  error: string | null

  // メンバー管理
  members: ProjectMember[]
  membersLoading: boolean
  currentUserRole: ProjectMemberRole | null

  // プロジェクト ID ごとの現在ユーザーのロール（トップページ等で閲覧判定に使用）
  userRolesByProject: Map<string, ProjectMemberRole>
  fetchUserRoles: () => Promise<void>

  // データ取得
  fetchProjects: () => Promise<void>
  fetchMembers: (projectId: string) => Promise<void>

  // プロジェクト操作
  createProject: (name: string, description?: string, coordinateZone?: number) => Promise<Project | null>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'start_date' | 'end_date' | 'client' | 'contractor' | 'coordinate_zone'>>) => Promise<void>
  deleteProject: (id: string) => Promise<void>

  // メンバー操作
  addMember: (projectId: string, email: string, role: ProjectMemberRole) => Promise<boolean>
  updateMemberRole: (memberId: string, role: ProjectMemberRole) => Promise<void>
  removeMember: (memberId: string) => Promise<void>

  // 選択
  setCurrentProject: (project: Project | null) => void

  // 権限チェック
  canEdit: () => boolean
  canDelete: () => boolean
}

export const useProjectListStore = create<ProjectListState>()(
  persist(
    (set, get) => ({
  projects: [],
  currentProject: null,
  loading: false,
  error: null,
  members: [],
  membersLoading: false,
  currentUserRole: null,
  userRolesByProject: new Map(),

  fetchUserRoles: async () => {
    try {
      const { data: userData } = await supabase.auth.getUser()
      const currentUserId = userData.user?.id
      if (!currentUserId) return

      const { data, error } = await supabase
        .from('project_members')
        .select('project_id, role')
        .eq('user_id', currentUserId)

      if (error) throw error

      const map = new Map<string, ProjectMemberRole>()
      for (const row of (data || []) as { project_id: string; role: ProjectMemberRole }[]) {
        map.set(row.project_id, row.role)
      }
      set({ userRolesByProject: map })
    } catch (err) {
      console.error('ユーザーロール取得エラー:', err)
    }
  },

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

  fetchMembers: async (projectId: string) => {
    set({ membersLoading: true })
    try {
      // RLS では project_members.SELECT を「自分の行」だけに絞っているため、
      // owner / 他メンバー一覧の取得には SECURITY DEFINER の RPC を使う。
      // database.ts に未登録の RPC のため、ここは型アサーションで呼ぶ。
      const { data: membersData, error: membersError } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: { p_project_id: string },
        ) => Promise<{ data: ProjectMember[] | null; error: { message: string } | null }>
      )('get_project_members', { p_project_id: projectId })

      if (membersError) throw membersError

      // 現在のユーザーIDを取得
      const { data: userData } = await supabase.auth.getUser()
      const currentUserId = userData.user?.id

      const members = (membersData || []) as ProjectMember[]

      // 現在のユーザーのロールを特定
      const currentMember = members.find(m => m.user_id === currentUserId)
      const currentUserRole = currentMember?.role ?? null

      set({
        members,
        membersLoading: false,
        currentUserRole,
      })
    } catch (err) {
      console.error('メンバー取得エラー:', err)
      set({ membersLoading: false })
    }
  },

  createProject: async (name, description, coordinateZone = 13) => {
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
          coordinate_zone: coordinateZone,
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

  addMember: async (projectId, email, role) => {
    try {
      // メールアドレスからユーザーIDを取得するため、RPC関数を使用
      // 注: セキュリティ上、auth.usersへの直接アクセスはできないため、
      // RPC関数をSupabaseで作成する必要がある
      const { data: userData, error: userError } = await supabase.rpc('get_user_id_by_email', {
        user_email: email,
      } as never)

      if (userError || !userData) {
        set({ error: 'ユーザーが見つかりません' })
        return false
      }

      const { error } = await supabase.from('project_members').insert({
        project_id: projectId,
        user_id: userData,
        role,
      } as never)

      if (error) {
        if (error.code === '23505') {
          set({ error: 'このユーザーは既にメンバーです' })
        } else {
          throw error
        }
        return false
      }

      // メンバー一覧を再取得
      await get().fetchMembers(projectId)
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'メンバーの追加に失敗しました' })
      return false
    }
  },

  updateMemberRole: async (memberId, role) => {
    const state = get()
    try {
      const { error } = await supabase
        .from('project_members')
        .update({ role } as never)
        .eq('id', memberId)

      if (error) throw error

      set({
        members: state.members.map((m) => (m.id === memberId ? { ...m, role } : m)),
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'ロールの更新に失敗しました' })
    }
  },

  removeMember: async (memberId) => {
    const state = get()
    try {
      const { error } = await supabase.from('project_members').delete().eq('id', memberId)

      if (error) throw error

      set({
        members: state.members.filter((m) => m.id !== memberId),
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'メンバーの削除に失敗しました' })
    }
  },

  setCurrentProject: (project) => {
    set({ currentProject: project, members: [], currentUserRole: null })
    // プロジェクトが選択されたらメンバーも取得
    if (project) {
      get().fetchMembers(project.id)
    }
  },

  canEdit: () => {
    const { currentUserRole } = get()
    return currentUserRole === 'owner' || currentUserRole === 'editor'
  },

  canDelete: () => {
    const { currentUserRole } = get()
    return currentUserRole === 'owner'
  },
    }),
    {
      name: 'nodecloud-current-project',
      // 選択中の工事だけ永続化（一覧・メンバー・ロールは毎回取り直す）
      partialize: (state) => ({ currentProject: state.currentProject }),
    },
  ),
)
