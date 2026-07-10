import { useEffect, useState, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  Plus,
  Trash2,
  Loader2,
  MapPin,
  Navigation,
  X,
  ChevronDown,
  ChevronRight,
  Folder,
  Edit3,
  Users,
  UserPlus,
  UserMinus,
  Minimize2,
  Table as TableIcon,
  Check,
  ArrowLeft,
  Mail,
} from 'lucide-react'
import { MapContainer, TileLayer, Marker, Popup, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useFarmStore, type Farm, type FarmLocation } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { FarmEditModal, isoToDateInput, dateInputToIso } from '@/features/farms/FarmEditModal'
import { ProjectEditModal } from '@/features/projects/ProjectEditModal'
import {
  useWorkStatusStore,
  type WorkStatus,
  STATUS_LABEL,
} from '@/stores/workStatusStore'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { useAuth } from '@/contexts/AuthContext'
import type { Project, ProjectCategory, ProjectMemberRole } from '@/types/database'
import { PROJECT_CATEGORY_LABEL } from '@/types/database'

// 工種ごとのポリゴン色
const WORK_TYPE_COLORS: Record<string, string> = {
  boundary_survey: '#0ea5e9', // 境界測量: シアン
  underdrain: '#3b82f6',     // 暗渠工事: 青
  soil_import: '#f59e0b',    // 客土工事: オレンジ
  simple_grading: '#8b5cf6', // 簡易整地: 紫
  grading: '#10b981',        // 整地: 緑
  subsoil: '#ec4899',        // 心破土改: ピンク
  stone_removal: '#6b7280',  // 徐礫: グレー
}

// 工種名
const WORK_TYPE_NAMES: Record<string, string> = {
  boundary_survey: '境界測量',
  underdrain: '暗渠',
  soil_import: '客土',
  simple_grading: '簡易整地',
  grading: '整地',
  subsoil: '心土破砕',
  stone_removal: '除礫',
}

// 全工種リスト
const ALL_WORK_TYPES = ['boundary_survey', 'underdrain', 'soil_import', 'simple_grading', 'grading', 'subsoil', 'stone_removal'] as const

// カスタムマーカーアイコン
//   isSelected: 選択中 → 赤 + 大きめ
//   completed:  完了工区 → 緑 (未完了は青)
const createMarkerIcon = (isSelected = false, completed = false): L.DivIcon => {
  const bg = isSelected ? '#ef4444' : completed ? '#10b981' : '#3b82f6'
  const size = isSelected ? 28 : 20
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${bg};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 地図の境界を自動調整するコンポーネント
function FitBounds({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 })
    }
  }, [map, bounds])
  return null
}

// 選択した工区にフォーカス
function FocusOnFarm({ location }: { location: { lat: number; lng: number } | null }) {
  const map = useMap()
  useEffect(() => {
    if (location) {
      map.setView([location.lat, location.lng], 16, { animate: true })
    }
  }, [map, location])
  return null
}

export function ProjectListPage() {
  const navigate = useNavigate()
  const { projectId: routeProjectId } = useParams<{ projectId: string }>()
  const {
    farms: allFarms,
    loading: farmsLoading,
    error: farmsError,
    fetchFarms,
    createFarm,
    updateFarm,
    deleteFarm,
    setCurrentFarm,
    farmLocations,
    workAreaPolygons,
    fetchWorkAreaPolygons,
  } = useFarmStore()
  const {
    projects: allProjects,
    loading: projectsLoading,
    error: projectsError,
    fetchProjects,
    createProject,
    updateProject,
    deleteProject,
    members,
    membersLoading,
    fetchMembers,
    inviteMember,
    updateMemberRole,
    removeMember,
    fetchUserRoles,
    setCurrentProject,
  } = useProjectListStore()
  const { user: authUser } = useAuth()

  // URL の projectId に該当する工事だけに絞り込む
  const projects = useMemo(
    () => (routeProjectId ? allProjects.filter((p) => p.id === routeProjectId) : allProjects),
    [allProjects, routeProjectId],
  )
  const farms = useMemo(
    () => (routeProjectId ? allFarms.filter((f) => f.project_id === routeProjectId) : allFarms),
    [allFarms, routeProjectId],
  )

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [selectedFarm, setSelectedFarm] = useState<Farm | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)

  // 工種フィルター（表示する工種のSet）
  const [visibleWorkTypes, setVisibleWorkTypes] = useState<Set<string>>(new Set(ALL_WORK_TYPES))
  // (完了フィルタは hideCompletedFarms に統一 — 状態別チェックボックスは撤去)

  // (現在地の表示ボタンは工区一覧では不要になったため撤去)

  // 一覧拡大表示モード（デフォルト: 従来のツリー+地図）
  const [expandedList, setExpandedList] = useState(false)
  const [showNewFarmDialog, setShowNewFarmDialog] = useState<string | null>(null) // project_id
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [newProjectZone, setNewProjectZone] = useState(13)
  const [newFarmName, setNewFarmName] = useState('')
  const [newFarmDescription, setNewFarmDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [showMapDialog, setShowMapDialog] = useState<{ farm: Farm; location: FarmLocation } | null>(null)

  // プロジェクト編集モーダル (ProjectEditModal を呼ぶだけになったので state は 1 つ)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  // メンバー管理用state
  const [showMemberDialog, setShowMemberDialog] = useState<Project | null>(null)
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<ProjectMemberRole>('viewer')
  const [addingMember, setAddingMember] = useState(false)
  // 招待結果のフィードバック表示
  const [inviteFeedback, setInviteFeedback] = useState<{
    kind: 'invited' | 'added'
    email: string
  } | null>(null)

  const fetchStatuses = useWorkStatusStore((s) => s.fetchStatuses)
  const setWorkStatus = useWorkStatusStore((s) => s.setStatus)
  const statusByKey = useWorkStatusStore((s) => s.statusByKey)
  // 完了判定は farms.completed_at を真実の源とする
  const isFarmCompleted = (farmId: string): boolean => {
    const f = allFarms.find((x) => x.id === farmId)
    return f?.completed_at != null
  }
  // 一覧の右端 編集ボタンで開く 工区情報編集モーダル
  const [editFarmForModal, setEditFarmForModal] = useState<Farm | null>(null)
  // 完了工区を非表示にするかどうか (既定: 非表示)。設定は localStorage に保存
  const [hideCompletedFarms, setHideCompletedFarms] = useState<boolean>(() => {
    try { return localStorage.getItem('projects:hideCompletedFarms') !== '0' } catch { return true }
  })
  useEffect(() => {
    try {
      localStorage.setItem('projects:hideCompletedFarms', hideCompletedFarms ? '1' : '0')
    } catch { /* ignore */ }
  }, [hideCompletedFarms])

  useEffect(() => {
    fetchProjects()
    fetchFarms()
    fetchUserRoles()
  }, [fetchProjects, fetchFarms, fetchUserRoles])

  useEffect(() => {
    if (farms.length > 0) {
      fetchStatuses(farms.map((f) => f.id))
    }
  }, [farms, fetchStatuses])

  // (アクション選択ダイアログは撤去。工区クリックで直接工区編集へ遷移する)

  // 工区が読み込まれたらポリゴンデータを取得
  useEffect(() => {
    if (farms.length > 0) {
      fetchWorkAreaPolygons()
    }
  }, [farms, fetchWorkAreaPolygons])

  // 初期表示時に全プロジェクトを展開
  useEffect(() => {
    if (projects.length > 0 && expandedProjects.size === 0) {
      setExpandedProjects(new Set(projects.map((p) => p.id)))
    }
  }, [projects, expandedProjects.size])

  // 地図に出す対象の工区位置（routeProjectId があれば当該工事の工区だけ、無ければ全工区）
  const scopedFarmLocations = useMemo(() => {
    const locs: FarmLocation[] = []
    for (const f of farms) {
      const loc = farmLocations.get(f.id)
      if (loc) locs.push(loc)
    }
    return locs
  }, [farms, farmLocations])

  // 工区の位置情報から地図の境界を計算
  const allBounds = useMemo(() => {
    if (scopedFarmLocations.length === 0) return null
    const lats = scopedFarmLocations.map((loc) => loc.lat)
    const lngs = scopedFarmLocations.map((loc) => loc.lng)
    return L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)]
    )
  }, [scopedFarmLocations])

  // 地図の中心
  const mapCenter = useMemo(() => {
    if (scopedFarmLocations.length === 0) return { lat: 43.06, lng: 141.35 } // 北海道
    const avgLat = scopedFarmLocations.reduce((sum, loc) => sum + loc.lat, 0) / scopedFarmLocations.length
    const avgLng = scopedFarmLocations.reduce((sum, loc) => sum + loc.lng, 0) / scopedFarmLocations.length
    return { lat: avgLat, lng: avgLng }
  }, [scopedFarmLocations])

  // 選択された工区の位置
  const selectedFarmLocation = useMemo(() => {
    if (!selectedFarm) return null
    return farmLocations.get(selectedFarm.id) || null
  }, [selectedFarm, farmLocations])

  // 表示中の工事（routeProjectId 指定時のみ）
  const currentRouteProject = routeProjectId
    ? allProjects.find((p) => p.id === routeProjectId) ?? null
    : null
  const isCurrentProjectUncategorized =
    currentRouteProject != null && currentRouteProject.category == null
  // 地籍測量モード: 工種が境界測量のみなので一覧表 / 工種フィルターを出さず、
  // 代わりに状態（未着手・進行中・完了）でフィルターする
  const isCadastral = currentRouteProject?.category === 'cadastral'

  // フィルタリングされたポリゴン
  // - 共通: 当該工事の工区のみ
  // - 地籍測量モード: 状態フィルタ（未着手・進行中・完了）で絞る
  // - それ以外: 工種フィルタで絞る
  const filteredPolygons = useMemo(() => {
    const farmIdSet = new Set(farms.map((f) => f.id))
    // 完了工区は farms.completed_at で判定 (単一トグル hideCompletedFarms に連動)
    const completedFarmIds = new Set(
      farms.filter((f) => f.completed_at != null).map((f) => f.id),
    )
    return workAreaPolygons.filter((p) => {
      if (!farmIdSet.has(p.farmId)) return false
      if (hideCompletedFarms && completedFarmIds.has(p.farmId)) return false
      if (!isCadastral && !visibleWorkTypes.has(p.workType)) return false
      return true
    })
  }, [workAreaPolygons, visibleWorkTypes, farms, isCadastral, hideCompletedFarms])

  // 工区ごとの工種別面積を計算（ポップアップ用）
  const farmWorkAreaSummary = useMemo(() => {
    const summary: Record<string, Record<string, number>> = {}
    for (const polygon of workAreaPolygons) {
      if (!summary[polygon.farmId]) {
        summary[polygon.farmId] = {}
      }
      // ポリゴンの面積を計算（簡易計算：ラジアンベースの球面幾何）
      const positions = polygon.positions
      if (positions.length >= 3) {
        // Shoelace公式で面積計算（緯度経度から概算）
        let area = 0
        for (let i = 0; i < positions.length; i++) {
          const [lat1, lng1] = positions[i]
          const [lat2, lng2] = positions[(i + 1) % positions.length]
          area += lng1 * lat2 - lng2 * lat1
        }
        area = Math.abs(area) / 2
        // 緯度経度から平方メートルに変換（北海道付近の概算係数）
        const metersPerDegree = 111000 // 緯度1度 ≈ 111km
        const areaM2 = area * metersPerDegree * metersPerDegree * Math.cos((positions[0][0] * Math.PI) / 180)
        const areaHa = areaM2 / 10000

        if (!summary[polygon.farmId][polygon.workType]) {
          summary[polygon.farmId][polygon.workType] = 0
        }
        summary[polygon.farmId][polygon.workType] += areaHa
      }
    }
    return summary
  }, [workAreaPolygons])

  // 工種フィルターの切り替え
  const toggleWorkType = (workType: string) => {
    setVisibleWorkTypes(prev => {
      const next = new Set(prev)
      if (next.has(workType)) {
        next.delete(workType)
      } else {
        next.add(workType)
      }
      return next
    })
  }

  const toggleProject = (projectId: string) => {
    setExpandedProjects((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(projectId)) {
        newSet.delete(projectId)
      } else {
        newSet.add(projectId)
      }
      return newSet
    })
  }

  const handleCreateProject = async () => {
    if (!newProjectName.trim()) return
    setCreating(true)
    const project = await createProject(newProjectName, newProjectDescription, newProjectZone)
    setCreating(false)
    if (project) {
      setShowNewProjectDialog(false)
      setNewProjectName('')
      setNewProjectDescription('')
      setNewProjectZone(13)
      setExpandedProjects((prev) => new Set([...prev, project.id]))
    }
  }

  const handleCreateFarm = async () => {
    if (!newFarmName.trim() || !showNewFarmDialog) return
    setCreating(true)
    const farm = await createFarm(showNewFarmDialog, newFarmName, newFarmDescription)
    setCreating(false)
    if (farm) {
      setShowNewFarmDialog(null)
      setNewFarmName('')
      setNewFarmDescription('')
    }
  }

  const handleSelectFarm = (farm: Farm) => {
    setSelectedFarm(farm)
  }

  // 種別選択ダイアログの保留情報。
  // - openAfter があれば、分類後にその工区を開く（現場へ進む）
  // - openAfter が無ければ、分類だけ行う（工区が無い工事でも使える）
  const [categoryPrompt, setCategoryPrompt] = useState<
    { projectId: string; openAfter?: Farm } | null
  >(null)

  const handleOpenFarm = (farm: Farm) => {
    const proj = allProjects.find((p) => p.id === farm.project_id)
    // 未分類の工事は、ここで種別（地籍測量 / 土木工事）を決めてもらう
    if (proj && proj.category == null) {
      setCategoryPrompt({ projectId: proj.id, openAfter: farm })
      return
    }
    // ヘッダー表示・リロード復帰のため、所属する工事も記憶しておく
    if (proj) setCurrentProject(proj)
    setCurrentFarm(farm)
    navigate('/coordinates')
  }

  // バナーから「種別を選択」を押したとき: 工区が無くても分類だけ行える
  const handleClassifyProject = (projectId: string) => {
    setCategoryPrompt({ projectId })
  }

  // 種別選択ダイアログで「決定」されたとき
  const handleConfirmPendingCategory = async (category: ProjectCategory) => {
    const prompt = categoryPrompt
    if (!prompt) return
    const proj = allProjects.find((p) => p.id === prompt.projectId)
    if (!proj) {
      setCategoryPrompt(null)
      return
    }
    await updateProject(proj.id, { category })
    setCategoryPrompt(null)
    // openAfter があればそのまま現場へ、無ければこの画面に留まる
    if (prompt.openAfter) {
      setCurrentProject({ ...proj, category })
      setCurrentFarm(prompt.openAfter)
      navigate('/coordinates')
    }
  }

  const handleDeleteProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const farmsInProject = farms.filter((f) => f.project_id === id)
    const msg =
      farmsInProject.length > 0
        ? `このプロジェクトには ${farmsInProject.length} 個の工区があります。\nゴミ箱へ移動しますか？\n\n7 日以内なら「ゴミ箱」から復元できます。\n7 日を超えると完全削除されます。`
        : 'このプロジェクトをゴミ箱へ移動しますか？\n\n7 日以内なら「ゴミ箱」から復元できます。\n7 日を超えると完全削除されます。'
    if (!confirm(msg)) return
    await deleteProject(id)
    fetchFarms()
  }

  const openGoogleMapsNavigation = (lat: number, lng: number) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    window.open(url, '_blank')
  }

  // プロジェクト編集モーダルを開く (実際の編集 UI は ProjectEditModal 側)
  const handleOpenEditDialog = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setEditingProject(project)
  }

  // メンバー管理ダイアログを開く
  const handleOpenMemberDialog = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setShowMemberDialog(project)
    fetchMembers(project.id)
  }

  // メンバー招待（招待リンクをメール送信。既存ユーザーなら即追加）
  const handleAddMember = async () => {
    if (!showMemberDialog || !newMemberEmail.trim()) return
    setAddingMember(true)
    setInviteFeedback(null)
    const result = await inviteMember(showMemberDialog.id, newMemberEmail.trim(), newMemberRole)
    setAddingMember(false)
    if (result.ok) {
      setInviteFeedback({
        kind: result.mode === 'added_existing' ? 'added' : 'invited',
        email: newMemberEmail.trim(),
      })
      setNewMemberEmail('')
      setNewMemberRole('viewer')
    }
  }

  // メンバーロール変更
  const handleUpdateMemberRole = async (memberId: string, role: ProjectMemberRole) => {
    await updateMemberRole(memberId, role)
  }

  // メンバー削除
  const handleRemoveMember = async (memberId: string) => {
    if (confirm('このメンバーをプロジェクトから削除しますか？')) {
      await removeMember(memberId)
    }
  }

  const getFarmsForProject = (projectId: string) => {
    const all = farms.filter((f) => f.project_id === projectId)
    if (!hideCompletedFarms) return all
    // 「完了」の farm_work_status が 1 件でもある工区は完了扱いとして隠す
    return all.filter((f) => !isFarmCompleted(f.id))
  }

  const loading = projectsLoading || farmsLoading
  const error = projectsError || farmsError

  if (loading && projects.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
        <span className="ml-2 text-muted-foreground">読み込み中...</span>
      </div>
    )
  }

  // 地籍測量モードに切り替わったら拡大表示は強制的に閉じる
  useEffect(() => {
    if (isCadastral) setExpandedList(false)
  }, [isCadastral])

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="p-3 bg-red-50 border-b border-red-200 text-sm text-red-600">
          {error}
        </div>
      )}

      {isCurrentProjectUncategorized && currentRouteProject && (
        <div className="px-3 py-2 bg-amber-50 border-b border-amber-200 text-xs text-amber-800 flex items-center gap-2">
          <span className="flex-1">
            この工事の種別が未設定です。種別を設定すると左メニューが工事に合った内容になります。
          </span>
          <button
            onClick={() => handleClassifyProject(currentRouteProject.id)}
            className="px-3 py-1 text-xs bg-amber-600 text-white rounded hover:bg-amber-700"
          >
            種別を選択
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {expandedList ? (
        /* 左半分: 工区一覧表 */
        <div className="w-1/2 border-r flex flex-col overflow-hidden">
          <ExpandedProjectTable
            projects={projects}
            farms={farms}
            farmWorkAreaSummary={farmWorkAreaSummary}
            statusByKey={statusByKey}
            onSetStatus={setWorkStatus}
            onClose={() => setExpandedList(false)}
            onSelectFarm={(farm) => handleOpenFarm(farm)}
            onNewProject={() => setShowNewProjectDialog(true)}
          />
        </div>
        ) : (
        /* 左側: プロジェクト・工区ツリー */
        <div className="w-80 border-r bg-white flex flex-col overflow-hidden">
          {/* ヘッダー */}
          <div className="p-3 border-b flex items-center justify-between gap-1">
            {routeProjectId ? (
              <button
                onClick={() => navigate('/')}
                className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
                title="工事一覧に戻る"
              >
                <ArrowLeft className="h-3 w-3" />
                工事一覧
              </button>
            ) : (
              <span className="font-medium text-sm">プロジェクト</span>
            )}
            <div className="flex items-center gap-1">
              {/* 地籍測量は工種が境界測量のみで一覧表の意義が薄いので非表示 */}
              {!isCadastral && (
                <button
                  onClick={() => setExpandedList(true)}
                  className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
                  title="一覧表表示に切り替え"
                >
                  <TableIcon className="h-3 w-3" />
                  一覧表
                </button>
              )}
              {!routeProjectId && (
                <button
                  onClick={() => setShowNewProjectDialog(true)}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                >
                  <Plus className="h-3 w-3" />
                  追加
                </button>
              )}
            </div>
          </div>

          {/* ツリー表示 */}
          <div className="flex-1 overflow-auto p-2">
            {projects.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                プロジェクトがありません
              </div>
            ) : (
              <div className="space-y-1">
                {projects.map((project) => {
                  const projectFarms = getFarmsForProject(project.id)
                  const isExpanded = expandedProjects.has(project.id)

                  return (
                    <div key={project.id}>
                      {/* プロジェクト行 */}
                      <div className="flex items-center gap-1 group">
                        <button
                          onClick={() => toggleProject(project.id)}
                          className="p-1 hover:bg-slate-100 rounded"
                        >
                          {isExpanded ? (
                            <ChevronDown className="h-4 w-4 text-slate-500" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-slate-500" />
                          )}
                        </button>
                        <Folder className="h-4 w-4 text-blue-500 flex-shrink-0" />
                        <span
                          className="flex-1 text-sm truncate cursor-pointer hover:text-blue-600"
                          onClick={() => toggleProject(project.id)}
                          title={project.name}
                        >
                          {project.name}
                        </span>
                        <span className="text-xs text-muted-foreground mr-1">
                          {projectFarms.length}
                        </span>
                        <div className="hidden group-hover:flex items-center">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setShowNewFarmDialog(project.id)
                            }}
                            className="p-1 text-green-600 hover:bg-green-50 rounded"
                            title="工区追加"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => handleOpenMemberDialog(e, project)}
                            className="p-1 text-slate-400 hover:text-blue-500 hover:bg-blue-50 rounded"
                            title="メンバー"
                          >
                            <Users className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => handleOpenEditDialog(e, project)}
                            className="p-1 text-slate-400 hover:text-blue-500 hover:bg-blue-50 rounded"
                            title="編集"
                          >
                            <Edit3 className="h-3 w-3" />
                          </button>
                          <button
                            onClick={(e) => handleDeleteProject(e, project.id)}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                            title="削除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>

                      {/* 工区一覧 */}
                      {isExpanded && (
                        <div className="ml-5 mt-1 space-y-0.5">
                          {projectFarms.length === 0 ? (
                            <div className="text-xs text-muted-foreground py-2 pl-5">
                              工区なし
                            </div>
                          ) : (
                            projectFarms.map((farm) => {
                              const isSelected = selectedFarm?.id === farm.id
                              const done = farm.completed_at != null
                              return (
                                <div
                                  key={farm.id}
                                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group ${
                                    done
                                      ? 'bg-emerald-50 hover:bg-emerald-100'
                                      : isSelected
                                        ? 'bg-blue-100 text-blue-700'
                                        : 'hover:bg-slate-100'
                                  }`}
                                >
                                  {/* 左端: 完了チェックボックス (工区ナビゲーションを阻止) */}
                                  <input
                                    type="checkbox"
                                    checked={done}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => {
                                      e.stopPropagation()
                                      void updateFarm(farm.id, {
                                        completed_at: e.target.checked ? new Date().toISOString() : null,
                                      })
                                    }}
                                    className="h-4 w-4 flex-shrink-0"
                                    title={done ? '完了' : '未完了'}
                                  />
                                  <span
                                    onClick={() => {
                                      handleSelectFarm(farm)
                                      handleOpenFarm(farm)
                                    }}
                                    className="flex-1 text-sm truncate"
                                    title={`${farm.name} — クリックで工区編集を開く`}
                                  >
                                    {farm.name}
                                  </span>
                                  {/* 右端: 編集 / 削除ボタン (ホバー時のみ表示) */}
                                  <div className="hidden group-hover:flex items-center gap-1">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setEditFarmForModal(farm)
                                      }}
                                      className="p-1 text-slate-400 hover:text-blue-500 hover:bg-blue-50 rounded"
                                      title="工区情報を編集 (削除もここから)"
                                    >
                                      <Edit3 className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                              )
                            })
                          )}
                          {/* 新規工区ボタン */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setShowNewFarmDialog(project.id)
                            }}
                            className="flex items-center gap-2 px-2 py-1.5 w-full text-left text-xs text-green-600 hover:bg-green-50 rounded"
                          >
                            <Plus className="h-3 w-3" />
                            新規工区を追加
                          </button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

        </div>
        )}

        {/* 右側: 地図（一覧表示モード共通） */}
        <div className="flex-1 bg-slate-100 flex flex-col">
          {/* 凡例（地籍測量モードは状態フィルター、それ以外は工種フィルター） */}
          <div className="p-3 bg-white border-b flex flex-wrap gap-4 items-center">
            {isCadastral ? null : (
              <>
                <span className="text-sm font-medium text-muted-foreground">工種:</span>
                {ALL_WORK_TYPES.map(workType => (
                  <label
                    key={workType}
                    className="flex items-center gap-2 cursor-pointer text-sm px-2 py-1 rounded hover:bg-slate-50"
                  >
                    <input
                      type="checkbox"
                      checked={visibleWorkTypes.has(workType)}
                      onChange={() => toggleWorkType(workType)}
                      className="h-4 w-4"
                    />
                    <span
                      className="w-4 h-4 rounded"
                      style={{ backgroundColor: WORK_TYPE_COLORS[workType] }}
                    />
                    <span className="font-medium">{WORK_TYPE_NAMES[workType]}</span>
                  </label>
                ))}
              </>
            )}
            {/* 完了工区の表示 ON/OFF (一覧・地図の両方に効く単一トグル) */}
            <button
              type="button"
              onClick={() => setHideCompletedFarms((v) => !v)}
              className={`ml-auto flex items-center gap-1 px-2 py-1 text-sm rounded border ${
                !hideCompletedFarms
                  ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
              title={
                hideCompletedFarms
                  ? '完了工区を表示する (一覧・地図とも)'
                  : '完了工区を非表示にする (一覧・地図とも)'
              }
            >
              <Check className="h-4 w-4" />
              完了を表示
            </button>
          </div>

          {farmLocations.size === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <MapPin className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>位置情報のある工区がありません</p>
                <p className="text-sm mt-1">座標を登録すると地図に表示されます</p>
              </div>
            </div>
          ) : (
            <MapContainer
              center={[mapCenter.lat, mapCenter.lng]}
              zoom={10}
              className="flex-1 w-full"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {!selectedFarm && allBounds && <FitBounds bounds={allBounds} />}
              {selectedFarm && selectedFarmLocation && (
                <FocusOnFarm location={selectedFarmLocation} />
              )}
              {/* 工事区域ポリゴン（地籍測量モードでは非表示。マーカー + 名称だけにする） */}
              {!isCadastral && filteredPolygons.map((polygon) => (
                <Polygon
                  key={polygon.id}
                  positions={polygon.positions}
                  pathOptions={{
                    color: WORK_TYPE_COLORS[polygon.workType] || '#22c55e',
                    fillColor: WORK_TYPE_COLORS[polygon.workType] || '#22c55e',
                    fillOpacity: 0.3,
                    weight: 2,
                  }}
                />
              ))}
              {/* 工区マーカー（地籍測量モードでは状態フィルタで絞り込み） */}
              {farms.map((farm) => {
                const location = farmLocations.get(farm.id)
                if (!location) return null
                // 完了工区は 「完了を表示」トグル OFF のときマップからも除外
                if (hideCompletedFarms && farm.completed_at != null) return null
                const isSelected = selectedFarm?.id === farm.id
                const areaSummary = farmWorkAreaSummary[farm.id] || {}

                return (
                  <Marker
                    key={farm.id}
                    position={[location.lat, location.lng]}
                    icon={createMarkerIcon(isSelected, farm.completed_at != null)}
                    eventHandlers={{
                      click: () => handleSelectFarm(farm),
                      dblclick: () => handleOpenFarm(farm),
                    }}
                  >
                    <Tooltip permanent direction="top" offset={[0, -15]} className="farm-label-tooltip">
                      {farm.name}
                    </Tooltip>
                    <Popup>
                      <FarmMarkerPopup
                        farm={farm}
                        areaSummary={areaSummary}
                        onUpdateFarm={(patch) => void updateFarm(farm.id, patch)}
                        onOpen={() => handleOpenFarm(farm)}
                      />
                    </Popup>
                  </Marker>
                )
              })}
            </MapContainer>
          )}
        </div>
      </div>

      {/* 地図表示ダイアログ */}
      {showMapDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000] p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-4 border-b">
              <div>
                <h2 className="text-lg font-bold">{showMapDialog.farm.name}</h2>
                <p className="text-sm text-muted-foreground">
                  先頭座標: {showMapDialog.location.pointNumber}
                </p>
              </div>
              <button
                onClick={() => setShowMapDialog(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 min-h-[300px] h-[50vh]">
              <MapContainer
                center={[showMapDialog.location.lat, showMapDialog.location.lng]}
                zoom={16}
                className="h-full w-full"
              >
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Marker
                  position={[showMapDialog.location.lat, showMapDialog.location.lng]}
                  icon={createMarkerIcon(true)}
                >
                  <Popup>
                    <div className="text-sm">
                      <div className="font-bold">{showMapDialog.farm.name}</div>
                      <div className="text-muted-foreground">{showMapDialog.location.pointNumber}</div>
                    </div>
                  </Popup>
                </Marker>
              </MapContainer>
            </div>

            <div className="p-4 border-t flex flex-col sm:flex-row gap-2">
              <button
                onClick={() => openGoogleMapsNavigation(showMapDialog.location.lat, showMapDialog.location.lng)}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-medium"
              >
                <Navigation className="h-5 w-5" />
                Google Mapsで経路探索
              </button>
              <button
                onClick={() => setShowMapDialog(null)}
                className="px-4 py-3 border rounded-lg hover:bg-slate-50 transition-colors text-sm"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新規プロジェクトダイアログ */}
      {showNewProjectDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
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
                  placeholder="例: 〇〇地区工区整備工事"
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
                onClick={() => setShowNewProjectDialog(false)}
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

      {/* 工区情報編集モーダル (サイドバー右端の 編集ボタンで開く) */}
      {editFarmForModal && (
        <FarmEditModal
          farm={
            allFarms.find((f) => f.id === editFarmForModal.id) ?? editFarmForModal
          }
          onUpdateFarm={(patch) => void updateFarm(editFarmForModal.id, patch)}
          onClose={() => setEditFarmForModal(null)}
          onDelete={async () => {
            const id = editFarmForModal.id
            setEditFarmForModal(null)
            try {
              await deleteFarm(id)
              if (selectedFarm?.id === id) setSelectedFarm(null)
            } catch (err) {
              alert(err instanceof Error ? err.message : '工区の削除に失敗しました')
            }
          }}
        />
      )}

      {/* 新規工区ダイアログ */}
      {showNewFarmDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold mb-4">新規工区</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">工区名 *</label>
                <input
                  type="text"
                  value={newFarmName}
                  onChange={(e) => setNewFarmName(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例: 1-1"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">説明</label>
                <textarea
                  value={newFarmDescription}
                  onChange={(e) => setNewFarmDescription(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={2}
                  placeholder="工区の説明（任意）"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => setShowNewFarmDialog(null)}
                className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleCreateFarm}
                disabled={!newFarmName.trim() || creating}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                作成
              </button>
            </div>
          </div>
        </div>
      )}

      {/* プロジェクト編集モーダル: ProjectChooserPage と共有 (共有者も編集可) */}
      {editingProject && (
        <ProjectEditModal
          project={
            allProjects.find((p) => p.id === editingProject.id) ?? editingProject
          }
          onSave={async (patch) => {
            await updateProject(editingProject.id, patch)
          }}
          onClose={() => setEditingProject(null)}
          onDelete={async () => {
            const id = editingProject.id
            setEditingProject(null)
            await deleteProject(id)
            fetchFarms()
          }}
        />
      )}

      {/* メンバー管理ダイアログ */}
      {showMemberDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">メンバー管理</h2>
              <button
                onClick={() => {
                  setShowMemberDialog(null)
                  setInviteFeedback(null)
                }}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{showMemberDialog.name}</p>

            {/* メンバー招待フォーム */}
            <div className="border rounded-lg p-4 mb-4 bg-slate-50">
              <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                メンバーを招待
              </h3>
              <p className="text-xs text-slate-500 mb-3">
                招待リンクをメールで送信します。受け取った人がリンクから自分でパスワードを設定すると、自動的にこのプロジェクトに参加します。
              </p>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">メールアドレス</label>
                  <input
                    type="email"
                    value={newMemberEmail}
                    onChange={(e) => setNewMemberEmail(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                    placeholder="user@example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs text-muted-foreground mb-1">権限</label>
                  <select
                    value={newMemberRole}
                    onChange={(e) => setNewMemberRole(e.target.value as ProjectMemberRole)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  >
                    <option value="viewer">閲覧者（viewer）</option>
                    <option value="editor">編集者（editor）</option>
                  </select>
                </div>
                <button
                  onClick={handleAddMember}
                  disabled={!newMemberEmail.trim() || addingMember}
                  className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {addingMember && <Loader2 className="h-4 w-4 animate-spin" />}
                  招待を送る
                </button>
                {inviteFeedback && (
                  <div className="p-2 bg-emerald-50 border border-emerald-200 rounded text-xs text-emerald-700">
                    {inviteFeedback.kind === 'invited'
                      ? `招待メールを ${inviteFeedback.email} に送信しました。受信者がリンクを踏んでパスワード設定するとメンバーに加わります。`
                      : `${inviteFeedback.email} は既に登録済みだったため、メンバーに追加しました。`}
                  </div>
                )}
              </div>
            </div>

            {/* メンバー一覧 */}
            <div>
              <div className="flex items-center justify-between mb-3 gap-2">
                <h3 className="text-sm font-medium flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  現在のメンバー
                </h3>
                {(() => {
                  // 自分以外のメンバー（email あり）に mailto: でまとめて送る。
                  // 件名 = "NodeCloud: {業務名}"、本文先頭に業務 URL を入れる。
                  const recipients = members
                    .map((m) => m.email)
                    .filter((e): e is string => !!e && e !== authUser?.email)
                  const disabled = recipients.length === 0 || !showMemberDialog
                  const handleMailAll = () => {
                    if (!showMemberDialog || recipients.length === 0) return
                    const projectUrl = `${window.location.origin}/projects/${showMemberDialog.id}`
                    const subject = `NodeCloud: ${showMemberDialog.name}`
                    const body =
                      `NodeCloud の業務「${showMemberDialog.name}」についてご連絡します。\n\n` +
                      `業務 URL: ${projectUrl}\n\n` +
                      `---\nこのメールは NodeCloud から共有メンバー宛に下書きされました。\n`
                    const href =
                      `mailto:${recipients.join(',')}` +
                      `?subject=${encodeURIComponent(subject)}` +
                      `&body=${encodeURIComponent(body)}`
                    window.location.href = href
                  }
                  return (
                    <button
                      type="button"
                      onClick={handleMailAll}
                      disabled={disabled}
                      title={
                        disabled
                          ? '送信先のメールアドレスがありません'
                          : `${recipients.length} 件のアドレス宛にメール下書きを開きます`
                      }
                      className="flex items-center gap-1 px-2.5 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Mail className="h-3.5 w-3.5" />
                      全員にメール
                      {recipients.length > 0 && (
                        <span className="text-[10px] text-slate-500">
                          ({recipients.length})
                        </span>
                      )}
                    </button>
                  )
                })()}
              </div>
              {membersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
                </div>
              ) : members.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  メンバーがいません
                </div>
              ) : (
                <div className="space-y-2">
                  {members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center justify-between p-3 border rounded-lg bg-white"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate" title={member.email ?? undefined}>
                          {member.display_name || member.email || member.user_id}
                        </div>
                        {member.display_name && member.email && (
                          <div className="text-[11px] text-slate-500 truncate">{member.email}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          {member.role === 'owner' && 'オーナー'}
                          {member.role === 'editor' && '編集者'}
                          {member.role === 'viewer' && '閲覧者'}
                        </div>
                      </div>
                      {member.role !== 'owner' && (
                        <div className="flex items-center gap-2">
                          <select
                            value={member.role}
                            onChange={(e) =>
                              handleUpdateMemberRole(member.id, e.target.value as ProjectMemberRole)
                            }
                            className="px-2 py-1 border rounded text-xs"
                          >
                            <option value="viewer">閲覧者</option>
                            <option value="editor">編集者</option>
                          </select>
                          <button
                            onClick={() => handleRemoveMember(member.id)}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                            title="削除"
                          >
                            <UserMinus className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 未分類工事の種別選択ダイアログ。
          openAfter 付き: 工区を開くフロー中（分類後そのまま現場へ）
          openAfter 無し: バナーから「種別を選択」を押したとき（分類のみ） */}

      {categoryPrompt && (() => {
        const proj = allProjects.find((p) => p.id === categoryPrompt.projectId)
        return (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
            <div className="bg-white rounded-lg p-5 w-full max-w-md">
              <h3 className="text-base font-semibold mb-1">工事種別の選択</h3>
              <div className="text-xs text-slate-500 mb-4">
                {proj?.name ?? '(工事)'} の種別が未設定です。地籍測量と土木工事のどちらかを選んでください。
                左メニューに表示される機能が種別ごとに切り替わります（後から変更も可）。
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                {(['cadastral', 'civil'] as const).map((c) => (
                  <button
                    key={c}
                    onClick={() => handleConfirmPendingCategory(c)}
                    className="border rounded-lg p-4 hover:border-blue-400 hover:bg-blue-50 text-center transition-colors"
                  >
                    <div className="text-base font-semibold text-slate-800">
                      {PROJECT_CATEGORY_LABEL[c]}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1">
                      {c === 'cadastral'
                        ? '境界測量・座標管理など'
                        : '暗渠・客土・整地など'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex justify-end">
                <button
                  onClick={() => setCategoryPrompt(null)}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// 状態のスタイル (2 値)
const STATUS_STYLE: Record<WorkStatus, { wrap: string; icon: React.ReactNode | null }> = {
  not_started: { wrap: '', icon: null },
  completed: {
    wrap: 'bg-emerald-50 text-emerald-700',
    icon: <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={3} />,
  },
}

// 工区×工種の面積セル（状態マーク付き、右クリックで状態選択メニュー）
// 工区マーカーの Popup 内で 説明 / 進捗 / 着手日 / 完了日 を編集できる小コンポーネント
function FarmMarkerPopup({
  farm,
  areaSummary,
  onUpdateFarm,
  onOpen,
}: {
  farm: Farm
  areaSummary: Record<string, number>
  onUpdateFarm: (patch: Partial<Pick<Farm, 'description' | 'started_at' | 'completed_at'>>) => void
  onOpen: () => void
}) {
  const [description, setDescription] = useState(farm.description ?? '')
  const [startedAt, setStartedAt] = useState<string>(isoToDateInput(farm.started_at))
  const [completedAt, setCompletedAt] = useState<string>(isoToDateInput(farm.completed_at))

  useEffect(() => {
    setDescription(farm.description ?? '')
    setStartedAt(isoToDateInput(farm.started_at))
    setCompletedAt(isoToDateInput(farm.completed_at))
  }, [farm.id, farm.description, farm.started_at, farm.completed_at])

  const commitDescription = () => {
    const v = description.trim()
    const prev = farm.description ?? ''
    if (v !== prev) onUpdateFarm({ description: v || null })
  }
  const commitStartedAt = () => {
    const iso = dateInputToIso(startedAt)
    if (iso !== farm.started_at) onUpdateFarm({ started_at: iso })
  }
  const commitCompletedAt = () => {
    const iso = dateInputToIso(completedAt)
    if (iso !== farm.completed_at) onUpdateFarm({ completed_at: iso })
  }

  const isCompleted = farm.completed_at != null

  return (
    <div className="text-sm min-w-[240px]">
      <div className="font-bold text-base mb-1">{farm.name}</div>

      {/* 説明 (テキストエリア、blur で保存) */}
      <div className="mb-2">
        <div className="text-[10px] text-slate-500 mb-0.5">説明</div>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={commitDescription}
          placeholder="任意"
          className="w-full px-1.5 py-1 border rounded text-xs h-12 resize-none"
        />
      </div>

      {/* 進捗 / 着手日 / 完了日 */}
      <div className="border-t pt-2 mb-2 space-y-1 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-slate-500 w-12">進捗</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={isCompleted}
              onChange={(e) => {
                if (e.target.checked) {
                  const iso = farm.completed_at ?? new Date().toISOString()
                  onUpdateFarm({ completed_at: iso })
                  setCompletedAt(isoToDateInput(iso))
                } else {
                  onUpdateFarm({ completed_at: null })
                  setCompletedAt('')
                }
              }}
              className="h-3.5 w-3.5"
            />
            {isCompleted ? (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 font-medium">
                <Check className="h-3 w-3" strokeWidth={3} />
                完了
              </span>
            ) : (
              <span className="text-slate-600 font-medium">未完了</span>
            )}
          </label>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-500 w-12">着手日</span>
          <input
            type="date"
            value={startedAt}
            onChange={(e) => setStartedAt(e.target.value)}
            onBlur={commitStartedAt}
            className="flex-1 px-1.5 py-0.5 border rounded text-xs font-mono"
          />
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-500 w-12">完了日</span>
          <input
            type="date"
            value={completedAt}
            onChange={(e) => setCompletedAt(e.target.value)}
            onBlur={commitCompletedAt}
            disabled={!isCompleted}
            className="flex-1 px-1.5 py-0.5 border rounded text-xs font-mono disabled:bg-slate-50 disabled:text-slate-400"
          />
        </div>
      </div>

      {/* 工種別面積 */}
      {Object.keys(areaSummary).length > 0 && (
        <div className="border-t pt-2 mb-2">
          <div className="text-xs font-semibold mb-1">施工面積</div>
          {ALL_WORK_TYPES.map((wt) => {
            const area = areaSummary[wt]
            if (!area) return null
            return (
              <div key={wt} className="flex items-center gap-2 text-xs">
                <span
                  className="w-2 h-2 rounded-sm flex-shrink-0"
                  style={{ backgroundColor: WORK_TYPE_COLORS[wt] }}
                />
                <span className="flex-1">{WORK_TYPE_NAMES[wt]}</span>
                <span className="font-mono">{area.toFixed(2)} ha</span>
              </div>
            )
          })}
        </div>
      )}

      <button
        onClick={onOpen}
        className={`mt-2 px-3 py-1.5 text-xs text-white rounded w-full ${
          isCompleted
            ? 'bg-emerald-600 hover:bg-emerald-700'
            : 'bg-primary hover:bg-primary/90'
        }`}
      >
        工区編集を開く
      </button>
    </div>
  )
}

function StatusAreaCell({
  area,
  status,
  onContextMenu,
}: {
  area: number
  status: WorkStatus
  onContextMenu: (e: React.MouseEvent) => void
}) {
  if (area <= 0) {
    return (
      <td className="px-2 py-1.5 border-b border-r text-right font-mono text-slate-300">—</td>
    )
  }
  const style = STATUS_STYLE[status]
  return (
    <td
      className={`px-2 py-1.5 border-b border-r font-mono text-slate-700 cursor-context-menu ${style.wrap}`}
      onContextMenu={onContextMenu}
      title={`${STATUS_LABEL[status]}（右クリックで変更）`}
    >
      <div className="flex items-center justify-end gap-1">
        {style.icon}
        <span>{area.toFixed(2)}</span>
      </div>
    </td>
  )
}

// 状態選択コンテキストメニュー
function StatusContextMenu({
  x,
  y,
  current,
  onSelect,
  onClose,
}: {
  x: number
  y: number
  current: WorkStatus
  onSelect: (status: WorkStatus) => void
  onClose: () => void
}) {
  useEffect(() => {
    const handler = () => onClose()
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // 次の tick で登録（メニュー開いた直後の click を拾わない）
    const t = setTimeout(() => {
      window.addEventListener('click', handler)
      window.addEventListener('contextmenu', handler)
      window.addEventListener('keydown', escHandler)
    }, 0)
    return () => {
      clearTimeout(t)
      window.removeEventListener('click', handler)
      window.removeEventListener('contextmenu', handler)
      window.removeEventListener('keydown', escHandler)
    }
  }, [onClose])

  // 画面端ではみ出さないよう調整
  const left = Math.min(x, window.innerWidth - 180)
  const top = Math.min(y, window.innerHeight - 140)

  const items: WorkStatus[] = ['not_started', 'completed']
  return (
    <div
      className="fixed bg-white shadow-xl rounded-md border z-[2000] py-1 min-w-[160px]"
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((s) => {
        const style = STATUS_STYLE[s]
        return (
          <button
            key={s}
            onClick={() => onSelect(s)}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm w-full text-left hover:bg-slate-100 ${
              current === s ? 'font-semibold' : ''
            }`}
          >
            <span className="w-4 inline-flex items-center justify-center">
              {style.icon}
            </span>
            <span>{STATUS_LABEL[s]}</span>
            {current === s && (
              <span className="ml-auto text-[10px] text-slate-400">現在</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// プロジェクト工種別の進捗集計 (2 値: 完了 / 未完了)
interface WorkTypeProgress {
  totalArea: number
  completedArea: number
  total: number
  completed: number
}

function computeProgress(
  farms: Farm[],
  workType: string,
  farmWorkAreaSummary: Record<string, Record<string, number>>,
  statusByKey: Map<string, WorkStatus>,
): WorkTypeProgress {
  const r: WorkTypeProgress = {
    totalArea: 0,
    completedArea: 0,
    total: 0,
    completed: 0,
  }
  for (const farm of farms) {
    const area = farmWorkAreaSummary[farm.id]?.[workType] ?? 0
    if (area <= 0) continue
    r.totalArea += area
    r.total += 1
    const status = statusByKey.get(`${farm.id}:${workType}`) ?? 'not_started'
    if (status === 'completed') {
      r.completedArea += area
      r.completed += 1
    }
  }
  return r
}

// 一覧拡大表示: 工種別面積テーブル
function ExpandedProjectTable({
  projects,
  farms,
  farmWorkAreaSummary,
  statusByKey,
  onSetStatus,
  onClose,
  onSelectFarm,
  onNewProject,
}: {
  projects: Project[]
  farms: Farm[]
  farmWorkAreaSummary: Record<string, Record<string, number>>
  statusByKey: Map<string, WorkStatus>
  onSetStatus: (farmId: string, workType: string, status: WorkStatus) => void
  onClose: () => void
  onSelectFarm: (farm: Farm) => void
  onNewProject: () => void
}) {
  const [menu, setMenu] = useState<{
    x: number
    y: number
    farmId: string
    workType: string
    current: WorkStatus
  } | null>(null)

  const openMenu = (
    e: React.MouseEvent,
    farmId: string,
    workType: string,
    current: WorkStatus,
  ) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, farmId, workType, current })
  }

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {/* ヘッダー */}
      <div className="p-3 border-b flex items-center gap-2">
        <TableIcon className="h-4 w-4 text-slate-500" />
        <span className="font-medium text-sm">プロジェクト一覧（工種別面積・進捗）</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={onNewProject}
            className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
          >
            <Plus className="h-3 w-3" />
            プロジェクト追加
          </button>
          <button
            onClick={onClose}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
            title="ツリー表示に戻す"
          >
            <Minimize2 className="h-3 w-3" />
            ツリー表示
          </button>
        </div>
      </div>

      {/* 凡例 */}
      <div className="px-3 py-1.5 border-b bg-slate-50 flex items-center gap-3 text-[11px] text-slate-600">
        <span className="font-medium">状態:</span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-slate-500">
          未完了
        </span>
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-emerald-700 bg-emerald-50">
          <Check className="h-3.5 w-3.5" strokeWidth={3} />
          完了
        </span>
        <span className="text-slate-400">（セルを右クリックで状態を変更）</span>
      </div>

      {/* テーブル */}
      <div className="flex-1 overflow-auto">
        {projects.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">
            プロジェクトがありません
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr>
                <th className="px-2 py-2 border-b border-r text-left font-semibold text-slate-700" style={{ minWidth: 180 }}>
                  工事名 / 工区名
                </th>
                {ALL_WORK_TYPES.map((wt) => (
                  <th
                    key={wt}
                    className="px-2 py-2 border-b border-r text-right font-semibold text-slate-700 whitespace-nowrap"
                  >
                    <div className="flex items-center justify-end gap-1">
                      <span
                        className="w-2 h-2 rounded-sm flex-shrink-0"
                        style={{ backgroundColor: WORK_TYPE_COLORS[wt] }}
                      />
                      {WORK_TYPE_NAMES[wt]}
                      <span className="text-slate-400 font-normal">(ha)</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const projFarms = farms.filter((f) => f.project_id === project.id)
                return (
                  <ProjectTableGroup
                    key={project.id}
                    project={project}
                    farms={projFarms}
                    farmWorkAreaSummary={farmWorkAreaSummary}
                    statusByKey={statusByKey}
                    onOpenStatusMenu={openMenu}
                    onSelectFarm={onSelectFarm}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {menu && (
        <StatusContextMenu
          x={menu.x}
          y={menu.y}
          current={menu.current}
          onSelect={(status) => {
            onSetStatus(menu.farmId, menu.workType, status)
            setMenu(null)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

function ProjectTableGroup({
  project,
  farms,
  farmWorkAreaSummary,
  statusByKey,
  onOpenStatusMenu,
  onSelectFarm,
}: {
  project: Project
  farms: Farm[]
  farmWorkAreaSummary: Record<string, Record<string, number>>
  statusByKey: Map<string, WorkStatus>
  onOpenStatusMenu: (
    e: React.MouseEvent,
    farmId: string,
    workType: string,
    current: WorkStatus,
  ) => void
  onSelectFarm: (farm: Farm) => void
}) {
  const [expanded, setExpanded] = useState(true)
  const progressByWorkType = useMemo(() => {
    const m: Record<string, WorkTypeProgress> = {}
    for (const wt of ALL_WORK_TYPES) {
      m[wt] = computeProgress(farms, wt, farmWorkAreaSummary, statusByKey)
    }
    return m
  }, [farms, farmWorkAreaSummary, statusByKey])

  return (
    <>
      {/* プロジェクト行（工種別合計＋進捗） */}
      <tr className="bg-blue-50 hover:bg-blue-100">
        <td className="px-2 py-1.5 border-b border-r">
          <button
            onClick={() => setExpanded((s) => !s)}
            className="flex items-center gap-1 font-medium text-slate-800"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3 text-slate-500" />
            ) : (
              <ChevronRight className="h-3 w-3 text-slate-500" />
            )}
            <Folder className="h-3.5 w-3.5 text-blue-500" />
            <span>{project.name}</span>
            <span className="text-xs text-slate-500 ml-1">（{farms.length}工区）</span>
          </button>
        </td>
        {ALL_WORK_TYPES.map((wt) => {
          const p = progressByWorkType[wt]
          if (p.totalArea <= 0) {
            return (
              <td key={wt} className="px-2 py-1.5 border-b border-r text-right font-mono text-slate-300">
                —
              </td>
            )
          }
          const pct = (p.completedArea / p.totalArea) * 100
          return (
            <td key={wt} className="px-2 py-1.5 border-b border-r text-right font-mono">
              <div className="text-slate-800 font-semibold">{p.totalArea.toFixed(2)}</div>
              {p.completedArea > 0 && (
                <div className="flex items-center justify-end gap-2 text-[10px] mt-0.5">
                  <span className="inline-flex items-center gap-0.5 text-emerald-700">
                    <Check className="h-2.5 w-2.5" strokeWidth={3} />
                    {p.completedArea.toFixed(2)}（{pct.toFixed(0)}%）
                  </span>
                </div>
              )}
            </td>
          )
        })}
      </tr>
      {/* 工区行 */}
      {expanded &&
        farms.map((farm) => {
          const summary = farmWorkAreaSummary[farm.id] || {}
          return (
            <tr key={farm.id} className="hover:bg-slate-50">
              <td className="px-2 py-1.5 border-b border-r pl-8">
                <div className="flex items-center gap-1">
                  <span className="text-slate-700">{farm.name}</span>
                  <button
                    onClick={() => onSelectFarm(farm)}
                    className="ml-1 px-1.5 py-0.5 text-[10px] text-slate-500 border rounded hover:bg-slate-50"
                    title="アクション選択"
                  >
                    …
                  </button>
                </div>
              </td>
              {ALL_WORK_TYPES.map((wt) => {
                const area = summary[wt] ?? 0
                const status = statusByKey.get(`${farm.id}:${wt}`) ?? 'not_started'
                return (
                  <StatusAreaCell
                    key={wt}
                    area={area}
                    status={status}
                    onContextMenu={(e) => onOpenStatusMenu(e, farm.id, wt, status)}
                  />
                )
              })}
            </tr>
          )
        })}
    </>
  )
}
