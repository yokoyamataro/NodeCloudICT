import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Polygon, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, Monitor, LogOut, ArrowLeft, Plus, Edit3 } from 'lucide-react'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useAuth } from '@/contexts/AuthContext'
import { FarmEditModal } from '@/features/farms/FarmEditModal'
import { CurrentLocationLayer } from '@/components/map/CurrentLocationLayer'
import { setDisplayModeOverride } from '@/lib/displayMode'
import { FeedbackButton } from '@/components/layout/FeedbackButton'
import { MobileHamburgerMenu } from './MobileHamburgerMenu'
import {
  NewFarmFromParcelPanel,
  type NewFarmFromParcelSelection,
} from '@/features/projects/NewFarmFromParcelPanel'
import { importParcelBatch } from '@/features/parcel-maps/importParcelBatch'
import { useCoordinateStore } from '@/stores/coordinateStore'

const WORK_TYPE_COLORS: Record<string, string> = {
  boundary_survey: '#0ea5e9',
  underdrain: '#3b82f6',
  soil_import: '#f59e0b',
  simple_grading: '#8b5cf6',
  grading: '#10b981',
  subsoil: '#ec4899',
  stone_removal: '#6b7280',
}

// 完了時は緑色に切り替える。未完了は既定の青。
const createMarkerIcon = (completed = false): L.DivIcon => {
  const bg = completed ? '#10b981' : '#3b82f6'
  return L.divIcon({
    className: 'mobile-farm-marker',
    html: `<div style="
      background-color: ${bg};
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  })
}

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
  const { signOut, user, profile } = useAuth()
  const userLabel = profile?.full_name?.trim() || (user?.email ? user.email.split('@')[0] : '')
  const {
    farms: allFarms,
    loading: farmsLoading,
    fetchFarms,
    createFarm,
    updateFarm,
    deleteFarm,
    farmLocations,
    workAreaPolygons,
    fetchWorkAreaPolygons,
    setCurrentFarm,
  } = useFarmStore()
  const { projects, fetchProjects, setCurrentProject } = useProjectListStore()
  // 完了判定: farms.completed_at が真実の源。過去互換用に isFarmCompleted 関数だけ残す
  const isFarmCompleted = (farm: Farm) => farm.completed_at != null

  // 新規工区ダイアログ
  const [showNewFarmDialog, setShowNewFarmDialog] = useState(false)
  const [newFarmName, setNewFarmName] = useState('')
  const [newFarmDescription, setNewFarmDescription] = useState('')
  const [creatingFarm, setCreatingFarm] = useState(false)
  const [newFarmMode, setNewFarmMode] = useState<'normal' | 'from-parcel'>(
    'normal',
  )
  const [parcelSelection, setParcelSelection] =
    useState<NewFarmFromParcelSelection | null>(null)
  const [createFromParcelError, setCreateFromParcelError] = useState<string | null>(
    null,
  )

  // 完了工区を非表示にするかどうか (既定: 非表示)。PC の ProjectListPage と同じ localStorage キーを共有
  const [hideCompletedFarms, setHideCompletedFarms] = useState<boolean>(() => {
    try { return localStorage.getItem('projects:hideCompletedFarms') !== '0' } catch { return true }
  })
  useEffect(() => {
    try {
      localStorage.setItem('projects:hideCompletedFarms', hideCompletedFarms ? '1' : '0')
    } catch { /* ignore */ }
  }, [hideCompletedFarms])

  useEffect(() => {
    fetchFarms()
    fetchProjects()
  }, [fetchFarms, fetchProjects])

  // URL の projectId に該当する工事の工区のみ表示。完了フィルタ ON なら「完了」も除外。
  const farms = useMemo(() => {
    const list = routeProjectId
      ? allFarms.filter((f) => f.project_id === routeProjectId)
      : allFarms
    if (!hideCompletedFarms) return list
    return list.filter((f) => f.completed_at == null)
  }, [allFarms, routeProjectId, hideCompletedFarms])
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

  // 工区タップで直接工事測量画面へ (地籍・土木とも共通)
  const handleFarmClick = (farm: Farm) => {
    navigate(`/mobile/staking?farmId=${farm.id}`)
  }
  // 一覧右端の 編集ボタンで開く 工区編集モーダル (名前 / 説明 / 完了)
  const [editFarm, setEditFarm] = useState<Farm | null>(null)

  const closeNewFarmDialog = () => {
    setShowNewFarmDialog(false)
    setNewFarmName('')
    setNewFarmDescription('')
    setNewFarmMode('normal')
    setParcelSelection(null)
    setCreateFromParcelError(null)
  }

  const handleCreateNewFarm = async () => {
    if (!routeProjectId) {
      alert('工事が選択されていません')
      return
    }
    // 通常作成
    if (newFarmMode === 'normal') {
      if (!newFarmName.trim()) return
      setCreatingFarm(true)
      try {
        const created = await createFarm(
          routeProjectId,
          newFarmName.trim(),
          newFarmDescription.trim() || undefined,
        )
        closeNewFarmDialog()
        if (created) {
          navigate(`/mobile/staking?farmId=${created.id}`)
        }
      } finally {
        setCreatingFarm(false)
      }
      return
    }
    // 地番から作成
    if (!parcelSelection) return
    const nameToUse =
      newFarmName.trim() || parcelSelection.suggestedFarmName.trim()
    if (!nameToUse) return
    if (!currentProject) return
    setCreatingFarm(true)
    setCreateFromParcelError(null)
    try {
      const created = await createFarm(
        routeProjectId,
        nameToUse,
        newFarmDescription.trim() || undefined,
      )
      if (!created) {
        setCreateFromParcelError('工区の作成に失敗しました')
        return
      }
      // importParcelBatch は farm / zone をグローバルストアから読むので切替え + zone set
      setCurrentProject(currentProject)
      setCurrentFarm(created)
      useCoordinateStore.getState().setZone(currentProject.coordinate_zone)
      try {
        await importParcelBatch(
          [parcelSelection.feature],
          { farmId: created.id, zone: currentProject.coordinate_zone },
        )
      } catch (err) {
        console.error('[MobileTopPage] importParcelBatch failed', err)
        setCreateFromParcelError(
          err instanceof Error
            ? `工区は作成しましたが地番取込に失敗しました: ${err.message}`
            : '工区は作成しましたが地番取込に失敗しました',
        )
        return
      }
      closeNewFarmDialog()
      navigate(`/mobile/staking?farmId=${created.id}`)
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
        <MobileHamburgerMenu />
        {routeProjectId && (
          <button
            onClick={() => navigate('/mobile')}
            className="p-1 rounded hover:bg-slate-700"
            title="工事一覧"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <span className="font-medium truncate">
          {currentProject ? currentProject.name : '工区一覧（スマホ）'}
        </span>
        <button
          onClick={handleGoPC}
          className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700"
          title="PC表示へ切替"
        >
          <Monitor className="h-3.5 w-3.5" />
          PC表示
        </button>
        <div className="flex-1" />
        {userLabel && (
          <span className="text-[11px] text-slate-300 truncate max-w-[6rem]" title={user?.email ?? ''}>
            {userLabel}
          </span>
        )}
        <FeedbackButton variant="mobile" />
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
              .filter((polygon) => {
                if (!farms.some((f) => f.id === polygon.farmId)) return false
                // 地籍測量プロジェクトの工区一覧では、地番ポリゴン (boundary_survey) を
                // 描画しない。地番数が多く俯瞰の妨げになるため。土木工事は表示のまま。
                if (
                  currentProject?.category === 'cadastral' &&
                  polygon.workType === 'boundary_survey'
                ) {
                  return false
                }
                return true
              })
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
              const done = isFarmCompleted(farm)
              return (
                <Marker
                  key={farm.id}
                  position={[location.lat, location.lng]}
                  icon={createMarkerIcon(done)}
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
        {/* 完了工区フィルタ (既定: 非表示) */}
        <div className="px-3 py-1.5 border-b bg-slate-50 flex items-center text-xs text-slate-600">
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={!hideCompletedFarms}
              onChange={(e) => setHideCompletedFarms(!e.target.checked)}
              className="h-3.5 w-3.5"
            />
            <span>完了工区も表示</span>
          </label>
        </div>
        {farms.length === 0 ? (
          <div className="p-4 text-center text-sm text-slate-500">
            {hideCompletedFarms
              ? '工区がありません（完了工区は非表示中）。上のチェックで完了も表示できます。'
              : '工区がありません。下の「新規工区を追加」から作成してください。'}
          </div>
        ) : (
          <ul className="divide-y">
            {farms.map((farm) => {
              const done = isFarmCompleted(farm)
              return (
                <li
                  key={farm.id}
                  className={`flex items-stretch ${
                    done
                      ? 'bg-emerald-50 hover:bg-emerald-100 active:bg-emerald-200'
                      : 'hover:bg-slate-50 active:bg-blue-50'
                  }`}
                >
                  {/* 完了チェック (左端)。工区ナビゲーションを阻止 */}
                  <label
                    className="flex items-center pl-3 pr-1 cursor-pointer select-none"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={(e) => {
                        e.stopPropagation()
                        void updateFarm(farm.id, {
                          completed_at: e.target.checked ? new Date().toISOString() : null,
                        })
                      }}
                      className="h-4 w-4"
                    />
                  </label>
                  <button
                    onClick={() => handleFarmClick(farm)}
                    className="flex-1 min-w-0 flex items-center gap-2 pl-2 pr-2 py-3 text-left"
                  >
                    <span className="flex-1 truncate font-medium">{farm.name}</span>
                    {farm.description && (
                      <span className="text-[11px] text-slate-400 truncate max-w-[40%]">
                        {farm.description}
                      </span>
                    )}
                  </button>
                  {/* 右端: 編集ボタン (名前 / 説明 / 完了 の編集モーダルを開く) */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditFarm(farm)
                    }}
                    className="px-3 flex items-center text-slate-400 hover:text-blue-600 hover:bg-slate-100"
                    title="工区の編集"
                  >
                    <Edit3 className="h-4 w-4" />
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
      {showNewFarmDialog && (() => {
        const isCadastral = currentProject?.category === 'cadastral'
        const canSubmit =
          newFarmMode === 'normal'
            ? newFarmName.trim().length > 0
            : parcelSelection != null &&
              (newFarmName.trim() || parcelSelection.suggestedFarmName.trim())
                .length > 0
        return (
          <div className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]">
            <div className="bg-white w-full sm:max-w-sm rounded-t-xl sm:rounded-xl shadow-xl p-4 max-h-[92vh] overflow-y-auto">
              <h3 className="text-base font-semibold mb-2">新規工区</h3>
              {isCadastral && (
                <div className="flex border-b mb-3">
                  <button
                    onClick={() => setNewFarmMode('normal')}
                    className={`flex-1 py-2 text-sm font-medium border-b-2 ${
                      newFarmMode === 'normal'
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-500'
                    }`}
                  >
                    通常作成
                  </button>
                  <button
                    onClick={() => setNewFarmMode('from-parcel')}
                    className={`flex-1 py-2 text-sm font-medium border-b-2 ${
                      newFarmMode === 'from-parcel'
                        ? 'border-blue-600 text-blue-700'
                        : 'border-transparent text-slate-500'
                    }`}
                  >
                    地番から作成
                  </button>
                </div>
              )}
              {newFarmMode === 'from-parcel' && isCadastral ? (
                <div className="space-y-3">
                  <NewFarmFromParcelPanel
                    onSelectionChange={(sel) => {
                      setParcelSelection(sel)
                      if (sel && !newFarmName.trim()) {
                        setNewFarmName(sel.suggestedFarmName)
                      }
                    }}
                  />
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">
                      工区名{' '}
                      <span className="text-slate-400">(地番から自動入力・編集可)</span>
                    </label>
                    <input
                      type="text"
                      value={newFarmName}
                      onChange={(e) => setNewFarmName(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border rounded"
                      placeholder={
                        parcelSelection?.suggestedFarmName ?? '地番を選択すると自動入力されます'
                      }
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-600 mb-1">説明（任意）</label>
                    <textarea
                      value={newFarmDescription}
                      onChange={(e) => setNewFarmDescription(e.target.value)}
                      className="w-full px-2 py-1.5 text-sm border rounded h-12"
                    />
                  </div>
                  {createFromParcelError && (
                    <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                      {createFromParcelError}
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
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
              )}
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={closeNewFarmDialog}
                  disabled={creatingFarm}
                  className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleCreateNewFarm}
                  disabled={creatingFarm || !canSubmit}
                  className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {creatingFarm ? '作成中…' : '作成して開く'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 工区編集モーダル (右端の 編集ボタンで開く: 名前 / 説明 / 着手日 / 完成日 / 完了 / 削除) */}
      {editFarm && (
        <FarmEditModal
          farm={
            // farms 側 (allFarms) から最新の状態を再検索して常に最新を表示する
            allFarms.find((f) => f.id === editFarm.id) ?? editFarm
          }
          onUpdateFarm={(patch) => void updateFarm(editFarm.id, patch)}
          onClose={() => setEditFarm(null)}
          onDelete={async () => {
            const id = editFarm.id
            setEditFarm(null)
            try {
              await deleteFarm(id)
            } catch (err) {
              alert(err instanceof Error ? err.message : '工区の削除に失敗しました')
            }
          }}
        />
      )}
    </div>
  )
}

