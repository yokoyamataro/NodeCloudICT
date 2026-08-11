// 現場 (project) の情報編集モーダル (共有コンポーネント)。
//   一覧の 編集ボタンで開く。
//   フィールド:
//     基本    : 現場名 / 説明 / 種別 / 座標系
//     関係者  : 発注者 / 受託者
//     進捗    : 着手日 / 完成日 (実際の作業実績) + 完了チェック
//     共有    : 占有 / 共有 / 公開 (+ 共有メンバー管理)
//     アクション: 現場を削除する (ゴミ箱へ)
//
// 挙動:
//   ・全フィールドの変更は draft に保持され、フッターの「保存」ボタンで
//     まとめて DB へコミットする。閉じる or ×ボタンでは破棄される。
//   ・共有ポリシー (占有/共有/公開) の変更は、ボタンを押した瞬間に注意文
//     ダイアログを出す。「承諾しました」を押した時点で draft に反映され、
//     最終的な永続化は保存ボタン。
//   ・共有メンバーの追加/削除/権限変更も draft に保持 (pendingAdds /
//     pendingRemoves / pendingRoleChanges)。保存ボタンで一括反映する。

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  X,
  Trash2,
  Globe,
  Plus,
  UserMinus,
  Save,
  RotateCcw,
  Loader2,
  Mail,
} from 'lucide-react'
import type {
  Project,
  ProjectMember,
  ProjectMemberRole,
  ProjectVisibility,
} from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { isoToDateInput, dateInputToIso } from '@/features/farms/FarmEditModal'
import { supabase } from '@/lib/supabase'
import { useProjectListStore } from '@/stores/projectListStore'
import { useAuth } from '@/contexts/AuthContext'

/** list_share_candidates RPC の 1 行 */
interface ShareCandidate {
  user_id: string
  email: string
  full_name: string | null
  is_internal: boolean
}

interface PendingAdd {
  // user_id: 社内候補ドロップダウンから追加された場合のみセット。
  //   組織外メール入力で未登録の可能性がある場合は null (Edge Function 側で解決)。
  user_id: string | null
  email: string
  display_name: string
  role: ProjectMemberRole
  is_internal: boolean
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ProjectEditModal({
  project,
  onSave,
  onClose,
  onDelete,
}: {
  project: Project
  /** フィールド変更の一括永続化 (保存ボタン押下時)。差分が無ければ呼ばれない。 */
  onSave: (
    patch: Partial<
      Pick<
        Project,
        | 'name'
        | 'description'
        | 'client'
        | 'contractor'
        | 'coordinate_zone'
        | 'category'
        | 'started_at'
        | 'completed_at'
        | 'visibility'
      >
    >,
  ) => Promise<void> | void
  onClose: () => void
  /** 渡された場合のみ「現場を削除する」ボタンを表示 */
  onDelete?: () => void
}) {
  // ホスト (現場作成者) のみが公開設定を変更できる
  const { user } = useAuth()
  const isOwner = user?.id != null && project.user_id === user.id

  // ---------------- フィールド draft ----------------
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [client, setClient] = useState(project.client ?? '')
  const [contractor, setContractor] = useState(project.contractor ?? '')
  const [zone, setZone] = useState<number>(project.coordinate_zone ?? 13)
  const category = project.category
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(project.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(project.completed_at))
  const [isCompleted, setIsCompleted] = useState<boolean>(project.completed_at != null)
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility)

  // ---------------- 保存 UI ----------------
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // project が切り替わったら draft をリセット
  useEffect(() => {
    setName(project.name)
    setDescription(project.description ?? '')
    setClient(project.client ?? '')
    setContractor(project.contractor ?? '')
    setZone(project.coordinate_zone ?? 13)
    setStartedAt(isoToDateInput(project.started_at))
    setCompletedAt(isoToDateInput(project.completed_at))
    setIsCompleted(project.completed_at != null)
    setVisibility(project.visibility)
    setPendingAdds([])
    setPendingRemoves(new Set())
    setPendingRoleChanges(new Map())
    setSelectedCandidate('')
    setNewMemberRole('editor')
    setInviteEmail('')
    setInviteEmailRole('editor')
    setInviteEmailError(null)
    setSaveError(null)
  }, [
    project.id,
    project.name,
    project.description,
    project.client,
    project.contractor,
    project.coordinate_zone,
    project.category,
    project.started_at,
    project.completed_at,
    project.visibility,
  ])

  // ---------------- 共有メンバー管理 (visibility='shared' の時に表示) ----------------
  const inviteMember = useProjectListStore((s) => s.inviteMember)
  const removeMember = useProjectListStore((s) => s.removeMember)
  const updateMemberRole = useProjectListStore((s) => s.updateMemberRole)

  const [members, setMembers] = useState<ProjectMember[]>([])
  const [candidates, setCandidates] = useState<ShareCandidate[]>([])
  const [pendingAdds, setPendingAdds] = useState<PendingAdd[]>([])
  const [pendingRemoves, setPendingRemoves] = useState<Set<string>>(new Set())
  const [pendingRoleChanges, setPendingRoleChanges] = useState<
    Map<string, ProjectMemberRole>
  >(new Map())
  const [selectedCandidate, setSelectedCandidate] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<ProjectMemberRole>('editor')
  // 組織外メール直接入力
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteEmailRole, setInviteEmailRole] = useState<ProjectMemberRole>('editor')
  const [inviteEmailError, setInviteEmailError] = useState<string | null>(null)

  const refetchMembers = useCallback(async () => {
    try {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: { p_project_id: string },
        ) => Promise<{ data: ProjectMember[] | null; error: { message: string } | null }>
      )('get_project_members', { p_project_id: project.id })
      if (error) throw error
      setMembers((data ?? []) as ProjectMember[])
    } catch (err) {
      console.warn('[ProjectEditModal] fetch members failed', err)
    }
  }, [project.id])

  const refetchCandidates = useCallback(async () => {
    try {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
        ) => Promise<{ data: ShareCandidate[] | null; error: { message: string } | null }>
      )('list_share_candidates')
      if (error) throw error
      setCandidates((data ?? []) as ShareCandidate[])
    } catch (err) {
      console.warn('[ProjectEditModal] fetch candidates failed', err)
    }
  }, [])

  useEffect(() => {
    // 共有中でなくても、共有に切り替える draft 操作をした瞬間に fetch が必要になるので、
    // draft 側の visibility が shared の時にフェッチする。
    if (visibility !== 'shared') return
    void refetchMembers()
    void refetchCandidates()
  }, [visibility, refetchMembers, refetchCandidates])

  // 組織内候補: 社内候補 - オーナー - 既存メンバー - 追加予定
  //   組織外メンバーはドロップダウンには出さず、メール直接入力から追加させる。
  const internalCandidates = useMemo(
    () =>
      candidates.filter(
        (c) =>
          c.is_internal &&
          c.user_id !== project.user_id &&
          !members.some((m) => m.user_id === c.user_id) &&
          !pendingAdds.some(
            (a) =>
              a.user_id === c.user_id ||
              a.email.toLowerCase() === c.email.toLowerCase(),
          ),
      ),
    [candidates, members, project.user_id, pendingAdds],
  )

  const queueAdd = () => {
    const cand = internalCandidates.find((c) => c.user_id === selectedCandidate)
    if (!cand) return
    setPendingAdds((prev) => [
      ...prev,
      {
        user_id: cand.user_id,
        email: cand.email,
        display_name: cand.full_name || cand.email,
        role: newMemberRole,
        is_internal: cand.is_internal,
      },
    ])
    setSelectedCandidate('')
  }

  // 組織外メールから追加予定に登録。
  //   * 形式チェックだけしてキューへ。実際の「登録済み判定 / 招待送信 / 組織登録誘導」は
  //     保存時に Edge Function 'invite-member' が担う (未登録メールは invite メール送信)。
  //   * 入力メールが偶然 candidates に含まれる (社内メンバー) 場合は user_id を紐付ける。
  const queueEmailInvite = () => {
    const email = inviteEmail.trim().toLowerCase()
    if (!email) {
      setInviteEmailError('メールアドレスを入力してください')
      return
    }
    if (!EMAIL_REGEX.test(email)) {
      setInviteEmailError('メールアドレスの形式が正しくありません')
      return
    }
    if (
      members.some((m) => (m.email ?? '').toLowerCase() === email) ||
      pendingAdds.some((a) => a.email.toLowerCase() === email)
    ) {
      setInviteEmailError('このメールアドレスは既に追加されています')
      return
    }
    const cand = candidates.find((c) => c.email.toLowerCase() === email)
    setPendingAdds((prev) => [
      ...prev,
      {
        user_id: cand?.user_id ?? null,
        email,
        display_name: cand?.full_name || email,
        role: inviteEmailRole,
        is_internal: cand?.is_internal ?? false,
      },
    ])
    setInviteEmail('')
    setInviteEmailError(null)
  }

  const cancelPendingAdd = (email: string) => {
    setPendingAdds((prev) => prev.filter((a) => a.email !== email))
  }

  const updatePendingAddRole = (email: string, role: ProjectMemberRole) => {
    setPendingAdds((prev) =>
      prev.map((a) => (a.email === email ? { ...a, role } : a)),
    )
  }

  const queueRemoveMember = (memberId: string) => {
    setPendingRemoves((prev) => {
      const next = new Set(prev)
      next.add(memberId)
      return next
    })
    // ロール変更予定がある場合はクリア
    setPendingRoleChanges((prev) => {
      if (!prev.has(memberId)) return prev
      const next = new Map(prev)
      next.delete(memberId)
      return next
    })
  }

  const unqueueRemoveMember = (memberId: string) => {
    setPendingRemoves((prev) => {
      if (!prev.has(memberId)) return prev
      const next = new Set(prev)
      next.delete(memberId)
      return next
    })
  }

  const queueRoleChange = (
    memberId: string,
    originalRole: ProjectMemberRole,
    newRole: ProjectMemberRole,
  ) => {
    setPendingRoleChanges((prev) => {
      const next = new Map(prev)
      if (newRole === originalRole) next.delete(memberId)
      else next.set(memberId, newRole)
      return next
    })
  }

  // ---------------- dirty 判定 ----------------
  const patchToApply = useMemo(() => {
    const patch: Partial<Project> = {}
    if (name.trim() && name.trim() !== project.name) patch.name = name.trim()
    const prevDescription = project.description ?? ''
    if (description.trim() !== prevDescription)
      patch.description = description.trim() || null
    const prevClient = project.client ?? ''
    if (client.trim() !== prevClient) patch.client = client.trim() || null
    const prevContractor = project.contractor ?? ''
    if (contractor.trim() !== prevContractor)
      patch.contractor = contractor.trim() || null
    if (zone !== (project.coordinate_zone ?? 13)) patch.coordinate_zone = zone
    const nextStartedAt = dateInputToIso(startedAt)
    if (nextStartedAt !== project.started_at) patch.started_at = nextStartedAt
    const nextCompletedAt = isCompleted
      ? dateInputToIso(completedAt) ?? project.completed_at ?? new Date().toISOString()
      : null
    if (nextCompletedAt !== project.completed_at)
      patch.completed_at = nextCompletedAt
    if (visibility !== project.visibility) patch.visibility = visibility
    return patch
  }, [
    name,
    description,
    client,
    contractor,
    zone,
    startedAt,
    completedAt,
    isCompleted,
    visibility,
    project.name,
    project.description,
    project.client,
    project.contractor,
    project.coordinate_zone,
    project.started_at,
    project.completed_at,
    project.visibility,
  ])

  const isDirty =
    Object.keys(patchToApply).length > 0 ||
    pendingAdds.length > 0 ||
    pendingRemoves.size > 0 ||
    pendingRoleChanges.size > 0

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    setSaveError(null)
    try {
      if (Object.keys(patchToApply).length > 0) {
        await onSave(patchToApply)
      }
      // メンバー操作 (追加 → ロール変更 → 削除)
      for (const add of pendingAdds) {
        const result = await inviteMember(project.id, add.email, add.role)
        if (!result.ok) {
          throw new Error(result.error ?? `${add.email} の追加に失敗しました`)
        }
      }
      for (const [memberId, role] of pendingRoleChanges) {
        await updateMemberRole(memberId, role)
      }
      for (const memberId of pendingRemoves) {
        await removeMember(memberId)
      }
      onClose()
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  // ---------------- レンダリング ----------------
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[92vh] relative"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">現場の編集</h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
            title="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-3 overflow-y-auto flex-1 space-y-1.5">
          {/* 現場名 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">現場名</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
          </div>

          {/* 説明 (現場名の直下) */}
          <div className="flex items-start gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16 pt-1">説明</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="任意"
              className="flex-1 px-2 py-1.5 border rounded text-sm h-14"
            />
          </div>

          {/* 種別 (変更不可・表示のみ) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">種別</span>
            <div
              className={`flex-1 px-2 py-1 text-xs rounded border font-medium ${
                category === 'cadastral'
                  ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                  : category === 'civil'
                    ? 'bg-blue-50 text-blue-800 border-blue-200'
                    : 'bg-amber-50 text-amber-800 border-amber-200'
              }`}
              title="種別は作成時に確定します。変更できません。"
            >
              {category != null ? PROJECT_CATEGORY_LABEL[category] : '未分類'}
            </div>
          </div>

          {/* 公開設定: 「公開を許可する」チェック 1 つに集約。
              ホスト (プロジェクトオーナー) のみ変更可能。 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">公開</span>
            <label
              className={`flex-1 flex items-center gap-2 px-2 py-1.5 rounded border ${
                isOwner
                  ? 'bg-white border-slate-300 cursor-pointer hover:bg-slate-50'
                  : 'bg-slate-50 border-slate-200 cursor-not-allowed opacity-70'
              }`}
              title={
                isOwner
                  ? '公開 URL を経由すれば認証なしでも閲覧できます (編集は所有者のみ)'
                  : '公開設定の変更はホスト (現場作成者) のみが可能です'
              }
            >
              <input
                type="checkbox"
                checked={visibility === 'public'}
                disabled={!isOwner}
                onChange={(e) => {
                  setVisibility(e.target.checked ? 'public' : 'private')
                }}
                className="h-4 w-4"
              />
              <Globe className="h-3.5 w-3.5 text-slate-500 shrink-0" />
              <span className="text-xs">公開を許可する</span>
              {visibility === 'public' && (
                <span className="ml-auto text-[10px] text-amber-700 font-medium">
                  URL 公開中
                </span>
              )}
            </label>
          </div>
          <div className="text-[10px] text-slate-500 pl-[4.5rem]">
            {visibility === 'public'
              ? '共有 URL を知る誰でも (未ログインを含む) 閲覧できます。編集は所有者のみ。'
              : 'メンバー一覧に追加された人だけがアクセスできます。'}
            {!isOwner && (
              <span className="ml-1 text-slate-400">
                (変更はホストのみ)
              </span>
            )}
          </div>

          {/* メンバー管理は常時表示 (以前は visibility='shared' 時のみ表示していた) */}
          {true && (
            <div className="mt-1 rounded border bg-slate-50">
              {/* 組織内メンバー追加行 */}
              <div className="flex items-center gap-2 px-2 py-1.5 border-b bg-white">
                <span className="text-xs text-slate-500 shrink-0 w-16">組織内</span>
                <select
                  value={selectedCandidate}
                  onChange={(e) => setSelectedCandidate(e.target.value)}
                  disabled={internalCandidates.length === 0}
                  className="flex-1 min-w-0 px-2 py-1 text-xs border rounded disabled:bg-slate-50 disabled:text-slate-400"
                >
                  <option value="">
                    {internalCandidates.length === 0
                      ? '追加可能な組織メンバーはいません'
                      : '-- メンバーを選択 --'}
                  </option>
                  {internalCandidates.map((c) => (
                    <option key={c.user_id} value={c.user_id}>
                      {c.full_name || c.email} ({c.email})
                    </option>
                  ))}
                </select>
                <select
                  value={newMemberRole}
                  onChange={(e) => setNewMemberRole(e.target.value as ProjectMemberRole)}
                  className="shrink-0 px-1.5 py-1 text-xs border rounded"
                >
                  <option value="editor">編集</option>
                  <option value="viewer">閲覧</option>
                </select>
                <button
                  type="button"
                  onClick={queueAdd}
                  disabled={!selectedCandidate}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  追加
                </button>
              </div>
              {/* 組織外メール招待行 */}
              <div className="flex items-center gap-2 px-2 py-1.5 border-b bg-white">
                <span className="text-xs text-slate-500 shrink-0 w-16">組織外</span>
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => {
                    setInviteEmail(e.target.value)
                    if (inviteEmailError) setInviteEmailError(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && inviteEmail.trim()) {
                      e.preventDefault()
                      queueEmailInvite()
                    }
                  }}
                  placeholder="user@example.com"
                  className="flex-1 min-w-0 px-2 py-1 text-xs border rounded"
                />
                <select
                  value={inviteEmailRole}
                  onChange={(e) =>
                    setInviteEmailRole(e.target.value as ProjectMemberRole)
                  }
                  className="shrink-0 px-1.5 py-1 text-xs border rounded"
                >
                  <option value="editor">編集</option>
                  <option value="viewer">閲覧</option>
                </select>
                <button
                  type="button"
                  onClick={queueEmailInvite}
                  disabled={!inviteEmail.trim()}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  <Mail className="h-3 w-3" />
                  招待
                </button>
              </div>
              {inviteEmailError && (
                <div className="px-2 py-1 bg-red-50 text-[10px] text-red-700 border-b">
                  {inviteEmailError}
                </div>
              )}
              <div className="px-2 py-1 bg-white text-[10px] text-slate-500 border-b leading-relaxed">
                登録済みユーザーは即座に共有され通知メール、未登録ユーザーには招待メールが送信されます。
              </div>
              {/* メンバー一覧 */}
              <ul className="divide-y">
                {members.length === 0 && pendingAdds.length === 0 ? (
                  <li className="px-2 py-2 text-xs text-slate-400 text-center">
                    まだ共有メンバーはいません
                  </li>
                ) : (
                  <>
                    {members.map((m) => {
                      const isPendingRemove = pendingRemoves.has(m.id)
                      const pendingRole = pendingRoleChanges.get(m.id)
                      const displayRole = (pendingRole ?? m.role) as ProjectMemberRole
                      return (
                        <li
                          key={m.id}
                          className={`flex items-center gap-2 px-2 py-1 ${
                            isPendingRemove ? 'bg-red-50 text-slate-400' : ''
                          }`}
                        >
                          <span
                            className={`flex-1 min-w-0 text-xs truncate ${
                              isPendingRemove ? 'line-through' : ''
                            }`}
                            title={m.email ?? ''}
                          >
                            <span className="font-medium">
                              {m.display_name || m.email || m.user_id}
                            </span>
                            {m.email && m.display_name && (
                              <span className="text-slate-400 ml-1">({m.email})</span>
                            )}
                          </span>
                          {isPendingRemove && (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-red-100 text-red-700 border border-red-300">
                              削除予定
                            </span>
                          )}
                          {!isPendingRemove && pendingRole && (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-700 border border-amber-300">
                              変更予定
                            </span>
                          )}
                          {m.role === 'owner' ? (
                            <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-slate-700 text-white">
                              オーナー
                            </span>
                          ) : (
                            <>
                              <select
                                value={displayRole}
                                disabled={isPendingRemove}
                                onChange={(e) =>
                                  queueRoleChange(
                                    m.id,
                                    m.role as ProjectMemberRole,
                                    e.target.value as ProjectMemberRole,
                                  )
                                }
                                className="shrink-0 px-1 py-0.5 text-[11px] border rounded disabled:opacity-40"
                              >
                                <option value="editor">編集</option>
                                <option value="viewer">閲覧</option>
                              </select>
                              {isPendingRemove ? (
                                <button
                                  type="button"
                                  onClick={() => unqueueRemoveMember(m.id)}
                                  className="shrink-0 p-1 text-slate-500 hover:text-blue-600 hover:bg-blue-50 rounded"
                                  title="削除予定を取り消す"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => queueRemoveMember(m.id)}
                                  className="shrink-0 p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                                  title="削除予定にする"
                                >
                                  <UserMinus className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </>
                          )}
                        </li>
                      )
                    })}
                    {pendingAdds.map((a) => (
                      <li
                        key={`add-${a.email}`}
                        className="flex items-center gap-2 px-2 py-1 bg-emerald-50"
                      >
                        <span className="flex-1 min-w-0 text-xs truncate">
                          <span className="font-medium">{a.display_name}</span>
                          {a.email !== a.display_name && (
                            <span className="text-slate-400 ml-1">({a.email})</span>
                          )}
                        </span>
                        <span
                          className={`shrink-0 px-1.5 py-0.5 text-[10px] rounded border ${
                            a.is_internal
                              ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
                              : 'bg-sky-100 text-sky-700 border-sky-300'
                          }`}
                        >
                          {a.is_internal ? '追加予定 (組織内)' : '招待予定 (組織外)'}
                        </span>
                        <select
                          value={a.role}
                          onChange={(e) =>
                            updatePendingAddRole(
                              a.email,
                              e.target.value as ProjectMemberRole,
                            )
                          }
                          className="shrink-0 px-1 py-0.5 text-[11px] border rounded"
                        >
                          <option value="editor">編集</option>
                          <option value="viewer">閲覧</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => cancelPendingAdd(a.email)}
                          className="shrink-0 p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                          title="追加予定を取り消す"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </>
                )}
              </ul>
            </div>
          )}

          {/* 発注者 / 受託者 を 1 行に */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">発注者</span>
            <input
              type="text"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="任意"
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
            <span className="text-xs text-slate-500 shrink-0 pl-2">受託者</span>
            <input
              type="text"
              value={contractor}
              onChange={(e) => setContractor(e.target.value)}
              placeholder="任意"
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
          </div>

          {/* 座標系 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">座標系</span>
            <select
              value={zone}
              onChange={(e) => setZone(parseInt(e.target.value, 10))}
              className="flex-1 px-2 py-1.5 text-sm border rounded"
            >
              {Object.entries(JGD2011_ZONES).map(([z, info]) => (
                <option key={z} value={z}>
                  {info.name}
                </option>
              ))}
            </select>
          </div>

          {/* 着手日 (実績) + 完了チェック + 完成日 を 1 行に */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">着手日</span>
            <input
              type="date"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
            <label className="flex items-center gap-1.5 px-2 py-1.5 border rounded cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={isCompleted}
                onChange={(e) => {
                  const checked = e.target.checked
                  setIsCompleted(checked)
                  if (checked && !completedAt) {
                    const now = new Date().toISOString()
                    setCompletedAt(isoToDateInput(now))
                  }
                }}
                className="h-3.5 w-3.5"
              />
              <span className="text-xs">完了</span>
            </label>
            <input
              type="date"
              value={completedAt}
              onChange={(e) => setCompletedAt(e.target.value)}
              disabled={!isCompleted}
              className="flex-1 px-2 py-1.5 border rounded text-sm disabled:bg-slate-50 disabled:text-slate-400"
              title="完成日"
            />
          </div>

          {/* 削除 */}
          {onDelete && (
            <div className="pt-2 border-t">
              <button
                type="button"
                onClick={() => {
                  if (
                    confirm(
                      `現場「${project.name}」をゴミ箱へ移動しますか？\n\n7 日以内なら「ゴミ箱」から復元できます。\n7 日を超えると配下の工区・関連データすべてが自動で完全削除されます。`,
                    )
                  ) {
                    onDelete()
                  }
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
                現場を削除する
              </button>
            </div>
          )}
        </div>

        {saveError && (
          <div className="px-3 py-2 border-t bg-red-50 text-xs text-red-700 shrink-0">
            {saveError}
          </div>
        )}

        <div className="px-3 py-2 border-t shrink-0 flex gap-2">
          <button
            onClick={handleSave}
            disabled={!isDirty || saving}
            className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm rounded-lg ${
              isDirty && !saving
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-slate-200 text-slate-500 cursor-not-allowed'
            }`}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            保存
          </button>
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 px-4 py-2.5 text-sm border rounded-lg hover:bg-slate-50 disabled:opacity-50"
          >
            閉じる
          </button>
        </div>

        {/* 旧: 共有ポリシー (占有/共有/公開) 変更ダイアログは撤去済み。
            公開のオン/オフだけになったのでインラインチェックで十分。 */}
      </div>
    </div>
  )
}
