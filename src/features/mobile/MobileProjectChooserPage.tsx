// モバイルのトップ画面: 工事（プロジェクト）を選んでから工区一覧へ
// 選ぶと /mobile/farms/:projectId に遷移する。
// 上から 地籍測量 → 土木工事 → 未分類（あれば）の順で縦に並べる。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Folder, Loader2, LogOut, MapPin, Monitor, Pencil, Plus, X } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { useAuth } from '@/contexts/AuthContext'
import { setDisplayModeOverride } from '@/lib/displayMode'
import { FeedbackButton } from '@/components/layout/FeedbackButton'
import { JGD2011_ZONES } from '@/lib/coordinates'
import type { Project, ProjectCategory } from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'
import { MobileProjectEditModal } from './MobileProjectEditModal'

export function MobileProjectChooserPage() {
  const navigate = useNavigate()
  const { signOut, user, profile } = useAuth()
  const userLabel = profile?.full_name?.trim() || (user?.email ? user.email.split('@')[0] : '')
  const { projects, loading, error, fetchProjects, createProject } = useProjectListStore()
  const { farms, fetchFarms } = useFarmStore()

  useEffect(() => {
    fetchProjects()
    fetchFarms()
  }, [fetchProjects, fetchFarms])

  // 編集モーダル (現場情報 + 削除ボタン)
  const [editProject, setEditProject] = useState<Project | null>(null)

  // 新規工事作成ダイアログ
  const [showNewDialog, setShowNewDialog] = useState<ProjectCategory | null>(null)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newZone, setNewZone] = useState(13)
  const [creating, setCreating] = useState(false)

  const openCreateDialog = (category: ProjectCategory) => {
    setShowNewDialog(category)
    setNewName('')
    setNewDescription('')
    setNewZone(13)
  }

  const handleCreate = async () => {
    if (!showNewDialog || !newName.trim()) return
    setCreating(true)
    try {
      await createProject(
        newName.trim(),
        newDescription.trim() || undefined,
        newZone,
        showNewDialog,
      )
      setShowNewDialog(null)
    } finally {
      setCreating(false)
    }
  }

  const farmCountByProject = (id: string) =>
    farms.filter((f) => f.project_id === id).length

  const cadastralProjects = useMemo(
    () => projects.filter((p) => p.category === 'cadastral'),
    [projects],
  )
  const civilProjects = useMemo(
    () => projects.filter((p) => p.category === 'civil'),
    [projects],
  )
  const uncategorizedProjects = useMemo(
    () => projects.filter((p) => p.category == null),
    [projects],
  )

  const handleGoPC = () => {
    setDisplayModeOverride('pc')
    navigate('/')
  }

  const handleSignOut = async () => {
    if (confirm('ログアウトしますか？')) {
      await signOut()
      navigate('/login')
    }
  }

  if (loading && projects.length === 0) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="mobile-screen flex flex-col bg-slate-50">
      <div className="px-3 py-2 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <span className="font-medium">現場一覧（スマホ）</span>
        <button
          onClick={handleGoPC}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700"
          title="PC表示へ切替"
        >
          <Monitor className="h-3.5 w-3.5" />
          PC表示
        </button>
        <div className="flex-1" />
        {userLabel && (
          <span className="text-[11px] text-slate-300 truncate max-w-[6rem]" title={user?.email ?? ''}>
            {userLabel}
          </span>
        )}
        <FeedbackButton variant="mobile" />
        <button
          onClick={handleSignOut}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700"
          title="ログアウト"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs text-red-600">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-3 space-y-3">
        {/* 新規作成ボタン (地籍測量 / 土木工事)。空でも常時表示 */}
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => openCreateDialog('cadastral')}
            className="flex items-center justify-center gap-1 py-2.5 text-sm font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700"
          >
            <Plus className="h-4 w-4" />
            新規地籍測量
          </button>
          <button
            onClick={() => openCreateDialog('civil')}
            className="flex items-center justify-center gap-1 py-2.5 text-sm font-semibold bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            新規土木工事
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="text-center py-8 text-sm text-slate-500">
            工事がありません。上のボタンから新規作成してください。
          </div>
        ) : (
          <>
            <MobileProjectsSection
              title="地籍測量"
              accentClass="bg-emerald-500"
              projects={cadastralProjects}
              emptyText="地籍測量の工事はありません。"
              farmCountByProject={farmCountByProject}
              onSelect={(p) => navigate(`/mobile/farms/${p.id}`)}
              onEdit={(p) => setEditProject(p)}
            />
            <MobileProjectsSection
              title="土木工事"
              accentClass="bg-blue-500"
              projects={civilProjects}
              emptyText="土木工事の工事はありません。"
              farmCountByProject={farmCountByProject}
              onSelect={(p) => navigate(`/mobile/farms/${p.id}`)}
              onEdit={(p) => setEditProject(p)}
            />
            {uncategorizedProjects.length > 0 && (
              <MobileProjectsSection
                title={`未分類 (${uncategorizedProjects.length})`}
                accentClass="bg-amber-500"
                projects={uncategorizedProjects}
                emptyText="未分類はありません。"
                hint="編集ボタンから種別（地籍測量 / 土木工事）を設定してください。"
                hintIcon={<AlertCircle className="h-3 w-3" />}
                farmCountByProject={farmCountByProject}
                onSelect={(p) => navigate(`/mobile/farms/${p.id}`)}
                onEdit={(p) => setEditProject(p)}
              />
            )}
          </>
        )}
      </div>

      {/* 編集モーダル */}
      {editProject && (
        <MobileProjectEditModal
          project={editProject}
          onClose={() => setEditProject(null)}
          onDone={() => {
            void fetchProjects()
            void fetchFarms()
          }}
        />
      )}

      {/* 新規工事作成ダイアログ (モバイル向けボトムシート) */}
      {showNewDialog && (
        <div
          className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[9999]"
          onClick={() => !creating && setShowNewDialog(null)}
        >
          <div
            className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl flex flex-col max-h-[92vh]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
              <h3 className="text-base font-semibold">
                新規{PROJECT_CATEGORY_LABEL[showNewDialog]}
              </h3>
              <button
                onClick={() => !creating && setShowNewDialog(null)}
                disabled={creating}
                className="p-1 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-50"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 overflow-y-auto flex-1 space-y-3">
              <div>
                <label className="block text-xs text-slate-600 mb-1">現場名</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-2 py-2 text-base border rounded"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">概要</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="w-full px-2 py-2 text-sm border rounded h-16"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">座標系</label>
                <select
                  value={newZone}
                  onChange={(e) => setNewZone(parseInt(e.target.value, 10))}
                  className="w-full px-2 py-2 text-sm border rounded"
                >
                  {Object.entries(JGD2011_ZONES).map(([zone, info]) => (
                    <option key={zone} value={zone}>
                      {info.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="px-4 py-3 border-t flex gap-2 shrink-0">
              <button
                onClick={() => setShowNewDialog(null)}
                disabled={creating}
                className="flex-1 px-3 py-2 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                作成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MobileProjectsSection({
  title,
  accentClass,
  projects,
  emptyText,
  hint,
  hintIcon,
  farmCountByProject,
  onSelect,
  onEdit,
}: {
  title: string
  accentClass: string
  projects: Project[]
  emptyText: string
  hint?: string
  hintIcon?: React.ReactNode
  farmCountByProject: (id: string) => number
  onSelect: (p: Project) => void
  onEdit: (p: Project) => void
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`inline-block w-1 h-4 rounded ${accentClass}`} />
        <h2 className="text-sm font-semibold text-slate-700">{title}</h2>
        <span className="text-[11px] text-slate-400">({projects.length})</span>
      </div>
      {hint && (
        <div className="mb-2 px-2 py-1 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-800 flex items-center gap-1">
          {hintIcon}
          {hint}
        </div>
      )}
      {projects.length === 0 ? (
        <div className="text-center py-4 text-[12px] text-slate-400 border border-dashed rounded bg-white">
          {emptyText}
        </div>
      ) : (
        <ul className="space-y-2">
          {projects.map((p) => {
            const count = farmCountByProject(p.id)
            return (
              <li key={p.id} className="relative">
                <button
                  onClick={() => onSelect(p)}
                  className="w-full text-left bg-white border rounded-lg p-3 pr-11 hover:border-blue-400 active:bg-blue-50"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Folder className="h-4 w-4 text-blue-600 flex-shrink-0" />
                    <span className="font-semibold flex-1 truncate" title={p.name}>
                      {p.name}
                    </span>
                    <span className="inline-flex items-center gap-1 text-xs text-slate-500 flex-shrink-0">
                      <MapPin className="h-3 w-3" />
                      {count}
                    </span>
                  </div>
                  {p.description && (
                    <div className="text-xs text-slate-500 line-clamp-2">
                      {p.description}
                    </div>
                  )}
                  {(p.client || p.contractor) && (
                    <div className="text-[11px] text-slate-400 mt-1 truncate">
                      {p.client && `発注: ${p.client}`}
                      {p.client && p.contractor && ' / '}
                      {p.contractor && `受託: ${p.contractor}`}
                    </div>
                  )}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onEdit(p)
                  }}
                  className="absolute top-2 right-2 p-1.5 rounded border border-slate-300 bg-white text-slate-500 hover:text-slate-800 hover:bg-slate-50"
                  title="現場を編集"
                  aria-label="現場を編集"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
