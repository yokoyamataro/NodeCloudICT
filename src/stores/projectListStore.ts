import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '@/lib/supabase'
import type { Project, ProjectCategory, ProjectMember, ProjectMemberRole } from '@/types/database'

interface ProjectListState {
  projects: Project[]
  // ゴミ箱内 (deleted_at != null) のプロジェクト。トップの一覧には含めない
  trashedProjects: Project[]
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
  fetchTrashedProjects: () => Promise<void>
  fetchMembers: (projectId: string) => Promise<void>

  // プロジェクト操作
  createProject: (name: string, description?: string, coordinateZone?: number, category?: ProjectCategory | null) => Promise<Project | null>
  updateProject: (id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'start_date' | 'end_date' | 'client' | 'contractor' | 'coordinate_zone' | 'category' | 'started_at' | 'completed_at' | 'visibility'>>) => Promise<void>
  /** ゴミ箱へ移動 (soft delete)。保持期間経過で物理削除される。 */
  deleteProject: (id: string) => Promise<void>
  /** ゴミ箱から復元 */
  restoreProject: (id: string) => Promise<void>
  /** ゴミ箱から即時完全削除 (子行は CASCADE、Storage 掃除は含まない) */
  purgeProject: (id: string) => Promise<void>

  // メンバー操作
  // - inviteMember: 招待リンク経由でメンバーを追加。既存ユーザーなら即追加、
  //   未登録なら invite メール送信。Edge Function `invite-member` を呼ぶ。
  inviteMember: (projectId: string, email: string, role: ProjectMemberRole) => Promise<{
    ok: boolean
    mode?: 'added_existing' | 'invited'
    error?: string
  }>
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
  trashedProjects: [],
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
      // 通常一覧はゴミ箱に入ってないものだけ
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .is('deleted_at', null)
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

  fetchTrashedProjects: async () => {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*')
        .not('deleted_at', 'is', null)
        .order('deleted_at', { ascending: false })

      if (error) throw error

      set({ trashedProjects: (data || []) as Project[] })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'ゴミ箱の取得に失敗しました',
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

  createProject: async (name, description, coordinateZone = 13, category = null) => {
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
          category,
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
      // ゴミ箱へ移動 (soft delete)。物理削除は保持期間経過後
      const { error } = await supabase
        .from('projects')
        .update({ deleted_at: new Date().toISOString() } as never)
        .eq('id', id)

      if (error) throw error

      set({
        projects: state.projects.filter((p) => p.id !== id),
        currentProject: state.currentProject?.id === id ? null : state.currentProject,
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの削除に失敗しました' })
    }
  },

  restoreProject: async (id) => {
    const state = get()
    try {
      const { data, error } = await supabase
        .from('projects')
        .update({ deleted_at: null } as never)
        .eq('id', id)
        .select()
        .single()

      if (error) throw error

      const restored = data as Project
      set({
        trashedProjects: state.trashedProjects.filter((p) => p.id !== id),
        projects: [restored, ...state.projects],
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'プロジェクトの復元に失敗しました' })
    }
  },

  purgeProject: async (id) => {
    const state = get()
    try {
      // 完全削除 (FK CASCADE で子行は消える)
      const { error } = await supabase.from('projects').delete().eq('id', id)
      if (error) throw error

      set({
        trashedProjects: state.trashedProjects.filter((p) => p.id !== id),
      })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'プロジェクトの完全削除に失敗しました',
      })
    }
  },

  inviteMember: async (projectId, email, role) => {
    try {
      // 認証トークンを取り出して Edge Function を呼ぶ
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        const msg = 'ログインセッションがありません'
        set({ error: msg })
        return { ok: false, error: msg }
      }

      const { data, error } = await supabase.functions.invoke('invite-member', {
        body: { project_id: projectId, email, role },
      })

      if (error) {
        // Edge Function 側 4xx/5xx は error.context に response が入っている
        let msg = error.message || 'メンバー招待に失敗しました'
        const ctx = (error as unknown as { context?: { body?: string } }).context
        if (ctx?.body) {
          try {
            const parsed = JSON.parse(ctx.body) as { error?: string }
            if (parsed.error) msg = parsed.error
          } catch {
            // ignore parse error
          }
        }
        set({ error: msg })
        return { ok: false, error: msg }
      }

      const result = (data ?? {}) as { ok?: boolean; mode?: 'added_existing' | 'invited' }
      if (!result.ok) {
        set({ error: 'メンバー招待に失敗しました' })
        return { ok: false, error: 'メンバー招待に失敗しました' }
      }

      // 既存ユーザー追加の場合のみ即座にメンバー一覧を再取得
      // （未登録招待は signup 後にトリガで反映される）
      if (result.mode === 'added_existing') {
        await get().fetchMembers(projectId)
      }
      return { ok: true, mode: result.mode }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'メンバー招待に失敗しました'
      set({ error: msg })
      return { ok: false, error: msg }
    }
  },

  updateMemberRole: async (memberId, role) => {
    const state = get()
    try {
      // .select() を付けて更新された行を返してもらう。RLS で弾かれた場合は
      // エラーにならず data が空配列で返るので、それを「権限なし」として UI に出す。
      const { data, error } = await supabase
        .from('project_members')
        .update({ role } as never)
        .eq('id', memberId)
        .select()

      if (error) throw error

      if (!data || (data as unknown[]).length === 0) {
        set({
          error:
            'メンバーの権限を変更する権限がありません（プロジェクト作成者・オーナーのみ変更できます）',
        })
        // ローカル状態は触らない（実 DB と乖離させない）
        const target = state.members.find((m) => m.id === memberId)
        if (target?.project_id) {
          await get().fetchMembers(target.project_id)
        }
        return
      }

      set({
        members: state.members.map((m) => (m.id === memberId ? { ...m, role } : m)),
      })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'ロールの更新に失敗しました' })
    }
  },

  removeMember: async (memberId) => {
    const state = get()
    const target = state.members.find((m) => m.id === memberId)
    try {
      // .select() を付けて削除された行を返してもらう。
      // RLS で弾かれた場合はエラーにならず data が空配列で返るので、それを検知して
      // 「権限がない」エラーとして UI に出す。
      const { data, error } = await supabase
        .from('project_members')
        .delete()
        .eq('id', memberId)
        .select()

      if (error) throw error

      if (!data || (data as unknown[]).length === 0) {
        set({
          error:
            'メンバーを削除する権限がありません（プロジェクト作成者のみ削除できます）',
        })
        return
      }

      // 楽観的にローカルを更新
      set({
        members: state.members.filter((m) => m.id !== memberId),
      })

      // サーバから再取得して整合（楽観更新だけだと、別タブや権限不足で実際は
      // 残っているケースを次回再表示で取り違える可能性があるため）
      if (target?.project_id) {
        await get().fetchMembers(target.project_id)
      }
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
