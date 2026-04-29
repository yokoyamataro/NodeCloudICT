import { useEffect, useMemo, useState } from 'react'
import { Layers, MousePointerClick, RotateCcw, Pencil, CornerDownRight, Undo2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  generateBranchStrips,
  generateGridStrips,
  totalLength,
  bufferPolyline,
  bufferSegments,
  type XY,
} from '@/lib/stripPlanGeometry'
import { StripPlanMap, type StripPlanBaseLayer } from './StripPlanMap'

// 帯置計画パラメータ
interface StripPlanParams {
  thicknessB: number
  dumpCapacityV: number
  crossWA: number
  crossWB: number
  crossH: number
}

const DEFAULT_PARAMS: StripPlanParams = {
  thicknessB: 0.10,
  dumpCapacityV: 7.1,
  crossWA: 4.5,
  crossWB: 5.0,
  crossH: 0.5,
}

type Pattern = 'branch' | 'grid' | 'free'

function NumberField({
  label,
  unit,
  value,
  onChange,
  decimals = 2,
  step = 0.01,
}: {
  label: string
  unit: string
  value: number
  onChange: (v: number) => void
  decimals?: number
  step?: number
}) {
  const [local, setLocal] = useState(value.toFixed(decimals))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setLocal(value.toFixed(decimals))
  }, [value, focused, decimals])
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step={step}
          value={local}
          onFocus={() => {
            setFocused(true)
            setLocal(String(value))
          }}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            setFocused(false)
            const n = parseFloat(local)
            if (!isNaN(n) && n >= 0) onChange(n)
            else setLocal(value.toFixed(decimals))
          }}
          className="w-full px-2 py-1.5 border rounded text-right"
        />
        <span className="text-xs text-slate-500 whitespace-nowrap">{unit}</span>
      </div>
    </label>
  )
}

function ResultCard({ label, value, unit, hint }: { label: string; value: string; unit: string; hint?: string }) {
  return (
    <div className="bg-white border rounded-lg p-3 shadow-sm">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-xl font-bold text-slate-800">{value}</span>
        <span className="text-xs text-slate-500">{unit}</span>
      </div>
      {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
    </div>
  )
}

export function SoilImportStripPlanPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { fetchWorkAreas, getWorkAreasByType } = useWorkAreaStore()
  const farmId = currentFarm?.id

  useEffect(() => {
    if (farmId) fetchWorkAreas(farmId)
  }, [farmId, fetchWorkAreas])

  // プロジェクトの座標系
  const zone = useMemo(() => {
    if (!currentFarm) return 13
    const proj = projects.find((p) => p.id === currentFarm.project_id)
    return proj?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  const areas = getWorkAreasByType('soil_import')
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  const [params, setParams] = useState<StripPlanParams>(DEFAULT_PARAMS)
  const [pattern, setPattern] = useState<Pattern>('branch')
  const [interval, setInterval] = useState<number>(20) // m
  const [baseLayer, setBaseLayer] = useState<StripPlanBaseLayer>('gsi-photo')
  const [pickMode, setPickMode] = useState(false)
  const [baselineLatLng, setBaselineLatLng] = useState<[number, number][]>([])
  // フリー描画
  const [freeDrawMode, setFreeDrawMode] = useState(false)
  const [freeLines, setFreeLines] = useState<[number, number][][]>([])
  const [freeCurrent, setFreeCurrent] = useState<[number, number][]>([])
  const [hoverLatLng, setHoverLatLng] = useState<[number, number] | null>(null)

  useEffect(() => {
    if (!selectedAreaId && areas.length > 0) {
      setSelectedAreaId(areas[0].id)
    }
  }, [areas, selectedAreaId])

  // 区域変更時は基線・フリー描画をリセット
  useEffect(() => {
    setBaselineLatLng([])
    setPickMode(false)
    setFreeLines([])
    setFreeCurrent([])
    setFreeDrawMode(false)
  }, [selectedAreaId])

  // パターン切替時はピック・描画モードを抜ける
  useEffect(() => {
    setPickMode(false)
    setFreeDrawMode(false)
  }, [pattern])

  const selectedArea = areas.find((a) => a.id === selectedAreaId) ?? null

  // 区域ポリゴン（lat/lng）
  const areaLatLng = useMemo<[number, number][]>(() => {
    if (!selectedArea) return []
    return selectedArea.points
      .filter((p) => p.lat !== null && p.lng !== null)
      .map((p) => [p.lat!, p.lng!] as [number, number])
  }, [selectedArea])

  // 区域ポリゴン（XY 平面直角座標）
  const areaXY = useMemo<XY[]>(() => {
    if (!selectedArea) return []
    return selectedArea.points.map((p) => ({ x: p.x, y: p.y }))
  }, [selectedArea])

  // 計算
  const calc = useMemo(() => {
    const areaHa = selectedArea?.areaHa ?? 0
    const areaSqm = selectedArea?.areaSqm ?? areaHa * 10000
    const V = areaSqm * params.thicknessB
    const v = params.dumpCapacityV
    const n = v > 0 ? Math.ceil(V / v) : 0
    const CA = ((params.crossWA + params.crossWB) * params.crossH) / 2
    const L = CA > 0 ? V / CA : 0
    const lengthPerTruck = CA > 0 ? v / CA : 0
    return { areaSqm, V, v, n, CA, L, lengthPerTruck }
  }, [selectedArea, params])

  // 基線（XY）
  const baselineXY = useMemo<XY[]>(() => {
    return baselineLatLng.map((ll) => {
      const { x, y } = converter.toXY(ll[0], ll[1])
      return { x, y }
    })
  }, [baselineLatLng, converter])

  // 帯線生成（branch/grid のみ。free はユーザー入力をそのまま使う）
  const strips = useMemo(() => {
    if (pattern === 'free' || baselineXY.length < 2 || areaXY.length < 3) {
      return { axisXY: [] as [XY, XY][], parallelXY: [] as [XY, XY][], perpXY: [] as [XY, XY][] }
    }
    if (pattern === 'branch') {
      const r = generateBranchStrips(baselineXY[0], baselineXY[1], areaXY, interval, params.crossWB)
      return { axisXY: r.axisSegments, parallelXY: [] as [XY, XY][], perpXY: r.branchSegments }
    } else {
      const r = generateGridStrips(baselineXY[0], baselineXY[1], areaXY, interval)
      return { axisXY: [] as [XY, XY][], parallelXY: r.parallelSegments, perpXY: r.perpendicularSegments }
    }
  }, [baselineXY, areaXY, pattern, interval, params.crossWB])

  // 描画用に lat/lng に戻す
  const segmentsToLatLng = (segs: [XY, XY][]): [number, number][][] =>
    segs.map((seg) => seg.map(({ x, y }) => {
      const { lat, lng } = converter.toLatLng(x, y)
      return [lat, lng] as [number, number]
    }))
  const polygonsToLatLng = (polys: XY[][]): [number, number][][] =>
    polys.map((poly) => poly.map(({ x, y }) => {
      const { lat, lng } = converter.toLatLng(x, y)
      return [lat, lng] as [number, number]
    }))

  const axisLines = useMemo(() => segmentsToLatLng(strips.axisXY), [strips.axisXY, converter]) // eslint-disable-line react-hooks/exhaustive-deps
  const parallelLines = useMemo(() => segmentsToLatLng(strips.parallelXY), [strips.parallelXY, converter]) // eslint-disable-line react-hooks/exhaustive-deps
  const perpLines = useMemo(() => segmentsToLatLng(strips.perpXY), [strips.perpXY, converter]) // eslint-disable-line react-hooks/exhaustive-deps

  // 帯幅 WB の半幅
  const halfWidth = params.crossWB / 2

  // 帯ポリゴン（XY → lat/lng）
  const axisBuffers = useMemo(
    () => polygonsToLatLng(bufferSegments(strips.axisXY, halfWidth)),
    [strips.axisXY, halfWidth, converter] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const parallelBuffers = useMemo(
    () => polygonsToLatLng(bufferSegments(strips.parallelXY, halfWidth)),
    [strips.parallelXY, halfWidth, converter] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const perpBuffers = useMemo(
    () => polygonsToLatLng(bufferSegments(strips.perpXY, halfWidth)),
    [strips.perpXY, halfWidth, converter] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // フリー描画ラインの XY 化と長さ（確定済み + 入力途中）
  const freeLinesLengthM = useMemo(() => {
    let total = 0
    for (const line of [...freeLines, freeCurrent]) {
      for (let i = 1; i < line.length; i++) {
        const a = converter.toXY(line[i - 1][0], line[i - 1][1])
        const b = converter.toXY(line[i][0], line[i][1])
        total += Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    return total
  }, [freeLines, freeCurrent, converter])

  // マウス追従プレビューセグメント（直前点 → ホバー位置）
  const previewSegment = useMemo<[[number, number], [number, number]] | undefined>(() => {
    if (pattern !== 'free' || !freeDrawMode) return undefined
    if (freeCurrent.length === 0 || !hoverLatLng) return undefined
    const last = freeCurrent[freeCurrent.length - 1]
    return [last, hoverLatLng]
  }, [pattern, freeDrawMode, freeCurrent, hoverLatLng])

  // プレビュー区間の長さ
  const previewLengthM = useMemo(() => {
    if (!previewSegment) return 0
    const a = converter.toXY(previewSegment[0][0], previewSegment[0][1])
    const b = converter.toXY(previewSegment[1][0], previewSegment[1][1])
    return Math.hypot(a.x - b.x, a.y - b.y)
  }, [previewSegment, converter])

  // フリー描画ラインの帯ポリゴン（確定済み + 入力途中 + プレビュー）
  const freeBuffers = useMemo<[number, number][][]>(() => {
    if (pattern !== 'free') return []
    const result: [number, number][][] = []
    // 確定済みライン
    for (const line of freeLines) {
      const lineXY = line.map((ll) => {
        const xy = converter.toXY(ll[0], ll[1])
        return { x: xy.x, y: xy.y }
      })
      const buf = bufferPolyline(lineXY, halfWidth)
      if (buf) {
        result.push(buf.map(({ x, y }) => {
          const { lat, lng } = converter.toLatLng(x, y)
          return [lat, lng] as [number, number]
        }))
      }
    }
    // 入力途中ライン（+ プレビュー位置を末尾に追加）
    const drawing: [number, number][] = [
      ...freeCurrent,
      ...(previewSegment ? [previewSegment[1]] : []),
    ]
    if (drawing.length >= 2) {
      const lineXY = drawing.map((ll) => {
        const xy = converter.toXY(ll[0], ll[1])
        return { x: xy.x, y: xy.y }
      })
      const buf = bufferPolyline(lineXY, halfWidth)
      if (buf) {
        result.push(buf.map(({ x, y }) => {
          const { lat, lng } = converter.toLatLng(x, y)
          return [lat, lng] as [number, number]
        }))
      }
    }
    return result
  }, [pattern, freeLines, freeCurrent, previewSegment, halfWidth, converter])

  // 統計（フリー時はプレビュー区間も含む）
  const generated = useMemo(() => {
    if (pattern === 'free') {
      const lenTotal = freeLinesLengthM + previewLengthM
      const trucks = calc.lengthPerTruck > 0 ? lenTotal / calc.lengthPerTruck : 0
      // 描画中の現在線が 1 点以上ある場合も「現在描画中の線」として 1 本扱い
      const drawingExtra = freeCurrent.length >= 1 ? 1 : 0
      return { lenTotal, trucks, lineCount: freeLines.length + drawingExtra }
    }
    const all: [XY, XY][] = [...strips.axisXY, ...strips.parallelXY, ...strips.perpXY]
    const lenTotal = totalLength(all)
    const trucks = calc.lengthPerTruck > 0 ? lenTotal / calc.lengthPerTruck : 0
    return { lenTotal, trucks, lineCount: all.length }
  }, [strips, calc.lengthPerTruck, pattern, freeLines.length, freeCurrent.length, freeLinesLengthM, previewLengthM])

  // 目標との差分
  const diff = useMemo(() => {
    const dLen = generated.lenTotal - calc.L
    const dTrucks = generated.trucks - calc.n
    return { dLen, dTrucks }
  }, [generated, calc.L, calc.n])

  const handleMapClick = (ll: [number, number]) => {
    if (freeDrawMode) {
      setFreeCurrent((prev) => [...prev, ll])
      return
    }
    if (pickMode) {
      setBaselineLatLng((prev) => {
        if (prev.length >= 2) return [ll]
        const next = [...prev, ll]
        if (next.length >= 2) setPickMode(false)
        return next
      })
    }
  }

  const resetBaseline = () => {
    setBaselineLatLng([])
    setPickMode(false)
  }

  const finishFreeLine = () => {
    if (freeCurrent.length >= 2) {
      setFreeLines((prev) => [...prev, freeCurrent])
    }
    setFreeCurrent([])
  }

  const undoFreePoint = () => {
    if (freeCurrent.length > 0) {
      setFreeCurrent((prev) => prev.slice(0, -1))
    } else if (freeLines.length > 0) {
      // 直前の確定線を再編集状態に戻す
      setFreeCurrent(freeLines[freeLines.length - 1])
      setFreeLines((prev) => prev.slice(0, -1))
    }
  }

  const resetFree = () => {
    setFreeLines([])
    setFreeCurrent([])
    setFreeDrawMode(false)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="帯置計画作成" subtitle="客土工事 / 帯置計画" />
        <div className="flex-1 flex items-center justify-center text-slate-500">
          圃場を選択してください
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="帯置計画作成" subtitle="客土工事 / 帯置計画" />

      <div className="flex-1 flex overflow-hidden">
        {/* 左：パラメータ・操作 */}
        <div className="w-[440px] overflow-auto p-4 bg-slate-50 border-r space-y-4">
          {/* 工事区域 */}
          <section className="bg-white rounded-lg border p-3">
            <div className="flex items-center gap-2 mb-2">
              <Layers className="h-4 w-4 text-slate-600" />
              <h2 className="font-semibold text-slate-800 text-sm">対象の工事区域</h2>
            </div>
            {areas.length === 0 ? (
              <div className="text-xs text-slate-500">
                客土工事の工事区域がありません。先に「工事区域」で区域を作成してください。
              </div>
            ) : (
              <>
                <select
                  value={selectedAreaId ?? ''}
                  onChange={(e) => setSelectedAreaId(e.target.value || null)}
                  className="w-full px-2 py-1.5 border rounded text-sm"
                >
                  {areas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.zoneNumber} {a.name}
                    </option>
                  ))}
                </select>
                <div className="text-xs text-slate-500 mt-1">
                  面積 A: {selectedArea?.areaHa != null
                    ? `${selectedArea.areaHa.toFixed(2)} ha（${(selectedArea.areaSqm ?? 0).toFixed(0)} m²）`
                    : '未計算'}
                </div>
              </>
            )}
          </section>

          {/* 入力パラメータ */}
          <section className="bg-white rounded-lg border p-3">
            <h2 className="font-semibold text-slate-800 text-sm mb-2">入力パラメータ</h2>
            <div className="grid grid-cols-2 gap-3">
              <NumberField label="客土厚 B" unit="m" value={params.thicknessB}
                onChange={(v) => setParams((p) => ({ ...p, thicknessB: v }))} step={0.01} />
              <NumberField label="ダンプ積載量 v" unit="m³" value={params.dumpCapacityV}
                onChange={(v) => setParams((p) => ({ ...p, dumpCapacityV: v }))} step={0.1} />
              <NumberField label="帯断面 上底 WA" unit="m" value={params.crossWA}
                onChange={(v) => setParams((p) => ({ ...p, crossWA: v }))} step={0.1} />
              <NumberField label="帯断面 下底 WB" unit="m" value={params.crossWB}
                onChange={(v) => setParams((p) => ({ ...p, crossWB: v }))} step={0.1} />
              <NumberField label="帯断面 厚さ H" unit="m" value={params.crossH}
                onChange={(v) => setParams((p) => ({ ...p, crossH: v }))} step={0.05} />
            </div>
          </section>

          {/* 計算結果 */}
          <section className="grid grid-cols-2 gap-2">
            <ResultCard label="客土量 V" value={calc.V.toFixed(1)} unit="m³"
              hint={`= ${calc.areaSqm.toFixed(0)} × ${params.thicknessB}`} />
            <ResultCard label="台数 n" value={calc.n.toString()} unit="台"
              hint={`V/v = ${calc.v > 0 ? (calc.V / calc.v).toFixed(2) : '-'}`} />
            <ResultCard label="帯断面 CA" value={calc.CA.toFixed(3)} unit="m²" />
            <ResultCard label="必要総延長 L" value={calc.L.toFixed(1)} unit="m"
              hint={`v/CA=${calc.lengthPerTruck.toFixed(2)} m/台`} />
          </section>

          {/* 配置パターン */}
          <section className="bg-white rounded-lg border p-3 space-y-3">
            <h2 className="font-semibold text-slate-800 text-sm">配置パターン</h2>
            <div className="flex gap-2 text-sm">
              <label className={`flex-1 flex items-center justify-center gap-1 px-3 py-1.5 border rounded cursor-pointer ${pattern === 'branch' ? 'bg-orange-100 border-orange-400' : ''}`}>
                <input type="radio" className="hidden" checked={pattern === 'branch'} onChange={() => setPattern('branch')} />
                枝状
              </label>
              <label className={`flex-1 flex items-center justify-center gap-1 px-3 py-1.5 border rounded cursor-pointer ${pattern === 'grid' ? 'bg-orange-100 border-orange-400' : ''}`}>
                <input type="radio" className="hidden" checked={pattern === 'grid'} onChange={() => setPattern('grid')} />
                格子状
              </label>
              <label className={`flex-1 flex items-center justify-center gap-1 px-3 py-1.5 border rounded cursor-pointer ${pattern === 'free' ? 'bg-orange-100 border-orange-400' : ''}`}>
                <input type="radio" className="hidden" checked={pattern === 'free'} onChange={() => setPattern('free')} />
                フリー
              </label>
            </div>
            {pattern !== 'free' && (
              <NumberField label={pattern === 'branch' ? '枝の間隔' : '格子の間隔'}
                unit="m" value={interval} onChange={setInterval} step={1} decimals={1} />
            )}
          </section>

          {/* 操作パネル：パターン別 */}
          {pattern !== 'free' ? (
            <section className="bg-white rounded-lg border p-3 space-y-2">
              <h2 className="font-semibold text-slate-800 text-sm">基線（軸）</h2>
              <div className="text-xs text-slate-500">
                {baselineLatLng.length === 0 && '地図上の 2 点をクリックして基線を指定'}
                {baselineLatLng.length === 1 && '2 点目をクリック'}
                {baselineLatLng.length === 2 && '基線設定済み（やり直すにはリセット）'}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPickMode(!pickMode)}
                  disabled={!selectedArea || areaLatLng.length < 3}
                  className={`flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded ${pickMode ? 'bg-orange-100 border-orange-400' : 'hover:bg-slate-50'} disabled:opacity-50`}
                >
                  <MousePointerClick className="h-3.5 w-3.5" />
                  {pickMode ? '選択中…' : '基線を指定'}
                </button>
                <button
                  type="button"
                  onClick={resetBaseline}
                  disabled={baselineLatLng.length === 0}
                  className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  リセット
                </button>
              </div>
            </section>
          ) : (
            <section className="bg-white rounded-lg border p-3 space-y-2">
              <h2 className="font-semibold text-slate-800 text-sm">フリー描画</h2>
              <div className="text-xs text-slate-500">
                {!freeDrawMode && '「描画開始」を押して、地図クリックで帯の中心線を作図'}
                {freeDrawMode && freeCurrent.length === 0 && '地図クリックで点を追加'}
                {freeDrawMode && freeCurrent.length > 0 && `現在の線：${freeCurrent.length} 点 / 「次の帯」で確定して新しい線へ`}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setFreeDrawMode(!freeDrawMode)}
                  disabled={!selectedArea || areaLatLng.length < 3}
                  className={`flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded ${freeDrawMode ? 'bg-orange-100 border-orange-400' : 'hover:bg-slate-50'} disabled:opacity-50`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {freeDrawMode ? '描画中…' : '描画開始'}
                </button>
                <button
                  type="button"
                  onClick={finishFreeLine}
                  disabled={freeCurrent.length < 2}
                  className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                  title="現在の線を確定して新しい線へ"
                >
                  <CornerDownRight className="h-3.5 w-3.5" />
                  次の帯
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={undoFreePoint}
                  disabled={freeCurrent.length === 0 && freeLines.length === 0}
                  className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  <Undo2 className="h-3.5 w-3.5" />
                  1点戻る
                </button>
                <button
                  type="button"
                  onClick={resetFree}
                  disabled={freeCurrent.length === 0 && freeLines.length === 0}
                  className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  全削除
                </button>
              </div>
              <div className="text-xs text-slate-500">
                確定済み：{freeLines.length} 本（合計 {freeLinesLengthM.toFixed(1)} m）
              </div>
            </section>
          )}

          {/* 生成統計 + 目標との差分 */}
          {((pattern !== 'free' && baselineLatLng.length === 2) || (pattern === 'free' && (freeLines.length > 0 || freeCurrent.length >= 1))) && (
            <section className="space-y-2">
              <table className="w-full text-xs bg-white border rounded-lg overflow-hidden">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-medium">項目</th>
                    <th className="px-2 py-1.5 text-right font-medium">生成</th>
                    <th className="px-2 py-1.5 text-right font-medium">目標</th>
                    <th className="px-2 py-1.5 text-right font-medium">差分</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-t">
                    <td className="px-2 py-1.5">総延長 (m)</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{generated.lenTotal.toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{calc.L.toFixed(1)}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${diff.dLen < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {diff.dLen >= 0 ? '+' : ''}{diff.dLen.toFixed(1)}
                    </td>
                  </tr>
                  <tr className="border-t">
                    <td className="px-2 py-1.5">台数 (台)</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{generated.trucks.toFixed(1)}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{calc.n}</td>
                    <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${diff.dTrucks < 0 ? 'text-red-600' : 'text-green-600'}`}>
                      {diff.dTrucks >= 0 ? '+' : ''}{diff.dTrucks.toFixed(1)}
                    </td>
                  </tr>
                  <tr className="border-t">
                    <td className="px-2 py-1.5">本数 (本)</td>
                    <td className="px-2 py-1.5 text-right tabular-nums" colSpan={3}>
                      {generated.lineCount}
                    </td>
                  </tr>
                </tbody>
              </table>
              {pattern === 'free' && previewLengthM > 0 && (
                <div className="text-xs text-purple-600 px-1">
                  プレビュー区間：{previewLengthM.toFixed(1)} m（{calc.lengthPerTruck > 0 ? (previewLengthM / calc.lengthPerTruck).toFixed(2) : '-'} 台分）
                </div>
              )}
            </section>
          )}
        </div>

        {/* 右：地図 */}
        <div className="flex-1 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b bg-white">
            <span className="text-xs text-slate-600">背景</span>
            <select
              value={baseLayer}
              onChange={(e) => setBaseLayer(e.target.value as StripPlanBaseLayer)}
              className="text-xs border rounded px-1 py-0.5"
            >
              <option value="gsi-photo">航空写真</option>
              <option value="gsi-std">地理院地図</option>
              <option value="osm">OSM</option>
            </select>
          </div>
          <div className="flex-1">
            <StripPlanMap
              areaPolygon={areaLatLng}
              baseline={baselineLatLng}
              axisLines={axisLines}
              parallelLines={parallelLines}
              perpLines={perpLines}
              freeLines={freeLines}
              freeCurrent={freeCurrent}
              previewSegment={previewSegment}
              axisBuffers={axisBuffers}
              parallelBuffers={parallelBuffers}
              perpBuffers={perpBuffers}
              freeBuffers={freeBuffers}
              baseLayer={baseLayer}
              pickMode={pickMode || freeDrawMode}
              onMapClick={handleMapClick}
              onMouseMove={setHoverLatLng}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
