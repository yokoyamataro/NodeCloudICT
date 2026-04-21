import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2, ArrowLeft, Layers } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { UnifiedFieldMap, type BaseLayerType, type LayerVisibility } from '@/components/map/UnifiedFieldMap'
import type { Project } from '@/types/database'

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
    workAreas: true,
    route: true,
    currentLocation: true,
  })
  const [showLayerPanel, setShowLayerPanel] = useState(false)

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
          setError(err instanceof Error ? err.message : '圃場データの取得に失敗しました')
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
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex flex-col bg-slate-100">
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
    <div className="h-screen flex flex-col">
      <div className="px-2 py-2 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <button
          onClick={() => navigate('/mobile')}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700"
          title="戻る"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-medium truncate flex-1">{title}</span>
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
        <select
          value={baseLayer}
          onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
          className="px-2 py-1 text-xs border border-slate-500 bg-slate-700 text-white rounded"
        >
          <option value="osm">地図</option>
          <option value="gsi-photo">航空写真</option>
          <option value="gsi-std">地理院地図</option>
        </select>
      </div>

      <div className="flex-1 relative">
        <UnifiedFieldMap key={farmId ?? 'no-farm'} baseLayer={baseLayer} layers={layers} />

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
              <LayerCheckbox label="現在位置" checked={layers.currentLocation} onChange={() => toggleLayer('currentLocation')} color="#2563eb" />
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
