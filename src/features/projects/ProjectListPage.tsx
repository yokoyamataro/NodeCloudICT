import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Plus, FolderOpen } from 'lucide-react'

// 仮のプロジェクト型（NodeCloudと同じSupabaseを使用する想定）
interface Project {
  id: string
  name: string
  project_number: string | null
  status: string
  created_at: string
}

export function ProjectListPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // TODO: Supabaseからプロジェクト一覧を取得
    // 現在は仮データ
    setProjects([
      {
        id: '1',
        name: 'サンプル工事',
        project_number: 'P-2024-001',
        status: 'active',
        created_at: '2024-01-15',
      },
    ])
    setLoading(false)
  }, [])

  if (loading) {
    return (
      <div className="p-8 flex items-center justify-center">
        <p className="text-muted-foreground">読み込み中...</p>
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
        <button className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors">
          <Plus className="h-4 w-4" />
          新規プロジェクト
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.map((project) => (
          <Link
            key={project.id}
            to={`/projects/${project.id}`}
            className="block p-6 bg-white rounded-lg border hover:border-primary transition-colors"
          >
            <div className="flex items-start gap-4">
              <div className="p-2 bg-slate-100 rounded-lg">
                <FolderOpen className="h-6 w-6 text-slate-600" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold truncate">{project.name}</h3>
                <p className="text-sm text-muted-foreground">{project.project_number}</p>
                <div className="mt-2 flex items-center gap-2">
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                    {project.status === 'active' ? '進行中' : project.status}
                  </span>
                </div>
              </div>
            </div>
          </Link>
        ))}

        {projects.length === 0 && (
          <div className="col-span-full text-center py-12 text-muted-foreground">
            プロジェクトがありません
          </div>
        )}
      </div>
    </div>
  )
}
