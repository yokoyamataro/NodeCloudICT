// 現場 (project) の情報編集モーダル (共有コンポーネント)。
//   一覧の 編集ボタンで開く。
//   フィールド:
//     基本    : 工事名 / 説明 / 種別 / 座標系
//     関係者  : 発注者 / 受託者
//     工期    : 工期開始日 / 工期終了日 (予定)
//     進捗    : 着手日 / 完成日 (実際の作業実績) + 完了チェック
//     アクション: 現場を削除する (ゴミ箱へ)

import { useCallback, useEffect, useState } from 'react'
import { X, Trash2, Lock, Users, Globe, Plus, UserMinus } from 'lucide-react'
import type { Project, ProjectMember, ProjectMemberRole } from '@/types/database'
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

// YYYY-MM-DD 形式の日付 (DATE 型: start_date / end_date) → date input value
function dateStringToInput(s: string | null): string {
  if (!s) return ''
  // 'YYYY-MM-DD' がそのまま入る想定。念のためスライスして 10 文字取る
  return s.slice(0, 10)
}

export function ProjectEditModal({
  project,
  onUpdateProject,
  onClose,
  onDelete,
}: {
  project: Project
  onUpdateProject: (
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
  ) => void
  onClose: () => void
  /** 渡された場合のみ「現場を削除する」ボタンを表示 */
  onDelete?: () => void
}) {
  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [client, setClient] = useState(project.client ?? '')
  const [contractor, setContractor] = useState(project.contractor ?? '')
  const [startDate, setStartDate] = useState(dateStringToInput(project.start_date))
  const [endDate, setEndDate] = useState(dateStringToInput(project.end_date))
  const [zone, setZone] = useState<number>(project.coordinate_zone ?? 13)
  // 種別 (地籍測量 / 土木工事) は編集モーダルからは変更不可 (作成時に確定 or PC の別導線でのみ)。
  // 表示だけ最新値を追う。
  const category = project.category
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(project.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(project.completed_at))

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
  ])

  const commitName = () => {
    const v = name.trim()
    if (v && v !== project.name) onUpdateProject({ name: v })
    else if (!v) setName(project.name)
  }
  const commitDescription = () => {
    const v = description.trim()
    const prev = project.description ?? ''
    if (v !== prev) onUpdateProject({ description: v || null })
  }
  const commitClient = () => {
    const v = client.trim()
    const prev = project.client ?? ''
    if (v !== prev) onUpdateProject({ client: v || null })
  }
  const commitContractor = () => {
    const v = contractor.trim()
    const prev = project.contractor ?? ''
    if (v !== prev) onUpdateProject({ contractor: v || null })
  }
  const commitStartDate = () => {
    const v = startDate || null
    if (v !== (project.start_date ?? null)) onUpdateProject({ start_date: v })
  }
  const commitEndDate = () => {
    const v = endDate || null
    if (v !== (project.end_date ?? null)) onUpdateProject({ end_date: v })
  }
  const commitStartedAt = () => {
    const iso = dateInputToIso(startedAt)
    if (iso !== project.started_at) onUpdateProject({ started_at: iso })
  }
  const commitCompletedAt = () => {
    const iso = dateInputToIso(completedAt)
    if (iso !== project.completed_at) onUpdateProject({ completed_at: iso })
  }

  const isCompleted = project.completed_at != null

  // ---------------- 共有メンバー管理 (visibility='shared' の時に表示) ----------------
  const inviteMember = useProjectListStore((s) => s.inviteMember)
  const removeMember = useProjectListStore((s) => s.removeMember)
  const updateMemberRole = useProjectListStore((s) => s.updateMemberRole)
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [candidates, setCandidates] = useState<ShareCandidate[]>([])
  const [selectedCandidate, setSelectedCandidate] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<ProjectMemberRole>('editor')
  const [addingMember, setAddingMember] = useState(false)
  const [memberError, setMemberError] = useState<string | null>(null)

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
    if (project.visibility !== 'shared') return
    void refetchMembers()
    void refetchCandidates()
  }, [project.visibility, refetchMembers, refetchCandidates])

  // 追加候補は 「候補一覧」 - 「既にメンバーに居る人」 - 「オーナー自身」
  const availableCandidates = candidates.filter(
    (c) =>
      c.user_id !== project.user_id &&
      !members.some((m) => m.user_id === c.user_id),
  )
  const internalCandidates = availableCandidates.filter((c) => c.is_internal)
  const externalCandidates = availableCandidates.filter((c) => !c.is_internal)

  const handleAddMember = async () => {
    const cand = candidates.find((c) => c.user_id === selectedCandidate)
    if (!cand) return
    setAddingMember(true)
    setMemberError(null)
    try {
      const result = await inviteMember(project.id, cand.email, newMemberRole)
      if (!result.ok) {
        setMemberError(result.error ?? 'メンバー追加に失敗しました')
        return
      }
      setSelectedCandidate('')
      await refetchMembers()
    } finally {
      setAddingMember(false)
    }
  }

  const handleRemoveMember = async (memberId: string, name: string) => {
    if (!confirm(`「${name}」を共有メンバーから外しますか?`)) return
    await removeMember(memberId)
    await refetchMembers()
  }

  const handleChangeMemberRole = async (memberId: string, role: ProjectMemberRole) => {
    await updateMemberRole(memberId, role)
    await refetchMembers()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3500]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-2xl rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[92vh]"
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
          {/* 工事名 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">工事名</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
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
                const on = project.visibility === v
                return (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      if (project.visibility !== v) onUpdateProject({ visibility: v })
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
            {project.visibility === 'private' && '自分のみ閲覧・編集できます。'}
            {project.visibility === 'shared' &&
              'メンバー一覧に登録された人が閲覧・編集できます。'}
            {project.visibility === 'public' &&
              '認証なしでも閲覧できます。編集は所有者のみ。'}
          </div>

          {/* 共有メンバー管理 (visibility='shared' のときのみ) */}
          {project.visibility === 'shared' && (
            <div className="mt-1 rounded border bg-slate-50">
              {/* メンバー追加行: [候補セレクト] [権限] [追加] */}
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
                  onClick={handleAddMember}
                  disabled={!selectedCandidate || addingMember}
                  className="shrink-0 inline-flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  <Plus className="h-3 w-3" />
                  追加
                </button>
              </div>
              {memberError && (
                <div className="px-2 py-1 text-[11px] text-red-600 border-b bg-red-50">
                  {memberError}
                </div>
              )}
              {/* メンバー一覧 */}
              <ul className="divide-y">
                {members.length === 0 ? (
                  <li className="px-2 py-2 text-xs text-slate-400 text-center">
                    まだ共有メンバーはいません
                  </li>
                ) : (
                  members.map((m) => (
                    <li key={m.id} className="flex items-center gap-2 px-2 py-1">
                      <span className="flex-1 min-w-0 text-xs truncate" title={m.email ?? ''}>
                        <span className="font-medium">{m.display_name || m.email || m.user_id}</span>
                        {m.email && m.display_name && (
                          <span className="text-slate-400 ml-1">({m.email})</span>
                        )}
                      </span>
                      {m.role === 'owner' ? (
                        <span className="shrink-0 px-1.5 py-0.5 text-[10px] rounded bg-slate-700 text-white">
                          オーナー
                        </span>
                      ) : (
                        <>
                          <select
                            value={m.role}
                            onChange={(e) =>
                              handleChangeMemberRole(m.id, e.target.value as ProjectMemberRole)
                            }
                            className="shrink-0 px-1 py-0.5 text-[11px] border rounded"
                          >
                            <option value="editor">編集</option>
                            <option value="viewer">閲覧</option>
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              handleRemoveMember(m.id, m.display_name || m.email || '')
                            }
                            className="shrink-0 p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                            title="メンバーを外す"
                          >
                            <UserMinus className="h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                    </li>
                  ))
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
              onBlur={commitDescription}
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
              onBlur={commitClient}
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
              onBlur={commitContractor}
              placeholder="任意"
              className="flex-1 px-2 py-1.5 border rounded text-sm"
            />
          </div>

          {/* 座標系 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 shrink-0 w-16">座標系</span>
            <select
              value={zone}
              onChange={(e) => {
                const n = parseInt(e.target.value, 10)
                setZone(n)
                if (n !== project.coordinate_zone) onUpdateProject({ coordinate_zone: n })
              }}
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
              onBlur={commitStartDate}
              className="flex-1 px-2 py-1.5 border rounded text-sm"
              title="工期開始日"
            />
            <span className="text-xs text-slate-400">〜</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              onBlur={commitEndDate}
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
              onBlur={commitStartedAt}
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
                  if (e.target.checked) {
                    const iso = project.completed_at ?? new Date().toISOString()
                    onUpdateProject({ completed_at: iso })
                    setCompletedAt(isoToDateInput(iso))
                  } else {
                    onUpdateProject({ completed_at: null })
                    setCompletedAt('')
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
              onBlur={commitCompletedAt}
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
        <div className="px-3 py-2 border-t shrink-0">
          <button
            onClick={onClose}
            className="w-full px-4 py-2.5 text-sm border rounded-lg hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
