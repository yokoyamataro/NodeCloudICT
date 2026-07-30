// トップページ: 工事（プロジェクト）を選択する画面。
// 上から 地籍測量一覧 → 土木工事一覧 → 未分類（あれば）の順で縦に並べる。
// 旧仕様ではタブ切替だったが、両方を一画面で見渡せたほうが現場ニーズに合うため
// 廃止して縦並びにした（PC / モバイル共通方針）。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Folder, Loader2, Users, MapPin, AlertCircle, Trash2, Edit3, Check, Lock, Globe, Car, ChevronRight } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { JGD2011_ZONES } from '@/lib/coordinates'
import type { Project, ProjectCategory, ProjectVisibility } from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'
import { AnnouncementsSection } from '@/features/announcements/AnnouncementsSection'
import { ProjectEditModal } from '@/features/projects/ProjectEditModal'
import {
  useProjectPermission,
  ROLE_LABEL,
  ROLE_BADGE_CLASS,
} from '@/lib/useProjectPermission'
import { useCanUseMobility, useCanManageMobility } from '@/lib/useCanUseMobility'

export function ProjectChooserPage() {
  const navigate = useNavigate()
  const {
    projects,
    loading,
    error,
    fetchProjects,
    fetchUserRoles,
    createProject,
    updateProject,
    deleteProject,
    setCurrentProject,
  } = useProjectListStore()
  const { farms, fetchFarms, setCurrentFarm } = useFarmStore()
  const canUseMobility = useCanUseMobility()
  const canManageMobility = useCanManageMobility()

  // 新規作成ダイアログは category を持つ
  const [showNewDialog, setShowNewDialog] = useState<ProjectCategory | null>(null)
  // 現場情報編集モーダル
  const [editProject, setEditProject] = useState<Project | null>(null)
  // 完了現場を非表示にするか (既定: 非表示)。localStorage に永続化 (工区側と同じキーで別枠)
  const [hideCompletedProjects, setHideCompletedProjects] = useState<boolean>(() => {
    try { return localStorage.getItem('projects:hideCompletedProjects') !== '0' } catch { return true }
  })
  useEffect(() => {
    try {
      localStorage.setItem('projects:hideCompletedProjects', hideCompletedProjects ? '1' : '0')
    } catch { /* ignore */ }
  }, [hideCompletedProjects])
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newZone, setNewZone] = useState(13)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchProjects()
    fetchFarms()
    // 各プロジェクトごとの自分の role をキャッシュ (useProjectPermission で参照)
    void fetchUserRoles()
    // トップページに来た時点で選択状態を解除（リロードしてもトップのまま）
    setCurrentFarm(null)
    setCurrentProject(null)
  }, [fetchProjects, fetchFarms, fetchUserRoles, setCurrentFarm, setCurrentProject])

  // 完了現場フィルタ (hideCompletedProjects=true の時は completed_at != null を除外)
  const visibleProjects = useMemo(
    () =>
      hideCompletedProjects
        ? projects.filter((p) => p.completed_at == null)
        : projects,
    [projects, hideCompletedProjects],
  )
  const cadastralProjects = useMemo(
    () => visibleProjects.filter((p) => p.category === 'cadastral'),
    [visibleProjects],
  )
  const civilProjects = useMemo(
    () => visibleProjects.filter((p) => p.category === 'civil'),
    [visibleProjects],
  )
  const uncategorizedProjects = useMemo(
    () => visibleProjects.filter((p) => p.category == null),
    [visibleProjects],
  )

  const farmCountByProject = (projectId: string) =>
    farms.filter((f) => f.project_id === projectId).length

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
      setNewName('')
      setNewDescription('')
      setShowNewDialog(null)
    } finally {
      setCreating(false)
    }
  }

  if (loading && projects.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-2 text-muted-foreground">読み込み中...</span>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-slate-50 overflow-auto">
      {/* お知らせ（未読のみ常時表示・既読は折りたたみ） */}
      <AnnouncementsSection />

      {/* タイトル + 種別ごとの新規作成ボタン */}
      <div className="p-4 bg-white border-b flex items-center gap-3 flex-wrap">
        <Folder className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">現場一覧</h1>
        <button
          type="button"
          onClick={() => setHideCompletedProjects((v) => !v)}
          className={`flex items-center gap-1 px-2 py-1.5 text-sm rounded border ${
            !hideCompletedProjects
              ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
              : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
          }`}
          title={
            hideCompletedProjects
              ? '完了した現場も表示する'
              : '完了した現場を非表示にする'
          }
        >
          <Check className="h-4 w-4" />
          完了を表示
        </button>
        <button
          onClick={() => navigate('/trash')}
          className="flex items-center gap-1 px-2 py-1.5 text-sm border border-slate-300 text-slate-600 rounded hover:bg-slate-50"
          title="削除した現場・工区を確認"
        >
          <Trash2 className="h-4 w-4" />
          ゴミ箱
        </button>
        <button
          onClick={() => openCreateDialog('cadastral')}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700"
        >
          <Plus className="h-4 w-4" />
          新規地籍測量
        </button>
        <button
          onClick={() => openCreateDialog('civil')}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          新規土木工事
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border-b border-red-200 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4 space-y-6">
        <ProjectsSection
          title="地籍測量一覧"
          accentClass="bg-emerald-500"
          projects={cadastralProjects}
          emptyText="地籍測量の工事がありません。右上の「新規地籍測量」から作成してください。"
          farmCountByProject={farmCountByProject}
          onSelectProject={(p) => navigate(`/projects/${p.id}`)}
          onEditProject={(p) => setEditProject(p)}
        />
        <ProjectsSection
          title="土木工事一覧"
          accentClass="bg-blue-500"
          projects={civilProjects}
          emptyText="土木工事の工事がありません。右上の「新規土木工事」から作成してください。"
          farmCountByProject={farmCountByProject}
          onSelectProject={(p) => navigate(`/projects/${p.id}`)}
          onEditProject={(p) => setEditProject(p)}
        />
        {uncategorizedProjects.length > 0 && (
          <ProjectsSection
            title={`未分類 (${uncategorizedProjects.length})`}
            accentClass="bg-amber-500"
            projects={uncategorizedProjects}
            emptyText="未分類の工事はありません。"
            hint="以前作成された工事です。工区を開いたタイミングで種別（地籍測量 / 土木工事）を指定してください。"
            hintIcon={<AlertCircle className="h-3.5 w-3.5" />}
            farmCountByProject={farmCountByProject}
            onSelectProject={(p) => navigate(`/projects/${p.id}`)}
            onEditProject={(p) => setEditProject(p)}
          />
        )}
        {/* モビリティ (準備中): サイトオーナーだけに表示。現場と違いタイル 1 個で入口を提供する */}
        {canUseMobility && (
          <MobilityTile
            onOpen={() =>
              // 管理者は管理画面へ、それ以外はドライバー画面へ
              navigate(canManageMobility ? '/mobility' : '/mobility/drive')
            }
            isAdmin={canManageMobility}
          />
        )}
      </div>

      {/* 現場情報編集モーダル */}
      {editProject && (
        <ProjectEditModal
          project={projects.find((p) => p.id === editProject.id) ?? editProject}
          onSave={async (patch) => {
            await updateProject(editProject.id, patch)
          }}
          onClose={() => setEditProject(null)}
          onDelete={async () => {
            const id = editProject.id
            setEditProject(null)
            try {
              await deleteProject(id)
              fetchFarms()
            } catch (err) {
              alert(err instanceof Error ? err.message : '現場の削除に失敗しました')
            }
          }}
        />
      )}

      {/* 新規工事作成ダイアログ（種別ごと） */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-white rounded-lg p-5 w-full max-w-md">
            <h3 className="text-base font-semibold mb-3">
              新規{PROJECT_CATEGORY_LABEL[showNewDialog]}
            </h3>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs text-slate-600 mb-1">現場名</label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border rounded"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">概要</label>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border rounded h-16"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">座標系</label>
                <select
                  value={newZone}
                  onChange={(e) => setNewZone(parseInt(e.target.value, 10))}
                  className="w-full px-2 py-1.5 text-sm border rounded"
                >
                  {Object.entries(JGD2011_ZONES).map(([zone, info]) => (
                    <option key={zone} value={zone}>
                      {info.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNewDialog(null)}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                disabled={creating}
              >
                キャンセル
              </button>
              <button
                onClick={handleCreate}
                disabled={creating || !newName.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                作成
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// モビリティ入口タイル。現場と違い 1 枚の CTA タイルとして描画する。
// 管理者向けは「管理画面へ」、ドライバー向けは「乗車 / 現在地送信」
function MobilityTile({
  onOpen,
  isAdmin,
}: {
  onOpen: () => void
  isAdmin: boolean
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <div className="w-1 h-5 rounded bg-indigo-500" />
        <h2 className="text-sm font-semibold text-slate-700">モビリティ</h2>
        <span className="px-1.5 py-0.5 text-[10px] rounded bg-amber-100 text-amber-800 border border-amber-300">
          開発中
        </span>
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="w-full flex items-center gap-3 p-4 bg-white rounded-lg border shadow-sm hover:border-indigo-400 hover:bg-indigo-50/40 transition text-left"
      >
        <div className="h-10 w-10 rounded-full bg-indigo-100 flex items-center justify-center shrink-0">
          <Car className="h-5 w-5 text-indigo-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800">
            {isAdmin
              ? '社員・車両・重機の現在地を管理'
              : '乗車 / 現在地送信'}
          </div>
          <div className="text-xs text-slate-500 mt-0.5">
            {isAdmin
              ? '走行ログ・地図・車両マスタ (管理者向け)'
              : '地図を見ながら乗車 / 降車 / 位置送信'}
          </div>
        </div>
        <ChevronRight className="h-5 w-5 text-slate-400" />
      </button>
    </section>
  )
}

// 種別ごとに同じカードグリッドを描画する小コンポーネント。
// 見出し（左にアクセントバー）+ 空のときの案内 + カードグリッド の構成。
function ProjectsSection({
  title,
  accentClass,
  projects,
  emptyText,
  hint,
  hintIcon,
  farmCountByProject,
  onSelectProject,
  onEditProject,
}: {
  title: string
  /** 見出し左のアクセント色 (tailwind bg-...) */
  accentClass: string
  projects: Project[]
  emptyText: string
  hint?: string
  hintIcon?: React.ReactNode
  farmCountByProject: (projectId: string) => number
  onSelectProject: (p: Project) => void
  onEditProject: (p: Project) => void
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className={`inline-block w-1 h-5 rounded ${accentClass}`} />
        <h2 className="text-base font-semibold text-slate-800">{title}</h2>
        <span className="text-xs text-slate-400">({projects.length})</span>
      </div>
      {hint && (
        <div className="mb-2 px-3 py-1.5 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 flex items-center gap-1">
          {hintIcon}
          {hint}
        </div>
      )}
      {projects.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-xs border border-dashed rounded bg-white">
          {emptyText}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              farmCount={farmCountByProject(p.id)}
              onSelect={onSelectProject}
              onEdit={onEditProject}
            />
          ))}
        </div>
      )}
    </section>
  )
}

/** 現場カード 1 件。permission を判定して編集ボタンの表示可否・役割バッジを出す。 */
function ProjectCard({
  project: p,
  farmCount,
  onSelect,
  onEdit,
}: {
  project: Project
  farmCount: number
  onSelect: (p: Project) => void
  onEdit: (p: Project) => void
}) {
  const perm = useProjectPermission(p)
  const zoneName =
    JGD2011_ZONES[p.coordinate_zone]?.name ?? `第${p.coordinate_zone}系`
  const done = p.completed_at != null

  const editBtnClass = perm.canEdit
    ? 'absolute top-1.5 right-1.5 p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-white/80 opacity-70 group-hover:opacity-100'
    : 'absolute top-1.5 right-1.5 p-1 rounded text-slate-300 cursor-not-allowed opacity-40'

  return (
    <div
      onClick={() => onSelect(p)}
      className={`relative text-left border rounded-lg p-3 hover:shadow transition-shadow cursor-pointer group ${
        done ? 'bg-emerald-50 hover:border-emerald-400' : 'bg-white hover:border-blue-400'
      }`}
    >
      {/* 右上: 編集ボタン (現場情報編集モーダルを開く) - 権限がなければ disabled */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (perm.canEdit) onEdit(p)
        }}
        disabled={!perm.canEdit}
        className={editBtnClass}
        title={
          perm.canEdit
            ? '現場情報を編集'
            : '閲覧権限のみです (編集にはオーナーまたは編集者権限が必要)'
        }
      >
        <Edit3 className="h-3.5 w-3.5" />
      </button>
      <div className="flex items-center gap-1.5 mb-1 pr-6">
        <Folder
          className={`h-4 w-4 flex-shrink-0 ${done ? 'text-emerald-600' : 'text-blue-600'}`}
        />
        <span className="font-semibold truncate flex-1" title={p.name}>
          {p.name}
        </span>
        <VisibilityBadge visibility={p.visibility} />
        {done && (
          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-200 text-emerald-800 rounded">
            完了
          </span>
        )}
        {p.category == null && (
          <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
            未分類
          </span>
        )}
      </div>
      {/* 自分の役割バッジ (owner/editor/viewer)。null (public 閲覧のみ) は非表示 */}
      {perm.role && (
        <div className="mb-1">
          <span
            className={`inline-flex items-center text-[10px] px-1.5 py-0.5 rounded border font-medium ${
              ROLE_BADGE_CLASS[perm.role]
            }`}
            title={`あなたの役割: ${ROLE_LABEL[perm.role]}`}
          >
            {ROLE_LABEL[perm.role]}
          </span>
        </div>
      )}
      {p.description && (
        <div className="text-xs text-slate-500 mb-2 line-clamp-2">
          {p.description}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-slate-500 mt-2">
        <span className="inline-flex items-center gap-1">
          <MapPin className="h-3 w-3" />
          工区 {farmCount}
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" />
          {zoneName.replace(/（.*$/, '')}
        </span>
      </div>
      {(p.client || p.contractor) && (
        <div className="text-[11px] text-slate-400 mt-1 truncate">
          {p.client && `発注: ${p.client}`}
          {p.client && p.contractor && ' / '}
          {p.contractor && `受託: ${p.contractor}`}
        </div>
      )}
    </div>
  )
}

// 共有ポリシー バッジ (占有 / 共有 / 公開)。工事カードや一覧に表示する用の共通コンポーネント
function VisibilityBadge({ visibility }: { visibility: ProjectVisibility }) {
  const conf = (() => {
    switch (visibility) {
      case 'private':
        return { label: '占有', icon: Lock, cls: 'bg-slate-100 text-slate-700 border-slate-300' }
      case 'shared':
        return { label: '共有', icon: Users, cls: 'bg-blue-50 text-blue-700 border-blue-200' }
      case 'public':
        return { label: '公開', icon: Globe, cls: 'bg-amber-50 text-amber-700 border-amber-200' }
    }
  })()
  const Icon = conf.icon
  return (
    <span
      className={`inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border font-medium ${conf.cls}`}
      title={`共有ポリシー: ${conf.label}`}
    >
      <Icon className="h-2.5 w-2.5" />
      {conf.label}
    </span>
  )
}
