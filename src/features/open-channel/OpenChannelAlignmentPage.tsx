// 線形物（水路・道路）— 線形登録ページ
//
// - 工区ごとに複数の線形物を登録可能
// - 各線形物は平面線形（BP→IP→EP、IP は角 or 単曲線 R）+ 縦断 + 標準断面で定義
// - 標準断面は中心から右/左に並ぶ要素列（幅・勾配[1:i または %]）
// - 座標管理の点を参照する
// - 地図で線形（直線 + 曲線）をプレビュー

import { useEffect, useMemo, useRef, useState } from 'react'
import { Polyline, CircleMarker, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Pencil, Check, X, Upload, Loader2 } from 'lucide-react'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import { decodeDxfBytes, type DxfShape } from '@/lib/dxfRender'
import { supabase } from '@/lib/supabase'
import {
  getActiveLandxmlFile,
  downloadLandxmlText,
  uploadLandxmlFile,
  type LandxmlKind,
} from '@/lib/landxmlFiles'
import { useLandxmlEventsStore } from '@/stores/landxmlEventsStore'
import { parseLandXml, type ParsedSurface } from '@/lib/landxml/parser'
import { indexTin } from '@/lib/landxml/tinInterpolation'
import { sampleStationCrossSection } from '@/lib/openChannel/tinCrossSection'
import { useFarmStore } from '@/stores/farmStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import {
  useOpenChannelStore,
  type AlignmentPoint,
  type AlignmentPointKind,
  type ProfilePoint,
  type CrossSectionElement,
  type StandardCrossSection,
  type StationRow,
  type SideOrientation,
  type WidthStake,
  type MeasuredCrossPoint,
  type OpenChannelRow,
  type DxfCalibration,
  type DxfCrossSectionFile,
  buildCrossSectionPath,
  elementStep,
} from '@/stores/openChannelStore'
import { useStakingStore } from '@/stores/stakingStore'
import { useSurveySetStore } from '@/stores/surveySetStore'
import { fetchSurveySlide, NO_SLIDE, type SurveySlide } from '@/lib/surveyCalibration'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  sampleAlignment,
  alignmentTotalLength,
  buildSegments,
  pointAtDistance,
  tangentAtDistance,
  getCurveMarkers,
  getCornerIpStations,
  getIpCornerGuides,
  type AlignmentSegment,
  type AlignmentVertex,
  type CurveMarker,
} from '@/lib/openChannel/alignment'
import { downloadSimaFile, type SimaExportPoint } from '@/lib/sima-parser'
import { buildLandXml } from '@/lib/landxml/exporter'
import type {
  Alignment as LandXmlAlignment,
  AlignmentSegment as LandXmlAlignmentSegment,
} from '@/lib/landxml/types'
import { clothoidPoint, clothoidPointOut } from '@/lib/clothoid'
import {
  computeStationVertices,
  computeVerticalCurves,
  interpolateProfileZ,
  type StationVertex,
  type VerticalCurve,
} from '@/lib/openChannel/stationVertices'
import type { TinPoint, TinTriangle, TinSurface } from '@/lib/landxml/surface'

/**

}

/**
 * 範囲外は null を 返す 版。 中間点計算 の 「計画高」列や、断面図の 「中心設計高」
 * 表示など、「縦断計画が 無ければ 値も 出さない」用途で 使う。
 */
function interpolateProfileZOrNull(
  profilePoints: ProfilePoint[],
  distance: number,
): number | null {
  if (profilePoints.length < 2) return null
  const sorted = [...profilePoints].sort((a, b) => a.distance - b.distance)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const EPS = 1e-6
  if (distance < first.distance - EPS || distance > last.distance + EPS) return null
  return interpolateProfileZ(sorted, distance)
}

/**
 * 位置から 線形点の 種別 (BP/IP/EP) を 決定。
 *   先頭 (index=0) → BP
 *   末尾 (index=total-1) → EP
 *   その間 → IP
 * (1 点しか ない 場合 は BP 扱い)
 */
function inferKindByIndex(index: number, total: number): AlignmentPointKind {
  if (total <= 1) return 'bp'
  if (index === 0) return 'bp'
  if (index === total - 1) return 'ep'
  return 'ip'
}

/**
 * alignmentPoints 配列の 全要素 の kind を 位置から 再計算 して 返す。
 * ユーザー が 追加/削除/並べ替え した ときに 必ず 通す。
 */
function normalizeKinds(points: AlignmentPoint[]): AlignmentPoint[] {
  const n = points.length
  return points.map((p, i) => ({ ...p, kind: inferKindByIndex(i, n) }))
}

/**
 * 標準断面 (element 列) を 中心 (offset=0, elevation=centerHeight) 基準 の 絶対 elevation
 * 点列 に 展開する。 対話型 エディタ 保存 → plannedSectionRaw 側 の 同期 に 使用。
 * buildCrossSectionPath は 左端 → 中心 → 右端 の {x=offset, y=中心 相対 高} を 返す。
 */
function standardCsToMeasuredPoints(
  cs: StandardCrossSection,
  centerHeight: number,
): MeasuredCrossPoint[] {
  const raw = buildCrossSectionPath(cs)
  return raw.map((p, i) => ({
    id: `pcs-${Date.now().toString(36)}-${i}`,
    offset: p.x,
    elevation: centerHeight + p.y,
  }))
}

/**
 * 点列 を 標準断面 (element 列、percent / vertical) に 逆変換 する。
 * DXF トレース 保存 → station.crossSection 側 の 同期 に 使用。
 *   - offset > 0 は 右側、< 0 は 左側 (中心 に 近い 順 に 並べ、隣接 差 = 1 要素)
 *   - dx = 0 は vertical、dx > 0 は percent (勾配 = dy/dx * 100)
 * 中心 (offset=0) が 点 に 含まれ ない 場合 は 中心 = (0, centerHeight) を 仮想 起点 に する。
 */
function measuredPointsToStandardCs(
  points: MeasuredCrossPoint[],
  centerHeight: number,
): StandardCrossSection {
  const right = points
    .filter((p) => p.offset > 1e-9)
    .slice()
    .sort((a, b) => a.offset - b.offset)
  const left = points
    .filter((p) => p.offset < -1e-9)
    .slice()
    .sort((a, b) => b.offset - a.offset)
  const centerPt = points.find((p) => Math.abs(p.offset) < 1e-9)
  const centerY = centerPt ? centerPt.elevation : centerHeight

  const buildSide = (
    ordered: MeasuredCrossPoint[],
    sideSign: 1 | -1,
  ): CrossSectionElement[] => {
    const els: CrossSectionElement[] = []
    let prevX = 0
    let prevY = centerY
    ordered.forEach((p, i) => {
      const dx = Math.abs(p.offset - prevX)
      const dy = p.elevation - prevY
      const id = `pcs-${sideSign > 0 ? 'r' : 'l'}-${i}-${Math.random()
        .toString(36)
        .slice(2, 6)}`
      if (dx < 1e-9) {
        els.push({ id, name: '', width: 0, slopeValue: dy, slopeUnit: 'vertical' })
      } else {
        els.push({
          id,
          name: '',
          width: dx,
          slopeValue: (dy / dx) * 100,
          slopeUnit: 'percent',
        })
      }
      prevX = p.offset
      prevY = p.elevation
    })
    return els
  }

  return { right: buildSide(right, 1), left: buildSide(left, -1) }
}

/** タイトルのみで折りたたみ可能なセクション（開閉状態は localStorage に記憶可）。
 *  onOpenChange を 渡すと 親コンポーネントが 現在の 開閉状態を 監視できる
 *  (例: 折りたたみ中は 地図クリック による 編集を 抑止 する 用途)。 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  storageKey,
  onOpenChange,
  actions,
  children,
}: {
  title: string
  defaultOpen?: boolean
  storageKey?: string
  onOpenChange?: (open: boolean) => void
  /** タイトル行 の 右端 に 置く 操作 (開閉 ボタン の 外 に 出す) */
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useState<boolean>(() => {
    if (storageKey && typeof window !== 'undefined') {
      const v = window.localStorage.getItem(storageKey)
      if (v === '1') return true
      if (v === '0') return false
    }
    return defaultOpen
  })
  // 開閉状態が 変わる たびに 親へ 通知 (初回 マウント 時も 発火 する)
  useEffect(() => {
    onOpenChange?.(open)
  }, [open, onOpenChange])
  const toggle = () => {
    setOpen((prev) => {
      const next = !prev
      if (storageKey && typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, next ? '1' : '0')
      }
      return next
    })
  }
  return (
    <section className="bg-white rounded-lg border">
      <div className="flex items-center">
        <button
          type="button"
          onClick={toggle}
          className="flex-1 min-w-0 px-3 py-2 flex items-center font-semibold text-slate-800 text-sm hover:bg-slate-50 rounded-tl-lg"
        >
          {open ? (
            <ChevronDown className="h-4 w-4 mr-1 text-slate-500" />
          ) : (
            <ChevronRight className="h-4 w-4 mr-1 text-slate-500" />
          )}
          <span className="truncate">{title}</span>
        </button>
        {actions && <div className="pr-3 shrink-0">{actions}</div>}
      </div>
      {open && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </section>
  )
}

// マウント時に 1 度だけ フィットする。線形点を 編集する たびに 位置が
// 動くと 使いづらいため、線形物を 切り替えた ときだけ 再フィット させたい。
// 呼び出し側で <FitBounds key={selectedId} ... /> と 書けば、選択切替で
// アンマウント→再マウント され、初回だけ 1 度 フィットする。
function FitBounds({ positions }: { positions: [number, number][] }) {
  const map = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    if (positions.length < 2) return
    const bounds = L.latLngBounds(positions)
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 })
    done.current = true
  }, [positions, map])
  return null
}

// 選択中の 測点位置に 地図を パン+ズーム。 latLng が 変わる 度に 移動。
// 既に 目的 ズーム 以上に 拡大されている 場合は そのまま (むやみに 縮小しない)。
//
// 注意: 測点選択と 同時に 下パネル (横断図タブ) が 展開して 地図コンテナが
// 縮むため、setView の 直前に invalidateSize + 2 フレーム 待って 実 レイアウトが
// 落ち着いてから 設定する。 これを しない と 縮む前 の 中心 に アラインされて
// 「測点が 画面中央から ズレる」現象が 起きる。
function StationFocus({
  latLng,
  targetZoom = 20,
}: {
  latLng: [number, number] | null
  targetZoom?: number
}) {
  const map = useMap()
  // 直前 に 合わせた 位置。 同じ 所 なら 動かさない。
  //
  // latLng は 毎回 新しい 配列 に なる (測点 を 触る たび に stations が
  // 作り直される) ので、素直 に 依存 に 入れる と 断面点 を 1 つ 足す だけ で
  // 地図 が 測点 へ 飛んで しまう。 地図 で 点 を 拾って いる 最中 に これ を
  // やられる と 探して いた 場所 から 引き剥がされる。
  const lastRef = useRef<[number, number] | null>(null)
  const lat = latLng?.[0] ?? null
  const lng = latLng?.[1] ?? null
  useEffect(() => {
    if (lat == null || lng == null) {
      lastRef.current = null
      return
    }
    const prev = lastRef.current
    if (prev && Math.abs(prev[0] - lat) < 1e-9 && Math.abs(prev[1] - lng) < 1e-9) return
    lastRef.current = [lat, lng]
    let cancelled = false
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return
      const raf2 = requestAnimationFrame(() => {
        if (cancelled) return
        map.invalidateSize({ animate: false })
        const nextZoom = Math.max(map.getZoom(), targetZoom)
        map.setView([lat, lng], nextZoom, { animate: true, duration: 0.4 })
      })
      void raf2
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
    }
  }, [lat, lng, targetZoom, map])
  return null
}

// 「見栄えの良い」目盛間隔を 決定。 rawStep (単位) を 直近 の 1/2/5/10 系列に 丸める。
// 例: rawStep=0.4 → 0.5、 rawStep=15 → 20、 rawStep=1.33 → 1
function niceStep(rawStep: number): number {
  const safe = Math.max(rawStep, 1e-9)
  const magnitude = Math.pow(10, Math.floor(Math.log10(safe)))
  const norm = safe / magnitude
  let step: number
  if (norm < 1.5) step = 1
  else if (norm < 3) step = 2
  else if (norm < 7) step = 5
  else step = 10
  return step * magnitude
}

// 6 段階の 伸縮比率 (縦・横 共通)。単位は 倍率 (1.0 = 100%)。CrossSectionChart と 同系列。
const PROFILE_SCALE_STEPS = [0.5, 1.0, 2.0, 3.0, 5.0, 8.0] as const
type ProfileScale = (typeof PROFILE_SCALE_STEPS)[number]
const nearestScaleIndex = (v: number): number => {
  let best = 0
  let bestDiff = Number.POSITIVE_INFINITY
  for (let i = 0; i < PROFILE_SCALE_STEPS.length; i++) {
    const d = Math.abs(PROFILE_SCALE_STEPS[i] - v)
    if (d < bestDiff) {
      bestDiff = d
      best = i
    }
  }
  return best
}

// 縦断図（追加距離 vs 計画高）
//  - ResizeObserver で 親要素の 寸法に 追従。
//  - 縦・横 独立の 伸縮スケール (0.5x〜8x、暗渠 縦断と 同じ 段階) + マウスホイール。
//  - 目盛は niceStep() で ピクセル密度 に 応じて 自動選定 (細かすぎ/粗すぎ 回避)。
function ProfileChart({
  points,
  totalLen,
  spOffset = 0,
  currentGroundPoints,
}: {
  points: ProfilePoint[]
  totalLen: number
  /**
   * 現況地盤高 の 測点列 (station.currentGroundHeight から 生成)。
   * ある 場合 は 計画線 (青) と 別 に 「現況線 (茶)」として 重ね描き 。
   * 高さ レンジ の 計算 にも 参加する。 undefined / 空 で 非表示。
   */
  currentGroundPoints?: { distance: number; z: number }[]
  /** 距離 (BP からの 内部距離) を SP 表示に 変換する ため の オフセット。
   *  SP = distance + spOffset。 中間点計算 の 表と 同じ 目盛で x 軸 ラベルを 出す */
  spOffset?: number
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 280, h: 140 })
  const [heightScale, setHeightScale] = useState<ProfileScale>(1.0)
  const [widthScale, setWidthScale] = useState<ProfileScale>(1.0)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      setSize({
        w: Math.max(200, rect.width),
        h: Math.max(80, rect.height),
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const stepUp = (v: number): ProfileScale => {
    for (const s of PROFILE_SCALE_STEPS) if (s > v + 1e-6) return s
    return PROFILE_SCALE_STEPS[PROFILE_SCALE_STEPS.length - 1]
  }
  const stepDown = (v: number): ProfileScale => {
    for (let i = PROFILE_SCALE_STEPS.length - 1; i >= 0; i--) {
      if (PROFILE_SCALE_STEPS[i] < v - 1e-6) return PROFILE_SCALE_STEPS[i]
    }
    return PROFILE_SCALE_STEPS[0]
  }
  // Ctrl (or Meta) + ホイール: 縦スケール、 Shift + ホイール: 横スケール。
  // 素の ホイールは スクロール に 任せる (混在すると 使いにくい)。
  const handleWheel = (e: React.WheelEvent) => {
    if (e.shiftKey) {
      e.preventDefault()
      setWidthScale((prev) => (e.deltaY > 0 ? stepDown(prev) : stepUp(prev)))
    } else if (e.ctrlKey || e.metaKey) {
      e.preventDefault()
      setHeightScale((prev) => (e.deltaY > 0 ? stepDown(prev) : stepUp(prev)))
    }
  }
  const resetScale = () => {
    setHeightScale(1.0)
    setWidthScale(1.0)
  }

  const padding = { top: 12, right: 20, bottom: 26, left: 48 }

  if (points.length < 2) {
    return (
      <div className="w-full h-full flex flex-col">
        <div className="text-[11px] text-slate-400 shrink-0 px-1 py-0.5">
          変化点が 2 点以上で 縦断図を 表示
        </div>
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 border rounded bg-slate-50 flex items-center justify-center text-xs text-slate-400"
        >
          変化点 を 追加してください
        </div>
      </div>
    )
  }
  const sorted = [...points].sort((a, b) => a.distance - b.distance)
  const curves = computeVerticalCurves(sorted)
  const maxDist = Math.max(totalLen, sorted[sorted.length - 1].distance)
  const minDist = Math.min(0, sorted[0].distance)
  const distSpan = Math.max(maxDist - minDist, 1)
  // 高さ範囲: 変化点 + BVC / EVC / 曲線サンプル も 含めて レンジ を 決定。
  const heightSamples: number[] = sorted.map((p) => p.floorHeight)
  for (const c of curves) {
    heightSamples.push(c.bvcHeight, c.evcHeight)
    // 曲線 の 極値 (勾配 0 位置) を 加味。 X* = -i1 × L / (i2 - i1) (勾配 が 0 に なる 位置)
    const denom = c.i2Percent - c.i1Percent
    if (Math.abs(denom) > 1e-9) {
      const xStar = (-c.i1Percent * c.vcl) / denom
      if (xStar > 0 && xStar < c.vcl) {
        const y = c.bvcHeight + (c.i1Percent / 100) * xStar +
          ((c.i2Percent - c.i1Percent) / (200 * c.vcl)) * xStar * xStar
        heightSamples.push(y)
      }
    }
  }
  // 現況線 (LandXML 由来) も レンジ に 参加させて 収まる ようにする
  const currentPts = (currentGroundPoints ?? [])
    .filter((p) => Number.isFinite(p.z))
    .slice()
    .sort((a, b) => a.distance - b.distance)
  for (const p of currentPts) heightSamples.push(p.z)
  const minH = Math.min(...heightSamples)
  const maxH = Math.max(...heightSamples)
  const rangeRaw = maxH - minH
  const range = rangeRaw < 1e-6 ? 1 : rangeRaw

  // scale=1 で コンテナ に ぴったり 収まる base pxPerMeter を 算出。
  const baseInnerW = Math.max(200, size.w - padding.left - padding.right)
  const baseInnerH = Math.max(80, size.h - padding.top - padding.bottom)
  const pxPerMeterX = (baseInnerW / distSpan) * widthScale
  const pxPerMeterY = (baseInnerH / range) * heightScale
  const innerW = distSpan * pxPerMeterX
  const innerH = range * pxPerMeterY
  const svgWidth = innerW + padding.left + padding.right
  const svgHeight = innerH + padding.top + padding.bottom

  const tx = (d: number) => padding.left + (d - minDist) * pxPerMeterX
  const ty = (h: number) => padding.top + (maxH - h) * pxPerMeterY

  // 縦断曲線 が ある 場合 は 放物線 の サンプル 点 を 挟んで パス を 組み立てる。
  // BVC / EVC の 間 は 20 分割 で 放物線 を 追従。 曲線 外 は 直線 補間。
  const pathParts: string[] = []
  const curveByPvi = new Map<number, VerticalCurve>()
  for (const c of curves) curveByPvi.set(c.pviIndex, c)
  let started = false
  const moveTo = (d: number, h: number) => {
    pathParts.push(`${started ? 'L' : 'M'} ${tx(d)} ${ty(h)}`)
    started = true
  }
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    const c = curveByPvi.get(i)
    if (c) {
      // BVC → 放物線 サンプル → EVC。 PVI (角) は 通らない。
      moveTo(c.bvcDistance, c.bvcHeight)
      const SAMPLES = 20
      for (let k = 1; k <= SAMPLES; k++) {
        const x = (c.vcl * k) / SAMPLES
        const d = c.bvcDistance + x
        const h =
          c.bvcHeight + (c.i1Percent / 100) * x +
          ((c.i2Percent - c.i1Percent) / (200 * c.vcl)) * x * x
        moveTo(d, h)
      }
    } else {
      // 曲線 なし: 変化点 を そのまま 通る
      moveTo(p.distance, p.floorHeight)
    }
  }
  const path = pathParts.join(' ')

  // 目盛間隔: 約 60px (X) / 40px (Y) 毎 に 1 目盛 になる ように niceStep で 丸める。
  const xStep = niceStep(60 / pxPerMeterX)
  const yStep = niceStep(40 / pxPerMeterY)

  const xTicks: number[] = []
  for (let d = Math.ceil(minDist / xStep) * xStep; d <= maxDist + 1e-9; d += xStep) {
    xTicks.push(d)
  }
  const yTicks: number[] = []
  for (let h = Math.ceil(minH / yStep) * yStep; h <= maxH + 1e-9; h += yStep) {
    yTicks.push(h)
  }

  return (
    <div className="w-full h-full flex flex-col">
      {/* スケール コントロール */}
      <div className="text-[11px] text-slate-500 flex items-center gap-2 shrink-0 px-1 py-0.5">
        <span className="flex items-center gap-1">
          縦:
          <input
            type="range"
            min={0}
            max={PROFILE_SCALE_STEPS.length - 1}
            step={1}
            value={nearestScaleIndex(heightScale)}
            onChange={(e) => setHeightScale(PROFILE_SCALE_STEPS[parseInt(e.target.value, 10)])}
            className="w-20"
          />
          <span className="w-10 text-right tabular-nums">
            {(heightScale * 100).toFixed(0)}%
          </span>
        </span>
        <span className="flex items-center gap-1">
          横:
          <input
            type="range"
            min={0}
            max={PROFILE_SCALE_STEPS.length - 1}
            step={1}
            value={nearestScaleIndex(widthScale)}
            onChange={(e) => setWidthScale(PROFILE_SCALE_STEPS[parseInt(e.target.value, 10)])}
            className="w-20"
          />
          <span className="w-10 text-right tabular-nums">
            {(widthScale * 100).toFixed(0)}%
          </span>
        </span>
        {(heightScale !== 1.0 || widthScale !== 1.0) && (
          <button
            onClick={resetScale}
            className="px-1.5 py-0.5 text-[11px] rounded bg-slate-200 hover:bg-slate-300"
          >
            リセット
          </button>
        )}
        <span className="text-slate-400">Ctrl+ホイール: 縦 / Shift+ホイール: 横</span>
      </div>

      {/* スクロール 可能 な SVG 領域 */}
      <div
        ref={scrollRef}
        onWheel={handleWheel}
        className="flex-1 min-h-0 overflow-auto border rounded bg-slate-50"
      >
        <svg width={svgWidth} height={svgHeight} className="block">
          {/* 枠 */}
          <line
            x1={padding.left}
            y1={padding.top}
            x2={padding.left}
            y2={padding.top + innerH}
            stroke="#94a3b8"
            strokeWidth={1}
          />
          <line
            x1={padding.left}
            y1={padding.top + innerH}
            x2={padding.left + innerW}
            y2={padding.top + innerH}
            stroke="#94a3b8"
            strokeWidth={1}
          />

          {/* Y 軸グリッド + ラベル */}
          {yTicks.map((h, i) => (
            <g key={`y-${i}`}>
              <line
                x1={padding.left}
                y1={ty(h)}
                x2={padding.left + innerW}
                y2={ty(h)}
                stroke="#e2e8f0"
                strokeWidth={1}
              />
              <text
                x={padding.left - 4}
                y={ty(h) + 3}
                textAnchor="end"
                fontSize={10}
                fill="#64748b"
              >
                {yStep < 1 ? h.toFixed(2) : h.toFixed(1)}
              </text>
            </g>
          ))}

          {/* X 軸グリッド + ラベル */}
          {xTicks.map((d, i) => (
            <g key={`x-${i}`}>
              <line
                x1={tx(d)}
                y1={padding.top}
                x2={tx(d)}
                y2={padding.top + innerH}
                stroke="#f1f5f9"
                strokeWidth={1}
              />
              <line
                x1={tx(d)}
                y1={padding.top + innerH}
                x2={tx(d)}
                y2={padding.top + innerH + 3}
                stroke="#94a3b8"
                strokeWidth={1}
              />
              {/* 目盛 ラベル: SP 値 で 出す (中間点計算 の 表と 同じ 座標系)。
                  spOffset=0 なら SP = 距離 なので 表示は 実質 距離。 */}
              <text
                x={tx(d)}
                y={padding.top + innerH + 14}
                textAnchor="middle"
                fontSize={10}
                fill="#64748b"
              >
                {(() => {
                  const sp = d + spOffset
                  return xStep < 1 ? sp.toFixed(1) : String(Math.round(sp))
                })()}
              </text>
            </g>
          ))}

          {/* 計画高ライン */}
          <path
            d={path}
            fill="none"
            stroke="#0ea5e9"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* 現況地盤線 (茶): LandXML TIN から 取り込んだ 各測点 の currentGroundHeight を
              距離順 で つなぐ。 計画線 と 区別 する ため 茶色 + 少し 細く。 */}
          {currentPts.length >= 2 && (
            <path
              d={currentPts
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${tx(p.distance)} ${ty(p.z)}`)
                .join(' ')}
              fill="none"
              stroke="#a16207"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity={0.9}
            />
          )}
          {currentPts.map((p, i) => (
            <circle
              key={`cg-${i}`}
              cx={tx(p.distance)}
              cy={ty(p.z)}
              r={2.5}
              fill="#a16207"
              stroke="#fff"
              strokeWidth={1}
            />
          ))}

          {/* 点 (縦断曲線 が 適用 されている PVI は 薄色 の 中抜き で 「実際 は
              通過 しない」ことを 表現) */}
          {sorted.map((p, i) => {
            const isCurvedPvi = curveByPvi.has(i)
            return (
              <circle
                key={`p-${i}`}
                cx={tx(p.distance)}
                cy={ty(p.floorHeight)}
                r={3.5}
                fill={isCurvedPvi ? '#fff' : '#0ea5e9'}
                stroke={isCurvedPvi ? '#94a3b8' : '#fff'}
                strokeDasharray={isCurvedPvi ? '2,2' : undefined}
                strokeWidth={1.5}
              />
            )
          })}

          {/* 縦断曲線 の BVC / EVC マーカー + M / VCR 注記 */}
          {curves.map((c) => (
            <g key={`vc-${c.pviIndex}`}>
              {/* BVC / EVC 縦の 補助線 */}
              <line
                x1={tx(c.bvcDistance)}
                y1={ty(c.bvcHeight)}
                x2={tx(c.bvcDistance)}
                y2={padding.top + innerH}
                stroke="#f97316"
                strokeWidth={0.75}
                strokeDasharray="2,2"
                opacity={0.7}
              />
              <line
                x1={tx(c.evcDistance)}
                y1={ty(c.evcHeight)}
                x2={tx(c.evcDistance)}
                y2={padding.top + innerH}
                stroke="#f97316"
                strokeWidth={0.75}
                strokeDasharray="2,2"
                opacity={0.7}
              />
              {/* BVC / EVC マーカー */}
              <circle
                cx={tx(c.bvcDistance)}
                cy={ty(c.bvcHeight)}
                r={3}
                fill="#f97316"
                stroke="#fff"
                strokeWidth={1}
              />
              <circle
                cx={tx(c.evcDistance)}
                cy={ty(c.evcHeight)}
                r={3}
                fill="#f97316"
                stroke="#fff"
                strokeWidth={1}
              />
              <text
                x={tx(c.bvcDistance)}
                y={padding.top + innerH + 24}
                textAnchor="middle"
                fontSize={9}
                fill="#c2410c"
              >
                BVC
              </text>
              <text
                x={tx(c.evcDistance)}
                y={padding.top + innerH + 24}
                textAnchor="middle"
                fontSize={9}
                fill="#c2410c"
              >
                EVC
              </text>
              {/* PVI 位置 に VCL / M / VCR を まとめて 表示 */}
              <text
                x={tx(c.pviDistance)}
                y={ty(c.pviHeight) - 10}
                textAnchor="middle"
                fontSize={9}
                fill="#c2410c"
              >
                VCL={c.vcl.toFixed(0)}  M={c.m.toFixed(3)}m
              </text>
            </g>
          ))}

          {/* 勾配ラベル */}
          {sorted.slice(1).map((p, i) => {
            const prev = sorted[i]
            const dx = p.distance - prev.distance
            const dy = p.floorHeight - prev.floorHeight
            if (Math.abs(dx) < 1e-6) return null
            const slope =
              Math.abs(dy) < 1e-9 ? '水平' : `1/${Math.round(Math.abs(dx / dy))}`
            const mx = (tx(prev.distance) + tx(p.distance)) / 2
            const my = (ty(prev.floorHeight) + ty(p.floorHeight)) / 2 - 6
            return (
              <text
                key={`s-${i}`}
                x={mx}
                y={my}
                textAnchor="middle"
                fontSize={10}
                fill="#475569"
              >
                {slope}
              </text>
            )
          })}

          {/* 軸単位 */}
          <text x={5} y={padding.top - 2} fontSize={10} fill="#64748b">
            計画高 (m)
          </text>
          <text
            x={svgWidth - 4}
            y={svgHeight - 4}
            textAnchor="end"
            fontSize={10}
            fill="#64748b"
          >
            {spOffset === 0 ? '距離 (m)' : 'SP (m)'}
          </text>
        </svg>
      </div>
    </div>
  )
}


/**
 * 断面図 (表示 専用)。
 *
 * 断面 の 入力 は 左 の 断面入力欄 (SectionPointsEditor) と
 * LandXML / 地図 / DXF から の 取込 に 一本化 した ので、ここ は
 * 計画線 / 現況 / 出来形 の 表示 と パン / ズーム だけ を 受け持つ。
 *
 * 座標系: 中心 (0,0) を 基準 に 右 +x / 左 -x、上 +y (計画高 基準)。
 */
/** 断面 区間 の 勾配 部分 だけ を 短い 文字列 に。 直高 は 高さ (符号 付) を 返す。 */
function formatSlopeOnly(e: CrossSectionElement): string {
  if (e.slopeUnit === 'vertical') {
    const sign = e.slopeValue >= 0 ? '+' : ''
    return `H${sign}${e.slopeValue.toFixed(3)}`
  }
  if (e.slopeUnit === 'percent') {
    const sign = e.slopeValue >= 0 ? '+' : ''
    return `${sign}${e.slopeValue.toFixed(2)}%`
  }
  const sign = e.slopeValue < 0 ? '-' : ''
  return `${sign}1:${Math.abs(e.slopeValue).toFixed(2)}`
}

/** 断面 区間 の 幅 部分 だけ を 短い 文字列 に。 直高 (幅 0) の 場合 は 空 文字。 */
function formatWidthOnly(e: CrossSectionElement): string {
  if (e.slopeUnit === 'vertical') return ''
  if (e.width < 1e-6) return ''
  return e.width.toFixed(2)
}

/** 標高 は mm 単位 (小数 3 桁) まで 出す。 12.3 → "12.300" */
const mm3 = (x: number): string => x.toFixed(3)

/**
 * 標高 の 入力欄。 触って いない 間 は mm 単位 (小数 3 桁) で 揃えて 見せ、
 * フォーカス 中 だけ 生 の 文字列 を 持つ (12.300 の 末尾 0 を 消さない と 打ちにくい)。
 * 空 を 許す 欄 (現況高 など) は allowEmpty で null を 返す。
 */
function ElevationField({
  value,
  onCommit,
  allowEmpty = false,
  className,
  placeholder,
  onClick,
}: {
  value: number | null | undefined
  onCommit: (v: number | null) => void
  allowEmpty?: boolean
  className?: string
  placeholder?: string
  onClick?: (e: React.MouseEvent<HTMLInputElement>) => void
}) {
  const [buf, setBuf] = useState<string | null>(null)
  const shown = buf ?? (value == null ? '' : mm3(value))
  const commit = () => {
    const raw = (buf ?? '').trim()
    setBuf(null)
    if (buf == null) return
    if (raw === '') {
      if (allowEmpty && value != null) onCommit(null)
      return
    }
    const n = parseFloat(raw)
    if (!Number.isFinite(n)) return
    const rounded = Math.round(n * 1000) / 1000
    if (rounded !== value) onCommit(rounded)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      value={shown}
      placeholder={placeholder}
      onClick={onClick}
      onFocus={() => setBuf(value == null ? '' : String(value))}
      onChange={(e) => setBuf(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      className={className}
    />
  )
}

/**
 * 断面点 の 表。 中心 / 左 / 右 の かたまり ごと に 出す。
 * 左 / 右 は 末尾 に 空白行 を 持ち、そこ に 直接 打つ と 1 点 増える
 * (幅杭 / 縦断 の 表 と 同じ 入力 の しかた)。
 */
function SectionRowTable({
  title,
  side,
  rows,
  sourceOf,
  onUpdate,
  onRemove,
  onAdd,
}: {
  title: string
  /** 空白行 で 追加 する とき の 符号。 center は 追加行 を 出さない */
  side: 'center' | 'left' | 'right'
  rows: MeasuredCrossPoint[]
  sourceOf: (id: string) => string
  onUpdate: (id: string, patch: Partial<MeasuredCrossPoint>) => void
  onRemove: (id: string) => void
  onAdd?: (p: { offset: number; elevation: number; note?: string }) => void
}) {
  // 末尾 の 空白行 の 下書き。 離れ と 標高 が 揃った 時点 で 1 点 に する
  const [dOffset, setDOffset] = useState('')
  const [dElevation, setDElevation] = useState('')
  const [dNote, setDNote] = useState('')
  const canAdd = side !== 'center' && !!onAdd
  const commitDraft = () => {
    if (!canAdd || !onAdd) return
    const o = parseFloat(dOffset)
    const e = parseFloat(dElevation)
    if (!Number.isFinite(o) || o === 0 || !Number.isFinite(e)) return
    onAdd({
      // 左 の 表 に 打った 値 は 左 (負) に 寄せる。 符号 は 気にしなくて よい
      offset: side === 'left' ? -Math.abs(o) : Math.abs(o),
      elevation: e,
      note: dNote.trim() || undefined,
    })
    setDOffset('')
    setDElevation('')
    setDNote('')
  }
  const onDraftKey = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      commitDraft()
    }
  }
  return (
    <div className="border rounded overflow-hidden">
      <div className="px-2 py-1 bg-slate-100 text-[11px] font-semibold text-slate-600 flex items-center gap-1">
        {title}
        <span className="text-slate-400 font-normal">{rows.length} 点</span>
      </div>
      {rows.length === 0 && !canAdd ? (
        <div className="px-2 py-3 text-center text-[11px] text-slate-400">なし</div>
      ) : (
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="px-1 py-1 text-right">離れ (m)</th>
              <th className="px-1 py-1 text-right">標高 (m)</th>
              <th className="px-1 py-1 text-left">点名</th>
              <th className="px-1 py-1 w-7" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="px-1 py-1">
                  <input
                    type="number"
                    step={0.01}
                    value={r.offset}
                    onChange={(e) => onUpdate(r.id, { offset: parseFloat(e.target.value) || 0 })}
                    className="w-full px-1 py-0.5 border rounded text-right tabular-nums"
                  />
                </td>
                <td className="px-1 py-1">
                  <ElevationField
                    value={r.elevation}
                    onCommit={(v) => onUpdate(r.id, { elevation: v ?? 0 })}
                    className="w-full px-1 py-0.5 border rounded text-right tabular-nums"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={r.note ?? ''}
                    onChange={(e) => onUpdate(r.id, { note: e.target.value || undefined })}
                    placeholder={sourceOf(r.id)}
                    className="w-full px-1 py-0.5 border rounded"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    onClick={() => onRemove(r.id)}
                    className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                    title="この点を削除"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
            {/* 末尾 の 空白行。 離れ と 標高 を 入れて Enter (か + ) で 1 点 追加 */}
            {canAdd && (
              <tr className="border-t bg-slate-50/60">
                <td className="px-1 py-1">
                  <input
                    type="number"
                    step={0.01}
                    value={dOffset}
                    onChange={(e) => setDOffset(e.target.value)}
                    onKeyDown={onDraftKey}
                    placeholder={side === 'left' ? '左へ m' : '右へ m'}
                    className="w-full px-1 py-0.5 border rounded text-right tabular-nums bg-white"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={dElevation}
                    onChange={(e) => setDElevation(e.target.value)}
                    onKeyDown={onDraftKey}
                    onBlur={commitDraft}
                    placeholder="標高 m"
                    className="w-full px-1 py-0.5 border rounded text-right tabular-nums bg-white"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={dNote}
                    onChange={(e) => setDNote(e.target.value)}
                    onKeyDown={onDraftKey}
                    placeholder="点名"
                    className="w-full px-1 py-0.5 border rounded bg-white"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    onClick={commitDraft}
                    disabled={
                      !Number.isFinite(parseFloat(dOffset)) ||
                      !Number.isFinite(parseFloat(dElevation))
                    }
                    className="p-0.5 border rounded hover:bg-blue-50 text-blue-600 disabled:opacity-30"
                    title="この行を追加"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}

/**
 * 断面 の 点列 を 直接 いじる 表 (縦断/横断図 の 左 に 常設)。
 *
 * 中心線からの 離れ (右+ / 左-) と 標高 の ペア を 行 単位 で 追加・編集・削除。
 * 測点 を 選ぶ と そのまま この 表 が その 断面 の 中身 に なる ので、
 * 「表で入力」 の ような 呼び出し は 要らない。
 *
 * 編集 は 即時 に onChange で 返す。 表示 は ローカル 状態 を 持ち、
 * 測点 / 対象 が 変わった とき と 外 から 点数 が 変わった とき に 読み直す。
 */
function SectionPointsEditor({
  target,
  stationId,
  stationLabel,
  points,
  autoPoints,
  onChange,
}: {
  target: SectionTarget
  stationId: string
  stationLabel: string
  points: MeasuredCrossPoint[]
  /** 横断幅 以内 の 実測記録 (まだ 表 に 入って いない 分)。 現況 だけ */
  autoPoints?: MeasuredCrossPoint[]
  onChange: (points: MeasuredCrossPoint[]) => void
}) {
  const [rows, setRows] = useState<MeasuredCrossPoint[]>(() => points.map((p) => ({ ...p })))
  // 測点 / 対象 が 変わったら 読み直す (同じ 断面 を 編集 中 は 触らない)
  useEffect(() => {
    setRows(points.map((p) => ({ ...p })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, target])
  // 外 (地図ピック / DXF トレース / LandXML 取込) から 点数 が 変わった 場合 も 追従
  useEffect(() => {
    setRows((prev) => (prev.length === points.length ? prev : points.map((p) => ({ ...p }))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.length])

  const commit = (next: MeasuredCrossPoint[]) => {
    setRows(next)
    onChange(next)
  }
  const targetLabel =
    target === 'current' ? '現況断面' : target === 'asbuilt' ? '出来形' : '計画断面 (トレース)'
  /** 行 の id の 頭 で 出所 が 分かる (sr-=実測記録 / mp-=地図 / dxf-=トレース / tin-=LandXML) */
  const sourceOf = (id: string): string =>
    id.startsWith('sr-') ? '実測記録'
      : id.startsWith('tin-') ? 'LandXML'
      : id.startsWith('dxf-') ? 'DXF'
      : id.startsWith('mp-') ? '地図'
      : '手入力'
  const newId = () => `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  /** 空白行 から の 追加。 離れ 順 に 入れて おく */
  const addPoint = (p: { offset: number; elevation: number; note?: string }) =>
    commit([...rows, { id: newId(), ...p }].sort((a, b) => a.offset - b.offset))
  /** 横断幅 以内 の 実測記録 を 表 に 入れる。 既に ある 分 は 足さない */
  const addFromRecords = () => {
    if (!autoPoints || autoPoints.length === 0) return
    const have = new Set(rows.map((p) => p.id))
    const add = autoPoints.filter((p) => !have.has(p.id))
    if (add.length === 0) return
    commit([...rows, ...add].sort((a, b) => a.offset - b.offset))
  }
  const clearRows = () => {
    if (rows.length === 0) return
    if (!window.confirm(`${rows.length} 点 すべて を 消します。よろしいですか？`)) return
    commit([])
  }
  const sortRows = () => commit([...rows].sort((a, b) => a.offset - b.offset))
  const removeRow = (id: string) => commit(rows.filter((p) => p.id !== id))
  const updateRow = (id: string, patch: Partial<MeasuredCrossPoint>) =>
    commit(rows.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  // 中心 / 左 / 右。 左右 は 中心 に 近い 順 (|離れ| の 小さい 順)
  const center = rows.filter((r) => r.offset === 0)
  const leftRows = rows
    .filter((r) => r.offset < 0)
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))
  const rightRows = rows
    .filter((r) => r.offset > 0)
    .sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset))

  return (
    <div className="h-full flex flex-col gap-1.5">
      <div className="shrink-0">
        <div className="text-xs font-semibold text-slate-700">
          {targetLabel}
          <span className="ml-1 font-mono text-slate-500">{stationLabel}</span>
          <span className="ml-1 text-[11px] font-normal text-slate-400">{rows.length} 点</span>
        </div>
        <div className="mt-1 flex items-center gap-1 flex-wrap">
          {autoPoints && autoPoints.length > 0 && (
            <button
              onClick={addFromRecords}
              className="px-1.5 py-0.5 text-[11px] border rounded bg-cyan-50 text-cyan-800 border-cyan-300 hover:bg-cyan-100"
              title="中心線沿い の 横断幅 以内 に ある 実測記録 を 行 と して 取り込む"
            >
              実測記録から ({autoPoints.length})
            </button>
          )}
          <button
            onClick={sortRows}
            disabled={rows.length < 2}
            className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-40"
          >
            離れ順
          </button>
          <button
            onClick={clearRows}
            disabled={rows.length === 0}
            className="ml-auto px-1.5 py-0.5 text-[11px] border rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            全消去
          </button>
        </div>
      </div>
      {/* 中心 から 左 / 右 に 分けて 並べる。 上 が 中心 寄り で、下 に 行く ほど 外。
          現場 で 読む 順 と 同じ に する ため。 */}
      <div className="flex-1 min-h-0 overflow-auto space-y-1.5">
        {center.length > 0 && (
          <SectionRowTable
            title="中心 (0)"
            side="center"
            rows={center}
            sourceOf={sourceOf}
            onUpdate={updateRow}
            onRemove={removeRow}
          />
        )}
        <div className="grid grid-cols-2 gap-1.5">
          <SectionRowTable
            title="左 (L)"
            side="left"
            rows={leftRows}
            sourceOf={sourceOf}
            onUpdate={updateRow}
            onRemove={removeRow}
            onAdd={addPoint}
          />
          <SectionRowTable
            title="右 (R)"
            side="right"
            rows={rightRows}
            sourceOf={sourceOf}
            onUpdate={updateRow}
            onRemove={removeRow}
            onAdd={addPoint}
          />
        </div>
        {rows.length === 0 && (
          <div className="px-2 py-4 text-center text-slate-400 text-[11px] border rounded">
            まだ 点が ありません。 左 / 右 の 空白行 に 打つ か、上 の 取込 から 始めて ください。
          </div>
        )}
      </div>
    </div>
  )
}

function CrossSectionView({
  cs,
  centerHeight,
  currentGroundHeight,
  currentSection,
  asbuiltSection,
}: {
  cs: StandardCrossSection
  centerHeight?: number
  /** 現況高 (中心線上の 地盤高) [m]。undefined / null は 未入力扱い。
   *  横線 + ラベルで 上書き表示し、計画高との 差分 (切/盛) も 併記 */
  currentGroundHeight?: number | null
  /** 現況断面 の 測定点列 (offset, elevation)。ある場合 は 折れ線 + マーカーで 描画。 */
  currentSection?: MeasuredCrossPoint[] | null
  /** 出来形 断面 の 測定点列。ある場合 は 別 色 で 折れ線 + マーカー描画。 */
  asbuiltSection?: MeasuredCrossPoint[] | null
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 720, h: 340 })

  // 断面 の 入力 は 左 の 断面入力欄 (表) に 一本化 した ので、
  // ここ は 表示 (パン / ズーム) だけ を 持つ。

  // 表示側の パン (SVG ピクセル) と ズーム 倍率。 自動フィット (scale / offset) の 上に
  // 重ねる 「ユーザー操作 の 視点」。 データ を 変えても 保持し、リセットボタンで 戻す。
  const [viewPan, setViewPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [viewZoom, setViewZoom] = useState<number>(1)
  // ドラッグ 中 に click を 発火させない ため の ガード。ref で 持ち 再レンダー を 避ける。
  const wasDraggingRef = useRef<boolean>(false)
  const panStartRef = useRef<{ px: number; py: number; panX: number; panY: number } | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect
      setSize({
        w: Math.max(320, Math.floor(rect.width)),
        h: Math.max(200, Math.floor(rect.height)),
      })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ホイール ズーム。 React の onWheel は passive で preventDefault が 効かない ため、
  // 生 addEventListener で { passive: false } で 張る。カーソル 位置 を 中心に 拡縮。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      setViewZoom((prevZoom) => {
        const nextZoom = Math.max(0.2, Math.min(10, prevZoom * factor))
        const k = nextZoom / prevZoom
        setViewPan((prevPan) => ({
          x: px - (px - prevPan.x) * k,
          y: py - (py - prevPan.y) * k,
        }))
        return nextZoom
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 描画済 の 折れ線 (左端 → 中心 → 右端)
  const points = useMemo(() => buildCrossSectionPath(cs), [cs])

  // SVG スケール。 cs / 現況 / 出来形 が 変わった とき に 再フィット する。
  const padding = { top: 30, right: 20, bottom: 40, left: 20 }
  const innerW = size.w - padding.left - padding.right
  const innerH = size.h - padding.top - padding.bottom
  const xsForExt = points.map((p) => p.x)
  const ysForExt = points.map((p) => p.y)
  const minX = Math.min(-5, ...xsForExt)
  const maxX = Math.max(5, ...xsForExt)
  const minY = Math.min(-2, ...ysForExt)
  const maxY = Math.max(0.5, ...ysForExt)
  const spanX = Math.max(maxX - minX, 0.01)
  const spanY = Math.max(maxY - minY, 0.01)
  const scale = Math.min(innerW / spanX, innerH / spanY)
  const drawnW = spanX * scale
  const drawnH = spanY * scale
  const offsetX = padding.left + (innerW - drawnW) / 2 - minX * scale
  const offsetY = padding.top + (innerH - drawnH) / 2 + maxY * scale
  const tx = (x: number) => offsetX + x * scale
  const ty = (y: number) => offsetY - y * scale

  /**
   * 断面点 に マウス を 当てた とき に 出す 中身。
   * 点名 (note) / 地盤高 (標高) / 幅 (中心 から の 離れ) を 見せる。
   */
  const [hoverPoint, setHoverPoint] = useState<{
    x: number
    y: number
    name: string | null
    elevation: number
    offset: number
    kind: '現況' | '出来形' | '計画'
  } | null>(null)

  // 世界 座標 → 画面 ピクセル (パン/ズーム 込み)。参照線 の 位置 決定 等 に 使う
  const vx = (x: number) => viewPan.x + viewZoom * tx(x)
  const vy = (y: number) => viewPan.y + viewZoom * ty(y)

  const onSvgMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    // 左ボタン のみ pan 候補。右クリックは 通常メニュー を 出す (何もしない)
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    wasDraggingRef.current = false
    panStartRef.current = {
      px: e.clientX - rect.left,
      py: e.clientY - rect.top,
      panX: viewPan.x,
      panY: viewPan.y,
    }
  }
  const onSvgMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    // 左ボタン 押しっぱなし で 4px 以上 動いたら pan (以後 click は 抑止)
    if (panStartRef.current && (e.buttons & 1)) {
      const dx = px - panStartRef.current.px
      const dy = py - panStartRef.current.py
      if (wasDraggingRef.current || Math.hypot(dx, dy) > 4) {
        wasDraggingRef.current = true
        setViewPan({
          x: panStartRef.current.panX + dx,
          y: panStartRef.current.panY + dy,
        })
      }
    }
  }
  const onSvgMouseLeave = () => {
    panStartRef.current = null
  }
  const onSvgMouseUp = () => {
    panStartRef.current = null
    // wasDraggingRef は 直後の onClick で 読まれる。次の mouseDown で リセット される
  }
  /** 表示 リセット: パン (0,0) / ズーム 1.0 に 戻す (自動フィット 状態) */
  const resetView = () => {
    setViewPan({ x: 0, y: 0 })
    setViewZoom(1)
  }
  return (
    <div className="flex flex-col gap-2 h-full">
      {/* ツールバー。 断面 の 入力 は 左 の 断面入力欄 (表) に 一本化 した ので、
          ここ に 残る のは 表示 まわり だけ。 */}
      <div className="flex items-center gap-1.5 flex-wrap text-xs shrink-0">
        <button
          onClick={resetView}
          className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-100"
          title="表示 (パン / ズーム) を リセット"
        >
          表示リセット
        </button>
        <span className="text-slate-400 text-[10px] ml-1">
          ホイール ズーム / ドラッグ スクロール
        </span>
      </div>

      {/* 断面図。 点 の 入力 は 左 の 断面入力欄 (表) で 行う。
          ここ は 表示 と パン / ズーム だけ。 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 border rounded bg-slate-50 relative overflow-hidden"
      >
        <svg
          width={size.w}
          height={size.h}
          onMouseDown={onSvgMouseDown}
          onMouseMove={onSvgMouseMove}
          onMouseLeave={onSvgMouseLeave}
          onMouseUp={onSvgMouseUp}
          style={{ cursor: wasDraggingRef.current ? 'grabbing' : 'grab' }}
        >
          {/* 中心線 (縦) は 画面 端まで 伸ばす (パン/ズームで 端が 見切れないよう、
              transform の 外で 位置を 手計算)。 中心設計高 は 横線で なく 中心線上の
              点マーカー だけで 示す (下の 中心設計高 マーカー 参照)。 */}
          <line
            x1={vx(0)}
            y1={padding.top}
            x2={vx(0)}
            y2={size.h - padding.bottom}
            stroke="#cbd5e1"
            strokeDasharray="3,3"
            strokeWidth={1}
          />

          {/* 世界レイヤ: パン/ズームで 変形。断面 本体・折点・寸法ラベル・プレビュー等 */}
          <g transform={`translate(${viewPan.x} ${viewPan.y}) scale(${viewZoom})`}>

          {/* 現在 の 断面 */}
          {points.length >= 2 && (
            <path
              d={points
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${tx(p.x)} ${ty(p.y)}`)
                .join(' ')}
              fill="none"
              stroke="#0ea5e9"
              strokeWidth={2}
              strokeLinejoin="round"
            />
          )}

          {/* 各 折点 */}
          {points.map((p, i) => (
            <circle
              key={`v-${i}`}
              cx={tx(p.x)}
              cy={ty(p.y)}
              r={3}
              fill={Math.abs(p.x) < 1e-9 && Math.abs(p.y) < 1e-9 ? '#0ea5e9' : '#fff'}
              stroke="#0ea5e9"
              strokeWidth={1.5}
            />
          ))}

          {/* 各 区間 の パラメータ ラベル。
              - 線 の 上 (画面 上 側) : 勾配 (2.00% / 1:1.5↑ / H+1.500 等)
              - 線 の 下 (画面 下 側) : 幅 (dW を m 無しで 2.00 と 表記)
              直高 区間 は 幅 0 の ため 下側 は 省略。 */}
          {(() => {
            type Seg = {
              from: { x: number; y: number }
              to: { x: number; y: number }
              e: CrossSectionElement
            }
            const segs: Seg[] = []
            let rx = 0
            let ry = 0
            for (const e of cs.right) {
              const from = { x: rx, y: ry }
              const s = elementStep(e, 1)
              rx += s.dx
              ry += s.dy
              segs.push({ from, to: { x: rx, y: ry }, e })
            }
            let lx = 0
            let ly = 0
            for (const e of cs.left) {
              const from = { x: lx, y: ly }
              const s = elementStep(e, -1)
              lx += s.dx
              ly += s.dy
              segs.push({ from, to: { x: lx, y: ly }, e })
            }
            return segs.map((s, i) => {
              const midX = (tx(s.from.x) + tx(s.to.x)) / 2
              const midY = (ty(s.from.y) + ty(s.to.y)) / 2
              const dxSvg = tx(s.to.x) - tx(s.from.x)
              const dySvg = ty(s.to.y) - ty(s.from.y)
              const len = Math.hypot(dxSvg, dySvg) || 1
              // 画面 上 側 (SVG y が 小) を 指す 法線 単位 ベクトル
              let nUpX = -dySvg / len
              let nUpY = dxSvg / len
              if (nUpY > 0) {
                nUpX = -nUpX
                nUpY = -nUpY
              }
              const offset = 12
              const slope = formatSlopeOnly(s.e)
              const width = formatWidthOnly(s.e)
              return (
                <g key={`seglbl-${i}`}>
                  {slope && (
                    <text
                      x={midX + nUpX * offset}
                      y={midY + nUpY * offset}
                      fontSize={13}
                      fill="#334155"
                      textAnchor="middle"
                      style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
                    >
                      {slope}
                    </text>
                  )}
                  {width && (
                    <text
                      x={midX - nUpX * offset}
                      y={midY - nUpY * offset + 4}
                      fontSize={13}
                      fill="#334155"
                      textAnchor="middle"
                      style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
                    >
                      {width}
                    </text>
                  )}
                </g>
              )
            })
          })()}

          {/* 現況断面: offset を x に、elevation - centerHeight を y に。
              計画高 (y=0) 基準で 折れ線 (茶) + 点マーカー を 描画。
              測定点は 中心軸 (x=0) から 見て 右+ / 左- (WidthStake 同じ 慣習)。
              左計画線 は 描画時 x を 反転してるので、断面座標系 に 合わせるため x = offset。 */}
          {currentSection && currentSection.length > 0 && centerHeight !== undefined && (() => {
            const pts = currentSection
              .map((p) => ({ x: tx(p.offset), y: ty(p.elevation - centerHeight) }))
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
            return (
              <g>
                <path d={d} fill="none" stroke="#a16207" strokeWidth={1.5} strokeDasharray="4,3" opacity={0.9} />
                {currentSection.map((p, i) => (
                  <circle
                    key={`cs-${p.id ?? i}`}
                    cx={tx(p.offset)}
                    cy={ty(p.elevation - centerHeight)}
                    r={3.5}
                    fill="#a16207"
                    stroke="#fff"
                    strokeWidth={1.5}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() =>
                      setHoverPoint({
                        x: tx(p.offset),
                        y: ty(p.elevation - centerHeight),
                        name: p.note ?? null,
                        elevation: p.elevation,
                        offset: p.offset,
                        kind: '現況',
                      })
                    }
                    onMouseLeave={() => setHoverPoint(null)}
                  />
                ))}
                {/* 点名 (note) を 点 の 上 に 添える。 重なって 読めなく なる のを
                    避ける ため、隣 と 近い 点 は 一段 上げて 互い違い に する。 */}
                {currentSection.map((p, i) => {
                  if (!p.note) return null
                  const px = tx(p.offset)
                  const prev = currentSection[i - 1]
                  const tight = prev != null && Math.abs(px - tx(prev.offset)) < 34
                  return (
                    <text
                      key={`csl-${p.id ?? i}`}
                      x={px}
                      y={ty(p.elevation - centerHeight) - (tight ? 18 : 8)}
                      fontSize={10}
                      textAnchor="middle"
                      fill="#a16207"
                      pointerEvents="none"
                      style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
                    >
                      {p.note}
                    </text>
                  )
                })}
              </g>
            )
          })()}
          {/* 出来形 断面 (緑系) — 現状 保存だけ、次ステップで 使う */}
          {asbuiltSection && asbuiltSection.length > 0 && centerHeight !== undefined && (() => {
            const pts = asbuiltSection
              .map((p) => ({ x: tx(p.offset), y: ty(p.elevation - centerHeight) }))
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')
            return (
              <g>
                <path d={d} fill="none" stroke="#059669" strokeWidth={1.5} opacity={0.9} />
                {asbuiltSection.map((p, i) => (
                  <circle
                    key={`as-${p.id ?? i}`}
                    cx={tx(p.offset)}
                    cy={ty(p.elevation - centerHeight)}
                    r={3.5}
                    fill="#059669"
                    stroke="#fff"
                    strokeWidth={1.5}
                    style={{ cursor: 'pointer' }}
                    onMouseEnter={() =>
                      setHoverPoint({
                        x: tx(p.offset),
                        y: ty(p.elevation - centerHeight),
                        name: p.note ?? null,
                        elevation: p.elevation,
                        offset: p.offset,
                        kind: '出来形',
                      })
                    }
                    onMouseLeave={() => setHoverPoint(null)}
                  />
                ))}
                {/* 点名 (note) を 点 の 上 に 添える。 重なって 読めなく なる のを
                    避ける ため、隣 と 近い 点 は 一段 上げて 互い違い に する。 */}
                {asbuiltSection.map((p, i) => {
                  if (!p.note) return null
                  const px = tx(p.offset)
                  const prev = asbuiltSection[i - 1]
                  const tight = prev != null && Math.abs(px - tx(prev.offset)) < 34
                  return (
                    <text
                      key={`asl-${p.id ?? i}`}
                      x={px}
                      y={ty(p.elevation - centerHeight) - (tight ? 18 : 8)}
                      fontSize={10}
                      textAnchor="middle"
                      fill="#059669"
                      pointerEvents="none"
                      style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}
                    >
                      {p.note}
                    </text>
                  )
                })}
              </g>
            )
          })()}
          {/* 計画 (トレース由来) 断面 の 重ね描き は 廃止。 対話型 エディタ 用 cs
              (station.crossSection / standardCrossSection) が 常に plannedSectionRaw
              と 同じ 内容 で 保存 される ため、 主線 と 重複 する だけ に なる。 */}
          </g>
          {/* 現況高: 中心線上の 地盤高が 入力されて いる 場合、中心線 (x=0) 上の
              「点 (丸)」で 示す。 従来は 全幅 の 水平線 だったが 図が うるさく なる ため
              マーカー + ラベル (計画高 との 差=切/盛) のみ に した。 */}
          {currentGroundHeight != null && centerHeight !== undefined && (() => {
            const dy = currentGroundHeight - centerHeight
            const cutFillLabel =
              dy > 0.001 ? `切 ${dy.toFixed(3)}m` : dy < -0.001 ? `盛 ${(-dy).toFixed(3)}m` : '±0'
            const cutFillColor = dy > 0.001 ? '#dc2626' : dy < -0.001 ? '#2563eb' : '#64748b'
            return (
              <>
                <circle
                  cx={vx(0)}
                  cy={vy(dy)}
                  r={4}
                  fill="#a16207"
                  stroke="#fff"
                  strokeWidth={1}
                />
                <text x={vx(0) + 8} y={vy(dy) - 4} fontSize={12} fill="#a16207">
                  現況高 {currentGroundHeight.toFixed(3)}m
                </text>
                <text x={vx(0) + 8} y={vy(dy) + 14} fontSize={11} fill={cutFillColor} fontWeight={600}>
                  {cutFillLabel}
                </text>
              </>
            )
          })()}
          {/* 中心設計高: 中心線 (x=0) 上の 「点 (丸)」で 示す + ラベル。
              旧来は 全幅 の 水平線 だったが 図が うるさく なる ため マーカー のみ に した。 */}
          {centerHeight !== undefined && (
            <>
              <circle
                cx={vx(0)}
                cy={vy(0)}
                r={4}
                fill="#334155"
                stroke="#fff"
                strokeWidth={1}
              />
              <text x={vx(0) + 8} y={vy(0) - 4} fontSize={12} fill="#334155">
                中心設計高 {centerHeight.toFixed(3)}m
              </text>
            </>
          )}

          {/* 左右 ラベル (パン/ズームに 影響されない UI 表示) */}
          <text x={padding.left} y={16} fontSize={12} fill="#64748b">
            左
          </text>
          <text
            x={size.w - padding.right}
            y={16}
            fontSize={12}
            fill="#64748b"
            textAnchor="end"
          >
            右
          </text>

          {/* 断面点 の 吹き出し。 点名 / 地盤高 / 幅 を 出す。
              枠 から はみ出す 側 は 反対 に 回す。 */}
          {hoverPoint && (() => {
            const rows = [
              hoverPoint.name ? `${hoverPoint.kind}  ${hoverPoint.name}` : hoverPoint.kind,
              `地盤高 ${hoverPoint.elevation.toFixed(3)} m`,
              `幅 ${hoverPoint.offset >= 0 ? 'R' : 'L'}${Math.abs(hoverPoint.offset).toFixed(3)} m`,
            ]
            const w = Math.max(...rows.map((t) => t.length)) * 6.6 + 14
            const h = rows.length * 14 + 10
            const flipX = hoverPoint.x + 12 + w > size.w
            const flipY = hoverPoint.y - 12 - h < 0
            const bx = flipX ? hoverPoint.x - 12 - w : hoverPoint.x + 12
            const by = flipY ? hoverPoint.y + 12 : hoverPoint.y - 12 - h
            return (
              <g pointerEvents="none">
                <rect
                  x={bx}
                  y={by}
                  width={w}
                  height={h}
                  rx={3}
                  fill="rgba(15,23,42,0.92)"
                  stroke="#0f172a"
                />
                {rows.map((t, i) => (
                  <text
                    key={i}
                    x={bx + 7}
                    y={by + 16 + i * 14}
                    fontSize={11}
                    fill="#fff"
                    fontFamily="ui-monospace, monospace"
                  >
                    {t}
                  </text>
                ))}
                <circle
                  cx={hoverPoint.x}
                  cy={hoverPoint.y}
                  r={6}
                  fill="none"
                  stroke="#0f172a"
                  strokeWidth={1.5}
                />
              </g>
            )
          })()}
        </svg>
      </div>
    </div>
  )
}


/**
 * 3 桁精度で 数値 → 文字列 化 (float 誤差 の 末尾 桁を 落とす)。
 * 例: 3059.9999999999995 → "3060"、17.500000000000003 → "17.5"
 */
function trimFloat3(x: number): string {
  return String(Math.round(x * 1000) / 1000)
}

/**
 * 縦断線形 テーブル の 1 行。 SP / 計画高 / VCL の 3 入力を ローカルドラフト で 持ち、
 * blur (or Enter) で 親に コミット。 これにより:
 *   - 途中入力で 配列が 再ソートされて 行 位置が 入れ替わる 現象を 防ぐ
 *   - float 誤差で cursor 入れると 値が 揺れる 現象を 防ぐ (親側は 3 桁丸めで 保存)
 */
function ProfileRow({
  p,
  index,
  isMiddle,
  slopeText,
  curve,
  spOffset,
  onChangeCommit,
  onRemove,
}: {
  p: ProfilePoint
  index: number
  isMiddle: boolean
  slopeText: string
  curve: VerticalCurve | undefined
  spOffset: number
  onChangeCommit: (patch: Partial<ProfilePoint>) => void
  onRemove: () => void
}) {
  const [spDraft, setSpDraft] = useState<string>(() => trimFloat3(p.distance + spOffset))
  const [zDraft, setZDraft] = useState<string>(() => mm3(p.floorHeight))
  const [vclDraft, setVclDraft] = useState<string>(() => (p.vcl ? trimFloat3(p.vcl) : ''))
  // 外部 (別行 の コミット等) で 値が 変わった時 は ドラフト を 同期。
  // 「入力中」の この行 は onChangeCommit で 親を 更新するので 変わる → useEffect で
  // 同じ 文字列に 戻す (実質 no-op)。 他行 の 変更で この行 の p が 変わる こと は 通常 なし。
  useEffect(() => { setSpDraft(trimFloat3(p.distance + spOffset)) }, [p.distance, spOffset])
  useEffect(() => { setZDraft(mm3(p.floorHeight)) }, [p.floorHeight])
  useEffect(() => { setVclDraft(p.vcl ? trimFloat3(p.vcl) : '') }, [p.vcl])

  const commitSp = () => {
    const sp = parseFloat(spDraft)
    if (!Number.isFinite(sp)) {
      setSpDraft(trimFloat3(p.distance + spOffset))
      return
    }
    const nextDist = Math.round((sp - spOffset) * 1000) / 1000
    if (nextDist !== p.distance) onChangeCommit({ distance: nextDist })
  }
  const commitZ = () => {
    const v = parseFloat(zDraft)
    if (!Number.isFinite(v)) {
      setZDraft(mm3(p.floorHeight))
      return
    }
    const nextZ = Math.round(v * 1000) / 1000
    // 値 が 変わら なくて も 表示 は mm 単位 に 揃え 直す (12.3 → 12.300)
    setZDraft(mm3(nextZ))
    if (nextZ !== p.floorHeight) onChangeCommit({ floorHeight: nextZ })
  }
  const commitVcl = () => {
    const raw = vclDraft.trim()
    if (raw === '') {
      if (p.vcl !== undefined) onChangeCommit({ vcl: undefined })
      return
    }
    const v = parseFloat(raw)
    if (!Number.isFinite(v) || v <= 0) {
      if (p.vcl !== undefined) onChangeCommit({ vcl: undefined })
      setVclDraft('')
      return
    }
    const nextVcl = Math.round(v * 100) / 100
    if (nextVcl !== p.vcl) onChangeCommit({ vcl: nextVcl })
  }
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') e.currentTarget.blur()
  }
  return (
    <tr className="border-t">
      <td className="px-2 py-1 text-center text-slate-500 text-xs">{index + 1}</td>
      <td className="px-2 py-1 text-right">
        <input
          type="number"
          step={0.1}
          value={spDraft}
          onChange={(e) => setSpDraft(e.target.value)}
          onBlur={commitSp}
          onKeyDown={onEnter}
          className="w-20 px-1 py-0.5 border rounded text-right text-sm"
        />
      </td>
      <td className="px-2 py-1 text-right">
        <input
          type="number"
          step={0.001}
          value={zDraft}
          onChange={(e) => setZDraft(e.target.value)}
          onBlur={commitZ}
          onKeyDown={onEnter}
          className="w-20 px-1 py-0.5 border rounded text-right text-sm"
        />
      </td>
      <td className="px-2 py-1 text-right text-slate-500 tabular-nums">{slopeText}</td>
      <td className="px-2 py-1 text-right">
        {isMiddle ? (
          <input
            type="number"
            step={1}
            min={0}
            value={vclDraft}
            placeholder="0"
            onChange={(e) => setVclDraft(e.target.value)}
            onBlur={commitVcl}
            onKeyDown={onEnter}
            className="w-16 px-1 py-0.5 border rounded text-right text-sm"
          />
        ) : (
          <span className="text-slate-300 text-xs">—</span>
        )}
      </td>
      <td className="px-2 py-1 text-right text-[10px] tabular-nums">
        {curve ? (
          <span className="text-amber-700" title={
            `i1=${curve.i1Percent.toFixed(2)}% / i2=${curve.i2Percent.toFixed(2)}% / A=${curve.aPercent.toFixed(2)}%`
          }>
            M={curve.m.toFixed(3)}m
            <br />
            VCR={Number.isFinite(curve.vcr) ? curve.vcr.toFixed(1) : '∞'}
          </span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="px-2 py-1 text-right">
        <button
          onClick={onRemove}
          className="p-0.5 border rounded hover:bg-red-50 text-red-600"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </td>
    </tr>
  )
}

/**
 * 現況 / 計画 (トレース) / 出来形 の 3 種 断面 対象。
 * 表モーダル・地図ピック・DXF トレース で 共通の 対象種別 として 使う。
 */
type SectionTarget = 'current' | 'asbuilt' | 'planned'

/** SectionTarget → 表示ラベル / トレース時の 色 */
const SECTION_TARGET_META: Record<SectionTarget, { label: string; color: string }> = {
  current: { label: '現況', color: '#a16207' },
  planned: { label: '計画', color: '#0ea5e9' },
  asbuilt: { label: '出来形', color: '#059669' },
}

/**
 * DXF 上の 点 (px, py) を 校正 (calib) を 通して 実 (offset, elevation) に 変換。
 * DXF は mm 単位、hScale/vScale は 分母 (100 = 1:100)。
 *   offset [m]    = (px - centerX) * hScale / 1000
 *   elevation [m] = dlElevation + (py - dlY) * vScale / 1000
 */
function dxfToWorld(
  px: number,
  py: number,
  calib: DxfCalibration,
): { offset: number; elevation: number } {
  const offset = ((px - calib.centerX) * calib.hScale) / 1000
  const elevation = calib.dlElevation + ((py - calib.dlY) * calib.vScale) / 1000
  return {
    offset: Math.round(offset * 1000) / 1000,
    elevation: Math.round(elevation * 1000) / 1000,
  }
}

/**
 * トレース 点リスト の 「ここ に 割り込む」 帯。
 * 点 と 点 の 間 を 押して 次 の 1 点 を 入れる 位置 を 決める。
 */
function InsertSlot({
  active,
  onClick,
  last,
}: {
  active: boolean
  onClick: () => void
  last?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-1 px-1.5 text-[10px] leading-none ${
        active
          ? 'bg-amber-100 text-amber-800 py-1'
          : 'text-transparent hover:text-slate-500 hover:bg-slate-100 py-0.5'
      }`}
      title={last ? '末尾 に 足す' : 'ここ に 割り込む'}
    >
      <span className="flex-1 border-t border-dashed border-current" />
      <span>{active ? 'ここ に 追加' : '＋'}</span>
      <span className="flex-1 border-t border-dashed border-current" />
    </button>
  )
}

/**
 * DXF トレース モーダル: 選択測点 + 対象 (現況/計画/出来形) 向けに
 * 校正 (DL/中心線/縮尺) と トレース (LINE/LWPOLYLINE クリックで 点列 抽出) を 行う。
 */
function DxfTraceModal({
  channel,
  station,
  target: initialTarget,
  stationsOrdered,
  onClose,
  onSaveCalibration,
  onReplacePoints,
  onSwitchStation,
  onUpdateStationDxfId,
  onUploadDxf,
  onDeleteDxf,
}: {
  channel: OpenChannelRow
  station: StationRow
  target: SectionTarget
  /** 全 測点 (前/次 ボタン 用)。 stations そのままの 並び。 */
  stationsOrdered: StationRow[]
  onClose: () => void
  onSaveCalibration: (calib: DxfCalibration) => void
  /** 「確定」ボタン (or 対象切替 の 前) で 呼ばれる。 指定 target の 断面 点列を 差替 */
  onReplacePoints: (target: SectionTarget, pts: MeasuredCrossPoint[]) => void
  /** 前/次 の 測点に 切替。 呼ぶ前に 現行 draft は 自動 コミット される。 */
  onSwitchStation: (stationId: string) => void
  /** この 測点で 使う DXF ファイル の id を 更新 (station.dxfCrossSectionId)。 */
  onUpdateStationDxfId: (stationId: string, dxfId: string | null) => void
  /** DXF ファイル を Storage に アップロード + channel.dxfCrossSections に 追加 +
   *  当該 station.dxfCrossSectionId を 新規 id に セット。 */
  onUploadDxf: (file: File) => Promise<void>
  /** DXF ファイル を Storage から 削除 + channel.dxfCrossSections から 除外 +
   *  参照 中 の 全 station.dxfCrossSectionId を クリア。 */
  onDeleteDxf: (dxfId: string) => Promise<void>
}) {
  // モーダル内で 切り替えられる 現在の 対象 (初期値は 呼出元の 指定)
  const [activeTarget, setActiveTarget] = useState<SectionTarget>(initialTarget)
  const stationSectionKey =
    activeTarget === 'current' ? 'currentSection' : activeTarget === 'asbuilt' ? 'asbuiltSection' : 'plannedSectionRaw'
  // モーダル内 で 編集する ローカル 点列 (確定 ボタン まで 元の 断面には 反映しない)
  const [localPoints, setLocalPoints] = useState<MeasuredCrossPoint[]>(() => {
    const initial = (station[stationSectionKey] as MeasuredCrossPoint[] | null | undefined) ?? []
    return initial.map((p) => ({ ...p }))
  })
  /**
   * 次 の 1 点 を 入れる 位置。 null = 末尾 (従来 どおり 右端 に 足す)。
   * 数値 の とき は その 前 に 割り込む (0 = 先頭 = 左端)。
   * 割り込み 中 も 拾った 順 に 並ぶ よう、1 点 足す ごと に 1 つ 進める。
   */
  const [insertIndex, setInsertIndex] = useState<number | null>(null)
  // station or 対象 が 変わった時 に 該当 断面の 点列を 再読込
  useEffect(() => {
    const initial = (station[stationSectionKey] as MeasuredCrossPoint[] | null | undefined) ?? []
    setLocalPoints(initial.map((p) => ({ ...p })))
    setInsertIndex(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id, activeTarget])

  /**
   * 対象を 切り替える。 現在の ローカル 点列を 現行 target に 自動コミットしてから
   * 切替 (useEffect で 新 target の 点列を 読込む)。 破棄して 切り替えたい場合は
   * 先に 「全クリア」してから 切替。
   */
  const switchTarget = (t: SectionTarget) => {
    if (t === activeTarget) return
    // 現行 の draft を 自動 コミット (入力順を そのまま 保存)
    onReplacePoints(activeTarget, localPoints)
    setActiveTarget(t)
  }

  // 対象 DXF ファイル (複数対応): station.dxfCrossSectionId で 選択。 未指定は 先頭。
  // 旧 scalar (dxfCrossSectionPath) しか 無い チャンネル は toRow で 'legacy' id に
  // マイグレート 済み なので ここでは 常に dxfCrossSections 経由で 引く。
  const dxfFiles = channel.dxfCrossSections ?? []
  const activeDxfId = station.dxfCrossSectionId ?? dxfFiles[0]?.id ?? null
  const activeDxf = dxfFiles.find((f) => f.id === activeDxfId) ?? null

  // 前/次 の 測点 (stations の 表示順 = 距離 順 前提)
  const currentIdx = stationsOrdered.findIndex((s) => s.id === station.id)
  const prevStation = currentIdx > 0 ? stationsOrdered[currentIdx - 1] : null
  const nextStation =
    currentIdx >= 0 && currentIdx < stationsOrdered.length - 1
      ? stationsOrdered[currentIdx + 1]
      : null

  /**
   * 測点を 切り替える。 現行 draft を 自動 コミットしてから 親の 選択を 差替える。
   * 校正情報は station に 紐付いて 保存されて いる ので、新 station の 校正が あれば
   * useEffect で 自動 再ロード される。
   */
  const switchStation = (targetId: string) => {
    onReplacePoints(activeTarget, localPoints)
    onSwitchStation(targetId)
  }

  const [dxfText, setDxfText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // DXF アップロード / 削除 の busy 状態 (サイドバー DXF 管理 で 使用)
  const [dxfBusy, setDxfBusy] = useState(false)
  const dxfFileInputRef = useRef<HTMLInputElement | null>(null)

  const handleUploadDxfFile = async (file: File | null) => {
    if (!file) return
    setDxfBusy(true)
    setError(null)
    try {
      await onUploadDxf(file)
    } catch (e) {
      console.error('[dxf upload]', e)
      setError(e instanceof Error ? e.message : 'アップロード 失敗')
    } finally {
      setDxfBusy(false)
      if (dxfFileInputRef.current) dxfFileInputRef.current.value = ''
    }
  }
  const handleDeleteDxfFile = async (f: DxfCrossSectionFile) => {
    if (!window.confirm(`DXF 「${f.name}」を 削除しますか?`)) return
    setDxfBusy(true)
    setError(null)
    try {
      await onDeleteDxf(f.id)
    } catch (e) {
      console.error('[dxf delete]', e)
      setError(e instanceof Error ? e.message : '削除 失敗')
    } finally {
      setDxfBusy(false)
    }
  }

  const [pickMode, setPickMode] = useState<'dl' | 'center' | 'trace' | null>(null)
  // トレース時 の 吸着 (端点/交点 スナップ) ON/OFF
  const [snapEnabled, setSnapEnabled] = useState<boolean>(true)
  // 校正 入力 (既存 校正 が あれば 初期値)
  const [dlY, setDlY] = useState<number | null>(station.dxfCalibration?.dlY ?? null)
  const [centerX, setCenterX] = useState<number | null>(station.dxfCalibration?.centerX ?? null)
  const [dlEl, setDlEl] = useState<string>(
    station.dxfCalibration?.dlElevation != null ? String(station.dxfCalibration.dlElevation) : '',
  )
  const [hScale, setHScale] = useState<string>(
    station.dxfCalibration?.hScale != null ? String(station.dxfCalibration.hScale) : '100',
  )
  const [vScale, setVScale] = useState<string>(
    station.dxfCalibration?.vScale != null ? String(station.dxfCalibration.vScale) : '100',
  )

  // 対象 DXF が 変わる 度 (=測点切替 or DXF セレクタ 変更) に 再ダウンロード。
  useEffect(() => {
    if (!activeDxf) {
      setDxfText(null)
      return
    }
    let cancelled = false
    setDxfText(null)
    setLoading(true)
    setError(null)
    supabase.storage
      .from('open-channel-dxf')
      .download(activeDxf.path)
      .then(async ({ data, error: dlErr }) => {
        if (cancelled) return
        if (dlErr || !data) throw dlErr ?? new Error('DL 失敗')
        const buf = await data.arrayBuffer()
        if (cancelled) return
        setDxfText(decodeDxfBytes(buf))
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[dxf trace download]', e)
        setError(e instanceof Error ? e.message : '取得 失敗')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDxf?.path])

  // 測点が 変わったら 校正入力を その 測点の 保存値で 再初期化。 pick モード も リセット。
  // (station.id 依存 の みで OK — 同じ 測点内での 校正 上書き 保存は 呼出元経由で 反映)
  useEffect(() => {
    setDlY(station.dxfCalibration?.dlY ?? null)
    setCenterX(station.dxfCalibration?.centerX ?? null)
    setDlEl(
      station.dxfCalibration?.dlElevation != null
        ? String(station.dxfCalibration.dlElevation)
        : '',
    )
    setHScale(
      station.dxfCalibration?.hScale != null
        ? String(station.dxfCalibration.hScale)
        : '100',
    )
    setVScale(
      station.dxfCalibration?.vScale != null
        ? String(station.dxfCalibration.vScale)
        : '100',
    )
    setPickMode(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id])

  const parsedCalib = useMemo<DxfCalibration | null>(() => {
    const dlNum = parseFloat(dlEl)
    const hNum = parseFloat(hScale)
    const vNum = parseFloat(vScale)
    if (dlY == null || centerX == null) return null
    if (!Number.isFinite(dlNum) || !Number.isFinite(hNum) || !Number.isFinite(vNum)) return null
    if (hNum <= 0 || vNum <= 0) return null
    return { dlY, centerX, dlElevation: dlNum, hScale: hNum, vScale: vNum }
  }, [dlY, centerX, dlEl, hScale, vScale])

  const handleCanvasPick = (worldPt: { x: number; y: number }, shape: DxfShape | null) => {
    if (pickMode === 'dl') {
      // DL は 水平線 想定。 線に ヒットして 水平なら その中央 Y、それ以外は
      // クリック位置 Y を そのまま (短い セグメントで 外れた ケースも 拾える)。
      let y = worldPt.y
      if (shape?.kind === 'line' && Math.abs(shape.y1 - shape.y2) < 0.1) {
        y = (shape.y1 + shape.y2) / 2
      }
      setDlY(Math.round(y * 1000) / 1000)
      setPickMode(null)
      return
    }
    if (pickMode === 'center') {
      // 中心線 も 同様。 中心線マーク が 短い セグメント (数 mm) の DXF も 多いので
      // 空クリック でも 位置 X を 直接 採用する。
      let x = worldPt.x
      if (shape?.kind === 'line' && Math.abs(shape.x1 - shape.x2) < 0.1) {
        x = (shape.x1 + shape.x2) / 2
      }
      setCenterX(Math.round(x * 1000) / 1000)
      setPickMode(null)
      return
    }
    if (pickMode === 'trace') {
      if (!parsedCalib) return
      // トレースは 1 クリック = 1 点、ローカル 点列 に 追加 (確定 ボタン まで 反映しない)
      const w = dxfToWorld(worldPt.x, worldPt.y, parsedCalib)
      const now = Date.now()
      const rand = () => Math.random().toString(36).slice(2, 7)
      const pt: MeasuredCrossPoint = {
        id: `dxf-${now}-${rand()}`,
        offset: w.offset,
        elevation: w.elevation,
      }
      setLocalPoints((pts) => {
        const at = insertIndex == null ? pts.length : Math.min(insertIndex, pts.length)
        return [...pts.slice(0, at), pt, ...pts.slice(at)]
      })
      // 割り込み 中 は キャレット も 1 つ 進めて、続けて 拾って も 順 が 崩れない
      setInsertIndex((i) => (i == null ? null : i + 1))
      return
    }
  }
  const clearLocalPoints = () => {
    setLocalPoints([])
    setInsertIndex(null)
  }
  /** キャレット の 直前 1 点 を 取消 (末尾 モード なら 最後 の 点) */
  const undoLastPoint = () => {
    setLocalPoints((pts) => {
      const at = insertIndex == null ? pts.length : Math.min(insertIndex, pts.length)
      if (at <= 0) return pts
      return [...pts.slice(0, at - 1), ...pts.slice(at)]
    })
    setInsertIndex((i) => (i == null ? null : Math.max(0, i - 1)))
  }
  /** 点 を 1 個 消す。 キャレット より 前 を 消した ら キャレット も 詰める */
  const removePointAt = (idx: number) => {
    setLocalPoints((pts) => pts.filter((_, k) => k !== idx))
    setInsertIndex((i) => (i == null ? null : i > idx ? i - 1 : i))
  }
  const confirmAndClose = () => {
    // 入力順を そのまま 保存 (オーバーハング等 の 逆行を 潰さない)
    onReplacePoints(activeTarget, localPoints)
    onClose()
  }

  // BS で 直近 1 点を 取消。 入力欄 フォーカス中は 通常の 文字削除に 干渉しない
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return
      // トレース モード 以外での BS は 無視 (校正入力中の 誤削除を 防ぐ)
      if (pickMode !== 'trace') return
      e.preventDefault()
      undoLastPoint()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pickMode])

  // モーダル内 ローカル 点列 を DXF 上に 逆マッピングで マーカー + 折れ線 表示
  // (校正済み時のみ)。 ラベル に 「H (標高) / d (中心離れ)」を 付けて 誤認しにくく する。
  // 折れ線は 拾った 順に 結ぶ (オーバーハング等で 水平方向が 逆行する ケースを 潰さない)。
  const overlays = useMemo(() => {
    if (!parsedCalib) return []
    const color = SECTION_TARGET_META[activeTarget].color
    const toDxfXY = (p: MeasuredCrossPoint) => ({
      x: parsedCalib.centerX + (p.offset * 1000) / parsedCalib.hScale,
      y: parsedCalib.dlY + ((p.elevation - parsedCalib.dlElevation) * 1000) / parsedCalib.vScale,
    })
    const items: NonNullable<React.ComponentProps<typeof DxfCrossSectionViewer>['overlays']> = []
    // 折れ線 (入力順)
    if (localPoints.length >= 2) {
      items.push({
        kind: 'line',
        color,
        pts: localPoints.map(toDxfXY),
      })
    }
    // 各点 の マーカー + ラベル (H / d を 2 段 で 縦積み)。
    // 通し番号 を 付けて、左 の 点リスト と 見比べられる ように する。
    localPoints.forEach((p, idx) => {
      const xy = toDxfXY(p)
      items.push({
        kind: 'dot',
        x: xy.x,
        y: xy.y,
        color,
        label: [
          `#${idx + 1} H ${p.elevation.toFixed(3)}`,
          `d ${p.offset >= 0 ? '+' : ''}${p.offset.toFixed(3)}`,
        ],
      })
    })
    // 割り込み 位置 を 図 の 上 でも 示す。 割り込む 2 点 を 橙 の 丸 で 囲み、
    // その 間 を 破線 に する (どこ に 入る のか 一目 で 分かる)
    if (insertIndex != null) {
      const at = Math.min(insertIndex, localPoints.length)
      const before = at > 0 ? localPoints[at - 1] : null
      const after = at < localPoints.length ? localPoints[at] : null
      if (before && after) {
        items.push({
          kind: 'line',
          color: '#f59e0b',
          dashed: true,
          pts: [toDxfXY(before), toDxfXY(after)],
        })
      }
      for (const p of [before, after]) {
        if (!p) continue
        const xy = toDxfXY(p)
        items.push({ kind: 'dot', x: xy.x, y: xy.y, color: '#f59e0b', r: 1.6 })
      }
    }
    return items
  }, [parsedCalib, localPoints, activeTarget, insertIndex])

  // トレース仮線 の 出発点 = キャレット の 直前 1 点 (末尾 モード なら localPoints
  // 末尾)。 校正済み で 1 点以上 あれば DXF 座標に 逆マッピングして 渡す。
  const traceRubberBandFrom = useMemo<{ x: number; y: number } | null>(() => {
    if (!parsedCalib || localPoints.length === 0) return null
    const at = insertIndex == null ? localPoints.length : Math.min(insertIndex, localPoints.length)
    if (at === 0) return null
    const p = localPoints[at - 1]
    return {
      x: parsedCalib.centerX + (p.offset * 1000) / parsedCalib.hScale,
      y: parsedCalib.dlY + ((p.elevation - parsedCalib.dlElevation) * 1000) / parsedCalib.vScale,
    }
  }, [parsedCalib, localPoints, insertIndex])

  // カーソル位置の 補助ラベル (校正済み + トレース中に 有効)。
  // 校正 済み なら 常時 現在位置の 「H (標高) / d (中心離れ)」を 返す。
  const cursorLabelFormatter = useMemo(() => {
    if (!parsedCalib) return undefined
    return (wp: { x: number; y: number }) => {
      const w = dxfToWorld(wp.x, wp.y, parsedCalib)
      return [
        `H ${w.elevation.toFixed(3)}`,
        `d ${w.offset >= 0 ? '+' : ''}${w.offset.toFixed(3)}`,
      ]
    }
  }, [parsedCalib])

  const meta = SECTION_TARGET_META[activeTarget]

  return (
    <div className="fixed inset-0 bg-black/60 z-[3000] flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full h-full max-w-[95vw] max-h-[95vh] flex flex-col">
        <div className="flex items-center gap-3 px-3 py-2 border-b">
          {/* 前/次 測点 切替。 押下 前に 現行 draft は 自動 コミット。 */}
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => prevStation && switchStation(prevStation.id)}
              disabled={!prevStation}
              className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              title={prevStation ? `前 の 測点 (${prevStation.label}) に 切替` : '前 の 測点 なし'}
            >
              ◀ {prevStation?.label ?? '—'}
            </button>
            <button
              onClick={() => nextStation && switchStation(nextStation.id)}
              disabled={!nextStation}
              className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"
              title={nextStation ? `次 の 測点 (${nextStation.label}) に 切替` : '次 の 測点 なし'}
            >
              {nextStation?.label ?? '—'} ▶
            </button>
          </div>
          <h3 className="text-sm font-semibold shrink-0">
            DXF から トレース —{' '}
            <span className="font-mono text-slate-600">{station.label}</span>
          </h3>
          {/* 対象 切替: 現況 / 計画 / 出来形。 切替 前に 現行 target へ 自動 保存 */}
          <div className="flex items-center gap-0.5">
            <span className="text-[10px] text-slate-500 mr-1">対象</span>
            {(['current', 'planned', 'asbuilt'] as SectionTarget[]).map((t) => {
              const m = SECTION_TARGET_META[t]
              const active = t === activeTarget
              return (
                <button
                  key={t}
                  onClick={() => switchTarget(t)}
                  className={`px-2 py-0.5 text-[11px] border rounded ${
                    active
                      ? 'text-white'
                      : 'bg-white hover:bg-slate-50'
                  }`}
                  style={
                    active
                      ? { backgroundColor: m.color, borderColor: m.color }
                      : { color: m.color, borderColor: m.color }
                  }
                  title={active ? '選択中' : `${m.label} に 切替 (現行の draft は 自動保存)`}
                >
                  {m.label}
                </button>
              )
            })}
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1 hover:bg-slate-100 rounded"
            title="閉じる"
          >
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          {/* 左サイドバー: DXF 管理 + 校正 + トレース操作 */}
          <div className="w-72 border-r p-3 overflow-y-auto text-xs flex flex-col gap-3 shrink-0">
            {/* DXF 図面 管理: 取込 + 一覧 (ラジオ 選択 + 削除)。 校正は 選択 中の 図面
                (station.dxfCrossSectionId) に 対して 記録される。 */}
            <div>
              <div className="font-semibold mb-1">DXF 図面</div>
              <input
                ref={dxfFileInputRef}
                type="file"
                accept=".dxf,application/dxf"
                onChange={(e) => void handleUploadDxfFile(e.target.files?.[0] ?? null)}
                className="hidden"
              />
              {dxfFiles.length === 0 ? (
                <button
                  onClick={() => dxfFileInputRef.current?.click()}
                  disabled={dxfBusy}
                  className="w-full flex items-center justify-center gap-1 px-2 py-1 border rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {dxfBusy ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Upload className="h-3 w-3" />
                  )}
                  DXF を 取込
                </button>
              ) : (
                <>
                  <div className="flex flex-col gap-1">
                    {dxfFiles.map((f, i) => {
                      const active = activeDxfId === f.id
                      return (
                        <label
                          key={f.id}
                          className={`flex items-center gap-1 border rounded px-1.5 py-1 cursor-pointer ${
                            active
                              ? 'bg-blue-50 border-blue-400'
                              : 'bg-white hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="radio"
                            name="active-dxf"
                            checked={active}
                            onChange={() => onUpdateStationDxfId(station.id, f.id)}
                            className="cursor-pointer"
                          />
                          <span className="text-[10px] tabular-nums text-slate-400 w-4 text-center">
                            {i + 1}
                          </span>
                          <span
                            className="flex-1 text-[11px] font-mono truncate"
                            title={f.name}
                          >
                            {f.name}
                          </span>
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              void handleDeleteDxfFile(f)
                            }}
                            disabled={dxfBusy}
                            className="p-0.5 text-red-600 hover:bg-red-50 rounded disabled:opacity-40"
                            title="この DXF を 削除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </label>
                      )
                    })}
                  </div>
                  <button
                    onClick={() => dxfFileInputRef.current?.click()}
                    disabled={dxfBusy}
                    className="mt-1 w-full flex items-center justify-center gap-1 px-2 py-1 border rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {dxfBusy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Upload className="h-3 w-3" />
                    )}
                    + DXF 追加
                  </button>
                </>
              )}
            </div>
            <div>
              <div className="font-semibold mb-1">① 校正</div>
              <div className="grid grid-cols-1 gap-1.5">
                <button
                  onClick={() => setPickMode(pickMode === 'dl' ? null : 'dl')}
                  className={`px-2 py-1 border rounded text-left ${
                    pickMode === 'dl'
                      ? 'bg-purple-600 text-white border-purple-600'
                      : 'bg-white hover:bg-slate-50'
                  }`}
                >
                  DL 選択 {dlY != null && <span className="font-mono">{dlY.toFixed(2)}</span>}
                </button>
                <button
                  onClick={() => setPickMode(pickMode === 'center' ? null : 'center')}
                  className={`px-2 py-1 border rounded text-left ${
                    pickMode === 'center'
                      ? 'bg-purple-600 text-white border-purple-600'
                      : 'bg-white hover:bg-slate-50'
                  }`}
                >
                  中心線 選択 {centerX != null && <span className="font-mono">{centerX.toFixed(2)}</span>}
                </button>
                <label className="flex items-center gap-1">
                  <span className="w-20 text-slate-500">DL 実標高 (m)</span>
                  <input
                    type="number"
                    step={0.01}
                    value={dlEl}
                    onChange={(e) => setDlEl(e.target.value)}
                    className="flex-1 px-1 py-0.5 border rounded font-mono text-right"
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="w-20 text-slate-500">H 縮尺 (1:)</span>
                  <input
                    type="number"
                    step={1}
                    value={hScale}
                    onChange={(e) => setHScale(e.target.value)}
                    className="flex-1 px-1 py-0.5 border rounded font-mono text-right"
                  />
                </label>
                <label className="flex items-center gap-1">
                  <span className="w-20 text-slate-500">V 縮尺 (1:)</span>
                  <input
                    type="number"
                    step={1}
                    value={vScale}
                    onChange={(e) => setVScale(e.target.value)}
                    className="flex-1 px-1 py-0.5 border rounded font-mono text-right"
                  />
                </label>
                <button
                  disabled={!parsedCalib}
                  onClick={() => parsedCalib && onSaveCalibration(parsedCalib)}
                  className="mt-1 px-2 py-1 border rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:bg-slate-300"
                >
                  校正 を 保存
                </button>
              </div>
            </div>
            <div>
              <div className="font-semibold mb-1">② トレース</div>
              {!parsedCalib ? (
                <div className="text-[11px] text-slate-500">
                  校正を 完了 (DL + 中心線 + 縮尺) すると トレース可能に なります
                </div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <button
                    onClick={() => setPickMode(pickMode === 'trace' ? null : 'trace')}
                    className={`px-2 py-1 border rounded text-left ${
                      pickMode === 'trace'
                        ? 'text-white'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                    style={
                      pickMode === 'trace'
                        ? { backgroundColor: meta.color, borderColor: meta.color }
                        : {}
                    }
                  >
                    {pickMode === 'trace' ? 'トレース 中 (クリックで 追加)' : `${meta.label}をトレース`}
                  </button>
                  <label className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={snapEnabled}
                      onChange={(e) => setSnapEnabled(e.target.checked)}
                      className="cursor-pointer"
                    />
                    <span>ピック (端点 / 交点に 吸着)</span>
                  </label>
                  <div className="text-[11px] text-slate-500">
                    1 クリック = 1 点 追加。 BS で 直前 1 点 取消。 ピック ON 時は
                    端点 (青) / 交点 (橙×) に 吸い付く。
                  </div>
                  <div className="flex items-center gap-1 text-[11px] pt-1 border-t">
                    <span className="text-slate-500">拾い済 {localPoints.length} 点</span>
                    <button
                      onClick={undoLastPoint}
                      disabled={localPoints.length === 0}
                      className="ml-auto px-2 py-0.5 border rounded bg-white hover:bg-slate-50 disabled:opacity-40"
                      title="追加位置 の 直前 1 点を 取消 (BS でも 可)"
                    >
                      1 点 戻す (BS)
                    </button>
                    <button
                      onClick={clearLocalPoints}
                      disabled={localPoints.length === 0}
                      className="px-2 py-0.5 border rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                    >
                      全クリア
                    </button>
                  </div>
                  {/* 追加位置。 既定 は 末尾 (右端) だが、先頭 (左端) や
                      点 と 点 の 間 を 選ぶ と そこ に 割り込んで 拾える。 */}
                  <div className="pt-1 border-t">
                    <div className="flex items-center gap-1 text-[11px]">
                      <span className="text-slate-500">追加位置</span>
                      <button
                        onClick={() => setInsertIndex(null)}
                        className={`ml-auto px-2 py-0.5 border rounded ${
                          insertIndex == null
                            ? 'bg-slate-700 text-white border-slate-700'
                            : 'bg-white hover:bg-slate-50'
                        }`}
                        title="末尾 に 足す (従来 どおり)"
                      >
                        末尾 (右端)
                      </button>
                      <button
                        onClick={() => setInsertIndex(0)}
                        disabled={localPoints.length === 0}
                        className={`px-2 py-0.5 border rounded disabled:opacity-40 ${
                          insertIndex === 0
                            ? 'bg-amber-500 text-white border-amber-500'
                            : 'bg-white hover:bg-slate-50'
                        }`}
                        title="先頭 に 割り込む"
                      >
                        先頭 (左端)
                      </button>
                    </div>
                    {localPoints.length > 0 && (
                      <div className="mt-1 max-h-48 overflow-y-auto border rounded bg-white">
                        {localPoints.map((p, idx) => (
                          <div key={p.id}>
                            <InsertSlot
                              active={insertIndex === idx}
                              onClick={() => setInsertIndex(idx)}
                            />
                            <div className="px-1.5 py-0.5 flex items-center gap-1 text-[11px] font-mono hover:bg-slate-50">
                              <span className="w-6 text-slate-400">#{idx + 1}</span>
                              <span className="w-14 text-right">
                                {p.offset >= 0 ? '+' : ''}
                                {p.offset.toFixed(3)}
                              </span>
                              <span className="w-14 text-right">{p.elevation.toFixed(3)}</span>
                              <button
                                onClick={() => removePointAt(idx)}
                                className="ml-auto px-1 text-red-500 hover:bg-red-50 rounded"
                                title="この 点 を 削除"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        ))}
                        <InsertSlot
                          active={insertIndex == null || insertIndex >= localPoints.length}
                          onClick={() => setInsertIndex(null)}
                          last
                        />
                      </div>
                    )}
                    {insertIndex != null && (
                      <div className="mt-1 text-[11px] text-amber-700">
                        {insertIndex === 0
                          ? '先頭 に 割り込み 中'
                          : `#${insertIndex} の 後ろ に 割り込み 中`}
                        。 図 の 橙 破線 の 位置 に 入ります。
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {/* 中央: DXF ビューア */}
          <div className="flex-1 min-w-0 p-2">
            {loading && <div className="text-xs text-slate-500">DXF 読込中...</div>}
            {error && <div className="text-xs text-red-600">{error}</div>}
            {dxfText && (
              <DxfCrossSectionViewer
                dxfText={dxfText}
                onCanvasPick={pickMode ? handleCanvasPick : undefined}
                pickCursorHint={pickMode ?? undefined}
                highlightDlY={dlY}
                highlightCenterX={centerX}
                overlays={overlays}
                snapEnabled={snapEnabled}
                cursorLabelFormatter={cursorLabelFormatter}
                traceRubberBandFrom={traceRubberBandFrom}
              />
            )}
          </div>
        </div>
        {/* フッター: 確定 / 破棄 */}
        <div className="flex items-center justify-end gap-2 px-3 py-2 border-t bg-slate-50">
          <span className="text-[11px] text-slate-500 mr-auto">
            拾い済 {localPoints.length} 点 (確定 で 元の 断面に 反映)
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs border rounded bg-white hover:bg-slate-50"
          >
            破棄して閉じる
          </button>
          <button
            onClick={confirmAndClose}
            className="px-3 py-1 text-xs border rounded bg-blue-600 text-white hover:bg-blue-700"
          >
            確定して閉じる
          </button>
        </div>
      </div>
    </div>
  )
}


/** LandXML の 取込先 と 種別 の 対応。 kind は landxml_files.kind (自由文字列) */
const LANDXML_TARGET_META: Record<SectionTarget, { kind: LandxmlKind; label: string }> = {
  current: { kind: 'ground', label: '現況' },
  planned: { kind: 'design', label: '計画' },
  asbuilt: { kind: 'asbuilt', label: '出来形' },
}

/**
 * LandXML 取込 (横断 セクション 内 の 1 行)。
 *
 * 工区共有 の LandXML を Storage から fetch し、TIN から 各測点 の 断面 を
 * 一括 サンプリング して 現況 / 計画 / 出来形 の いずれか に 入れる。
 * 取込先 は 開いて いる タブ (target) で 決まり、LandXML の 種別 も それ に
 * 対応 する (現況=ground / 計画=design / 出来形=asbuilt)。
 *
 * - 未登録: ファイル選択 → uploadLandxmlFile で active に する
 * - 登録済: ファイル名 表示 + 「置換」 (別 の LandXML を 上げ直す)
 * - サンプリング: 幅 (半分) + 刻み を 指定 して 「取込」
 */
function LandxmlSectionImport({
  farmId,
  channelName,
  target,
  stations,
  segments,
  sideOrientation,
  onImported,
}: {
  farmId: string | null
  channelName: string | null
  /** 取込先。 横断 セクション の タブ と 同じ */
  target: SectionTarget
  stations: StationRow[]
  segments: AlignmentSegment[]
  sideOrientation: SideOrientation
  /** 測点 ごと の 点列。 親 で 中心高 / 個別断面 の 同期 まで 行う */
  onImported: (rows: { id: string; points: MeasuredCrossPoint[] }[]) => void
}) {
  const meta = LANDXML_TARGET_META[target]
  const [activeFile, setActiveFile] = useState<{
    id: string
    name: string
    storagePath: string
  } | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [halfWidthText, setHalfWidthText] = useState<string>('10')
  const [stepText, setStepText] = useState<string>('0.5')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 工区 の active な LandXML を fetch。 種別 は タブ に 対応 する ので
  // タブ を 切り替える と 見に 行く ファイル も 変わる。
  useEffect(() => {
    setStatus(null)
    setError(null)
    if (!farmId) {
      setActiveFile(null)
      return
    }
    let cancelled = false
    setLoadingFile(true)
    getActiveLandxmlFile(farmId, meta.kind)
      .then((row) => {
        if (cancelled) return
        setActiveFile(
          row ? { id: row.id, name: row.name, storagePath: row.storagePath } : null,
        )
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[landxml active fetch]', e)
      })
      .finally(() => {
        if (!cancelled) setLoadingFile(false)
      })
    return () => {
      cancelled = true
    }
  }, [farmId, meta.kind])

  const handleFileChosen = async (file: File | null) => {
    if (!file || !farmId) return
    setBusy(true)
    setError(null)
    setStatus(null)
    try {
      const text = await file.text()
      // 事前 パース で 有効性 チェック (壊れた XML は 上げない)
      const parsed = parseLandXml(text, file.name)
      if (parsed.surfaces.length === 0) {
        throw new Error('LandXML に 三角メッシュ (Surface) が 含まれて いません')
      }
      const uploaded = await uploadLandxmlFile({
        farmId,
        fileName: file.name,
        content: text,
        kind: meta.kind,
        notes: channelName ? `open-channel: ${channelName}` : null,
      })
      // 全体図 側 で 自動 再フェッチ される よう version を bump
      useLandxmlEventsStore.getState().bump()
      setActiveFile({
        id: uploaded.id,
        name: uploaded.name,
        storagePath: uploaded.storagePath,
      })
      setStatus(`「${file.name}」を ${meta.label} として 登録 しました`)
    } catch (e) {
      console.error('[landxml upload]', e)
      setError(e instanceof Error ? e.message : 'アップロード 失敗')
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleImport = async () => {
    if (!activeFile) {
      setError(`先に ${meta.label} の LandXML を 登録 して ください`)
      return
    }
    if (stations.length === 0) {
      setError('中間点 が 登録 されて いません')
      return
    }
    if (segments.length === 0) {
      setError('路線線形 が 未設定 です')
      return
    }
    const halfWidth = Number(halfWidthText)
    const step = Number(stepText)
    if (!Number.isFinite(halfWidth) || halfWidth <= 0) {
      setError('幅 (半分) は 正 の 数値 で 入力 して ください')
      return
    }
    if (!Number.isFinite(step) || step <= 0) {
      setError('刻み は 正 の 数値 で 入力 して ください')
      return
    }
    setBusy(true)
    setError(null)
    setStatus('LandXML を ダウンロード 中...')
    try {
      const text = await downloadLandxmlText(activeFile.storagePath)
      setStatus('TIN を 展開 中...')
      const parsed = parseLandXml(text, activeFile.name)
      if (parsed.surfaces.length === 0) {
        throw new Error('LandXML に 三角メッシュ が 含まれて いません')
      }
      // 複数 Surface が あれば 三角形 数 が 最大 の もの を 採用 (1 面 が 通例)
      const surface: ParsedSurface = parsed.surfaces.reduce((best, s) =>
        s.triangles.length > best.triangles.length ? s : best,
      )
      const tinIdx = indexTin(surface)

      setStatus(`${stations.length} 測点 を サンプリング 中...`)
      const rows: { id: string; points: MeasuredCrossPoint[] }[] = []
      for (const s of stations) {
        const pts = sampleStationCrossSection(
          tinIdx,
          segments,
          s.distance,
          sideOrientation,
          halfWidth,
          step,
          s.id,
        )
        // TIN の 外 は 触らない (既存 の 断面 を 空 で 潰さない)
        if (pts.length > 0) rows.push({ id: s.id, points: pts })
      }
      onImported(rows)
      const skipped = stations.length - rows.length
      setStatus(
        `完了: ${meta.label}断面 を ${rows.length}/${stations.length} 測点 に 作成` +
          (skipped > 0 ? ` (${skipped} 測点 は TIN 範囲外)` : ''),
      )
    } catch (e) {
      console.error('[landxml import]', e)
      setError(e instanceof Error ? e.message : '取込 失敗')
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  if (!farmId) return null

  return (
    <div className="space-y-1 text-[11px]">
      <input
        ref={fileInputRef}
        type="file"
        accept=".xml,application/xml,text/xml"
        onChange={(e) => void handleFileChosen(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-slate-500 shrink-0">LandXML ({meta.label})</span>
        <span
          className="font-mono truncate max-w-[12rem] text-slate-700"
          title={activeFile?.name}
        >
          {loadingFile ? '確認中…' : activeFile ? activeFile.name : '未登録'}
        </span>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy || loadingFile}
          className="px-2 py-0.5 border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
        >
          {activeFile ? '置換' : '登録'}
        </button>
        <label className="flex items-center gap-1 text-slate-500">
          <span>幅(半分)</span>
          <input
            type="number"
            step={0.5}
            min={0}
            value={halfWidthText}
            onChange={(e) => setHalfWidthText(e.target.value)}
            className="w-12 px-1 py-0.5 border rounded font-mono text-right"
          />
        </label>
        <label className="flex items-center gap-1 text-slate-500">
          <span>刻み</span>
          <input
            type="number"
            step={0.1}
            min={0.05}
            value={stepText}
            onChange={(e) => setStepText(e.target.value)}
            className="w-12 px-1 py-0.5 border rounded font-mono text-right"
          />
        </label>
        <button
          onClick={() => void handleImport()}
          disabled={busy || !activeFile || stations.length === 0}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 border rounded bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
          title={`LandXML の TIN から 全測点 の ${meta.label}断面 を 作成`}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          LandXML から{meta.label}を取込
        </button>
      </div>
      {status && <div className="text-emerald-700">{status}</div>}
      {error && <div className="text-red-600">{error}</div>}
    </div>
  )
}

export function OpenChannelAlignmentPage() {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { channels, fetchChannels, addChannel, updateChannel, deleteChannel } = useOpenChannelStore()

  const farmId = currentFarm?.id
  useEffect(() => {
    if (!farmId) return
    fetchCoordinates(farmId)
    fetchChannels(farmId)
  }, [farmId, fetchCoordinates, fetchChannels])

  // 座標系
  const zone = useMemo(() => {
    if (!currentFarm) return 13
    return projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  const [selectedId, setSelectedId] = useState<string | null>(null)
  useEffect(() => {
    if (!selectedId && channels.length > 0) setSelectedId(channels[0].id)
    if (selectedId && !channels.find((c) => c.id === selectedId)) setSelectedId(channels[0]?.id ?? null)
  }, [channels, selectedId])

  const selected = channels.find((c) => c.id === selectedId) ?? null

  // 線形点を解決して XY 列に変換。
  // 種別 (BP/IP/EP) は 位置から 自動決定 (先頭=BP、末尾=EP、中間=IP)。
  const alignmentXY = useMemo<AlignmentVertex[]>(() => {
    if (!selected) return []
    const out: AlignmentVertex[] = []
    const total = selected.alignmentPoints.length
    for (let i = 0; i < total; i++) {
      const p = selected.alignmentPoints[i]
      const c = coordinates.find((cc) => cc.id === p.coordId)
      if (!c) continue
      out.push({
        x: c.x,
        y: c.y,
        kind: inferKindByIndex(i, total),
        radius: p.radius,
        spiralAIn: p.spiralAIn,
        spiralAOut: p.spiralAOut,
      })
    }
    return out
  }, [selected, coordinates])

  const sampledXY = useMemo(() => sampleAlignment(alignmentXY, 64), [alignmentXY])
  const segments = useMemo(() => buildSegments(alignmentXY), [alignmentXY])
  const totalLen = useMemo(() => alignmentTotalLength(alignmentXY), [alignmentXY])
  // R (単曲線) や 緩和曲線が 当たっている IP について、元の 折れ線 (TS-IP-ST) を
  // 点線で 上書き表示する ための ガイド。
  const ipCornerGuides = useMemo(() => getIpCornerGuides(alignmentXY), [alignmentXY])

  // 描画用 lat/lng
  const sampledLatLng = useMemo<[number, number][]>(() => {
    return sampledXY.map((p) => {
      const r = converter.toLatLng(p.x, p.y)
      return [r.lat, r.lng]
    })
  }, [sampledXY, converter])

  // 線形点として 登録済みの 座標 ID 集合。CoordinateMap の checkedCoordIds に
  // 渡して スカイブルーの ハローで 強調 (座標管理と 同じ 選択済み表現)。
  const registeredCoordIds = useMemo(() => {
    if (!selected) return new Set<string>()
    return new Set(selected.alignmentPoints.map((p) => p.coordId))
  }, [selected])

  // 線形点セクション の 開閉状態。折りたたみ 中は 地図クリック 追加を 抑止 する。
  // 初期値 は CollapsibleSection と 同じく localStorage を 見る (デフォルト = 開)。
  const [linearPointsExpanded, setLinearPointsExpanded] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem('oc:section:linear-points')
      if (v === '0') return false
    }
    return true
  })

  // 地図下 パネル の 開閉状態 (localStorage 永続化、デフォルト = 開)。
  const [profileChartExpanded, setProfileChartExpanded] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = window.localStorage.getItem('oc:section:profile-chart')
      if (v === '0') return false
    }
    return true
  })
  const toggleProfileChart = () => {
    setProfileChartExpanded((prev) => {
      const next = !prev
      if (typeof window !== 'undefined') {
        window.localStorage.setItem('oc:section:profile-chart', next ? '1' : '0')
      }
      return next
    })
  }
  // 地図下 パネル の タブ (縦断図 / 横断図)。 計画 ボタン 押下 で 横断図 に 自動切替。
  type BottomTab = 'profile' | 'crossSection'
  const [bottomTab, setBottomTab] = useState<BottomTab>('profile')

  // 横断図 で 何を 編集する か。ヘッダーの ラベル 右側 3 ボタン で 切替。
  //   'plan'   — 計画断面 (従来の Interactive エディタ)
  //   'current'— 現況断面 (地図拾い or 表モーダル 入力)
  //   'asbuilt'— 出来形 (次ステップ 実装予定 — ボタンは 置く だけ)
  type EditTarget = 'plan' | 'current' | 'asbuilt'
  const [editTarget, setEditTarget] = useState<EditTarget>('plan')
  /** 編集対象 (タブ) を 断面 の 保存先 に マップ (plan → planned) */
  const sectionTargetOfEditTarget = (t: EditTarget): SectionTarget =>
    t === 'current' ? 'current' : t === 'asbuilt' ? 'asbuilt' : 'planned'
  /** 「横断」 セクション の タブ と 右下 横断図 の 編集対象 ボタン で 共用 */
  const EDIT_TARGET_TABS: { key: EditTarget; label: string; act: string; idle: string }[] = [
    {
      key: 'current',
      label: '現況',
      act: 'bg-amber-500 text-white border-amber-500',
      idle: 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50',
    },
    {
      key: 'plan',
      label: '計画',
      act: 'bg-blue-600 text-white border-blue-600',
      idle: 'bg-white text-blue-700 border-blue-300 hover:bg-blue-50',
    },
    {
      key: 'asbuilt',
      label: '出来形',
      act: 'bg-emerald-600 text-white border-emerald-600',
      idle: 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50',
    },
  ]

  // 中間点計算 表の 表示列 (任意で 非表示 に できる)。 SP / 距離 / X / Y の 4 列。
  // # と 削除 は 常に 表示。 計画高 / 現況高 と 断面 の 編集 は 「横断」 セクション。
  type StationCol = 'sp' | 'distance' | 'x' | 'y'
  const [visibleStationCols, setVisibleStationCols] = useState<Set<StationCol>>(
    () => new Set<StationCol>(['sp', 'distance', 'x', 'y']),
  )
  const toggleStationCol = (col: StationCol) => {
    setVisibleStationCols((prev) => {
      const next = new Set(prev)
      if (next.has(col)) next.delete(col)
      else next.add(col)
      return next
    })
  }
  const STATION_COL_DEFS: { key: StationCol; label: string }[] = [
    { key: 'sp', label: 'SP' },
    { key: 'distance', label: '距離' },
    { key: 'x', label: 'X' },
    { key: 'y', label: 'Y' },
  ]
  // 地図から 現況/出来形/計画 点を 拾う モード。null で 通常
  const [mapCaptureTarget, setMapCaptureTarget] = useState<SectionTarget | null>(null)

  /**
   * 横断幅 [m]。中心線 沿い に この 範囲に 入る 実測記録を 「その 測点の
   * 横断上の 点」と みなす。既定 0.5m (50cm)。
   */
  const [crossBandM, setCrossBandM] = useState<number>(() => {
    try {
      const v = localStorage.getItem('oc:crossBandM')
      const n = v ? parseFloat(v) : NaN
      return Number.isFinite(n) && n > 0 ? n : 0.5
    } catch {
      return 0.5
    }
  })
  useEffect(() => {
    try { localStorage.setItem('oc:crossBandM', String(crossBandM)) } catch { /* ignore */ }
  }, [crossBandM])
  /** 横断上の 実測点を 出す ための 測設記録 */
  const stakingRecords = useStakingStore((st) => st.records)
  const fetchStakingRecords = useStakingStore((st) => st.fetchRecords)
  useEffect(() => {
    if (farmId) void fetchStakingRecords(farmId)
  }, [farmId, fetchStakingRecords])

  /**
   * 実測記録に かける スライド量 (逆スライドで 設計の 土俵に 乗せる)。
   * 記録セット ごと に 持つ ので、記録 の セット の 値 を 引く。
   * セット が 無い 記録 は 工区 単位 の 値 (surveySlide) に 落ちる。
   */
  const surveySets = useSurveySetStore((st) => st.sets)
  const fetchSurveySets = useSurveySetStore((st) => st.fetchByFarm)
  useEffect(() => {
    if (farmId) void fetchSurveySets(farmId)
  }, [farmId, fetchSurveySets])
  const [surveySlide, setSurveySlide] = useState<SurveySlide>(NO_SLIDE)
  const slideOfRecord = (r: { recordSetId?: string | null }): SurveySlide => {
    if (!r.recordSetId) return surveySlide
    return surveySets.find((s) => s.id === r.recordSetId)?.slide ?? surveySlide
  }
  useEffect(() => {
    if (!farmId) {
      setSurveySlide(NO_SLIDE)
      return
    }
    let cancelled = false
    void fetchSurveySlide(farmId).then((v) => {
      if (!cancelled) setSurveySlide(v)
    })
    return () => {
      cancelled = true
    }
  }, [farmId])
  // DXF トレースモーダル (校正 + トレース)。対象 station + target を 保持
  const [dxfTraceContext, setDxfTraceContext] = useState<
    | { stationId: string; target: SectionTarget }
    | null
  >(null)

  // 線形点の追加: 座標を選択 (種別 BP/IP/EP は 位置から 自動決定)
  const [addCoordId, setAddCoordId] = useState<string>('')
  const [addRadius, setAddRadius] = useState<number>(0)

  const handleAddPoint = () => {
    if (!selected || !addCoordId) return
    const next: AlignmentPoint[] = normalizeKinds([
      ...selected.alignmentPoints,
      { coordId: addCoordId, kind: 'ip', radius: addRadius > 0 ? addRadius : undefined },
    ])
    updateChannel(selected.id, { alignmentPoints: next })
    setAddCoordId('')
  }

  // 地図でクリックした 座標を そのまま 線形点として 追加。
  // 線形点セクション が 折りたたまれて いる 時は 編集 不可 (誤操作 防止)。
  // 既登録の 座標は 何もしない (トグル 挙動は 誤操作の 元なので しない)。
  //
  // mapCaptureTarget が 'current' / 'asbuilt' の 時は 「現況/出来形 の 断面点」
  // として、選択測点 の 中心線に 垂直投影して 追加 (offset, elevation)。
  const handlePickCoordFromMap = (coordId: string) => {
    if (!selected) return

    // 現況/出来形 の 地図取得 モード
    if (mapCaptureTarget && selectedStation) {
      const coord = coordinates.find((c) => c.id === coordId)
      if (!coord) return
      if (coord.z == null) {
        alert('選択した 座標に 標高 (Z) が ありません')
        return
      }
      const center = pointAtDistance(segments, selectedStation.distance)
      const tangent = tangentAtDistance(segments, selectedStation.distance)
      if (!center || !tangent) return
      // 世界座標 (x=北, y=東)。断面「右向き」単位ベクトル perp:
      //   forward: 進行方向 (tangent) の CCW 90° = (-t.y, t.x)
      //   reverse: 反転 (河川工事 慣習)
      const sign = selected.sideOrientation === 'reverse' ? -1 : 1
      const perpX = -tangent.y * sign
      const perpY = tangent.x * sign
      const dx = coord.x - center.x
      const dy = coord.y - center.y
      // 中心線 沿い の ズレ (前後方向)。 5m 以上 ずれてたら 確認
      const along = dx * tangent.x + dy * tangent.y
      if (Math.abs(along) > 5) {
        const ok = window.confirm(
          `選択した 座標 は 中心線 から ${along.toFixed(2)}m 前後方向 に ズレています。追加しますか?`,
        )
        if (!ok) return
      }
      const offset = dx * perpX + dy * perpY
      handleAppendStationSectionPoint(selectedStation.id, mapCaptureTarget, {
        id: `mp-${coord.id}`,
        offset: Math.round(offset * 1000) / 1000,
        elevation: Math.round(coord.z * 1000) / 1000,
        note: coord.pointNumber ?? undefined,
      })
      return
    }

    // 通常: 線形点として 追加
    if (!linearPointsExpanded) return
    if (selected.alignmentPoints.some((p) => p.coordId === coordId)) return
    const next: AlignmentPoint[] = normalizeKinds([
      ...selected.alignmentPoints,
      { coordId, kind: 'ip', radius: addRadius > 0 ? addRadius : undefined },
    ])
    updateChannel(selected.id, { alignmentPoints: next })
  }

  const handleMovePoint = (idx: number, dir: -1 | 1) => {
    if (!selected) return
    const arr = selected.alignmentPoints.slice()
    const target = idx + dir
    if (target < 0 || target >= arr.length) return
    const tmp = arr[idx]
    arr[idx] = arr[target]
    arr[target] = tmp
    updateChannel(selected.id, { alignmentPoints: normalizeKinds(arr) })
  }

  const handleRemovePoint = (idx: number) => {
    if (!selected) return
    const arr = selected.alignmentPoints.filter((_, i) => i !== idx)
    updateChannel(selected.id, { alignmentPoints: normalizeKinds(arr) })
  }

  const handleChangePoint = (idx: number, patch: Partial<AlignmentPoint>) => {
    if (!selected) return
    const arr = selected.alignmentPoints.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    updateChannel(selected.id, { alignmentPoints: normalizeKinds(arr) })
  }

  // 線形物の 名前 編集 (ヘッダー の 鉛筆ボタン で 切替)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const handleStartEditName = () => {
    if (!selected) return
    setNameDraft(selected.name)
    setEditingName(true)
  }
  const handleSaveName = () => {
    if (!selected) return
    const next = nameDraft.trim()
    if (next && next !== selected.name) updateChannel(selected.id, { name: next })
    setEditingName(false)
  }
  const handleCancelEditName = () => setEditingName(false)
  // 線形物 を 切り替えたら 編集モード は 解除
  useEffect(() => {
    setEditingName(false)
  }, [selectedId])

  // 縦断線形（profile）操作 — テーブル 末尾 の 空行 に 直接 入力する 方式。
  // 数値 未確定 の 状態 も 表現できる よう 文字列 で 保持。
  const [newProfileDistText, setNewProfileDistText] = useState<string>('')
  const [newProfileHText, setNewProfileHText] = useState<string>('')

  const commitNewProfile = () => {
    if (!selected) return
    // 入力欄 は SP 値 (中間点計算 と 同じ)。内部保存は 距離 = SP - spOffset
    const sp = parseFloat(newProfileDistText)
    const h = parseFloat(newProfileHText)
    if (!Number.isFinite(sp) || !Number.isFinite(h)) return
    const d = sp - (selected.spOffset ?? 0)
    const next: ProfilePoint[] = [
      ...selected.profilePoints,
      { distance: d, floorHeight: h },
    ]
    next.sort((a, b) => a.distance - b.distance)
    updateChannel(selected.id, { profilePoints: next })
    setNewProfileDistText('')
    setNewProfileHText('')
  }

  const sortedProfile = useMemo<ProfilePoint[]>(() => {
    if (!selected) return []
    return [...selected.profilePoints].sort((a, b) => a.distance - b.distance)
  }, [selected])

  // 縦断曲線 (VCL > 0 の 中間 変化点) を PVI インデックス で 引ける Map
  const profileCurvesByPviIndex = useMemo(() => {
    const map = new Map<number, VerticalCurve>()
    for (const c of computeVerticalCurves(sortedProfile)) map.set(c.pviIndex, c)
    return map
  }, [sortedProfile])

  const handleRemoveProfile = (idx: number) => {
    if (!selected) return
    const arr = selected.profilePoints.filter((_, i) => i !== idx)
    updateChannel(selected.id, { profilePoints: arr })
  }
  const handleChangeProfile = (idx: number, patch: Partial<ProfilePoint>) => {
    if (!selected) return
    const arr = selected.profilePoints.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    arr.sort((a, b) => a.distance - b.distance)
    updateChannel(selected.id, { profilePoints: arr })
  }

  // 幅杭 (width stakes) 操作 — 縦断線形 と 同じく テーブル末尾 の 空行 で 追加。
  const [newStakeSpText, setNewStakeSpText] = useState<string>('')
  const [newStakeOffsetText, setNewStakeOffsetText] = useState<string>('')
  const [newStakeNoteText, setNewStakeNoteText] = useState<string>('')

  const newWidthStakeId = () =>
    `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  const commitNewWidthStake = () => {
    if (!selected) return
    const sp = parseFloat(newStakeSpText)
    const off = parseFloat(newStakeOffsetText)
    if (!Number.isFinite(sp) || !Number.isFinite(off)) return
    const d = sp - (selected.spOffset ?? 0)
    const stake: WidthStake = {
      id: newWidthStakeId(),
      distance: d,
      offset: off,
      note: newStakeNoteText.trim() || undefined,
    }
    const next = [...selected.widthStakes, stake].sort((a, b) => a.distance - b.distance)
    updateChannel(selected.id, { widthStakes: next })
    setNewStakeSpText('')
    setNewStakeOffsetText('')
    setNewStakeNoteText('')
  }

  const handleRemoveWidthStake = (id: string) => {
    if (!selected) return
    updateChannel(selected.id, {
      widthStakes: selected.widthStakes.filter((s) => s.id !== id),
    })
  }
  const handleChangeWidthStake = (id: string, patch: Partial<WidthStake>) => {
    if (!selected) return
    const arr = selected.widthStakes.map((s) => (s.id === id ? { ...s, ...patch } : s))
    arr.sort((a, b) => a.distance - b.distance)
    updateChannel(selected.id, { widthStakes: arr })
  }

  // BP に 割り当てる SP 値 (= 内部距離 0 の SP)。デフォルト 0。
  // 内部距離 d に対する SP 表示値 = d + spOffset。
  const spOffset = selected?.spOffset ?? 0

  // 幅杭 に 対する 平面 座標 XY を まとめて 算出。
  // 座標は 中心線 の 接線 に 対する 垂直方向 (右 が +) に offset だけ 進めた 点。
  // sideOrientation='reverse' (河川モード) の 場合 は 符号 を 反転する。
  const widthStakesWithXY = useMemo(() => {
    if (!selected || segments.length === 0) return []
    const sign = selected.sideOrientation === 'forward' ? 1 : -1
    return selected.widthStakes.map((stake) => {
      const center = pointAtDistance(segments, stake.distance)
      const tangent = tangentAtDistance(segments, stake.distance)
      if (!center || !tangent) {
        return { stake, x: null as number | null, y: null as number | null }
      }
      // (x=北, y=東) 系で 進行方向 (tx, ty) の CCW 90° = (-ty, tx) が 右
      const perpX = -tangent.y * sign
      const perpY = tangent.x * sign
      return {
        stake,
        x: center.x + stake.offset * perpX,
        y: center.y + stake.offset * perpY,
      }
    })
  }, [selected, segments])

  // 中間点計算（任意 SP / ピッチ割）— 数値は 全て SP 値 (内部距離 ではなく)
  // で 保持し、実際 の 計算時 に (SP - spOffset) で 内部距離 に 変換する。
  const [stationMode, setStationMode] = useState<'sp' | 'pitch'>('sp')
  const [stationSp, setStationSp] = useState<number>(0)
  const [stationStartSp, setStationStartSp] = useState<number>(0)
  const [stationEndSp, setStationEndSp] = useState<number>(0)
  const [stationPitch, setStationPitch] = useState<number>(20)
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null)

  // 線形物 切替時 に 中間点計算 の SP 入力 を BP..EP の SP 値 に 初期化。
  useEffect(() => {
    if (!selected) return
    setStationSp(selected.spOffset)
    setStationStartSp(selected.spOffset)
    setStationEndSp(selected.spOffset + totalLen)
    // 線形物 切替時 のみ 実行 (totalLen 変更 で 再 リセット しない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const stations: StationRow[] = selected?.stations ?? []
  const selectedStation = stations.find((s) => s.id === selectedStationId) ?? null

  /**
   * 選んでいる 測点の 横断上に ある 実測点。
   * 中心線 沿い に 横断幅 (既定 50cm) 以内の 測設記録を 逆スライド して 拾う。
   *
   * 保存はしない (DB へ 書くのは 取込ボタン)。ここは 「いま その 断面の 上に
   * 何が 測られて いるか」を 常に 見せる ための もの で、開いた だけで
   * 勝手に 保存されると 手入力の 現況を 潰しかねない。
   */
  const measuredPointsOnStation = (st: StationRow): MeasuredCrossPoint[] => {
    if (!farmId) return []
    const center = pointAtDistance(segments, st.distance)
    const tangent = tangentAtDistance(segments, st.distance)
    if (!center || !tangent) return []
    const sign = selected?.sideOrientation === 'reverse' ? -1 : 1
    const perpX = -tangent.y * sign
    const perpY = tangent.x * sign
    const out: MeasuredCrossPoint[] = []
    for (const r of stakingRecords) {
      if (r.farmId !== farmId || r.measuredZ == null) continue
      // 逆スライド: 実測 − スライド量 で 設計の 土俵に 乗せる。
      // スライド量 は 記録セット ごと に 持つ ので、その 記録 の セット の 値 を 引く。
      // セット が 無い 記録 は 工区 単位 の 値 に 落ちる。
      const sl = slideOfRecord(r)
      const x = r.measuredX - sl.dx
      const y = r.measuredY - sl.dy
      const z = r.measuredZ - sl.dz
      const dx = x - center.x
      const dy = y - center.y
      // 中心線 沿い の ずれが 横断幅 に 収まる もの だけ
      if (Math.abs(dx * tangent.x + dy * tangent.y) > crossBandM) continue
      out.push({
        id: `sr-${r.id}`,
        offset: Math.round((dx * perpX + dy * perpY) * 1000) / 1000,
        elevation: Math.round(z * 1000) / 1000,
        note: r.targetName ?? undefined,
      })
    }
    out.sort((a, b) => a.offset - b.offset)
    return out
  }

  const autoCurrentSection = useMemo<MeasuredCrossPoint[]>(() => {
    if (!selectedStation) return []
    return measuredPointsOnStation(selectedStation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStation, farmId, segments, selected?.sideOrientation, stakingRecords, surveySlide, surveySets, crossBandM])

  /**
   * 「横断 > 現況」 の 表 に 出す、測点 ごと の 「その 断面 の 上 に ある 実測点」 の 数。
   * 取込 ボタン を 押す 価値 が ある 測点 が どれ か を 先 に 見せる ため。
   * 現況 タブ 以外 では 数えない (記録 × 測点 の 総当たり な ので)。
   */
  const measuredCountByStation = useMemo(() => {
    const m = new Map<string, number>()
    if (editTarget !== 'current') return m
    for (const st of stations) m.set(st.id, measuredPointsOnStation(st).length)
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTarget, stations, farmId, segments, selected?.sideOrientation, stakingRecords, surveySlide, surveySets, crossBandM])

  /** 直近 の 取込 結果 (「横断 > 現況」 の 表 の 下 に 出す) */
  const [stationImportMsg, setStationImportMsg] = useState<string | null>(null)

  /** 横断 の 表 を 管理測点 だけ に 絞る */
  const [controlOnly, setControlOnly] = useState<boolean>(() => {
    try {
      return localStorage.getItem('oc:controlOnly') === '1'
    } catch {
      return false
    }
  })
  const toggleControlOnly = () => {
    setControlOnly((prev) => {
      const next = !prev
      try {
        localStorage.setItem('oc:controlOnly', next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }
  /** 管理測点 フラグ の 切替 */
  const handleToggleControlStation = (id: string) => {
    setStations(
      stations.map((s) => (s.id === id ? { ...s, isControlStation: !s.isControlStation } : s)),
    )
  }
  const controlStationCount = stations.filter((s) => s.isControlStation).length

  /**
   * 1 測点 分 の 現況 を 実測記録 から 取込む。
   * 一括 では なく 行 ごと に 押す 形 に して いる のは、手入力 済み の 現況 を
   * まとめて 潰さない ため。 中心高 (currentGroundHeight) は 取込 内容 から 補間。
   */
  const handleImportStationCurrent = (st: StationRow) => {
    const pts = measuredPointsOnStation(st)
    if (pts.length === 0) {
      setStationImportMsg(
        `${st.label}: 横断幅 ${crossBandM} m 以内 に 実測点 が 見つかり ません`,
      )
      return
    }
    handleReplaceStationSection(st.id, 'current', pts)
    setStationImportMsg(`${st.label}: 実測記録 から ${pts.length} 点 を 取込みました`)
  }

  // 「横断を 切替中は 図面の 断面方向 (左右=画面 左右) が 水平に なる ように 地図を 回転」
  // する 用の bearing (度)。 CoordinateMap の mapBearingDeg (setBearing 経由) に 渡す。
  //   世界座標: x=北 / y=東 (JGD 平面直角)
  //   選択測点の 接線 (t.x, t.y) を 画面上向きに 揃える compass bearing = atan2(t.y, t.x)
  //   leaflet-rotate の setBearing は 反時計回り 正 なので 符号 反転。
  //   選択測点 なし (=標準断面 モード) は 0 (北向き) に 戻す。
  //
  // 河川工事 (sideOrientation='reverse') の 場合、「左右」は EP→BP 方向を 見て
  // 定義される (下流を 向いて 左岸/右岸)。 通常の tangent-up は BP→EP を 見る 向き
  // なので、この モードでは 180° 足して 反対向き (EP→BP を 画面上に) にする。
  const mapBearingDeg = useMemo(() => {
    if (!selectedStation) return 0
    const t = tangentAtDistance(segments, selectedStation.distance)
    if (!t) return 0
    const base = -Math.atan2(t.y, t.x) * (180 / Math.PI)
    return selected?.sideOrientation === 'reverse' ? base + 180 : base
  }, [selectedStation, segments, selected?.sideOrientation])

  // 選択中の 測点の 地図上 位置 (LatLng)。 StationFocus に 渡して
  // その 点を 中央に パン+拡大 させる。 選択なし は null (地図は 触らない)。
  const selectedStationLatLng = useMemo<[number, number] | null>(() => {
    if (!selectedStation) return null
    const p = pointAtDistance(segments, selectedStation.distance)
    if (!p) return null
    const ll = converter.toLatLng(p.x, p.y)
    return [ll.lat, ll.lng]
  }, [selectedStation, segments, converter])

  // 測点を 選択 したら 常に 横断図 タブ に 自動切替 + パネル 展開。
  // (行 click / ◀手前 / 次▶ / 「計画」ボタン 経由 いずれ でも 統一動作)
  useEffect(() => {
    if (!selectedStationId) return
    setBottomTab('crossSection')
    setProfileChartExpanded(true)
  }, [selectedStationId])

  // 内部距離 (BP からの 累積) を 受け取り、SP 表示付き の ラベル を 返す。
  const formatSp = (d: number) => `SP${(d + spOffset).toFixed(2)}`
  const formatBc = (d: number) => `BC${(d + spOffset).toFixed(2)}`
  const formatEc = (d: number) => `EC${(d + spOffset).toFixed(2)}`
  const formatBtc = (d: number) => `BTC${(d + spOffset).toFixed(2)}`
  const formatEtc = (d: number) => `ETC${(d + spOffset).toFixed(2)}`
  const formatIp = (d: number) => `IP${(d + spOffset).toFixed(2)}`

  // getCurveMarkers が 返す 6 種類の マーカー を、ユーザー が 見慣れた
  // ラベル に 変換する。 単曲線 の 両端は BC/EC、緩和曲線 の 外側端は
  // BTC/ETC (Beginning/End of Transition Curve)、緩和曲線 内側 (arc と の 接続) は
  // BC/EC (arc の 起終点 として 扱う)。
  const formatCurveMarker = (kind: CurveMarker['kind'], distance: number): string => {
    switch (kind) {
      case 'bc':
        return formatBc(distance)
      case 'ec':
        return formatEc(distance)
      case 'ts':
        return formatBtc(distance)
      case 'st':
        return formatEtc(distance)
      case 'sc':
        return formatBc(distance)
      case 'cs':
        return formatEc(distance)
    }
  }

  const newStationId = () =>
    `st-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const newElementId = () =>
    `e${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  const cloneCrossSection = (cs: StandardCrossSection): StandardCrossSection => ({
    right: cs.right.map((e) => ({ ...e, id: newElementId() })),
    left: cs.left.map((e) => ({ ...e, id: newElementId() })),
  })

  const setStations = (next: StationRow[]) => {
    if (!selected) return
    updateChannel(selected.id, { stations: next })
  }

  // 「特徴点」= IP (折点) / BC / EC / BTC / ETC の 集合。線形形状から 一意に決まる。
  const isFeatureLabel = (label: string) =>
    label.startsWith('IP') ||
    label.startsWith('BTC') ||
    label.startsWith('ETC') ||
    label.startsWith('BC') ||
    label.startsWith('EC')

  const collectFeaturePoints = (): { label: string; distance: number }[] => {
    const out: { label: string; distance: number }[] = []
    for (const m of getCurveMarkers(segments)) {
      out.push({ label: formatCurveMarker(m.kind, m.distance), distance: m.distance })
    }
    for (const m of getCornerIpStations(alignmentXY)) {
      out.push({ label: formatIp(m.distance), distance: m.distance })
    }
    return out
  }

  // 距離でソート + 同距離 (5mm 以内) を 特徴点 優先で 重複排除。
  const dedupeStations = (arr: StationRow[]): StationRow[] => {
    const sorted = [...arr].sort((a, b) => a.distance - b.distance)
    const merged: StationRow[] = []
    for (const s of sorted) {
      const prev = merged[merged.length - 1]
      if (prev && Math.abs(prev.distance - s.distance) < 5e-3) {
        if (isFeatureLabel(s.label) && !isFeatureLabel(prev.label)) {
          merged[merged.length - 1] = s
        }
        continue
      }
      merged.push(s)
    }
    return merged
  }

  const handleAddStation = () => {
    if (!selected || segments.length === 0) return
    // 線形物 の 有効 SP 範囲 = [spOffset, spOffset + totalLen]
    const minSp = spOffset
    const maxSp = spOffset + totalLen
    if (stationMode === 'sp') {
      // 任意 SP: 1 点だけ 追加。範囲外 は クランプ。
      const sp = Math.max(minSp, Math.min(stationSp, maxSp))
      const d = sp - spOffset
      const newRow: StationRow = {
        id: newStationId(),
        label: formatSp(d),
        distance: d,
        crossSection: null,
      }
      const next = [...stations, newRow].sort((a, b) => a.distance - b.distance)
      setStations(next)
    } else {
      // ピッチ割: 指定 SP 範囲 [startSp, endSp] を pitch 毎 に 生成。
      const pitch = stationPitch
      if (!Number.isFinite(pitch) || pitch <= 0) return
      // 範囲を 有効 SP 範囲 に クランプ
      const startSp = Math.max(minSp, Math.min(stationStartSp, maxSp))
      const endSp = Math.max(minSp, Math.min(stationEndSp, maxSp))
      if (endSp < startSp - 1e-6) return

      const out: StationRow[] = []
      const push = (label: string, distance: number) =>
        out.push({ id: newStationId(), label, distance, crossSection: null })

      let sp = startSp
      while (sp <= endSp + 1e-6) {
        const d = Math.min(sp, endSp) - spOffset
        push(formatSp(d), d)
        sp += pitch
      }
      // 範囲末端 が pitch で 割り切れない 場合は 明示的に 末端 も 追加
      const lastAdded = out.length > 0 ? out[out.length - 1].distance : -1
      const endDist = endSp - spOffset
      if (Math.abs(lastAdded - endDist) > 1e-3) {
        push(formatSp(endDist), endDist)
      }
      // 特徴点 (IP / BC / EC / BTC / ETC) を 範囲内 だけ 追加
      for (const f of collectFeaturePoints()) {
        const sp = f.distance + spOffset
        if (sp < startSp - 1e-6 || sp > endSp + 1e-6) continue
        push(f.label, f.distance)
      }

      const merged = dedupeStations(out)

      // 既存の個別断面（crossSection != null）をラベル一致で引き継ぐ
      const existingByLabel = new Map(stations.map((s) => [s.label, s]))
      const final = merged.map((s) => {
        const ex = existingByLabel.get(s.label)
        if (ex && ex.crossSection) return { ...s, id: ex.id, crossSection: ex.crossSection }
        return s
      })
      // 既存 の 中間点 は 上書き ではなく、範囲外 の 分 は 保持する。
      const preserved = stations.filter((s) => {
        const sp = s.distance + spOffset
        return sp < startSp - 1e-6 || sp > endSp + 1e-6
      })
      setStations(dedupeStations([...preserved, ...final]))
    }
  }

  // 現状の 中間点 リストに、線形形状 から 一意に決まる 特徴点 (IP / BC / EC /
  // BTC / ETC) を 追記する。既存 SP は 保持。同じ 追加距離 が 既に あれば
  // 特徴点ラベル で 置き換える。
  const handleAddFeaturePoints = () => {
    if (!selected || segments.length === 0) return
    const features = collectFeaturePoints()
    if (features.length === 0) return
    const featureRows: StationRow[] = features.map((f) => ({
      id: newStationId(),
      label: f.label,
      distance: f.distance,
      crossSection: null,
    }))
    setStations(dedupeStations([...stations, ...featureRows]))
  }

  const handleClearStations = () => {
    setStations([])
    setSelectedStationId(null)
  }
  const handleRemoveStation = (id: string) => {
    setStations(stations.filter((s) => s.id !== id))
    if (selectedStationId === id) setSelectedStationId(null)
  }
  /**
   * 個別断面 (element ベース) を セット + plannedSectionRaw (点列) にも 同期。
   * 対話型 エディタ と DXF トレース を 同じ 「横断計画」として 扱う ため、常に
   * 両フィールドを 揃える。 null (標準に戻す) は 両方 クリア。
   * centerHeight が 取れない (縦断 情報なし) ケースは 0 を 基準に 保存し、
   * 再表示側で centerHeight を 引いて 相対 高さで 描画する ので 形状 は 崩れない。
   */
  const handleUpdateStationCrossSection = (
    id: string,
    crossSection: StandardCrossSection | null,
  ) => {
    const target = stations.find((s) => s.id === id)
    if (!target) return
    const centerZ =
      target.plannedCenterHeight ??
      interpolateProfileZOrNull(selected?.profilePoints ?? [], target.distance) ??
      0
    const nextPoints =
      crossSection == null
        ? null
        : standardCsToMeasuredPoints(crossSection, centerZ)
    setStations(
      stations.map((s) =>
        s.id === id
          ? { ...s, crossSection, plannedSectionRaw: nextPoints }
          : s,
      ),
    )
  }
  /** 現況高 (中心線上の 地盤高) の 手入力を 保存。空文字 / NaN は null に。 */
  /**
   * 「横断」 セクション の 「編集」。 測点 と 編集対象 を 選び、右下 の 横断図 を 開く。
   * 計画 は 個別断面 が 無ければ 標準断面 を 複製 して から 開く (旧 「計画」 ボタン と 同じ)。
   */
  const openStationSection = (s: StationRow, t: EditTarget) => {
    setSelectedStationId(s.id)
    setEditTarget(t)
    if (t === 'plan') {
      const hasOverride = s.crossSection || (s.plannedSectionRaw?.length ?? 0) > 0
      if (!hasOverride && selected) {
        handleUpdateStationCrossSection(s.id, cloneCrossSection(selected.standardCrossSection))
      }
    }
    setBottomTab('crossSection')
    if (!profileChartExpanded) toggleProfileChart()
  }

  const handleUpdateStationCurrentHeight = (id: string, raw: string) => {
    const trimmed = raw.trim()
    const parsed = trimmed === '' ? null : Number(trimmed)
    const value = parsed !== null && Number.isFinite(parsed) ? parsed : null
    setStations(
      stations.map((s) => (s.id === id ? { ...s, currentGroundHeight: value } : s)),
    )
  }
  /**
   * 現況断面 の 点列 から 中心 (offset=0) の 標高を 線形補間 で 求める。
   * - 0 が 点と 一致: その点の elevation
   * - 0 が 2 点間に 挟まれる: 隣接 2 点で 直線補間
   * - 0 が 範囲外 (全点 が 片側): 外挿しない → null (currentGroundHeight は 触らない)
   * - 点が 空 / 1 点かつ offset != 0: null
   */
  const interpolateSectionAtCenter = (points: MeasuredCrossPoint[]): number | null => {
    if (points.length === 0) return null
    const sorted = [...points].sort((a, b) => a.offset - b.offset)
    // 完全一致
    const exact = sorted.find((p) => Math.abs(p.offset) < 1e-6)
    if (exact) return exact.elevation
    // 中心 0 を 挟む 2 点を 探す
    for (let i = 1; i < sorted.length; i++) {
      const a = sorted[i - 1]
      const b = sorted[i]
      if (a.offset < 0 && b.offset > 0) {
        const t = (0 - a.offset) / (b.offset - a.offset)
        return a.elevation + (b.elevation - a.elevation) * t
      }
    }
    // 中心が 範囲外
    return null
  }

  /**
   * 現況/計画 断面 の 更新に 合わせて、中心 (offset=0) の 補間値を 特定フィールド
   * (currentGroundHeight / plannedCenterHeight) に 自動同期する ヘルパ。
   *   - 新 点列 が 空 → フィールド = null (リセット)
   *   - 中心を 補間できる → その値を セット
   *   - 補間できない (全点が 片側) → フィールドは 触らない (旧値保持)
   */
  const applyCenterHeightFromSection = (
    stationsArr: StationRow[],
    id: string,
    newPoints: MeasuredCrossPoint[],
    field: 'currentGroundHeight' | 'plannedCenterHeight',
  ): StationRow[] => {
    return stationsArr.map((s) => {
      if (s.id !== id) return s
      if (newPoints.length === 0) {
        return { ...s, [field]: null }
      }
      const interp = interpolateSectionAtCenter(newPoints)
      if (interp == null) return s
      return { ...s, [field]: Math.round(interp * 1000) / 1000 }
    })
  }

  const sectionKeyOf = (t: SectionTarget) =>
    t === 'current' ? 'currentSection' : t === 'asbuilt' ? 'asbuiltSection' : 'plannedSectionRaw'

  /**
   * 現況/出来形/計画 (トレース由来) 断面 の 点列 を 差替 (モーダル 保存 用)。
   * 入力順を そのまま 保存 (オーバーハングで 水平距離が 逆行する ケースを 潰さない)。
   * 中心 (offset=0) の 補間は interpolateSectionAtCenter が 内部で ソートして 使う。
   *   target='current' → currentGroundHeight を 中心補間値で 自動更新
   *   target='planned' → plannedCenterHeight を 中心補間値で 自動更新
   */
  const replaceSectionIn = (
    list: StationRow[],
    id: string,
    target: SectionTarget,
    points: MeasuredCrossPoint[],
  ): StationRow[] => {
    const key = sectionKeyOf(target)
    const kept = points.map((p) => ({ ...p }))
    let next = list.map((s) => (s.id === id ? { ...s, [key]: kept } : s))
    if (target === 'current') {
      next = applyCenterHeightFromSection(next, id, kept, 'currentGroundHeight')
    } else if (target === 'planned') {
      next = applyCenterHeightFromSection(next, id, kept, 'plannedCenterHeight')
      // plannedSectionRaw (点列) の 更新に 合わせて 個別断面 (element ベース) も 同期。
      // 対話型 エディタ 上 で 同じ 「横断計画」 として 表示 / 編集 する ため。
      // 空 (クリア) は crossSection も null に する。
      next = next.map((s) => {
        if (s.id !== id) return s
        if (kept.length === 0) return { ...s, crossSection: null }
        const centerZ =
          s.plannedCenterHeight ??
          interpolateProfileZOrNull(selected?.profilePoints ?? [], s.distance) ??
          0
        return { ...s, crossSection: measuredPointsToStandardCs(kept, centerZ) }
      })
    }
    return next
  }

  const handleReplaceStationSection = (
    id: string,
    target: SectionTarget,
    points: MeasuredCrossPoint[],
  ) => {
    setStations(replaceSectionIn(stations, id, target, points))
  }

  /**
   * 複数 測点 を 一度 に 差替 (LandXML 取込 用)。 1 件 ずつ
   * handleReplaceStationSection を 呼ぶ と 最後 の 1 件 しか 残らない ので、
   * 同じ ロジック を リスト 上 で 畳み込む。
   */
  const handleReplaceStationSectionsBulk = (
    target: SectionTarget,
    rows: { id: string; points: MeasuredCrossPoint[] }[],
  ) => {
    let next = stations
    for (const r of rows) next = replaceSectionIn(next, r.id, target, r.points)
    setStations(next)
  }
  /**
   * 現況/出来形/計画 断面 に 点を 1 個 追加 (地図ピック / DXFトレース 用)。
   * 同じ id が あれば 上書き (位置は 元の 位置に 保持)。 新規は 末尾 に 追加。
   * 入力順を 保存 (オーバーハング等で 水平順に ならなくても そのまま)。
   */
  const handleAppendStationSectionPoint = (
    id: string,
    target: SectionTarget,
    point: MeasuredCrossPoint,
  ) => {
    const key = sectionKeyOf(target)
    let appendedPoints: MeasuredCrossPoint[] = []
    let next = stations.map((s) => {
      if (s.id !== id) return s
      const existing = (s[key] ?? []) as MeasuredCrossPoint[]
      // 同じ id が 既に あれば 上書き (位置維持)、無ければ 末尾追加。
      const foundIdx = existing.findIndex((p) => p.id === point.id)
      const merged =
        foundIdx >= 0
          ? existing.map((p, i) => (i === foundIdx ? point : p))
          : [...existing, point]
      appendedPoints = merged
      return { ...s, [key]: merged }
    })
    if (target === 'current') {
      next = applyCenterHeightFromSection(next, id, appendedPoints, 'currentGroundHeight')
    } else if (target === 'planned') {
      next = applyCenterHeightFromSection(next, id, appendedPoints, 'plannedCenterHeight')
    }
    setStations(next)
  }
  /** 校正情報 (dxfCalibration) を セット。 */
  const handleUpdateStationCalibration = (id: string, calib: DxfCalibration | null) => {
    setStations(stations.map((s) => (s.id === id ? { ...s, dxfCalibration: calib } : s)))
  }

  // 線形物を切り替えたら中間点選択をリセット
  useEffect(() => {
    setSelectedStationId(null)
  }, [selectedId])

  // 地図上の断面オーバーレイ表示モード
  type OverlayMode = 'none' | 'selected' | 'all'
  const [overlayMode, setOverlayMode] = useState<OverlayMode>('all')

  // 各中間点の断面を平面に投影した頂点列をまとめて算出
  const stationVertexLists = useMemo(() => {
    if (!selected) return [] as { station: StationRow; vertices: StationVertex[] }[]
    return stations.map((s) => ({
      station: s,
      vertices: computeStationVertices(
        s,
        selected.standardCrossSection,
        selected.profilePoints,
        segments,
        selected.sideOrientation,
      ),
    }))
  }, [selected, stations, segments])

  // 表示対象を overlayMode で絞り込む
  const visibleStationVertices = useMemo(() => {
    if (overlayMode === 'none') return []
    if (overlayMode === 'selected')
      return stationVertexLists.filter((s) => s.station.id === selectedStationId)
    return stationVertexLists
  }, [stationVertexLists, overlayMode, selectedStationId])

  // ---- エクスポート ----

  /**
   * 各測点の断面頂点から TIN サーフェスを構築する。
   *
   * 断面ごとの頂点並び: [CL, R1, R2, ..., R_nR, L1, L2, ..., L_nL]
   * 隣接する 2 測点の同じ要素番号 k のセル（CL→R1→R2... または CL→L1→L2...）を四角形 → 2 三角形に分割する。
   * 個別断面で要素数が異なる測点間では、共通する分（min）までで打ち切る。
   *
   * 三角形の巻き向きは外積で判定し、平面 (x=北, y=東) の math-CCW 側を選ぶ
   * （LandXML エクスポータ側で b/c を入替して上空視点 CCW に揃える）。
   */
  const stationTin = useMemo<TinSurface | null>(() => {
    if (!selected) return null
    const sorted = stationVertexLists
      .filter((s) => s.vertices.length > 0)
      .sort((a, b) => a.station.distance - b.station.distance)
    if (sorted.length < 2) return null

    const points: TinPoint[] = []
    const stationPointIdx: number[][] = []
    for (const sv of sorted) {
      const idxs: number[] = []
      for (const v of sv.vertices) {
        idxs.push(points.length)
        points.push({ x: v.x, y: v.y, z: v.z, source: 'plan' })
      }
      stationPointIdx.push(idxs)
    }

    const triangles: TinTriangle[] = []
    const emitQuad = (iA: number, iA1: number, iB: number, iB1: number) => {
      if (iA === iA1 || iB === iB1) return
      const A = points[iA]
      const A1 = points[iA1]
      const B1 = points[iB1]
      const cross = (A1.x - A.x) * (B1.y - A.y) - (A1.y - A.y) * (B1.x - A.x)
      if (cross >= 0) {
        triangles.push({ a: iA, b: iA1, c: iB1 })
        triangles.push({ a: iA, b: iB1, c: iB })
      } else {
        triangles.push({ a: iA, b: iB1, c: iA1 })
        triangles.push({ a: iA, b: iB, c: iB1 })
      }
    }

    const csOf = (st: StationRow) =>
      st.crossSection ?? selected.standardCrossSection

    for (let s = 0; s < sorted.length - 1; s++) {
      const A = sorted[s]
      const B = sorted[s + 1]
      const aR = csOf(A.station).right.length
      const bR = csOf(B.station).right.length
      const aL = csOf(A.station).left.length
      const bL = csOf(B.station).left.length

      // Right strip: CL→R1→...→R_min(aR,bR)
      const nR = Math.min(aR, bR)
      for (let k = 0; k < nR; k++) {
        emitQuad(
          stationPointIdx[s][k],
          stationPointIdx[s][k + 1],
          stationPointIdx[s + 1][k],
          stationPointIdx[s + 1][k + 1],
        )
      }

      // Left strip: CL→L1→L2→...
      // 頂点並び [CL, R..., L...] のため L_i は index 1+aR+i-1 = aR+i (i は 1 始まり)
      const nL = Math.min(aL, bL)
      for (let k = 0; k < nL; k++) {
        const iA = k === 0 ? stationPointIdx[s][0] : stationPointIdx[s][aR + k]
        const iA1 = stationPointIdx[s][aR + k + 1]
        const iB = k === 0 ? stationPointIdx[s + 1][0] : stationPointIdx[s + 1][bR + k]
        const iB1 = stationPointIdx[s + 1][bR + k + 1]
        emitQuad(iA, iA1, iB, iB1)
      }
    }

    const zs = points.map((p) => p.z)
    return {
      points,
      triangles,
      stats: {
        pointCount: points.length,
        triangleCount: triangles.length,
        zMin: zs.length > 0 ? Math.min(...zs) : 0,
        zMax: zs.length > 0 ? Math.max(...zs) : 0,
      },
    }
  }, [selected, stationVertexLists])

  const handleExportSima = () => {
    if (!selected || stationVertexLists.length === 0) return
    const sorted = [...stationVertexLists].sort(
      (a, b) => a.station.distance - b.station.distance,
    )
    const points: SimaExportPoint[] = []
    for (const sv of sorted) {
      for (const v of sv.vertices) {
        points.push({
          pointNumber: `${sv.station.label}_${v.label}`,
          x: v.x,
          y: v.y,
          z: v.z,
        })
      }
    }
    if (points.length === 0) return
    const safeName = selected.name.replace(/[^\w\-_]/g, '_')
    downloadSimaFile(
      { projectName: selected.name, zone, points },
      `${safeName}_sections.sim`,
    )
  }

  // openChannel の AlignmentSegment を LandXML の AlignmentSegment 配列に変換
  const buildLandXmlAlignment = (): LandXmlAlignment | null => {
    if (!selected || segments.length === 0) return null
    const out: LandXmlAlignmentSegment[] = []
    for (const s of segments) {
      if (s.kind === 'line') {
        out.push({
          type: 'line',
          startX: s.p0.x,
          startY: s.p0.y,
          endX: s.p1.x,
          endY: s.p1.y,
          length: s.length,
        })
      } else if (s.kind === 'arc') {
        const startX = s.center.x + s.radius * Math.cos(s.a0)
        const startY = s.center.y + s.radius * Math.sin(s.a0)
        const endA = s.a0 + s.dA
        const endX = s.center.x + s.radius * Math.cos(endA)
        const endY = s.center.y + s.radius * Math.sin(endA)
        out.push({
          type: 'curve',
          startX,
          startY,
          endX,
          endY,
          length: s.length,
          centerX: s.center.x,
          centerY: s.center.y,
          radius: s.radius,
          rotation: s.dA >= 0 ? 'ccw' : 'cw',
        })
      } else {
        // spiral
        const R = (s.A * s.A) / s.length // L = A²/R → R = A²/L
        const startRadius = s.direction === 'in' ? null : R
        const endRadius = s.direction === 'in' ? R : null
        // 終点を計算（局所座標 → ワールド変換）
        const local =
          s.direction === 'in'
            ? clothoidPoint(s.length, s.A)
            : clothoidPointOut(s.length, s.A, s.length)
        const tx = s.tangent0.x
        const ty = s.tangent0.y
        const nxL = -ty
        const nyL = tx
        const yL = s.rotSign * local.y
        const endX = s.p0.x + tx * local.x + nxL * yL
        const endY = s.p0.y + ty * local.x + nyL * yL
        out.push({
          type: 'spiral',
          startX: s.p0.x,
          startY: s.p0.y,
          endX,
          endY,
          length: s.length,
          spiralType: 'clothoid',
          startRadius,
          endRadius,
          spiralA: s.A,
        })
      }
    }
    return {
      id: selected.id,
      name: selected.name,
      staStart: 0,
      totalLength: totalLen,
      segments: out,
    }
  }

  const handleExportLandXml = () => {
    if (!selected || !stationTin) return
    const lAlign = buildLandXmlAlignment()
    const xml = buildLandXml({
      alignments: lAlign ? [lAlign] : [],
      surfaces: [{ name: selected.name, surface: stationTin }],
      projectName: selected.name,
      coordinateZoneName: `JGD2011 zone ${zone}`,
    })
    const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const safeName = selected.name.replace(/[^\w\-_]/g, '_')
    a.href = url
    a.download = `${safeName}_surface.xml`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">工区を選択してください</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 flex overflow-hidden">
        {/* 左: 一覧 + 編集 */}
        <div className="w-[624px] overflow-auto p-3 bg-slate-50 border-r space-y-3">
          {/* 路線線形 (BP → IP → EP) — 一番上、折りたたみ 可能。
              折りたたみ 中は 地図クリック による 追加が 抑止 される。 */}
          <CollapsibleSection
            title={`路線線形${selected ? ` · ${selected.name}` : ''}`}
            storageKey="oc:section:linear-points"
            defaultOpen
            onOpenChange={setLinearPointsExpanded}
          >
            {/* 線形物 の 選択プルダウン + 名前編集 + 新規追加 + 削除 */}
            <div className="flex items-center gap-1">
              {editingName && selected ? (
                <>
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveName()
                      if (e.key === 'Escape') handleCancelEditName()
                    }}
                    className="flex-1 min-w-0 px-2 py-1 border rounded text-sm"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveName}
                    title="保存"
                    className="shrink-0 p-1 border rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={handleCancelEditName}
                    title="キャンセル"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </>
              ) : (
                <>
                  <select
                    value={selectedId ?? ''}
                    onChange={(e) => setSelectedId(e.target.value || null)}
                    className="flex-1 min-w-0 px-2 py-1 border rounded text-sm"
                  >
                    {channels.length === 0 && (
                      <option value="">（線形物なし）</option>
                    )}
                    {channels.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={handleStartEditName}
                    disabled={!selected}
                    title="名前を編集"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50 disabled:opacity-30"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => farmId && addChannel(farmId)}
                    title="新規追加"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (!selected) return
                      if (window.confirm(`「${selected.name}」を削除しますか？`)) deleteChannel(selected.id)
                    }}
                    disabled={!selected}
                    title="この線形物を削除"
                    className="shrink-0 p-1 border rounded text-red-600 hover:bg-red-50 disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>

            {selected && (
              <>
                {/* 左右の基準方向 */}
                <div className="flex gap-1">
                  <button
                    onClick={() => updateChannel(selected.id, { sideOrientation: 'forward' })}
                    className={`flex-1 px-2 py-1 text-[11px] border rounded ${
                      selected.sideOrientation === 'forward'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    起点→終点を見て（道路）
                  </button>
                  <button
                    onClick={() => updateChannel(selected.id, { sideOrientation: 'reverse' })}
                    className={`flex-1 px-2 py-1 text-[11px] border rounded ${
                      selected.sideOrientation === 'reverse'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    終点→起点を見て（河川）
                  </button>
                </div>

                {/* 先頭測点 (BP) の SP オフセット。 路線 の 途中 から 始まる
                    線形物 (例: BP を SP 224.69 に 設定) で 使う。 デフォルト 0。 */}
                <div className="flex items-center gap-2 text-xs border rounded bg-blue-50/50 border-blue-200 px-2 py-1.5">
                  <span className="font-semibold text-slate-700">開始距離 SP</span>
                  <input
                    type="number"
                    step={0.01}
                    value={selected.spOffset}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value)
                      if (Number.isFinite(v))
                        updateChannel(selected.id, { spOffset: v })
                    }}
                    className="w-24 px-2 py-1 border rounded text-right text-sm"
                  />
                  <span className="text-slate-500 text-[11px]">
                    (= BP の SP 値。路線途中から IP を 入力する とき に 設定)
                  </span>
                </div>

                {/* 線形点テーブル (種別 は 位置から 自動決定: 先頭=BP、末尾=EP、中間=IP) */}
                {selected.alignmentPoints.length > 0 ? (
                  <div className="border rounded overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 text-slate-600 text-xs">
                        <tr>
                          <th className="px-2 py-1 w-12 text-center">種別</th>
                          <th className="px-2 py-1 w-20 text-left">点名</th>
                          <th className="px-2 py-1 w-20 text-right">R (m)</th>
                          <th
                            className="px-2 py-1 w-16 text-right"
                            title="クロソイドパラメータ A（IN 側）。L=A²/R で緩和曲線長を決定"
                          >
                            A<sub>IN</sub>
                          </th>
                          <th
                            className="px-2 py-1 w-16 text-right"
                            title="クロソイドパラメータ A（OUT 側）"
                          >
                            A<sub>OUT</sub>
                          </th>
                          <th className="px-2 py-1 w-16"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {selected.alignmentPoints.map((p, i) => {
                          const c = coordinates.find((cc) => cc.id === p.coordId)
                          const kind = inferKindByIndex(i, selected.alignmentPoints.length)
                          const kindLabel =
                            kind === 'bp' ? 'BP' : kind === 'ep' ? 'EP' : 'IP'
                          const kindColor =
                            kind === 'bp'
                              ? 'bg-green-100 text-green-700'
                              : kind === 'ep'
                                ? 'bg-red-100 text-red-700'
                                : 'bg-amber-100 text-amber-700'
                          return (
                            <tr key={i} className="border-t">
                              <td className="px-2 py-1 text-center">
                                <span
                                  className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold font-mono ${kindColor}`}
                                >
                                  {kindLabel}
                                </span>
                              </td>
                              <td className="px-2 py-1 truncate" title={c?.pointNumber ?? '？'}>
                                {c?.pointNumber ?? '？'}
                              </td>
                              <td className="px-2 py-1 text-right">
                                {kind === 'ip' ? (
                                  <input
                                    type="number"
                                    step={0.5}
                                    value={p.radius ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, { radius: Number.isFinite(v) && v > 0 ? v : undefined })
                                    }}
                                    className="w-16 px-1 py-0.5 border rounded text-right text-sm"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              {/* A_IN */}
                              <td className="px-2 py-1 text-right">
                                {kind === 'ip' && p.radius && p.radius > 0 ? (
                                  <input
                                    type="number"
                                    step={1}
                                    min={0}
                                    value={p.spiralAIn ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, {
                                        spiralAIn: Number.isFinite(v) && v > 0 ? v : undefined,
                                      })
                                    }}
                                    className="w-14 px-1 py-0.5 border rounded text-right text-sm"
                                    placeholder="0"
                                    title="0/空で緩和曲線なし"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              {/* A_OUT */}
                              <td className="px-2 py-1 text-right">
                                {kind === 'ip' && p.radius && p.radius > 0 ? (
                                  <input
                                    type="number"
                                    step={1}
                                    min={0}
                                    value={p.spiralAOut ?? 0}
                                    onChange={(e) => {
                                      const v = parseFloat(e.target.value)
                                      handleChangePoint(i, {
                                        spiralAOut: Number.isFinite(v) && v > 0 ? v : undefined,
                                      })
                                    }}
                                    className="w-14 px-1 py-0.5 border rounded text-right text-sm"
                                    placeholder="0"
                                    title="0/空で緩和曲線なし"
                                  />
                                ) : (
                                  <span className="text-slate-300">—</span>
                                )}
                              </td>
                              <td className="px-2 py-1 text-right">
                                <div className="flex gap-0.5 justify-end">
                                  <button
                                    onClick={() => handleMovePoint(i, -1)}
                                    disabled={i === 0}
                                    className="p-0.5 border rounded hover:bg-slate-50 disabled:opacity-30"
                                  >
                                    <ArrowUp className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => handleMovePoint(i, 1)}
                                    disabled={i === selected.alignmentPoints.length - 1}
                                    className="p-0.5 border rounded hover:bg-slate-50 disabled:opacity-30"
                                  >
                                    <ArrowDown className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() => handleRemovePoint(i)}
                                    className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-xs text-slate-400 text-center py-2 border rounded bg-slate-50">
                    線形点がありません。下のフォーム or 地図上の座標クリックで追加。
                  </div>
                )}

                {/* 末尾に 追加する インライン フォーム
                    (種別 は 位置から 自動決定: 先頭=BP、末尾=EP、中間=IP) */}
                <div className="grid grid-cols-12 gap-2 items-end pt-2 border-t">
                  <select
                    value={addCoordId}
                    onChange={(e) => setAddCoordId(e.target.value)}
                    className="col-span-8 px-2 py-1 border rounded text-sm"
                  >
                    <option value="">座標を選択…</option>
                    {(coordinates as CoordinateRow[]).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pointNumber}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    step={0.5}
                    value={addRadius}
                    onChange={(e) => setAddRadius(parseFloat(e.target.value) || 0)}
                    placeholder="R (IP用)"
                    title="IP になった 場合の 曲線半径 R (0=角折れ)"
                    className="col-span-2 px-2 py-1 border rounded text-sm text-right"
                  />
                  <button
                    onClick={handleAddPoint}
                    disabled={!addCoordId}
                    className="col-span-2 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    追加
                  </button>
                </div>
                <div className="text-xs text-slate-400">
                  💡 地図上の 座標を クリックしても 末尾に 追加できます
                  (既登録は スカイブルー ハロー で 強調)。
                </div>

                {/* 線形長 (以前の 独立セクションを ここに 統合) */}
                <div className="text-xs text-slate-500 pt-1 border-t">
                  線形長:{' '}
                  <span className="font-mono tabular-nums text-slate-700 text-sm">
                    {totalLen.toFixed(2)} m
                  </span>
                  <span className="text-[11px] text-slate-400 ml-2">
                    (直線・単曲線・クロソイド, L = A²/R)
                  </span>
                </div>
              </>
            )}
          </CollapsibleSection>

          {selected && (
            <>

              {/* 中間点計算 */}
              <CollapsibleSection title="中間点計算" storageKey="oc:section:stations">
                <div className="text-xs text-slate-500">
                  線形上の 任意位置の 座標を 算出します。SP 値 = BP の SP (
                  {spOffset.toFixed(2)}) + BP からの 内部距離。
                  有効 SP 範囲: <span className="font-mono">{spOffset.toFixed(2)}</span> 〜{' '}
                  <span className="font-mono">{(spOffset + totalLen).toFixed(2)}</span>
                  <br />
                  「特徴点を追加」で 折点 IP・単曲線 BC/EC・緩和曲線 BTC/ETC の SP 値を 一括登録できます。
                </div>

                <div className="flex gap-1 items-center flex-wrap">
                  <button
                    onClick={() => setStationMode('sp')}
                    className={`px-2 py-1 text-xs border rounded ${
                      stationMode === 'sp' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    任意 SP
                  </button>
                  <button
                    onClick={() => setStationMode('pitch')}
                    className={`px-2 py-1 text-xs border rounded ${
                      stationMode === 'pitch' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white hover:bg-slate-50'
                    }`}
                  >
                    ピッチ割
                  </button>
                  <button
                    onClick={handleAddFeaturePoints}
                    disabled={segments.length === 0}
                    className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                    title="折点 IP / 単曲線 BC/EC / 緩和曲線 BTC/ETC を 現在の 中間点リスト に 追加"
                  >
                    <Plus className="h-3 w-3" />
                    特徴点を追加
                  </button>
                </div>

                {stationMode === 'sp' ? (
                  <div className="grid grid-cols-12 gap-2 items-end">
                    <label className="col-span-8 flex flex-col gap-0.5 text-xs">
                      <span className="text-slate-500">SP 値</span>
                      <input
                        type="number"
                        step={0.01}
                        value={stationSp}
                        onChange={(e) => setStationSp(parseFloat(e.target.value) || 0)}
                        className="px-2 py-1 border rounded text-right text-sm"
                      />
                    </label>
                    <button
                      onClick={handleAddStation}
                      disabled={segments.length === 0}
                      className="col-span-4 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      座標を計算
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <label className="col-span-4 flex flex-col gap-0.5 text-xs">
                        <span className="text-slate-500">始点 SP</span>
                        <input
                          type="number"
                          step={0.01}
                          value={stationStartSp}
                          onChange={(e) => setStationStartSp(parseFloat(e.target.value) || 0)}
                          className="px-2 py-1 border rounded text-right text-sm"
                        />
                      </label>
                      <label className="col-span-4 flex flex-col gap-0.5 text-xs">
                        <span className="text-slate-500">終点 SP</span>
                        <input
                          type="number"
                          step={0.01}
                          value={stationEndSp}
                          onChange={(e) => setStationEndSp(parseFloat(e.target.value) || 0)}
                          className="px-2 py-1 border rounded text-right text-sm"
                        />
                      </label>
                      <label className="col-span-4 flex flex-col gap-0.5 text-xs">
                        <span className="text-slate-500">ピッチ (m)</span>
                        <input
                          type="number"
                          step={1}
                          value={stationPitch}
                          onChange={(e) => setStationPitch(parseFloat(e.target.value) || 0)}
                          className="px-2 py-1 border rounded text-right text-sm"
                        />
                      </label>
                    </div>
                    <div className="flex gap-2 items-center">
                      <button
                        onClick={() => {
                          setStationStartSp(spOffset)
                          setStationEndSp(spOffset + totalLen)
                        }}
                        disabled={segments.length === 0}
                        className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
                        title="始点 SP を BP、終点 SP を EP に セット"
                      >
                        全区間
                      </button>
                      <button
                        onClick={handleAddStation}
                        disabled={segments.length === 0}
                        className="ml-auto flex items-center justify-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        生成
                      </button>
                    </div>
                  </div>
                )}

                {stations.length > 0 && (
                  <>
                    {/* 表示列 トグル (SP / 距離 / X / Y)。 # と 削除 は 常時 表示 */}
                    <div className="flex items-center gap-1 flex-wrap text-[11px]">
                      <span className="text-slate-500">表示列:</span>
                      {STATION_COL_DEFS.map((c) => {
                        const on = visibleStationCols.has(c.key)
                        return (
                          <button
                            key={c.key}
                            onClick={() => toggleStationCol(c.key)}
                            className={`px-1.5 py-0.5 border rounded ${
                              on
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-50'
                            }`}
                            title={on ? 'クリックで 非表示' : 'クリックで 表示'}
                          >
                            {c.label}
                          </button>
                        )
                      })}
                    </div>
                    {/* 縦 max-h-80 + 横は cell を nowrap にして 自然幅、コンテナで 横スクロール */}
                    <div className="border rounded overflow-auto max-h-80">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                          <tr>
                            <th className="px-2 py-1 w-10 text-center whitespace-nowrap">#</th>
                            {visibleStationCols.has('sp') && (
                              <th className="px-2 py-1 text-left whitespace-nowrap">SP</th>
                            )}
                            {visibleStationCols.has('distance') && (
                              <th className="px-2 py-1 text-right whitespace-nowrap">距離 (m)</th>
                            )}
                            {visibleStationCols.has('x') && (
                              <th className="px-2 py-1 text-right whitespace-nowrap">X</th>
                            )}
                            {visibleStationCols.has('y') && (
                              <th className="px-2 py-1 text-right whitespace-nowrap">Y</th>
                            )}
                            <th className="px-2 py-1 w-8"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {stations.map((s, i) => {
                            const p = pointAtDistance(segments, s.distance)
                            const isSel = s.id === selectedStationId
                            return (
                              <tr
                                key={s.id}
                                onClick={() =>
                                  setSelectedStationId(isSel ? null : s.id)
                                }
                                className={`border-t cursor-pointer ${
                                  isSel ? 'bg-blue-50' : 'hover:bg-slate-50'
                                }`}
                              >
                                <td className="px-2 py-1 text-center text-slate-500 text-xs whitespace-nowrap">{i + 1}</td>
                                {visibleStationCols.has('sp') && (
                                  <td className="px-2 py-1 font-mono whitespace-nowrap">{s.label}</td>
                                )}
                                {visibleStationCols.has('distance') && (
                                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                                    {s.distance.toFixed(2)}
                                  </td>
                                )}
                                {visibleStationCols.has('x') && (
                                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                                    {p ? p.x.toFixed(3) : '-'}
                                  </td>
                                )}
                                {visibleStationCols.has('y') && (
                                  <td className="px-2 py-1 text-right tabular-nums whitespace-nowrap">
                                    {p ? p.y.toFixed(3) : '-'}
                                  </td>
                                )}
                                <td className="px-1 py-1 text-right">
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleRemoveStation(s.id)
                                    }}
                                    className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] text-slate-500">地図に断面を表示:</span>
                      <div className="flex gap-1">
                        {(['none', 'selected', 'all'] as const).map((m) => (
                          <button
                            key={m}
                            onClick={() => setOverlayMode(m)}
                            className={`px-2 py-0.5 text-[11px] border rounded ${
                              overlayMode === m
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'bg-white hover:bg-slate-50'
                            }`}
                          >
                            {m === 'none' ? 'なし' : m === 'selected' ? '選択中' : '全て'}
                          </button>
                        ))}
                      </div>
                      <button
                        onClick={handleClearStations}
                        className="ml-auto px-2 py-1 text-xs border rounded text-slate-600 hover:bg-slate-50"
                      >
                        全クリア
                      </button>
                    </div>
                    <div className="flex items-center gap-2 pt-1 border-t mt-1">
                      <span className="text-[11px] text-slate-500">エクスポート:</span>
                      <button
                        onClick={handleExportSima}
                        disabled={stationVertexLists.length === 0}
                        className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
                        title="各測点の断面変化点を SIMA 座標として出力"
                      >
                        SIMA
                      </button>
                      <button
                        onClick={handleExportLandXml}
                        disabled={!stationTin || stationTin.triangles.length === 0}
                        className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
                        title="隣接測点の同要素番号同士を結んで TIN を作成"
                      >
                        LandXML (TIN)
                      </button>
                      {stationTin && (
                        <span className="text-[10px] text-slate-400 ml-auto">
                          {stationTin.points.length} 点 / {stationTin.triangles.length} 三角形
                        </span>
                      )}
                    </div>

                    {selectedStation && (
                      <div className="text-[11px] text-slate-500 border rounded p-2 bg-slate-50">
                        <span className="font-mono font-semibold text-slate-700">
                          {selectedStation.label}
                        </span>{' '}
                        の 断面 (現況・計画・出来形) は 下 の{' '}
                        <span className="font-semibold">横断</span> セクション から 開き ます。
                      </div>
                    )}
                  </>
                )}
              </CollapsibleSection>

              {/* 幅杭計算 (中間点 の 直下 に 配置)。
                  SP 値 と 中心線 から の 垂直方向 オフセット (右 +/左 -) を
                  入力する と、平面 座標 XY が 算出される。 追加 は テーブル
                  末尾 の 空行 に 直接 入力 (Enter or + ボタン で 確定)。 */}
              <CollapsibleSection title="幅杭計算" storageKey="oc:section:width-stakes">
                <div className="text-xs text-slate-500">
                  SP 値 と 中心線 から の 垂直方向 オフセット (m) を 入力。
                  <br />
                  右 (
                  {selected.sideOrientation === 'forward'
                    ? '起点→終点視点'
                    : '終点→起点視点'}
                  ) が +、左が -。 末尾 の 空行 に 入力 → Enter or + ボタン で 追加。
                </div>

                <div className="border rounded overflow-auto max-h-56">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                      <tr>
                        <th className="px-2 py-1 w-10 text-center">#</th>
                        <th className="px-2 py-1 text-right">SP</th>
                        <th className="px-2 py-1 text-right">オフセット (m)</th>
                        <th className="px-2 py-1 text-right">X</th>
                        <th className="px-2 py-1 text-right">Y</th>
                        <th className="px-2 py-1 text-left">メモ</th>
                        <th className="px-2 py-1 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {widthStakesWithXY.map(({ stake, x, y }, i) => {
                        const sp = stake.distance + spOffset
                        return (
                          <tr key={stake.id} className="border-t">
                            <td className="px-2 py-1 text-center text-slate-500 text-xs">
                              {i + 1}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <input
                                type="number"
                                step={0.01}
                                value={sp}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value)
                                  if (Number.isFinite(v))
                                    handleChangeWidthStake(stake.id, {
                                      distance: v - spOffset,
                                    })
                                }}
                                className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                              />
                            </td>
                            <td className="px-2 py-1 text-right">
                              <input
                                type="number"
                                step={0.01}
                                value={stake.offset}
                                onChange={(e) => {
                                  const v = parseFloat(e.target.value)
                                  if (Number.isFinite(v))
                                    handleChangeWidthStake(stake.id, { offset: v })
                                }}
                                className="w-20 px-1 py-0.5 border rounded text-right text-sm"
                              />
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {x != null ? x.toFixed(3) : '-'}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {y != null ? y.toFixed(3) : '-'}
                            </td>
                            <td className="px-2 py-1">
                              <input
                                type="text"
                                value={stake.note ?? ''}
                                placeholder="任意"
                                onChange={(e) =>
                                  handleChangeWidthStake(stake.id, {
                                    note: e.target.value || undefined,
                                  })
                                }
                                className="w-full px-1 py-0.5 border rounded text-sm"
                              />
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button
                                onClick={() => handleRemoveWidthStake(stake.id)}
                                className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                              >
                                <Trash2 className="h-3 w-3" />
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                      {/* 末尾 の 空行: SP と オフセット を 入力 して Enter or + で 追加。 */}
                      <tr className="border-t bg-blue-50/40">
                        <td className="px-2 py-1 text-center text-slate-400 text-xs">
                          {widthStakesWithXY.length + 1}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <input
                            type="number"
                            step={0.01}
                            value={newStakeSpText}
                            placeholder="SP"
                            onChange={(e) => setNewStakeSpText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNewWidthStake()
                            }}
                            className="w-24 px-1 py-0.5 border rounded text-right text-sm bg-white"
                          />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <input
                            type="number"
                            step={0.01}
                            value={newStakeOffsetText}
                            placeholder="±m"
                            onChange={(e) => setNewStakeOffsetText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNewWidthStake()
                            }}
                            className="w-20 px-1 py-0.5 border rounded text-right text-sm bg-white"
                          />
                        </td>
                        <td
                          className="px-2 py-1 text-right text-slate-300 text-xs"
                          colSpan={2}
                        >
                          追加前
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="text"
                            value={newStakeNoteText}
                            placeholder="任意"
                            onChange={(e) => setNewStakeNoteText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNewWidthStake()
                            }}
                            className="w-full px-1 py-0.5 border rounded text-sm bg-white"
                          />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button
                            onClick={commitNewWidthStake}
                            disabled={
                              !Number.isFinite(parseFloat(newStakeSpText)) ||
                              !Number.isFinite(parseFloat(newStakeOffsetText))
                            }
                            title="幅杭 を 追加"
                            className="p-0.5 border rounded text-blue-600 hover:bg-blue-50 disabled:opacity-30"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CollapsibleSection>

              {/* 縦断 (幅杭 と 横断 の 間 に 配置)。
                  縦断図 の プロット は 地図の 下に 残す。ここでは 変化点 の
                  追加 / 編集 / 削除 のみ。追加 は テーブル 末尾 の 空行 に
                  直接 入力 (Enter or + ボタン で 確定)。 */}
              <CollapsibleSection title="縦断" storageKey="oc:section:profile">
                <div className="text-xs text-slate-500">
                  SP 値 (中間点計算 と 同じ 座標系) と 計画高 (m) を 変化点 ごと に 登録。
                  末尾 の 空行 に 入力 → Enter or + ボタン で 追加。
                  中間 の 変化点 (PVI) に VCL (縦断曲線長 m) を 指定すると 放物線
                  縦断曲線 を 割り付ける (M / VCR は 自動計算)。
                  <br />
                  内部保存 は BP からの 距離 (= SP − spOffset<span className="font-mono ml-1">{selected ? `= SP − ${(selected.spOffset ?? 0).toFixed(2)}` : ''}</span>)。
                </div>

                <div className="border rounded overflow-auto max-h-72">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                      <tr>
                        <th className="px-2 py-1 w-10 text-center">#</th>
                        <th className="px-2 py-1 text-right">SP (m)</th>
                        <th className="px-2 py-1 text-right">計画高 (m)</th>
                        <th className="px-2 py-1 text-right">勾配</th>
                        <th
                          className="px-2 py-1 text-right"
                          title="縦断曲線長 (Vertical Curve Length) — 0 or 空 で 曲線 なし"
                        >
                          VCL (m)
                        </th>
                        <th className="px-2 py-1 text-right text-[10px]">M / VCR</th>
                        <th className="px-2 py-1 w-10"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedProfile.map((p, i) => {
                        const realIdx = selected.profilePoints.indexOf(p)
                        const prev = i > 0 ? sortedProfile[i - 1] : null
                        const slope = prev
                          ? (() => {
                              const dx = p.distance - prev.distance
                              const dy = p.floorHeight - prev.floorHeight
                              if (Math.abs(dx) < 1e-6) return '-'
                              if (Math.abs(dy) < 1e-9) return '水平'
                              return `1/${Math.round(Math.abs(dx / dy))}`
                            })()
                          : '-'
                        // 両端 (BP/EP) は VCL 適用外。中間点 のみ 入力可。
                        const isMiddle = i > 0 && i < sortedProfile.length - 1
                        const curve = profileCurvesByPviIndex.get(i)
                        return (
                          <ProfileRow
                            key={realIdx}
                            p={p}
                            index={i}
                            isMiddle={isMiddle}
                            slopeText={slope}
                            curve={curve}
                            spOffset={selected?.spOffset ?? 0}
                            onChangeCommit={(patch) => handleChangeProfile(realIdx, patch)}
                            onRemove={() => handleRemoveProfile(realIdx)}
                          />
                        )
                      })}
                      {/* 末尾 の 空行: 両方 入力 して Enter or + で 追加。 */}
                      <tr className="border-t bg-blue-50/40">
                        <td className="px-2 py-1 text-center text-slate-400 text-xs">
                          {sortedProfile.length + 1}
                        </td>
                        <td className="px-2 py-1 text-right">
                          <input
                            type="number"
                            step={0.1}
                            value={newProfileDistText}
                            placeholder="SP"
                            onChange={(e) => setNewProfileDistText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNewProfile()
                            }}
                            className="w-20 px-1 py-0.5 border rounded text-right text-sm bg-white"
                          />
                        </td>
                        <td className="px-2 py-1 text-right">
                          <input
                            type="number"
                            step={0.001}
                            value={newProfileHText}
                            placeholder="計画高"
                            onChange={(e) => setNewProfileHText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitNewProfile()
                            }}
                            className="w-20 px-1 py-0.5 border rounded text-right text-sm bg-white"
                          />
                        </td>
                        <td
                          className="px-2 py-1 text-right text-slate-300 text-xs"
                          colSpan={3}
                        >
                          追加後 に VCL 設定
                        </td>
                        <td className="px-2 py-1 text-right">
                          <button
                            onClick={commitNewProfile}
                            disabled={
                              !Number.isFinite(parseFloat(newProfileDistText)) ||
                              !Number.isFinite(parseFloat(newProfileHText))
                            }
                            title="変化点 を 追加"
                            className="p-0.5 border rounded text-blue-600 hover:bg-blue-50 disabled:opacity-30"
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </CollapsibleSection>

              {/* 横断 (現況・計画・出来形)。 中間点 の 表 に 並んで いた
                  現況 / 計画 / 出来形 の ボタン と 計画高 / 現況高 を ここ に 移した。
                  タブ は 右下 の 横断図 パネル の 編集対象 と 同じ state を 見る ので、
                  ここ で 切り替える と 下 の エディタ も 一緒 に 切り替わる。 */}
              <CollapsibleSection
                title="横断 (現況・計画・出来形)"
                storageKey="oc:section:cross"
                actions={
                  <button
                    type="button"
                    onClick={toggleControlOnly}
                    className={`px-2 py-0.5 text-[11px] border rounded ${
                      controlOnly
                        ? 'bg-slate-700 text-white border-slate-700'
                        : 'bg-white text-slate-600 hover:bg-slate-50'
                    }`}
                    title="管理測点 に チェック を 付けた 測点 だけ を 表示"
                  >
                    管理測点のみ表示
                    <span className="ml-1 opacity-70">{controlStationCount}</span>
                  </button>
                }
              >
                <div className="flex items-center gap-1 flex-wrap">
                  {EDIT_TARGET_TABS.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => {
                        setEditTarget(t.key)
                        // 対象を 切り替えたら 地図ピック モードは 解除 (下 の パネル と 同じ)
                        setMapCaptureTarget(null)
                      }}
                      className={`px-3 py-1 text-xs border rounded ${
                        editTarget === t.key ? t.act : t.idle
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                  {/* 取込 で 拾う 範囲。 右下 横断図 の 「横断幅」 と 同じ 値 */}
                  {editTarget === 'current' && (
                    <label
                      className="ml-auto flex items-center gap-1 text-[11px] text-slate-500"
                      title="中心線沿いにこの範囲内の実測記録を、その断面上の点として拾います"
                    >
                      <span>横断幅</span>
                      <input
                        type="number"
                        step={0.1}
                        min={0.05}
                        value={crossBandM}
                        onChange={(e) => {
                          const n = parseFloat(e.target.value)
                          if (Number.isFinite(n) && n > 0) setCrossBandM(n)
                        }}
                        className="w-14 px-1 py-0.5 border rounded text-right text-[11px]"
                      />
                      <span>m</span>
                    </label>
                  )}
                </div>
                {stations.length === 0 ? (
                  <div className="text-xs text-slate-500">
                    中間点計算 で 測点 を 登録 する と、ここ で 測点 ごと の 断面 を 作れ ます。
                  </div>
                ) : (
                  <>
                    <div className="text-[11px] text-slate-500">
                      {editTarget === 'plan'
                        ? '行 を 選ぶ と 右下 の 横断図 で 計画断面 の 編集 に 入り ます。 個別断面 が 無い 測点 は 標準断面 を 複製 して 始め ます。'
                        : editTarget === 'current'
                          ? '行 を 選ぶ と 右下 の 横断図 で 現況 の 編集 に 入り ます (地図 / 表 / DXF から 拾える)。 「取込」 は その 測点 の 現況 を 実測記録 から 入れ 直し ます。'
                          : '行 を 選ぶ と 右下 の 横断図 で 出来形 の 編集 に 入り ます。'}
                    </div>
                    <div className="border rounded overflow-auto max-h-80">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                          <tr>
                            <th className="px-2 py-1 w-10 text-center whitespace-nowrap">#</th>
                            <th className="px-2 py-1 text-left whitespace-nowrap">SP</th>
                            <th
                              className="px-2 py-1 w-12 text-center whitespace-nowrap"
                              title="出来形管理 の 対象 に する 測点"
                            >
                              管理
                            </th>
                            {editTarget === 'plan' && (
                              <th
                                className="px-2 py-1 w-24 text-right whitespace-nowrap"
                                title="縦断線形から 自動取込 (トレース/入力 が あれば 優先)"
                              >
                                計画高 (m)
                              </th>
                            )}
                            {editTarget === 'current' && (
                              <th
                                className="px-2 py-1 w-24 text-right whitespace-nowrap"
                                title="現況地盤高 を 直接入力"
                              >
                                現況高 (m)
                              </th>
                            )}
                            {editTarget === 'current' && (
                              <th
                                className="px-2 py-1 w-16 text-right whitespace-nowrap"
                                title="この断面の横断幅以内にある実測記録の点数"
                              >
                                実測
                              </th>
                            )}
                            <th className="px-2 py-1 w-28 text-center whitespace-nowrap">状態</th>
                            {editTarget === 'current' && (
                              <th className="px-2 py-1 w-16 text-center whitespace-nowrap"></th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {stations
                            .map((s, i) => ({ s, i }))
                            .filter(({ s }) => !controlOnly || s.isControlStation)
                            .map(({ s, i }) => {
                            const isSel = s.id === selectedStationId
                            return (
                              <tr
                                key={s.id}
                                onClick={() => openStationSection(s, editTarget)}
                                className={`border-t cursor-pointer ${
                                  isSel ? 'bg-blue-50' : 'hover:bg-slate-50'
                                }`}
                              >
                                <td className="px-2 py-1 text-center text-slate-500 text-xs whitespace-nowrap">
                                  {i + 1}
                                </td>
                                <td className="px-2 py-1 font-mono whitespace-nowrap">{s.label}</td>
                                {/* 管理測点。 行クリック (= 編集) に 巻き込まれない ように 止める */}
                                <td className="px-2 py-1 text-center">
                                  <input
                                    type="checkbox"
                                    checked={s.isControlStation === true}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={() => handleToggleControlStation(s.id)}
                                    className="cursor-pointer"
                                    title="管理測点 に する"
                                  />
                                </td>
                                {/* 計画高: plannedCenterHeight (トレース由来 or 手入力) を 最優先、
                                    無ければ 縦断線形から 内挿 (範囲外は null)。 どちらも 無ければ "-"。 */}
                                {editTarget === 'plan' && (() => {
                                  const fromPlanned = s.plannedCenterHeight ?? null
                                  const fromProfile = selected
                                    ? interpolateProfileZOrNull(selected.profilePoints, s.distance)
                                    : null
                                  const value = fromPlanned ?? fromProfile
                                  const source =
                                    fromPlanned != null
                                      ? 'トレース/入力'
                                      : fromProfile != null
                                        ? '縦断線形'
                                        : null
                                  return (
                                    <td
                                      className="px-2 py-1 text-right tabular-nums text-emerald-700 whitespace-nowrap"
                                      title={source ? `出典: ${source}` : '計画高が 未取得'}
                                    >
                                      {value != null ? value.toFixed(3) : '-'}
                                      {fromPlanned != null && (
                                        <span className="text-[9px] text-amber-600 ml-0.5">*</span>
                                      )}
                                    </td>
                                  )
                                })()}
                                {/* 現況高: 直接 入力。空 なら 未計測扱い */}
                                {editTarget === 'current' && (
                                  <td className="px-1 py-1 text-right whitespace-nowrap">
                                    <ElevationField
                                      value={s.currentGroundHeight ?? null}
                                      allowEmpty
                                      onClick={(e) => e.stopPropagation()}
                                      onCommit={(v) =>
                                        handleUpdateStationCurrentHeight(
                                          s.id,
                                          v == null ? '' : String(v),
                                        )
                                      }
                                      placeholder="-"
                                      className="w-full px-1 py-0.5 border rounded text-right tabular-nums text-amber-700 bg-amber-50/40"
                                    />
                                  </td>
                                )}
                                {editTarget === 'current' && (
                                  <td className="px-2 py-1 text-right tabular-nums text-[11px] whitespace-nowrap">
                                    {(() => {
                                      const n = measuredCountByStation.get(s.id) ?? 0
                                      return n > 0 ? (
                                        <span className="text-cyan-700">{n}</span>
                                      ) : (
                                        <span className="text-slate-300">0</span>
                                      )
                                    })()}
                                  </td>
                                )}
                                <td className="px-2 py-1 text-center text-[11px] whitespace-nowrap">
                                  {(() => {
                                    if (editTarget === 'plan') {
                                      const n = s.plannedSectionRaw?.length ?? 0
                                      if (s.crossSection)
                                        return <span className="text-blue-700">個別設定</span>
                                      if (n > 0)
                                        return (
                                          <span className="text-blue-700">トレース {n} 点</span>
                                        )
                                      return <span className="text-slate-400">標準を継承</span>
                                    }
                                    const n =
                                      (editTarget === 'current'
                                        ? s.currentSection?.length
                                        : s.asbuiltSection?.length) ?? 0
                                    if (n === 0) return <span className="text-slate-400">未作成</span>
                                    return (
                                      <span
                                        className={
                                          editTarget === 'current'
                                            ? 'text-amber-700'
                                            : 'text-emerald-700'
                                        }
                                      >
                                        {n} 点
                                      </span>
                                    )
                                  })()}
                                </td>
                                {editTarget === 'current' && (
                                  <td className="px-1 py-1 text-center whitespace-nowrap">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        handleImportStationCurrent(s)
                                      }}
                                      disabled={(measuredCountByStation.get(s.id) ?? 0) === 0}
                                      className="px-1.5 py-0.5 text-[11px] border rounded bg-cyan-50 border-cyan-300 text-cyan-800 hover:bg-cyan-100 disabled:opacity-40"
                                      title="この 測点 の 現況 を 実測記録 から 取込 (逆スライド 済み)"
                                    >
                                      取込
                                    </button>
                                  </td>
                                )}
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {controlOnly && controlStationCount === 0 && (
                      <div className="text-[11px] text-amber-700">
                        管理測点 が まだ ありません。 「管理測点のみ表示」 を 解除 して
                        「管理」 に チェック を 付けて ください。
                      </div>
                    )}
                    {editTarget === 'current' && stationImportMsg && (
                      <div className="text-[11px] text-emerald-700">{stationImportMsg}</div>
                    )}
                  </>
                )}
              </CollapsibleSection>

              {/* 断面 の 編集 は 右下 パネル の 横断図 タブ。 横断 セクション の
                  「編集」 で 該当測点、選択なし の 場合 は 標準断面 を 編集 する。 */}
            </>
          )}
        </div>

        {/* 右: 地図 (上) + 縦断図 (下) */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0 relative overflow-hidden isolate">
            {/* 地図 から 断面点 を 拾って いる 間 の 帯。
                どの 断面 に 入る のか、今 効いて いるのか が 地図 を 見て いる
                だけ で 分かる ように する。 */}
            {mapCaptureTarget && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1200] flex items-center gap-2 px-3 py-1.5 rounded bg-purple-600 text-white text-xs shadow-lg">
                <span>
                  地図から
                  {mapCaptureTarget === 'current' ? '現況' : mapCaptureTarget === 'asbuilt' ? '出来形' : '計画'}
                  断面に追加中
                </span>
                {selectedStation ? (
                  <span className="font-mono opacity-90">{selectedStation.label}</span>
                ) : (
                  <span className="text-amber-200">測点が未選択です</span>
                )}
                <button
                  type="button"
                  onClick={() => setMapCaptureTarget(null)}
                  className="ml-1 px-2 py-0.5 rounded bg-white/20 hover:bg-white/30"
                >
                  やめる
                </button>
              </div>
            )}
            <CoordinateMap
              farmId={farmId ?? null}
              showLabels
              checkedCoordIds={registeredCoordIds}
              onPointSelect={handlePickCoordFromMap}
              // 現況/出来形の 地図取得 中は 重なり選択を 挟まない。
              // 続けて 点を 拾う 場面で ポップアップが 邪魔に なる うえ、
              // 断面表示で 地図を 回して いる 間は Popup の 位置が ずれて
              // 「押しても 何も 起きない」ように 見える
              disableOverlapPicker={mapCaptureTarget != null}
              mapBearingDeg={mapBearingDeg}
            >
              {sampledLatLng.length >= 2 && (
                <FitBounds key={selectedId ?? 'none'} positions={sampledLatLng} />
              )}
              {/* 測点選択で その 位置に パン+拡大。 選択解除 で は 触らない */}
              <StationFocus latLng={selectedStationLatLng} />


              {sampledLatLng.length >= 2 && (
                <Polyline positions={sampledLatLng} pathOptions={{ color: '#0ea5e9', weight: 5 }} />
              )}

              {/* IP に R (単曲線) や 緩和曲線 が 効いている 折れ点は、実線は 円弧側に 譲るため
                  「元の 折れ線」= BC(TS)-IP-EC(ST) を 点線で 上書き表示して 参考線として 残す */}
              {ipCornerGuides.map((g, idx) => {
                const ipLL = converter.toLatLng(g.ip.x, g.ip.y)
                const tsLL = converter.toLatLng(g.ts.x, g.ts.y)
                const stLL = converter.toLatLng(g.st.x, g.st.y)
                return (
                  <Polyline
                    key={`ipguide-${idx}`}
                    positions={[
                      [tsLL.lat, tsLL.lng],
                      [ipLL.lat, ipLL.lng],
                      [stLL.lat, stLL.lng],
                    ]}
                    pathOptions={{
                      color: '#0ea5e9',
                      weight: 1.5,
                      opacity: 0.7,
                      dashArray: '5,4',
                    }}
                  />
                )
              })}

              {/* 中間点ごとの断面オーバーレイ */}
              {visibleStationVertices.map(({ station, vertices }) => {
                if (vertices.length < 2) return null
                const isSel = station.id === selectedStationId
                const positions: [number, number][] = vertices.map((v) => {
                  const ll = converter.toLatLng(v.x, v.y)
                  return [ll.lat, ll.lng]
                })
                const lineColor = isSel ? '#dc2626' : '#7c3aed'
                const opacity = isSel ? 1 : 0.6
                return (
                  <div key={`cs-${station.id}`}>
                    <Polyline
                      positions={positions}
                      pathOptions={{
                        color: lineColor,
                        weight: isSel ? 2.5 : 1.5,
                        opacity,
                      }}
                    />
                    {vertices.map((v, vi) => {
                      const ll = converter.toLatLng(v.x, v.y)
                      const fill =
                        v.side === 'center'
                          ? '#0ea5e9'
                          : v.side === 'right'
                          ? '#16a34a'
                          : '#f59e0b'
                      return (
                        <CircleMarker
                          key={`csv-${station.id}-${vi}`}
                          center={[ll.lat, ll.lng]}
                          radius={isSel ? 3.5 : 2.5}
                          pathOptions={{
                            color: '#fff',
                            fillColor: fill,
                            fillOpacity: opacity,
                            weight: 1,
                          }}
                        >
                          <Tooltip direction="right" offset={[4, 0]} className="!text-[10px]">
                            {station.label} / {v.label}
                            {v.side !== 'center' ? ` (${v.offset.toFixed(2)}m)` : ''}
                          </Tooltip>
                        </CircleMarker>
                      )
                    })}
                  </div>
                )
              })}
              {/* 幅杭: ピンク (#ec4899) の 小さめ マーカー + 中心線 との
                  接続線 で 「どの SP から どちら側 か」を 分かりやすく 表示。 */}
              {widthStakesWithXY.map(({ stake, x, y }) => {
                if (x == null || y == null) return null
                const center = pointAtDistance(segments, stake.distance)
                if (!center) return null
                const stakeLL = converter.toLatLng(x, y)
                const centerLL = converter.toLatLng(center.x, center.y)
                const sp = stake.distance + spOffset
                const side = stake.offset >= 0 ? 'R' : 'L'
                return (
                  <div key={`ws-${stake.id}-${mapCaptureTarget ? 'locked' : 'free'}`}>
                    <Polyline
                      positions={[
                        [centerLL.lat, centerLL.lng],
                        [stakeLL.lat, stakeLL.lng],
                      ]}
                      interactive={false}
                      pathOptions={{
                        color: '#ec4899',
                        weight: 1.5,
                        opacity: 0.8,
                        dashArray: '3,3',
                      }}
                    />
                    <CircleMarker
                      center={[stakeLL.lat, stakeLL.lng]}
                      radius={4}
                      // 断面点 を 拾って いる 間 は 座標 の マーカー を 邪魔 しない
                      interactive={mapCaptureTarget == null}
                      pathOptions={{
                        color: '#fff',
                        fillColor: '#ec4899',
                        fillOpacity: 0.95,
                        weight: 1.5,
                      }}
                    >
                      <Tooltip
                        permanent
                        direction="right"
                        offset={[6, 0]}
                        className="point-label-tooltip"
                      >
                        <span
                          style={{
                            color: '#ec4899',
                            textShadow:
                              '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                          }}
                        >
                          SP{sp.toFixed(2)} {side}{Math.abs(stake.offset).toFixed(2)}
                          {stake.note ? ` (${stake.note})` : ''}
                        </span>
                      </Tooltip>
                    </CircleMarker>
                  </div>
                )
              })}
              {stations.map((s) => {
                const p = pointAtDistance(segments, s.distance)
                if (!p) return null
                const ll = converter.toLatLng(p.x, p.y)
                const isSel = s.id === selectedStationId
                const hasOverride = s.crossSection != null
                // 中間点 (SP) は 紫 で 固定。 個別断面 は 琥珀色 で 差別化。
                const fillColor = hasOverride ? '#f59e0b' : '#a78bfa'
                return (
                  <CircleMarker
                    key={`${s.id}-${mapCaptureTarget ? 'locked' : 'free'}`}
                    center={[ll.lat, ll.lng]}
                    radius={isSel ? 6 : 4}
                    // 断面点 を 地図 から 拾って いる 間 は 測点 の 印 を 触れなく する。
                    // 座標 の マーカー を 狙った つもり で 測点 を 選んで しまい、
                    // 別 の 測点 へ 地図 が 飛ぶ 事故 を 防ぐ。
                    // interactive は 作る ときの 設定 な ので key で 作り直す。
                    interactive={mapCaptureTarget == null}
                    eventHandlers={
                      mapCaptureTarget == null
                        ? { click: () => setSelectedStationId(isSel ? null : s.id) }
                        : undefined
                    }
                    pathOptions={{
                      color: '#fff',
                      fillColor,
                      fillOpacity: 0.95,
                      weight: isSel ? 2 : 1.5,
                    }}
                  >
                    {/* 座標管理と 同じ 「白フチ 付き 色文字」スタイル
                        (point-label-tooltip class で 背景・枠 を 透明化)。
                        常時表示 で 測点名 が いつでも 見える。 */}
                    <Tooltip
                      permanent
                      direction="bottom"
                      offset={[0, 6]}
                      className="point-label-tooltip"
                    >
                      <span
                        style={{
                          color: fillColor,
                          textShadow:
                            '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                        }}
                      >
                        {s.label}
                        {hasOverride ? ' (個別)' : ''}
                      </span>
                    </Tooltip>
                  </CircleMarker>
                )
              })}
            </CoordinateMap>
          </div>
        </div>
      </div>

      {/* 画面 下端 の 二面パネル: 縦断図 / 横断図 を タブ で 切替。
          - 縦断図: 変化点 の 編集 UI は 左サイドバー 「縦断」に。
          - 横断図: 中間点 選択 時 は その 測点 の 計画断面、
                   選択なし の 時 は 標準断面 (=横断計画) を 編集。
          計画 ボタン 押下 で 横断図 タブ に 自動切替。 */}
      {selected && (
        <div
          className="shrink-0 border-t bg-white flex flex-col relative isolate overflow-hidden"
          style={{ height: profileChartExpanded ? '420px' : 'auto' }}
        >
          <div className="px-2 py-1 flex items-center gap-2 shrink-0 border-b bg-slate-50">
            <button
              type="button"
              onClick={toggleProfileChart}
              className="p-0.5 hover:bg-slate-100 rounded"
              title={profileChartExpanded ? '折りたたむ' : '展開'}
            >
              {profileChartExpanded ? (
                <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
              )}
            </button>
            <div className="flex gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setBottomTab('profile')
                  if (!profileChartExpanded) toggleProfileChart()
                }}
                className={`px-2 py-0.5 text-xs rounded ${
                  bottomTab === 'profile'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border hover:bg-slate-100 text-slate-700'
                }`}
              >
                縦断図
              </button>
              <button
                type="button"
                onClick={() => {
                  setBottomTab('crossSection')
                  if (!profileChartExpanded) toggleProfileChart()
                }}
                className={`px-2 py-0.5 text-xs rounded ${
                  bottomTab === 'crossSection'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border hover:bg-slate-100 text-slate-700'
                }`}
              >
                横断図
              </button>
            </div>
            <span className="text-[11px] text-slate-500 truncate">
              {bottomTab === 'profile'
                ? '変化点 の 追加 / 編集 は 左サイドバー 「縦断」から'
                : selectedStation
                ? `${selectedStation.label} の 計画断面`
                : '横断計画 (標準断面) — 中間点 で 計画 を 押すと 個別 に 編集 できます'}
            </span>
          </div>
          {/* 展開中 は 図 の 左 に 断面点 の 表 を 固定 する。 測点 を 選べば
              その 断面 の 中身 が そのまま 出る ので、別 の 呼び出し は 要らない。
              縦断図 / 横断図 の どちら の タブ でも 出し続ける。 */}
          {profileChartExpanded && (
          <div className="flex-1 min-h-0 flex">
            <aside className="w-[624px] shrink-0 border-r p-2 overflow-hidden flex flex-col gap-1.5">
              {/* 取込 の 入口 は 表 の 上 に まとめる。
                  LandXML は 全測点 一括、地図 / DXF は 選んで いる 測点 に 対して。 */}
              {stations.length > 0 && (
                <div className="shrink-0 space-y-1">
                  <LandxmlSectionImport
                    farmId={farmId ?? null}
                    channelName={selected?.name ?? null}
                    target={sectionTargetOfEditTarget(editTarget)}
                    stations={stations}
                    segments={segments}
                    sideOrientation={selected?.sideOrientation ?? 'forward'}
                    onImported={(rows) =>
                      handleReplaceStationSectionsBulk(
                        sectionTargetOfEditTarget(editTarget),
                        rows,
                      )
                    }
                  />
                  {selectedStation && (() => {
                    const t = sectionTargetOfEditTarget(editTarget)
                    const isMapMode = editTarget === 'current' || editTarget === 'asbuilt'
                    return (
                      <div className="flex items-center gap-1 flex-wrap">
                        {isMapMode && (
                          <button
                            onClick={() => {
                              if (mapCaptureTarget === t) {
                                setMapCaptureTarget(null)
                                return
                              }
                              // 現況 で まだ 何も 保存 して いない ときは、いま 断面図 に
                              // 出て いる 実測点 を そのまま 土台 に する。
                              // これ を しない と 1 点 拾った 途端 に 実測点 が 消えて
                              // 「反映 されない」 ように 見える。
                              if (
                                t === 'current' &&
                                !selectedStation.currentSection?.length &&
                                autoCurrentSection.length > 0
                              ) {
                                handleReplaceStationSection(
                                  selectedStation.id,
                                  'current',
                                  autoCurrentSection,
                                )
                              }
                              setMapCaptureTarget(t)
                            }}
                            className={`px-2 py-0.5 text-[11px] border rounded ${
                              mapCaptureTarget === t
                                ? 'bg-purple-600 text-white border-purple-600'
                                : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'
                            }`}
                            title="地図で 測点マーカーを クリック すると 中心線に 垂直投影 して 追加"
                          >
                            {mapCaptureTarget === t ? '地図取得: 選択中' : '地図から追加'}
                          </button>
                        )}
                        {/* DXF が 未登録 でも 出す。 トレース モーダル 側 で
                            登録 できる ので、ここ が 入口 に なる。 */}
                        <button
                          onClick={() =>
                            setDxfTraceContext({ stationId: selectedStation.id, target: t })
                          }
                          className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                          title="既存 DXF 横断図 から トレースして 点を 拾う (DXF の 登録 も ここ から)"
                        >
                          DXFから取込
                        </button>
                      </div>
                    )
                  })()}
                </div>
              )}
              <div className="flex-1 min-h-0">
              {selectedStation ? (
                (() => {
                  const t = sectionTargetOfEditTarget(editTarget)
                  const key = sectionKeyOf(t)
                  const pts =
                    (selectedStation[key] as MeasuredCrossPoint[] | null | undefined) ?? []
                  return (
                    <SectionPointsEditor
                      target={t}
                      stationId={selectedStation.id}
                      stationLabel={selectedStation.label}
                      points={pts}
                      autoPoints={t === 'current' ? autoCurrentSection : undefined}
                      onChange={(next) =>
                        handleReplaceStationSection(selectedStation.id, t, next)
                      }
                    />
                  )
                })()
              ) : (
                <div className="text-[11px] text-slate-400">
                  左メニュー 「横断」 で 測点 を 選ぶ と、その 断面 の 点 が ここ に 出ます。
                </div>
              )}
              </div>
            </aside>
            <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {profileChartExpanded && bottomTab === 'profile' && (
            <div className="flex-1 min-h-0 px-2 pb-2">
              <ProfileChart
                points={selected.profilePoints}
                totalLen={totalLen}
                spOffset={spOffset}
                currentGroundPoints={stations
                  .filter((s) => s.currentGroundHeight != null)
                  .map((s) => ({ distance: s.distance, z: s.currentGroundHeight as number }))}
              />
            </div>
          )}
          {profileChartExpanded && bottomTab === 'crossSection' && (
            <div className="flex-1 min-h-0 flex flex-col p-2 gap-2">
              {(() => {
                // 計画高 (中心設計高) の 優先順位:
                //   1. plannedCenterHeight (トレース由来 or 手入力)
                //   2. profilePoints から 内挿 (範囲外なら null → undefined 扱い)
                //   3. undefined (未取得)
                const centerZ = selectedStation
                  ? (selectedStation.plannedCenterHeight ??
                      interpolateProfileZOrNull(selected.profilePoints, selectedStation.distance) ??
                      undefined)
                  : undefined
                // 編集対象 = 選択測点 の 個別断面 (element or 点列 の いずれか) / なければ 標準断面。
                //   crossSection と plannedSectionRaw は handleUpdateStationCrossSection /
                //   handleReplaceStationSection('planned') で 常に 同期される 想定 だが、
                //   旧データ (片方 のみ) との 互換 の ため plannedSectionRaw を 逆変換 で フォールバック。
                const stationCs: StandardCrossSection | null = selectedStation
                  ? selectedStation.crossSection
                    ? selectedStation.crossSection
                    : selectedStation.plannedSectionRaw &&
                        selectedStation.plannedSectionRaw.length > 0
                      ? measuredPointsToStandardCs(
                          selectedStation.plannedSectionRaw,
                          centerZ ?? 0,
                        )
                      : null
                  : null
                const cs: StandardCrossSection = stationCs ?? selected.standardCrossSection
                return (
                  <>
                    {/* ヘッダー: 対象 表示 + 個別/標準 切替 */}
                    <div className="flex items-center gap-2 flex-wrap text-xs shrink-0">
                      {selectedStation ? (
                        <>
                          <span className="font-mono font-semibold text-slate-700">
                            {selectedStation.label}
                          </span>
                          {/* 測点 の 切替。 表題 の 測点名 の 右 に 置く */}
                          {(() => {
                            const idx = stations.findIndex((s) => s.id === selectedStation.id)
                            const prev = idx > 0 ? stations[idx - 1] : null
                            const next =
                              idx >= 0 && idx < stations.length - 1 ? stations[idx + 1] : null
                            return (
                              <span className="inline-flex items-center gap-0.5">
                                <button
                                  onClick={() => prev && setSelectedStationId(prev.id)}
                                  disabled={!prev}
                                  className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                  title={
                                    prev ? `手前の 断面 (${prev.label})` : '手前の 断面 は ありません'
                                  }
                                >
                                  ◀ 手前
                                </button>
                                <button
                                  onClick={() => next && setSelectedStationId(next.id)}
                                  disabled={!next}
                                  className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                                  title={
                                    next ? `次の 断面 (${next.label})` : '次の 断面 は ありません'
                                  }
                                >
                                  次 ▶
                                </button>
                              </span>
                            )
                          })()}
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              selectedStation.crossSection
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-200 text-slate-600'
                            }`}
                          >
                            {selectedStation.crossSection ? '個別設定' : '標準を継承'}
                          </span>
                          {centerZ !== undefined && (
                            <>
                              <span className="text-[10px] text-slate-500">中心設計高</span>
                              <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                                {centerZ.toFixed(3)}
                                <span className="text-[10px] text-slate-400 ml-0.5">m</span>
                              </span>
                            </>
                          )}
                          {/* 横断幅: 中心線 沿い に この 範囲の 実測記録を
                              「この 断面上の 点」と みなす。既定 50cm */}
                          <label
                            className="flex items-center gap-1 text-[10px] text-slate-500"
                            title="中心線沿いにこの範囲内の実測記録を、この断面上の点として自動で拾います"
                          >
                            <span>横断幅</span>
                            <input
                              type="number"
                              step={0.1}
                              min={0.05}
                              value={crossBandM}
                              onChange={(e) => {
                                const n = parseFloat(e.target.value)
                                if (Number.isFinite(n) && n > 0) setCrossBandM(n)
                              }}
                              className="w-14 px-1 py-0.5 border rounded text-right text-[11px]"
                            />
                            <span>m</span>
                            {autoCurrentSection.length > 0 && (
                              <span className="text-cyan-700">
                                実測 {autoCurrentSection.length} 点
                              </span>
                            )}
                          </label>
                          {/* 編集対象 (現況 / 計画 / 出来形) は 左メニュー の 「横断」 タブ
                              で 選ぶ。 ここ は いま どれ を 編集 して いる か の 表示 だけ。 */}
                          {(() => {
                            const m = EDIT_TARGET_TABS.find((t) => t.key === editTarget)
                            if (!m) return null
                            return (
                              <div className="flex items-center gap-1 border-l pl-2 ml-1">
                                <span className="text-[10px] text-slate-500">編集</span>
                                <span
                                  className={`px-2 py-0.5 text-[11px] border rounded ${m.act}`}
                                  title="左メニュー の 「横断」 タブ で 切り替え"
                                >
                                  {m.label}
                                </span>
                              </div>
                            )
                          })()}
                          <div className="ml-auto flex gap-1">
                            {selectedStation.crossSection ||
                            (selectedStation.plannedSectionRaw?.length ?? 0) > 0 ? (
                              <button
                                onClick={() =>
                                  handleUpdateStationCrossSection(selectedStation.id, null)
                                }
                                className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-600 hover:bg-slate-50"
                              >
                                標準に戻す
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  handleUpdateStationCrossSection(
                                    selectedStation.id,
                                    cloneCrossSection(selected.standardCrossSection),
                                  )
                                }
                                className="px-2 py-0.5 text-[11px] border rounded bg-blue-600 text-white hover:bg-blue-700"
                              >
                                個別設定（標準を取込）
                              </button>
                            )}
                          </div>
                        </>
                      ) : (
                        <>
                          <span className="font-semibold text-slate-700">
                            横断計画 (標準断面)
                          </span>
                          <span className="text-[11px] text-slate-500">
                            左右計画線 の ボタン で 描画 開始。 中間点 の 計画 を 押すと 個別断面 を 編集 できます。
                          </span>
                        </>
                      )}
                    </div>

                    {/* 断面図 (表示)。 測点 の 切替 は 表題 の 測点名 の 右 の
                        ◀ 手前 / 次 ▶。 入力 は 左 の 断面入力欄 (表) で。 */}
                    <div className="flex-1 min-h-0">
                      <CrossSectionView
                        cs={cs}
                        centerHeight={centerZ}
                        currentGroundHeight={selectedStation?.currentGroundHeight ?? null}
                        // 保存済みが 無ければ、横断幅 以内の 実測点を
                        // そのまま 出す (取込ボタンを 押さなくても 見える)
                        currentSection={
                          selectedStation?.currentSection?.length
                            ? selectedStation.currentSection
                            : autoCurrentSection.length > 0
                              ? autoCurrentSection
                              : null
                        }
                        asbuiltSection={selectedStation?.asbuiltSection ?? null}
                      />
                    </div>
                  </>
                )
              })()}
            </div>
          )}
            </div>
          </div>
          )}
        </div>
      )}

      {/* DXF トレース モーダル */}
      {dxfTraceContext && selected && (() => {
        const st = stations.find((s) => s.id === dxfTraceContext.stationId)
        if (!st) return null
        return (
          <DxfTraceModal
            channel={selected}
            station={st}
            target={dxfTraceContext.target}
            stationsOrdered={stations}
            onClose={() => setDxfTraceContext(null)}
            onSaveCalibration={(c) => handleUpdateStationCalibration(st.id, c)}
            onReplacePoints={(t, pts) =>
              handleReplaceStationSection(st.id, t, pts)
            }
            onSwitchStation={(id) =>
              setDxfTraceContext((prev) => (prev ? { ...prev, stationId: id } : prev))
            }
            onUpdateStationDxfId={(id, dxfId) =>
              setStations(
                stations.map((s) =>
                  s.id === id ? { ...s, dxfCrossSectionId: dxfId } : s,
                ),
              )
            }
            onUploadDxf={async (file) => {
              const uid =
                globalThis.crypto?.randomUUID?.() ??
                Math.random().toString(36).slice(2)
              const path = `${selected.farmId}/${selected.id}-${uid}.dxf`
              const { error: upErr } = await supabase.storage
                .from('open-channel-dxf')
                .upload(path, file, {
                  contentType: 'application/dxf',
                  upsert: false,
                })
              if (upErr) throw upErr
              const entry: DxfCrossSectionFile = {
                id: uid,
                name: file.name,
                path,
                addedAt: new Date().toISOString(),
              }
              // channel と station を 1 回 の updateChannel で 反映 (再取得 待ちを 避ける)。
              // setStations 経由だ と stations だけ 更新 で dxfCrossSections が 上書き
              // されてしまう ため、直接 updateChannel を 呼ぶ。
              await updateChannel(selected.id, {
                dxfCrossSections: [
                  ...(selected.dxfCrossSections ?? []),
                  entry,
                ],
                stations: stations.map((s) =>
                  s.id === st.id ? { ...s, dxfCrossSectionId: uid } : s,
                ),
              })
            }}
            onDeleteDxf={async (dxfId) => {
              const target = (selected.dxfCrossSections ?? []).find(
                (f) => f.id === dxfId,
              )
              if (!target) return
              await supabase.storage
                .from('open-channel-dxf')
                .remove([target.path])
              await updateChannel(selected.id, {
                dxfCrossSections: (selected.dxfCrossSections ?? []).filter(
                  (f) => f.id !== dxfId,
                ),
                // 参照 中 の 全 測点 の dxfCrossSectionId を クリア (フォールバック で 先頭 が 使われる)
                stations: stations.map((s) =>
                  s.dxfCrossSectionId === dxfId
                    ? { ...s, dxfCrossSectionId: null }
                    : s,
                ),
              })
            }}
          />
        )
      })()}
    </div>
  )
}
