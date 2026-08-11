// モバイル向けの現場 (project) 編集モーダル。
// PC 版 ProjectEditModal から必要な項目を抜粋:
//   基本   : 現場名 / 説明 / 発注 / 受託 / 座標系 / 種別
//   共有   : 占有 / 共有 / 公開 + 共有メンバーの一覧・追加・削除・権限変更
//   削除   : プロジェクトオーナー (project.user_id === user.id) のみ
// 保存ボタン押下で基本項目 + visibility をまとめて DB へ。メンバー操作は即時反映。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, Mail, Plus, Trash2, X } from 'lucide-react'
import type {
  Project,
  ProjectCategory,
  ProjectMember,
  ProjectMemberRole,
  ProjectVisibility,
} from '@/types/database'
import {
  PROJECT_CATEGORY_LABEL,
} from '@/types/database'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { useProjectListStore } from '@/stores/projectListStore'
import { useProjectPermission } from '@/lib/useProjectPermission'
import { supabase } from '@/lib/supabase'

type EditablePatch = Partial<
  Pick<
    Project,
    | 'name'
    | 'description'
    | 'client'
    | 'contractor'
    | 'coordinate_zone'
    | 'category'
    | 'visibility'
  >
>

interface Props {
  project: Project
  onClose: () => void
  /** 保存 or 削除成功時に呼ぶ (呼び出し側で fetch 済みリストの再取得等) */
  onDone?: () => void
}

export function MobileProjectEditModal({ project, onClose, onDone }: Props) {
  // 権限判定は useProjectPermission に統一。owner 相当を isOwner としてローカル alias。
  // 現行の UI ロジックは基本 owner 権限を前提にしているため、 canManageMembers をそのまま使う。
  const perm = useProjectPermission(project)
  const isOwner = perm.canManageMembers
  const updateProject = useProjectListStore((s) => s.updateProject)
  const deleteProject = useProjectListStore((s) => s.deleteProject)
  const inviteMember = useProjectListStore((s) => s.inviteMember)
  const updateMemberRole = useProjectListStore((s) => s.updateMemberRole)
  const removeMember = useProjectListStore((s) => s.removeMember)

  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [client, setClient] = useState(project.client ?? '')
  const [contractor, setContractor] = useState(project.contractor ?? '')
  const [zone, setZone] = useState(project.coordinate_zone)
  const [category, setCategory] = useState<ProjectCategory | ''>(
    project.category ?? '',
  )
  const [visibility, setVisibility] = useState<ProjectVisibility>(project.visibility)

  const [busy, setBusy] = useState<'save' | 'delete' | 'member' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteText, setDeleteText] = useState('')

  // 共有メンバー一覧 (visibility=shared のときのみ操作)
  const [members, setMembers] = useState<ProjectMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<ProjectMemberRole>('editor')
  // 組織内メンバー候補 (list_share_candidates RPC の is_internal=true のみ)
  const [internalCandidates, setInternalCandidates] = useState<
    { user_id: string; email: string; full_name: string | null }[]
  >([])
  const [selectedCandidate, setSelectedCandidate] = useState('')
  const [candidateRole, setCandidateRole] = useState<ProjectMemberRole>('editor')

  const refetchMembers = useCallback(async () => {
    setMembersLoading(true)
    try {
      const { data, error: rpcErr } = await (
        supabase.rpc as unknown as (
          fn: string,
          args: { p_project_id: string },
        ) => Promise<{ data: ProjectMember[] | null; error: { message: string } | null }>
      )('get_project_members', { p_project_id: project.id })
      if (rpcErr) throw rpcErr
      setMembers((data ?? []) as ProjectMember[])
    } catch (err) {
      console.warn('[MobileProjectEditModal] fetch members failed', err)
    } finally {
      setMembersLoading(false)
    }
  }, [project.id])

  const refetchCandidates = useCallback(async () => {
    try {
      const { data, error: rpcErr } = await (
        supabase.rpc as unknown as (
          fn: string,
        ) => Promise<{
          data:
            | { user_id: string; email: string; full_name: string | null; is_internal: boolean }[]
            | null
          error: { message: string } | null
        }>
      )('list_share_candidates')
      if (rpcErr) throw rpcErr
      setInternalCandidates(
        (data ?? [])
          .filter((c) => c.is_internal)
          .map(({ user_id, email, full_name }) => ({ user_id, email, full_name })),
      )
    } catch (err) {
      console.warn('[MobileProjectEditModal] fetch candidates failed', err)
    }
  }, [])

  // モーダル起動時に共有メンバー / 招待候補を一覧取得。
  // (以前は visibility='shared' 時のみ取得していたが、区分をやめて常時表示)
  useEffect(() => {
    void refetchMembers()
    void refetchCandidates()
  }, [refetchMembers, refetchCandidates])

  // 追加ドロップダウンには、まだメンバーになっていない組織内候補だけを出す
  const availableInternal = useMemo(
    () =>
      internalCandidates.filter(
        (c) =>
          c.user_id !== project.user_id &&
          !members.some((m) => m.user_id === c.user_id),
      ),
    [internalCandidates, members, project.user_id],
  )

  const handleInvite = async () => {
    const email = inviteEmail.trim()
    if (!email) {
      setError('メールアドレスを入力してください')
      return
    }
    setError(null)
    setBusy('member')
    try {
      const res = await inviteMember(project.id, email, inviteRole)
      if (!res.ok) {
        setError(res.error ?? '招待に失敗しました')
        return
      }
      setInviteEmail('')
      await refetchMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // 組織内メンバー (プルダウン選択) を追加。inviteMember 経由で Edge Function に投げる
  // (既存ユーザーなので即時 project_members に反映される)。
  const handleAddInternal = async () => {
    const cand = availableInternal.find((c) => c.user_id === selectedCandidate)
    if (!cand) return
    setError(null)
    setBusy('member')
    try {
      const res = await inviteMember(project.id, cand.email, candidateRole)
      if (!res.ok) {
        setError(res.error ?? '追加に失敗しました')
        return
      }
      setSelectedCandidate('')
      await refetchMembers()
      await refetchCandidates()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleChangeRole = async (memberId: string, role: ProjectMemberRole) => {
    setBusy('member')
    try {
      await updateMemberRole(memberId, role)
      await refetchMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleRemoveMember = async (m: ProjectMember) => {
    if (!confirm(`${m.email ?? m.display_name ?? m.user_id} を共有から外しますか?`)) return
    setBusy('member')
    try {
      await removeMember(m.id)
      await refetchMembers()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async () => {
    setError(null)
    if (!name.trim()) {
      setError('現場名を入力してください')
      return
    }
    const patch: EditablePatch = {
      name: name.trim(),
      description: description.trim() || null,
      client: client.trim() || null,
      contractor: contractor.trim() || null,
      coordinate_zone: zone,
      category: category === '' ? null : (category as ProjectCategory),
      visibility,
    }
    setBusy('save')
    try {
      await updateProject(project.id, patch)
      onDone?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const handleDelete = async () => {
    if (!isOwner) return
    if (deleteText.trim() !== project.name) {
      setError('現場名が一致しません (削除確認)')
      return
    }
    setError(null)
    setBusy('delete')
    try {
      await deleteProject(project.id)
      onDone?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '削除に失敗しました')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/50 flex items-end sm:items-center justify-center"
      onClick={() => !busy && onClose()}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
          <h3 className="text-base font-semibold">現場を編集</h3>
          <button
            onClick={onClose}
            disabled={!!busy}
            className="p-1 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-50"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          <div>
            <label className="block text-xs text-slate-600 mb-1">現場名 *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!!busy}
              className="w-full px-2 py-2 text-base border rounded"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">概要</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={!!busy}
              className="w-full px-2 py-2 text-sm border rounded h-16"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-slate-600 mb-1">発注者</label>
              <input
                type="text"
                value={client}
                onChange={(e) => setClient(e.target.value)}
                disabled={!!busy}
                className="w-full px-2 py-2 text-sm border rounded"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">受託者</label>
              <input
                type="text"
                value={contractor}
                onChange={(e) => setContractor(e.target.value)}
                disabled={!!busy}
                className="w-full px-2 py-2 text-sm border rounded"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">種別</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as ProjectCategory | '')}
              disabled={!!busy}
              className="w-full px-2 py-2 text-sm border rounded bg-white"
            >
              <option value="">(未分類)</option>
              <option value="cadastral">{PROJECT_CATEGORY_LABEL['cadastral']}</option>
              <option value="civil">{PROJECT_CATEGORY_LABEL['civil']}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-600 mb-1">座標系</label>
            <select
              value={zone}
              onChange={(e) => setZone(parseInt(e.target.value, 10))}
              disabled={!!busy}
              className="w-full px-2 py-2 text-sm border rounded bg-white"
            >
              {Object.entries(JGD2011_ZONES).map(([z, info]) => (
                <option key={z} value={z}>
                  {info.name}
                </option>
              ))}
            </select>
          </div>

          {/* 公開設定: 「公開を許可する」チェックのみ。ホストのみ変更可能。 */}
          <div className="pt-3 mt-3 border-t border-slate-200">
            <label className="block text-xs text-slate-600 mb-1.5">公開設定</label>
            <label
              className={`flex items-center gap-2 px-2 py-2 rounded border ${
                isOwner
                  ? 'bg-white border-slate-300'
                  : 'bg-slate-50 border-slate-200 opacity-70'
              }`}
            >
              <input
                type="checkbox"
                checked={visibility === 'public'}
                disabled={!isOwner || !!busy}
                onChange={(e) =>
                  setVisibility(e.target.checked ? 'public' : 'private')
                }
                className="h-4 w-4"
              />
              <span className="text-sm">公開を許可する</span>
              {visibility === 'public' && (
                <span className="ml-auto text-[10px] text-amber-700 font-medium">
                  URL 公開中
                </span>
              )}
            </label>
            <p className="mt-1.5 text-[11px] text-slate-500 leading-relaxed">
              {visibility === 'public'
                ? '共有 URL を知る誰でも (未ログインを含む) 閲覧できます。編集は所有者のみ。'
                : 'メンバー一覧に追加された人だけがアクセスできます。'}
              {!isOwner && (
                <span className="ml-1 text-slate-400">(変更はホストのみ)</span>
              )}
            </p>
          </div>

          {/* 共有メンバー: 常時表示 (以前は visibility='shared' 時のみ) */}
          {true && (
            <div className="pt-2">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-medium text-slate-700">
                  共有ユーザー ({members.length})
                </label>
                {membersLoading && (
                  <Loader2 className="h-3 w-3 text-slate-400 animate-spin" />
                )}
              </div>

              {members.length === 0 && !membersLoading ? (
                <div className="text-[11px] text-slate-400 border border-dashed rounded px-2 py-2 text-center">
                  共有ユーザーが未登録です
                </div>
              ) : (
                <ul className="space-y-1">
                  {members.map((m) => (
                    <li
                      key={m.id}
                      className="flex items-center gap-1.5 bg-slate-50 border rounded px-2 py-1.5"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm truncate">
                          {m.display_name || m.email || m.user_id.slice(0, 8)}
                        </div>
                        {m.email && m.email !== m.display_name && (
                          <div className="text-[10px] text-slate-500 truncate">{m.email}</div>
                        )}
                      </div>
                      {isOwner ? (
                        <select
                          value={m.role}
                          onChange={(e) =>
                            void handleChangeRole(m.id, e.target.value as ProjectMemberRole)
                          }
                          disabled={!!busy}
                          className="px-1 py-0.5 text-xs border rounded bg-white"
                        >
                          <option value="viewer">閲覧</option>
                          <option value="editor">編集</option>
                          <option value="owner">管理</option>
                        </select>
                      ) : (
                        <span className="px-1.5 py-0.5 text-[11px] text-slate-600 bg-white border rounded">
                          {m.role === 'owner' ? '管理' : m.role === 'editor' ? '編集' : '閲覧'}
                        </span>
                      )}
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => void handleRemoveMember(m)}
                          disabled={!!busy}
                          className="p-1 text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
                          title="共有から外す"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {/* 追加フォーム: オーナーのみ (project_members INSERT の RLS で editors は弾かれるため)
                    上段: 組織内メンバーをプルダウンから選択
                    下段: 組織外はメールアドレスを直接入力して招待 */}
              {isOwner ? (
                <>
                  <div className="mt-2">
                    <label className="block text-[10px] text-slate-500 mb-0.5">組織内</label>
                    <div className="flex items-center gap-1">
                      <select
                        value={selectedCandidate}
                        onChange={(e) => setSelectedCandidate(e.target.value)}
                        disabled={!!busy || availableInternal.length === 0}
                        className="flex-1 min-w-0 px-2 py-1.5 text-xs border rounded bg-white disabled:bg-slate-50 disabled:text-slate-400"
                      >
                        <option value="">
                          {availableInternal.length === 0
                            ? '追加可能な組織メンバーはいません'
                            : '-- メンバーを選択 --'}
                        </option>
                        {availableInternal.map((c) => (
                          <option key={c.user_id} value={c.user_id}>
                            {c.full_name || c.email} ({c.email})
                          </option>
                        ))}
                      </select>
                      <select
                        value={candidateRole}
                        onChange={(e) =>
                          setCandidateRole(e.target.value as ProjectMemberRole)
                        }
                        disabled={!!busy}
                        className="px-1 py-1.5 text-xs border rounded bg-white shrink-0"
                      >
                        <option value="viewer">閲覧</option>
                        <option value="editor">編集</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleAddInternal()}
                        disabled={!!busy || !selectedCandidate}
                        className="flex items-center gap-0.5 px-2 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 shrink-0"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        追加
                      </button>
                    </div>
                  </div>
                  <div className="mt-2">
                    <label className="block text-[10px] text-slate-500 mb-0.5">
                      組織外 (メール招待)
                    </label>
                    <div className="flex items-center gap-1">
                      <input
                        type="email"
                        value={inviteEmail}
                        onChange={(e) => setInviteEmail(e.target.value)}
                        disabled={!!busy}
                        placeholder="user@example.com"
                        className="flex-1 min-w-0 px-2 py-1.5 text-sm border rounded"
                      />
                      <select
                        value={inviteRole}
                        onChange={(e) => setInviteRole(e.target.value as ProjectMemberRole)}
                        disabled={!!busy}
                        className="px-1 py-1.5 text-xs border rounded bg-white shrink-0"
                      >
                        <option value="viewer">閲覧</option>
                        <option value="editor">編集</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => void handleInvite()}
                        disabled={!!busy || !inviteEmail.trim()}
                        className="flex items-center gap-0.5 px-2 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 shrink-0"
                      >
                        <Mail className="h-3.5 w-3.5" />
                        招待
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-[10px] text-slate-500 leading-relaxed">
                    登録済みユーザーには通知メール、未登録ユーザーには新規登録案内が送信されます。
                  </p>
                </>
              ) : (
                <p className="mt-2 text-[10px] text-slate-500 leading-relaxed">
                  共有ユーザーの追加・削除・権限変更は所有者のみ可能です。
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {/* 削除セクション: オーナーのみ表示 */}
          {isOwner && (
            <div className="pt-3 mt-3 border-t border-slate-200">
              {!confirmingDelete ? (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingDelete(true)
                    setDeleteText('')
                    setError(null)
                  }}
                  disabled={!!busy}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                  この現場を削除
                </button>
              ) : (
                <div className="space-y-2 bg-red-50 border border-red-200 rounded p-2.5">
                  <div className="text-xs text-red-800 leading-relaxed">
                    現場「{project.name}」を削除します。工区・座標・写真・区域も
                    すべて連鎖削除されます。取り消しはできません。
                    <br />
                    続行するには、下に現場名 <b>{project.name}</b> を入力:
                  </div>
                  <input
                    type="text"
                    value={deleteText}
                    onChange={(e) => setDeleteText(e.target.value)}
                    disabled={!!busy}
                    className="w-full px-2 py-1.5 text-sm border border-red-300 rounded bg-white"
                    placeholder={project.name}
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmingDelete(false)
                        setDeleteText('')
                        setError(null)
                      }}
                      disabled={!!busy}
                      className="flex-1 px-3 py-1.5 text-sm border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
                    >
                      キャンセル
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={
                        busy === 'delete' || deleteText.trim() !== project.name
                      }
                      className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-40"
                    >
                      {busy === 'delete' && (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      )}
                      削除実行
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {!isOwner && (
            <div className="text-[11px] text-slate-500 border-t pt-2 mt-2">
              この現場を削除できるのは所有者のみです。
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={!!busy}
            className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSave}
            disabled={busy === 'save' || !name.trim()}
            className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy === 'save' && <Loader2 className="h-4 w-4 animate-spin" />}
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
