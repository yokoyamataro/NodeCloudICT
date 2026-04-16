import { useState, useEffect } from 'react'
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Map,
  Database,
  GitBranch,
  Settings,
  ChevronDown,
  ChevronRight,
  FileSearch,
  MapPin,
  Upload,
  Cable,
  Ruler,
  Droplets,
  PenTool,
  FileOutput,
  Eye,
  FileText,
  Square,
  LogOut,
  User,
  Save,
  RotateCcw,
  Loader2,
  Layers,
  Mountain,
  Shovel,
  Gem,
  LandPlot,
  FolderOpen,
  Home,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/AuthContext'
import { useSettingsStore } from '@/stores/settingsStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { usePipeWiringStore } from '@/stores/pipeWiringStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'

interface NavItem {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

interface NavGroup {
  name: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  children?: NavItem[]
}

const navigation: NavGroup[] = [
  { name: 'トップ', href: '/', icon: Home },
  { name: '座標管理', href: '/coordinates', icon: Map },
  {
    name: '暗渠工事',
    href: '/underdrain',
    icon: GitBranch,
    children: [
      { name: '工事区域', href: '/underdrain/work-area', icon: Square },
      { name: 'CAD解析', href: '/underdrain/cad-analysis', icon: FileSearch },
      { name: '座標計算', href: '/underdrain/coordinate-calc', icon: MapPin },
      { name: '配管系統', href: '/underdrain/pipe-wiring', icon: Cable },
      { name: '測量データ', href: '/underdrain/survey-import', icon: Upload },
      { name: '施工計画', href: '/underdrain/depth-calc', icon: Ruler },
      { name: '水理計算', href: '/underdrain/hydraulics', icon: Droplets },
      { name: 'CAD転記', href: '/underdrain/cad-export', icon: PenTool },
      { name: 'LandXML出力', href: '/underdrain/landxml', icon: FileOutput },
      { name: '現場データ', href: '/underdrain/field-data', icon: Eye },
      { name: '帳票作成', href: '/underdrain/reports', icon: FileText },
    ],
  },
  {
    name: '客土工事',
    href: '/soil-import',
    icon: Layers,
    children: [
      { name: '工事区域', href: '/soil-import/work-area', icon: Square },
    ],
  },
  {
    name: '簡易整地',
    href: '/simple-grading',
    icon: Mountain,
    children: [
      { name: '工事区域', href: '/simple-grading/work-area', icon: Square },
    ],
  },
  {
    name: '整地',
    href: '/grading',
    icon: LandPlot,
    children: [
      { name: '工事区域', href: '/grading/work-area', icon: Square },
    ],
  },
  {
    name: '心破土改',
    href: '/subsoil',
    icon: Shovel,
    children: [
      { name: '工事区域', href: '/subsoil/work-area', icon: Square },
    ],
  },
  {
    name: '徐礫',
    href: '/stone-removal',
    icon: Gem,
    children: [
      { name: '工事区域', href: '/stone-removal/work-area', icon: Square },
    ],
  },
  { name: '設定', href: '/settings', icon: Settings },
]

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(['暗渠工事']) // デフォルトで暗渠工事を展開
  )
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())

  // トップページかどうか
  const isTopPage = location.pathname === '/'

  // 設定ストア
  const { hasUnsavedChanges } = useSettingsStore()
  const { saveAllCoordinates, resetCoordinateChanges, error: coordinateError } = useCoordinateStore()
  const { saveAllPipes, resetPipeChanges, error: pipeError } = useUnderdrainStore()
  const { saveWiring, hasChanges: hasWiringChanges, error: wiringError } = usePipeWiringStore()
  const { hasChanges: hasWorkAreaChanges, saveAllWorkAreas, resetWorkAreaChanges, error: workAreaError } = useWorkAreaStore()

  // プロジェクト・圃場ストア
  const { projects, fetchProjects, currentProject, setCurrentProject } = useProjectListStore()
  const { farms, fetchFarms, currentFarm, setCurrentFarm } = useFarmStore()

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // トップページでプロジェクト一覧を取得
  useEffect(() => {
    if (isTopPage) {
      fetchProjects()
      fetchFarms()
    }
  }, [isTopPage, fetchProjects, fetchFarms])

  // プロジェクトの展開を切り替え
  const toggleProject = (projectId: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
  }

  // 圃場を開く
  const handleOpenFarm = (farm: typeof farms[0]) => {
    const project = projects.find(p => p.id === farm.project_id)
    if (project) {
      setCurrentProject(project)
    }
    setCurrentFarm(farm)
    navigate('/coordinates')
  }

  // 未保存の変更があるか（配管系統・工事区域も含む）
  const hasAnyUnsavedChanges = hasUnsavedChanges || hasWiringChanges || hasWorkAreaChanges

  // 各ストアのエラーを集約
  const anyError = coordinateError || pipeError || wiringError || workAreaError || saveError

  const handleSignOut = async () => {
    if (hasAnyUnsavedChanges) {
      if (!confirm('未保存の変更があります。保存せずにログアウトしますか？')) {
        return
      }
    }
    await signOut()
    navigate('/login')
  }

  // 全データを保存
  const handleSaveAll = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await Promise.all([
        saveAllCoordinates(),
        saveAllPipes(),
        saveWiring(),
        saveAllWorkAreas(),
      ])
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  // 変更をリセット
  const handleResetAll = () => {
    if (confirm('未保存の変更を破棄しますか？')) {
      resetCoordinateChanges()
      resetPipeChanges()
      resetWorkAreaChanges()
    }
  }

  const toggleGroup = (name: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(name)) {
        next.delete(name)
      } else {
        next.add(name)
      }
      return next
    })
  }

  const isActiveLink = (href: string) => {
    return location.pathname === href || location.pathname.startsWith(href + '/')
  }

  return (
    <div className="h-screen flex overflow-hidden">
      {/* サイドバー */}
      <aside className="w-64 bg-slate-900 text-white flex flex-col flex-shrink-0">
        <div className="p-4 border-b border-slate-700">
          <h1 className="text-xl font-bold">NodeCloud Design</h1>
          <div className="flex items-center gap-2">
            <p className="text-sm text-slate-400">ICT設計システム</p>
            <span className="text-xs text-slate-500">{__BUILD_TIME__}</span>
          </div>

          {/* 作業中のプロジェクト・圃場 */}
          {(currentProject || currentFarm) && (
            <div className="mt-3 p-2 bg-slate-800 rounded-lg text-xs">
              {currentProject && (
                <div className="text-slate-300 truncate" title={currentProject.name}>
                  {currentProject.name}
                </div>
              )}
              {currentFarm && (
                <div className="text-slate-400 truncate" title={currentFarm.name}>
                  └ {currentFarm.name}
                </div>
              )}
            </div>
          )}

          {/* 保存ボタン */}
          <div className="mt-3 p-2 bg-slate-800 rounded-lg">
            <div className="flex gap-1">
              <button
                onClick={handleSaveAll}
                disabled={!hasAnyUnsavedChanges || saving}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
                  hasAnyUnsavedChanges
                    ? 'bg-blue-600 text-white hover:bg-blue-500'
                    : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                )}
              >
                {saving ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                保存
              </button>
              <button
                onClick={handleResetAll}
                disabled={!hasAnyUnsavedChanges}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
                  hasAnyUnsavedChanges
                    ? 'bg-slate-600 text-white hover:bg-slate-500'
                    : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                )}
              >
                <RotateCcw className="h-3 w-3" />
                リセット
              </button>
            </div>

            {/* 未保存の変更インジケーター */}
            {hasAnyUnsavedChanges && (
              <div className="mt-2 text-xs text-yellow-400 flex items-center gap-1">
                <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                未保存の変更があります
              </div>
            )}

            {/* エラーメッセージ */}
            {anyError && (
              <div className="mt-2 text-xs text-red-400 bg-red-900/30 p-2 rounded">
                <div className="font-semibold">保存エラー</div>
                <div className="mt-1 break-words">{anyError}</div>
              </div>
            )}
          </div>
        </div>
        <nav className="flex-1 p-4 overflow-y-auto">
          {isTopPage ? (
            /* トップページ：プロジェクト・圃場リスト */
            <div className="space-y-2">
              <div className="text-xs text-slate-400 uppercase tracking-wide mb-2">プロジェクト</div>
              {projects.length === 0 ? (
                <div className="text-sm text-slate-500">プロジェクトがありません</div>
              ) : (
                <ul className="space-y-1">
                  {projects.map(project => {
                    const projectFarms = farms.filter(f => f.project_id === project.id)
                    const isExpanded = expandedProjects.has(project.id)

                    return (
                      <li key={project.id}>
                        <button
                          onClick={() => toggleProject(project.id)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 flex-shrink-0" />
                          ) : (
                            <ChevronRight className="h-4 w-4 flex-shrink-0" />
                          )}
                          <Database className="h-4 w-4 flex-shrink-0 text-slate-400" />
                          <span className="flex-1 text-left truncate">{project.name}</span>
                          <span className="text-xs text-slate-500">{projectFarms.length}</span>
                        </button>
                        {isExpanded && (
                          <ul className="ml-6 mt-1 space-y-0.5">
                            {projectFarms.length === 0 ? (
                              <li className="text-xs text-slate-500 py-1 px-2">圃場なし</li>
                            ) : (
                              projectFarms.map(farm => {
                                const isCurrentFarm = currentFarm?.id === farm.id
                                return (
                                  <li key={farm.id}>
                                    <button
                                      onClick={() => handleOpenFarm(farm)}
                                      className={cn(
                                        'w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors',
                                        isCurrentFarm
                                          ? 'bg-blue-600 text-white'
                                          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                                      )}
                                    >
                                      <FolderOpen className="h-3 w-3 flex-shrink-0" />
                                      <span className="flex-1 text-left truncate">{farm.name}</span>
                                    </button>
                                  </li>
                                )
                              })
                            )}
                          </ul>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          ) : (
            /* その他のページ：工種ナビゲーション */
            <ul className="space-y-1">
              {navigation.map((item) => {
                const hasChildren = item.children && item.children.length > 0
                const isExpanded = expandedGroups.has(item.name)
                const isActive = isActiveLink(item.href)
                const isChildActive = item.children?.some((child) =>
                  isActiveLink(child.href)
                )

                return (
                  <li key={item.name}>
                    {hasChildren ? (
                      <>
                        <button
                          onClick={() => toggleGroup(item.name)}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                            isActive || isChildActive
                              ? 'bg-slate-800 text-white'
                              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                          )}
                        >
                          <item.icon className="h-5 w-5" />
                          <span className="flex-1 text-left">{item.name}</span>
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </button>
                        {isExpanded && item.children && (
                          <ul className="mt-1 ml-4 space-y-1">
                            {item.children.map((child) => {
                              const isChildItemActive = isActiveLink(child.href)
                              return (
                                <li key={child.name}>
                                  <Link
                                    to={child.href}
                                    className={cn(
                                      'flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                                      isChildItemActive
                                        ? 'bg-slate-700 text-white'
                                        : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                                    )}
                                  >
                                    <child.icon className="h-4 w-4" />
                                    {child.name}
                                  </Link>
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </>
                    ) : (
                      <Link
                        to={item.href}
                        className={cn(
                          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-slate-800 text-white'
                          : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                      )}
                    >
                      <item.icon className="h-5 w-5" />
                      {item.name}
                    </Link>
                  )}
                </li>
              )
              })}
            </ul>
          )}
        </nav>
        <div className="p-4 border-t border-slate-700">
          <div className="flex items-center gap-2 mb-2">
            <User className="h-4 w-4 text-slate-400" />
            <span className="text-xs text-slate-300 truncate">{user?.email}</span>
          </div>
          <button
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-slate-800 rounded transition-colors"
          >
            <LogOut className="h-4 w-4" />
            ログアウト
          </button>
          <div className="mt-2 text-xs text-slate-500">v0.1.0</div>
        </div>
      </aside>

      {/* メインコンテンツ */}
      <main className="flex-1 bg-slate-50 overflow-hidden">
        <Outlet />
      </main>
    </div>
  )
}
