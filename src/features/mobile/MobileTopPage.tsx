import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, Monitor, LogOut, Map as MapIcon, Navigation, X, Crosshair, ClipboardList } from 'lucide-react'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useAuth } from '@/contexts/AuthContext'
import { CurrentLocationLayer } from '@/components/map/CurrentLocationLayer'
import { setDisplayModeOverride } from '@/lib/displayMode'

const WORK_TYPE_COLORS: Record<string, string> = {
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
  const { signOut } = useAuth()
  const {
    farms,
    loading: farmsLoading,
    fetchFarms,
    farmLocations,
    workAreaPolygons,
    fetchWorkAreaPolygons,
  } = useFarmStore()

  // 圃場クリック時のアクション選択ダイアログ
  const [actionFarm, setActionFarm] = useState<Farm | null>(null)

  useEffect(() => {
    fetchFarms()
  }, [fetchFarms])

  useEffect(() => {
    if (farms.length > 0) fetchWorkAreaPolygons()
  }, [farms, fetchWorkAreaPolygons])

  const allBounds = useMemo(() => {
    const locs = Array.from(farmLocations.values())
    if (locs.length === 0) return null
    const lats = locs.map((l) => l.lat)
    const lngs = locs.map((l) => l.lng)
    return L.latLngBounds([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)])
  }, [farmLocations])

  const mapCenter = useMemo(() => {
    const locs = Array.from(farmLocations.values())
    if (locs.length === 0) return { lat: 43.06, lng: 141.35 }
    const avgLat = locs.reduce((s, l) => s + l.lat, 0) / locs.length
    const avgLng = locs.reduce((s, l) => s + l.lng, 0) / locs.length
    return { lat: avgLat, lng: avgLng }
  }, [farmLocations])

  const handleFarmClick = (farm: Farm) => {
    setActionFarm(farm)
  }

  const handleOpenMap = (farm: Farm) => {
    setActionFarm(null)
    navigate(`/mobile/map?farmId=${farm.id}`)
  }

  const handleOpenStaking = (farm: Farm) => {
    setActionFarm(null)
    navigate(`/mobile/staking?farmId=${farm.id}`)
  }

  const handleOpenDirections = (farm: Farm) => {
    const loc = farmLocations.get(farm.id)
    if (!loc) return
    setActionFarm(null)
    const url = `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}`
    window.open(url, '_blank')
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
        <span className="font-medium">圃場一覧（スマホ）</span>
        <div className="ml-auto flex items-center gap-2">
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
      </div>

      <div className="flex-1 relative">
        {farmLocations.size === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            位置情報のある圃場がありません
          </div>
        ) : (
          <MapContainer
            center={[mapCenter.lat, mapCenter.lng]}
            zoom={12}
            maxZoom={22}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              maxZoom={22}
              maxNativeZoom={19}
            />
            {allBounds && <FitBounds bounds={allBounds} />}
            <CurrentLocationLayer />
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

      {/* 圃場アクション選択 */}
      {actionFarm && (
        <div
          className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-[2000]"
          onClick={() => setActionFarm(null)}
        >
          <div
            className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs text-slate-500">圃場</div>
                <div className="text-base font-bold">{actionFarm.name}</div>
              </div>
              <button
                onClick={() => setActionFarm(null)}
                className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-2">
              <button
                onClick={() => handleOpenMap(actionFarm)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
              >
                <MapIcon className="h-5 w-5" />
                地図を見る
              </button>
              <button
                onClick={() => handleOpenStaking(actionFarm)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm font-medium"
              >
                <Crosshair className="h-5 w-5" />
                工事測量（RTK-GNSS）
              </button>
              <button
                onClick={() => {
                  setActionFarm(null)
                  navigate(`/mobile/points?farmId=${actionFarm.id}`)
                }}
                className="w-full flex items-center gap-3 px-4 py-3 bg-slate-700 text-white rounded-lg hover:bg-slate-800 text-sm font-medium"
              >
                <ClipboardList className="h-5 w-5" />
                測点一覧
              </button>
              <button
                onClick={() => handleOpenDirections(actionFarm)}
                className="w-full flex items-center gap-3 px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-medium"
              >
                <Navigation className="h-5 w-5" />
                道案内（Google マップ）
              </button>
              <button
                onClick={() => setActionFarm(null)}
                className="w-full px-4 py-2.5 border rounded-lg hover:bg-slate-50 text-sm"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
