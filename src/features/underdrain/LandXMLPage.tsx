import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FileOutput,
  Upload,
  Trash2,
  Loader2,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react'
import { MapContainer, TileLayer, Polygon, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { parseLandXml, type ParsedSurface } from '@/lib/landxml/parser'
import { sampleAlignment } from '@/lib/landxml/geometry'
import { buildAlignmentsFromPlan, alignmentZRange } from '@/lib/landxml/fromPlan'
import { buildTinSurface, buildTrenchTin } from '@/lib/landxml/surface'
import { buildLandXml } from '@/lib/landxml/exporter'
import { detectOverlaps, type OverlapResult } from '@/lib/landxml/overlap'
import { uploadLandxmlFile } from '@/lib/landxmlFiles'
import { CoordinateConverter } from '@/lib/coordinates'
import type { Alignment } from '@/lib/landxml/types'

export function LandXMLPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { zone, setZone } = useCoordinateStore()
  const {
    planGroups: rawPlanGroups,
    loadedForFarmId: planLoadedForFarmId,
    fetchPlan,
  } = useConstructionPlanStore()
  const {
    pipes: rawPipes,
    loadedForFarmId: pipesLoadedForFarmId,
    fetchPipes,
  } = useUnderdrainStore()
  const {
    surveyData: rawSurveyData,
    loadedForFarmId: surveyLoadedForFarmId,
    fetchSurveyData,
  } = useSurveyStore()

  // 工区読込時にデータ取得
  useEffect(() => {
    if (!currentFarm) return
    fetchPlan(currentFarm.id)
    fetchPipes(currentFarm.id)
    fetchSurveyData(currentFarm.id)
  }, [currentFarm, fetchPlan, fetchPipes, fetchSurveyData])

  // プロジェクトの座標系を適用
  useEffect(() => {
    if (!currentFarm?.project_id) return
    const proj = projects.find((p) => p.id === currentFarm.project_id)
    if (proj?.coordinate_zone) setZone(proj.coordinate_zone)
  }, [currentFarm, projects, setZone])

  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // planGroups は 現在の 圃場と 一致する時のみ 有効扱い
  // (store に 前の圃場の データが 残っている 可能性が あるため)
  const planGroups = useMemo(() => {
    if (!currentFarm) return []
    if (planLoadedForFarmId !== currentFarm.id) return []
    return rawPlanGroups
  }, [currentFarm, planLoadedForFarmId, rawPlanGroups])

  // pipes と surveyData も 同様の 圃場ガード。
  // TIN 生成 (buildTinSurface) が これらを 使うため、前圃場のを 使うと
  // 別現場の TIN が LandXML に 混入する。
  const pipes = useMemo(() => {
    if (!currentFarm) return []
    if (pipesLoadedForFarmId !== currentFarm.id) return []
    return rawPipes
  }, [currentFarm, pipesLoadedForFarmId, rawPipes])
  const surveyData = useMemo(() => {
    if (!currentFarm) return []
    if (surveyLoadedForFarmId !== currentFarm.id) return []
    return rawSurveyData
  }, [currentFarm, surveyLoadedForFarmId, rawSurveyData])

  // 施工計画から自動算出した中心線形（吸水・集水）
  const derivedAlignments = useMemo(() => {
    if (!planGroups || planGroups.length === 0) return []
    return buildAlignmentsFromPlan(planGroups)
  }, [planGroups])

  // 絞り込み: 吸水/集水を個別 on/off
  const [showAbsorption, setShowAbsorption] = useState(true)
  const [showCollector, setShowCollector] = useState(true)
  // 中心線形パネルの 折りたたみ (初期: 折る = リストが 邪魔になるため)
  const [derivedAlignmentsExpanded, setDerivedAlignmentsExpanded] = useState(false)

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

  // LandXML 出力設定
  const [exportDerivedAlignments, setExportDerivedAlignments] = useState(true)
  const [exportTinSurface, setExportTinSurface] = useState(false)
  const [exportTrenchSurface, setExportTrenchSurface] = useState(false)
  const [exporting, setExporting] = useState(false)

  // 重複チェック用の取込サーフェス
  const [checkSurfaces, setCheckSurfaces] = useState<ParsedSurface[]>([])
  const [overlapResult, setOverlapResult] = useState<OverlapResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const checkFileInputRef = useRef<HTMLInputElement | null>(null)

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

  // 地図フィット用 bounds（施工計画由来の線形）
  const bounds = useMemo(() => {
    const all: [number, number][] = []
    for (const p of derivedPolylines) all.push(...p.positions)
    if (all.length === 0) return null
    const lats = all.map((p) => p[0])
    const lngs = all.map((p) => p[1])
    return L.latLngBounds(
      [Math.min(...lats), Math.min(...lngs)],
      [Math.max(...lats), Math.max(...lngs)],
    )
  }, [derivedPolylines])

  const mapCenter: [number, number] = bounds
    ? [(bounds.getNorth() + bounds.getSouth()) / 2, (bounds.getEast() + bounds.getWest()) / 2]
    : [43.06, 141.35]

  // 出力対象が一つでもあるか
  const hasExportTarget =
    (exportDerivedAlignments && derivedAlignments.length > 0) ||
    (exportTinSurface && tinSurface !== null) ||
    (exportTrenchSurface && trenchSurface !== null)

  /**
   * 現在 の チェックボックス 設定 で XML 文字列 を 組み立てて 返す。
   * 返り値 が null なら 出力対象なし / データ 未ロード。 alert は 発火する。
   */
  const buildExportXml = (): string | null => {
    if (!hasExportTarget) return null
    if (currentFarm) {
      const farmId = currentFarm.id
      const staleStore =
        (exportDerivedAlignments && planLoadedForFarmId !== farmId) ||
        ((exportTinSurface || exportTrenchSurface) &&
          (pipesLoadedForFarmId !== farmId || surveyLoadedForFarmId !== farmId))
      if (staleStore) {
        alert(
          'データの 読み込み が 完了していません (前圃場の 残留 or ロード中)。\n' +
            '上部の 「🔄 再読込」ボタンで 最新化してから 再度お試しください。',
        )
        return null
      }
    }
    const out: Alignment[] = []
    if (exportDerivedAlignments) out.push(...derivedAlignments)
    const surfaces: { name: string; surface: NonNullable<typeof tinSurface> }[] = []
    if (exportTinSurface && tinSurface) {
      surfaces.push({ name: '地盤 TIN', surface: tinSurface })
    }
    if (exportTrenchSurface && trenchSurface) {
      surfaces.push({ name: '床掘 TIN', surface: trenchSurface })
    }
    return buildLandXml({
      alignments: out,
      surfaces,
      projectName: currentFarm?.name,
      coordinateZoneName: zone ? `JGD2011 / 平面直角座標系第${zone}系` : undefined,
    })
  }

  const handleExportLandXml = () => {
    setExporting(true)
    try {
      const xml = buildExportXml()
      if (xml == null) return
      const blob = new Blob([xml], { type: 'application/xml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${currentFarm?.name || 'export'}.xml`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  /**
   * 全体図 に エクスポート: 同じ XML を Storage (bucket=landxml) に アップロード し、
   * landxml_files に kind='design' の アクティブ 行 を 作成 する。
   * 全体図 (OrthophotoPage) は 工区 の active な design LandXML を 自動 表示 する ため、
   * これで 全体図 に 反映 される。 旧 active は uploadLandxmlFile 側で 非active 化。
   */
  const [uploadingToOverview, setUploadingToOverview] = useState(false)
  const [overviewExportStatus, setOverviewExportStatus] = useState<string | null>(null)
  const [overviewExportError, setOverviewExportError] = useState<string | null>(null)
  const handleExportToOverview = async () => {
    if (!currentFarm) return
    setOverviewExportError(null)
    setOverviewExportStatus(null)
    setUploadingToOverview(true)
    try {
      const xml = buildExportXml()
      if (xml == null) return
      const stamp = new Date()
        .toISOString()
        .slice(0, 19)
        .replace(/[-:T]/g, '')
      const fileName = `${currentFarm.name || 'underdrain'}-${stamp}.xml`
      await uploadLandxmlFile({
        farmId: currentFarm.id,
        fileName,
        content: xml,
        kind: 'design',
        notes: '暗渠 ICT 施工 (LandXML 出力)',
      })
      setOverviewExportStatus(
        `「${fileName}」を 全体図 に エクスポート しました (旧 active は 非active 化)`,
      )
    } catch (e) {
      console.error('[landxml overview export]', e)
      setOverviewExportError(e instanceof Error ? e.message : 'アップロード 失敗')
    } finally {
      setUploadingToOverview(false)
    }
  }

  // 重複チェック: ファイル取込
  const handleCheckFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return
    setCheckError(null)
    setOverlapResult(null)
    const added: ParsedSurface[] = []
    const warns: string[] = []
    for (const f of Array.from(files)) {
      try {
        const text = await f.text()
        const { surfaces, warnings } = parseLandXml(text, f.name)
        if (surfaces.length === 0) {
          warns.push(`${f.name}: Surface 要素が見つかりませんでした`)
        } else {
          added.push(...surfaces)
        }
        warns.push(...warnings)
      } catch (err) {
        warns.push(
          `${f.name}: ${err instanceof Error ? err.message : 'パースに失敗しました'}`,
        )
      }
    }
    if (added.length === 0) {
      setCheckError(warns.join(' / ') || 'TIN サーフェスが見つかりませんでした')
    } else {
      setCheckSurfaces((prev) => [...prev, ...added])
      if (warns.length > 0) setCheckError(warns.join(' / '))
    }
    if (checkFileInputRef.current) checkFileInputRef.current.value = ''
  }

  const handleCheckSurfaceRemove = (id: string) => {
    setCheckSurfaces((prev) => prev.filter((s) => s.id !== id))
    setOverlapResult(null)
  }

  const handleCheckClear = () => {
    setCheckSurfaces([])
    setOverlapResult(null)
    setCheckError(null)
  }

  const handleRunOverlapCheck = () => {
    if (checkSurfaces.length === 0) return
    setChecking(true)
    setOverlapResult(null)
    // 重い処理は次フレームで（UI ロックを避ける）
    setTimeout(() => {
      try {
        const inputs = checkSurfaces.map((s) => ({
          surfaceId: s.id,
          surfaceName: s.name,
          triangles: s.triangles.map((t, idx) => ({
            index: idx,
            vertices: [s.points[t.a], s.points[t.b], s.points[t.c]] as [
              { x: number; y: number },
              { x: number; y: number },
              { x: number; y: number },
            ],
          })),
        }))
        const result = detectOverlaps(inputs)
        setOverlapResult(result)
      } finally {
        setChecking(false)
      }
    }, 30)
  }

  // 地図に描画する「重複エラー三角形」のポリゴン（赤塗り）
  const errorTrianglePolygons = useMemo(() => {
    if (!overlapResult) return [] as Array<{ id: string; positions: [number, number][] }>
    const errSet = new Set(
      overlapResult.errorTriangles.map((e) => `${e.surfaceId}::${e.triangleIndex}`),
    )
    const out: Array<{ id: string; positions: [number, number][] }> = []
    for (const surf of checkSurfaces) {
      surf.triangles.forEach((t, idx) => {
        if (!errSet.has(`${surf.id}::${idx}`)) return
        const verts = [surf.points[t.a], surf.points[t.b], surf.points[t.c]]
        const ll: [number, number][] = []
        for (const p of verts) {
          try {
            const { lat, lng } = converter.toLatLng(p.x, p.y)
            if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
          } catch {
            // skip
          }
        }
        if (ll.length === 3) out.push({ id: `${surf.id}-${idx}`, positions: ll })
      })
    }
    return out
  }, [overlapResult, checkSurfaces, converter])

  // 地図に描画する「重複チェック対象の三角網」エッジ（薄紫、参考表示）
  const checkSurfaceEdges = useMemo(() => {
    const out: Array<[[number, number], [number, number]]> = []
    for (const surf of checkSurfaces) {
      for (const t of surf.triangles) {
        const verts = [surf.points[t.a], surf.points[t.b], surf.points[t.c]]
        const ll: [number, number][] = []
        for (const p of verts) {
          try {
            const { lat, lng } = converter.toLatLng(p.x, p.y)
            if (Number.isFinite(lat) && Number.isFinite(lng)) ll.push([lat, lng])
          } catch {
            // skip
          }
        }
        if (ll.length === 3) {
          out.push([ll[0], ll[1]])
          out.push([ll[1], ll[2]])
          out.push([ll[2], ll[0]])
        }
      }
    }
    return out
  }, [checkSurfaces, converter])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b bg-white flex items-center gap-3">
        <FileOutput className="h-5 w-5" />
        <div className="flex-1">
          <h1 className="text-xl font-bold">LandXML 出力</h1>
          <p className="text-sm text-muted-foreground">
            中心線形・面データを準備し、LandXML 1.2 形式で出力します
          </p>
        </div>
        {currentFarm && (
          <button
            type="button"
            onClick={() => {
              if (!currentFarm) return
              // 全データを 再取得 (施工計画 / パイプ / 実測)
              void fetchPlan(currentFarm.id)
              void fetchPipes(currentFarm.id)
              void fetchSurveyData(currentFarm.id)
            }}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border border-slate-300 rounded hover:bg-slate-50"
            title="施工計画 / パイプ / 実測データ を DB から 再取得"
          >
            <RefreshCw className="h-4 w-4" />
            再読込
          </button>
        )}
      </div>

      <ResizableSplit
        storageKey="landxml"
        defaultLeft={520}
        minLeft={320}
        maxLeft={900}
        className="flex-1"
        left={
        <div className="flex-1 border-r bg-white flex flex-col overflow-hidden">
          {/* 施工計画由来の線形 */}
          <div className="px-3 py-2 border-b bg-emerald-50">
            <button
              type="button"
              onClick={() => setDerivedAlignmentsExpanded((v) => !v)}
              className="w-full flex items-center gap-2 text-left"
              title={derivedAlignmentsExpanded ? '線形一覧を折りたたむ' : '線形一覧を展開する'}
            >
              <span
                className="inline-block text-slate-500 transition-transform"
                style={{
                  transform: derivedAlignmentsExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                }}
              >
                ▶
              </span>
              <div className="text-sm font-semibold">施工計画から算出した中心線形</div>
              <span className="text-xs text-slate-500">
                {derivedAlignments.length} 件
              </span>
              <span className="ml-auto text-[10px] text-slate-500">
                {derivedAlignmentsExpanded ? '折りたたむ' : '展開'}
              </span>
            </button>
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
            {derivedAlignmentsExpanded && derivedAlignments.length > 0 && (
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

          {/* 操作パネル（TIN 生成 / LandXML 出力） */}
          <div className="flex-1 overflow-auto p-3 space-y-3">
            {/* 面データ（TIN 生成） */}
            <div>
              <div className="text-sm font-semibold">1. 面データ（TIN 生成）</div>
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

            {/* LandXML 出力 */}
            <div className="border-t pt-3 mt-3">
              <div className="text-sm font-semibold">2. LandXML 出力</div>
              <div className="text-xs text-slate-500 mt-0.5">
                選択した中心線形・サーフェスを LandXML 1.2 形式で書き出します
              </div>
              <div className="mt-2 space-y-1 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportDerivedAlignments}
                    onChange={(e) => setExportDerivedAlignments(e.target.checked)}
                    disabled={derivedAlignments.length === 0}
                    className="h-3.5 w-3.5"
                  />
                  <span className={derivedAlignments.length === 0 ? 'text-slate-400' : ''}>
                    施工計画由来の中心線形（{derivedAlignments.length} 件）
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportTinSurface}
                    onChange={(e) => setExportTinSurface(e.target.checked)}
                    disabled={!tinSurface}
                    className="h-3.5 w-3.5"
                  />
                  <span className={!tinSurface ? 'text-slate-400' : ''}>
                    地盤 TIN
                    {tinSurface
                      ? `（${tinSurface.stats.triangleCount} 三角形）`
                      : '（上で生成して下さい）'}
                  </span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={exportTrenchSurface}
                    onChange={(e) => setExportTrenchSurface(e.target.checked)}
                    disabled={!trenchSurface}
                    className="h-3.5 w-3.5"
                  />
                  <span className={!trenchSurface ? 'text-slate-400' : ''}>
                    床掘 TIN
                    {trenchSurface
                      ? `（${trenchSurface.stats.triangleCount} 三角形）`
                      : '（上で生成して下さい）'}
                  </span>
                </label>
              </div>
              <div className="mt-2 flex flex-col gap-1.5">
                <button
                  type="button"
                  onClick={handleExportLandXml}
                  disabled={!hasExportTarget || exporting || !currentFarm}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-sm"
                >
                  {exporting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileOutput className="h-4 w-4" />
                  )}
                  {exporting ? '出力中...' : 'LandXML を ダウンロード'}
                </button>
                {/* 全体図 (OrthophotoPage) の 「設計面 (LandXML)」レイヤ に 反映 する。
                    工区 の active な design LandXML を 差替 (旧 active は 非active 化)。 */}
                <button
                  type="button"
                  onClick={() => void handleExportToOverview()}
                  disabled={!hasExportTarget || uploadingToOverview || !currentFarm}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-sm"
                  title="全体図 の 「設計面 (LandXML)」 として 保存 (工区 単位、他 端末 でも 反映)"
                >
                  {uploadingToOverview ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  {uploadingToOverview ? '保存中...' : '全体図 に エクスポート'}
                </button>
              </div>
              {!hasExportTarget && currentFarm && (
                <div className="text-[11px] text-slate-500 mt-1">
                  出力対象を 1 つ以上選択してください
                </div>
              )}
              {overviewExportStatus && (
                <div className="mt-1 text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1">
                  {overviewExportStatus}
                </div>
              )}
              {overviewExportError && (
                <div className="mt-1 text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
                  {overviewExportError}
                </div>
              )}
            </div>

            {/* LandXML 重複チェック */}
            <div className="border-t pt-3 mt-3">
              <div className="text-sm font-semibold">3. LandXML 重複チェック</div>
              <div className="text-xs text-slate-500 mt-0.5">
                取り込んだ TIN サーフェスの三角形同士で内部が重なるペアを検出します
                <br />
                （エッジ・頂点だけ共有する隣接状態は OK）
              </div>

              <input
                ref={checkFileInputRef}
                type="file"
                accept=".xml,.landxml"
                multiple
                onChange={handleCheckFileChange}
                className="hidden"
              />
              <div className="flex gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => checkFileInputRef.current?.click()}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 text-xs"
                >
                  <Upload className="h-3.5 w-3.5" />
                  LandXML を追加
                </button>
                <button
                  type="button"
                  onClick={handleCheckClear}
                  disabled={checkSurfaces.length === 0}
                  className="px-3 py-1.5 border rounded hover:bg-slate-50 disabled:opacity-50 text-xs"
                >
                  クリア
                </button>
              </div>

              {checkError && (
                <div className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-1.5 flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 flex-shrink-0 mt-0.5" />
                  <span className="break-all">{checkError}</span>
                </div>
              )}

              {checkSurfaces.length > 0 && (
                <div className="mt-2 max-h-48 overflow-auto border rounded bg-white">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="text-left font-normal px-2 py-1">サーフェス</th>
                        <th className="text-right font-normal px-2 py-1">点</th>
                        <th className="text-right font-normal px-2 py-1">面</th>
                        <th className="px-1 py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {checkSurfaces.map((s) => (
                        <tr key={s.id} className="border-t">
                          <td className="px-2 py-0.5 truncate max-w-[200px]" title={s.name}>
                            {s.name}
                            {s.sourceFile && (
                              <span className="ml-1 text-slate-400">
                                ({s.sourceFile})
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono">
                            {s.points.length}
                          </td>
                          <td className="px-2 py-0.5 text-right font-mono">
                            {s.triangles.length}
                          </td>
                          <td className="px-1 py-0.5">
                            <button
                              onClick={() => handleCheckSurfaceRemove(s.id)}
                              className="p-0.5 text-slate-400 hover:text-red-500"
                              title="除外"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <button
                type="button"
                onClick={handleRunOverlapCheck}
                disabled={checkSurfaces.length === 0 || checking}
                className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-1.5 bg-amber-600 text-white rounded hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed text-xs"
              >
                {checking ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <AlertTriangle className="h-3.5 w-3.5" />
                )}
                {checking ? '検査中...' : '重複チェックを実行'}
              </button>

              {overlapResult && (
                <div className="mt-2 text-[11px] border rounded p-2 space-y-1">
                  <div
                    className={
                      overlapResult.pairs.length === 0
                        ? 'text-emerald-700 font-semibold'
                        : 'text-red-700 font-semibold'
                    }
                  >
                    {overlapResult.pairs.length === 0
                      ? `重複なし（${overlapResult.pairsChecked} ペア検査）`
                      : `${overlapResult.pairs.length} 件の重複が見つかりました（エラー三角形 ${overlapResult.errorTriangles.length} / ${overlapResult.pairsChecked} ペア検査）`}
                  </div>
                  {overlapResult.pairs.length > 0 && (
                    <div className="max-h-48 overflow-auto border-t pt-1 mt-1">
                      <table className="w-full text-[10px]">
                        <thead className="text-slate-500">
                          <tr>
                            <th className="text-left font-normal pr-1">A</th>
                            <th className="text-left font-normal pr-1">B</th>
                            <th className="text-right font-normal">面積 (m²)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {overlapResult.pairs.map((p, i) => (
                            <tr key={i} className="border-t">
                              <td className="pr-1 truncate max-w-[120px]">
                                {p.aSurfaceName}#{p.aTriangleIndex}
                              </td>
                              <td className="pr-1 truncate max-w-[120px]">
                                {p.bSurfaceName}#{p.bTriangleIndex}
                              </td>
                              <td className="text-right font-mono">
                                {p.overlapArea.toFixed(4)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        }
        right={
        <div className="flex-1 relative">
          <MapContainer
            center={mapCenter}
            zoom={15}
            maxZoom={24}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; 国土地理院'
              url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
              maxZoom={24}
              maxNativeZoom={18}
            />
            <FitBoundsOnce bounds={bounds} />
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
            {/* 重複チェック対象 TIN: 紫の薄エッジ */}
            {checkSurfaceEdges.map((e, idx) => (
              <Polyline
                key={`check-${idx}`}
                positions={e}
                pathOptions={{ color: '#a855f7', weight: 0.5, opacity: 0.6 }}
              />
            ))}
            {/* 重複エラー三角形: 赤の塗りつぶし */}
            {errorTrianglePolygons.map((p) => (
              <Polygon
                key={`err-${p.id}`}
                positions={p.positions}
                pathOptions={{
                  color: '#dc2626',
                  weight: 1.5,
                  fillColor: '#ef4444',
                  fillOpacity: 0.4,
                }}
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
          </MapContainer>
          {/* 凡例 */}
          {(derivedPolylines.length > 0 ||
            tinEdgeLatLngs.length > 0 ||
            trenchEdgeLatLngs.length > 0 ||
            checkSurfaceEdges.length > 0) && (
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
              {checkSurfaceEdges.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-0.5 bg-purple-500" />
                  <span>重複チェック対象</span>
                </div>
              )}
              {errorTrianglePolygons.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-5 h-2 bg-red-500/40 border border-red-600" />
                  <span>重複エラー</span>
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
            </div>
          )}
        </div>
        }
      />
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
