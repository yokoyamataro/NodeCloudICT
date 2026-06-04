// モバイルのトップ画面: 工事（プロジェクト）を選んでから工区一覧へ
// 選ぶと /mobile/farms/:projectId に遷移する。

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Folder, Loader2, LogOut, Monitor, MapPin } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { useAuth } from '@/contexts/AuthContext'
import { setDisplayModeOverride } from '@/lib/displayMode'
import { FeedbackButton } from '@/components/layout/FeedbackButton'

export function MobileProjectChooserPage() {
  const navigate = useNavigate()
  const { signOut, user } = useAuth()
  const userLabel = user?.email ? user.email.split('@')[0] : ''
  const { projects, loading, error, fetchProjects } = useProjectListStore()
  const { farms, fetchFarms } = useFarmStore()

  useEffect(() => {
    fetchProjects()
    fetchFarms()
  }, [fetchProjects, fetchFarms])

  const farmCountByProject = (id: string) =>
    farms.filter((f) => f.project_id === id).length

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
        <span className="font-medium">工事一覧（スマホ）</span>
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

      <div className="flex-1 overflow-auto p-3">
        {projects.length === 0 ? (
          <div className="text-center py-12 text-sm text-slate-500">
            工事がありません。PC で作成してください。
          </div>
        ) : (
          <ul className="space-y-2">
            {projects.map((p) => {
              const count = farmCountByProject(p.id)
              return (
                <li key={p.id}>
                  <button
                    onClick={() => navigate(`/mobile/farms/${p.id}`)}
                    className="w-full text-left bg-white border rounded-lg p-3 hover:border-blue-400 active:bg-blue-50"
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
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
