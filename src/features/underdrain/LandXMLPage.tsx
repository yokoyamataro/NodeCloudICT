import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FileOutput,
  Upload,
  Trash2,
  Loader2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { MapContainer, TileLayer, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useAlignmentStore } from '@/stores/alignmentStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { parseLandXml } from '@/lib/landxml/parser'
import { sampleAlignment } from '@/lib/landxml/geometry'
import { buildAlignmentsFromPlan, alignmentZRange } from '@/lib/landxml/fromPlan'
import { buildTinSurface, buildTrenchTin } from '@/lib/landxml/surface'
import { CoordinateConverter } from '@/lib/coordinates'
import type { Alignment } from '@/lib/landxml/types'

export function LandXMLPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { zone, setZone } = useCoordinateStore()
  const {
    alignments,
    loading,
    saving,
    error,
    fetchAlignments,
    addAlignments,
    deleteAlignment,
    clearAlignments,
  } = useAlignmentStore()
  const { planGroups, fetchPlan } = useConstructionPlanStore()
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { surveyData, fetchSurveyData } = useSurveyStore()

  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [parseWarnings, setParseWarnings] = useState<string[]>([])
  const [pendingAlignments, setPendingAlignments] = useState<Alignment[] | null>(null)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // 圃場読込時にデータ取得
  useEffect(() => {
    if (!currentFarm) return
    fetchAlignments(currentFarm.id)
    fetchPlan(currentFarm.id)
    fetchPipes(currentFarm.id)
    fetchSurveyData(currentFarm.id)
  }, [currentFarm, fetchAlignments, fetchPlan, fetchPipes, fetchSurveyData])

  // プロジェクトの座標系を適用
  useEffect(() => {
    if (!currentFarm?.project_id) return
    const proj = projects.find((p) => p.id === currentFarm.project_id)
    if (proj?.coordinate_zone) setZone(proj.coordinate_zone)
  }, [currentFarm, projects, setZone])

  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // 施工計画から自動算出した中心線形（吸水・集水）
  const derivedAlignments = useMemo(() => {
    if (!planGroups || planGroups.length === 0) return []
    return buildAlignmentsFromPlan(planGroups)
  }, [planGroups])

  // 絞り込み: 吸水/集水を個別 on/off
  const [showAbsorption, setShowAbsorption] = useState(true)
  const [showCollector, setShowCollector] = useState(true)

  // TIN 生成・表示設定
  const [showTin, setShowTin] = useState(false)
  const [tinIncludePipes, setTinIncludePipes] = useState(true)
  const [tinIncludeSurvey, setTinIncludeSurvey] = useState(true)
  const [tinIncludePlan, setTinIncludePlan] = useState(false)

  // 床掘 TIN 設定
  const [showTrench, setShowTrench] = useState(false)
  const [trenchHalfWidth, setTrenchHalfWidth] = useState(0.25) // m = 片側 25cm
  const [trenchIncludeAbsorption, setTrenchIncludeAbsorption] = useState(true)
  const [trenchIncludeCollector, setTrenchIncludeCollector] = useState(true)
  const [trenchApplyTransition, setTrenchApplyTransition] = useState(true)
  const [trenchTransitionDistance, setTrenchTransitionDistance] = useState(5.0) // m
  const [trenchTrimClearance, setTrenchTrimClearance] = useState(0.10) // m

  const tinSurface = useMemo(() => {
    if (!showTin) return null
    return buildTinSurface({
      pipes,
      surveyData,
      planGroups,
      includePipes: tinIncludePipes,
      includeSurvey: tinIncludeSurvey,
      includePlan: tinIncludePlan,
    })
  }, [showTin, pipes, surveyData, planGroups, tinIncludePipes, tinIncludeSurvey, tinIncludePlan])

  const trenchSurface = useMemo(() => {
    if (!showTrench) return null
    return buildTrenchTin({
      planGroups,
      halfWidth: trenchHalfWidth,
      includeAbsorption: trenchIncludeAbsorption,
      includeCollector: trenchIncludeCollector,
      applyTransition: trenchApplyTransition,
      transitionDistance: trenchTransitionDistance,
      trimClearance: trenchTrimClearance,
    })
  }, [
    showTrench,
    planGroups,
    trenchHalfWidth,
    trenchIncludeAbsorption,
    trenchIncludeCollector,
    trenchApplyTransition,
    trenchTransitionDistance,
    trenchTrimClearance,
  ])

  // 三角形サーフェスのエッジを緯度経度に変換
  const surfaceToLatLngEdges = (
    surface: ReturnType<typeof buildTinSurface> | null,
  ): Array<[[number, number], [number, number]]> => {
    if (!surface) return []
    const edges: Array<[[number, number], [number, number]]> = []
    for (const t of surface.triangles) {
      const pts = [surface.points[t.a], surface.points[t.b], surface.points[t.c]]
      const ll: Array<[number, number]> = []
      for (const p of pts) {
        try {
          const { lat, lng } = converter.toLatLng(p.x, p.y)
          if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
        } catch {
          // skip
        }
      }
      if (ll.length === 3) {
        edges.push([ll[0], ll[1]])
        edges.push([ll[1], ll[2]])
        edges.push([ll[2], ll[0]])
      }
    }
    return edges
  }

  const tinEdgeLatLngs = useMemo(() => surfaceToLatLngEdges(tinSurface), [tinSurface, converter])
  const trenchEdgeLatLngs = useMemo(
    () => surfaceToLatLngEdges(trenchSurface),
    [trenchSurface, converter],
  )

  // 保存済み線形を緯度経度で点列化
  const alignmentPolylines = useMemo(() => {
    return alignments
      .map((a) => {
        const pts = sampleAlignment(a.segments, 0.5)
        const ll: [number, number][] = []
        for (const p of pts) {
          try {
            const { lat, lng } = converter.toLatLng(p.x, p.y)
            if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
          } catch {
            // skip
          }
        }
        return { id: a.id, name: a.name, positions: ll }
      })
      .filter((p) => p.positions.length >= 2)
  }, [alignments, converter])

  // 施工計画由来の線形（派生）
  const derivedPolylines = useMemo(() => {
    return derivedAlignments
      .filter((a) => (a.source === 'absorption' ? showAbsorption : showCollector))
      .map((a) => {
        const pts = sampleAlignment(a.segments, 0.5)
        const ll: [number, number][] = []
        for (const p of pts) {
          try {
            const { lat, lng } = converter.toLatLng(p.x, p.y)
            if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
          } catch {
            // skip
          }
        }
        return { id: a.id, name: a.name, positions: ll, source: a.source }
      })
      .filter((p) => p.positions.length >= 2)
  }, [derivedAlignments, converter, showAbsorption, showCollector])

  // 取り込み直後の線形（未保存プレビュー）
  const pendingPolylines = useMemo(() => {
    if (!pendingAlignments) return []
    return pendingAlignments
      .map((a) => {
        const pts = sampleAlignment(a.segments, 0.5)
        const ll: [number, number][] = []
        for (const p of pts) {
          try {
            const { lat, lng } = converter.toLatLng(p.x, p.y)
            if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
          } catch {
            // skip
          }
        }
        return { id: a.id, name: a.name, positions: ll }
      })
      .filter((p) => p.positions.length >= 2)
  }, [pendingAlignments, converter])

  // 地図フィット用 bounds（保存済み + プレビュー + 派生を含む）
  const bounds = useMemo(() => {
    const sourcePrimary =
      pendingPolylines.length > 0
        ? pendingPolylines
        : alignmentPolylines.length > 0
          ? alignmentPolylines
          : derivedPolylines
    const all: [number, number][] = []
    for (const p of sourcePrimary) all.push(...p.positions)
    if (all.length === 0) return null
    const lats = all.map((p) => p[0])
    const lngs = all.map((p) => p[1])
    return L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    )
  }, [alignmentPolylines, pendingPolylines, derivedPolylines])

  const mapCenter: [number, number] = bounds
    ? [(bounds.getNorth() + bounds.getSouth()) / 2, (bounds.getEast() + bounds.getWest()) / 2]
    : [43.06, 141.35]

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setParseError(null)
    setParseWarnings([])
    try {
      const text = await file.text()
      const { alignments: parsed, warnings } = parseLandXml(text, file.name)
      if (parsed.length === 0) {
        setParseError('Alignment 要素が見つかりませんでした')
        setPendingAlignments(null)
      } else {
        setPendingAlignments(parsed)
        setParseWarnings(warnings)
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました')
      setPendingAlignments(null)
    }
    // ファイル選択をリセット
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleConfirmImport = async () => {
    if (!currentFarm || !pendingAlignments) return
    await addAlignments(currentFarm.id, pendingAlignments)
    setPendingAlignments(null)
    setParseWarnings([])
  }

  const handleCancelImport = () => {
    setPendingAlignments(null)
    setParseWarnings([])
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この中心線形を削除しますか？')) return
    await deleteAlignment(id)
  }

  const handleClearAll = async () => {
    if (!currentFarm) return
    if (!confirm(`${currentFarm.name} のすべての中心線形を削除しますか？`)) return
    await clearAlignments(currentFarm.id)
  }

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b bg-white flex items-center gap-3">
        <FileOutput className="h-5 w-5" />
        <div className="flex-1">
          <h1 className="text-xl font-bold">LandXML 出力</h1>
          <p className="text-sm text-muted-foreground">
            中心線形・面データを準備し、LandXML 形式で出力します
            <span className="ml-2 text-xs text-amber-700">
              （現在は中心線形の取り込みまで実装。面データ取込・LandXML 出力は今後追加）
            </span>
          </p>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* 左: 操作＋リスト */}
        <div className="w-[420px] border-r bg-white flex flex-col overflow-hidden">
          {/* 施工計画由来の線形 */}
          <div className="px-3 py-2 border-b bg-emerald-50">
            <div className="flex items-center gap-2">
              <div className="text-sm font-semibold">施工計画から算出した中心線形</div>
              <span className="text-xs text-slate-500">
                {derivedAlignments.length} 件
              </span>
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              各系統の集水・吸水 XYZ から自動生成（保存不要）
            </div>
            <div className="flex gap-3 text-xs mt-2">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showAbsorption}
                  onChange={(e) => setShowAbsorption(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                <span className="inline-block w-3 h-0.5 bg-blue-600" />
                吸水
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={showCollector}
                  onChange={(e) => setShowCollector(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                <span className="inline-block w-3 h-0.5 bg-emerald-500" />
                集水
              </label>
            </div>
            {derivedAlignments.length > 0 && (
              <div className="mt-2 max-h-56 overflow-auto border rounded bg-white">
                <table className="w-full text-[11px]">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left font-normal px-2 py-1">線形</th>
                      <th className="text-right font-normal px-2 py-1">延長 (m)</th>
                      <th className="text-right font-normal px-2 py-1">区間</th>
                      <th className="text-right font-normal px-2 py-1">Z 範囲</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derivedAlignments.map((a) => {
                      const zr = alignmentZRange(a.segments)
                      return (
                        <tr key={a.id} className="border-t">
                          <td className="px-2 py-0.5 truncate max-w-[160px]" title={a.name}>
                            <span
                              className={`inline-block w-2 h-2 rounded-full mr-1 align-middle ${
                                a.source === 'absorption' ? 'bg-blue-600' : 'bg-emerald-500'
                              }`}
                            />
                            {a.name}
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono">
                            {a.totalLength.toFixed(2)}
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono text-slate-500">
                            {a.segments.length}
                          </td>
                          <td
                            className={`px-2 py-0.5 text-right font-mono ${
                              zr.has3D ? 'text-slate-700' : 'text-red-500'
                            }`}
                            title={
                              zr.has3D
                                ? `${zr.min.toFixed(3)} 〜 ${zr.max.toFixed(3)} m (3D)`
                                : 'Z 値が入っていません（計画高・地盤高が未入力）'
                            }
                          >
                            {zr.has3D
                              ? `${zr.min.toFixed(2)}〜${zr.max.toFixed(2)}`
                              : '2D のみ'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="px-2 py-1 text-[10px] text-slate-500 border-t">
                  Z は計画高を優先、未入力なら地盤高をフォールバック。どちらも無い場合は「2D のみ」
                </div>
              </div>
            )}
          </div>

          {/* セクション見出し */}
          <div className="px-3 py-2 border-b bg-slate-50">
            <div className="text-sm font-semibold">1. 中心線形の取り込み</div>
            <div className="text-xs text-slate-500">
              LandXML ファイルから Alignment を読み込みます
            </div>
          </div>

          {/* 操作 */}
          <div className="p-3 border-b space-y-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".xml,.landxml"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={!currentFarm}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <Upload className="h-4 w-4" />
              LandXML ファイルを選択
            </button>

            {parseError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1">
                <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                <span>{parseError}</span>
              </div>
            )}

            {error && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-1">
                <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {pendingAlignments && (
              <div className="text-xs border border-blue-300 rounded bg-blue-50 p-2 space-y-2">
                <div className="font-semibold text-blue-800">
                  {pendingAlignments.length} 件の中心線形が見つかりました
                </div>
                <ul className="space-y-0.5">
                  {pendingAlignments.map((a) => (
                    <li key={a.id}>
                      ・{a.name}（延長 {a.totalLength.toFixed(2)} m / {a.segments.length} セグメント）
                    </li>
                  ))}
                </ul>
                {parseWarnings.length > 0 && (
                  <div className="text-amber-700 space-y-0.5">
                    {parseWarnings.map((w, i) => (
                      <div key={i}>⚠ {w}</div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={handleConfirmImport}
                    disabled={saving}
                    className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 text-xs"
                  >
                    {saving ? '保存中...' : '保存'}
                  </button>
                  <button
                    onClick={handleCancelImport}
                    className="flex-1 px-3 py-1.5 border rounded hover:bg-slate-50 text-xs"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* リスト */}
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-slate-500 text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                読み込み中...
              </div>
            ) : alignments.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                登録された中心線形がありません
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs text-slate-600">{alignments.length} 件</span>
                  <button
                    onClick={handleClearAll}
                    disabled={saving}
                    className="text-xs text-red-600 hover:underline"
                  >
                    全て削除
                  </button>
                </div>
                <ul className="space-y-1">
                  {alignments.map((a) => {
                    const isExpanded = expandedIds.has(a.id)
                    return (
                      <li key={a.id} className="border rounded bg-white">
                        <div className="flex items-center gap-1 px-2 py-1.5">
                          <button
                            onClick={() => toggleExpanded(a.id)}
                            className="p-0.5 hover:bg-slate-100 rounded"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5" />
                            )}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate" title={a.name}>
                              {a.name}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              延長 {a.totalLength.toFixed(2)} m / {a.segments.length} 区間
                              {a.sourceFile && <> · {a.sourceFile}</>}
                            </div>
                          </div>
                          <button
                            onClick={() => handleDelete(a.id)}
                            className="p-1 text-slate-400 hover:text-red-500"
                            title="削除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        {isExpanded && (
                          <div className="border-t px-2 py-1 overflow-x-auto">
                            <table className="w-full text-[11px]">
                              <thead className="text-slate-500">
                                <tr>
                                  <th className="text-left font-normal px-1">#</th>
                                  <th className="text-left font-normal px-1">種別</th>
                                  <th className="text-right font-normal px-1">長さ</th>
                                  <th className="text-right font-normal px-1">R</th>
                                </tr>
                              </thead>
                              <tbody>
                                {a.segments.map((seg, i) => (
                                  <tr key={i}>
                                    <td className="px-1 text-slate-500">{i + 1}</td>
                                    <td className="px-1">
                                      {seg.type === 'line'
                                        ? '直線'
                                        : seg.type === 'curve'
                                          ? '曲線'
                                          : '緩和'}
                                    </td>
                                    <td className="px-1 text-right font-mono">
                                      {seg.length.toFixed(2)}
                                    </td>
                                    <td className="px-1 text-right font-mono text-slate-500">
                                      {seg.radius ? seg.radius.toFixed(1) : '-'}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}

            {/* 面データ（TIN 生成） */}
            <div className="border-t pt-3 mt-4">
              <div className="text-sm font-semibold">2. 面データ（TIN 生成）</div>
              <div className="text-xs text-slate-500 mt-0.5">
                配管頂点・測量点・計画点から 3D TIN を作成
              </div>
              <label className="flex items-center gap-2 mt-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={showTin}
                  onChange={(e) => setShowTin(e.target.checked)}
                  className="h-3.5 w-3.5"
                />
                TIN を生成して表示
              </label>
              {showTin && (
                <div className="mt-2 ml-4 space-y-1 text-xs">
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={tinIncludePipes}
                      onChange={(e) => setTinIncludePipes(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    配管頂点（{pipes.reduce((s, p) => s + p.vertices.filter((v) => v.z != null).length, 0)} 点）
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={tinIncludeSurvey}
                      onChange={(e) => setTinIncludeSurvey(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    測量点（{surveyData.filter((s) => s.z != null).length} 点）
                  </label>
                  <label className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={tinIncludePlan}
                      onChange={(e) => setTinIncludePlan(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    施工計画点（計画高）
                  </label>
                  {tinSurface && (
                    <div className="mt-2 text-[11px] text-slate-600 bg-slate-50 border rounded p-2 space-y-0.5">
                      <div>
                        点数: {tinSurface.stats.pointCount} / 三角形:{' '}
                        {tinSurface.stats.triangleCount}
                      </div>
                      <div>
                        Z 範囲: {tinSurface.stats.zMin.toFixed(2)} 〜{' '}
                        {tinSurface.stats.zMax.toFixed(2)} m
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 床掘 TIN */}
              <div className="mt-3 pt-3 border-t">
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showTrench}
                    onChange={(e) => setShowTrench(e.target.checked)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="font-semibold">床掘 TIN を生成して表示</span>
                </label>
                <div className="ml-4 mt-0.5 text-[11px] text-slate-500">
                  各配管の中心線から左右へ一定幅オフセットした帯を、計画高でリボン化
                </div>
                {showTrench && (
                  <div className="mt-2 ml-4 space-y-1.5 text-xs">
                    <label className="flex items-center gap-2">
                      <span>片側幅 (m):</span>
                      <input
                        type="number"
                        step="0.01"
                        min={0.01}
                        value={trenchHalfWidth}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (Number.isFinite(v) && v > 0) setTrenchHalfWidth(v)
                        }}
                        onWheel={(e) => e.currentTarget.blur()}
                        className="w-16 px-1 py-0.5 border rounded text-right font-mono text-xs"
                      />
                      <span className="text-slate-500">
                        → 全幅 {(trenchHalfWidth * 2).toFixed(2)} m
                      </span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={trenchIncludeAbsorption}
                        onChange={(e) => setTrenchIncludeAbsorption(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      吸水管
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={trenchIncludeCollector}
                        onChange={(e) => setTrenchIncludeCollector(e.target.checked)}
                        className="h-3.5 w-3.5"
                      />
                      集水管
                    </label>
                    {/* 擦り付け処理 */}
                    <div className="border-t pt-1 mt-1">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={trenchApplyTransition}
                          onChange={(e) => setTrenchApplyTransition(e.target.checked)}
                          className="h-3.5 w-3.5"
                        />
                        <span className="font-medium">擦り付け処理</span>
                      </label>
                      <div className="text-[10px] text-slate-500 mt-0.5 ml-4">
                        合流点で Z を一致させ、N m 上流から線形変化 ·
                        集水幅 + クリアランスでトリミング
                      </div>
                      {trenchApplyTransition && (
                        <div className="ml-4 mt-1 space-y-1">
                          <label className="flex items-center gap-2">
                            <span>変化点距離 (m):</span>
                            <input
                              type="number"
                              step="0.1"
                              min={0.1}
                              value={trenchTransitionDistance}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value)
                                if (Number.isFinite(v) && v > 0) setTrenchTransitionDistance(v)
                              }}
                              onWheel={(e) => e.currentTarget.blur()}
                              className="w-16 px-1 py-0.5 border rounded text-right font-mono text-xs"
                            />
                          </label>
                          <label className="flex items-center gap-2">
                            <span>クリアランス (m):</span>
                            <input
                              type="number"
                              step="0.01"
                              min={0}
                              value={trenchTrimClearance}
                              onChange={(e) => {
                                const v = parseFloat(e.target.value)
                                if (Number.isFinite(v) && v >= 0) setTrenchTrimClearance(v)
                              }}
                              onWheel={(e) => e.currentTarget.blur()}
                              className="w-16 px-1 py-0.5 border rounded text-right font-mono text-xs"
                            />
                            <span className="text-slate-500">
                              トリム = {trenchHalfWidth.toFixed(2)}+{trenchTrimClearance.toFixed(2)}
                              ={(trenchHalfWidth + trenchTrimClearance).toFixed(2)} m
                            </span>
                          </label>
                        </div>
                      )}
                    </div>
                    {trenchSurface && (
                      <div className="mt-1 text-[11px] text-slate-600 bg-amber-50 border border-amber-200 rounded p-2 space-y-0.5">
                        <div>
                          点数: {trenchSurface.stats.pointCount} / 三角形:{' '}
                          {trenchSurface.stats.triangleCount}
                        </div>
                        <div>
                          Z 範囲: {trenchSurface.stats.zMin.toFixed(2)} 〜{' '}
                          {trenchSurface.stats.zMax.toFixed(2)} m
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* LandXML 出力 (未実装) */}
            <div className="border-t pt-3 mt-3">
              <div className="text-sm font-semibold text-slate-500">3. LandXML 出力</div>
              <div className="text-xs text-slate-400 mt-1">（今後実装予定）</div>
              <button
                type="button"
                disabled
                className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2 bg-slate-200 text-slate-400 rounded text-sm cursor-not-allowed"
              >
                <FileOutput className="h-4 w-4" />
                LandXML を出力
              </button>
            </div>
          </div>
        </div>

        {/* 右: 地図 */}
        <div className="flex-1 relative">
          <MapContainer
            center={mapCenter}
            zoom={15}
            maxZoom={22}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; 国土地理院'
              url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
              maxZoom={22}
              maxNativeZoom={18}
            />
            <FitBoundsOnce
              bounds={bounds}
              key={pendingPolylines.length > 0 ? 'pending' : 'saved'}
            />
            {/* TIN 三角形エッジ: 薄灰 */}
            {tinEdgeLatLngs.map((e, idx) => (
              <Polyline
                key={`tin-${idx}`}
                positions={e}
                pathOptions={{ color: '#94a3b8', weight: 0.7, opacity: 0.7 }}
              />
            ))}
            {/* 床掘 TIN: 琥珀色 */}
            {trenchEdgeLatLngs.map((e, idx) => (
              <Polyline
                key={`trench-${idx}`}
                positions={e}
                pathOptions={{ color: '#d97706', weight: 1, opacity: 0.85 }}
              />
            ))}
            {/* 施工計画由来: 吸水=青・集水=緑 */}
            {derivedPolylines.map((p) => (
              <Polyline
                key={`derived-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: p.source === 'absorption' ? '#2563eb' : '#10b981',
                  weight: 2.5,
                  opacity: 0.9,
                }}
              />
            ))}
            {/* 保存済み (取り込み線形): 赤 */}
            {alignmentPolylines.map((p) => (
              <Polyline
                key={`saved-${p.id}`}
                positions={p.positions}
                pathOptions={{ color: '#dc2626', weight: 3, opacity: 0.9 }}
              />
            ))}
            {/* 取り込み直後のプレビュー: オレンジ（点線） */}
            {pendingPolylines.map((p) => (
              <Polyline
                key={`pending-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: '#f97316',
                  weight: 4,
                  opacity: 0.95,
                  dashArray: '6,6',
                }}
              />
            ))}
          </MapContainer>
          {/* 凡例 */}
          {(alignmentPolylines.length > 0 ||
            pendingPolylines.length > 0 ||
            derivedPolylines.length > 0 ||
            tinEdgeLatLngs.length > 0 ||
            trenchEdgeLatLngs.length > 0) && (
            <div className="absolute bottom-3 right-3 bg-white/90 border rounded px-2 py-1 text-xs space-y-1 shadow">
              {tinEdgeLatLngs.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-slate-400" />
                  <span>TIN メッシュ</span>
                </div>
              )}
              {trenchEdgeLatLngs.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-amber-600" />
                  <span>床掘 TIN</span>
                </div>
              )}
              {derivedPolylines.some((p) => p.source === 'absorption') && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-1 bg-blue-600" />
                  <span>吸水（施工計画）</span>
                </div>
              )}
              {derivedPolylines.some((p) => p.source === 'collector') && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-1 bg-emerald-500" />
                  <span>集水（施工計画）</span>
                </div>
              )}
              {alignmentPolylines.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-1 bg-red-600" />
                  <span>取込済み</span>
                </div>
              )}
              {pendingPolylines.length > 0 && (
                <div className="flex items-center gap-2">
                  <span
                    className="inline-block w-5 h-1"
                    style={{
                      background:
                        'repeating-linear-gradient(to right, #f97316 0 3px, transparent 3px 6px)',
                    }}
                  />
                  <span>プレビュー（未保存）</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function FitBoundsOnce({ bounds }: { bounds: L.LatLngBoundsExpression | null }) {
  const map = useMap()
  const doneRef = useRef(false)
  useEffect(() => {
    if (doneRef.current) return
    if (!bounds) return
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 20 })
    doneRef.current = true
  }, [map, bounds])
  return null
}
