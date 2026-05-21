import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2, Layers, Crosshair, Image as ImageIcon } from 'lucide-react'
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

// 別ウィンドウで現場の地図のみを全画面表示するページ
// URL: /site-map?farmId=xxx
export function SiteMapWindowPage() {
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

  const [baseLayer, setBaseLayer] = useState<BaseLayerType>('osm')
  const [layers, setLayers] = useState<LayerVisibility>({
    coordinatePoints: true,
    pipes: true,
    pipeNumbers: true,
    pipeMeasurementPoints: false,
    surveyPoints: true,
    workAreas: true,
    route: true,
    currentLocation: false,
    orthophoto: true,
  })
  const [showLayerPanel, setShowLayerPanel] = useState(true)

  // URL から farmId を元にデータをロード
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

        // 全データを並列ロード
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
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100">
        <div className="p-6 bg-white rounded shadow text-red-600 text-sm">{error}</div>
      </div>
    )
  }

  return (
    <div className="h-screen flex flex-col">
      {/* ヘッダー */}
      <div className="px-3 py-2 bg-white border-b flex items-center gap-4 flex-wrap text-sm">
        <span className="font-medium text-slate-800">{title}</span>
        <span className="text-xs text-slate-500">現場地図（別ウィンドウ）</span>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setLayers((prev) => ({ ...prev, orthophoto: !prev.orthophoto }))}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              layers.orthophoto
                ? 'bg-emerald-100 border-emerald-400 text-emerald-800 font-medium'
                : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
            title="オルソ画像の表示を切替"
          >
            <ImageIcon className="h-3 w-3" />
            オルソ
          </button>
          <button
            onClick={() =>
              setLayers((prev) => ({ ...prev, currentLocation: !prev.currentLocation }))
            }
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              layers.currentLocation
                ? 'bg-blue-100 border-blue-400 text-blue-800 font-medium'
                : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
            title="現在位置の表示を切替"
          >
            <Crosshair className="h-3 w-3" />
            現在地
          </button>
          <button
            onClick={() => setShowLayerPanel((s) => !s)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showLayerPanel
                ? 'bg-blue-100 border-blue-300 text-blue-800'
                : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Layers className="h-3 w-3" />
            レイヤー
          </button>
          <select
            value={baseLayer}
            onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
            className="px-2 py-1 text-xs border rounded bg-white"
          >
            <option value="osm">地図</option>
            <option value="gsi-photo">航空写真</option>
            <option value="gsi-std">地理院地図</option>
          </select>
        </div>
      </div>

      {/* 地図エリア */}
      <div className="flex-1 relative">
        {/* farmId が変わったら確実に再マウントして fitBounds を再実行 */}
        <UnifiedFieldMap key={farmId ?? 'no-farm'} baseLayer={baseLayer} layers={layers} farmId={farmId} />

        {/* レイヤーパネル（オーバーレイ） */}
        {showLayerPanel && (
          <div className="absolute top-3 right-3 z-[1000] w-56 bg-white border border-slate-300 rounded shadow-lg">
            <div className="px-3 py-2 border-b bg-slate-50 rounded-t text-xs font-semibold text-slate-700 flex items-center gap-1">
              <Layers className="h-3 w-3" />
              レイヤー表示
            </div>
            <div className="p-2 space-y-1 text-xs">
              <LayerCheckbox
                label="座標点"
                checked={layers.coordinatePoints}
                onChange={() => toggleLayer('coordinatePoints')}
                color="#3b82f6"
              />
              <LayerCheckbox
                label="工事区域"
                checked={layers.workAreas}
                onChange={() => toggleLayer('workAreas')}
                color="#10b981"
              />
              <LayerCheckbox
                label="配管"
                checked={layers.pipes}
                onChange={() => toggleLayer('pipes')}
                color="#ef4444"
              />
              <div className="pl-5">
                <LayerCheckbox
                  label="配管番号"
                  checked={layers.pipeNumbers}
                  onChange={() => toggleLayer('pipeNumbers')}
                  disabled={!layers.pipes}
                />
              </div>
              <LayerCheckbox
                label="管の測点 (C/B/A)"
                checked={layers.pipeMeasurementPoints}
                onChange={() => toggleLayer('pipeMeasurementPoints')}
                color="#3b82f6"
              />
              <LayerCheckbox
                label="測点（測量）"
                checked={layers.surveyPoints}
                onChange={() => toggleLayer('surveyPoints')}
                color="#0ea5e9"
              />
              <LayerCheckbox
                label="経路"
                checked={layers.route}
                onChange={() => toggleLayer('route')}
                color="#2563eb"
              />
              <LayerCheckbox
                label="オルソ画像"
                checked={layers.orthophoto}
                onChange={() => toggleLayer('orthophoto')}
                color="#10b981"
              />
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
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="h-3.5 w-3.5"
      />
      {color && <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />}
      <span className="text-slate-700">{label}</span>
    </label>
  )
}
