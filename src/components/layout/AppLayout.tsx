import { useState } from 'react'
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Map,
  Database,
  Calculator,
  GitBranch,
  Settings,
  ChevronDown,
  ChevronRight,
  FileSearch,
  MapPin,
  Upload,
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
  CloudOff,
  Cloud,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/AuthContext'
import { useSettingsStore } from '@/stores/settingsStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'

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
  { name: 'プロジェクト', href: '/', icon: Database },
  { name: '座標管理', href: '/coordinates', icon: Map },
  {
    name: '暗渠工事',
    href: '/underdrain',
    icon: GitBranch,
    children: [
      { name: '工事区域', href: '/underdrain/work-area', icon: Square },
      { name: 'CAD解析', href: '/underdrain/cad-analysis', icon: FileSearch },
      { name: '座標計算', href: '/underdrain/coordinate-calc', icon: MapPin },
      { name: '測量データ', href: '/underdrain/survey-import', icon: Upload },
      { name: '切深計算', href: '/underdrain/depth-calc', icon: Ruler },
      { name: '水理計算', href: '/underdrain/hydraulics', icon: Droplets },
      { name: 'CAD転記', href: '/underdrain/cad-export', icon: PenTool },
      { name: 'LandXML出力', href: '/underdrain/landxml', icon: FileOutput },
      { name: '現場データ', href: '/underdrain/field-data', icon: Eye },
      { name: '帳票作成', href: '/underdrain/reports', icon: FileText },
    ],
  },
  { name: '水理計算', href: '/hydraulics', icon: Calculator },
  { name: '設定', href: '/settings', icon: Settings },
]

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, signOut } = useAuth()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(['暗渠工事']) // デフォルトで暗渠工事を展開
  )

  // 設定ストア
  const { saveMode, setSaveMode, hasUnsavedChanges } = useSettingsStore()
  const { saveAllCoordinates, resetCoordinateChanges } = useCoordinateStore()
  const { saveAllPipes, resetPipeChanges } = useUnderdrainStore()
  const [saving, setSaving] = useState(false)

  const handleSignOut = async () => {
    if (hasUnsavedChanges) {
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
    try {
      await Promise.all([
        saveAllCoordinates(),
        saveAllPipes(),
      ])
    } finally {
      setSaving(false)
    }
  }

  // 変更をリセット
  const handleResetAll = () => {
    if (confirm('未保存の変更を破棄しますか？')) {
      resetCoordinateChanges()
      resetPipeChanges()
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
          <p className="text-sm text-slate-400">ICT設計システム</p>

          {/* 保存モード切替 */}
          <div className="mt-3 p-2 bg-slate-800 rounded-lg">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-400">保存モード</span>
              {saveMode === 'auto' ? (
                <Cloud className="h-3.5 w-3.5 text-green-400" />
              ) : (
                <CloudOff className="h-3.5 w-3.5 text-yellow-400" />
              )}
            </div>
            <div className="flex gap-1">
              <button
                onClick={() => setSaveMode('auto')}
                className={cn(
                  'flex-1 px-2 py-1 text-xs rounded transition-colors',
                  saveMode === 'auto'
                    ? 'bg-green-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                )}
              >
                自動
              </button>
              <button
                onClick={() => setSaveMode('manual')}
                className={cn(
                  'flex-1 px-2 py-1 text-xs rounded transition-colors',
                  saveMode === 'manual'
                    ? 'bg-yellow-600 text-white'
                    : 'bg-slate-700 text-slate-400 hover:bg-slate-600'
                )}
              >
                手動
              </button>
            </div>

            {/* 手動モード時の保存・リセットボタン */}
            {saveMode === 'manual' && (
              <div className="mt-2 flex gap-1">
                <button
                  onClick={handleSaveAll}
                  disabled={!hasUnsavedChanges || saving}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
                    hasUnsavedChanges
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
                  disabled={!hasUnsavedChanges}
                  className={cn(
                    'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 text-xs rounded transition-colors',
                    hasUnsavedChanges
                      ? 'bg-slate-600 text-white hover:bg-slate-500'
                      : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                  )}
                >
                  <RotateCcw className="h-3 w-3" />
                  リセット
                </button>
              </div>
            )}

            {/* 未保存の変更インジケーター */}
            {hasUnsavedChanges && (
              <div className="mt-2 text-xs text-yellow-400 flex items-center gap-1">
                <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                未保存の変更があります
              </div>
            )}
          </div>
        </div>
        <nav className="flex-1 p-4 overflow-y-auto">
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
