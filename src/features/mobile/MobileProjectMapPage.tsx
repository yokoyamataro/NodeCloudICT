import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Navigation, MapPin, List, RefreshCw, Loader2 } from 'lucide-react'
import { useProjectStore, type ProjectLocation } from '@/stores/projectStore'

// カスタムマーカーアイコン
const createMarkerIcon = (isSelected: boolean = false): L.DivIcon => {
  const size = isSelected ? 32 : 24
  const color = isSelected ? '#2563eb' : '#ef4444'
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${color};
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 8px rgba(0,0,0,0.5);
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 地図の境界を全プロジェクトに合わせる
function FitBoundsToProjects({ locations }: { locations: ProjectLocation[] }) {
  const map = useMap()

  useEffect(() => {
    if (locations.length === 0) return

    if (locations.length === 1) {
      map.setView([locations[0].lat, locations[0].lng], 15)
    } else {
      const bounds = L.latLngBounds(locations.map(loc => [loc.lat, loc.lng]))
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15 })
    }
  }, [locations, map])

  return null
}

// 選択したプロジェクトにフォーカス
function FocusOnProject({ location }: { location: ProjectLocation | null }) {
  const map = useMap()

  useEffect(() => {
    if (location) {
      map.setView([location.lat, location.lng], 17, { animate: true })
    }
  }, [location, map])

  return null
}

export function MobileProjectMapPage() {
  const { projects, loading, fetchProjects, projectLocations } = useProjectStore()
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)

  useEffect(() => {
    fetchProjects()
  }, [fetchProjects])

  const locations = Array.from(projectLocations.values())
  const selectedLocation = selectedProjectId ? projectLocations.get(selectedProjectId) : null
  const selectedProject = selectedProjectId ? projects.find(p => p.id === selectedProjectId) : null

  const openGoogleMapsNavigation = (lat: number, lng: number) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    window.open(url, '_blank')
  }

  const handleMarkerClick = (projectId: string) => {
    setSelectedProjectId(projectId)
    setShowList(false)
  }

  const handleListItemClick = (projectId: string) => {
    setSelectedProjectId(projectId)
    setShowList(false)
  }

  if (loading && projects.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-slate-100">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600 mx-auto" />
          <p className="mt-2 text-slate-600">読み込み中...</p>
        </div>
      </div>
    )
  }

  // 座標が登録されているプロジェクトのみ
  const projectsWithLocation = projects.filter(p => projectLocations.has(p.id))

  // デフォルトの中心（日本の中心あたり）
  const defaultCenter: [number, number] = locations.length > 0
    ? [locations[0].lat, locations[0].lng]
    : [36.0, 138.0]

  return (
    <div className="h-screen flex flex-col bg-slate-100">
      {/* ヘッダー */}
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between z-10">
        <h1 className="text-lg font-bold text-slate-800">現場マップ</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchProjects()}
            className="p-2 text-slate-600 hover:bg-slate-100 rounded-full"
            title="更新"
          >
            <RefreshCw className="h-5 w-5" />
          </button>
          <button
            onClick={() => setShowList(!showList)}
            className={`p-2 rounded-full ${showList ? 'bg-blue-100 text-blue-600' : 'text-slate-600 hover:bg-slate-100'}`}
            title="一覧"
          >
            <List className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* メインコンテンツ */}
      <div className="flex-1 relative" style={{ minHeight: 0 }}>
        {/* 地図 */}
        <MapContainer
          center={defaultCenter}
          zoom={10}
          className="h-full w-full"
          style={{ height: '100%', width: '100%' }}
          zoomControl={false}
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />

          {!selectedProjectId && <FitBoundsToProjects locations={locations} />}
          {selectedLocation && <FocusOnProject location={selectedLocation} />}

          {/* プロジェクトマーカー */}
          {locations.map(location => {
            const project = projects.find(p => p.id === location.projectId)
            const isSelected = location.projectId === selectedProjectId
            return (
              <Marker
                key={location.projectId}
                position={[location.lat, location.lng]}
                icon={createMarkerIcon(isSelected)}
                eventHandlers={{
                  click: () => handleMarkerClick(location.projectId),
                }}
              >
                <Popup>
                  <div className="text-sm min-w-[200px]">
                    <div className="font-bold text-base">{project?.name}</div>
                    <div className="text-slate-500 mt-1">{location.pointNumber}</div>
                    <button
                      onClick={() => openGoogleMapsNavigation(location.lat, location.lng)}
                      className="mt-3 w-full flex items-center justify-center gap-2 px-3 py-2 bg-green-600 text-white rounded-lg text-sm font-medium"
                    >
                      <Navigation className="h-4 w-4" />
                      ナビ開始
                    </button>
                  </div>
                </Popup>
              </Marker>
            )
          })}
        </MapContainer>

        {/* プロジェクト一覧パネル */}
        {showList && (
          <div className="absolute inset-0 bg-white z-20 overflow-auto">
            <div className="p-4">
              <h2 className="text-lg font-bold mb-4">プロジェクト一覧</h2>
              {projectsWithLocation.length === 0 ? (
                <p className="text-slate-500 text-center py-8">
                  座標が登録されたプロジェクトがありません
                </p>
              ) : (
                <div className="space-y-2">
                  {projectsWithLocation.map(project => {
                    const location = projectLocations.get(project.id)!
                    const isSelected = project.id === selectedProjectId
                    return (
                      <div
                        key={project.id}
                        onClick={() => handleListItemClick(project.id)}
                        className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-blue-50 border-blue-300'
                            : 'bg-white border-slate-200 hover:border-blue-200'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <MapPin className={`h-5 w-5 mt-0.5 ${isSelected ? 'text-blue-600' : 'text-red-500'}`} />
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold truncate">{project.name}</h3>
                            <p className="text-sm text-slate-500 truncate">
                              {project.description || '説明なし'}
                            </p>
                            <p className="text-xs text-slate-400 mt-1">
                              {location.pointNumber}
                            </p>
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              openGoogleMapsNavigation(location.lat, location.lng)
                            }}
                            className="p-2 bg-green-600 text-white rounded-full hover:bg-green-700"
                          >
                            <Navigation className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* 選択中のプロジェクト情報（フッター） */}
      {selectedProject && selectedLocation && !showList && (
        <div className="bg-white border-t p-4 z-10">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold truncate">{selectedProject.name}</h3>
              <p className="text-sm text-slate-500">{selectedLocation.pointNumber}</p>
            </div>
            <button
              onClick={() => openGoogleMapsNavigation(selectedLocation.lat, selectedLocation.lng)}
              className="flex items-center gap-2 px-4 py-3 bg-green-600 text-white rounded-lg font-medium"
            >
              <Navigation className="h-5 w-5" />
              ナビ開始
            </button>
          </div>
        </div>
      )}

      {/* 全体表示ボタン */}
      {selectedProjectId && !showList && (
        <button
          onClick={() => setSelectedProjectId(null)}
          className="absolute bottom-24 right-4 p-3 bg-white rounded-full shadow-lg border z-10"
          title="全体表示"
        >
          <MapPin className="h-5 w-5 text-slate-600" />
        </button>
      )}
    </div>
  )
}
