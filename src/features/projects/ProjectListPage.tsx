import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Plus, FolderOpen, Trash2, Loader2 } from 'lucide-react'
import { useProjectStore, type Project } from '@/stores/projectStore'
import { JGD2011_ZONES } from '@/lib/coordinates'

export function ProjectListPage() {
  const navigate = useNavigate()
  const { projects, loading, error, fetchProjects, createProject, deleteProject, setCurrentProject } = useProjectStore()
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [newProjectZone, setNewProjectZone] = useState(6)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return
    setCreating(true)
    const project = await createProject(newProjectName, newProjectDescription, newProjectZone)
    setCreating(false)
    if (project) {
      setShowNewDialog(false)
      setNewProjectName('')
      setNewProjectDescription('')
      setNewProjectZone(6)
    }
  }

  const handleSelectProject = (project: Project) => {
    setCurrentProject(project)
    navigate('/coordinates')
  }

  const handleDeleteProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (confirm('このプロジェクトを削除しますか？関連するすべてのデータが削除されます。')) {
      await deleteProject(id)
    }
  }

  if (loading && projects.length === 0) {
    return (
      <div className="p-8 flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-2 text-muted-foreground">読み込み中...</span>
      </div>
    )
  }

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">プロジェクト一覧</h1>
          <p className="text-muted-foreground">ICT設計データを管理するプロジェクトを選択</p>
        </div>
        <button
          onClick={() => setShowNewDialog(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          新規プロジェクト
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <div
            key={project.id}
            onClick={() => handleSelectProject(project)}
            className="block p-6 bg-white rounded-lg border hover:border-primary transition-colors cursor-pointer"
          >
            <div className="flex items-start gap-4">
              <div className="p-2 bg-slate-100 rounded-lg">
                <FolderOpen className="h-6 w-6 text-slate-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold truncate">{project.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {project.description || '説明なし'}
                </p>
                <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
                  <span>第{project.coordinate_zone}系</span>
                  <span>•</span>
                  <span>{new Date(project.created_at).toLocaleDateString('ja-JP')}</span>
                </div>
              </div>
              <button
                onClick={(e) => handleDeleteProject(e, project.id)}
                className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                title="削除"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </div>
        ))}

        {projects.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            プロジェクトがありません。「新規プロジェクト」から作成してください。
          </div>
        )}
      </div>

      {/* 新規プロジェクトダイアログ */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold mb-4">新規プロジェクト</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">プロジェクト名 *</label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例: 〇〇地区圃場整備工事"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">説明</label>
                <textarea
                  value={newProjectDescription}
                  onChange={(e) => setNewProjectDescription(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={2}
                  placeholder="プロジェクトの説明（任意）"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">座標系</label>
                <select
                  value={newProjectZone}
                  onChange={(e) => setNewProjectZone(parseInt(e.target.value))}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {Object.entries(JGD2011_ZONES).map(([num, info]) => (
                    <option key={num} value={num}>
                      {info.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowNewDialog(false)}
                className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleCreateProject}
                disabled={!newProjectName.trim() || creating}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
