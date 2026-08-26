import { useEffect, useRef, useState } from 'react'
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import {
  Map,
  GitBranch,
  Settings,
  ChevronDown,
  ChevronRight,
  FileSearch,
  MapPin,
  Cable,
  Ruler,
  FileOutput,
  Square,
  LogOut,
  User,
  Save,
  RotateCcw,
  Loader2,
  Layers,
  Rows3,
  Grid3x3,
  Mountain,
  Waves,
  Shovel,
  Gem,
  LandPlot,
  Compass,
  Home,
  ExternalLink,
  Smartphone,
  PanelLeftClose,
  PanelLeftOpen,
  Image as ImageIcon,
  Users,
  KeyRound,
  FileText,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import { setDisplayModeOverride } from '@/lib/displayMode'
import { useSettingsStore } from '@/stores/settingsStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { usePipeWiringStore } from '@/stores/pipeWiringStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import {
  useGlobalSaveRegistry,
  hasAnyRegisteredChanges,
  runAllRegisteredSaves,
} from '@/stores/globalSaveRegistry'
import { useProjectListStore } from '@/stores/projectListStore'
import { useFarmStore } from '@/stores/farmStore'
import { FeedbackButton } from '@/components/layout/FeedbackButton'
import { isNavVisibleForCategory } from '@/lib/projectCategory'

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
  { name: '工区選択に戻る', href: '/', icon: Home },
  { name: '座標管理', href: '/coordinates', icon: Map },
  { name: '実測記録', href: '/staking-records', icon: FileSearch },
  // 地籍測量: 「地番管理」と「地権者管理」をフラットに並べる
  { name: '地番管理', href: '/boundary-survey/work-area', icon: Compass },
  { name: '地権者管理', href: '/boundary-survey/landowners', icon: Users },
  { name: '土地調査報告書作成', href: '/boundary-survey/land-report', icon: FileText },
  { name: '全体図', href: '/orthophoto', icon: ImageIcon },
  {
    name: '暗渠工事',
    href: '/underdrain',
    icon: GitBranch,
    children: [
      { name: '工事区域', href: '/underdrain/work-area', icon: Square },
      { name: 'CAD解析', href: '/underdrain/cad-analysis', icon: FileSearch },
      { name: '配管系統', href: '/underdrain/pipe-wiring', icon: Cable },
      { name: '座標計算', href: '/underdrain/coordinate-calc', icon: MapPin },
      { name: '施工計画', href: '/underdrain/depth-calc', icon: Ruler },
      { name: 'ICT施工', href: '/underdrain/landxml', icon: FileOutput },
    ],
  },
  {
    name: '客土工事',
    href: '/soil-import',
    icon: Layers,
    children: [
      { name: '工事区域', href: '/soil-import/work-area', icon: Square },
      { name: '帯置計画作成', href: '/soil-import/strip-plan', icon: Rows3 },
      { name: '坪置計画作成', href: '/soil-import/heap-plan', icon: Grid3x3 },
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
  {
    name: '線形物',
    href: '/open-channel',
    icon: Waves,
    children: [
      { name: '線形登録', href: '/open-channel/alignment', icon: Square },
    ],
  },
  { name: '設定', href: '/settings', icon: Settings },
]

export function AppLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, displayName, organizationName, isOrgAdmin, signOut } = useAuth()
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(['暗渠工事']) // デフォルトで暗渠工事を展開
  )

  // 設定ストア
  const { hasUnsavedChanges } = useSettingsStore()
  const { saveAllCoordinates, resetCoordinateChanges, error: coordinateError } = useCoordinateStore()
  const { saveAllPipes, resetPipeChanges, error: pipeError } = useUnderdrainStore()
  const { saveWiring, hasChanges: hasWiringChanges, error: wiringError } = usePipeWiringStore()
  const { hasChanges: hasWorkAreaChanges, saveAllWorkAreas, resetWorkAreaChanges, error: workAreaError } = useWorkAreaStore()
  const {
    hasChanges: hasPlanChanges,
    savePlan,
    error: planError,
    hasData: hasPlanData,
  } = useConstructionPlanStore()
  const { registrations: globalSaveRegs } = useGlobalSaveRegistry()

  // プロジェクト・工区ストア（現在の表示用）
  const { currentProject, projects, fetchProjects } = useProjectListStore()
  const fetchUserRoles = useProjectListStore((s) => s.fetchUserRoles)
  const { currentFarm, setCurrentFarm, farms, fetchFarms } = useFarmStore()

  // リロード時の復帰: currentProject/currentFarm は localStorage から復元されるが、
  // 一覧（projects/farms/userRoles）は揮発するため、座標系の解決や 権限判定のために取り直す。
  //
  // userRolesByProject を再取得しないと useProjectPermission が空 Map を参照し、
  // 全ページで 編集者権限を持つユーザーが 閲覧のみ扱い (readOnly=true) になる。
  // ProjectChooser 経由で入った時だけ機能する状態を修正する。
  useEffect(() => {
    if (projects.length === 0) fetchProjects()
    if (farms.length === 0) fetchFarms()
    void fetchUserRoles()
    // 初回マウント時のみ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)


  // 未保存の変更があるか（配管系統・工事区域・施工計画・登録されたページの変更も含む）
  const hasAnyUnsavedChanges =
    hasUnsavedChanges ||
    hasWiringChanges ||
    hasWorkAreaChanges ||
    hasPlanChanges ||
    hasAnyRegisteredChanges(globalSaveRegs)

  // 各ストアのエラーを集約
  const anyError = coordinateError || pipeError || wiringError || workAreaError || planError || saveError

  // 工区選択に戻る処理（現在の工事の工区一覧へ）
  // currentProject が分かっていればその工区一覧へ、無ければトップへフォールバック
  const handleGoToTop = () => {
    const targetPath = currentProject ? `/projects/${currentProject.id}` : '/'
    if (location.pathname === targetPath) {
      return
    }

    // 未保存データがある場合は確認
    if (hasAnyUnsavedChanges) {
      if (!confirm('未保存の変更があります。破棄して工区選択に戻りますか？')) {
        return
      }
    }

    // 状態をリセット（工区を選択なしに戻す）。currentProject は維持して工区一覧を引かせる
    setCurrentFarm(null)

    navigate(targetPath)
  }

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
        hasPlanData ? savePlan() : Promise.resolve(),
        runAllRegisteredSaves(globalSaveRegs),
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

  // 工事 → 工区 → 細部編集 の順で開く運用なので、工区が未選択のうちは
  // 左メニュー（黒いサイドバー）自体を出さない。工区を選んでから初めて表示する。
  const allowSidebar = !!currentFarm

  // ユーザー操作で折りたたみ可能。状態は localStorage に永続化。
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem('nodecloud_sidebar_collapsed') === '1'
  })
  const toggleSidebar = () => {
    setSidebarCollapsed((v) => {
      const next = !v
      try {
        window.localStorage.setItem('nodecloud_sidebar_collapsed', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
  }
  const showSidebar = allowSidebar && !sidebarCollapsed

  // 別ウィンドウ (?panel=...) で開かれた場合は ヘッダ / サイドバー を隠して
  // Outlet だけ全画面表示する。
  const isPopupPanel =
    typeof window !== 'undefined' &&
    !!new URLSearchParams(window.location.search).get('panel')
  if (isPopupPanel) {
    return (
      <div className="h-screen flex flex-col overflow-hidden">
        <Outlet />
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* 上部ヘッダー */}
      <header className="bg-slate-900 text-white border-b border-slate-700">
        <div className="px-4 py-3 flex items-center justify-between">
          {/* タイトル部分 */}
          <div className="flex items-center gap-3">
            {allowSidebar && (
              <button
                onClick={toggleSidebar}
                className="p-1.5 text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                title={sidebarCollapsed ? 'サイドバーを開く' : 'サイドバーを折りたたむ'}
              >
                {sidebarCollapsed ? (
                  <PanelLeftOpen className="h-5 w-5" />
                ) : (
                  <PanelLeftClose className="h-5 w-5" />
                )}
              </button>
            )}
            <div className="flex flex-col leading-none">
              <h1 className="text-xl font-bold">NodeCloud</h1>
              <span className="text-[10px] text-slate-500 mt-0.5">{__BUILD_TIME__}</span>
            </div>
            {/* スマホ画面へ切替（タイトル直右） */}
            <button
              type="button"
              onClick={() => {
                setDisplayModeOverride('mobile')
                navigate('/mobile')
              }}
              className="flex items-center gap-1 px-2 py-1 text-xs text-slate-300 hover:text-white hover:bg-slate-800 rounded border border-slate-700 transition-colors"
              title="スマホ画面へ切替"
            >
              <Smartphone className="h-3.5 w-3.5" />
              スマホ表示
            </button>
            {/* 現場名／工区番号 */}
            {(currentProject || currentFarm) && (
              <span className="text-sm flex items-center">
                {currentProject && (
                  <span className="text-slate-200 font-medium">{currentProject.name}</span>
                )}
                {currentFarm && (
                  <>
                    <span className="text-slate-500 mx-1">／</span>
                    <span className="text-slate-200 font-medium">{currentFarm.name}</span>
                  </>
                )}
              </span>
            )}
          </div>

          {/* 右側：ログイン情報 */}
          <div className="flex items-center gap-4">
            {/* 組織管理者 (サイトオーナーではない) 向け: 自組織のメンバー管理へ */}
            {!isAdmin(user?.email) && isOrgAdmin && (
              <Link
                to="/admin/organizations"
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                title="組織のメンバーを管理"
              >
                メンバー
              </Link>
            )}
            {/* サイトオーナー: 各種管理画面。組織・メンバーは統合済み */}
            {isAdmin(user?.email) && (
              <>
                <Link
                  to="/admin/organizations"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                  title="組織・メンバー管理"
                >
                  組織・メンバー
                </Link>
                <Link
                  to="/admin/signups"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                  title="申し込み管理"
                >
                  申込
                </Link>
                <Link
                  to="/admin/announcements"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                  title="お知らせ管理"
                >
                  お知らせ
                </Link>
                <Link
                  to="/admin/parcel-maps"
                  className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                  title="地番マップ (法務省地図)"
                >
                  地番マップ
                </Link>
              </>
            )}
            {/* 意見・要望メール */}
            <FeedbackButton variant="pc" />

            {/* 現場の地図を別ウィンドウで全画面表示 */}
            {currentFarm && (
              <button
                type="button"
                onClick={() => {
                  const url = `/site-map?farmId=${encodeURIComponent(currentFarm.id)}`
                  const screenW = window.screen.availWidth
                  const screenH = window.screen.availHeight
                  // 同じ target で開くことで、別の現場のウィンドウが残らず常に現在の現場に切り替わる
                  const w = window.open(
                    url,
                    'nodecloud_site_map',
                    `width=${screenW},height=${screenH},left=0,top=0`,
                  )
                  // 既存ウィンドウが開いていて URL が違う場合は明示的に navigate
                  if (w) {
                    try {
                      if (w.location.href.indexOf(url) === -1) {
                        w.location.href = url
                      }
                      w.focus()
                    } catch {
                      // cross-origin などの例外は無視
                    }
                  }
                }}
                className="flex items-center gap-2 px-3 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
                title="現場の地図を別ウィンドウで全画面表示"
              >
                <ExternalLink className="h-4 w-4" />
                地図ウィンドウ
              </button>
            )}

            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-slate-400" />
              {organizationName && (
                <span
                  className="text-sm text-slate-300"
                  title={`所属: ${organizationName}`}
                >
                  {organizationName}
                </span>
              )}
              {isOrgAdmin && (
                <span
                  className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-amber-500/20 text-amber-300 border border-amber-400/40"
                  title="この組織の管理者"
                >
                  管理者
                </span>
              )}
              <span className="text-sm text-slate-300" title={user?.email ?? ''}>{displayName}</span>
            </div>
            <UserMenu onSignOut={handleSignOut} isSiteOwner={isAdmin(user?.email)} />
          </div>
        </div>
      </header>

      {/* メインコンテンツ領域 */}
      <div className="flex-1 flex overflow-hidden">
        {/* サイドバー */}
        {showSidebar && (
          <aside className="w-64 bg-slate-900 text-white flex flex-col flex-shrink-0">
          {/* 保存ボタン */}
          <div className="p-4 border-b border-slate-700">
            <div className="p-2 bg-slate-800 rounded-lg">
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
          <ul className="space-y-1">
              {navigation
                .filter((item) =>
                  isNavVisibleForCategory(item.href, currentProject?.category ?? null),
                )
                .map((item) => {
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
                      item.name === '工区選択に戻る' ? (
                        <button
                          onClick={handleGoToTop}
                          className={cn(
                            'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left',
                            'text-slate-300 hover:bg-slate-800 hover:text-white'
                          )}
                        >
                          <item.icon className="h-5 w-5" />
                          {item.name}
                        </button>
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
                      )
                    )}
                </li>
              )
              })}
            </ul>
        </nav>
      </aside>
        )}

      {/* メインコンテンツ (min-w-0: 中身 の min-content で フレックス 幅 が
          膨張 しない よう 抑止。 実測記録 の 広い 表 等 が 横スクロール 化
          される だけ で 済む) */}
      <main className="flex-1 min-w-0 bg-slate-50 overflow-hidden">
        <Outlet />
      </main>
    </div>
  </div>
  )
}

/** ヘッダ右端のユーザーメニュー。個人設定 (登記情報、パスワード変更) と
 *  ログアウトをドロップダウンに集約する。 */
function UserMenu({ onSignOut, isSiteOwner }: { onSignOut: () => void; isSiteOwner: boolean }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1.5 text-sm text-slate-300 hover:text-white hover:bg-slate-800 rounded transition-colors"
        title="個人設定 / ログアウト"
      >
        <User className="h-4 w-4" />
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white text-slate-800 border border-slate-200 rounded-md shadow-lg z-[5000] overflow-hidden">
          {isSiteOwner && (
            <Link
              to="/settings/registry"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <KeyRound className="h-4 w-4 text-slate-500" />
              登記情報 (touki.or.jp)
            </Link>
          )}
          <Link
            to="/settings/password"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50"
          >
            <KeyRound className="h-4 w-4 text-slate-500" />
            パスワード変更
          </Link>
          <div className="border-t" />
          <button
            onClick={() => {
              setOpen(false)
              onSignOut()
            }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-700 hover:bg-red-50 text-left"
          >
            <LogOut className="h-4 w-4" />
            ログアウト
          </button>
        </div>
      )}
    </div>
  )
}
