import { useEffect, useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Plus,
  FolderOpen,
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
  Crosshair,
  Maximize2,
  Minimize2,
  Table as TableIcon,
  Edit,
  Map as MapIcon,
  Lock,
} from 'lucide-react'
import { MapContainer, TileLayer, Marker, Popup, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useFarmStore, type Farm, type FarmLocation } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { JGD2011_ZONES } from '@/lib/coordinates'
import { CurrentLocationLayer } from '@/components/map/CurrentLocationLayer'
import type { Project, ProjectMemberRole } from '@/types/database'

// 工種ごとのポリゴン色
const WORK_TYPE_COLORS: Record<string, string> = {
  underdrain: '#3b82f6',     // 暗渠工事: 青
  soil_import: '#f59e0b',    // 客土工事: オレンジ
  simple_grading: '#8b5cf6', // 簡易整地: 紫
  grading: '#10b981',        // 整地: 緑
  subsoil: '#ec4899',        // 心破土改: ピンク
  stone_removal: '#6b7280',  // 徐礫: グレー
}

// 工種名
const WORK_TYPE_NAMES: Record<string, string> = {
  underdrain: '暗渠',
  soil_import: '客土',
  simple_grading: '簡易整地',
  grading: '整地',
  subsoil: '心土破砕',
  stone_removal: '除礫',
}

// 全工種リスト
const ALL_WORK_TYPES = ['underdrain', 'soil_import', 'simple_grading', 'grading', 'subsoil', 'stone_removal'] as const

// カスタムマーカーアイコン
const createMarkerIcon = (isSelected: boolean = false): L.DivIcon => {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${isSelected ? '#ef4444' : '#3b82f6'};
      width: ${isSelected ? 28 : 20}px;
      height: ${isSelected ? 28 : 20}px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [isSelected ? 28 : 20, isSelected ? 28 : 20],
    iconAnchor: [isSelected ? 14 : 10, isSelected ? 14 : 10],
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

// 選択した圃場にフォーカス
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
  const {
    farms,
    loading: farmsLoading,
    error: farmsError,
    fetchFarms,
    createFarm,
    deleteFarm,
    setCurrentFarm,
    farmLocations,
    workAreaPolygons,
    fetchWorkAreaPolygons,
  } = useFarmStore()
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    fetchProjects,
    createProject,
    updateProject,
    deleteProject,
    members,
    membersLoading,
    fetchMembers,
    addMember,
    updateMemberRole,
    removeMember,
    userRolesByProject,
    fetchUserRoles,
  } = useProjectListStore()

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [selectedFarm, setSelectedFarm] = useState<Farm | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)

  // 工種フィルター（表示する工種のSet）
  const [visibleWorkTypes, setVisibleWorkTypes] = useState<Set<string>>(new Set(ALL_WORK_TYPES))

  // 現在地表示トグル
  const [showCurrentLocation, setShowCurrentLocation] = useState(false)

  // 一覧拡大表示モード
  const [expandedList, setExpandedList] = useState(false)
  const [showNewFarmDialog, setShowNewFarmDialog] = useState<string | null>(null) // project_id
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [newProjectZone, setNewProjectZone] = useState(13)
  const [newFarmName, setNewFarmName] = useState('')
  const [newFarmDescription, setNewFarmDescription] = useState('')
  const [creating, setCreating] = useState(false)
  const [showMapDialog, setShowMapDialog] = useState<{ farm: Farm; location: FarmLocation } | null>(null)

  // プロジェクト編集用state
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [editProjectName, setEditProjectName] = useState('')
  const [editProjectDescription, setEditProjectDescription] = useState('')
  const [editProjectStartDate, setEditProjectStartDate] = useState('')
  const [editProjectEndDate, setEditProjectEndDate] = useState('')
  const [editProjectClient, setEditProjectClient] = useState('')
  const [editProjectContractor, setEditProjectContractor] = useState('')
  const [editProjectZone, setEditProjectZone] = useState(13)
  const [saving, setSaving] = useState(false)

  // メンバー管理用state
  const [showMemberDialog, setShowMemberDialog] = useState<Project | null>(null)
  const [newMemberEmail, setNewMemberEmail] = useState('')
  const [newMemberRole, setNewMemberRole] = useState<ProjectMemberRole>('viewer')
  const [addingMember, setAddingMember] = useState(false)

  useEffect(() => {
    fetchProjects()
    fetchFarms()
    fetchUserRoles()
  }, [fetchProjects, fetchFarms, fetchUserRoles])

  // 圃場クリック時のアクション選択ダイアログ
  const [farmActionDialog, setFarmActionDialog] = useState<Farm | null>(null)

  // 圃場が読み込まれたらポリゴンデータを取得
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

  // 全圃場の位置情報から地図の境界を計算
  const allBounds = useMemo(() => {
    const allLocations = Array.from(farmLocations.values())
    if (allLocations.length === 0) return null
    const lats = allLocations.map((loc) => loc.lat)
    const lngs = allLocations.map((loc) => loc.lng)
    return L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)]
    )
  }, [farmLocations])

  // 地図の中心
  const mapCenter = useMemo(() => {
    const allLocations = Array.from(farmLocations.values())
    if (allLocations.length === 0) return { lat: 43.06, lng: 141.35 } // 北海道
    const avgLat = allLocations.reduce((sum, loc) => sum + loc.lat, 0) / allLocations.length
    const avgLng = allLocations.reduce((sum, loc) => sum + loc.lng, 0) / allLocations.length
    return { lat: avgLat, lng: avgLng }
  }, [farmLocations])

  // 選択された圃場の位置
  const selectedFarmLocation = useMemo(() => {
    if (!selectedFarm) return null
    return farmLocations.get(selectedFarm.id) || null
  }, [selectedFarm, farmLocations])

  // フィルタリングされたポリゴン
  const filteredPolygons = useMemo(() => {
    return workAreaPolygons.filter(p => visibleWorkTypes.has(p.workType))
  }, [workAreaPolygons, visibleWorkTypes])

  // 圃場ごとの工種別面積を計算（ポップアップ用）
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

  const handleOpenFarm = (farm: Farm) => {
    setCurrentFarm(farm)
    navigate('/coordinates')
  }

  const handleDeleteProject = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const farmsInProject = farms.filter((f) => f.project_id === id)
    if (farmsInProject.length > 0) {
      if (
        !confirm(
          `このプロジェクトには${farmsInProject.length}個の圃場があります。プロジェクトを削除すると、関連するすべての圃場とデータが削除されます。続行しますか？`
        )
      ) {
        return
      }
    } else {
      if (!confirm('このプロジェクトを削除しますか？')) {
        return
      }
    }
    await deleteProject(id)
    fetchFarms()
  }

  const handleDeleteFarm = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (confirm('この圃場を削除しますか？関連するすべてのデータが削除されます。')) {
      await deleteFarm(id)
      if (selectedFarm?.id === id) {
        setSelectedFarm(null)
      }
    }
  }

  const openGoogleMapsNavigation = (lat: number, lng: number) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    window.open(url, '_blank')
  }

  // プロジェクト編集ダイアログを開く
  const handleOpenEditDialog = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setEditingProject(project)
    setEditProjectName(project.name)
    setEditProjectDescription(project.description || '')
    setEditProjectStartDate(project.start_date || '')
    setEditProjectEndDate(project.end_date || '')
    setEditProjectClient(project.client || '')
    setEditProjectContractor(project.contractor || '')
    setEditProjectZone(project.coordinate_zone ?? 13)
  }

  // プロジェクト更新
  const handleUpdateProject = async () => {
    if (!editingProject || !editProjectName.trim()) return
    setSaving(true)
    await updateProject(editingProject.id, {
      name: editProjectName,
      description: editProjectDescription || null,
      start_date: editProjectStartDate || null,
      end_date: editProjectEndDate || null,
      client: editProjectClient || null,
      contractor: editProjectContractor || null,
      coordinate_zone: editProjectZone,
    })
    setSaving(false)
    setEditingProject(null)
  }

  // メンバー管理ダイアログを開く
  const handleOpenMemberDialog = (e: React.MouseEvent, project: Project) => {
    e.stopPropagation()
    setShowMemberDialog(project)
    fetchMembers(project.id)
  }

  // メンバー追加
  const handleAddMember = async () => {
    if (!showMemberDialog || !newMemberEmail.trim()) return
    setAddingMember(true)
    const success = await addMember(showMemberDialog.id, newMemberEmail, newMemberRole)
    setAddingMember(false)
    if (success) {
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
    return farms.filter((f) => f.project_id === projectId)
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

  return (
    <div className="h-full flex flex-col">
      {error && (
        <div className="p-3 bg-red-50 border-b border-red-200 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {expandedList ? (
          <ExpandedProjectTable
            projects={projects}
            farms={farms}
            farmWorkAreaSummary={farmWorkAreaSummary}
            onClose={() => setExpandedList(false)}
            onOpenFarm={handleOpenFarm}
            onSelectFarm={(farm) => setFarmActionDialog(farm)}
            onNewProject={() => setShowNewProjectDialog(true)}
          />
        ) : (
        <>
        {/* 左側: プロジェクト・圃場ツリー */}
        <div className="w-80 border-r bg-white flex flex-col overflow-hidden">
          {/* ヘッダー */}
          <div className="p-3 border-b flex items-center justify-between gap-1">
            <span className="font-medium text-sm">プロジェクト</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setExpandedList(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
                title="一覧を拡大表示"
              >
                <Maximize2 className="h-3 w-3" />
                拡大
              </button>
              <button
                onClick={() => setShowNewProjectDialog(true)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
              >
                <Plus className="h-3 w-3" />
                追加
              </button>
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
                            title="圃場追加"
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

                      {/* 圃場一覧 */}
                      {isExpanded && (
                        <div className="ml-5 mt-1 space-y-0.5">
                          {projectFarms.length === 0 ? (
                            <div className="text-xs text-muted-foreground py-2 pl-5">
                              圃場なし
                            </div>
                          ) : (
                            projectFarms.map((farm) => {
                              const location = farmLocations.get(farm.id)
                              const isSelected = selectedFarm?.id === farm.id

                              return (
                                <div
                                  key={farm.id}
                                  onClick={() => {
                                    handleSelectFarm(farm)
                                    setFarmActionDialog(farm)
                                  }}
                                  className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer group ${
                                    isSelected
                                      ? 'bg-blue-100 text-blue-700'
                                      : 'hover:bg-slate-100'
                                  }`}
                                >
                                  <FolderOpen className={`h-4 w-4 flex-shrink-0 ${isSelected ? 'text-blue-600' : 'text-slate-400'}`} />
                                  <span className="flex-1 text-sm truncate" title={farm.name}>
                                    {farm.name}
                                  </span>
                                  {location && (
                                    <MapPin className="h-3 w-3 text-slate-400 flex-shrink-0" />
                                  )}
                                  <div className="hidden group-hover:flex items-center gap-1">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setFarmActionDialog(farm)
                                      }}
                                      className="px-2 py-0.5 text-xs border text-slate-500 rounded hover:bg-slate-50"
                                      title="アクション選択"
                                    >
                                      …
                                    </button>
                                    <button
                                      onClick={(e) => handleDeleteFarm(e, farm.id)}
                                      className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                                      title="削除"
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </button>
                                  </div>
                                </div>
                              )
                            })
                          )}
                          {/* 新規圃場ボタン */}
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setShowNewFarmDialog(project.id)
                            }}
                            className="flex items-center gap-2 px-2 py-1.5 w-full text-left text-xs text-green-600 hover:bg-green-50 rounded"
                          >
                            <Plus className="h-3 w-3" />
                            新規圃場を追加
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

        {/* 右側: 地図 */}
        <div className="flex-1 bg-slate-100 flex flex-col">
          {/* 凡例（工種フィルター） */}
          <div className="p-3 bg-white border-b flex flex-wrap gap-4 items-center">
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
            <button
              type="button"
              onClick={() => setShowCurrentLocation((s) => !s)}
              className={`ml-auto flex items-center gap-1 px-2 py-1 text-sm rounded border ${
                showCurrentLocation
                  ? 'bg-blue-100 border-blue-400 text-blue-800 font-medium'
                  : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
              }`}
              title="現在位置の表示を切替"
            >
              <Crosshair className="h-4 w-4" />
              現在地
            </button>
          </div>

          {farmLocations.size === 0 ? (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <MapPin className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>位置情報のある圃場がありません</p>
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
              {showCurrentLocation && <CurrentLocationLayer />}
              {/* 工事区域ポリゴン（フィルタリング済み） */}
              {filteredPolygons.map((polygon) => (
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
              {/* 圃場マーカー */}
              {farms.map((farm) => {
                const location = farmLocations.get(farm.id)
                if (!location) return null
                const isSelected = selectedFarm?.id === farm.id
                const areaSummary = farmWorkAreaSummary[farm.id] || {}

                return (
                  <Marker
                    key={farm.id}
                    position={[location.lat, location.lng]}
                    icon={createMarkerIcon(isSelected)}
                    eventHandlers={{
                      click: () => handleSelectFarm(farm),
                      dblclick: () => handleOpenFarm(farm),
                    }}
                  >
                    <Tooltip permanent direction="top" offset={[0, -15]} className="farm-label-tooltip">
                      {farm.name}
                    </Tooltip>
                    <Popup>
                      <div className="text-sm min-w-[180px]">
                        <div className="font-bold text-base mb-2">{farm.name}</div>
                        {farm.description && (
                          <div className="text-muted-foreground text-xs mb-2">{farm.description}</div>
                        )}
                        {/* 工種別面積 */}
                        {Object.keys(areaSummary).length > 0 && (
                          <div className="border-t pt-2 mb-2">
                            <div className="text-xs font-semibold mb-1">施工面積</div>
                            {ALL_WORK_TYPES.map(wt => {
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
                          onClick={() => setFarmActionDialog(farm)}
                          className="mt-2 px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90 w-full"
                        >
                          アクション選択（圃場編集 / 地図表示 / 経路案内）
                        </button>
                      </div>
                    </Popup>
                  </Marker>
                )
              })}
            </MapContainer>
          )}
        </div>
        </>
        )}
      </div>

      {/* 圃場アクション選択ダイアログ */}
      {farmActionDialog && (() => {
        const farm = farmActionDialog
        const location = farmLocations.get(farm.id)
        const project = projects.find((p) => p.id === farm.project_id)
        const role = farm.project_id ? userRolesByProject.get(farm.project_id) ?? null : null
        const canEdit = role === 'owner' || role === 'editor' || role == null // 未登録は owner 扱い（既存データ互換）
        const canEditExplicitViewer = role === 'viewer'
        return (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-[1500] p-4"
            onClick={() => setFarmActionDialog(null)}
          >
            <div
              className="bg-white rounded-xl shadow-xl w-full max-w-sm p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  {project && <div className="text-xs text-slate-500">{project.name}</div>}
                  <div className="text-base font-bold">{farm.name}</div>
                  {role && (
                    <div className="mt-1 text-xs text-slate-500">
                      権限:{' '}
                      {role === 'owner' ? 'オーナー' : role === 'editor' ? '編集者' : '閲覧者'}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => setFarmActionDialog(null)}
                  className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="space-y-2">
                <button
                  disabled={canEditExplicitViewer || !canEdit}
                  onClick={() => {
                    setFarmActionDialog(null)
                    handleOpenFarm(farm)
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium ${
                    canEditExplicitViewer || !canEdit
                      ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700'
                  }`}
                  title={canEditExplicitViewer ? '閲覧権限では編集できません' : ''}
                >
                  {canEditExplicitViewer ? (
                    <Lock className="h-5 w-5" />
                  ) : (
                    <Edit className="h-5 w-5" />
                  )}
                  圃場編集
                  {canEditExplicitViewer && (
                    <span className="ml-auto text-xs">閲覧のみ</span>
                  )}
                </button>
                <button
                  onClick={() => {
                    setFarmActionDialog(null)
                    const url = `/site-map?farmId=${encodeURIComponent(farm.id)}`
                    const screenW = window.screen.availWidth
                    const screenH = window.screen.availHeight
                    const w = window.open(
                      url,
                      'nodecloud_site_map',
                      `width=${screenW},height=${screenH},left=0,top=0`,
                    )
                    if (w) {
                      try {
                        if (w.location.href.indexOf(url) === -1) w.location.href = url
                        w.focus()
                      } catch {
                        // ignore
                      }
                    }
                  }}
                  className="w-full flex items-center gap-3 px-4 py-3 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium"
                >
                  <MapIcon className="h-5 w-5" />
                  地図表示
                </button>
                <button
                  disabled={!location}
                  onClick={() => {
                    if (!location) return
                    setFarmActionDialog(null)
                    openGoogleMapsNavigation(location.lat, location.lng)
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium ${
                    location
                      ? 'bg-green-600 text-white hover:bg-green-700'
                      : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                  }`}
                  title={!location ? '位置情報がありません' : ''}
                >
                  <Navigation className="h-5 w-5" />
                  経路案内（Google マップ）
                </button>
                <button
                  onClick={() => setFarmActionDialog(null)}
                  className="w-full px-4 py-2.5 border rounded-lg hover:bg-slate-50 text-sm"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )
      })()}

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

      {/* 新規圃場ダイアログ */}
      {showNewFarmDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md p-6">
            <h2 className="text-lg font-bold mb-4">新規圃場</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">圃場名 *</label>
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
                  placeholder="圃場の説明（任意）"
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

      {/* プロジェクト編集ダイアログ */}
      {editingProject && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold mb-4">プロジェクト編集</h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">プロジェクト名 *</label>
                <input
                  type="text"
                  value={editProjectName}
                  onChange={(e) => setEditProjectName(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">説明</label>
                <textarea
                  value={editProjectDescription}
                  onChange={(e) => setEditProjectDescription(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  rows={2}
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium mb-1">工期開始日</label>
                  <input
                    type="date"
                    value={editProjectStartDate}
                    onChange={(e) => setEditProjectStartDate(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">工期終了日</label>
                  <input
                    type="date"
                    value={editProjectEndDate}
                    onChange={(e) => setEditProjectEndDate(e.target.value)}
                    className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">発注者</label>
                <input
                  type="text"
                  value={editProjectClient}
                  onChange={(e) => setEditProjectClient(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例: 〇〇県土地改良課"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">受託者</label>
                <input
                  type="text"
                  value={editProjectContractor}
                  onChange={(e) => setEditProjectContractor(e.target.value)}
                  className="w-full px-3 py-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例: 〇〇建設株式会社"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">座標系</label>
                <select
                  value={editProjectZone}
                  onChange={(e) => setEditProjectZone(parseInt(e.target.value))}
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
                onClick={() => setEditingProject(null)}
                className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleUpdateProject}
                disabled={!editProjectName.trim() || saving}
                className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* メンバー管理ダイアログ */}
      {showMemberDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1000]">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">メンバー管理</h2>
              <button
                onClick={() => setShowMemberDialog(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">{showMemberDialog.name}</p>

            {/* メンバー追加フォーム */}
            <div className="border rounded-lg p-4 mb-4 bg-slate-50">
              <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                <UserPlus className="h-4 w-4" />
                メンバーを追加
              </h3>
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
                  追加
                </button>
              </div>
            </div>

            {/* メンバー一覧 */}
            <div>
              <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
                <Users className="h-4 w-4" />
                現在のメンバー
              </h3>
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
                      <div>
                        <div className="text-sm font-medium">{member.email || member.user_id}</div>
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
    </div>
  )
}

// 一覧拡大表示: 工種別面積テーブル
function ExpandedProjectTable({
  projects,
  farms,
  farmWorkAreaSummary,
  onClose,
  onOpenFarm,
  onSelectFarm,
  onNewProject,
}: {
  projects: Project[]
  farms: Farm[]
  farmWorkAreaSummary: Record<string, Record<string, number>>
  onClose: () => void
  onOpenFarm: (farm: Farm) => void
  onSelectFarm: (farm: Farm) => void
  onNewProject: () => void
}) {
  // プロジェクトごとの工種別合計
  const projectTotals = useMemo(() => {
    const result: Record<string, Record<string, number>> = {}
    for (const project of projects) {
      const totals: Record<string, number> = {}
      const projFarms = farms.filter((f) => f.project_id === project.id)
      for (const farm of projFarms) {
        const summary = farmWorkAreaSummary[farm.id] || {}
        for (const wt of ALL_WORK_TYPES) {
          if (summary[wt]) {
            totals[wt] = (totals[wt] || 0) + summary[wt]
          }
        }
      }
      result[project.id] = totals
    }
    return result
  }, [projects, farms, farmWorkAreaSummary])

  return (
    <div className="flex-1 flex flex-col bg-white overflow-hidden">
      {/* ヘッダー */}
      <div className="p-3 border-b flex items-center gap-2">
        <TableIcon className="h-4 w-4 text-slate-500" />
        <span className="font-medium text-sm">プロジェクト一覧（工種別面積）</span>
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
            title="地図表示に戻す"
          >
            <Minimize2 className="h-3 w-3" />
            地図表示
          </button>
        </div>
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
                <th className="px-2 py-2 border-b border-r text-left font-semibold text-slate-700" style={{ minWidth: 200 }}>
                  工事名 / 圃場名
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
                <th className="px-2 py-2 border-b border-r text-right font-semibold text-slate-700 whitespace-nowrap bg-slate-200">
                  合計 (ha)
                </th>
                {/* 進捗: 将来実装用プレースホルダ */}
                <th
                  className="px-2 py-2 border-b text-center font-semibold text-slate-500 whitespace-nowrap bg-slate-50"
                  style={{ minWidth: 120 }}
                  title="各工程の進捗状況（実装予定）"
                >
                  進捗
                </th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const projFarms = farms.filter((f) => f.project_id === project.id)
                const pTotals = projectTotals[project.id] || {}
                const pGrandTotal = ALL_WORK_TYPES.reduce((s, wt) => s + (pTotals[wt] || 0), 0)
                return (
                  <ProjectTableGroup
                    key={project.id}
                    project={project}
                    farms={projFarms}
                    farmWorkAreaSummary={farmWorkAreaSummary}
                    projectTotals={pTotals}
                    projectGrandTotal={pGrandTotal}
                    onOpenFarm={onOpenFarm}
                    onSelectFarm={onSelectFarm}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function ProjectTableGroup({
  project,
  farms,
  farmWorkAreaSummary,
  projectTotals,
  projectGrandTotal,
  onOpenFarm,
  onSelectFarm,
}: {
  project: Project
  farms: Farm[]
  farmWorkAreaSummary: Record<string, Record<string, number>>
  projectTotals: Record<string, number>
  projectGrandTotal: number
  onOpenFarm: (farm: Farm) => void
  onSelectFarm: (farm: Farm) => void
}) {
  const [expanded, setExpanded] = useState(true)
  return (
    <>
      {/* プロジェクト行（合計） */}
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
            <span className="text-xs text-slate-500 ml-1">（{farms.length}圃場）</span>
          </button>
        </td>
        {ALL_WORK_TYPES.map((wt) => (
          <td key={wt} className="px-2 py-1.5 border-b border-r text-right font-mono text-slate-700">
            {projectTotals[wt] ? projectTotals[wt].toFixed(2) : '—'}
          </td>
        ))}
        <td className="px-2 py-1.5 border-b border-r text-right font-mono font-semibold bg-blue-100">
          {projectGrandTotal > 0 ? projectGrandTotal.toFixed(2) : '—'}
        </td>
        <td className="px-2 py-1.5 border-b text-center text-slate-400">—</td>
      </tr>
      {/* 圃場行 */}
      {expanded &&
        farms.map((farm) => {
          const summary = farmWorkAreaSummary[farm.id] || {}
          const grandTotal = ALL_WORK_TYPES.reduce((s, wt) => s + (summary[wt] || 0), 0)
          return (
            <tr key={farm.id} className="hover:bg-slate-50 cursor-pointer" onDoubleClick={() => onOpenFarm(farm)}>
              <td className="px-2 py-1.5 border-b border-r pl-8">
                <button
                  onClick={() => onSelectFarm(farm)}
                  className="flex items-center gap-1 text-slate-700 hover:text-blue-600"
                  title="クリックでアクション選択（ダブルクリックで圃場編集）"
                >
                  <FolderOpen className="h-3.5 w-3.5 text-slate-400" />
                  <span>{farm.name}</span>
                </button>
              </td>
              {ALL_WORK_TYPES.map((wt) => (
                <td key={wt} className="px-2 py-1.5 border-b border-r text-right font-mono text-slate-600">
                  {summary[wt] ? summary[wt].toFixed(2) : '—'}
                </td>
              ))}
              <td className="px-2 py-1.5 border-b border-r text-right font-mono text-slate-700 bg-slate-50">
                {grandTotal > 0 ? grandTotal.toFixed(2) : '—'}
              </td>
              <td className="px-2 py-1.5 border-b text-center text-slate-400">—</td>
            </tr>
          )
        })}
    </>
  )
}
