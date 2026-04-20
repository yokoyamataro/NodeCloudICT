import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import { CoordinateMap, type BaseLayerType } from '@/components/map/CoordinateMap'
import type { Project } from '@/types/database'

// 別ウィンドウで現場の地図のみを全画面表示するページ
// URL: /site-map?farmId=xxx
export function SiteMapWindowPage() {
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const { setCurrentFarm } = useFarmStore()
  const { setZone, fetchCoordinates, fetchRoute, route } = useCoordinateStore()

  const [farm, setFarm] = useState<Farm | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showLabels, setShowLabels] = useState(true)
  const [baseLayer, setBaseLayer] = useState<BaseLayerType>('osm')
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(
    new Set(Object.keys(COORDINATE_TYPE_NAMES)),
  )

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
        // 圃場を取得
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

        // プロジェクトを取得（座標系のため）
        if (typedFarm.project_id) {
          const { data: projData } = await supabase
            .from('projects')
            .select('*')
            .eq('id', typedFarm.project_id)
            .single()
          if (!cancelled && projData) {
            const typedProj = projData as Project
            setProject(typedProj)
            // projectListStore にも設定（他コンポーネントの参照用）
            useProjectListStore.setState({ currentProject: typedProj })
            setZone(typedProj.coordinate_zone)
          }
        }

        // 座標と経路をロード
        await Promise.all([fetchCoordinates(typedFarm.id), fetchRoute(typedFarm.id)])
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
  }, [farmId, setCurrentFarm, setZone, fetchCoordinates, fetchRoute])

  const title = useMemo(() => {
    if (!farm) return '現場地図'
    return project ? `${project.name} / ${farm.name}` : farm.name
  }, [farm, project])

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
      {/* ヘッダー（ツールバー） */}
      <div className="px-3 py-2 bg-white border-b flex items-center gap-4 flex-wrap text-sm">
        <span className="font-medium text-slate-800">{title}</span>
        <span className="text-xs text-slate-500">現場地図（別ウィンドウ）</span>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={() => setShowLabels(!showLabels)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
            }`}
          >
            点名 {showLabels ? 'ON' : 'OFF'}
          </button>
          <div className="flex items-center gap-2">
            {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
              <label key={type} className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleTypes.has(type)}
                  onChange={(e) => {
                    const next = new Set(visibleTypes)
                    if (e.target.checked) next.add(type)
                    else next.delete(type)
                    setVisibleTypes(next)
                  }}
                  className="h-3 w-3"
                />
                {name}
              </label>
            ))}
          </div>
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

      <div className="flex-1">
        <CoordinateMap
          showLabels={showLabels}
          visibleTypes={visibleTypes}
          baseLayer={baseLayer}
          route={route}
          showRoute={true}
        />
      </div>
    </div>
  )
}
