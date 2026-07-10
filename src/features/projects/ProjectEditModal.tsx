// 現場 (project) の情報編集モーダル (共有コンポーネント)。
//   一覧の 編集ボタンで開く。
//   フィールド:
//     基本    : 現場名 / 説明 / 種別 / 座標系
//     関係者  : 発注者 / 受託者
//     工期    : 工期開始日 / 工期終了日 (予定)
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
  Lock,
  Users,
  Globe,
  Plus,
  UserMinus,
  Save,
  RotateCcw,
  AlertTriangle,
  Loader2,
} from 'lucide-react'
import type {
  Project,
  ProjectMember,
  ProjectMemberRole,
  ProjectVisibility,
} from '@/types/database'
import { PROJECT_CATEGORY_LABEL, PROJECT_VISIBILITY_LABEL } from '@/types/database'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { isoToDateInput, dateInputToIso } from '@/features/farms/FarmEditModal'
import { supabase } from '@/lib/supabase'
import { useProjectListStore } from '@/stores/projectListStore'

/** list_share_candidates RPC の 1 行 */
interface ShareCandidate {
  user_id: string
  email: string
  full_name: string | null
  is_internal: boolean
}

interface PendingAdd {
  user_id: string
  email: string
  display_name: string
  role: ProjectMemberRole
  is_internal: boolean
}

// YYYY-MM-DD 形式の日付 (DATE 型: start_date / end_date) → date input value
function dateStringToInput(s: string | null): string {
  if (!s) return ''
  return s.slice(0, 10)
}

// 共有ポリシー変更時の注意文
function visibilityWarningText(
  from: ProjectVisibility,
  to: ProjectVisibility,
): string {
  if (to === 'public') {
    return '公開に変更すると、認証していない人も含めて誰でもこの現場を閲覧できるようになります。編集は所有者と編集メンバーに限られますが、地図や工区情報が第三者に見られる点にご注意ください。'
  }
  if (to === 'private') {
    return '占有に変更すると、あなた以外の全ユーザー (共有メンバー・公開閲覧者) はこの現場にアクセスできなくなります。共有メンバーは残りますが、実質的に閲覧・編集ができない状態になります。'
  }
  // to === 'shared'
  if (from === 'public') {
    return '共有に変更すると、認証していない人はこの現場を閲覧できなくなります。メンバー一覧に登録した人だけがアクセスできる状態に切り替わります。'
  }
  return '共有に変更すると、メンバー一覧に登録した人が閲覧・編集できるようになります。'
}

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
        | 'start_date'
        | 'end_date'
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
  // ---------------- フィールド draft ----------------
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [client, setClient] = useState(project.client ?? '')
  const [contractor, setContractor] = useState(project.contractor ?? '')
  const [startDate, setStartDate] = useState(dateStringToInput(project.start_date))
  const [endDate, setEndDate] = useState(dateStringToInput(project.end_date))
  const [zone, setZone] = useState<number>(project.coordinate_zone ?? 13)
  const category = project.category
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(project.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(project.completed_at))
  const [isCompleted, setIsCompleted] = useState<boolean>(project.completed_at != null)
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility)

  // ---------------- 共有ポリシー変更の承諾ダイアログ ----------------
  const [pendingVisibility, setPendingVisibility] = useState<ProjectVisibility | null>(
    null,
  )

  // ---------------- 保存 UI ----------------
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // project が切り替わったら draft をリセット
  useEffect(() => {
    setName(project.name)
    setDescription(project.description ?? '')
    setClient(project.client ?? '')
    setContractor(project.contractor ?? '')
    setStartDate(dateStringToInput(project.start_date))
    setEndDate(dateStringToInput(project.end_date))
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
    setSaveError(null)
    setPendingVisibility(null)
  }, [
    project.id,
    project.name,
    project.description,
    project.client,
    project.contractor,
    project.start_date,
    project.end_date,
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

  // 追加候補: 全候補 - オーナー - 既存メンバー - 追加予定
  const availableCandidates = useMemo(
    () =>
      candidates.filter(
        (c) =>
          c.user_id !== project.user_id &&
          !members.some((m) => m.user_id === c.user_id) &&
          !pendingAdds.some((a) => a.user_id === c.user_id),
      ),
    [candidates, members, project.user_id, pendingAdds],
  )
  const internalCandidates = availableCandidates.filter((c) => c.is_internal)
  const externalCandidates = availableCandidates.filter((c) => !c.is_internal)

  const queueAdd = () => {
    const cand = availableCandidates.find((c) => c.user_id === selectedCandidate)
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

  const cancelPendingAdd = (userId: string) => {
    setPendingAdds((prev) => prev.filter((a) => a.user_id !== userId))
  }

  const updatePendingAddRole = (userId: string, role: ProjectMemberRole) => {
    setPendingAdds((prev) =>
      prev.map((a) => (a.user_id === userId ? { ...a, role } : a)),
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
    const nextStartDate = startDate || null
    if (nextStartDate !== (project.start_date ?? null))
      patch.start_date = nextStartDate
    const nextEndDate = endDate || null
    if (nextEndDate !== (project.end_date ?? null)) patch.end_date = nextEndDate
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
    startDate,
    endDate,
    zone,
    startedAt,
    completedAt,
    isCompleted,
    visibility,
    project.name,
    project.description,
    project.client,
    project.contractor,
    project.start_date,
    project.end_date,
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

          {/* 共有ポリシー (占有 / 共有 / 公開) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">共有</span>
            <div className="flex-1 flex gap-1">
              {(
                [
                  { v: 'private', icon: Lock, hint: '自分だけが閲覧・編集できます' },
                  { v: 'shared', icon: Users, hint: '選択したメンバーが閲覧・編集できます' },
                  { v: 'public', icon: Globe, hint: '誰でも閲覧できます (編集は所有者のみ)' },
                ] as const
              ).map(({ v, icon: Icon, hint }) => {
                const on = visibility === v
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      if (visibility !== v) setPendingVisibility(v)
                    }}
                    title={hint}
                    className={`flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded border text-xs font-medium ${
                      on
                        ? v === 'private'
                          ? 'bg-slate-700 text-white border-slate-700'
                          : v === 'shared'
                            ? 'bg-blue-600 text-white border-blue-600'
                            : 'bg-amber-500 text-white border-amber-500'
                        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className="h-3 w-3" />
                    {PROJECT_VISIBILITY_LABEL[v]}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="text-[10px] text-slate-500 pl-[4.5rem]">
            {visibility === 'private' && '自分のみ閲覧・編集できます。'}
            {visibility === 'shared' &&
              'メンバー一覧に登録された人が閲覧・編集できます。'}
            {visibility === 'public' && '認証なしでも閲覧できます。編集は所有者のみ。'}
          </div>

          {/* 共有メンバー管理 (visibility='shared' のときのみ) */}
          {visibility === 'shared' && (
            <div className="mt-1 rounded border bg-slate-50">
              {/* メンバー追加行 */}
              <div className="flex items-center gap-2 px-2 py-1.5 border-b bg-white">
                <span className="text-xs text-slate-500 shrink-0 w-16">追加</span>
                <select
                  value={selectedCandidate}
                  onChange={(e) => setSelectedCandidate(e.target.value)}
                  className="flex-1 min-w-0 px-2 py-1 text-xs border rounded"
                >
                  <option value="">-- ユーザーを選択 --</option>
                  {internalCandidates.length > 0 && (
                    <optgroup label="社内メンバー">
                      {internalCandidates.map((c) => (
                        <option key={c.user_id} value={c.user_id}>
                          {c.full_name || c.email} ({c.email})
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {externalCandidates.length > 0 && (
                    <optgroup label="社外 (過去に共有したことがある)">
                      {externalCandidates.map((c) => (
                        <option key={c.user_id} value={c.user_id}>
                          {c.full_name || c.email} ({c.email})
                        </option>
                      ))}
                    </optgroup>
                  )}
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
                        key={`add-${a.user_id}`}
                        className="flex items-center gap-2 px-2 py-1 bg-emerald-50"
                      >
                        <span className="flex-1 min-w-0 text-xs truncate">
                          <span className="font-medium">{a.display_name}</span>
                          {a.email !== a.display_name && (
                            <span className="text-slate-400 ml-1">({a.email})</span>
                          )}
                        </span>
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-emerald-100 text-emerald-700 border border-emerald-300">
                          追加予定
                        </span>
                        <select
                          value={a.role}
                          onChange={(e) =>
                            updatePendingAddRole(
                              a.user_id,
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
                          onClick={() => cancelPendingAdd(a.user_id)}
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

          {/* 説明 */}
          <div className="flex items-start gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16 pt-1">説明</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="任意"
              className="flex-1 px-2 py-1.5 border rounded text-sm h-14"
            />
          </div>

          {/* 発注者 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">発注者</span>
            <input
              type="text"
              value={client}
              onChange={(e) => setClient(e.target.value)}
              placeholder="任意"
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
          </div>

          {/* 受託者 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">受託者</span>
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

          {/* 工期 (予定): 開始 / 終了 を 1 行に */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">工期予定</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="flex-1 px-2 py-1.5 border rounded text-sm"
              title="工期開始日"
            />
            <span className="text-xs text-slate-400">〜</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="flex-1 px-2 py-1.5 border rounded text-sm"
              title="工期終了日"
            />
          </div>

          {/* 着手日 (実績) */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">着手日</span>
            <input
              type="date"
              value={startedAt}
              onChange={(e) => setStartedAt(e.target.value)}
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
          </div>

          {/* 進捗 / 完成日: 完了チェック + 完成日 を 1 行に */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">進捗</span>
            <label className="flex items-center gap-1.5 px-2 py-1.5 border rounded cursor-pointer">
              <input
                type="checkbox"
                checked={isCompleted}
                onChange={(e) => {
                  const checked = e.target.checked
                  setIsCompleted(checked)
                  if (checked) {
                    if (!completedAt) {
                      const now = new Date().toISOString()
                      setCompletedAt(isoToDateInput(now))
                    }
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

        {/* 共有ポリシー変更の承諾ダイアログ */}
        {pendingVisibility && (
          <div
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-[10] rounded-t-xl sm:rounded-xl"
            onClick={() => setPendingVisibility(null)}
          >
            <div
              className="bg-white max-w-sm w-full mx-4 rounded-xl shadow-xl p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0" />
                <h4 className="text-base font-semibold">
                  共有ポリシーを「{PROJECT_VISIBILITY_LABEL[pendingVisibility]}」に変更します
                </h4>
              </div>
              <p className="text-sm text-slate-600 mb-4 leading-relaxed">
                {visibilityWarningText(visibility, pendingVisibility)}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPendingVisibility(null)}
                  className="flex-1 px-3 py-2 text-sm border rounded-lg hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={() => {
                    setVisibility(pendingVisibility)
                    setPendingVisibility(null)
                  }}
                  className="flex-1 px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                >
                  承諾しました
                </button>
              </div>
              <div className="text-[10px] text-slate-400 mt-2 text-center">
                この変更は「保存」ボタンを押すまで確定しません。
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
