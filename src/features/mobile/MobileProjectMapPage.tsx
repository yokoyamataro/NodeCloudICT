import { useEffect, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Navigation, MapPin, List, RefreshCw, Loader2, Locate } from 'lucide-react'
import { useFarmStore, type FarmLocation } from '@/stores/farmStore'

// カスタムマーカーアイコン（ラベル付き）
const createMarkerIcon = (isSelected: boolean = false, label?: string): L.DivIcon => {
  const size = isSelected ? 32 : 24
  const color = isSelected ? '#2563eb' : '#ef4444'
  const labelHtml = label ? `
    <div style="
      position: absolute;
      bottom: ${size + 4}px;
      left: 50%;
      transform: translateX(-50%);
      background-color: white;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: bold;
      white-space: nowrap;
      box-shadow: 0 1px 4px rgba(0,0,0,0.3);
      border: 1px solid ${color};
      color: ${isSelected ? '#1e40af' : '#b91c1c'};
    ">${label}</div>
  ` : ''
  return L.divIcon({
    className: 'custom-marker',
    html: `
      <div style="position: relative;">
        ${labelHtml}
        <div style="
          background-color: ${color};
          width: ${size}px;
          height: ${size}px;
          border-radius: 50%;
          border: 3px solid white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.5);
        "></div>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 自己位置マーカーアイコン
const createUserLocationIcon = (): L.DivIcon => {
  return L.divIcon({
    className: 'user-location-marker',
    html: `
      <div style="position: relative;">
        <div style="
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 40px;
          height: 40px;
          background-color: rgba(59, 130, 246, 0.2);
          border-radius: 50%;
          animation: pulse 2s infinite;
        "></div>
        <div style="
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          width: 16px;
          height: 16px;
          background-color: #3b82f6;
          border: 3px solid white;
          border-radius: 50%;
          box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        "></div>
      </div>
    `,
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

// 地図の境界を全プロジェクトに合わせる
function FitBoundsToFarms({ locations }: { locations: FarmLocation[] }) {
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
function FocusOnFarm({ location }: { location: FarmLocation | null }) {
  const map = useMap()

  useEffect(() => {
    if (location) {
      map.setView([location.lat, location.lng], 17, { animate: true })
    }
  }, [location, map])

  return null
}

// 自己位置にフォーカス
function FocusOnUserLocation({ userLocation }: { userLocation: { lat: number; lng: number } | null }) {
  const map = useMap()

  useEffect(() => {
    if (userLocation) {
      map.setView([userLocation.lat, userLocation.lng], 16, { animate: true })
    }
  }, [userLocation, map])

  return null
}

export function MobileFarmMapPage() {
  const { farms, loading, fetchFarms, farmLocations } = useFarmStore()
  const [selectedFarmId, setSelectedFarmId] = useState<string | null>(null)
  const [showList, setShowList] = useState(false)
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number; accuracy: number } | null>(null)
  const [watchingLocation, setWatchingLocation] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [focusOnUser, setFocusOnUser] = useState(false)

  useEffect(() => {
    fetchFarms()
  }, [fetchFarms])

  // GPS位置情報の監視
  useEffect(() => {
    if (!watchingLocation) return

    if (!navigator.geolocation) {
      setLocationError('お使いのブラウザは位置情報に対応していません')
      setWatchingLocation(false)
      return
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setUserLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        })
        setLocationError(null)
      },
      (error) => {
        switch (error.code) {
          case error.PERMISSION_DENIED:
            setLocationError('位置情報の使用が許可されていません')
            break
          case error.POSITION_UNAVAILABLE:
            setLocationError('位置情報を取得できません')
            break
          case error.TIMEOUT:
            setLocationError('位置情報の取得がタイムアウトしました')
            break
          default:
            setLocationError('位置情報の取得に失敗しました')
        }
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0,
      }
    )

    return () => {
      navigator.geolocation.clearWatch(watchId)
    }
  }, [watchingLocation])

  const toggleLocationTracking = () => {
    if (watchingLocation) {
      setWatchingLocation(false)
      setUserLocation(null)
      setFocusOnUser(false)
    } else {
      setWatchingLocation(true)
      setFocusOnUser(true)
    }
  }

  const handleFocusOnUser = () => {
    if (userLocation) {
      setFocusOnUser(true)
      setSelectedFarmId(null)
      // フォーカス後にリセット
      setTimeout(() => setFocusOnUser(false), 100)
    }
  }

  const locations = Array.from(farmLocations.values())
  const selectedLocation = selectedFarmId ? farmLocations.get(selectedFarmId) : null
  const selectedFarm = selectedFarmId ? farms.find(p => p.id === selectedFarmId) : null

  const openGoogleMapsNavigation = (lat: number, lng: number) => {
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`
    window.open(url, '_blank')
  }

  const handleMarkerClick = (farmId: string) => {
    setSelectedFarmId(farmId)
    setShowList(false)
  }

  const handleListItemClick = (farmId: string) => {
    setSelectedFarmId(farmId)
    setShowList(false)
  }

  if (loading && farms.length === 0) {
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
  const farmsWithLocation = farms.filter(p => farmLocations.has(p.id))

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
            onClick={() => fetchFarms()}
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

          {!selectedFarmId && !focusOnUser && <FitBoundsToFarms locations={locations} />}
          {selectedLocation && <FocusOnFarm location={selectedLocation} />}
          {focusOnUser && <FocusOnUserLocation userLocation={userLocation} />}

          {/* 自己位置マーカー */}
          {userLocation && (
            <>
              {/* 精度を示す円 */}
              <CircleMarker
                center={[userLocation.lat, userLocation.lng]}
                radius={Math.min(userLocation.accuracy / 2, 50)}
                pathOptions={{
                  color: '#3b82f6',
                  fillColor: '#3b82f6',
                  fillOpacity: 0.1,
                  weight: 1,
                }}
              />
              {/* 自己位置マーカー */}
              <Marker
                position={[userLocation.lat, userLocation.lng]}
                icon={createUserLocationIcon()}
                zIndexOffset={1000}
              >
                <Popup>
                  <div className="text-sm">
                    <div className="font-bold">現在地</div>
                    <div className="text-slate-500">精度: 約{Math.round(userLocation.accuracy)}m</div>
                  </div>
                </Popup>
              </Marker>
            </>
          )}

          {/* プロジェクトマーカー */}
          {locations.map(location => {
            const farm = farms.find(p => p.id === location.farmId)
            const isSelected = location.farmId === selectedFarmId
            return (
              <Marker
                key={location.farmId}
                position={[location.lat, location.lng]}
                icon={createMarkerIcon(isSelected, farm?.name)}
                eventHandlers={{
                  click: () => handleMarkerClick(location.farmId),
                }}
              >
                <Popup>
                  <div className="text-sm min-w-[200px]">
                    <div className="font-bold text-base">{farm?.name}</div>
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
              {farmsWithLocation.length === 0 ? (
                <p className="text-slate-500 text-center py-8">
                  座標が登録されたプロジェクトがありません
                </p>
              ) : (
                <div className="space-y-2">
                  {farmsWithLocation.map(farm => {
                    const location = farmLocations.get(farm.id)!
                    const isSelected = farm.id === selectedFarmId
                    return (
                      <div
                        key={farm.id}
                        onClick={() => handleListItemClick(farm.id)}
                        className={`p-4 rounded-lg border cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-blue-50 border-blue-300'
                            : 'bg-white border-slate-200 hover:border-blue-200'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <MapPin className={`h-5 w-5 mt-0.5 ${isSelected ? 'text-blue-600' : 'text-red-500'}`} />
                          <div className="flex-1 min-w-0">
                            <h3 className="font-semibold truncate">{farm.name}</h3>
                            <p className="text-sm text-slate-500 truncate">
                              {farm.description || '説明なし'}
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
      {selectedFarm && selectedLocation && !showList && (
        <div className="bg-white border-t p-4 z-10">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <h3 className="font-bold truncate">{selectedFarm.name}</h3>
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

      {/* フローティングボタン群 */}
      {!showList && (
        <div className="absolute bottom-24 right-4 flex flex-col gap-2 z-10">
          {/* 現在地ボタン */}
          <button
            onClick={watchingLocation ? handleFocusOnUser : toggleLocationTracking}
            onDoubleClick={toggleLocationTracking}
            className={`p-3 rounded-full shadow-lg border transition-colors ${
              watchingLocation
                ? 'bg-blue-500 text-white border-blue-500'
                : 'bg-white text-slate-600 border-slate-200'
            }`}
            title={watchingLocation ? '現在地にフォーカス（ダブルクリックで停止）' : '現在地を表示'}
          >
            <Locate className="h-5 w-5" />
          </button>

          {/* 全体表示ボタン */}
          {selectedFarmId && (
            <button
              onClick={() => setSelectedFarmId(null)}
              className="p-3 bg-white rounded-full shadow-lg border border-slate-200"
              title="全体表示"
            >
              <MapPin className="h-5 w-5 text-slate-600" />
            </button>
          )}
        </div>
      )}

      {/* 位置情報エラー表示 */}
      {locationError && (
        <div className="absolute top-16 left-4 right-4 bg-red-50 border border-red-200 rounded-lg p-3 z-20">
          <p className="text-sm text-red-600">{locationError}</p>
          <button
            onClick={() => setLocationError(null)}
            className="text-xs text-red-500 underline mt-1"
          >
            閉じる
          </button>
        </div>
      )}

      {/* CSSアニメーション */}
      <style>{`
        @keyframes pulse {
          0% {
            transform: translate(-50%, -50%) scale(1);
            opacity: 1;
          }
          100% {
            transform: translate(-50%, -50%) scale(2);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  )
}
