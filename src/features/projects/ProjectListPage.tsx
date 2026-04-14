import { useEffect, useState } from 'react'
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
} from 'lucide-react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useFarmStore, type Farm, type FarmLocation } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { JGD2011_ZONES } from '@/lib/coordinates'

// カスタムマーカーアイコン
const createMarkerIcon = (): L.DivIcon => {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: #ef4444;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  })
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
  } = useFarmStore()
  const {
    projects,
    loading: projectsLoading,
    error: projectsError,
    fetchProjects,
    createProject,
    deleteProject,
  } = useProjectListStore()

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showNewFarmDialog, setShowNewFarmDialog] = useState<string | null>(null) // project_id
  const [newProjectName, setNewProjectName] = useState('')
  const [newProjectDescription, setNewProjectDescription] = useState('')
  const [newFarmName, setNewFarmName] = useState('')
  const [newFarmDescription, setNewFarmDescription] = useState('')
  const [newFarmZone, setNewFarmZone] = useState(6)
  const [creating, setCreating] = useState(false)
  const [showMapDialog, setShowMapDialog] = useState<{ farm: Farm; location: FarmLocation } | null>(null)

  useEffect(() => {
    fetchProjects()
    fetchFarms()
  }, [fetchProjects, fetchFarms])

  // 初期表示時に全プロジェクトを展開
  useEffect(() => {
    if (projects.length > 0 && expandedProjects.size === 0) {
      setExpandedProjects(new Set(projects.map((p) => p.id)))
    }
  }, [projects, expandedProjects.size])

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
    const project = await createProject(newProjectName, newProjectDescription)
    setCreating(false)
    if (project) {
      setShowNewProjectDialog(false)
      setNewProjectName('')
      setNewProjectDescription('')
      // 新しいプロジェクトを展開
      setExpandedProjects((prev) => new Set([...prev, project.id]))
    }
  }

  const handleCreateFarm = async () => {
    if (!newFarmName.trim() || !showNewFarmDialog) return
    setCreating(true)
    const farm = await createFarm(showNewFarmDialog, newFarmName, newFarmDescription, newFarmZone)
    setCreating(false)
    if (farm) {
      setShowNewFarmDialog(null)
      setNewFarmName('')
      setNewFarmDescription('')
      setNewFarmZone(6)
    }
  }

  const handleSelectFarm = (farm: Farm) => {
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
    fetchFarms() // 圃場一覧を再取得
  }

  const handleDeleteFarm = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (confirm('この圃場を削除しますか？関連するすべてのデータが削除されます。')) {
      await deleteFarm(id)
    }
  }

  const handleShowMap = (e: React.MouseEvent, farm: Farm) => {
    e.stopPropagation()
    const location = farmLocations.get(farm.id)
    if (location) {
      setShowMapDialog({ farm, location })
    }
  }

  const openGoogleMapsNavigation = (lat: number, lng: number) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    window.open(url, '_blank')
  }

  const getFarmsForProject = (projectId: string) => {
    return farms.filter((f) => f.project_id === projectId)
  }

  const loading = projectsLoading || farmsLoading
  const error = projectsError || farmsError

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
          <p className="text-muted-foreground">工事プロジェクトと圃場を管理</p>
        </div>
        <button
          onClick={() => setShowNewProjectDialog(true)}
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

      <div className="space-y-4">
        {projects.map((project) => {
          const projectFarms = getFarmsForProject(project.id)
          const isExpanded = expandedProjects.has(project.id)

          return (
            <div key={project.id} className="bg-white rounded-lg border">
              {/* プロジェクトヘッダー */}
              <div
                onClick={() => toggleProject(project.id)}
                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-slate-50 transition-colors"
              >
                <button className="p-1 hover:bg-slate-200 rounded">
                  {isExpanded ? (
                    <ChevronDown className="h-5 w-5 text-slate-500" />
                  ) : (
                    <ChevronRight className="h-5 w-5 text-slate-500" />
                  )}
                </button>
                <div className="p-2 bg-blue-100 rounded-lg">
                  <Folder className="h-5 w-5 text-blue-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <h2 className="font-semibold text-lg">{project.name}</h2>
                  {project.description && (
                    <p className="text-sm text-muted-foreground truncate">{project.description}</p>
                  )}
                  <div className="text-xs text-slate-500 mt-1">
                    {projectFarms.length}件の圃場 •{' '}
                    {new Date(project.created_at).toLocaleDateString('ja-JP')}作成
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setShowNewFarmDialog(project.id)
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                  >
                    <Plus className="h-3 w-3" />
                    圃場追加
                  </button>
                  <button
                    onClick={(e) => handleDeleteProject(e, project.id)}
                    className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                    title="削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>

              {/* 圃場一覧 */}
              {isExpanded && (
                <div className="border-t bg-slate-50/50">
                  {projectFarms.length === 0 ? (
                    <div className="p-6 text-center text-muted-foreground text-sm">
                      圃場がありません。「圃場追加」から作成してください。
                    </div>
                  ) : (
                    <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {projectFarms.map((farm) => {
                        const location = farmLocations.get(farm.id)
                        return (
                          <div
                            key={farm.id}
                            onClick={() => handleSelectFarm(farm)}
                            className="block p-4 bg-white rounded-lg border hover:border-primary transition-colors cursor-pointer"
                          >
                            <div className="flex items-start gap-3">
                              <div className="p-1.5 bg-slate-100 rounded">
                                <FolderOpen className="h-4 w-4 text-slate-600" />
                              </div>
                              <div className="flex-1 min-w-0">
                                <h3 className="font-medium truncate">{farm.name}</h3>
                                <p className="text-xs text-muted-foreground truncate">
                                  {farm.description || '説明なし'}
                                </p>
                                <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                                  <span>第{farm.coordinate_zone}系</span>
                                  <span>•</span>
                                  <span>{new Date(farm.created_at).toLocaleDateString('ja-JP')}</span>
                                </div>
                              </div>
                              <div className="flex flex-col gap-1">
                                {location && (
                                  <button
                                    onClick={(e) => handleShowMap(e, farm)}
                                    className="p-1 text-blue-500 hover:text-blue-700 hover:bg-blue-50 rounded transition-colors"
                                    title="地図で表示"
                                  >
                                    <MapPin className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                <button
                                  onClick={(e) => handleDeleteFarm(e, farm.id)}
                                  className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                                  title="削除"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {projects.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            プロジェクトがありません。「新規プロジェクト」から作成してください。
          </div>
        )}
      </div>

      {/* 地図表示ダイアログ */}
      {showMapDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
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
                  icon={createMarkerIcon()}
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
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
    </div>
  )
}
