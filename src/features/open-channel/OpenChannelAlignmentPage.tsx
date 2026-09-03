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
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Pencil, Check, X, Upload, Eye, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import { decodeDxfBytes, type DxfShape } from '@/lib/dxfRender'
import { supabase } from '@/lib/supabase'
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
  buildCrossSectionPath,
  elementStep,
} from '@/stores/openChannelStore'
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
import type { TinPoint, TinTriangle, TinSurface } from '@/lib/landxml/surface'

/**
 * 中間点 1 つの断面要素境界点を、平面座標 (x_north, y_east) + 標高 z にプロジェクションして返す。
 *
 * - sideOrientation='forward': BP→EP を見て右が +、左が -
 * - sideOrientation='reverse': EP→BP を見て右が +、左が -
 * - 標高 z = 中心線床高（profile_points を線形補間） + 断面要素累積高さ
 * - 直立要素 (slopeUnit='vertical') は水平移動 0 (前頂点と同じ平面位置に重なる)。
 */
type StationVertex = {
  x: number
  y: number
  z: number
  offset: number // 中心からの符号付き水平距離 (m)、正=ユーザー視点の右
  localH: number // 中心床高からの局所高さ (m)
  label: string
  side: 'right' | 'left' | 'center'
}

/**
 * 縦断曲線 (対称 2 次放物線)。VCL > 0 の 中間 変化点 (PVI) について、
 * BVC (=PVI-VCL/2) 〜 EVC (=PVI+VCL/2) の 範囲 に 割り付ける。
 *
 * i1, i2 は 前後 の 勾配 (%, 符号付き)。
 * M = (i1 - i2) / 800 × VCL  (m、凸型で 正 → PVI より 下)
 * Y = (i1 - i2) / (200 × VCL) × X²  (X は BVC からの 距離)
 * i (代数的 勾配差) = i2 - i1
 * VCR = VCL / |i|  (m/%)
 */
export interface VerticalCurve {
  pviIndex: number     // sortedProfile 上 の インデックス
  pviDistance: number  // PVI の 追加距離 (m)
  pviHeight: number    // PVI の 計画高 (m)
  vcl: number
  i1Percent: number    // 前 勾配 (%, 符号付き)
  i2Percent: number    // 後ろ 勾配 (%, 符号付き)
  bvcDistance: number
  bvcHeight: number
  evcDistance: number
  evcHeight: number
  /** 縦距 M (m)、凸型 で 正 (曲線 が PVI より 下) */
  m: number
  /** 代数的 勾配差 A = i2 - i1 (%)、凸型 で 負、凹型 で 正 */
  aPercent: number
  /** 縦断曲線半径相当 VCR = VCL / |A| (m/%) */
  vcr: number
}

/** ソート済 profilePoints から VCL > 0 の 縦断曲線 列 を 抽出。 */
function computeVerticalCurves(
  sortedProfile: ProfilePoint[],
): VerticalCurve[] {
  const out: VerticalCurve[] = []
  for (let i = 1; i < sortedProfile.length - 1; i++) {
    const prev = sortedProfile[i - 1]
    const pvi = sortedProfile[i]
    const next = sortedProfile[i + 1]
    const vcl = pvi.vcl ?? 0
    if (!Number.isFinite(vcl) || vcl <= 1e-6) continue
    const d1 = pvi.distance - prev.distance
    const d2 = next.distance - pvi.distance
    if (d1 <= 1e-9 || d2 <= 1e-9) continue
    // 勾配 (%). 上り +、下り -
    const i1 = ((pvi.floorHeight - prev.floorHeight) / d1) * 100
    const i2 = ((next.floorHeight - pvi.floorHeight) / d2) * 100
    // BVC / EVC が 隣接 変化点 を 越え ない 範囲 に クランプ
    const halfL = vcl / 2
    if (halfL > d1 + 1e-9 || halfL > d2 + 1e-9) continue
    const bvcDistance = pvi.distance - halfL
    const evcDistance = pvi.distance + halfL
    const bvcHeight = pvi.floorHeight - (i1 / 100) * halfL
    const evcHeight = pvi.floorHeight + (i2 / 100) * halfL
    const m = ((i1 - i2) / 800) * vcl
    const aPercent = i2 - i1
    const vcr = Math.abs(aPercent) < 1e-9 ? Infinity : vcl / Math.abs(aPercent)
    out.push({
      pviIndex: i,
      pviDistance: pvi.distance,
      pviHeight: pvi.floorHeight,
      vcl,
      i1Percent: i1,
      i2Percent: i2,
      bvcDistance,
      bvcHeight,
      evcDistance,
      evcHeight,
      m,
      aPercent,
      vcr,
    })
  }
  return out
}

/**
 * 縦断曲線 (放物線) を 考慮 した 標高 (計画高) を X 位置 で 補間 する。
 * BVC 〜 EVC の 範囲 では 放物線 (Y = BVC + i1/100 × X + (i2-i1)/(200×L) × X²、
 * X は BVC からの 距離) を 使用。 それ 以外 は 直線 補間。
 * 端点を 超えたら クランプ (端点値 を 返す)。
 * ※ 「範囲外は 計画高 なし」扱い を したい 呼び出し側 は interpolateProfileZOrNull を 使う。
 */
function interpolateProfileZ(
  profilePoints: ProfilePoint[],
  distance: number,
): number {
  if (profilePoints.length === 0) return 0
  const sorted = [...profilePoints].sort((a, b) => a.distance - b.distance)
  if (distance <= sorted[0].distance) return sorted[0].floorHeight
  const last = sorted[sorted.length - 1]
  if (distance >= last.distance) return last.floorHeight

  // 該当 位置 が いずれか の 縦断曲線 範囲内 なら 放物線 で 計算
  const curves = computeVerticalCurves(sorted)
  for (const c of curves) {
    if (distance >= c.bvcDistance && distance <= c.evcDistance) {
      const x = distance - c.bvcDistance
      const linear = c.bvcHeight + (c.i1Percent / 100) * x
      const offset = ((c.i2Percent - c.i1Percent) / (200 * c.vcl)) * x * x
      return linear + offset
    }
  }

  // それ 以外 は 隣接 2 点 で 直線 補間
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]
    const b = sorted[i]
    if (distance >= a.distance && distance <= b.distance) {
      const dx = b.distance - a.distance
      if (dx < 1e-9) return a.floorHeight
      const t = (distance - a.distance) / dx
      return a.floorHeight + (b.floorHeight - a.floorHeight) * t
    }
  }
  return last.floorHeight
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

function computeStationVertices(
  station: StationRow,
  standardCS: StandardCrossSection,
  profilePoints: ProfilePoint[],
  segments: AlignmentSegment[],
  sideOrientation: SideOrientation,
): StationVertex[] {
  const cs = station.crossSection ?? standardCS
  const center = pointAtDistance(segments, station.distance)
  const tangent = tangentAtDistance(segments, station.distance)
  if (!center || !tangent) return []
  const sign = sideOrientation === 'forward' ? 1 : -1
  // (x=北, y=東) 系で進行方向 (tx, ty) の CCW 90° = (-ty, tx) が地図上の進行方向の右。
  // sign=-1 で河川向き（EP→BP 視点の右 = BP→EP 視点の左）に反転。
  const perp = { x: -tangent.y * sign, y: tangent.x * sign }
  const centerZ = interpolateProfileZ(profilePoints, station.distance)
  const out: StationVertex[] = [
    {
      x: center.x,
      y: center.y,
      z: centerZ,
      offset: 0,
      localH: 0,
      label: 'CL',
      side: 'center',
    },
  ]
  let cum = 0
  let localH = 0
  for (let i = 0; i < cs.right.length; i++) {
    const e = cs.right[i]
    const step = elementStep(e, 1)
    cum += step.dx
    localH += step.dy
    out.push({
      x: center.x + cum * perp.x,
      y: center.y + cum * perp.y,
      z: centerZ + localH,
      offset: cum,
      localH,
      label: e.name || `R${i + 1}`,
      side: 'right',
    })
  }
  cum = 0
  localH = 0
  for (let i = 0; i < cs.left.length; i++) {
    const e = cs.left[i]
    const step = elementStep(e, -1)
    cum += step.dx
    localH += step.dy
    out.push({
      x: center.x + cum * perp.x,
      y: center.y + cum * perp.y,
      z: centerZ + localH,
      offset: cum,
      localH,
      label: e.name || `L${i + 1}`,
      side: 'left',
    })
  }
  return out
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

/** タイトルのみで折りたたみ可能なセクション（開閉状態は localStorage に記憶可）。
 *  onOpenChange を 渡すと 親コンポーネントが 現在の 開閉状態を 監視できる
 *  (例: 折りたたみ中は 地図クリック による 編集を 抑止 する 用途)。 */
function CollapsibleSection({
  title,
  defaultOpen = true,
  storageKey,
  onOpenChange,
  children,
}: {
  title: string
  defaultOpen?: boolean
  storageKey?: string
  onOpenChange?: (open: boolean) => void
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
      <button
        type="button"
        onClick={toggle}
        className="w-full px-3 py-2 flex items-center font-semibold text-slate-800 text-sm hover:bg-slate-50 rounded-t-lg"
      >
        {open ? (
          <ChevronDown className="h-4 w-4 mr-1 text-slate-500" />
        ) : (
          <ChevronRight className="h-4 w-4 mr-1 text-slate-500" />
        )}
        <span>{title}</span>
      </button>
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
  useEffect(() => {
    if (!latLng) return
    let cancelled = false
    const raf1 = requestAnimationFrame(() => {
      if (cancelled) return
      const raf2 = requestAnimationFrame(() => {
        if (cancelled) return
        map.invalidateSize({ animate: false })
        const nextZoom = Math.max(map.getZoom(), targetZoom)
        map.setView(latLng, nextZoom, { animate: true, duration: 0.4 })
      })
      // raf2 の cleanup は 外側 では 追えないが requestAnimationFrame は 1 回で 完結
      void raf2
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf1)
    }
  }, [latLng, targetZoom, map])
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
}: {
  points: ProfilePoint[]
  totalLen: number
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
 * 断面 を SVG 上 で 直接 描画 する 対話 型 エディタ。
 *
 * ワークフロー:
 *   1. [左計画線] / [右計画線] ボタン で 描画 モード を 開始 (drawSide 選択)。
 *   2. 勾配 表記 モード を 切替:
 *      - フリーハンド : マウス 位置 の (dx, dy) を そのまま 使い、勾配 % を 算出。
 *      - %           : 入力値 (符号 有 で 上下 決定) を 勾配 % に。 幅 は マウス X。
 *      - 1:i          : 入力値 を ratio 単位 で 勾配 に。 幅 は マウス X。
 *      - 直高         : 幅 0、マウス Y 分 だけ 垂直 移動 (dW=0, dH=dy)。
 *   3. マウス 移動 で プレビュー、クリック で 区間 追加。 描画 中 の 側 の 末尾 に 追加 される。
 *
 * 座標系: 中心 (0,0) を 基準 に 右 +x / 左 -x、上 +y (計画高 基準)。
 */
type DrawMode = 'freehand' | 'percent' | 'ratio' | 'vertical' | 'dxdy'
type DrawSide = 'right' | 'left' | null

/** モード 順 (Space キー サイクル) と 表示ラベル */
const DRAW_MODES: DrawMode[] = ['freehand', 'percent', 'ratio', 'vertical', 'dxdy']
const DRAW_MODE_LABEL: Record<DrawMode, string> = {
  freehand: 'フリーハンド',
  percent: '%',
  ratio: '1:i',
  vertical: '直高',
  dxdy: '相対距離 (縦横)',
}

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

/**
 * 現況/出来形 断面 の 点列 を 直接 入力 する モーダル。
 * 中心線からの 離れ (右+ / 左-) と 標高 の ペア を 行 単位で 追加・編集・削除。
 * 保存で 呼び元 の handleReplaceStationSection に 引き渡す。
 */
function MeasuredSectionTableModal({
  target,
  stationLabel,
  initialPoints,
  onSave,
  onClose,
}: {
  target: SectionTarget
  stationLabel: string
  initialPoints: MeasuredCrossPoint[]
  onSave: (points: MeasuredCrossPoint[]) => void
  onClose: () => void
}) {
  const [rows, setRows] = useState<MeasuredCrossPoint[]>(() =>
    initialPoints.map((p) => ({ ...p })),
  )
  const targetLabel =
    target === 'current' ? '現況断面' : target === 'asbuilt' ? '出来形' : '計画断面 (トレース)'
  const newId = () => `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  const addRow = () => {
    setRows((r) => [...r, { id: newId(), offset: 0, elevation: 0 }])
  }
  const removeRow = (id: string) => {
    setRows((r) => r.filter((p) => p.id !== id))
  }
  const updateRow = (id: string, patch: Partial<MeasuredCrossPoint>) => {
    setRows((r) => r.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-4 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">
            {targetLabel} 入力 —{' '}
            <span className="font-mono text-slate-600">{stationLabel}</span>
          </h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded" title="キャンセル">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mb-2">
          中心線からの 離れ (右+ / 左-) と 標高 [m] を 入力。保存 で 昇順 に 並び 替えられます。
        </p>
        <div className="border rounded overflow-auto flex-1">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600 sticky top-0">
              <tr>
                <th className="px-2 py-1 w-8 text-center">#</th>
                <th className="px-2 py-1 text-right">中心からの離れ (m)</th>
                <th className="px-2 py-1 text-right">標高 (m)</th>
                <th className="px-2 py-1 w-8"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-2 py-4 text-center text-slate-400 text-[11px]">
                    まだ 点が ありません。「+ 行を 追加」で 入力を 始める
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={r.id} className="border-t">
                    <td className="px-2 py-1 text-center text-slate-500">{i + 1}</td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        step={0.01}
                        value={r.offset}
                        onChange={(e) =>
                          updateRow(r.id, { offset: parseFloat(e.target.value) || 0 })
                        }
                        className="w-full px-1 py-0.5 border rounded text-right tabular-nums"
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        step={0.001}
                        value={r.elevation}
                        onChange={(e) =>
                          updateRow(r.id, { elevation: parseFloat(e.target.value) || 0 })
                        }
                        className="w-full px-1 py-0.5 border rounded text-right tabular-nums"
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button
                        onClick={() => removeRow(r.id)}
                        className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between mt-3">
          <button
            onClick={addRow}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50"
          >
            <Plus className="h-3 w-3" />
            行を 追加
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1 text-xs border rounded hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              onClick={() => {
                onSave(rows)
                onClose()
              }}
              className="px-3 py-1 text-xs border rounded bg-blue-600 text-white hover:bg-blue-700"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function InteractiveCrossSectionEditor({
  cs,
  onChange,
  centerHeight,
  currentGroundHeight,
  currentSection,
  asbuiltSection,
  onPrevStation,
  onNextStation,
  canPrev = false,
  canNext = false,
  prevLabel,
  nextLabel,
}: {
  cs: StandardCrossSection
  onChange: (next: StandardCrossSection) => void
  centerHeight?: number
  /** 現況高 (中心線上の 地盤高) [m]。undefined / null は 未入力扱い。
   *  横線 + ラベルで 上書き表示し、計画高との 差分 (切/盛) も 併記 */
  currentGroundHeight?: number | null
  /** 現況断面 の 測定点列 (offset, elevation)。ある場合 は 折れ線 + マーカーで 描画。 */
  currentSection?: MeasuredCrossPoint[] | null
  /** 出来形 断面 の 測定点列。ある場合 は 別 色 で 折れ線 + マーカー描画。 */
  asbuiltSection?: MeasuredCrossPoint[] | null
  /** 手前の 断面 (前の 測点) に 移行。null なら ボタン非活性 */
  onPrevStation?: () => void
  /** 次の 断面 (次の 測点) に 移行。null なら ボタン非活性 */
  onNextStation?: () => void
  canPrev?: boolean
  canNext?: boolean
  /** ボタンの tooltip 表示用 (例: "SP0+20 の 計画断面") */
  prevLabel?: string
  nextLabel?: string
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 720, h: 340 })

  const [drawSide, setDrawSide] = useState<DrawSide>(null)
  const [drawMode, setDrawMode] = useState<DrawMode>('freehand')
  const [slopeText, setSlopeText] = useState<string>('2')
  // dW / dH の 手動 入力。 空 なら カーソル 位置 を 使い、値 が あれば その値 を 優先。
  //  - percent / ratio モード: dW が 空 で dH が あれば 勾配 から dW を 逆算。
  //  - vertical モード: dH の みず 使用。
  //  - dxdy モード: dW / dH の どちらか (両方) を 直接 指定。
  const [dWText, setDWText] = useState<string>('')
  const [dHText, setDHText] = useState<string>('')
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

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

  // 各側 の 末尾点 (次 区間 の 起点)
  const lastRight = useMemo(() => {
    let x = 0
    let y = 0
    for (const e of cs.right) {
      const s = elementStep(e, 1)
      x += s.dx
      y += s.dy
    }
    return { x, y }
  }, [cs.right])
  const lastLeft = useMemo(() => {
    let x = 0
    let y = 0
    for (const e of cs.left) {
      const s = elementStep(e, -1)
      x += s.dx
      y += s.dy
    }
    return { x, y }
  }, [cs.left])
  const drawOrigin =
    drawSide === 'right' ? lastRight : drawSide === 'left' ? lastLeft : { x: 0, y: 0 }

  // SVG スケール。 描画中 (プレビュー) に 拡縮 が 揺れる の を 避ける ため、
  // カーソル 位置 は 範囲 に 含めない。 区間 を 確定 (onChange) した タイミング で
  // cs.right / cs.left が 変わり、その とき に 再フィット する。
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
  // ピクセル → 世界 座標: 表示側の パン/ズーム を 逆に かけて から 自動フィット を 剥がす
  const ix = (px: number) => ((px - viewPan.x) / viewZoom - offsetX) / scale
  const iy = (py: number) => (offsetY - (py - viewPan.y) / viewZoom) / scale
  // 世界 座標 → 画面 ピクセル (パン/ズーム 込み)。参照線 の 位置 決定 等 に 使う
  const vx = (x: number) => viewPan.x + viewZoom * tx(x)
  const vy = (y: number) => viewPan.y + viewZoom * ty(y)

  /**
   * 現在 の モード + 入力値 + カーソル 位置 から 新 区間 を 算出。
   *  - dWText / dHText が 埋まっている 場合 は カーソル より 優先。
   *  - percent / ratio モード で dW/dH の 片方 が 埋まっていて 勾配 も
   *    ある 場合 は もう 片方 を 逆算 する。
   * カーソル も 入力 も 無い / 内向き の 場合 は null (追加不可)。
   */
  const computeSegment = (
    cursorOverride?: { x: number; y: number } | null,
  ): {
    element: CrossSectionElement
    endPoint: { x: number; y: number }
  } | null => {
    if (!drawSide) return null
    const effCursor = cursorOverride === undefined ? cursor : cursorOverride
    return computeSegmentCore({
      drawSide,
      drawOrigin,
      cursor: effCursor,
      drawMode,
      slopeText,
      dWText,
      dHText,
    })
  }

  const preview = drawSide ? computeSegment() : null

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
    if (!drawSide) return
    setCursor({ x: ix(px), y: iy(py) })
  }
  const onSvgMouseLeave = () => {
    setCursor(null)
    panStartRef.current = null
  }
  const onSvgMouseUp = () => {
    panStartRef.current = null
    // wasDraggingRef は 直後の onClick で 読まれる。次の mouseDown で リセット される
  }
  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    // ドラッグ 直後の click は 抑止 (pan の 終了 で 区間追加 されない ように)
    if (wasDraggingRef.current) return
    if (!drawSide) return
    // カーソル 位置 を 最新化 して から 計算
    const rect = e.currentTarget.getBoundingClientRect()
    const c = { x: ix(e.clientX - rect.left), y: iy(e.clientY - rect.top) }
    setCursor(c)
    const seg = computeSegment(c)
    if (!seg) return
    const nextSide = [...cs[drawSide], seg.element]
    onChange({ ...cs, [drawSide]: nextSide })
  }

  /** 表示 リセット: パン (0,0) / ズーム 1.0 に 戻す (自動フィット 状態) */
  const resetView = () => {
    setViewPan({ x: 0, y: 0 })
    setViewZoom(1)
  }
  const addManually = () => {
    if (!drawSide) return
    // dW/dH に 手動 入力 が 必要 (少なくとも 片方) — 空 だと mouse を 使う モード に なる
    const seg = computeSegment(null)
    if (!seg) return
    const nextSide = [...cs[drawSide], seg.element]
    onChange({ ...cs, [drawSide]: nextSide })
    // 追加後 は dW/dH をクリア (勾配は次入力の再利用のため保持)
    setDWText('')
    setDHText('')
  }

  const removeLast = () => {
    if (!drawSide) return
    if (cs[drawSide].length === 0) return
    const nextSide = cs[drawSide].slice(0, -1)
    onChange({ ...cs, [drawSide]: nextSide })
  }

  // キー操作:
  //   BS       — 直近区間 を 取消 (dW/dH/勾配 入力欄には 干渉しない)
  //   Space    — モード を 順に 切替 (freehand → % → 1:i → 直高 → 相対距離 → …)
  useEffect(() => {
    if (!drawSide) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName
      const inTextInput =
        tag === 'INPUT' || tag === 'TEXTAREA' || (t !== null && t.isContentEditable)
      if (e.key === 'Backspace') {
        if (inTextInput) return
        e.preventDefault()
        removeLast()
      } else if (e.key === ' ' || e.code === 'Space') {
        if (inTextInput) return
        e.preventDefault()
        setDrawMode((cur) => {
          const idx = DRAW_MODES.indexOf(cur)
          return DRAW_MODES[(idx + 1) % DRAW_MODES.length]
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawSide, cs, onChange])
  const clearSide = (side: 'right' | 'left') => {
    if (!window.confirm(`${side === 'right' ? '右' : '左'} 側 の 区間 を すべて 削除 します。`)) return
    onChange({ ...cs, [side]: [] })
  }

  const modeButton = (m: DrawMode, label: string) => (
    <button
      key={m}
      onClick={() => setDrawMode(m)}
      disabled={!drawSide}
      className={`px-2 py-0.5 text-[11px] border rounded ${
        drawMode === m
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40'
      }`}
    >
      {label}
    </button>
  )

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* ツールバー (左右計画線 ボタンは SVG 上に 移動、勾配モード等は ここに 残す) */}
      <div className="flex items-center gap-1.5 flex-wrap text-xs shrink-0">
        <span className="text-slate-500 text-[11px]">モード (Space で 切替)</span>
        {DRAW_MODES.map((m) => modeButton(m, DRAW_MODE_LABEL[m]))}
        {(drawMode === 'percent' || drawMode === 'ratio') && drawSide && (
          <input
            type="text"
            value={slopeText}
            onChange={(e) => setSlopeText(e.target.value)}
            placeholder={drawMode === 'percent' ? '例: 2 / -2' : '例: 1.5'}
            className="w-16 px-1 py-0.5 border rounded text-xs font-mono text-right"
            title="勾配 (符号 有 で 上下 決定、無 なら dH/カーソル に 合わせる)"
          />
        )}

        {/* 幅 / 高 の 手動入力 (percent / ratio / vertical / dxdy モード)。
            空 なら カーソル 位置 で 決定、埋めれば その値 で 追加 ボタン から 確定。 */}
        {drawSide && drawMode !== 'freehand' && (
          <>
            {(drawMode === 'percent' || drawMode === 'ratio' || drawMode === 'dxdy') && (
              <label className="flex items-center gap-1 text-slate-500 text-[11px]">
                dW
                <input
                  type="text"
                  value={dWText}
                  onChange={(e) => setDWText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addManually()
                  }}
                  placeholder="幅m"
                  className="w-14 px-1 py-0.5 border rounded text-xs font-mono text-right"
                />
              </label>
            )}
            <label className="flex items-center gap-1 text-slate-500 text-[11px]">
              dH
              <input
                type="text"
                value={dHText}
                onChange={(e) => setDHText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addManually()
                }}
                placeholder="高m"
                className="w-14 px-1 py-0.5 border rounded text-xs font-mono text-right"
              />
            </label>
            <button
              onClick={addManually}
              disabled={dWText.trim() === '' && dHText.trim() === ''}
              className="px-2 py-0.5 text-[11px] border rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:bg-slate-300"
              title="入力した dW / dH で 区間 を 追加"
            >
              + 追加
            </button>
          </>
        )}

        <span className="text-slate-400 mx-1">|</span>
        <button
          onClick={removeLast}
          disabled={!drawSide || cs[drawSide].length === 0}
          className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-100 disabled:opacity-40"
          title="直近 の 区間 を 取り消し (BS キー でも 可)"
        >
          <ArrowUp className="h-3 w-3 inline -mt-0.5" /> 戻す (BS)
        </button>
        <button
          onClick={() => clearSide('left')}
          className="px-2 py-1 text-xs border rounded text-red-600 hover:bg-red-50"
        >
          左クリア
        </button>
        <button
          onClick={() => clearSide('right')}
          className="px-2 py-1 text-xs border rounded text-red-600 hover:bg-red-50"
        >
          右クリア
        </button>
        <span className="text-slate-400 mx-1">|</span>
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

      {/* 描画キャンバス
          左右計画線 の 開始ボタンは 断面図の 左右端に 絶対配置。
          「右計画線」ボタンを 押したら 右側から 描く、「左計画線」を 押したら 左側から
          描くという 対応を 位置で 直感的に 見せる。 */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 border rounded bg-slate-50 relative overflow-hidden"
      >
        {/* 上部 中央 の ツールバー: 断面切替 (◀) + 左右計画線 + 断面切替 (▶)。
            中心線 (SVG 中央) を 挟む 形で 4 個 を 並べ、
            外側 2 個 で 手前 / 次の 測点 の 断面へ ジャンプできる。 */}
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1">
          <button
            onClick={onPrevStation}
            disabled={!canPrev}
            className="px-2 py-1 text-xs border rounded shadow-sm bg-white/95 hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={prevLabel ? `手前の 断面 (${prevLabel})` : '手前の 断面に 移行'}
          >
            ◀ 手前
          </button>
          <button
            onClick={() => setDrawSide(drawSide === 'left' ? null : 'left')}
            className={`px-2 py-1 text-xs border rounded shadow-sm ${
              drawSide === 'left'
                ? 'bg-amber-500 text-white border-amber-500'
                : 'bg-white/95 hover:bg-slate-100 text-slate-700'
            }`}
            title="左側 の 断面 を 描画"
          >
            ← 左計画線
          </button>
          <button
            onClick={() => setDrawSide(drawSide === 'right' ? null : 'right')}
            className={`px-2 py-1 text-xs border rounded shadow-sm ${
              drawSide === 'right'
                ? 'bg-emerald-500 text-white border-emerald-500'
                : 'bg-white/95 hover:bg-slate-100 text-slate-700'
            }`}
            title="右側 の 断面 を 描画"
          >
            右計画線 →
          </button>
          <button
            onClick={onNextStation}
            disabled={!canNext}
            className="px-2 py-1 text-xs border rounded shadow-sm bg-white/95 hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
            title={nextLabel ? `次の 断面 (${nextLabel})` : '次の 断面に 移行'}
          >
            次 ▶
          </button>
        </div>
        <svg
          width={size.w}
          height={size.h}
          onMouseDown={onSvgMouseDown}
          onMouseMove={onSvgMouseMove}
          onMouseLeave={onSvgMouseLeave}
          onMouseUp={onSvgMouseUp}
          onClick={onSvgClick}
          style={{
            cursor: wasDraggingRef.current
              ? 'grabbing'
              : drawSide
                ? 'crosshair'
                : 'grab',
          }}
        >
          {/* 中心線 / 中心設計高 基準線 は 常に 画面 端まで 伸ばす (パン/ズームで
              端が 見切れないよう、transform の 外で 位置を 手計算) */}
          <line
            x1={vx(0)}
            y1={padding.top}
            x2={vx(0)}
            y2={size.h - padding.bottom}
            stroke="#cbd5e1"
            strokeDasharray="3,3"
            strokeWidth={1}
          />
          <line
            x1={padding.left}
            y1={vy(0)}
            x2={size.w - padding.right}
            y2={vy(0)}
            stroke="#94a3b8"
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

          {/* プレビュー 区間 (未確定) — ラベル も 併記 */}
          {preview && (
            <>
              <line
                x1={tx(drawOrigin.x)}
                y1={ty(drawOrigin.y)}
                x2={tx(preview.endPoint.x)}
                y2={ty(preview.endPoint.y)}
                stroke={drawSide === 'right' ? '#059669' : '#d97706'}
                strokeWidth={2}
                strokeDasharray="5,3"
              />
              <circle
                cx={tx(preview.endPoint.x)}
                cy={ty(preview.endPoint.y)}
                r={4}
                fill={drawSide === 'right' ? '#059669' : '#d97706'}
                stroke="#fff"
                strokeWidth={1.5}
              />
              {(() => {
                const midX = (tx(drawOrigin.x) + tx(preview.endPoint.x)) / 2
                const midY = (ty(drawOrigin.y) + ty(preview.endPoint.y)) / 2
                const dxSvg = tx(preview.endPoint.x) - tx(drawOrigin.x)
                const dySvg = ty(preview.endPoint.y) - ty(drawOrigin.y)
                const len = Math.hypot(dxSvg, dySvg) || 1
                let nUpX = -dySvg / len
                let nUpY = dxSvg / len
                if (nUpY > 0) {
                  nUpX = -nUpX
                  nUpY = -nUpY
                }
                const offset = 12
                const color = drawSide === 'right' ? '#059669' : '#d97706'
                const slope = formatSlopeOnly(preview.element)
                const width = formatWidthOnly(preview.element)
                return (
                  <>
                    {slope && (
                      <text
                        x={midX + nUpX * offset}
                        y={midY + nUpY * offset}
                        fontSize={13}
                        fill={color}
                        textAnchor="middle"
                        fontWeight={600}
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
                        fill={color}
                        textAnchor="middle"
                        fontWeight={600}
                        style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
                      >
                        {width}
                      </text>
                    )}
                  </>
                )
              })()}
            </>
          )}

          {/* 描画 起点 マーカー */}
          {drawSide && (
            <circle
              cx={tx(drawOrigin.x)}
              cy={ty(drawOrigin.y)}
              r={5}
              fill="none"
              stroke={drawSide === 'right' ? '#059669' : '#d97706'}
              strokeWidth={2}
              strokeDasharray="2,2"
            />
          )}
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
                  />
                ))}
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
                  />
                ))}
              </g>
            )
          })()}
          </g>
          {/* 現況高: 中心線上の 地盤高が 入力されて いる 場合、水平線で 上書き表示。
              計画高 (中心設計高 = y=0) との 差 だけ 上下した 位置に 線を 描く。
              茶系 (地盤色) の 破線 で 「切/盛」の 目安に する。 */}
          {currentGroundHeight != null && centerHeight !== undefined && (() => {
            const dy = currentGroundHeight - centerHeight
            const cutFillLabel =
              dy > 0.001 ? `切 ${dy.toFixed(3)}m` : dy < -0.001 ? `盛 ${(-dy).toFixed(3)}m` : '±0'
            const cutFillColor = dy > 0.001 ? '#dc2626' : dy < -0.001 ? '#2563eb' : '#64748b'
            return (
              <>
                <line
                  x1={padding.left}
                  y1={vy(dy)}
                  x2={size.w - padding.right}
                  y2={vy(dy)}
                  stroke="#a16207"
                  strokeWidth={1.5}
                  strokeDasharray="6,4"
                  opacity={0.85}
                />
                <text x={vx(0) + 6} y={vy(dy) - 4} fontSize={12} fill="#a16207">
                  現況高 {currentGroundHeight.toFixed(3)}m
                </text>
                <text x={vx(0) + 6} y={vy(dy) + 14} fontSize={11} fill={cutFillColor} fontWeight={600}>
                  {cutFillLabel}
                </text>
              </>
            )
          })()}
          {/* 中心設計高 ラベル: 中心線 直近に 出す。パン/ズームで 位置は 追随 (vx/vy) */}
          {centerHeight !== undefined && (
            <text x={vx(0) + 6} y={vy(0) - 4} fontSize={12} fill="#334155">
              中心設計高 {centerHeight.toFixed(3)}m
            </text>
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

          {/* ステータス表示 */}
          {drawSide && cursor && (
            <text
              x={size.w - padding.right}
              y={size.h - 8}
              fontSize={11}
              fill="#334155"
              textAnchor="end"
              style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
            >
              {preview
                ? `dW=${(preview.endPoint.x - drawOrigin.x).toFixed(2)}m, dH=${(
                    preview.endPoint.y - drawOrigin.y
                  ).toFixed(3)}m`
                : 'カーソルを外側へ動かしてください'}
            </text>
          )}
          {drawSide && (
            <text
              x={padding.left}
              y={size.h - 8}
              fontSize={11}
              fill="#334155"
              style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
            >
              描画中: {drawSide === 'right' ? '右計画線' : '左計画線'} / {DRAW_MODE_LABEL[drawMode]}
            </text>
          )}
        </svg>
      </div>
    </div>
  )
}

/**
 * 描画 モード + 入力 + カーソル 位置 から 1 区間 を 算出 する 共通 ロジック。
 *
 * 優先順位:
 *   - dWText / dHText が 埋まっている 場合 は カーソル より 優先。
 *   - percent / ratio モード で dH のみ 埋めた 場合 は 勾配 から dW を 逆算。
 *   - vertical モード は dH の みず 使用 (dW=0)。
 *   - 何も 無い / 内向き の 場合 は null。
 *
 * 勾配 の 符号 決定:
 *   - slopeText に 明示 符号 (+ / -) が あれば その 通り。
 *   - なければ dH (または カーソル Y 差分) の 符号 に 合わせる。
 */
function computeSegmentCore(input: {
  drawSide: 'right' | 'left'
  drawOrigin: { x: number; y: number }
  cursor: { x: number; y: number } | null
  drawMode: DrawMode
  slopeText: string
  dWText: string
  dHText: string
}): { element: CrossSectionElement; endPoint: { x: number; y: number } } | null {
  const { drawSide, drawOrigin, cursor, drawMode, slopeText, dWText, dHText } = input
  const sideSign: 1 | -1 = drawSide === 'right' ? 1 : -1
  const newId = () => `e${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  const parseNum = (s: string): number | null => {
    const t = s.trim()
    if (t === '') return null
    const v = parseFloat(t)
    return Number.isFinite(v) ? v : null
  }
  const dWIn = parseNum(dWText)
  const dHIn = parseNum(dHText)

  // カーソル 由来 の 生 (dx, dy)。 override が 効く 前 の 値。
  const cursorDx = cursor ? cursor.x - drawOrigin.x : 0
  const cursorDy = cursor ? cursor.y - drawOrigin.y : 0

  // ------ 直高 モード ------
  if (drawMode === 'vertical') {
    const dh = dHIn !== null ? dHIn : cursor ? cursorDy : null
    if (dh === null) return null
    if (Math.abs(dh) < 1e-4) return null
    const el: CrossSectionElement = {
      id: newId(),
      name: '',
      width: 0,
      slopeValue: Math.round(dh * 1000) / 1000,
      slopeUnit: 'vertical',
    }
    return { element: el, endPoint: { x: drawOrigin.x, y: drawOrigin.y + el.slopeValue } }
  }

  // ------ 相対距離 モード (dW / dH を 直接 指定) ------
  //   両方 入力あれば その値で 追加、片方 空なら カーソル で 補完。
  //   保存形式は 「幅 + 勾配%」(=フリーハンドと 同じ) — 後で 編集する 時も 破綻しない。
  if (drawMode === 'dxdy') {
    const dw = dWIn !== null ? Math.abs(dWIn) : cursor ? Math.abs(cursorDx) : null
    const dh = dHIn !== null ? dHIn : cursor ? cursorDy : null
    if (dw === null || dh === null) return null
    if (dw < 1e-3) return null
    const wRounded = Math.round(dw * 1000) / 1000
    const pct = Math.round((dh / dw) * 100 * 100) / 100
    const el: CrossSectionElement = {
      id: newId(),
      name: '',
      width: wRounded,
      slopeValue: pct,
      slopeUnit: 'percent',
    }
    const step = elementStep(el, sideSign)
    return { element: el, endPoint: { x: drawOrigin.x + step.dx, y: drawOrigin.y + step.dy } }
  }

  // ------ フリーハンド (勾配 % を 位置から 算出) ------
  if (drawMode === 'freehand') {
    // カーソル 必須 (dW/dH 手動 入力 は %/ratio 用)
    if (!cursor) return null
    const outwardDx = cursorDx * sideSign
    if (outwardDx < 1e-3) return null
    const width = Math.round(outwardDx * 1000) / 1000
    const pct = Math.round((cursorDy / outwardDx) * 100 * 100) / 100
    const el: CrossSectionElement = {
      id: newId(),
      name: '',
      width,
      slopeValue: pct,
      slopeUnit: 'percent',
    }
    const step = elementStep(el, sideSign)
    return { element: el, endPoint: { x: drawOrigin.x + step.dx, y: drawOrigin.y + step.dy } }
  }

  // ------ percent / ratio モード ------
  const rawInput = parseFloat(slopeText)
  if (!Number.isFinite(rawInput)) return null
  const hasExplicitSign = /^[+-]/.test(slopeText.trim())

  // dW を 決定: 手動 dW 最優先 → dH + 勾配 で 逆算 → カーソル X
  let width: number | null = null
  let signedSlope = rawInput
  const dhSignSource = dHIn !== null ? dHIn : cursorDy
  const dirSign = dhSignSource > 0 ? 1 : dhSignSource < 0 ? -1 : 1
  if (!hasExplicitSign) signedSlope = dirSign * Math.abs(rawInput)

  if (dWIn !== null && dWIn > 1e-6) {
    width = Math.abs(dWIn)
  } else if (dHIn !== null) {
    // 勾配 と dH から dW を 逆算 (dH = dW * slopeFactor)
    const slopeFactor =
      drawMode === 'percent'
        ? signedSlope / 100
        : Math.abs(signedSlope) < 1e-6
        ? 0
        : Math.sign(signedSlope) / Math.abs(signedSlope)
    if (Math.abs(slopeFactor) < 1e-9) return null
    width = Math.abs(dHIn / slopeFactor)
  } else if (cursor) {
    const outwardDx = cursorDx * sideSign
    if (outwardDx < 1e-3) return null
    width = outwardDx
  } else {
    return null
  }
  const wRounded = Math.round(width * 1000) / 1000
  if (wRounded < 1e-6) return null

  if (drawMode === 'ratio' && Math.abs(signedSlope) < 1e-6) return null

  const el: CrossSectionElement = {
    id: newId(),
    name: '',
    width: wRounded,
    slopeValue: signedSlope,
    slopeUnit: drawMode === 'percent' ? 'percent' : 'ratio',
  }
  const step = elementStep(el, sideSign)
  return { element: el, endPoint: { x: drawOrigin.x + step.dx, y: drawOrigin.y + step.dy } }
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
  const [zDraft, setZDraft] = useState<string>(() => trimFloat3(p.floorHeight))
  const [vclDraft, setVclDraft] = useState<string>(() => (p.vcl ? trimFloat3(p.vcl) : ''))
  // 外部 (別行 の コミット等) で 値が 変わった時 は ドラフト を 同期。
  // 「入力中」の この行 は onChangeCommit で 親を 更新するので 変わる → useEffect で
  // 同じ 文字列に 戻す (実質 no-op)。 他行 の 変更で この行 の p が 変わる こと は 通常 なし。
  useEffect(() => { setSpDraft(trimFloat3(p.distance + spOffset)) }, [p.distance, spOffset])
  useEffect(() => { setZDraft(trimFloat3(p.floorHeight)) }, [p.floorHeight])
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
      setZDraft(trimFloat3(p.floorHeight))
      return
    }
    const nextZ = Math.round(v * 1000) / 1000
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
 * DXF トレース モーダル: 選択測点 + 対象 (現況/計画/出来形) 向けに
 * 校正 (DL/中心線/縮尺) と トレース (LINE/LWPOLYLINE クリックで 点列 抽出) を 行う。
 */
function DxfTraceModal({
  channel,
  station,
  target,
  onClose,
  onSaveCalibration,
  onReplacePoints,
}: {
  channel: OpenChannelRow
  station: StationRow
  target: SectionTarget
  onClose: () => void
  onSaveCalibration: (calib: DxfCalibration) => void
  /** 「確定」ボタン で 呼ばれる。 対象断面の 点列を モーダル内 のもので 差替 */
  onReplacePoints: (pts: MeasuredCrossPoint[]) => void
}) {
  const stationSectionKey =
    target === 'current' ? 'currentSection' : target === 'asbuilt' ? 'asbuiltSection' : 'plannedSectionRaw'
  // モーダル内 で 編集する ローカル 点列 (確定 ボタン まで 元の 断面には 反映しない)
  const [localPoints, setLocalPoints] = useState<MeasuredCrossPoint[]>(() => {
    const initial = (station[stationSectionKey] as MeasuredCrossPoint[] | null | undefined) ?? []
    return initial.map((p) => ({ ...p }))
  })
  // station が 変わった場合 (基本 起きない) は 初期化し直す
  useEffect(() => {
    const initial = (station[stationSectionKey] as MeasuredCrossPoint[] | null | undefined) ?? []
    setLocalPoints(initial.map((p) => ({ ...p })))
    // station.id / target が 変わった 時だけ (点列 の 参照変化で 巻き戻さない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [station.id, target])
  const [dxfText, setDxfText] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  useEffect(() => {
    if (!channel.dxfCrossSectionPath) return
    let cancelled = false
    setLoading(true)
    setError(null)
    supabase.storage
      .from('open-channel-dxf')
      .download(channel.dxfCrossSectionPath)
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
  }, [channel.dxfCrossSectionPath])

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
      setLocalPoints((pts) => [
        ...pts,
        {
          id: `dxf-${now}-${rand()}`,
          offset: w.offset,
          elevation: w.elevation,
        },
      ])
      return
    }
  }
  const clearLocalPoints = () => setLocalPoints([])
  const undoLastPoint = () => setLocalPoints((pts) => pts.slice(0, -1))
  const confirmAndClose = () => {
    // offset で 昇順 に して 保存 (handleReplaceStationSection でも 並び替えるが 冗長)
    onReplacePoints([...localPoints].sort((a, b) => a.offset - b.offset))
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
  // 折れ線は 断面らしく offset 昇順 で 結ぶ (拾った順番と 独立)。
  const overlays = useMemo(() => {
    if (!parsedCalib) return []
    const color = SECTION_TARGET_META[target].color
    const toDxfXY = (p: MeasuredCrossPoint) => ({
      x: parsedCalib.centerX + (p.offset * 1000) / parsedCalib.hScale,
      y: parsedCalib.dlY + ((p.elevation - parsedCalib.dlElevation) * 1000) / parsedCalib.vScale,
    })
    const items: NonNullable<React.ComponentProps<typeof DxfCrossSectionViewer>['overlays']> = []
    // 折れ線 (offset 昇順)
    if (localPoints.length >= 2) {
      const sorted = [...localPoints].sort((a, b) => a.offset - b.offset)
      items.push({
        kind: 'line',
        color,
        pts: sorted.map(toDxfXY),
      })
    }
    // 各点 の マーカー + ラベル (H / d を 2 段 で 縦積み)
    for (const p of localPoints) {
      const xy = toDxfXY(p)
      items.push({
        kind: 'dot',
        x: xy.x,
        y: xy.y,
        color,
        label: [
          `H ${p.elevation.toFixed(3)}`,
          `d ${p.offset >= 0 ? '+' : ''}${p.offset.toFixed(3)}`,
        ],
      })
    }
    return items
  }, [parsedCalib, localPoints, target])

  // トレース仮線 の 出発点 = 直前に 拾った 1 点 (localPoints 末尾)。 校正済み で
  // 1 点以上 あれば DXF 座標に 逆マッピングして 渡す。
  const traceRubberBandFrom = useMemo<{ x: number; y: number } | null>(() => {
    if (!parsedCalib || localPoints.length === 0) return null
    const p = localPoints[localPoints.length - 1]
    return {
      x: parsedCalib.centerX + (p.offset * 1000) / parsedCalib.hScale,
      y: parsedCalib.dlY + ((p.elevation - parsedCalib.dlElevation) * 1000) / parsedCalib.vScale,
    }
  }, [parsedCalib, localPoints])

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

  const meta = SECTION_TARGET_META[target]

  return (
    <div className="fixed inset-0 bg-black/60 z-[3000] flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full h-full max-w-[95vw] max-h-[95vh] flex flex-col">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <h3 className="text-sm font-semibold">
            DXF から トレース —{' '}
            <span className="font-mono text-slate-600">{station.label}</span>{' '}
            <span className="text-slate-500">/</span>{' '}
            <span style={{ color: meta.color }}>{meta.label}</span>
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            title="閉じる"
          >
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="flex-1 min-h-0 flex">
          {/* 左サイドバー: 校正 + トレース操作 */}
          <div className="w-72 border-r p-3 overflow-y-auto text-xs flex flex-col gap-3 shrink-0">
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
                      title="直前 1 点を 取消 (BS でも 可)"
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

/**
 * 「既存横断図 (DXF)」 セクション の 中身。
 * 未取込: ファイル選択 → Storage アップロード
 * 取込済: ファイル名表示 + [表示] (モーダル) + [削除]
 */
function DxfCrossSectionSection({ selected }: { selected: OpenChannelRow | null }) {
  const { updateChannel } = useOpenChannelStore()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [dxfText, setDxfText] = useState<string | null>(null)
  const [loadingDxf, setLoadingDxf] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  if (!selected) {
    return (
      <div className="text-xs text-slate-400">線形物を 選択してください</div>
    )
  }

  const bucket = 'open-channel-dxf'
  const hasFile = !!selected.dxfCrossSectionPath

  const handleFileChosen = async (file: File | null) => {
    if (!file) return
    setError(null)
    setBusy(true)
    try {
      // 既存が あれば 先に 削除 (履歴は 残さず 1 本のみ)
      if (selected.dxfCrossSectionPath) {
        await supabase.storage.from(bucket).remove([selected.dxfCrossSectionPath])
      }
      const uid = (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2))
      const path = `${selected.farmId}/${selected.id}-${uid}.dxf`
      const { error: upErr } = await supabase.storage
        .from(bucket)
        .upload(path, file, { contentType: 'application/dxf', upsert: false })
      if (upErr) throw upErr
      await updateChannel(selected.id, {
        dxfCrossSectionPath: path,
        dxfCrossSectionName: file.name,
      })
      setDxfText(null) // 再取得を 促す
    } catch (e) {
      console.error('[dxf upload]', e)
      setError(e instanceof Error ? e.message : 'アップロード 失敗')
    } finally {
      setBusy(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async () => {
    if (!selected.dxfCrossSectionPath) return
    if (!window.confirm('DXF ファイルを 削除しますか?')) return
    setError(null)
    setBusy(true)
    try {
      await supabase.storage.from(bucket).remove([selected.dxfCrossSectionPath])
      await updateChannel(selected.id, {
        dxfCrossSectionPath: null,
        dxfCrossSectionName: null,
      })
      setDxfText(null)
    } catch (e) {
      console.error('[dxf delete]', e)
      setError(e instanceof Error ? e.message : '削除 失敗')
    } finally {
      setBusy(false)
    }
  }

  const openViewer = async () => {
    if (!selected.dxfCrossSectionPath) return
    setViewerOpen(true)
    if (dxfText) return
    setLoadingDxf(true)
    setError(null)
    try {
      const { data, error: dlErr } = await supabase.storage
        .from(bucket)
        .download(selected.dxfCrossSectionPath)
      if (dlErr || !data) throw dlErr ?? new Error('DL 失敗')
      const buf = await data.arrayBuffer()
      setDxfText(decodeDxfBytes(buf))
    } catch (e) {
      console.error('[dxf download]', e)
      setError(e instanceof Error ? e.message : '取得 失敗')
      setViewerOpen(false)
    } finally {
      setLoadingDxf(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        工区全体の 並べ図 (5 断面 等) を 1 枚 添付します。次コミット で
        「DL/中心線/縮尺」の キャリブレーション と 「トレース → 現況/計画 断面」への
        変換 を 追加予定。
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".dxf,application/dxf"
        onChange={(e) => handleFileChosen(e.target.files?.[0] ?? null)}
        className="hidden"
      />
      {hasFile ? (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-700 font-mono truncate max-w-[16rem]">
            {selected.dxfCrossSectionName ?? '(名前 不明)'}
          </span>
          <button
            onClick={openViewer}
            disabled={busy || loadingDxf}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            {loadingDxf ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eye className="h-3 w-3" />}
            表示
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
            差替
          </button>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded text-red-600 hover:bg-red-50 disabled:opacity-50"
          >
            <Trash2 className="h-3 w-3" />
            削除
          </button>
        </div>
      ) : (
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
          DXF を 取込
        </button>
      )}
      {error && (
        <div className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
          {error}
        </div>
      )}
      {viewerOpen && dxfText && (
        <div className="fixed inset-0 bg-black/60 z-[3000] flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full h-full max-w-[90vw] max-h-[90vh] flex flex-col p-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold">
                DXF プレビュー —{' '}
                <span className="font-mono text-slate-600">
                  {selected.dxfCrossSectionName ?? '(名前 不明)'}
                </span>
              </h3>
              <button
                onClick={() => setViewerOpen(false)}
                className="p-1 hover:bg-slate-100 rounded"
                title="閉じる"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <DxfCrossSectionViewer dxfText={dxfText} />
            </div>
          </div>
        </div>
      )}
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

  // 中間点計算 表の 表示列 (任意で 非表示 に できる)。 SP / 距離 / X / Y / 計画高 / 現況高
  // の 6 列 が トグル対象。 # と 断面 ボタン と 削除 は 常に 表示。
  type StationCol = 'sp' | 'distance' | 'x' | 'y' | 'planZ' | 'currentZ'
  const [visibleStationCols, setVisibleStationCols] = useState<Set<StationCol>>(
    () => new Set<StationCol>(['sp', 'distance', 'x', 'y', 'planZ', 'currentZ']),
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
    { key: 'planZ', label: '計画高' },
    { key: 'currentZ', label: '現況高' },
  ]
  // 表モーダル (現況断面 / 出来形 / 計画 の 手入力) の 対象 種別。null で 閉じている
  const [tableModalTarget, setTableModalTarget] = useState<SectionTarget | null>(null)
  // 地図から 現況/出来形/計画 点を 拾う モード。null で 通常
  const [mapCaptureTarget, setMapCaptureTarget] = useState<SectionTarget | null>(null)
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
  const handleUpdateStationCrossSection = (
    id: string,
    crossSection: StandardCrossSection | null,
  ) => {
    setStations(stations.map((s) => (s.id === id ? { ...s, crossSection } : s)))
  }
  /** 現況高 (中心線上の 地盤高) の 手入力を 保存。空文字 / NaN は null に。 */
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
   * offset で 昇順 に ソート。
   *   target='current' → currentGroundHeight を 中心補間値で 自動更新
   *   target='planned' → plannedCenterHeight を 中心補間値で 自動更新
   */
  const handleReplaceStationSection = (
    id: string,
    target: SectionTarget,
    points: MeasuredCrossPoint[],
  ) => {
    const key = sectionKeyOf(target)
    const sorted = [...points].sort((a, b) => a.offset - b.offset)
    let next = stations.map((s) => (s.id === id ? { ...s, [key]: sorted } : s))
    if (target === 'current') {
      next = applyCenterHeightFromSection(next, id, sorted, 'currentGroundHeight')
    } else if (target === 'planned') {
      next = applyCenterHeightFromSection(next, id, sorted, 'plannedCenterHeight')
    }
    setStations(next)
  }
  /**
   * 現況/出来形/計画 断面 に 点を 1 個 追加 (地図ピック / DXFトレース 用)。
   * 同じ id が あれば 上書き。 target='current'/'planned' なら 中心高を 自動更新。
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
      const filtered = existing.filter((p) => p.id !== point.id)
      const merged = [...filtered, point].sort((a, b) => a.offset - b.offset)
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
        <PageHeader title="線形物 線形登録" subtitle="水路・道路など / 線形 + 横断計画" />
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm">工区を選択してください</div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="線形物 線形登録" subtitle="水路・道路など / 線形 + 横断計画" />

      <div className="flex-1 flex overflow-hidden">
        {/* 左: 一覧 + 編集 */}
        <div className="w-[624px] overflow-auto p-3 bg-slate-50 border-r space-y-3">
          {/* 線形点 (BP → IP → EP) — 一番上、折りたたみ 可能。
              折りたたみ 中は 地図クリック による 追加が 抑止 される。 */}
          <CollapsibleSection
            title={`線形点 (BP → IP → EP)${selected ? ` · ${selected.name}` : ''}`}
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
                    {/* 表示列 トグル (SP / 距離 / X / Y / 計画高 / 現況高)。
                        # と 断面ボタン と 削除 は 常時 表示。 */}
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
                            {visibleStationCols.has('planZ') && (
                              <th className="px-2 py-1 w-24 text-right whitespace-nowrap" title="縦断線形から 自動取込">
                                計画高 (m)
                              </th>
                            )}
                            {visibleStationCols.has('currentZ') && (
                              <th className="px-2 py-1 w-24 text-right whitespace-nowrap" title="現況地盤高 を 直接入力">
                                現況高 (m)
                              </th>
                            )}
                            <th className="px-2 py-1 w-32 text-center whitespace-nowrap">断面</th>
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
                                {/* 計画高: plannedCenterHeight (トレース由来 or 手入力) を 最優先、
                                    無ければ 縦断線形から 内挿 (範囲外は null)。 どちらも 無ければ "-"。 */}
                                {visibleStationCols.has('planZ') && (() => {
                                  const fromPlanned = s.plannedCenterHeight ?? null
                                  const fromProfile = selected
                                    ? interpolateProfileZOrNull(selected.profilePoints, s.distance)
                                    : null
                                  const value = fromPlanned ?? fromProfile
                                  const source = fromPlanned != null ? 'トレース/入力' : fromProfile != null ? '縦断線形' : null
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
                                {visibleStationCols.has('currentZ') && (
                                  <td className="px-1 py-1 text-right whitespace-nowrap">
                                    <input
                                      type="number"
                                      step={0.001}
                                      defaultValue={s.currentGroundHeight ?? ''}
                                      onClick={(e) => e.stopPropagation()}
                                      onBlur={(e) => handleUpdateStationCurrentHeight(s.id, e.target.value)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          e.currentTarget.blur()
                                        }
                                      }}
                                      placeholder="-"
                                      className="w-full px-1 py-0.5 border rounded text-right tabular-nums text-amber-700 bg-amber-50/40"
                                    />
                                  </td>
                                )}
                                <td className="px-1 py-1 text-center">
                                  {/* 現況 / 計画 / 出来形 — 計画 は 押下時 に 測点 を 選択 し、
                                      横断計画 未取込 なら 標準断面 を 複製 して エディタ を 開く。
                                      現況 / 出来形 は 現状 未実装 (今後 実測 データ を 参照 予定)。 */}
                                  <div className="inline-flex gap-0.5">
                                    <button
                                      onClick={(e) => e.stopPropagation()}
                                      title="現況 (未実装)"
                                      className="px-1 py-0.5 text-[10px] border rounded bg-slate-50 hover:bg-slate-100 text-slate-700"
                                    >
                                      現況
                                    </button>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setSelectedStationId(s.id)
                                        if (!s.crossSection && selected) {
                                          handleUpdateStationCrossSection(
                                            s.id,
                                            cloneCrossSection(selected.standardCrossSection),
                                          )
                                        }
                                        // 右下パネル を 横断図 タブ に 切替 + 展開
                                        setBottomTab('crossSection')
                                        if (!profileChartExpanded) toggleProfileChart()
                                      }}
                                      title="この測点の計画断面を編集"
                                      className={`px-1 py-0.5 text-[10px] border rounded ${
                                        s.crossSection
                                          ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                                          : 'bg-blue-50 hover:bg-blue-100 text-blue-700'
                                      }`}
                                    >
                                      計画
                                    </button>
                                    <button
                                      onClick={(e) => e.stopPropagation()}
                                      title="出来形 (未実装)"
                                      className="px-1 py-0.5 text-[10px] border rounded bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                                    >
                                      出来形
                                    </button>
                                  </div>
                                </td>
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
                        の 断面 編集 は 右下 の <span className="font-semibold">横断図</span>{' '}
                        タブ で 行い ます (計画 ボタン で 切替)。
                      </div>
                    )}
                  </>
                )}
              </CollapsibleSection>

              {/* 幅杭計算 (中間点 と 縦断線形 の 間 に 配置)。
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

              {/* 既存横断図 (DXF) — 工区全体の 並べ図 1 枚を 添付し、レイヤ切替 + パン/ズーム
                  で 確認できる。次コミット で 「DL/中心線/縮尺」の キャリブレーション と、
                  ライン クリック → 現況/計画 断面点 への 変換 (トレース) を 追加予定。 */}
              <CollapsibleSection title="既存横断図 (DXF)" storageKey="oc:section:dxf">
                <DxfCrossSectionSection selected={selected} />
              </CollapsibleSection>

              {/* 縦断線形 (中間点 と 標準断面 の 間 に 配置)。
                  縦断図 の プロット は 地図の 下に 残す。ここでは 変化点 の
                  追加 / 編集 / 削除 のみ。追加 は テーブル 末尾 の 空行 に
                  直接 入力 (Enter or + ボタン で 確定)。 */}
              <CollapsibleSection title="縦断線形" storageKey="oc:section:profile">
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

              {/* 横断計画 の 編集 は 右下 パネル の 横断図 タブ に 移動。
                  中間点 の 計画 ボタン 押下 で 該当測点、選択なし の 場合 は
                  標準断面 を 編集 する。 */}
            </>
          )}
        </div>

        {/* 右: 地図 (上) + 縦断図 (下) */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <div className="flex-1 min-h-0 relative overflow-hidden isolate">
            <CoordinateMap
              farmId={farmId ?? null}
              showLabels
              checkedCoordIds={registeredCoordIds}
              onPointSelect={handlePickCoordFromMap}
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
                  <div key={`ws-${stake.id}`}>
                    <Polyline
                      positions={[
                        [centerLL.lat, centerLL.lng],
                        [stakeLL.lat, stakeLL.lng],
                      ]}
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
                    key={s.id}
                    center={[ll.lat, ll.lng]}
                    radius={isSel ? 6 : 4}
                    eventHandlers={{
                      click: () => setSelectedStationId(isSel ? null : s.id),
                    }}
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

          {/* 地図下 の 二面パネル: 縦断図 / 横断図 を タブ で 切替。
              - 縦断図: 変化点 の 編集 UI は 左サイドバー 「縦断線形」に。
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
                    ? '変化点 の 追加 / 編集 は 左サイドバー 「縦断線形」から'
                    : selectedStation
                    ? `${selectedStation.label} の 計画断面`
                    : '横断計画 (標準断面) — 中間点 で 計画 を 押すと 個別 に 編集 できます'}
                </span>
              </div>
              {profileChartExpanded && bottomTab === 'profile' && (
                <div className="flex-1 min-h-0 px-2 pb-2">
                  <ProfileChart points={selected.profilePoints} totalLen={totalLen} spOffset={spOffset} />
                </div>
              )}
              {profileChartExpanded && bottomTab === 'crossSection' && (
                <div className="flex-1 min-h-0 flex flex-col p-2 gap-2">
                  {(() => {
                    // 編集対象 = 選択測点 の 個別断面 (あれば) / それ以外 は 標準断面
                    const editingStation =
                      selectedStation && selectedStation.crossSection ? selectedStation : null
                    const cs: StandardCrossSection = editingStation
                      ? editingStation.crossSection!
                      : selected.standardCrossSection
                    const applyChange = (next: StandardCrossSection) => {
                      if (editingStation) {
                        handleUpdateStationCrossSection(editingStation.id, next)
                      } else {
                        updateChannel(selected.id, { standardCrossSection: next })
                      }
                    }
                    // 計画高 (中心設計高) の 優先順位:
                    //   1. plannedCenterHeight (トレース由来 or 手入力)
                    //   2. profilePoints から 内挿 (範囲外なら null → undefined 扱い)
                    //   3. undefined (未取得)
                    const centerZ = selectedStation
                      ? (selectedStation.plannedCenterHeight ??
                          interpolateProfileZOrNull(selected.profilePoints, selectedStation.distance) ??
                          undefined)
                      : undefined
                    return (
                      <>
                        {/* ヘッダー: 対象 表示 + 個別/標準 切替 */}
                        <div className="flex items-center gap-2 flex-wrap text-xs shrink-0">
                          {selectedStation ? (
                            <>
                              <span className="font-mono font-semibold text-slate-700">
                                {selectedStation.label}
                              </span>
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
                              {/* 編集対象 の 切替 (現況 / 計画 / 出来形)。
                                  計画 = 従来の Interactive エディタ、現況 = 地図拾い or 表モーダル、
                                  出来形 = プレースホルダ (次ステップ) */}
                              <div className="flex items-center gap-0.5 border-l pl-2 ml-1">
                                <span className="text-[10px] text-slate-500 mr-0.5">編集</span>
                                {([
                                  { key: 'current' as EditTarget, label: '現況', act: 'bg-amber-500 text-white border-amber-500', idle: 'bg-white text-amber-700 border-amber-300 hover:bg-amber-50' },
                                  { key: 'plan' as EditTarget, label: '計画', act: 'bg-blue-600 text-white border-blue-600', idle: 'bg-white text-blue-700 border-blue-300 hover:bg-blue-50' },
                                  { key: 'asbuilt' as EditTarget, label: '出来形', act: 'bg-emerald-600 text-white border-emerald-600', idle: 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50' },
                                ]).map((b) => (
                                  <button
                                    key={b.key}
                                    onClick={() => {
                                      setEditTarget(b.key)
                                      // 対象を 切り替えたら 地図ピック モードは 解除
                                      setMapCaptureTarget(null)
                                    }}
                                    className={`px-2 py-0.5 text-[11px] border rounded ${
                                      editTarget === b.key ? b.act : b.idle
                                    }`}
                                  >
                                    {b.label}
                                  </button>
                                ))}
                              </div>
                              <div className="ml-auto flex gap-1">
                                {selectedStation.crossSection ? (
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

                        {/* 現況 / 計画(トレース) / 出来形 モード の 補助 アクション バー。
                            計画モード (editTarget='plan') は 対話型 element エディタが 主。
                            editTarget='current' → target=current、'asbuilt' → target=asbuilt、
                            'plan' → target=planned (トレース由来 plannedSectionRaw)。 */}
                        {selectedStation && (() => {
                          // editTarget を SectionTarget に マップ (plan → planned)
                          const target: SectionTarget =
                            editTarget === 'current' ? 'current'
                            : editTarget === 'asbuilt' ? 'asbuilt'
                            : 'planned'
                          const showAuxBar = editTarget === 'current' || editTarget === 'asbuilt' || editTarget === 'plan'
                          if (!showAuxBar) return null
                          const isMapMode = editTarget === 'current' || editTarget === 'asbuilt'
                          const labelPrefix =
                            editTarget === 'current' ? '現況断面: '
                            : editTarget === 'asbuilt' ? '出来形: '
                            : '計画 (トレース): '
                          const pts = ((): MeasuredCrossPoint[] => {
                            const key = target === 'current' ? 'currentSection' : target === 'asbuilt' ? 'asbuiltSection' : 'plannedSectionRaw'
                            return (selectedStation[key] as MeasuredCrossPoint[] | null | undefined) ?? []
                          })()
                          return (
                            <div className="flex items-center gap-1.5 flex-wrap text-xs shrink-0">
                              <span className="text-slate-500 text-[11px]">{labelPrefix}</span>
                              {isMapMode && (
                                <button
                                  onClick={() => {
                                    if (mapCaptureTarget === target) {
                                      setMapCaptureTarget(null)
                                    } else {
                                      setMapCaptureTarget(target)
                                    }
                                  }}
                                  className={`px-2 py-0.5 text-[11px] border rounded ${
                                    mapCaptureTarget === target
                                      ? 'bg-purple-600 text-white border-purple-600'
                                      : 'bg-white text-purple-700 border-purple-300 hover:bg-purple-50'
                                  }`}
                                  title="地図で 測点マーカーを クリック すると 中心線に 垂直投影 して 追加"
                                >
                                  {mapCaptureTarget === target ? '地図取得: 選択中' : '地図で追加'}
                                </button>
                              )}
                              <button
                                onClick={() => setTableModalTarget(target)}
                                className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                              >
                                表で入力
                              </button>
                              {selected?.dxfCrossSectionPath && (
                                <button
                                  onClick={() =>
                                    setDxfTraceContext({ stationId: selectedStation.id, target })
                                  }
                                  className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                                  title="既存 DXF 横断図 から トレースして 点を 拾う"
                                >
                                  DXFから取込
                                </button>
                              )}
                              <span className="text-[11px] text-slate-500">
                                登録済 {pts.length} 点
                              </span>
                              <button
                                onClick={() => {
                                  if (!window.confirm('この 測点の 全点を 削除します。')) return
                                  handleReplaceStationSection(selectedStation.id, target, [])
                                }}
                                className="ml-auto px-2 py-0.5 text-[11px] border rounded text-red-600 hover:bg-red-50"
                              >
                                クリア
                              </button>
                            </div>
                          )
                        })()}

                        {/* 対話 型 断面 エディタ
                            prev/next は 現在 選択中の 測点の 前後の 測点に ジャンプ。
                            標準断面 (selectedStation なし) の 時は 前=最終測点、次=先頭測点
                            に フォールバック (どちらの 状態からも 巡回できる)。 */}
                        {(() => {
                          const currentIdx = selectedStation
                            ? stations.findIndex((s) => s.id === selectedStation.id)
                            : -1
                          const prevStation = selectedStation
                            ? currentIdx > 0
                              ? stations[currentIdx - 1]
                              : null
                            : stations.length > 0
                              ? stations[stations.length - 1]
                              : null
                          const nextStation = selectedStation
                            ? currentIdx >= 0 && currentIdx < stations.length - 1
                              ? stations[currentIdx + 1]
                              : null
                            : stations.length > 0
                              ? stations[0]
                              : null
                          return (
                            <div className="flex-1 min-h-0">
                              <InteractiveCrossSectionEditor
                                cs={cs}
                                onChange={applyChange}
                                centerHeight={centerZ}
                                currentGroundHeight={selectedStation?.currentGroundHeight ?? null}
                                currentSection={selectedStation?.currentSection ?? null}
                                asbuiltSection={selectedStation?.asbuiltSection ?? null}
                                onPrevStation={
                                  prevStation
                                    ? () => setSelectedStationId(prevStation.id)
                                    : undefined
                                }
                                onNextStation={
                                  nextStation
                                    ? () => setSelectedStationId(nextStation.id)
                                    : undefined
                                }
                                canPrev={!!prevStation}
                                canNext={!!nextStation}
                                prevLabel={prevStation?.label}
                                nextLabel={nextStation?.label}
                              />
                            </div>
                          )
                        })()}
                      </>
                    )
                  })()}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 現況/計画/出来形 手入力 モーダル */}
      {tableModalTarget && selectedStation && (
        <MeasuredSectionTableModal
          target={tableModalTarget}
          stationLabel={selectedStation.label}
          initialPoints={
            tableModalTarget === 'current'
              ? (selectedStation.currentSection ?? [])
              : tableModalTarget === 'asbuilt'
                ? (selectedStation.asbuiltSection ?? [])
                : (selectedStation.plannedSectionRaw ?? [])
          }
          onSave={(pts) =>
            handleReplaceStationSection(selectedStation.id, tableModalTarget, pts)
          }
          onClose={() => setTableModalTarget(null)}
        />
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
            onClose={() => setDxfTraceContext(null)}
            onSaveCalibration={(c) => handleUpdateStationCalibration(st.id, c)}
            onReplacePoints={(pts) =>
              handleReplaceStationSection(st.id, dxfTraceContext.target, pts)
            }
          />
        )
      })()}
    </div>
  )
}
