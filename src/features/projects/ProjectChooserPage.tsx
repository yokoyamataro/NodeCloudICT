// トップページ: 工事（プロジェクト）を選択する画面
// 工事を選択すると /projects/:projectId に遷移し、その工事配下の工区一覧へ。

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, Folder, Loader2, Users, MapPin } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { JGD2011_ZONES } from '@/lib/coordinates'

export function ProjectChooserPage() {
  const navigate = useNavigate()
  const {
    projects,
    loading,
    error,
    fetchProjects,
    createProject,
  } = useProjectListStore()
  const { farms, fetchFarms } = useFarmStore()
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const [newZone, setNewZone] = useState(13)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchProjects()
    fetchFarms()
  }, [fetchProjects, fetchFarms])

  const farmCountByProject = (projectId: string) =>
    farms.filter((f) => f.project_id === projectId).length

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      await createProject(newName.trim(), newDescription.trim() || undefined, newZone)
      setNewName('')
      setNewDescription('')
      setShowNewDialog(false)
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
    <div className="h-full flex flex-col bg-slate-50">
      <div className="p-4 bg-white border-b flex items-center gap-3">
        <Folder className="h-5 w-5 text-blue-600" />
        <h1 className="text-lg font-bold flex-1">工事一覧</h1>
        <button
          onClick={() => setShowNewDialog(true)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          <Plus className="h-4 w-4" />
          新規工事
        </button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border-b border-red-200 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {projects.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground text-sm">
            工事がありません。「新規工事」ボタンから作成してください。
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {projects.map((p) => {
              const count = farmCountByProject(p.id)
              const zoneName = JGD2011_ZONES[p.coordinate_zone]?.name ?? `第${p.coordinate_zone}系`
              return (
                <button
                  key={p.id}
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className="text-left bg-white border rounded-lg p-3 hover:border-blue-400 hover:shadow transition-shadow"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Folder className="h-4 w-4 text-blue-600 flex-shrink-0" />
                    <span className="font-semibold truncate flex-1" title={p.name}>
                      {p.name}
                    </span>
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
      </div>

      {/* 新規工事作成ダイアログ */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
          <div className="bg-white rounded-lg p-5 w-full max-w-md">
            <h3 className="text-base font-semibold mb-3">新規工事</h3>
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
                onClick={() => setShowNewDialog(false)}
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
