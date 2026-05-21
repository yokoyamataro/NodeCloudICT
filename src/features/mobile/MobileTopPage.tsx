import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, Monitor, LogOut, ArrowLeft, MapPin, Plus } from 'lucide-react'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useAuth } from '@/contexts/AuthContext'
import { CurrentLocationLayer } from '@/components/map/CurrentLocationLayer'
import { setDisplayModeOverride } from '@/lib/displayMode'

const WORK_TYPE_COLORS: Record<string, string> = {
  boundary_survey: '#0ea5e9',
  underdrain: '#3b82f6',
  soil_import: '#f59e0b',
  simple_grading: '#8b5cf6',
  grading: '#10b981',
  subsoil: '#ec4899',
  stone_removal: '#6b7280',
}

const createMarkerIcon = (): L.DivIcon =>
  L.divIcon({
    className: 'mobile-farm-marker',
    html: `<div style="
      background-color: #3b82f6;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })

function FitBounds({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 })
    }
  }, [map, bounds])
  return null
}

export function MobileTopPage() {
  const navigate = useNavigate()
  const { projectId: routeProjectId } = useParams<{ projectId: string }>()
  const { signOut, user } = useAuth()
  const userLabel = user?.email ? user.email.split('@')[0] : ''
  const {
    farms: allFarms,
    loading: farmsLoading,
    fetchFarms,
    createFarm,
    farmLocations,
    workAreaPolygons,
    fetchWorkAreaPolygons,
  } = useFarmStore()
  const { projects, fetchProjects } = useProjectListStore()

  // 新規工区ダイアログ
  const [showNewFarmDialog, setShowNewFarmDialog] = useState(false)
  const [newFarmName, setNewFarmName] = useState('')
  const [newFarmDescription, setNewFarmDescription] = useState('')
  const [creatingFarm, setCreatingFarm] = useState(false)

  useEffect(() => {
    fetchFarms()
    fetchProjects()
  }, [fetchFarms, fetchProjects])

  // URL の projectId に該当する工事の工区のみ表示
  const farms = useMemo(
    () => (routeProjectId ? allFarms.filter((f) => f.project_id === routeProjectId) : allFarms),
    [allFarms, routeProjectId],
  )
  const currentProject = useMemo(
    () => (routeProjectId ? projects.find((p) => p.id === routeProjectId) : null),
    [projects, routeProjectId],
  )

  useEffect(() => {
    if (farms.length > 0) fetchWorkAreaPolygons()
  }, [farms, fetchWorkAreaPolygons])

  // 当該工事の工区の位置情報のみ抽出
  const projectFarmLocations = useMemo(() => {
    return farms
      .map((f) => farmLocations.get(f.id))
      .filter((l): l is NonNullable<typeof l> => l != null)
  }, [farms, farmLocations])

  const allBounds = useMemo(() => {
    if (projectFarmLocations.length === 0) return null
    const lats = projectFarmLocations.map((l) => l.lat)
    const lngs = projectFarmLocations.map((l) => l.lng)
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)])
  }, [projectFarmLocations])

  const mapCenter = useMemo(() => {
    if (projectFarmLocations.length === 0) return { lat: 43.06, lng: 141.35 }
    const avgLat = projectFarmLocations.reduce((s, l) => s + l.lat, 0) / projectFarmLocations.length
    const avgLng = projectFarmLocations.reduce((s, l) => s + l.lng, 0) / projectFarmLocations.length
    return { lat: avgLat, lng: avgLng }
  }, [projectFarmLocations])

  // 工区タップで直接工事測量画面へ
  const handleFarmClick = (farm: Farm) => {
    navigate(`/mobile/staking?farmId=${farm.id}`)
  }

  const handleCreateNewFarm = async () => {
    if (!routeProjectId) {
      alert('工事が選択されていません')
      return
    }
    if (!newFarmName.trim()) return
    setCreatingFarm(true)
    try {
      const created = await createFarm(
        routeProjectId,
        newFarmName.trim(),
        newFarmDescription.trim() || undefined,
      )
      setNewFarmName('')
      setNewFarmDescription('')
      setShowNewFarmDialog(false)
      if (created) {
        navigate(`/mobile/staking?farmId=${created.id}`)
      }
    } finally {
      setCreatingFarm(false)
    }
  }

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

  if (farmsLoading && farms.length === 0) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="mobile-screen flex flex-col">
      <div className="px-3 py-2 bg-slate-800 text-white flex items-center gap-2 text-sm">
        {routeProjectId && (
          <button
            onClick={() => navigate('/mobile')}
            className="p-1 rounded hover:bg-slate-700"
            title="工事一覧"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <span className="font-medium truncate flex-1">
          {currentProject ? currentProject.name : '工区一覧（スマホ）'}
        </span>
        {userLabel && (
          <span className="text-[11px] text-slate-300 truncate max-w-[6rem]" title={user?.email ?? ''}>
            {userLabel}
          </span>
        )}
        <button
          onClick={handleGoPC}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700"
          title="PC表示へ切替"
        >
          <Monitor className="h-3.5 w-3.5" />
          PC表示
        </button>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700"
          title="ログアウト"
        >
          <LogOut className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 地図（上半分） */}
      <div className="h-1/2 min-h-[200px] relative bg-slate-200">
        {projectFarmLocations.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            位置情報のある工区がありません
          </div>
        ) : (
          <MapContainer
            center={[mapCenter.lat, mapCenter.lng]}
            zoom={12}
            maxZoom={24}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={24}
              maxNativeZoom={19}
            />
            {allBounds && <FitBounds bounds={allBounds} />}
            <CurrentLocationLayer />
            {workAreaPolygons
              .filter((polygon) => farms.some((f) => f.id === polygon.farmId))
              .map((polygon) => (
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
            {farms.map((farm) => {
              const location = farmLocations.get(farm.id)
              if (!location) return null
              return (
                <Marker
                  key={farm.id}
                  position={[location.lat, location.lng]}
                  icon={createMarkerIcon()}
                  eventHandlers={{ click: () => handleFarmClick(farm) }}
                >
                  <Tooltip permanent direction="top" offset={[0, -16]}>
                    {farm.name}
                  </Tooltip>
                </Marker>
              )
            })}
          </MapContainer>
        )}
      </div>

      {/* 工区一覧（下半分）+ 末尾に新規作成 */}
      <div className="flex-1 overflow-auto bg-white border-t">
        {farms.length === 0 ? (
          <div className="p-4 text-center text-sm text-slate-500">
            工区がありません。下の「新規工区を追加」から作成してください。
          </div>
        ) : (
          <ul className="divide-y">
            {farms.map((farm) => {
              const location = farmLocations.get(farm.id)
              return (
                <li key={farm.id}>
                  <button
                    onClick={() => handleFarmClick(farm)}
                    className="w-full flex items-center gap-2 px-3 py-3 text-left hover:bg-slate-50 active:bg-blue-50"
                  >
                    <MapPin
                      className={`h-4 w-4 flex-shrink-0 ${
                        location ? 'text-blue-600' : 'text-slate-300'
                      }`}
                    />
                    <span className="flex-1 truncate font-medium">{farm.name}</span>
                    {farm.description && (
                      <span className="text-[11px] text-slate-400 truncate max-w-[40%]">
                        {farm.description}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {/* 新規工区作成（一覧末尾） */}
        {routeProjectId && (
          <button
            onClick={() => setShowNewFarmDialog(true)}
            className="w-full flex items-center justify-center gap-1 px-3 py-3 text-sm text-blue-600 border-t hover:bg-blue-50 active:bg-blue-100"
          >
            <Plus className="h-4 w-4" />
            新規工区を追加
          </button>
        )}
      </div>

      {/* 新規工区ダイアログ */}
      {showNewFarmDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
          <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4">
            <h3 className="text-base font-semibold mb-3">新規工区</h3>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs text-slate-600 mb-1">工区名</label>
                <input
                  type="text"
                  value={newFarmName}
                  onChange={(e) => setNewFarmName(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border rounded"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">説明（任意）</label>
                <textarea
                  value={newFarmDescription}
                  onChange={(e) => setNewFarmDescription(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm border rounded h-16"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowNewFarmDialog(false)}
                disabled={creatingFarm}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={handleCreateNewFarm}
                disabled={creatingFarm || !newFarmName.trim()}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {creatingFarm ? '作成中…' : '作成して開く'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
