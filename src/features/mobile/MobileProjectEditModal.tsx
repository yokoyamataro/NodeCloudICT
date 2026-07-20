// モバイル向けの現場 (project) 編集モーダル。
// PC 版 ProjectEditModal は共有メンバー管理・工期・進捗まで扱う重量級だが、
// モバイルでは頻度の高い項目 (現場名 / 説明 / 発注 / 受託 / 座標系 / 種別) と
// 「削除」だけに絞る。削除はプロジェクトオーナー (project.user_id === user.id) のみ。

import { useState } from 'react'
import { AlertTriangle, Loader2, Trash2, X } from 'lucide-react'
import type { Project, ProjectCategory } from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { useProjectListStore } from '@/stores/projectListStore'
import { useAuth } from '@/contexts/AuthContext'

type EditablePatch = Partial<
  Pick<
    Project,
    'name' | 'description' | 'client' | 'contractor' | 'coordinate_zone' | 'category'
  >
>

interface Props {
  project: Project
  onClose: () => void
  /** 保存 or 削除成功時に呼ぶ (呼び出し側で fetch 済みリストの再取得等) */
  onDone?: () => void
}

export function MobileProjectEditModal({ project, onClose, onDone }: Props) {
  const { user } = useAuth()
  const isOwner = user?.id === project.user_id
  const updateProject = useProjectListStore((s) => s.updateProject)
  const deleteProject = useProjectListStore((s) => s.deleteProject)

  const [name, setName] = useState(project.name)
  const [description, setDescription] = useState(project.description ?? '')
  const [client, setClient] = useState(project.client ?? '')
  const [contractor, setContractor] = useState(project.contractor ?? '')
  const [zone, setZone] = useState(project.coordinate_zone)
  const [category, setCategory] = useState<ProjectCategory | ''>(
    project.category ?? '',
  )

  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleteText, setDeleteText] = useState('')

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
