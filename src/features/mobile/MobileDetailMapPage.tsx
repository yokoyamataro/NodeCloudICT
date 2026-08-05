import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  Loader2,
  ArrowLeft,
  Layers,
  Crosshair,
  Image as ImageIcon,
  Map as MapIcon,
  Download,
  X,
} from 'lucide-react'
import type { Feature, Polygon } from 'geojson'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'
import { UnifiedFieldMap, type BaseLayerType, type LayerVisibility } from '@/components/map/UnifiedFieldMap'
import { ParcelMapLayer, parcelFeatureKey } from '@/components/map/ParcelMapLayer'
import type { Project } from '@/types/database'
import type { ParcelFeatureProperties } from '@/lib/jpgis-to-geojson'
import { type Bbox } from '@/lib/tile-math'
import { importParcelBatch } from '@/features/parcel-maps/importParcelBatch'
import { FeedbackButton } from '@/components/layout/FeedbackButton'
import { MobileHamburgerMenu } from './MobileHamburgerMenu'


export function MobileDetailMapPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const { setCurrentFarm } = useFarmStore()
  const { setZone, fetchCoordinates, fetchRoute } = useCoordinateStore()
  const { fetchPipes } = useUnderdrainStore()
  const { fetchWorkAreas } = useWorkAreaStore()
  const { fetchSurveyData } = useSurveyStore()
  const { fetchPlan } = useConstructionPlanStore()

  const [farm, setFarm] = useState<Farm | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [baseLayer, setBaseLayer] = useState<BaseLayerType>('gsi-photo')
  const [layers, setLayers] = useState<LayerVisibility>({
    coordinatePoints: true,
    pipes: true,
    pipeNumbers: true,
    pipeMeasurementPoints: true,
    surveyPoints: true,
    stakingRecords: true,
    workAreas: true,
    route: true,
    currentLocation: true,
    orthophoto: true,
  })
  const [showLayerPanel, setShowLayerPanel] = useState(false)

  // ---- 法務省地図 (地番マップ) レイヤ ----
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchParcelDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  const hasActiveParcelDataset = parcelDatasets.some((d) => d.active)
  const [showParcelLayer, setShowParcelLayer] = useState(false)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedParcels, setSelectedParcels] = useState<
    Map<string, Feature<Polygon, ParcelFeatureProperties>>
  >(new Map())
  const [parcelBusy, setParcelBusy] = useState(false)
  const [parcelMessage, setParcelMessage] = useState<string | null>(null)
  const selectedParcelKeys = useMemo(
    () => new Set(selectedParcels.keys()),
    [selectedParcels],
  )
  const toggleSelectedParcel = useCallback(
    (feature: Feature<Polygon, ParcelFeatureProperties>) => {
      const key = parcelFeatureKey(feature)
      setSelectedParcels((prev) => {
        const next = new Map(prev)
        if (next.has(key)) next.delete(key)
        else next.set(key, feature)
        return next
      })
    },
    [],
  )
  const clearSelection = () => setSelectedParcels(new Map())

  useEffect(() => {
    void fetchParcelDatasets()
  }, [fetchParcelDatasets])

  const { workAreas } = useWorkAreaStore()
  const parcelsByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)

  const isCadastralProject = project?.category === 'cadastral'

  // 常に「現在の地図ビュー」に追従する (以前は 工区+Nm プリセットがあったが、
  // features 数が数千〜数万に膨れてラベル bind が固まる原因になるため撤去)
  const effectiveParcelBbox: Bbox | null =
    (farm?.parcel_map_bbox as Bbox | null | undefined) ?? null

  // 取込済 "所在|地番" セット
  const importedParcelKeys = useMemo(() => {
    const s = new Set<string>()
    for (const p of parcelsByWorkAreaId.values()) {
      if (!p.parcel_number) continue
      s.add(`${p.location ?? ''}|${p.parcel_number}`)
    }
    const areas = workAreas['boundary_survey'] ?? []
    for (const a of areas) {
      if (a.name) s.add(`|${a.name}`)
      if (a.zoneNumber && a.zoneNumber !== a.name) s.add(`|${a.zoneNumber}`)
    }
    return s
  }, [parcelsByWorkAreaId, workAreas])

  const handleImportParcelBatch = async (
    features: Feature<Polygon, ParcelFeatureProperties>[],
  ) => {
    if (!farm || !project) return
    if (features.length === 0) return
    setParcelBusy(true)
    setParcelMessage(null)
    try {
      const result = await importParcelBatch(features, {
        farmId: farm.id,
        zone: project.coordinate_zone,
      })
      setSelectedParcels(new Map())
      setParcelMessage(result.message)
    } catch (err) {
      console.error(err)
      setParcelMessage(err instanceof Error ? err.message : '取込に失敗しました')
    } finally {
      setParcelBusy(false)
    }
  }

  useEffect(() => {
    if (!farmId) {
      setError('URL に farmId が指定されていません')
      setLoading(false)
      return
    }

    let cancelled = false
    ;(async () => {
      try {
        setLoading(true)
        const { data: farmData, error: farmErr } = await supabase
          .from('farms')
          .select('*')
          .eq('id', farmId)
          .single()
        if (farmErr) throw farmErr
        if (cancelled) return
        const typedFarm = farmData as Farm
        setFarm(typedFarm)
        setCurrentFarm(typedFarm)

        if (typedFarm.project_id) {
          const { data: projData } = await supabase
            .from('projects')
            .select('*')
            .eq('id', typedFarm.project_id)
            .single()
          if (!cancelled && projData) {
            const typedProj = projData as Project
            setProject(typedProj)
            useProjectListStore.setState({ currentProject: typedProj })
            setZone(typedProj.coordinate_zone)
          }
        }

        await Promise.all([
          fetchCoordinates(typedFarm.id),
          fetchRoute(typedFarm.id),
          fetchPipes(typedFarm.id),
          fetchWorkAreas(typedFarm.id),
          fetchSurveyData(typedFarm.id),
          fetchPlan(typedFarm.id),
        ])
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '工区データの取得に失敗しました')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [
    farmId,
    setCurrentFarm,
    setZone,
    fetchCoordinates,
    fetchRoute,
    fetchPipes,
    fetchWorkAreas,
    fetchSurveyData,
    fetchPlan,
  ])

  const title = useMemo(() => {
    if (!farm) return '現場地図'
    return project ? `${project.name} / ${farm.name}` : farm.name
  }, [farm, project])

  const toggleLayer = (key: keyof LayerVisibility) => {
    setLayers((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  if (loading) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="mobile-min-screen flex flex-col bg-slate-100">
        <div className="px-3 py-2 bg-slate-800 text-white text-sm flex items-center">
          <button onClick={() => navigate('/mobile')} className="flex items-center gap-1">
            <ArrowLeft className="h-4 w-4" />
            戻る
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center p-4">
          <div className="p-4 bg-white rounded shadow text-red-600 text-sm">{error}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="mobile-screen flex flex-col">
      <div className="px-2 py-2 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <MobileHamburgerMenu />
        <button
          onClick={() => navigate('/mobile')}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700"
          title="戻る"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-medium truncate flex-1">{title}</span>
        <button
          onClick={() => setLayers((prev) => ({ ...prev, orthophoto: !prev.orthophoto }))}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
            layers.orthophoto
              ? 'bg-emerald-600 border-emerald-400'
              : 'bg-slate-700 border-slate-500 hover:bg-slate-600'
          }`}
          title="オルソ画像の表示を切替"
        >
          <ImageIcon className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() =>
            setLayers((prev) => ({ ...prev, currentLocation: !prev.currentLocation }))
          }
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
            layers.currentLocation
              ? 'bg-blue-600 border-blue-400'
              : 'bg-slate-700 border-slate-500 hover:bg-slate-600'
          }`}
          title="現在位置の表示を切替"
        >
          <Crosshair className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={() => setShowLayerPanel((s) => !s)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
            showLayerPanel
              ? 'bg-blue-600 border-blue-400'
              : 'bg-slate-700 border-slate-500 hover:bg-slate-600'
          }`}
        >
          <Layers className="h-3.5 w-3.5" />
        </button>
        {/* 法務省地図 (地籍測量プロジェクトのみ、公開データセット有り時のみ) */}
        {isCadastralProject && hasActiveParcelDataset && (
          <button
            onClick={() => {
              setShowParcelLayer((v) => {
                const next = !v
                if (!next) {
                  setSelectionMode(false)
                  clearSelection()
                }
                return next
              })
            }}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showParcelLayer
                ? 'bg-orange-500 border-orange-400'
                : 'bg-slate-700 border-slate-500 hover:bg-slate-600'
            }`}
            title="法務省地図データを背景に表示する"
          >
            <MapIcon className="h-3.5 w-3.5" />
          </button>
        )}
        <select
          value={baseLayer}
          onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
          className="px-2 py-1 text-xs border border-slate-500 bg-slate-700 text-white rounded"
        >
          <option value="osm">地図</option>
          <option value="gsi-photo">航空写真</option>
          <option value="gsi-std">地理院地図</option>
        </select>
        <FeedbackButton variant="mobile" />
      </div>

      {/* 地番データ取込用のサブメニュー (法務省地図 ON 時のみ) */}
      {isCadastralProject && hasActiveParcelDataset && showParcelLayer && (
        <div className="px-2 py-1.5 bg-slate-700 text-white flex items-center gap-2 text-xs border-b border-slate-600">
          <button
            onClick={() => {
              if (!selectionMode) {
                setSelectionMode(true)
              } else if (selectedParcels.size === 0) {
                setSelectionMode(false)
              } else {
                void (async () => {
                  await handleImportParcelBatch(
                    Array.from(selectedParcels.values()),
                  )
                  setSelectionMode(false)
                })()
              }
            }}
            disabled={parcelBusy}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              !selectionMode
                ? 'bg-slate-800 border-slate-500'
                : selectedParcels.size === 0
                  ? 'bg-blue-600 border-blue-400'
                  : 'bg-emerald-600 border-emerald-400'
            } disabled:opacity-50`}
          >
            {parcelBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {!selectionMode
              ? '地番データ取込'
              : selectedParcels.size === 0
                ? '選択中… (キャンセル)'
                : `取り込む (${selectedParcels.size} 件)`}
          </button>
          {selectionMode && selectedParcels.size > 0 && (
            <button
              onClick={clearSelection}
              disabled={parcelBusy}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded border bg-slate-800 border-slate-500 disabled:opacity-50"
              title="選択を全て解除"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          {parcelMessage && (
            <span className="text-[11px] text-slate-300 truncate flex-1" title={parcelMessage}>
              {parcelMessage}
            </span>
          )}
        </div>
      )}

      <div className="flex-1 relative">
        <UnifiedFieldMap
          key={farmId ?? 'no-farm'}
          baseLayer={baseLayer}
          layers={layers}
          farmId={farmId}
        >
          {isCadastralProject && hasActiveParcelDataset && (
            <ParcelMapLayer
              visible={showParcelLayer}
              bbox={effectiveParcelBbox}
              importedParcelKeys={importedParcelKeys}
              selectedKeys={selectedParcelKeys}
              onToggleSelect={toggleSelectedParcel}
              selectionMode={selectionMode}
            />
          )}
        </UnifiedFieldMap>

        {showLayerPanel && (
          <div className="absolute top-2 right-2 z-[1000] w-56 bg-white border border-slate-300 rounded shadow-lg">
            <div className="px-3 py-2 border-b bg-slate-50 rounded-t text-xs font-semibold text-slate-700 flex items-center gap-1">
              <Layers className="h-3 w-3" />
              レイヤー表示
            </div>
            <div className="p-2 space-y-1 text-xs">
              <LayerCheckbox label="座標点" checked={layers.coordinatePoints} onChange={() => toggleLayer('coordinatePoints')} color="#3b82f6" />
              <LayerCheckbox label="工事区域" checked={layers.workAreas} onChange={() => toggleLayer('workAreas')} color="#10b981" />
              <LayerCheckbox label="配管" checked={layers.pipes} onChange={() => toggleLayer('pipes')} color="#ef4444" />
              <div className="pl-5">
                <LayerCheckbox label="配管番号" checked={layers.pipeNumbers} onChange={() => toggleLayer('pipeNumbers')} disabled={!layers.pipes} />
              </div>
              <LayerCheckbox label="管の測点 (C/B/A)" checked={layers.pipeMeasurementPoints} onChange={() => toggleLayer('pipeMeasurementPoints')} color="#3b82f6" />
              <LayerCheckbox label="測点（測量）" checked={layers.surveyPoints} onChange={() => toggleLayer('surveyPoints')} color="#0ea5e9" />
              <LayerCheckbox label="経路" checked={layers.route} onChange={() => toggleLayer('route')} color="#2563eb" />
              <LayerCheckbox label="オルソ画像" checked={layers.orthophoto} onChange={() => toggleLayer('orthophoto')} color="#10b981" />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function LayerCheckbox({
  label,
  checked,
  onChange,
  color,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: () => void
  color?: string
  disabled?: boolean
}) {
  return (
    <label
      className={`flex items-center gap-2 px-1 py-0.5 rounded cursor-pointer ${
        disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-slate-50'
      }`}
    >
      <input type="checkbox" checked={checked} onChange={onChange} disabled={disabled} className="h-4 w-4" />
      {color && <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />}
      <span className="text-slate-700">{label}</span>
    </label>
  )
}
