// プロジェクト単位の権限判定を集約するフック。
//
// これまで permission チェックが 3 パターン (project.user_id 直判定 /
// projectListStore.canEdit() / userRolesByProject.get() など) に散在し、
// - 編集/削除ボタンが viewer にも見えっぱなし
// - リスト画面で自分の role が分からない
// といった UX 課題があった。このフックが SoT (single source of truth) となり、
// 各 UI は capabilities を見て disabled / hidden / badge を出し分ける。
//
// DB 層は RLS + is_project_editor() 等の SECURITY DEFINER 関数で守られているので、
// このフックが返す capability はあくまで **UI 上の親切な事前判定** に過ぎない。
// 万が一 viewer が編集ボタンを叩いても DB 側で確実に弾かれる。

import { useMemo } from 'react'
import { useAuth } from '@/contexts/AuthContext'
import { useProjectListStore } from '@/stores/projectListStore'
import type { Project, ProjectMemberRole } from '@/types/database'

/** 集約された「役割 + capability」 */
export interface ProjectPermission {
  /** 実効ロール ('owner' | 'editor' | 'viewer' | null)。null = メンバーでない (public プロジェクトを閲覧しているだけ等) */
  role: ProjectMemberRole | null
  /** 表示できるか (public プロジェクト、または メンバー / owner) */
  canView: boolean
  /** 座標・地番などのデータを編集できるか (owner or editor) */
  canEdit: boolean
  /** メンバー招待・ロール変更ができるか (owner のみ) */
  canManageMembers: boolean
  /** プロジェクト自体を削除 (ゴミ箱へ移動) できるか (owner のみ) */
  canDelete: boolean
  /** visibility を変更できるか (owner のみ) */
  canChangeVisibility: boolean
}

const NO_PERMISSION: ProjectPermission = {
  role: null,
  canView: false,
  canEdit: false,
  canManageMembers: false,
  canDelete: false,
  canChangeVisibility: false,
}

/**
 * 指定 project の現在ユーザーの権限を返す。
 *
 * project が null の場合は「権限なし」で返す (loading 中や未選択の想定)。
 *
 * 依存元:
 *   - useAuth().user.id (認証状態)
 *   - useProjectListStore().userRolesByProject (project_members キャッシュ)
 *
 * userRolesByProject が未 fetch の場合、owner 以外の判定はロード待ちになる。
 * 呼出側は必要に応じて projectListStore.fetchUserRoles() を先に呼ぶこと
 * (トップページ / モバイル現場一覧では既に fetch 済み)。
 */
export function useProjectPermission(
  project: Project | null | undefined,
): ProjectPermission {
  const { user } = useAuth()
  const userRolesByProject = useProjectListStore((s) => s.userRolesByProject)

  return useMemo(() => {
    if (!project) return NO_PERMISSION

    const uid = user?.id ?? null
    const isOwner = uid != null && project.user_id === uid
    const memberRole = uid != null ? userRolesByProject.get(project.id) ?? null : null

    // 実効ロール: owner > editor > viewer > public 閲覧のみ
    let role: ProjectMemberRole | null = null
    if (isOwner) role = 'owner'
    else if (memberRole === 'editor') role = 'editor'
    else if (memberRole === 'viewer') role = 'viewer'
    else if (memberRole === 'owner') role = 'owner' // 稀: DB 側で owner を members にも入れているケース
    // memberRole が null でも public プロジェクトなら canView=true

    const isPublic = project.visibility === 'public'
    const canView = role != null || isPublic
    const canEdit = role === 'owner' || role === 'editor'
    const canManageMembers = role === 'owner'
    const canDelete = role === 'owner'
    const canChangeVisibility = role === 'owner'

    return {
      role,
      canView,
      canEdit,
      canManageMembers,
      canDelete,
      canChangeVisibility,
    }
  }, [project, user?.id, userRolesByProject])
}

/** 役割の日本語表示ラベル */
export const ROLE_LABEL: Record<ProjectMemberRole, string> = {
  owner: 'オーナー',
  editor: '編集者',
  viewer: '閲覧者',
}

/** 役割バッジの Tailwind クラス (owner=amber, editor=blue, viewer=slate) */
export const ROLE_BADGE_CLASS: Record<ProjectMemberRole, string> = {
  owner: 'bg-amber-100 text-amber-800 border-amber-200',
  editor: 'bg-blue-100 text-blue-800 border-blue-200',
  viewer: 'bg-slate-100 text-slate-700 border-slate-200',
}
