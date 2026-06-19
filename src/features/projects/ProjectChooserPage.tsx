// トップページ: 工事（プロジェクト）を選択する画面。
// 上から 地籍測量一覧 → 土木工事一覧 → 未分類（あれば）の順で縦に並べる。
// 旧仕様ではタブ切替だったが、両方を一画面で見渡せたほうが現場ニーズに合うため
// 廃止して縦並びにした（PC / モバイル共通方針）。

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Folder, Loader2, Users, MapPin, AlertCircle } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { JGD2011_ZONES } from '@/lib/coordinates'
import type { Project, ProjectCategory } from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'
import { AnnouncementsSection } from '@/features/announcements/AnnouncementsSection'

export function ProjectChooserPage() {
  const navigate = useNavigate()
  const {
    projects,
    loading,
    error,
    fetchProjects,
    createProject,
    setCurrentProject,
  } = useProjectListStore()
  const { farms, fetchFarms, setCurrentFarm } = useFarmStore()

  // 新規作成ダイアログは category を持つ
  const [showNewDialog, setShowNewDialog] = useState<ProjectCategory | null>(null)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newZone, setNewZone] = useState(13)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchProjects()
    fetchFarms()
    // トップページに来た時点で選択状態を解除（リロードしてもトップのまま）
    setCurrentFarm(null)
    setCurrentProject(null)
  }, [fetchProjects, fetchFarms, setCurrentFarm, setCurrentProject])

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
        <h1 className="text-lg font-bold flex-1">工事一覧</h1>
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
        />
        <ProjectsSection
          title="土木工事一覧"
          accentClass="bg-blue-500"
          projects={civilProjects}
          emptyText="土木工事の工事がありません。右上の「新規土木工事」から作成してください。"
          farmCountByProject={farmCountByProject}
          onSelectProject={(p) => navigate(`/projects/${p.id}`)}
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
          />
        )}
      </div>

      {/* 新規工事作成ダイアログ（種別ごと） */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-white rounded-lg p-5 w-full max-w-md">
            <h3 className="text-base font-semibold mb-3">
              新規{PROJECT_CATEGORY_LABEL[showNewDialog]}
            </h3>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs text-slate-600 mb-1">工事名</label>
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
          {projects.map((p) => {
            const count = farmCountByProject(p.id)
            const zoneName =
              JGD2011_ZONES[p.coordinate_zone]?.name ?? `第${p.coordinate_zone}系`
            return (
              <button
                key={p.id}
                onClick={() => onSelectProject(p)}
                className="text-left bg-white border rounded-lg p-3 hover:border-blue-400 hover:shadow transition-shadow"
              >
                <div className="flex items-center gap-2 mb-1">
                  <Folder className="h-4 w-4 text-blue-600 flex-shrink-0" />
                  <span className="font-semibold truncate flex-1" title={p.name}>
                    {p.name}
                  </span>
                  {p.category == null && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">
                      未分類
                    </span>
                  )}
                </div>
                {p.description && (
                  <div className="text-xs text-slate-500 mb-2 line-clamp-2">
                    {p.description}
                  </div>
                )}
                <div className="flex items-center gap-3 text-xs text-slate-500 mt-2">
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    工区 {count}
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
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
