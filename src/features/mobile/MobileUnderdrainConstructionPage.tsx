// 暗渠工事の施工管理（スマホ向け）
// - LandXML を読み込み、中心線形と床掘 TIN を地図に表示
// - 自己位置（RTK + ジオイド補正）と TIN 標高の差分をリアルタイム表示
// - 起工測量の暗渠構成点（計画高つき）も併せて表示

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MapContainer, TileLayer, CircleMarker, Polyline, Tooltip, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import {
  ArrowLeft, FileText, Loader2, Crosshair, Radio, Settings, Database,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore, type Farm } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { parseLandXml, type ParsedSurface } from '@/lib/landxml/parser'
import { indexTin, queryZ, type TinIndex, type TinSurfaceLike } from '@/lib/landxml/tinInterpolation'
import { buildTrenchTin } from '@/lib/landxml/surface'
import type { Alignment, AlignmentSegment } from '@/lib/landxml/types'
import type { Project } from '@/types/database'

function FollowCurrent({ position, enabled }: { position: [number, number] | null; enabled: boolean }) {
  const map = useMap()
  useEffect(() => {
    if (!enabled || !position) return
    map.setView(position, Math.max(map.getZoom(), 18), { animate: true })
  }, [map, position, enabled])
  return null
}

// セグメントを離散化してポリラインに変換
function segmentToPolyline(seg: AlignmentSegment, samples = 16): Array<[number, number]> {
  if (seg.type === 'line') {
    return [[seg.startX, seg.startY], [seg.endX, seg.endY]]
  }
  // curve / spiral は線形補間で簡易表示（曲線は後で精緻化）
  const pts: Array<[number, number]> = []
  for (let i = 0; i <= samples; i++) {
    const t = i / samples
    pts.push([
      seg.startX + (seg.endX - seg.startX) * t,
      seg.startY + (seg.endY - seg.startY) * t,
    ])
  }
  return pts
}

// 加速度色（差分の絶対値で色分け）
function diffColor(dz: number): string {
  const a = Math.abs(dz)
  if (a < 0.05) return '#10b981' // 5cm 以内 → 緑
  if (a < 0.10) return '#84cc16'
  if (a < 0.20) return '#eab308'
  if (a < 0.50) return '#f97316'
  return '#ef4444'
}

export function MobileUnderdrainConstructionPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const farmId = params.get('farmId')

  const { setCurrentFarm } = useFarmStore()
  const { setZone, fetchCoordinates } = useCoordinateStore()
  const { fetchSurveyData, surveyData } = useSurveyStore()

  const [farm, setFarm] = useState<Farm | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // GNSS 位置
  const [pos, setPos] = useState<[number, number] | null>(null)
  const [acc, setAcc] = useState<number | null>(null)
  const [alt, setAlt] = useState<number | null>(null)
  const [follow, setFollow] = useState(true)

  // 取込みデータ
  // 中心線形は lat/lng のポリラインの集合として保持（LandXML の Alignment / 施工計画の Pipe どちらからでも作る）
  const [alignmentLines, setAlignmentLines] = useState<Array<[number, number][]>>([])
  const [trenchSurface, setTrenchSurface] = useState<TinSurfaceLike | null>(null)
  const [groundSurface, setGroundSurface] = useState<ParsedSurface | null>(null)
  const [dataSourceLabel, setDataSourceLabel] = useState<string | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 暗渠ストア / 施工計画ストア（施工計画から取込み用）
  const { fetchPipes } = useUnderdrainStore()
  const { fetchPlan } = useConstructionPlanStore()

  // ジオイド補正設定（モバイル測量と共通）
  const [antennaHeight, setAntennaHeight] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('rtk:antennaHeight') : null
    const n = saved ? parseFloat(saved) : NaN
    return Number.isFinite(n) ? n : 2.0
  })
  useEffect(() => {
    try { localStorage.setItem('rtk:antennaHeight', String(antennaHeight)) } catch { /* ignore */ }
  }, [antennaHeight])
  const [useGeoid, setUseGeoid] = useState<boolean>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('rtk:useGeoid') : null
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    try { localStorage.setItem('rtk:useGeoid', useGeoid ? '1' : '0') } catch { /* ignore */ }
  }, [useGeoid])
  const [geoidGrid, setGeoidGrid] = useState<import('@/lib/geoid').GeoidGrid | null>(null)
  useEffect(() => {
    if (!useGeoid || geoidGrid) return
    import('@/lib/geoid').then(({ loadGeoid }) => loadGeoid()).then(setGeoidGrid).catch(() => undefined)
  }, [useGeoid, geoidGrid])

  // 表示設定
  const [showSettings, setShowSettings] = useState(false)
  const [showSurveyPoints, setShowSurveyPoints] = useState(true)

  // データ読込
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

        const { data: projData } = await supabase
          .from('projects')
          .select('*')
          .eq('id', typedFarm.project_id)
          .single()
        const typedProj = projData as Project | null
        if (typedProj) {
          setProject(typedProj)
          setZone(typedProj.coordinate_zone)
          // 既存のプロジェクト読込（簡易版）
          useProjectListStore.setState({ currentProject: typedProj })
        }
        await Promise.all([
          fetchCoordinates(typedFarm.id),
          fetchSurveyData(typedFarm.id),
        ])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '読込エラー')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [farmId, fetchCoordinates, fetchSurveyData, setCurrentFarm, setZone])

  // 座標変換
  const zone = project?.coordinate_zone ?? 13
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // GNSS 監視
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setError('このデバイスは位置情報に対応していません')
      return
    }
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        setPos([p.coords.latitude, p.coords.longitude])
        setAcc(p.coords.accuracy ?? null)
        setAlt(p.coords.altitude)
      },
      (e) => setError(e.message),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 },
    )
    return () => navigator.geolocation.clearWatch(watch)
  }, [])

  // 中心線形：Alignment[] → lat/lng ポリラインに変換
  const buildAlignmentLines = (als: Alignment[], conv: CoordinateConverter): Array<[number, number][]> => {
    const lines: Array<[number, number][]> = []
    for (const al of als) {
      for (const seg of al.segments) {
        const xyPts = segmentToPolyline(seg, 12)
        const llPts: [number, number][] = xyPts.map(([x, y]) => {
          const r = conv.toLatLng(x, y)
          return [r.lat, r.lng]
        })
        lines.push(llPts)
      }
    }
    return lines
  }

  // LandXML 読込
  const handleLoadXml = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setDataError(null)
    try {
      const text = await file.text()
      const result = parseLandXml(text, file.name)
      const trenchSurf = result.surfaces.find((s) => /trench|床掘|excav/i.test(s.name)) ?? result.surfaces[0] ?? null
      const groundSurf = result.surfaces.find((s) => /ground|現況|terrain/i.test(s.name)) ?? null
      setAlignmentLines(buildAlignmentLines(result.alignments, converter))
      setTrenchSurface(trenchSurf)
      setGroundSurface(groundSurf)
      setDataSourceLabel(`LandXML: ${file.name}`)
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'LandXML 読込エラー')
    } finally {
      e.target.value = ''
    }
  }

  // 施工計画データから取込（Supabase）
  const handleLoadFromPlan = async () => {
    if (!farmId) return
    setDataError(null)
    setImporting(true)
    try {
      await Promise.all([fetchPipes(farmId), fetchPlan(farmId)])
      // 状態反映後に最新値を取得
      const freshPipes = useUnderdrainStore.getState().pipes
      const freshPlan = useConstructionPlanStore.getState().planGroups
      // 中心線形：各暗渠の頂点を順に結ぶポリラインへ
      const lines: Array<[number, number][]> = []
      for (const pipe of freshPipes) {
        if (pipe.vertices.length < 2) continue
        const ll: [number, number][] = pipe.vertices.map((v) => {
          const r = converter.toLatLng(v.x, v.y)
          return [r.lat, r.lng]
        })
        lines.push(ll)
      }
      setAlignmentLines(lines)
      // 床掘 TIN を施工計画から構築（既定パラメータ）
      const trench = buildTrenchTin({
        planGroups: freshPlan,
        halfWidth: 0.25,
        includeAbsorption: true,
        includeCollector: true,
        applyTransition: true,
        transitionDistance: 5.0,
        trimClearance: 0.10,
      })
      setTrenchSurface(trench)
      setGroundSurface(null)
      setDataSourceLabel(`施工計画から取込（暗渠 ${freshPipes.length} / 計画 ${freshPlan.length} 系統）`)
    } catch (err) {
      setDataError(err instanceof Error ? err.message : '施工計画の取込に失敗')
    } finally {
      setImporting(false)
    }
  }

  // TIN インデックス（補間用）
  const trenchIdx = useMemo<TinIndex | null>(
    () => (trenchSurface ? indexTin(trenchSurface) : null),
    [trenchSurface],
  )
  const groundIdx = useMemo<TinIndex | null>(
    () => (groundSurface ? indexTin(groundSurface) : null),
    [groundSurface],
  )

  // 自己位置（XY 平面直角）
  const selfXY = useMemo(() => {
    if (!pos) return null
    return converter.toXY(pos[0], pos[1])
  }, [pos, converter])

  // 自己標高（補正済み）
  const selfElevation = useMemo<number | null>(() => {
    if (alt === null || pos === null) return null
    if (useGeoid && geoidGrid) {
      // インライン補間
      const rRow = (geoidGrid.latMax - pos[0]) / geoidGrid.dLat
      const rCol = (pos[1] - geoidGrid.lonMin) / geoidGrid.dLon
      if (rRow < 0 || rCol < 0 || rRow >= geoidGrid.nrows || rCol >= geoidGrid.ncols) {
        return alt - antennaHeight
      }
      const r0 = Math.floor(rRow), c0 = Math.floor(rCol)
      const r1 = Math.min(r0 + 1, geoidGrid.nrows - 1)
      const c1 = Math.min(c0 + 1, geoidGrid.ncols - 1)
      const tr = rRow - r0, tc = rCol - c0
      const v00 = geoidGrid.values[r0 * geoidGrid.ncols + c0]
      const v01 = geoidGrid.values[r0 * geoidGrid.ncols + c1]
      const v10 = geoidGrid.values[r1 * geoidGrid.ncols + c0]
      const v11 = geoidGrid.values[r1 * geoidGrid.ncols + c1]
      const N = (v00 * (1 - tc) + v01 * tc) * (1 - tr) + (v10 * (1 - tc) + v11 * tc) * tr
      if (Number.isFinite(N)) return alt - N - antennaHeight
    }
    return alt - antennaHeight
  }, [alt, pos, antennaHeight, useGeoid, geoidGrid])

  // TIN 標高（自己位置における）
  const trenchZ = useMemo<number | null>(() => {
    if (!trenchIdx || !selfXY) return null
    return queryZ(trenchIdx, selfXY.x, selfXY.y)
  }, [trenchIdx, selfXY])
  const groundZ = useMemo<number | null>(() => {
    if (!groundIdx || !selfXY) return null
    return queryZ(groundIdx, selfXY.x, selfXY.y)
  }, [groundIdx, selfXY])

  // 標高差（実標高 − TIN 標高）。正なら掘り不足、負なら過掘
  const trenchDiff = trenchZ !== null && selfElevation !== null ? selfElevation - trenchZ : null
  const groundDiff = groundZ !== null && selfElevation !== null ? selfElevation - groundZ : null

  // 床掘 TIN の輪郭線（三角形のエッジを表示）
  const trenchEdges = useMemo<Array<[number, number][]>>(() => {
    if (!trenchSurface) return []
    const edges: Array<[number, number][]> = []
    for (const tri of trenchSurface.triangles) {
      const a = trenchSurface.points[tri.a]
      const b = trenchSurface.points[tri.b]
      const c = trenchSurface.points[tri.c]
      if (!a || !b || !c) continue
      const aa = converter.toLatLng(a.x, a.y)
      const bb = converter.toLatLng(b.x, b.y)
      const cc = converter.toLatLng(c.x, c.y)
      edges.push([[aa.lat, aa.lng], [bb.lat, bb.lng], [cc.lat, cc.lng], [aa.lat, aa.lng]])
    }
    return edges
  }, [trenchSurface, converter])

  // 起工測量の暗渠構成点
  const surveyMarkers = useMemo(() => {
    return surveyData
      .filter((s) => s.category === 'underdrain')
      .map((s) => {
        const ll = converter.toLatLng(s.x, s.y)
        return {
          id: s.id,
          name: s.pointNumber || '?',
          lat: ll.lat,
          lng: ll.lng,
          measuredZ: s.z,
        }
      })
  }, [surveyData, converter])

  if (loading) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="mobile-min-screen flex items-center justify-center bg-slate-100 p-4">
        <div className="bg-white border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>
      </div>
    )
  }

  const initialCenter: [number, number] = pos ?? [43.06, 141.35]

  return (
    <div className="mobile-screen flex flex-col">
      <div className="px-3 py-2 bg-slate-800 text-white flex items-center gap-2 text-sm">
        <button onClick={() => navigate('/mobile')} className="p-1 hover:bg-slate-700 rounded" title="戻る">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="font-medium">{farm?.name ?? '施工管理'}</span>
        <span className="text-xs text-slate-400">暗渠施工管理</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleLoadFromPlan}
            disabled={importing}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700 disabled:opacity-50"
            title="現場データの施工計画 + 暗渠から床掘 TIN を生成"
          >
            <Database className="h-3.5 w-3.5" />
            施工計画
            {importing && <Loader2 className="h-3 w-3 animate-spin" />}
          </button>
          <label className="cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml,.XML,.landxml,.LANDXML"
              onChange={handleLoadXml}
              className="hidden"
            />
            <span className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700">
              <FileText className="h-3.5 w-3.5" />
              LandXML
            </span>
          </label>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-slate-500 hover:bg-slate-700"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 状態バー */}
      <div className="px-3 py-1 bg-slate-100 text-xs flex items-center gap-3 border-b">
        <Radio className="h-3.5 w-3.5" />
        <span className="font-mono">精度: {acc != null ? `${acc.toFixed(2)} m` : '未取得'}</span>
        {selfElevation !== null && (
          <span className="ml-auto font-mono text-slate-700">標高 {selfElevation.toFixed(3)} m</span>
        )}
      </div>
      {dataError && (
        <div className="px-3 py-1 bg-red-50 border-b border-red-200 text-xs text-red-700">{dataError}</div>
      )}
      {dataSourceLabel && (
        <div className="px-3 py-1 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-800">
          {dataSourceLabel} ／ 中心線 {alignmentLines.length} ／ 床掘 TIN {trenchSurface ? '✓' : '×'}
          {groundSurface ? ' ／ 現況 TIN ✓' : ''}
        </div>
      )}

      <div className="flex-1 relative">
        <MapContainer center={initialCenter} zoom={pos ? 18 : 14} maxZoom={22} className="h-full w-full">
          <TileLayer
            attribution='&copy; 国土地理院'
            url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
            maxZoom={22}
            maxNativeZoom={18}
          />
          <FollowCurrent position={pos} enabled={follow} />

          {/* 床掘 TIN（薄いシアンの三角形エッジ） */}
          {trenchEdges.map((tri, i) => (
            <Polyline
              key={`trench-${i}`}
              positions={tri}
              pathOptions={{ color: '#06b6d4', weight: 0.5, opacity: 0.5 }}
            />
          ))}

          {/* 中心線形（青） */}
          {alignmentLines.map((line, i) => (
            <Polyline
              key={`align-${i}`}
              positions={line}
              pathOptions={{ color: '#1d4ed8', weight: 3, opacity: 0.9 }}
            />
          ))}

          {/* 起工測量の暗渠構成点 */}
          {showSurveyPoints && surveyMarkers.map((m) => (
            <CircleMarker
              key={m.id}
              center={[m.lat, m.lng]}
              radius={5}
              pathOptions={{ color: '#fff', fillColor: '#a855f7', fillOpacity: 1, weight: 2 }}
            >
              <Tooltip permanent direction="top" offset={[0, -8]} className="!text-[10px]">
                {m.name}
                {m.measuredZ != null ? ` / 実測 ${m.measuredZ.toFixed(2)}` : ''}
              </Tooltip>
            </CircleMarker>
          ))}

          {/* 自己位置 */}
          {pos && (
            <CircleMarker
              center={pos}
              radius={9}
              pathOptions={{ color: '#fff', fillColor: '#dc2626', fillOpacity: 1, weight: 3 }}
            />
          )}
        </MapContainer>

        {/* 追従トグル */}
        <button
          onClick={() => setFollow((v) => !v)}
          className={`absolute bottom-3 right-3 z-[1000] p-2 rounded-full shadow-lg ${follow ? 'bg-blue-600 text-white' : 'bg-white text-slate-700'}`}
          title="現在位置を追従"
        >
          <Crosshair className="h-5 w-5" />
        </button>

        {/* ΔZ 大型表示 */}
        {trenchDiff !== null && (
          <div className="absolute top-2 left-2 z-[1000] bg-white/95 border rounded-lg shadow-lg p-3 min-w-[180px]">
            <div className="text-[11px] text-slate-500">床掘 TIN との差分</div>
            <div className="text-2xl font-bold tabular-nums" style={{ color: diffColor(trenchDiff) }}>
              {trenchDiff >= 0 ? '+' : ''}{trenchDiff.toFixed(3)} m
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              実標高 {selfElevation !== null ? selfElevation.toFixed(3) : '-'} ／ TIN {trenchZ !== null ? trenchZ.toFixed(3) : '-'}
            </div>
            <div className="text-[10px] text-slate-400 mt-1">
              {trenchDiff >= 0 ? '↑ 掘り不足' : '↓ 過掘'} {Math.abs(trenchDiff * 100).toFixed(1)} cm
            </div>
            {groundDiff !== null && (
              <div className="text-[10px] text-slate-500 mt-2 border-t pt-1">
                現況差 {groundDiff >= 0 ? '+' : ''}{groundDiff.toFixed(3)} m
              </div>
            )}
          </div>
        )}

        {/* 設定パネル */}
        {showSettings && (
          <div className="absolute top-2 right-2 z-[1000] bg-white border rounded-lg shadow-lg p-3 w-60 text-sm">
            <div className="font-semibold mb-2">設定</div>
            <label className="flex flex-col gap-1 mb-2">
              <span className="text-xs text-slate-600">アンテナ高 (m)</span>
              <input
                type="number"
                step={0.01}
                value={antennaHeight}
                onChange={(e) => {
                  const n = parseFloat(e.target.value)
                  if (Number.isFinite(n)) setAntennaHeight(n)
                }}
                className="w-full px-2 py-1 border rounded text-right font-mono"
              />
            </label>
            <label className="flex items-center gap-2 mb-2">
              <input type="checkbox" checked={useGeoid} onChange={(e) => setUseGeoid(e.target.checked)} />
              <span className="text-xs">ジオイド補正を有効化</span>
            </label>
            <label className="flex items-center gap-2 mb-2">
              <input type="checkbox" checked={showSurveyPoints} onChange={(e) => setShowSurveyPoints(e.target.checked)} />
              <span className="text-xs">起工測量点を表示</span>
            </label>
            <button
              onClick={() => setShowSettings(false)}
              className="mt-2 w-full px-2 py-1 text-xs border rounded hover:bg-slate-50"
            >
              閉じる
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
