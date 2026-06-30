// モバイルのトップ画面: 工事（プロジェクト）を選んでから工区一覧へ
// 選ぶと /mobile/farms/:projectId に遷移する。
// 上から 地籍測量 → 土木工事 → 未分類（あれば）の順で縦に並べる。

import { useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { AlertCircle, Folder, Loader2, LogOut, MapPin, Monitor } from 'lucide-react'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { useAuth } from '@/contexts/AuthContext'
import { setDisplayModeOverride } from '@/lib/displayMode'
import { FeedbackButton } from '@/components/layout/FeedbackButton'
import type { Project } from '@/types/database'

export function MobileProjectChooserPage() {
  const navigate = useNavigate()
  const { signOut, user, profile } = useAuth()
  const userLabel = profile?.full_name?.trim() || (user?.email ? user.email.split('@')[0] : '')
  const { projects, loading, error, fetchProjects } = useProjectListStore()
  const { farms, fetchFarms } = useFarmStore()

  useEffect(() => {
    fetchProjects()
    fetchFarms()
  }, [fetchProjects, fetchFarms])

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

      <div className="flex-1 overflow-auto p-3 space-y-4">
        {projects.length === 0 ? (
          <div className="text-center py-12 text-sm text-slate-500">
            工事がありません。PC で作成してください。
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
            />
            <MobileProjectsSection
              title="土木工事"
              accentClass="bg-blue-500"
              projects={civilProjects}
              emptyText="土木工事の工事はありません。"
              farmCountByProject={farmCountByProject}
              onSelect={(p) => navigate(`/mobile/farms/${p.id}`)}
            />
            {uncategorizedProjects.length > 0 && (
              <MobileProjectsSection
                title={`未分類 (${uncategorizedProjects.length})`}
                accentClass="bg-amber-500"
                projects={uncategorizedProjects}
                emptyText="未分類はありません。"
                hint="PC で種別（地籍測量 / 土木工事）を設定してください。"
                hintIcon={<AlertCircle className="h-3 w-3" />}
                farmCountByProject={farmCountByProject}
                onSelect={(p) => navigate(`/mobile/farms/${p.id}`)}
              />
            )}
          </>
        )}
      </div>
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
}: {
  title: string
  accentClass: string
  projects: Project[]
  emptyText: string
  hint?: string
  hintIcon?: React.ReactNode
  farmCountByProject: (id: string) => number
  onSelect: (p: Project) => void
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
              <li key={p.id}>
                <button
                  onClick={() => onSelect(p)}
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
    </section>
  )
}
