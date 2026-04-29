import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Layers, RotateCcw, Pencil, CornerDownRight, Undo2, Trash2, Edit3,
  Copy, Square as SquareIcon, Move, Settings, X,
} from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  bufferPolyline,
  polylineLength,
  polylineMidpoint,
  snapEndpointToMultiple,
  nearestPointOnPolyline,
  offsetPolyline,
  polylineSegmentDirection,
  type XY,
} from '@/lib/stripPlanGeometry'
import { StripPlanMap, type StripPlanBaseLayer, type StripLabel } from './StripPlanMap'

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

type Mode = 'idle' | 'draw' | 'parallel' | 'perp1' | 'perp2' | 'edit' | 'extend'

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

function ParamsModal({
  params,
  onChange,
  onClose,
}: {
  params: StripPlanParams
  onChange: (p: StripPlanParams) => void
  onClose: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg p-5 w-full max-w-md mx-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold">入力パラメータ</h2>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <NumberField label="客土厚 B" unit="m" value={params.thicknessB}
            onChange={(v) => onChange({ ...params, thicknessB: v })} step={0.01} />
          <NumberField label="ダンプ積載量 v" unit="m³" value={params.dumpCapacityV}
            onChange={(v) => onChange({ ...params, dumpCapacityV: v })} step={0.1} />
          <NumberField label="帯断面 上底 WA" unit="m" value={params.crossWA}
            onChange={(v) => onChange({ ...params, crossWA: v })} step={0.1} />
          <NumberField label="帯断面 下底 WB" unit="m" value={params.crossWB}
            onChange={(v) => onChange({ ...params, crossWB: v })} step={0.1} />
          <NumberField label="帯断面 厚さ H" unit="m" value={params.crossH}
            onChange={(v) => onChange({ ...params, crossH: v })} step={0.05} />
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
            閉じる
          </button>
        </div>
      </div>
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

  const zone = useMemo(() => {
    if (!currentFarm) return 13
    const proj = projects.find((p) => p.id === currentFarm.project_id)
    return proj?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  const areas = getWorkAreasByType('soil_import')
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  const [params, setParams] = useState<StripPlanParams>(DEFAULT_PARAMS)
  const [showParamsModal, setShowParamsModal] = useState(false)
  const [baseLayer, setBaseLayer] = useState<StripPlanBaseLayer>('gsi-photo')

  const [mode, setMode] = useState<Mode>('idle')
  const [freeLines, setFreeLines] = useState<[number, number][][]>([])
  const [freeCurrent, setFreeCurrent] = useState<[number, number][]>([])
  const [hoverLatLng, setHoverLatLng] = useState<[number, number] | null>(null)
  const [selectedFreeIdx, setSelectedFreeIdx] = useState<number | null>(null)
  const [perpAnchor, setPerpAnchor] = useState<[number, number] | null>(null)
  // 平行コピーの間隔モード
  const [parallelMode, setParallelMode] = useState<'distance' | 'truckMultiple'>('distance')
  const [parallelDistance, setParallelDistance] = useState<number>(10)
  const [parallelTruckMultiple, setParallelTruckMultiple] = useState<number>(1)
  const [roundToTruck, setRoundToTruck] = useState(false)
  const skipNextMapClickRef = useRef(false)

  useEffect(() => {
    if (!selectedAreaId && areas.length > 0) {
      setSelectedAreaId(areas[0].id)
    }
  }, [areas, selectedAreaId])

  // 区域変更時はリセット
  useEffect(() => {
    setFreeLines([])
    setFreeCurrent([])
    setMode('idle')
    setSelectedFreeIdx(null)
    setPerpAnchor(null)
  }, [selectedAreaId])

  // モード遷移時の整理
  useEffect(() => {
    if (mode === 'idle') {
      setPerpAnchor(null)
    }
  }, [mode])

  const selectedArea = areas.find((a) => a.id === selectedAreaId) ?? null

  const areaLatLng = useMemo<[number, number][]>(() => {
    if (!selectedArea) return []
    return selectedArea.points
      .filter((p) => p.lat !== null && p.lng !== null)
      .map((p) => [p.lat!, p.lng!] as [number, number])
  }, [selectedArea])

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

  const adjustEndpoint = (anchor: [number, number], target: [number, number]): [number, number] => {
    if (!roundToTruck || calc.lengthPerTruck <= 0) return target
    const aXY = converter.toXY(anchor[0], anchor[1])
    const tXY = converter.toXY(target[0], target[1])
    const snapped = snapEndpointToMultiple({ x: aXY.x, y: aXY.y }, { x: tXY.x, y: tXY.y }, calc.lengthPerTruck)
    const { lat, lng } = converter.toLatLng(snapped.x, snapped.y)
    return [lat, lng]
  }

  const previewSegment = useMemo<[[number, number], [number, number]] | undefined>(() => {
    if (mode !== 'draw') return undefined
    if (freeCurrent.length === 0 || !hoverLatLng) return undefined
    const last = freeCurrent[freeCurrent.length - 1]
    return [last, adjustEndpoint(last, hoverLatLng)]
  }, [mode, freeCurrent, hoverLatLng, roundToTruck, calc.lengthPerTruck, converter]) // eslint-disable-line react-hooks/exhaustive-deps

  const previewLengthM = useMemo(() => {
    if (!previewSegment) return 0
    const a = converter.toXY(previewSegment[0][0], previewSegment[0][1])
    const b = converter.toXY(previewSegment[1][0], previewSegment[1][1])
    return Math.hypot(a.x - b.x, a.y - b.y)
  }, [previewSegment, converter])

  const halfWidth = params.crossWB / 2

  const freeBuffers = useMemo<[number, number][][]>(() => {
    const result: [number, number][][] = []
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
    return result
  }, [freeLines, halfWidth, converter])

  const freeLabels = useMemo<StripLabel[]>(() => {
    const labels: StripLabel[] = []
    for (let i = 0; i < freeLines.length; i++) {
      const line = freeLines[i]
      const lineXY = line.map((ll) => {
        const xy = converter.toXY(ll[0], ll[1])
        return { x: xy.x, y: xy.y }
      })
      const len = polylineLength(lineXY)
      const trucks = calc.lengthPerTruck > 0 ? len / calc.lengthPerTruck : 0
      const mid = polylineMidpoint(lineXY)
      if (!mid) continue
      const { lat, lng } = converter.toLatLng(mid.x, mid.y)
      labels.push({
        position: [lat, lng],
        text: `${i + 1}: ${len.toFixed(1)} m / ${trucks.toFixed(1)} 台`,
        variant: 'confirmed',
      })
    }
    return labels
  }, [freeLines, converter, calc.lengthPerTruck])

  const freeCurrentBuffer = useMemo<[number, number][] | null>(() => {
    const drawing: [number, number][] = [
      ...freeCurrent,
      ...(previewSegment ? [previewSegment[1]] : []),
    ]
    if (drawing.length < 2) return null
    const lineXY = drawing.map((ll) => {
      const xy = converter.toXY(ll[0], ll[1])
      return { x: xy.x, y: xy.y }
    })
    const buf = bufferPolyline(lineXY, halfWidth)
    if (!buf) return null
    return buf.map(({ x, y }) => {
      const { lat, lng } = converter.toLatLng(x, y)
      return [lat, lng] as [number, number]
    })
  }, [freeCurrent, previewSegment, halfWidth, converter])

  const refLineXY = (idx: number | null): XY[] | null => {
    if (idx === null) return null
    const line = freeLines[idx]
    if (!line || line.length < 2) return null
    return line.map((ll) => {
      const xy = converter.toXY(ll[0], ll[1])
      return { x: xy.x, y: xy.y }
    })
  }

  const actionPreview = useMemo<[[number, number], [number, number]] | null>(() => {
    if (!hoverLatLng) return null
    try {
      if (mode === 'perp2' && perpAnchor) {
        const ref = refLineXY(selectedFreeIdx)
        if (!ref) return null
        const anchor = converter.toXY(perpAnchor[0], perpAnchor[1])
        const click = converter.toXY(hoverLatLng[0], hoverLatLng[1])
        const np = nearestPointOnPolyline({ x: anchor.x, y: anchor.y }, ref)
        if (!np) return null
        const dir = polylineSegmentDirection(ref, np.segIdx)
        const n = { x: -dir.y, y: dir.x }
        const t = (click.x - anchor.x) * n.x + (click.y - anchor.y) * n.y
        if (Math.abs(t) <= halfWidth + 1e-9) return null
        const sign = t >= 0 ? 1 : -1
        const startXY: XY = {
          x: anchor.x + n.x * sign * halfWidth,
          y: anchor.y + n.y * sign * halfWidth,
        }
        let endXY: XY = { x: anchor.x + n.x * t, y: anchor.y + n.y * t }
        if (roundToTruck && calc.lengthPerTruck > 0) {
          endXY = snapEndpointToMultiple(startXY, endXY, calc.lengthPerTruck)
        }
        const sLL = converter.toLatLng(startXY.x, startXY.y)
        const eLL = converter.toLatLng(endXY.x, endXY.y)
        return [[sLL.lat, sLL.lng], [eLL.lat, eLL.lng]]
      }
      if (mode === 'extend' && selectedFreeIdx !== null) {
        const ref = refLineXY(selectedFreeIdx)
        if (!ref || ref.length < 2) return null
        const click = converter.toXY(hoverLatLng[0], hoverLatLng[1])
        const dStart = Math.hypot(click.x - ref[0].x, click.y - ref[0].y)
        const dEnd = Math.hypot(click.x - ref[ref.length - 1].x, click.y - ref[ref.length - 1].y)
        const adjustEndPt = dEnd <= dStart
        const idx = adjustEndPt ? ref.length - 1 : 0
        const anchor = adjustEndPt ? ref[ref.length - 2] : ref[1]
        const dx = ref[idx].x - anchor.x
        const dy = ref[idx].y - anchor.y
        const dirLen = Math.hypot(dx, dy)
        if (dirLen < 1e-9) return null
        const dir = { x: dx / dirLen, y: dy / dirLen }
        const t = (click.x - anchor.x) * dir.x + (click.y - anchor.y) * dir.y
        let newPt: XY = { x: anchor.x + dir.x * t, y: anchor.y + dir.y * t }
        if (roundToTruck && calc.lengthPerTruck > 0) {
          newPt = snapEndpointToMultiple(anchor, newPt, calc.lengthPerTruck)
        }
        const aLL = converter.toLatLng(anchor.x, anchor.y)
        const nLL = converter.toLatLng(newPt.x, newPt.y)
        return [[aLL.lat, aLL.lng], [nLL.lat, nLL.lng]]
      }
      return null
    } catch (e) {
      console.error('[StripPlan] actionPreview error', e)
      return null
    }
  }, [mode, perpAnchor, hoverLatLng, selectedFreeIdx, freeLines, roundToTruck, calc.lengthPerTruck, converter]) // eslint-disable-line react-hooks/exhaustive-deps

  const freeCurrentLabel = useMemo<StripLabel | null>(() => {
    const drawing: [number, number][] = [
      ...freeCurrent,
      ...(previewSegment ? [previewSegment[1]] : []),
    ]
    if (drawing.length < 2) return null
    const lineXY = drawing.map((ll) => {
      const xy = converter.toXY(ll[0], ll[1])
      return { x: xy.x, y: xy.y }
    })
    const len = polylineLength(lineXY)
    const trucks = calc.lengthPerTruck > 0 ? len / calc.lengthPerTruck : 0
    const mid = polylineMidpoint(lineXY)
    if (!mid) return null
    const { lat, lng } = converter.toLatLng(mid.x, mid.y)
    return {
      position: [lat, lng],
      text: `${freeLines.length + 1}: ${len.toFixed(1)} m / ${trucks.toFixed(1)} 台`,
      variant: 'current',
    }
  }, [freeCurrent, previewSegment, converter, calc.lengthPerTruck, freeLines.length])

  const generated = useMemo(() => {
    const lenTotal = freeLinesLengthM + previewLengthM
    const trucks = calc.lengthPerTruck > 0 ? lenTotal / calc.lengthPerTruck : 0
    const drawingExtra = freeCurrent.length >= 1 ? 1 : 0
    return { lenTotal, trucks, lineCount: freeLines.length + drawingExtra }
  }, [calc.lengthPerTruck, freeLines.length, freeCurrent.length, freeLinesLengthM, previewLengthM])

  // 各帯の番号・延長・台数
  const lineStats = useMemo(() => {
    return freeLines.map((line, i) => {
      const lineXY = line.map((ll) => {
        const xy = converter.toXY(ll[0], ll[1])
        return { x: xy.x, y: xy.y }
      })
      const length = polylineLength(lineXY)
      const trucks = calc.lengthPerTruck > 0 ? length / calc.lengthPerTruck : 0
      return { index: i, number: i + 1, length, trucks }
    })
  }, [freeLines, converter, calc.lengthPerTruck])

  const diff = useMemo(() => {
    const dLen = generated.lenTotal - calc.L
    const dTrucks = generated.trucks - calc.n
    return { dLen, dTrucks }
  }, [generated, calc.L, calc.n])

  const skipMapClickOnce = () => {
    skipNextMapClickRef.current = true
    setTimeout(() => { skipNextMapClickRef.current = false }, 100)
  }

  // 現在の平行コピーモードに基づく実効間隔（中心線間隔 m）
  const effectiveParallelDistance = useMemo(() => {
    if (parallelMode === 'distance') return parallelDistance
    // 整数台数モード: 中心線間隔 = WB + N × (v/CA)
    return params.crossWB + Math.max(0, parallelTruckMultiple) * calc.lengthPerTruck
  }, [parallelMode, parallelDistance, parallelTruckMultiple, params.crossWB, calc.lengthPerTruck])

  const handleParallelClick = (ll: [number, number]) => {
    const ref = refLineXY(selectedFreeIdx)
    if (!ref) return
    const click = converter.toXY(ll[0], ll[1])
    const np = nearestPointOnPolyline({ x: click.x, y: click.y }, ref)
    if (!np) return
    const dir = polylineSegmentDirection(ref, np.segIdx)
    const n = { x: -dir.y, y: dir.x }
    const sign = (click.x - np.point.x) * n.x + (click.y - np.point.y) * n.y >= 0 ? 1 : -1
    const offsetXY = offsetPolyline(ref, effectiveParallelDistance * sign)
    if (!offsetXY) return
    const newLine: [number, number][] = offsetXY.map(({ x, y }) => {
      const r = converter.toLatLng(x, y)
      return [r.lat, r.lng]
    })
    setFreeLines((prev) => {
      const next = [...prev, newLine]
      setSelectedFreeIdx(next.length - 1)
      return next
    })
    skipMapClickOnce()
  }

  const handlePerp1Click = (ll: [number, number]) => {
    try {
      const ref = refLineXY(selectedFreeIdx)
      if (!ref) return
      const click = converter.toXY(ll[0], ll[1])
      const np = nearestPointOnPolyline({ x: click.x, y: click.y }, ref)
      if (!np) return
      // 基準線の端点付近でクリックされた場合は、端部がきれいに重なるよう
      // 内側へ WB/2 だけオフセットしたアンカーを使う
      const SNAP = halfWidth // 端点とみなす許容距離
      let anchorXY: XY = np.point
      const startV = ref[0]
      const endV = ref[ref.length - 1]
      const dStart = Math.hypot(np.point.x - startV.x, np.point.y - startV.y)
      const dEnd = Math.hypot(np.point.x - endV.x, np.point.y - endV.y)
      if (dStart < SNAP) {
        // 始点側: 直後のセグメント方向（始点→次点）に halfWidth 進める
        const d = polylineSegmentDirection(ref, 0)
        anchorXY = { x: startV.x + d.x * halfWidth, y: startV.y + d.y * halfWidth }
      } else if (dEnd < SNAP) {
        // 終点側: 末尾セグメントの逆方向に halfWidth 進める
        const d = polylineSegmentDirection(ref, ref.length - 2)
        anchorXY = { x: endV.x - d.x * halfWidth, y: endV.y - d.y * halfWidth }
      }
      const r = converter.toLatLng(anchorXY.x, anchorXY.y)
      setPerpAnchor([r.lat, r.lng])
      setMode('perp2')
    } catch (e) {
      console.error('[StripPlan] handlePerp1Click error', e)
      setMode('idle')
      setPerpAnchor(null)
    }
  }

  const handlePerp2Click = (ll: [number, number]) => {
    try {
      const ref = refLineXY(selectedFreeIdx)
      if (!ref || !perpAnchor) return
      const anchor = converter.toXY(perpAnchor[0], perpAnchor[1])
      const click = converter.toXY(ll[0], ll[1])
      const np = nearestPointOnPolyline({ x: anchor.x, y: anchor.y }, ref)
      if (!np) return
      const dir = polylineSegmentDirection(ref, np.segIdx)
      const n = { x: -dir.y, y: dir.x }
      const dx = click.x - anchor.x
      const dy = click.y - anchor.y
      const t = dx * n.x + dy * n.y
      // 起点を基準線から WB/2 オフセット（帯同士の重なり回避）
      // クリック側に向かって halfWidth 進めた位置を起点にする
      if (Math.abs(t) <= halfWidth + 1e-9) return // 短すぎ
      const sign = t >= 0 ? 1 : -1
      const startXY: XY = {
        x: anchor.x + n.x * sign * halfWidth,
        y: anchor.y + n.y * sign * halfWidth,
      }
      let endXY: XY = { x: anchor.x + n.x * t, y: anchor.y + n.y * t }
      if (roundToTruck && calc.lengthPerTruck > 0) {
        endXY = snapEndpointToMultiple(startXY, endXY, calc.lengthPerTruck)
      }
      const startLL = converter.toLatLng(startXY.x, startXY.y)
      const endLL = converter.toLatLng(endXY.x, endXY.y)
      const newLine: [number, number][] = [
        [startLL.lat, startLL.lng],
        [endLL.lat, endLL.lng],
      ]
      setFreeLines((prev) => [...prev, newLine])
      setPerpAnchor(null)
      setMode('perp1')
      skipMapClickOnce()
    } catch (e) {
      console.error('[StripPlan] handlePerp2Click error', e)
      setMode('idle')
      setPerpAnchor(null)
    }
  }

  const handleExtendClick = (ll: [number, number]) => {
    const ref = refLineXY(selectedFreeIdx)
    if (!ref || ref.length < 2 || selectedFreeIdx === null) return
    const click = converter.toXY(ll[0], ll[1])
    const startXY = ref[0]
    const endXY = ref[ref.length - 1]
    const dStart = Math.hypot(click.x - startXY.x, click.y - startXY.y)
    const dEnd = Math.hypot(click.x - endXY.x, click.y - endXY.y)
    const adjustEndPt = dEnd <= dStart
    const idx = adjustEndPt ? ref.length - 1 : 0
    const anchor = adjustEndPt ? ref[ref.length - 2] : ref[1]
    const dx = ref[idx].x - anchor.x
    const dy = ref[idx].y - anchor.y
    const dirLen = Math.hypot(dx, dy)
    if (dirLen < 1e-9) return
    const dir = { x: dx / dirLen, y: dy / dirLen }
    const t = (click.x - anchor.x) * dir.x + (click.y - anchor.y) * dir.y
    let newPt: XY = { x: anchor.x + dir.x * t, y: anchor.y + dir.y * t }
    if (roundToTruck && calc.lengthPerTruck > 0) {
      newPt = snapEndpointToMultiple(anchor, newPt, calc.lengthPerTruck)
    }
    const updated = ref.slice()
    updated[idx] = newPt
    const updatedLL: [number, number][] = updated.map(({ x, y }) => {
      const r = converter.toLatLng(x, y)
      return [r.lat, r.lng]
    })
    setFreeLines((prev) => prev.map((l, i) => (i === selectedFreeIdx ? updatedLL : l)))
    skipMapClickOnce()
  }

  const handleMapClick = (ll: [number, number]) => {
    if (skipNextMapClickRef.current) {
      skipNextMapClickRef.current = false
      return
    }
    if (mode === 'draw') {
      setFreeCurrent((prev) => {
        if (prev.length === 0) return [ll]
        const last = prev[prev.length - 1]
        const adjusted = adjustEndpoint(last, ll)
        return [...prev, adjusted]
      })
      return
    }
    if (mode === 'parallel') {
      if (selectedFreeIdx === null) return // 線をクリックしての選択待ち
      handleParallelClick(ll)
      return
    }
    if (mode === 'perp1') {
      if (selectedFreeIdx === null) return
      handlePerp1Click(ll)
      return
    }
    if (mode === 'perp2') {
      handlePerp2Click(ll)
      return
    }
    if (mode === 'extend') {
      handleExtendClick(ll)
      return
    }
    // idle / edit: 地図クリックは無効（ポリゴンクリックでの選択のみ）
  }

  const finishFreeLine = () => {
    if (freeCurrent.length >= 2) {
      setFreeLines((prev) => [...prev, freeCurrent])
    }
    setFreeCurrent([])
  }

  const finishFreeLineFromMap = () => {
    finishFreeLine()
    skipMapClickOnce()
  }

  // Enter で確定 / Backspace で 1 点戻る
  useEffect(() => {
    if (mode !== 'draw') return
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return
      if (e.key === 'Enter') {
        if (freeCurrent.length >= 2) {
          e.preventDefault()
          setFreeLines((prev) => [...prev, freeCurrent])
          setFreeCurrent([])
        }
      } else if (e.key === 'Backspace') {
        if (freeCurrent.length > 0) {
          e.preventDefault()
          setFreeCurrent((prev) => prev.slice(0, -1))
        } else if (freeLines.length > 0) {
          e.preventDefault()
          setFreeCurrent(freeLines[freeLines.length - 1])
          setFreeLines((prev) => prev.slice(0, -1))
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode, freeCurrent, freeLines])

  const deleteSelectedFree = () => {
    if (selectedFreeIdx === null) return
    setFreeLines((prev) => prev.filter((_, i) => i !== selectedFreeIdx))
    setSelectedFreeIdx(null)
  }

  const editSelectedFree = () => {
    if (selectedFreeIdx === null) return
    const line = freeLines[selectedFreeIdx]
    if (!line) return
    setFreeLines((prev) => prev.filter((_, i) => i !== selectedFreeIdx))
    setFreeCurrent(line)
    setMode('draw')
    setSelectedFreeIdx(null)
  }

  const undoFreePoint = () => {
    if (freeCurrent.length > 0) {
      setFreeCurrent((prev) => prev.slice(0, -1))
    } else if (freeLines.length > 0) {
      setFreeCurrent(freeLines[freeLines.length - 1])
      setFreeLines((prev) => prev.slice(0, -1))
    }
  }

  const resetAll = () => {
    setFreeLines([])
    setFreeCurrent([])
    setMode('idle')
    setSelectedFreeIdx(null)
    setPerpAnchor(null)
  }

  const enterMode = (next: Mode) => {
    setMode(mode === next ? 'idle' : next)
    // モード切替時は常に選択を解除（基準線は再選択させる）
    setSelectedFreeIdx(null)
    setPerpAnchor(null)
    setFreeCurrent([])
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

  // ポリゴン選択を許可するモード
  const allowPolygonSelect = mode !== 'draw' && mode !== 'perp2' && mode !== 'extend'

  // モードガイダンス
  let modeGuidance = ''
  if (mode === 'draw') {
    if (freeCurrent.length === 0) modeGuidance = '地図クリックで 1 点目を追加'
    else if (freeCurrent.length === 1) modeGuidance = '地図クリックで 2 点目（追加または最終点）'
    else modeGuidance = `現在の線：${freeCurrent.length} 点 / 最終点クリック・Enter・「次の帯」で確定`
  } else if (mode === 'parallel') {
    if (selectedFreeIdx === null) modeGuidance = '基準線をクリックして選択'
    else modeGuidance = `基準: ${selectedFreeIdx + 1} 本目 / クリックした側に平行コピー（連続可）`
  } else if (mode === 'perp1') {
    if (selectedFreeIdx === null) modeGuidance = '基準線をクリックして選択'
    else modeGuidance = `基準: ${selectedFreeIdx + 1} 本目 / 基準線をクリックして 1 点目（基準点を吸着）`
  } else if (mode === 'perp2') {
    modeGuidance = '2 点目をクリック（垂線方向に投影）'
  } else if (mode === 'extend') {
    modeGuidance = 'クリックに近い端点を線方向に移動'
  } else if (mode === 'edit') {
    modeGuidance = '帯をクリックして選択（削除・再編集・伸縮）'
  }

  const modeBtnCls = (active: boolean) =>
    `flex flex-col items-center justify-center gap-1 px-2 py-2 text-xs border rounded ${active ? 'bg-orange-100 border-orange-400' : 'bg-white hover:bg-slate-50'}`

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="帯置計画作成"
        subtitle="客土工事 / 帯置計画"
        actions={
          <button
            type="button"
            onClick={() => setShowParamsModal(true)}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            <Settings className="h-4 w-4" />
            入力パラメータ
          </button>
        }
      />

      {showParamsModal && (
        <ParamsModal
          params={params}
          onChange={setParams}
          onClose={() => setShowParamsModal(false)}
        />
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* 左：操作 */}
        <div className="w-[400px] overflow-auto p-3 bg-slate-50 border-r space-y-3">
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

          {/* 計算結果（目標 / 生成 / 差分 を統合） */}
          <section className="bg-white rounded-lg border overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-100">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">項目</th>
                  <th className="px-2 py-1.5 text-right font-medium">目標</th>
                  <th className="px-2 py-1.5 text-right font-medium">生成</th>
                  <th className="px-2 py-1.5 text-right font-medium">差分</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t">
                  <th className="px-2 py-1.5 text-left font-medium bg-slate-50">客土量 V (m³)</th>
                  <td className="px-2 py-1.5 text-right tabular-nums" colSpan={3}>{calc.V.toFixed(1)}</td>
                </tr>
                <tr className="border-t">
                  <th className="px-2 py-1.5 text-left font-medium bg-slate-50">帯断面 CA (m²)</th>
                  <td className="px-2 py-1.5 text-right tabular-nums" colSpan={3}>{calc.CA.toFixed(3)}</td>
                </tr>
                <tr className="border-t">
                  <th className="px-2 py-1.5 text-left font-medium bg-slate-50">総延長 (m)</th>
                  <td className="px-2 py-1.5 text-right tabular-nums">{calc.L.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{generated.lenTotal.toFixed(1)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${diff.dLen < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {diff.dLen >= 0 ? '+' : ''}{diff.dLen.toFixed(1)}
                  </td>
                </tr>
                <tr className="border-t">
                  <th className="px-2 py-1.5 text-left font-medium bg-slate-50">台数 (台)</th>
                  <td className="px-2 py-1.5 text-right tabular-nums">{calc.n}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{generated.trucks.toFixed(1)}</td>
                  <td className={`px-2 py-1.5 text-right tabular-nums font-medium ${diff.dTrucks < 0 ? 'text-red-600' : 'text-green-600'}`}>
                    {diff.dTrucks >= 0 ? '+' : ''}{diff.dTrucks.toFixed(1)}
                  </td>
                </tr>
              </tbody>
            </table>
            {previewLengthM > 0 && (
              <div className="text-xs text-purple-600 px-2 py-1 border-t">
                プレビュー：{previewLengthM.toFixed(1)} m / {calc.lengthPerTruck > 0 ? (previewLengthM / calc.lengthPerTruck).toFixed(2) : '-'} 台分
              </div>
            )}
          </section>

          {/* メイン操作：4 ボタン */}
          <section className="bg-white rounded-lg border p-3 space-y-2">
            <div className="grid grid-cols-4 gap-1">
              <button
                type="button"
                onClick={() => enterMode('draw')}
                disabled={!selectedArea || areaLatLng.length < 3}
                className={modeBtnCls(mode === 'draw') + ' disabled:opacity-50'}
              >
                <Pencil className="h-4 w-4" />
                帯を作成
              </button>
              <button
                type="button"
                onClick={() => enterMode('parallel')}
                disabled={freeLines.length === 0}
                className={modeBtnCls(mode === 'parallel') + ' disabled:opacity-50'}
              >
                <Copy className="h-4 w-4" />
                平行コピー
              </button>
              <button
                type="button"
                onClick={() => enterMode('perp1')}
                disabled={freeLines.length === 0}
                className={modeBtnCls(mode === 'perp1' || mode === 'perp2') + ' disabled:opacity-50'}
              >
                <SquareIcon className="h-4 w-4" />
                垂線作成
              </button>
              <button
                type="button"
                onClick={() => enterMode('edit')}
                disabled={freeLines.length === 0}
                className={modeBtnCls(mode === 'edit' || mode === 'extend') + ' disabled:opacity-50'}
              >
                <Edit3 className="h-4 w-4" />
                帯を編集
              </button>
            </div>

            {modeGuidance && (
              <div className="text-xs text-orange-700 bg-orange-50 px-2 py-1 rounded">
                {modeGuidance}
              </div>
            )}

            {/* draw モードの追加操作 */}
            {mode === 'draw' && (
              <div className="space-y-1">
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={finishFreeLine}
                    disabled={freeCurrent.length < 2}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                  >
                    <CornerDownRight className="h-3.5 w-3.5" />
                    次の帯
                  </button>
                  <button
                    type="button"
                    onClick={undoFreePoint}
                    disabled={freeCurrent.length === 0 && freeLines.length === 0}
                    className="flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                    1点戻る
                  </button>
                </div>
              </div>
            )}

            {/* parallel モードの間隔入力 */}
            {mode === 'parallel' && (
              <div className="space-y-2">
                <div className="flex gap-1 text-xs">
                  <label className={`flex-1 flex items-center justify-center px-2 py-1 border rounded cursor-pointer ${parallelMode === 'distance' ? 'bg-orange-100 border-orange-400' : 'bg-white hover:bg-slate-50'}`}>
                    <input type="radio" className="hidden" checked={parallelMode === 'distance'} onChange={() => setParallelMode('distance')} />
                    中心線間隔
                  </label>
                  <label className={`flex-1 flex items-center justify-center px-2 py-1 border rounded cursor-pointer ${parallelMode === 'truckMultiple' ? 'bg-orange-100 border-orange-400' : 'bg-white hover:bg-slate-50'}`}>
                    <input type="radio" className="hidden" checked={parallelMode === 'truckMultiple'} onChange={() => setParallelMode('truckMultiple')} />
                    整数台数
                  </label>
                </div>
                {parallelMode === 'distance' ? (
                  <NumberField label="平行距離（中心線間隔）" unit="m" value={parallelDistance}
                    onChange={setParallelDistance} step={0.5} decimals={1} />
                ) : (
                  <>
                    <NumberField label="台数倍率 N" unit="台" value={parallelTruckMultiple}
                      onChange={(v) => setParallelTruckMultiple(Math.max(0, Math.round(v)))} step={1} decimals={0} />
                    <div className="text-xs text-slate-500">
                      中心線間隔 = WB ({params.crossWB.toFixed(2)}) + N × v/CA ({calc.lengthPerTruck.toFixed(2)}) = {effectiveParallelDistance.toFixed(2)} m
                    </div>
                  </>
                )}
              </div>
            )}

            {/* edit モード：選択中の操作 */}
            {(mode === 'edit' || mode === 'extend') && selectedFreeIdx !== null && freeLines[selectedFreeIdx] && (
              <div className="p-2 bg-purple-50 border border-purple-200 rounded space-y-2">
                <div className="text-xs text-purple-800">
                  選択中：{selectedFreeIdx + 1} 本目（{freeLines[selectedFreeIdx].length} 点）
                </div>
                <div className="grid grid-cols-3 gap-1">
                  <button
                    type="button"
                    onClick={editSelectedFree}
                    className="flex items-center justify-center gap-1 px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50"
                    title="点列を引き継いで再作図"
                  >
                    <Edit3 className="h-3 w-3" />
                    再編集
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode(mode === 'extend' ? 'edit' : 'extend')}
                    className={`flex items-center justify-center gap-1 px-2 py-1 text-xs border rounded ${mode === 'extend' ? 'bg-amber-100 border-amber-400' : 'bg-white hover:bg-slate-50'}`}
                  >
                    <Move className="h-3 w-3" />
                    伸縮
                  </button>
                  <button
                    type="button"
                    onClick={deleteSelectedFree}
                    className="flex items-center justify-center gap-1 px-2 py-1 text-xs border rounded bg-white hover:bg-red-50 text-red-600"
                  >
                    <Trash2 className="h-3 w-3" />
                    削除
                  </button>
                </div>
              </div>
            )}

            {/* 共通：整数台数調整 / 全削除 */}
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={roundToTruck}
                onChange={(e) => setRoundToTruck(e.target.checked)}
              />
              延長を整数台数で調整（v/CA = {calc.lengthPerTruck.toFixed(2)} m の倍数）
            </label>
            <div className="flex justify-between items-center">
              <div className="text-xs text-slate-500">
                確定済み：{freeLines.length} 本
              </div>
              <button
                type="button"
                onClick={resetAll}
                disabled={freeLines.length === 0 && freeCurrent.length === 0}
                className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                <RotateCcw className="h-3 w-3" />
                全削除
              </button>
            </div>
          </section>

          {/* 帯一覧（番号・延長・台数） */}
          {freeLines.length > 0 && (
            <section className="bg-white rounded-lg border overflow-hidden">
              <div className="bg-slate-100 px-2 py-1.5 text-xs font-medium border-b">
                帯一覧（{freeLines.length} 本）
              </div>
              <table className="w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-2 py-1 text-left font-medium w-10">#</th>
                    <th className="px-2 py-1 text-right font-medium">延長 (m)</th>
                    <th className="px-2 py-1 text-right font-medium">台数 (台)</th>
                  </tr>
                </thead>
                <tbody>
                  {lineStats.map((s) => {
                    const isSelected = selectedFreeIdx === s.index
                    return (
                      <tr
                        key={s.index}
                        onClick={() => setSelectedFreeIdx(isSelected ? null : s.index)}
                        className={`border-t cursor-pointer ${isSelected ? 'bg-purple-50 text-purple-900 font-medium' : 'hover:bg-slate-50'}`}
                      >
                        <td className="px-2 py-1">{s.number}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{s.length.toFixed(1)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{s.trucks.toFixed(2)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
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
              baseline={[]}
              freeLines={freeLines}
              freeCurrent={freeCurrent}
              previewSegment={previewSegment}
              freeBuffers={freeBuffers}
              freeCurrentBuffer={freeCurrentBuffer}
              freeLabels={freeLabels}
              freeCurrentLabel={freeCurrentLabel}
              selectedFreeIdx={selectedFreeIdx}
              onSelectFreeLine={allowPolygonSelect ? setSelectedFreeIdx : undefined}
              onFinishCurrentLine={finishFreeLineFromMap}
              perpAnchor={perpAnchor}
              actionPreview={actionPreview}
              baseLayer={baseLayer}
              pickMode={mode !== 'idle' && mode !== 'edit'}
              onMapClick={handleMapClick}
              onMouseMove={setHoverLatLng}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
