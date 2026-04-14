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
} from 'lucide-react'
import { MapContainer, TileLayer, Marker, Popup, Polygon, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useFarmStore, type Farm, type FarmLocation } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { JGD2011_ZONES } from '@/lib/coordinates'
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
  } = useProjectListStore()

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [selectedFarm, setSelectedFarm] = useState<Farm | null>(null)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showNewFarmDialog, setShowNewFarmDialog] = useState<string | null>(null) // project_id
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [newProjectZone, setNewProjectZone] = useState(13)
  const [newFarmName, setNewFarmName] = useState('')
  const [newFarmDescription, setNewFarmDescription] = useState('')
  const [newFarmZone, setNewFarmZone] = useState(6)
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
  }, [fetchProjects, fetchFarms])

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
    // 座標系が変更されていない場合はundefinedを渡してプロジェクトの座標系を使用
    const project = projects.find(p => p.id === showNewFarmDialog)
    const zoneToUse = newFarmZone === (project?.coordinate_zone ?? 13) ? undefined : newFarmZone
    const farm = await createFarm(showNewFarmDialog, newFarmName, newFarmDescription, zoneToUse)
    setCreating(false)
    if (farm) {
      setShowNewFarmDialog(null)
      setNewFarmName('')
      setNewFarmDescription('')
      setNewFarmZone(13)
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
        {/* 左側: プロジェクト・圃場ツリー */}
        <div className="w-80 border-r bg-white flex flex-col overflow-hidden">
          {/* ヘッダー */}
          <div className="p-3 border-b flex items-center justify-between">
            <span className="font-medium text-sm">プロジェクト</span>
            <button
              onClick={() => setShowNewProjectDialog(true)}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
            >
              <Plus className="h-3 w-3" />
              追加
            </button>
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
                              // プロジェクトの座標系をデフォルトに設定
                              setNewFarmZone(project.coordinate_zone ?? 13)
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
                                  onClick={() => handleSelectFarm(farm)}
                                  onDoubleClick={() => handleOpenFarm(farm)}
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
                                  <div className="hidden group-hover:flex items-center">
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
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 選択中の圃場情報 */}
          {selectedFarm && (
            <div className="border-t p-3 bg-slate-50">
              <div className="text-xs text-muted-foreground mb-1">選択中</div>
              <div className="font-medium text-sm truncate">{selectedFarm.name}</div>
              {selectedFarm.description && (
                <div className="text-xs text-muted-foreground truncate mt-0.5">
                  {selectedFarm.description}
                </div>
              )}
              <div className="text-xs text-slate-500 mt-1">第{selectedFarm.coordinate_zone}系</div>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => handleOpenFarm(selectedFarm)}
                  className="flex-1 px-3 py-1.5 text-xs bg-primary text-primary-foreground rounded hover:bg-primary/90"
                >
                  開く
                </button>
                {selectedFarmLocation && (
                  <button
                    onClick={() => openGoogleMapsNavigation(selectedFarmLocation.lat, selectedFarmLocation.lng)}
                    className="px-3 py-1.5 text-xs border rounded hover:bg-slate-100"
                    title="Google Mapsで経路探索"
                  >
                    <Navigation className="h-3 w-3" />
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 右側: 地図 */}
        <div className="flex-1 bg-slate-100">
          {farmLocations.size === 0 ? (
            <div className="h-full flex items-center justify-center text-muted-foreground">
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
              className="h-full w-full"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {!selectedFarm && allBounds && <FitBounds bounds={allBounds} />}
              {selectedFarm && selectedFarmLocation && (
                <FocusOnFarm location={selectedFarmLocation} />
              )}
              {/* 工事区域ポリゴン */}
              {workAreaPolygons.map((polygon) => (
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
                    <Popup>
                      <div className="text-sm">
                        <div className="font-bold">{farm.name}</div>
                        {farm.description && (
                          <div className="text-muted-foreground text-xs">{farm.description}</div>
                        )}
                        <button
                          onClick={() => handleOpenFarm(farm)}
                          className="mt-2 px-3 py-1 text-xs bg-primary text-white rounded hover:bg-primary/90 w-full"
                        >
                          開く
                        </button>
                      </div>
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
              <div>
                <label className="block text-sm font-medium mb-1">座標系</label>
                <select
                  value={newFarmZone}
                  onChange={(e) => setNewFarmZone(parseInt(e.target.value))}
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
