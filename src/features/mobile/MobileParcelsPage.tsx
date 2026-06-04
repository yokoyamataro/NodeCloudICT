// スマホ向け: 地籍（境界測量）の地番一覧 + 構成点登録ページ。
// 入口は MobileTopPage で project.category === 'cadastral' のとき
// /mobile/parcels?farmId=... へ遷移する。
//
// UX:
//   - 地番一覧（地番名・点数・面積）
//   - 地番をタップ → 編集モーダル
//     ・地番名 input（parcels.parcel_number へ upsert）
//     ・地図に当該工区の全座標がプロットされ、タップで対象地番への
//       追加 / 削除トグル（点番入力フォームは置かない）
//     ・地目・地積・所有者などの属性は 表示のみ
//   - 構成点の変更は addPoint/removePoint/reorderPoints が hasChanges を
//     立てるので、操作直後に saveAllWorkAreas で都度永続化

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, CircleMarker, Polygon, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  ArrowLeft, Plus, Loader2, Trash2, ChevronUp, ChevronDown, X, Save, Pencil,
} from 'lucide-react'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore, type WorkAreaRow } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'
import { FeedbackButton } from '@/components/layout/FeedbackButton'

function FitBoundsOnPoints({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  useEffect(() => {
    if (bounds) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 19 })
  }, [map, bounds])
  return null
}

export function MobileParcelsPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const { setCurrentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const {
    workAreas,
    loading,
    fetchWorkAreas,
    addWorkArea,
    deleteWorkArea,
    addPoint,
    removePoint,
    reorderPoints,
    saveAllWorkAreas,
  } = useWorkAreaStore()
  const parcelByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)
  const fetchParcels = useParcelStore((s) => s.fetchByWorkAreaIds)
  const upsertParcel = useParcelStore((s) => s.upsertParcel)

  const [farm, setFarm] = useState<Farm | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 工区情報を取得
  useEffect(() => {
    if (!farmId) {
      setPageError('farmId が指定されていません')
      return
    }
    void (async () => {
      const { data, error } = await supabase
        .from('farms')
        .select('*')
        .eq('id', farmId)
        .single()
      if (error) {
        setPageError(error.message)
        return
      }
      const f = data as Farm
      setFarm(f)
      setCurrentFarm(f)
      void fetchCoordinates(f.id)
      void fetchWorkAreas(f.id)
    })()
  }, [farmId, setCurrentFarm, fetchCoordinates, fetchWorkAreas])

  const project = useMemo(
    () => (farm ? projects.find((p) => p.id === farm.project_id) ?? null : null),
    [farm, projects],
  )

  // 当該工区の地番一覧
  const parcels: WorkAreaRow[] = workAreas['boundary_survey'] ?? []
  const editingArea = parcels.find((p) => p.id === editingAreaId) ?? null

  // 地番（design_work_areas）が変わるたびに parcels を取得
  useEffect(() => {
    if (parcels.length === 0) return
    void fetchParcels(parcels.map((p) => p.id))
    // 参照系の re-run 抑止のため id 集合で比較
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parcels.map((p) => p.id).join(','), fetchParcels])

  // 座標 → 緯度経度の変換マップ（工事の座標系で）
  const zone = project?.coordinate_zone ?? 13
  const coordLatLng = useMemo(() => {
    const conv = new CoordinateConverter(zone)
    const map = new Map<string, { lat: number; lng: number; pointNumber: string }>()
    for (const c of coordinates) {
      const { lat, lng } = conv.toLatLng(c.x, c.y)
      map.set(c.id, { lat, lng, pointNumber: c.pointNumber })
    }
    return map
  }, [coordinates, zone])

  // 地図のフィット用 bounds
  const mapBounds = useMemo<L.LatLngBoundsExpression | null>(() => {
    const lls = Array.from(coordLatLng.values())
    if (lls.length === 0) return null
    const lats = lls.map((l) => l.lat)
    const lngs = lls.map((l) => l.lng)
    return [
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    ]
  }, [coordLatLng])

  const mapCenter: [number, number] = useMemo(() => {
    const lls = Array.from(coordLatLng.values())
    if (lls.length === 0) return [43.06, 141.35]
    const lat = lls.reduce((s, l) => s + l.lat, 0) / lls.length
    const lng = lls.reduce((s, l) => s + l.lng, 0) / lls.length
    return [lat, lng]
  }, [coordLatLng])

  // 変更を都度サーバへ反映
  const persist = async () => {
    setSaving(true)
    try {
      await saveAllWorkAreas()
    } finally {
      setSaving(false)
    }
  }

  const parcelLabel = (a: WorkAreaRow): string => {
    const p = parcelByWorkAreaId.get(a.id)
    return p?.parcel_number || a.zoneNumber || a.name || '(無題)'
  }

  const handleAddParcel = async () => {
    const created = await addWorkArea('boundary_survey')
    if (created) {
      await persist()
      setEditingAreaId(created.id)
    }
  }

  const handleDeleteParcel = async (areaId: string) => {
    if (!confirm('この地番を削除しますか？')) return
    await deleteWorkArea(areaId)
    if (editingAreaId === areaId) setEditingAreaId(null)
  }

  // 地図のマーカータップで構成点の追加/削除をトグル
  const handleToggleCoord = async (areaId: string, coordId: string) => {
    const area = parcels.find((p) => p.id === areaId)
    if (!area) return
    if (area.pointIds.includes(coordId)) {
      removePoint(areaId, coordId)
    } else {
      const c = coordinates.find((cc) => cc.id === coordId)
      if (!c) return
      addPoint(areaId, {
        id: c.id,
        pointNumber: c.pointNumber,
        x: c.x,
        y: c.y,
        z: c.z,
      })
    }
    await persist()
  }

  const handleRemovePoint = async (areaId: string, pointId: string) => {
    removePoint(areaId, pointId)
    await persist()
  }

  const handleMove = async (areaId: string, fromIdx: number, dir: -1 | 1) => {
    const area = parcels.find((p) => p.id === areaId)
    if (!area) return
    const toIdx = fromIdx + dir
    if (toIdx < 0 || toIdx >= area.pointIds.length) return
    const ids = [...area.pointIds]
    const [m] = ids.splice(fromIdx, 1)
    ids.splice(toIdx, 0, m)
    reorderPoints(areaId, ids)
    await persist()
  }

  if (pageError) {
    return (
      <div className="mobile-min-screen flex flex-col bg-slate-100">
        <div className="px-3 py-2 bg-slate-800 text-white text-sm flex items-center gap-2">
          <button onClick={() => navigate('/mobile')} className="flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            戻る
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="p-4 bg-white rounded shadow text-red-600 text-sm">{pageError}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-screen flex flex-col">
      {/* ヘッダー */}
      <div className="px-2 py-1.5 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate('/mobile')}
          className="p-1 hover:bg-slate-700 rounded"
          title="戻る"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex-1 min-w-0 flex items-baseline gap-2">
          {project && (
            <span className="text-[11px] text-slate-300 truncate max-w-[40%]" title={project.name}>
              {project.name}
            </span>
          )}
          <span className="font-medium truncate flex-1" title={farm?.name ?? ''}>
            {farm?.name ?? '地番一覧'}
          </span>
        </div>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-300" />}
        <FeedbackButton variant="mobile" />
      </div>

      {/* 一覧 */}
      <div className="flex-1 overflow-auto bg-slate-50">
        {loading && parcels.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : parcels.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            地番がまだ登録されていません。下の「地番追加」から追加してください。
          </div>
        ) : (
          <ul className="divide-y bg-white">
            {parcels.map((p) => (
              <li key={p.id} className="px-3 py-3 flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{parcelLabel(p)}</div>
                  <div className="text-xs text-slate-500">
                    構成点 {p.pointIds.length} 点
                    {p.areaSqm != null && (
                      <span className="ml-2 font-mono">
                        {(Math.floor(p.areaSqm * 100) / 100).toFixed(2)} m²
                      </span>
                    )}
                  </div>
                </div>
                <button
                  onClick={() => setEditingAreaId(p.id)}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  <Pencil className="h-3.5 w-3.5" />
                  編集
                </button>
                <button
                  onClick={() => handleDeleteParcel(p.id)}
                  className="p-1.5 text-red-600 hover:bg-red-50 rounded"
                  title="地番を削除"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* 地番追加（末尾） */}
        <button
          onClick={handleAddParcel}
          disabled={loading}
          className="w-full flex items-center justify-center gap-1 px-3 py-3 text-sm text-blue-600 border-t hover:bg-blue-50 active:bg-blue-100 disabled:opacity-50 bg-white"
        >
          <Plus className="h-4 w-4" />
          地番追加
        </button>
      </div>

      {/* 地番編集モーダル */}
      {editingArea && (
        <ParcelEditModal
          area={editingArea}
          parcelNumber={parcelByWorkAreaId.get(editingArea.id)?.parcel_number ?? null}
          fallbackLabel={parcelLabel(editingArea)}
          attrs={parcelByWorkAreaId.get(editingArea.id) ?? null}
          coordLatLng={coordLatLng}
          mapBounds={mapBounds}
          mapCenter={mapCenter}
          saving={saving}
          onSaveParcelNumber={(value) =>
            upsertParcel(editingArea.id, {
              parcel_number: value.trim() || null,
            }).then(() => undefined)
          }
          onToggleCoord={(coordId) => handleToggleCoord(editingArea.id, coordId)}
          onRemovePoint={(pointId) => handleRemovePoint(editingArea.id, pointId)}
          onMovePoint={(idx, dir) => handleMove(editingArea.id, idx, dir)}
          onClose={() => setEditingAreaId(null)}
        />
      )}
    </div>
  )
}

interface ModalProps {
  area: WorkAreaRow
  parcelNumber: string | null
  fallbackLabel: string
  attrs: {
    registered_land_category: string | null
    registered_area_sqm: number | null
    updated_land_category: string | null
    updated_area_sqm: number | null
    owner_name: string | null
    owner_address: string | null
    attended_at: string | null
  } | null
  coordLatLng: Map<string, { lat: number; lng: number; pointNumber: string }>
  mapBounds: L.LatLngBoundsExpression | null
  mapCenter: [number, number]
  saving: boolean
  onSaveParcelNumber: (value: string) => Promise<void>
  onToggleCoord: (coordId: string) => void
  onRemovePoint: (pointId: string) => void
  onMovePoint: (idx: number, dir: -1 | 1) => void
  onClose: () => void
}

function ParcelEditModal({
  area,
  parcelNumber,
  fallbackLabel,
  attrs,
  coordLatLng,
  mapBounds,
  mapCenter,
  saving,
  onSaveParcelNumber,
  onToggleCoord,
  onRemovePoint,
  onMovePoint,
  onClose,
}: ModalProps) {
  const [nameDraft, setNameDraft] = useState(parcelNumber ?? '')
  useEffect(() => {
    setNameDraft(parcelNumber ?? '')
  }, [parcelNumber])

  const selectedSet = useMemo(() => new Set(area.pointIds), [area.pointIds])

  // 地番ポリゴンの位置（強調表示用）
  const polygonPositions = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = []
    for (const pid of area.pointIds) {
      const ll = coordLatLng.get(pid)
      if (ll) pts.push([ll.lat, ll.lng])
    }
    return pts
  }, [area.pointIds, coordLatLng])

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-[3000]"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl max-h-[95vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <h3 className="text-base font-semibold truncate">{parcelNumber || fallbackLabel}</h3>
            <div className="text-xs text-slate-500">地番名と構成点を編集</div>
          </div>
          {saving && <Loader2 className="h-4 w-4 animate-spin text-blue-500" />}
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-700 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* 地番名（編集可） */}
          <label className="block">
            <span className="text-[11px] font-medium text-slate-600 mb-1 block">地番名</span>
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={() => {
                if (nameDraft !== (parcelNumber ?? '')) {
                  void onSaveParcelNumber(nameDraft)
                }
              }}
              placeholder="地番"
              className="w-full px-2 py-1.5 text-sm border rounded"
            />
          </label>

          {/* 地図: タップで構成点を追加 / 削除 */}
          <div>
            <div className="text-[11px] font-medium text-slate-600 mb-1">
              構成点を地図上のマーカーをタップして追加 / 削除
            </div>
            <div className="h-72 w-full border rounded overflow-hidden">
              {coordLatLng.size === 0 ? (
                <div className="h-full flex items-center justify-center text-xs text-amber-700 bg-amber-50 px-3 text-center">
                  この工区にはまだ座標がありません。先に PC または SIMA 取込で
                  座標を登録してください。
                </div>
              ) : (
                <MapContainer
                  center={mapCenter}
                  zoom={18}
                  maxZoom={24}
                  className="h-full w-full"
                >
                  <TileLayer
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    maxZoom={24}
                    maxNativeZoom={19}
                  />
                  {mapBounds && <FitBoundsOnPoints bounds={mapBounds} />}
                  {/* 当該地番の輪郭ポリゴン（3 点以上で閉じる） */}
                  {polygonPositions.length >= 3 && (
                    <Polygon
                      positions={polygonPositions}
                      pathOptions={{
                        color: '#dc2626',
                        fillColor: '#dc2626',
                        fillOpacity: 0.15,
                        weight: 2,
                      }}
                    />
                  )}
                  {/* 全座標。当該地番に含まれる点は赤丸、他は青小丸 */}
                  {Array.from(coordLatLng.entries()).map(([id, ll]) => {
                    const selected = selectedSet.has(id)
                    return (
                      <CircleMarker
                        key={id}
                        center={[ll.lat, ll.lng]}
                        radius={selected ? 9 : 5}
                        pathOptions={{
                          color: selected ? '#dc2626' : '#1d4ed8',
                          fillColor: selected ? '#dc2626' : '#3b82f6',
                          fillOpacity: 0.9,
                          weight: 2,
                        }}
                        eventHandlers={{ click: () => onToggleCoord(id) }}
                      >
                        <Tooltip direction="top" offset={[0, -6]} opacity={0.9}>
                          {ll.pointNumber}
                        </Tooltip>
                      </CircleMarker>
                    )
                  })}
                </MapContainer>
              )}
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              赤丸 = 当該地番の構成点、青丸 = 未割当
            </div>
          </div>

          {/* 構成点リスト */}
          <div>
            <div className="text-[11px] font-medium text-slate-600 mb-1">
              構成点（{area.points.length} 点）
            </div>
            {area.points.length === 0 ? (
              <div className="py-3 text-center text-xs text-slate-500 border border-dashed rounded">
                構成点がありません。地図のマーカーをタップして追加してください。
              </div>
            ) : (
              <ul className="space-y-1">
                {area.points.map((point, index) => (
                  <li
                    key={point.id}
                    className="flex items-center gap-2 px-2 py-1.5 text-sm bg-white border rounded"
                  >
                    <span className="w-6 text-xs text-slate-500">{index + 1}.</span>
                    <span className="font-medium flex-1 truncate">{point.pointNumber}</span>
                    <span className="text-[10px] text-slate-400 truncate max-w-[40%]">
                      ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                    </span>
                    <button
                      onClick={() => onMovePoint(index, -1)}
                      disabled={index === 0}
                      className="p-1 text-slate-500 hover:bg-slate-100 rounded disabled:opacity-30"
                      title="上へ"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => onMovePoint(index, 1)}
                      disabled={index === area.points.length - 1}
                      className="p-1 text-slate-500 hover:bg-slate-100 rounded disabled:opacity-30"
                      title="下へ"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      onClick={() => onRemovePoint(point.id)}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 属性は表示のみ（編集は PC 側で） */}
          <div className="border rounded p-2 bg-slate-50">
            <div className="text-[11px] font-medium text-slate-600 mb-1">
              属性（表示のみ。編集は PC で）
            </div>
            <AttrRow label="登記地目" value={attrs?.registered_land_category} />
            <AttrRow
              label="登記地積"
              value={
                attrs?.registered_area_sqm != null
                  ? `${attrs.registered_area_sqm.toFixed(2)} m²`
                  : null
              }
            />
            <AttrRow label="変更地目" value={attrs?.updated_land_category} />
            <AttrRow
              label="変更地積"
              value={
                attrs?.updated_area_sqm != null
                  ? `${attrs.updated_area_sqm.toFixed(2)} m²`
                  : null
              }
            />
            <AttrRow label="所有者氏名" value={attrs?.owner_name} />
            <AttrRow label="所有者住所" value={attrs?.owner_address} />
            <AttrRow
              label="立会日時"
              value={attrs?.attended_at ? new Date(attrs.attended_at).toLocaleString('ja-JP') : null}
            />
            {area.areaSqm != null && (
              <AttrRow
                label="直角座標法面積"
                value={`${(Math.floor(area.areaSqm * 100) / 100).toFixed(2)} m²`}
              />
            )}
          </div>
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-end gap-2">
          <span className="flex-1 text-[10px] text-slate-500">
            変更は自動保存されます
            <Save className="inline-block h-3 w-3 ml-1" />
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}

function AttrRow({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2 text-xs py-0.5">
      <span className="w-20 text-slate-500 shrink-0">{label}</span>
      <span className="flex-1 text-slate-800 break-all">
        {value && value !== '' ? value : <span className="text-slate-400">-</span>}
      </span>
    </div>
  )
}
