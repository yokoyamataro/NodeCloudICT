// 線形物（水路・道路）— 線形登録ページ
//
// - 工区ごとに複数の線形物を登録可能
// - 各線形物は平面線形（BP→IP→EP、IP は角 or 単曲線 R）+ 縦断 + 標準断面で定義
// - 標準断面は中心から右/左に並ぶ要素列（幅・勾配[1:i または %]）
// - 座標管理の点を参照する
// - 地図で線形（直線 + 曲線）をプレビュー

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { AlignmentReportKind } from './alignmentReport'
import { CrossSectionDxfModal } from './CrossSectionDxfModal'
import { Polyline, CircleMarker, useMap, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Plus, Trash2, ArrowUp, ArrowDown, ChevronRight, ChevronDown, Pencil, Check, X, Upload, Loader2, Calculator } from 'lucide-react'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import { StandardSectionPickerModal } from './StandardSectionModals'
import { ReverseStakePanel, type ReverseStakeRow } from './ReverseStakePanel'
import {
  useCoordinatePointTypeStore,
  getCoordinateTypeOptions,
} from '@/stores/coordinatePointTypeStore'
import { KEEP_SOURCE_TYPE, defaultStakeName } from './stakeName'
import { GridTable, type GridCellRef } from './GridTable'
import {
  gridLineIndices,
  gridLineName,
  gridLineOffset,
  gridPlanFromExtent,
  gridPointName,
  pointNearOffset,
  type GridExtent,
} from '@/lib/openChannel/gridLines'
import {
  StakeoutModal,
  type PickTarget,
  type ResolvedChohari,
  type ResolvedTombo,
} from './StakeoutModal'
import { labelOfPoint } from './sectionPointLabel'
import {
  SEGMENT_INPUT_MODES,
  factorToSlope,
  groundElevationAt,
  intersectGround,
  isInputField,
  slopeToFactor,
  solveSegment,
  type SegmentField,
  type SegmentInputMode,
} from './segmentMath'
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
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import {
  useOpenChannelStore,
  type AlignmentPoint,
  type AlignmentPointKind,
  type ProfilePoint,
  type ExtraProfile,
  type CrossSectionElement,
  type StandardCrossSection,
  type StationRow,
  type SideOrientation,
  type WidthStake,
  type MeasuredCrossPoint,
  type ChannelKind,
  type TomboPoint,
  type ChohariPoint,
  type OpenChannelRow,
  type DxfCalibration,
  type DxfCrossSectionFile,
  buildCrossSectionPath,
  elementStep,
  elementSlopePerMeter,
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
  projectPointToAlignment,
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
/**
 * 標準断面 の 片側 を 点 に 展開 する。
 *
 * 「現況まで」 (element.toGround) の 区間 は 現況断面 と の 交点 で 長さ が
 * 決まる。 現況 が 無い / 交わら ない ときは その 区間 で 打ち切る
 * (truncated=true)。 手前 まで の 区間 は そのまま 使える ので 捨て ない。
 */
function resolveStandardSide(
  elems: CrossSectionElement[],
  sideSign: 1 | -1,
  center: { offset: number; elevation: number },
  ground: MeasuredCrossPoint[] | null,
): {
  pts: { offset: number; elevation: number }[]
  truncated: boolean
  /** 打ち切った とき の 理由 (画面 に そのまま 出す) */
  reason?: string
} {
  const pts: { offset: number; elevation: number }[] = []
  let cur = { ...center }
  for (const e of elems) {
    if (e.toGround) {
      const r = solveSegment(
        'toGround',
        {
          width: null,
          height: null,
          slopeFactor: elementSlopePerMeter(e),
          length: null,
          marginW: e.toGround.marginW,
        },
        { from: cur, sideSign, ground: ground ?? null },
      )
      if (!r.ok) {
        const label = e.name ? e.name : '名前なし'
        return { pts, truncated: true, reason: `区間「${label}」: ${r.error}` }
      }
      cur = {
        offset: cur.offset + sideSign * r.value.w,
        elevation: cur.elevation + r.value.h,
      }
    } else {
      const { dx, dy } = elementStep(e, sideSign)
      cur = { offset: cur.offset + dx, elevation: cur.elevation + dy }
    }
    pts.push({ ...cur })
  }
  return { pts, truncated: false }
}

/**
 * 標準断面 → 測点 の 点列。 並び は 「左外 → 中心 → 右外」。
 * ground を 渡す と 「現況まで」 の 区間 を 解決 する。
 */
function standardCsToMeasuredPoints(
  cs: StandardCrossSection,
  centerHeight: number,
  ground?: MeasuredCrossPoint[] | null,
): { points: MeasuredCrossPoint[]; truncated: boolean; reasons: string[] } {
  const center = { offset: 0, elevation: centerHeight }
  const g = ground ?? null
  const l = resolveStandardSide(cs.left, -1, center, g)
  const r = resolveStandardSide(cs.right, 1, center, g)
  const seq = [...l.pts].reverse().concat([center], r.pts)
  const stamp = Date.now().toString(36)
  return {
    points: seq.map((p, i) => ({
      id: `pcs-${stamp}-${i}`,
      offset: Math.round(p.offset * 1000) / 1000,
      elevation: Math.round(p.elevation * 1000) / 1000,
    })),
    truncated: l.truncated || r.truncated,
    reasons: [
      ...(l.reason ? ['左 — ' + l.reason] : []),
      ...(r.reason ? ['右 — ' + r.reason] : []),
    ],
  }
}

/**
 * 点列 を 標準断面 (element 列、percent / vertical) に 逆変換 する。
 * DXF トレース 保存 → station.crossSection 側 の 同期 に 使用。
 *   - offset > 0 は 右側、< 0 は 左側
 *   - dx = 0 は vertical、それ 以外 は percent (勾配 = dy/dx * 100)
 * 中心 (offset=0) が 点 に 含まれ ない 場合 は 中心 = (0, centerHeight) を 仮想 起点 に する。
 *
 * 点列 は 「左外 → 中心 → 右外」 の 並び で 渡って くる 前提 で、その 並び を
 * 崩さ ない (離れ 順 に 並べ 替え ない)。 オーバーハング (外 へ 出て から 内 へ
 * 戻る) が ある と 離れ で は 順序 が 決まら ない ため。 内 へ 戻る 区間 は
 * 幅 が 負 の 要素 に なる (elementStep は 符号 を そのまま 使う)。
 */
function measuredPointsToStandardCs(
  points: MeasuredCrossPoint[],
  centerHeight: number,
): StandardCrossSection {
  // 右 は 中心 → 外 の 並び。 左 は 外 → 中心 で 入って くる ので 反転 する
  const right = points.filter((p) => p.offset > 1e-9)
  const left = points.filter((p) => p.offset < -1e-9).slice().reverse()
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
      // 外向き を 正 に した 幅。 内 へ 戻る 区間 は 負 に なり、
      // elementStep が そのまま 逆向き に 積む ので 形 が 保たれる
      const dx = (p.offset - prevX) * sideSign
      const dy = p.elevation - prevY
      const id = `pcs-${sideSign > 0 ? 'r' : 'l'}-${i}-${Math.random()
        .toString(36)
        .slice(2, 6)}`
      if (Math.abs(dx) < 1e-9) {
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
/**
 * 中心 から の 離れ を 杭 の 札 の 書き方 で。 左右 を 頭 に 付ける (L15.42)。
 * 距離 は cm まで で 足りる ので 小数 2 桁。
 */
function shiftText(offset: number): string {
  const side = offset > 1e-9 ? 'R' : offset < -1e-9 ? 'L' : 'CL'
  return side === 'CL' ? 'CL' : side + Math.abs(offset).toFixed(2)
}

/**
 * 法勾配 を i 表記 で。 1:n の n を 出す (i=1.60)。
 * 水平 は 勾配 が 決まら ない ので そのまま 「水平」。
 */
function slopeIText(dOffset: number, dElevation: number): string {
  if (Math.abs(dElevation) < 1e-9) return '水平'
  return 'i=' + Math.abs(dOffset / dElevation).toFixed(2)
}

/**
 * 杭 の 長さ の 目安 表記。 現場 で 用意 する 材 の 長さ な ので
 * 10cm 単位 に 丸める (約0.5m / 約1.2m など)。
 */
function roughMeters(v: number): string {
  return '約' + (Math.round(v * 10) / 10).toFixed(1) + 'm'
}

/**
 * 符号 を 付けた 短い 数値 表記 (トンボ の W / H 用)。
 * 末尾 の 0 は 落とす が 小数 第 1 位 まで は 残す (+1 → +1.0)。
 */
function signed(v: number): string {
  const body = (Math.round(v * 1000) / 1000)
    .toFixed(3)
    .replace(/0+$/, '')
    .replace(/\.$/, '.0')
  return v >= 0 ? '+' + body : body
}

/** 追加 縦断 の 既定色。 主縦断 (#0ea5e9) と 現況線 (#a16207) は 避ける */
const EXTRA_PROFILE_COLORS = [
  '#7c3aed',
  '#db2777',
  '#0d9488',
  '#ea580c',
  '#4338ca',
  '#65a30d',
]

/**
 * 縦断 の 変化点列 を SVG パス に する。
 * VCL > 0 の 変化点 は BVC → 放物線 20 分割 → EVC で 追従 し PVI (角) は 通らない。
 * 曲線 が 無い 変化点 は そのまま 通る。
 */
function buildProfilePath(
  sorted: ProfilePoint[],
  curveByPvi: Map<number, VerticalCurve>,
  tx: (d: number) => number,
  ty: (h: number) => number,
): string {
  const parts: string[] = []
  let started = false
  const moveTo = (d: number, h: number) => {
    parts.push(`${started ? 'L' : 'M'} ${tx(d)} ${ty(h)}`)
    started = true
  }
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    const c = curveByPvi.get(i)
    if (c) {
      moveTo(c.bvcDistance, c.bvcHeight)
      const SAMPLES = 20
      for (let k = 1; k <= SAMPLES; k++) {
        const x = (c.vcl * k) / SAMPLES
        const d = c.bvcDistance + x
        const h =
          c.bvcHeight +
          (c.i1Percent / 100) * x +
          ((c.i2Percent - c.i1Percent) / (200 * c.vcl)) * x * x
        moveTo(d, h)
      }
    } else {
      moveTo(p.distance, p.floorHeight)
    }
  }
  return parts.join(' ')
}

function ProfileChart({
  points,
  extraProfiles,
  totalLen,
  spOffset = 0,
  currentGroundPoints,
}: {
  points: ProfilePoint[]
  /**
   * 主縦断 と 別 に 重ねて 出す 縦断 (道路高 / 側溝高 など)。
   * 高さ レンジ の 計算 にも 参加 する。
   */
  extraProfiles?: ExtraProfile[]
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
  // 追加 の 縦断 も レンジ に 入れる (枠 から はみ出して 見え なく なら ない ように)
  for (const ep of extraProfiles ?? []) {
    for (const p of ep.points) {
      if (Number.isFinite(p.floorHeight)) heightSamples.push(p.floorHeight)
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
  const curveByPvi = new Map<number, VerticalCurve>()
  for (const c of curves) curveByPvi.set(c.pviIndex, c)
  const path = buildProfilePath(sorted, curveByPvi, tx, ty)

  // 追加 の 縦断。 主縦断 と 同じ 座標 変換 / 同じ 曲線 の 扱い で 重ねる。
  const extraLines = (extraProfiles ?? []).map((ep, i) => {
    const ps = [...ep.points].sort((a, b) => a.distance - b.distance)
    const map = new Map<number, VerticalCurve>()
    for (const c of computeVerticalCurves(ps)) map.set(c.pviIndex, c)
    return {
      id: ep.id,
      name: ep.name,
      color: ep.color ?? EXTRA_PROFILE_COLORS[i % EXTRA_PROFILE_COLORS.length],
      points: ps,
      d: ps.length >= 2 ? buildProfilePath(ps, map, tx, ty) : '',
    }
  })

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
      <div className="text-[11px] text-slate-500 flex items-center gap-2 shrink-0 px-1 py-0.5 flex-wrap">
        {extraLines.length > 0 && (
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <svg width="16" height="6">
                <line x1={0} y1={3} x2={16} y2={3} stroke="#0ea5e9" strokeWidth={2} />
              </svg>
              <span>中心 (主)</span>
            </span>
            {extraLines.map((ex) => (
              <span key={ex.id} className="flex items-center gap-1">
                <svg width="16" height="6">
                  <line x1={0} y1={3} x2={16} y2={3} stroke={ex.color} strokeWidth={2} />
                </svg>
                <span>{ex.name}</span>
              </span>
            ))}
          </span>
        )}
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

          {/* 追加 の 縦断。 主縦断 より 細く し、 点 も 小さめ に して 主従 を 付ける */}
          {extraLines.map((ex) => (
            <g key={ex.id}>
              {ex.d && (
                <path
                  d={ex.d}
                  fill="none"
                  stroke={ex.color}
                  strokeWidth={1.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  opacity={0.9}
                />
              )}
              {ex.points.map((p, i) => (
                <circle
                  key={i}
                  cx={tx(p.distance)}
                  cy={ty(p.floorHeight)}
                  r={2.5}
                  fill={ex.color}
                  stroke="#fff"
                  strokeWidth={1}
                />
              ))}
            </g>
          ))}

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
/**
 * 計算 中 の 線分 の プレビュー。 表 の ダイアログ と 断面図 で 共有 する。
 * from → original が いま の 線分、 from → to が 仮 の 位置。
 */
type CalcPreview = {
  from: { offset: number; elevation: number }
  original: { offset: number; elevation: number }
  to: { offset: number; elevation: number } | null
  /**
   * 確定 したら こう なる、 その 点 より 外側 の 点 (仮)。
   * 保持 なら いま の まま、 スライド なら 同じ 量 ずらした もの。
   * 仮 の 断面 の 形 を 図 に 出す ため に 使う。
   */
  outer?: { offset: number; elevation: number }[]
}


/**
 * 計画 の 1 点 を 「前 の 点 から の 勾配 と 幅 / 直高」 で 置く ダイアログ。
 *
 * 規約 は 標準断面 の 要素 (elementStep) と 同じ。
 *   - 幅   : 前 の 点 から 外 へ 向かう 水平距離 [m]。 負 に すると 内 へ 戻る
 *            (オーバーハング)。
 *   - 勾配 : 外 へ 1m 進む ごと の 上がり [m]。 + が 上がり。
 *            % は value/100、 比率 は 1:n と 読み 1/n。 比率 の 0 は 不可。
 *   - 直高 : 前 の 点 から の 上下 [m]。 + が 上。
 *
 * 幅 と 直高 は 「前 の 点 から の 差」 な ので、 断面 の 表 と 同じ 絶対値
 * (離れ / 標高) も 並べて 出し、 どちら から でも 入れられる ように する。
 *   離れ (中心 から の 距離、 左右 とも 正) = |前 の 点 の 離れ| + 幅
 *   標高                                    = 前 の 点 の 標高       + 直高
 *
 * 3 つ の うち 2 つ が 決まれば 残り は 決まる。 どれ を 自動計算 に する か は
 * 「自動計算」 の ボタン で 選ぶ。 自動計算 の 欄 は 灰色 で 編集 できない。
 * 切り替える とき は それまで 計算 で 出て いた 値 を その 欄 に 固定 する ので、
 * 「幅 と 直高 で 勾配 を 見る」 → 「その 勾配 と 標高 で 幅 を 出す」 と 繋げられる。
 *
 * 開いた 直後 は 自動計算 = 勾配。 いま の 点 の 幅 / 直高 が 入って いる ので、
 * 既存 の 点 の 「現在 の 勾配」 を そのまま 読める。
 */
function PlanPointCalcModal({
  prev,
  side,
  original,
  outerCount,
  ground,
  onPreview,
  onApply,
  onNavigate,
  hasPrev,
  hasNext,
  onClose,
}: {
  /** 基準 に する 点 (表 の 1 つ 内側、 無ければ 中心) */
  prev: { offset: number; elevation: number }
  side: 'left' | 'right'
  /** いま の この 点。 初期値 と 「元 の 位置」 の 表示 に 使う */
  original: { offset: number; elevation: number }
  /** この 点 より 外側 に 残って いる 行数。 1 以上 なら 保持 / スライド を 選ばせる */
  outerCount: number
  /**
   * この 測点 の 現況断面。 「勾配 ～ 現況まで」 の 交点 計算 に 使う。
   * 無い / 2 点 未満 の ときは その 入力方法 が エラー に なる。
   */
  ground?: MeasuredCrossPoint[] | null
  /** 図 に 出す 仮 の 位置 と、 外側 を ずらす か。 入力 が 足り なければ null */
  onPreview: (to: { offset: number; elevation: number } | null, slide: boolean) => void
  onApply: (next: { offset: number; elevation: number }, slide: boolean) => void
  /** 前 / 次 の 計画点 へ 移る。 端 なら null */
  onNavigate?: (dir: -1 | 1) => void
  hasPrev?: boolean
  hasNext?: boolean
  onClose: () => void
}) {
  const sideSign = side === 'left' ? -1 : 1
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  /** 中心 から の 距離 (左右 とも 正)。 表 の 「離れ」 と 同じ 見せ方 */
  const prevAbs = Math.abs(prev.offset)
  // 開いた ときの 値。 確定 して も 「最初に戻す」 が 効く ように 固定 する。
  // 別 の 点 へ 移る ときは key で 作り直す ので ここ も 入れ替わる。
  const [initW] = useState(() => r3((original.offset - prev.offset) * sideSign))
  const [initH] = useState(() => r3(original.elevation - prev.elevation))

  const initDist = r3(prevAbs + initW)
  const initElev = r3(prev.elevation + initH)

  const [unit, setUnit] = useState<'percent' | 'ratio'>('percent')
  /** 4 つ の うち どの 2 つ を 入力 に する か */
  const [mode, setMode] = useState<SegmentInputMode>('widthHeight')
  const [slopeText, setSlopeText] = useState('')
  const [lengthText, setLengthText] = useState(String(r3(Math.hypot(initW, initH))))
  /** 「現況まで」 の とき、 交点 から さらに 伸ばす 幅 */
  const [marginText, setMarginText] = useState('')
  // 幅 と 離れ (直高 と 標高) は 同じ 値 の 別 の 見方。 打った 側 の 文字 を
  // そのまま 残す ため 両方 を 文字列 で 持つ。 片方 を 計算 で 作り直すと
  // 1 文字 打つ たび に 整形 され、 カーソル が 末尾 へ 飛んで しまう。
  const [widthText, setWidthText] = useState(String(initW))
  const [distText, setDistText] = useState(String(initDist))
  const [heightText, setHeightText] = useState(String(initH))
  const [elevText, setElevText] = useState(String(initElev))
  const [slide, setSlide] = useState(false)
  /** ダイアログ の 移動量 (見たい 所 が 隠れる ので 動かせる ように する) */
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [drag, setDrag] = useState<{
    sx: number
    sy: number
    ox: number
    oy: number
  } | null>(null)

  useEffect(() => {
    if (!drag) return
    const onMove = (e: MouseEvent) =>
      setPos({ x: drag.ox + (e.clientX - drag.sx), y: drag.oy + (e.clientY - drag.sy) })
    const onUp = () => setDrag(null)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [drag])

  const num = (t: string) => {
    const v = parseFloat(t)
    return t.trim() !== '' && Number.isFinite(v) ? v : null
  }

  // 幅 / 直高 / 勾配 / 法長 の うち 2 つ で 区間 が 決まる。 解く の は 共通 の
  // segmentMath。 標準断面 の 区間 と 同じ 規則 に する ため。
  const svIn = isInputField(mode, 'slope') ? num(slopeText) : null
  const solved = solveSegment(
    mode,
    {
      width: isInputField(mode, 'width') ? num(widthText) : null,
      height: isInputField(mode, 'height') ? num(heightText) : null,
      slopeFactor: svIn == null ? null : slopeToFactor(svIn, unit),
      length: isInputField(mode, 'length') ? num(lengthText) : null,
      marginW: num(marginText) ?? 0,
    },
    // 「現況まで」 は 基準点 から 外 へ 伸ばして 現況線 と ぶつける
    { from: prev, sideSign, ground: ground ?? null },
  )
  const dW = solved.ok ? solved.value.w : null
  const dH = solved.ok ? solved.value.h : null
  const err = solved.ok ? '' : solved.error
  /** 幅 が 0 の とき 勾配 は 決まら ない (直立)。 位置 は 決まる ので エラー に しない */
  const factorOut = solved.ok ? solved.value.f : null

  const nextOffset = dW == null ? null : r3(prev.offset + sideSign * dW)
  const nextElevation = dH == null ? null : r3(prev.elevation + dH)
  const ok = !err && nextOffset != null && nextElevation != null

  // 手入力 の 欄 は 打った 文字 を、 自動計算 の 欄 は 計算 値 を 出す
  const auto = (k: SegmentField) => !isInputField(mode, k)
  const shownSlope = !auto('slope')
    ? slopeText
    : factorOut == null
      ? dW != null && Math.abs(dW) < 1e-9
        ? '直立'
        : ''
      : factorToSlope(factorOut, unit)
  const shownWidth = auto('width') ? (dW == null ? '' : dW.toFixed(3)) : widthText
  const shownHeight = auto('height') ? (dH == null ? '' : dH.toFixed(3)) : heightText
  const shownLength = auto('length')
    ? solved.ok
      ? solved.value.l.toFixed(3)
      : ''
    : lengthText
  // 離れ / 標高 は 幅 / 直高 の 別 の 見方。 相方 が 自動計算 なら こちら も
  const shownDist = auto('width') ? (dW == null ? '' : r3(prevAbs + dW).toFixed(3)) : distText
  const shownElev =
    auto('height') ? (dH == null ? '' : r3(prev.elevation + dH).toFixed(3)) : elevText

  /** 打った 側 は 文字 を 触らず、 相方 だけ を 計算 し 直す */
  const typeWidth = (raw: string) => {
    setWidthText(raw)
    const v = num(raw)
    setDistText(v == null ? '' : String(r3(prevAbs + v)))
  }
  const typeDist = (raw: string) => {
    setDistText(raw)
    const v = num(raw)
    setWidthText(v == null ? '' : String(r3(v - prevAbs)))
  }
  const typeHeight = (raw: string) => {
    setHeightText(raw)
    const v = num(raw)
    setElevText(v == null ? '' : String(r3(prev.elevation + v)))
  }
  const typeElev = (raw: string) => {
    setElevText(raw)
    const v = num(raw)
    setHeightText(v == null ? '' : String(r3(v - prev.elevation)))
  }
  /** 開いた ときの 値 に 戻す (位置 は そのまま) */
  const resetAll = () => {
    setUnit('percent')
    setMode('widthHeight')
    setSlopeText('')
    setWidthText(String(initW))
    setDistText(String(initDist))
    setHeightText(String(initH))
    setElevText(String(initElev))
    setLengthText(String(r3(Math.hypot(initW, initH))))
    setMarginText('')
    setSlide(false)
  }

  /** 入力方法 の 切替。 いま 出て いる 値 を 全部 の 欄 に 固定 して から 移す */
  const pickMode = (next: SegmentInputMode) => {
    if (next === mode) return
    if (solved.ok) {
      const v = solved.value
      setWidthText(String(r3(v.w)))
      setDistText(String(r3(prevAbs + v.w)))
      setHeightText(String(r3(v.h)))
      setElevText(String(r3(prev.elevation + v.h)))
      setLengthText(String(r3(v.l)))
      if (v.f != null) setSlopeText(factorToSlope(v.f, unit))
    }
    setMode(next)
  }
  /** 単位 を 変える とき、 入力 中 の 勾配 は 同じ 傾き の まま 書き換える */
  const pickUnit = (u: 'percent' | 'ratio') => {
    if (u === unit) return
    if (!auto('slope')) {
      const v = num(slopeText)
      const f = v == null ? null : slopeToFactor(v, unit)
      if (f != null) setSlopeText(factorToSlope(f, u))
    }
    setUnit(u)
  }

  // 図 に 仮 の 位置 を 出す。 onPreview は 毎 レンダー 作り直される ので
  // 依存 に は 入れず、 値 が 変わった とき だけ 親 に 知らせる。
  useEffect(() => {
    onPreview(
      ok ? { offset: nextOffset as number, elevation: nextElevation as number } : null,
      slide,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ok, nextOffset, nextElevation, slide])
  // 閉じる とき は 必ず 消す (null を 渡す だけ な ので 古い 関数 でも 困らない)
  useEffect(() => {
    return () => onPreview(null, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const inputCls = (isAuto: boolean) =>
    'flex-1 min-w-0 px-1.5 py-1 border rounded font-mono text-right ' +
    (isAuto ? 'bg-slate-100 text-slate-500' : 'bg-white')
  const pickCls = (on: boolean) =>
    'px-2 py-1 text-[11px] border rounded ' +
    (on ? 'bg-slate-700 text-white border-slate-700' : 'bg-white hover:bg-slate-50')
  const sideMark = side === 'left' ? 'L' : 'R'

  return (
    // 背景 は 暗く しない。 断面図 を 見ながら 数値 を 入れたい ので、
    // 覆い は クリック を 通し (pointer-events-none)、 本体 だけ 受ける。
    <div className="fixed inset-0 z-[3000] flex items-center justify-center p-4 pointer-events-none">
      <div
        className="bg-white rounded shadow-xl border w-[34rem] max-w-full pointer-events-auto"
        style={{ transform: 'translate(' + pos.x + 'px, ' + pos.y + 'px)' }}
      >
        <div
          onMouseDown={(e) => {
            // ヘッダー を つまんで 動かす。 閉じる ボタン の 上 では 始めない
            if ((e.target as HTMLElement).closest('button')) return
            setDrag({ sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y })
          }}
          className="px-3 py-2 border-b flex items-center justify-between cursor-move select-none bg-slate-50 rounded-t"
        >
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-700">
              計画点計算 ({sideMark})
            </span>
            {/* 同じ 側 の 表 の 並び (中心 に 近い 順) で 1 つ ずつ 移る */}
            {onNavigate && (
              <span className="inline-flex items-center gap-0.5">
                <button
                  onClick={() => onNavigate(-1)}
                  disabled={!hasPrev}
                  className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="1 つ 内側 の 計画点 へ"
                >
                  ◀ 前の点
                </button>
                <button
                  onClick={() => onNavigate(1)}
                  disabled={!hasNext}
                  className="px-1.5 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="1 つ 外側 の 計画点 へ"
                >
                  次の点 ▶
                </button>
              </span>
            )}
          </span>
          <button onClick={onClose} className="p-0.5 hover:bg-slate-100 rounded">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="p-3 space-y-2 text-xs">
          <div className="text-slate-500 leading-5">
            <div>
              基準 (前 の 点): 離れ{' '}
              <span className="font-mono text-slate-700">
                {sideMark}
                {prevAbs.toFixed(3)}
              </span>{' '}
              / 標高 <span className="font-mono text-slate-700">{prev.elevation.toFixed(3)}</span> m
            </div>
            <div>
              いま の この 点: 離れ{' '}
              <span className="font-mono text-slate-700">
                {sideMark}
                {Math.abs(original.offset).toFixed(3)}
              </span>{' '}
              / 標高{' '}
              <span className="font-mono text-slate-700">{original.elevation.toFixed(3)}</span> m
            </div>
          </div>

          {/* 入力方法。 幅 / 直高 / 勾配 / 法長 の うち 2 つ を 入れ、 残り を 計算 する。
              法面 は 「法長 + 勾配」 で 指定 する こと が 多い。 */}
          <div className="flex items-center gap-2 border-t pt-2">
            <span className="w-14 shrink-0 text-slate-600">入力方法</span>
            <select
              value={mode}
              onChange={(e) => pickMode(e.target.value as SegmentInputMode)}
              className="flex-1 px-1.5 py-1 border rounded bg-white"
            >
              {SEGMENT_INPUT_MODES.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="shrink-0 text-slate-400">灰色 の 欄 は 計算 結果</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-slate-600">勾配</span>
            <input
              type="text"
              inputMode="decimal"
              value={shownSlope}
              readOnly={auto('slope')}
              onChange={(e) => setSlopeText(e.target.value)}
              placeholder={unit === 'percent' ? '例 -2' : '例 1.5 (1:1.5)'}
              className={inputCls(auto('slope'))}
            />
            <div className="flex gap-0.5 shrink-0">
              {(['percent', 'ratio'] as const).map((u) => (
                <button key={u} onClick={() => pickUnit(u)} className={pickCls(unit === u)}>
                  {u === 'percent' ? '%' : '1:n'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-slate-600">幅 (m)</span>
            <input
              type="text"
              inputMode="decimal"
              value={shownWidth}
              readOnly={auto('width')}
              onChange={(e) => typeWidth(e.target.value)}
              placeholder="外 へ (負 で 内 へ)"
              className={inputCls(auto('width'))}
            />
            <span className="shrink-0 text-slate-600">離れ (m)</span>
            <input
              type="text"
              inputMode="decimal"
              value={shownDist}
              readOnly={auto('width')}
              onChange={(e) => typeDist(e.target.value)}
              placeholder={sideMark + ' からの 距離'}
              className={inputCls(auto('width'))}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-slate-600">直高 (m)</span>
            <input
              type="text"
              inputMode="decimal"
              value={shownHeight}
              readOnly={auto('height')}
              onChange={(e) => typeHeight(e.target.value)}
              placeholder="+ が 上"
              className={inputCls(auto('height'))}
            />
            <span className="shrink-0 text-slate-600">標高 (m)</span>
            <input
              type="text"
              inputMode="decimal"
              value={shownElev}
              readOnly={auto('height')}
              onChange={(e) => typeElev(e.target.value)}
              placeholder="標高"
              className={inputCls(auto('height'))}
            />
          </div>

          {/* 「現況まで」 の とき だけ。 交点 から 同じ 勾配 の まま 伸ばす 幅 */}
          {mode === 'toGround' && (
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-slate-600">余裕幅 (m)</span>
              <input
                type="text"
                inputMode="decimal"
                value={marginText}
                onChange={(e) => setMarginText(e.target.value)}
                placeholder="0 (交点 で 止める)"
                className={inputCls(false)}
              />
              <span className="shrink-0 text-slate-400">交点 から 幅方向 に 追加</span>
            </div>
          )}

          {/* 法長。 斜面 に 沿った 長さ。 対 に なる 絶対値 は 無い */}
          <div className="flex items-center gap-2">
            <span className="w-14 shrink-0 text-slate-600">法長 (m)</span>
            <input
              type="text"
              inputMode="decimal"
              value={shownLength}
              readOnly={auto('length')}
              onChange={(e) => setLengthText(e.target.value)}
              placeholder="斜面 に 沿った 長さ"
              className={inputCls(auto('length'))}
            />
          </div>

          {outerCount > 0 && (
            <div className="flex items-center gap-2 border-t pt-2">
              <span className="text-slate-600">外側 の {outerCount} 点</span>
              <div className="flex gap-0.5">
                <button
                  onClick={() => setSlide(false)}
                  className={pickCls(!slide)}
                  title="この 点 だけ 動かす"
                >
                  位置を保持
                </button>
                <button
                  onClick={() => setSlide(true)}
                  className={pickCls(slide)}
                  title="外側 の 点 も 同じ だけ ずらす (形 を 保つ)"
                >
                  スライド
                </button>
              </div>
            </div>
          )}

          <div className="border-t pt-2">
            {err ? (
              <div className="text-red-600">{err}</div>
            ) : (
              <>
                <div className="font-mono text-sm text-slate-800">
                  → 離れ {sideMark}
                  {Math.abs(nextOffset ?? 0).toFixed(3)} / 標高{' '}
                  {(nextElevation ?? 0).toFixed(3)} m
                </div>
                <div className="text-slate-500">
                  前 の 点 から 幅 {(dW ?? 0).toFixed(3)} / 直高 {(dH ?? 0).toFixed(3)}
                  {factorOut != null
                    ? ' / 勾配 ' + (factorOut * 100).toFixed(2) + '%'
                    : ' / 直立 (幅 0)'}
                </div>
                {solved.ok && solved.value.flipped && (
                  <div className="text-amber-600">
                    入れた 向き で は 現況 に 届か ない ので、 勾配 の 上下 を 反転 して
                    求めました (この 位置 で は 現況 が 反対側 に あります)。
                  </div>
                )}
                {solved.ok && solved.value.extrapolated && (
                  <div className="text-amber-600">
                    交点 が 現況 の 測った 範囲 の 外 です。 端 の 勾配 を 延長 して 求めました。
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        <div className="px-3 py-2 border-t flex justify-end gap-2">
          <button
            onClick={resetAll}
            className="px-3 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
            title="開いた ときの 値 に 戻す"
          >
            最初に戻す
          </button>
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
          >
            キャンセル
          </button>
          <button
            onClick={() => {
              if (!ok) return
              onApply(
                { offset: nextOffset as number, elevation: nextElevation as number },
                slide,
              )
            }}
            disabled={!ok}
            className="px-3 py-1 text-xs border rounded bg-blue-600 text-white border-blue-600 hover:bg-blue-700 disabled:opacity-40"
          >
            確定
          </button>
        </div>
      </div>
    </div>
  )
}

function SectionRowTable({
  title,
  side,
  rows,
  sourceOf,
  onUpdate,
  onRemove,
  onAdd,
  onMove,
  onCalc,
  selectedPointId,
  onSelectPoint,
}: {
  title: string
  /** 空白行 で 追加 する とき の 符号。 center は 追加行 を 出さない */
  side: 'center' | 'left' | 'right'
  rows: MeasuredCrossPoint[]
  sourceOf: (id: string) => string
  onUpdate: (id: string, patch: Partial<MeasuredCrossPoint>) => void
  onRemove: (id: string) => void
  onAdd?: (p: { offset: number; elevation: number; note?: string }) => void
  /**
   * 表示 上 の 1 つ 上 / 下 と 入れ替える。
   * 断面 は 普段 中心 に 近い 順 で 足りる が、オーバーハング (外 へ 出て
   * から 内 へ 戻る) だけ は 離れ で 順序 が 決まら ない ので 手 で 直す。
   */
  onMove?: (id: string, dir: -1 | 1) => void
  /** 計画 だけ。 前 の 点 から の 勾配 / 幅 / 直高 で この 点 を 置き直す */
  onCalc?: (id: string) => void
  /** 図 と 共有 する 選択 */
  selectedPointId?: string | null
  onSelectPoint?: (id: string | null) => void
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
              {onCalc && <th className="px-1 py-1 w-7" />}
              {onMove && <th className="px-1 py-1 w-10" />}
              <th className="px-1 py-1 w-7" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => onSelectPoint?.(selectedPointId === r.id ? null : r.id)}
                className={`border-t cursor-pointer ${
                  selectedPointId === r.id ? 'bg-pink-100' : ''
                }`}
              >
                <td className="px-1 py-1">
                  <input
                    type="number"
                    step={0.01}
                    min={side === 'center' ? undefined : 0}
                    // 左右 の 表 は 中心 から の 距離 を 正 で 見せる。
                    // 左 が 負 と いう 符号 は データ 側 の 約束 な ので 表示 で 吸収 する
                    // (末尾 の 追加行 も 同じ 扱い)。
                    value={side === 'center' ? r.offset : Math.abs(r.offset)}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value) || 0
                      onUpdate(r.id, {
                        offset:
                          side === 'left'
                            ? -Math.abs(v)
                            : side === 'right'
                              ? Math.abs(v)
                              : v,
                      })
                    }}
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
                {onCalc && (
                  <td className="px-0.5 py-1 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onCalc(r.id)
                      }}
                      className="p-0.5 border rounded hover:bg-blue-50 text-blue-600"
                      title="前 の 点 から の 勾配 と 幅 / 直高 で この 点 の 位置 を 計算"
                    >
                      <Calculator className="h-3 w-3" />
                    </button>
                  </td>
                )}
                {onMove && (
                  <td className="px-0.5 py-1 text-center whitespace-nowrap">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onMove(r.id, -1)
                      }}
                      disabled={rows[0]?.id === r.id}
                      className="p-0.5 border rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"
                      title="1 つ 上 (中心 側) へ"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        onMove(r.id, 1)
                      }}
                      disabled={rows[rows.length - 1]?.id === r.id}
                      className="ml-0.5 p-0.5 border rounded hover:bg-slate-100 text-slate-600 disabled:opacity-30"
                      title="1 つ 下 (外 側) へ"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                  </td>
                )}
                <td className="px-1 py-1 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(r.id)
                    }}
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
                {onCalc && <td />}
                {onMove && <td />}
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
  points,
  centerHeight,
  profileCenterHeight,
  groundPoints,
  onCalcPreviewChange,
  onChange,
  selectedPointId,
  onSelectPoint,
}: {
  target: SectionTarget
  stationId: string
  points: MeasuredCrossPoint[]
  /** 中心設計高 [m]。 一番 内側 の 点 を 計算 する とき の 基準 に 使う */
  centerHeight?: number
  /** この 測点 の 現況断面。 計算 の 「勾配 ～ 現況まで」 に 使う */
  groundPoints?: MeasuredCrossPoint[] | null
  /**
   * 縦断線形 を その 測点 の 位置 で 内挿 した 高さ [m]。
   * 計画 の 中心高 を 「縦断から計算」 で 入れる ため だけ に 使う。
   * 測点 が 縦断 の 範囲 外 なら undefined。
   */
  profileCenterHeight?: number
  /** 計算 中 の 線分 を 断面図 に 出す ため 親 へ 上げる */
  onCalcPreviewChange?: (p: CalcPreview | null) => void
  onChange: (points: MeasuredCrossPoint[]) => void
  /** 図 と 表 で 共有 する 選択。 行 を 押す と 図 の マーク も 変わる */
  selectedPointId?: string | null
  onSelectPoint?: (id: string | null) => void
}) {
  const [rows, setRows] = useState<MeasuredCrossPoint[]>(() => points.map((p) => ({ ...p })))
  // 測点 / 対象 が 変わったら 読み直す (同じ 断面 を 編集 中 は 触らない)
  useEffect(() => {
    setRows(points.map((p) => ({ ...p })))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stationId, target])
  // 外 (地図ピック / DXF トレース / 取込 / 図 の 上 で の 並べ替え) から
  // 中身 が 変わった 場合 も 追従。 点数 だけ だと 並べ替え を 取り逃す ので
  // id の 並び で 見る。
  const pointsKey = points.map((p) => p.id).join('|')
  useEffect(() => {
    setRows((prev) =>
      prev.map((p) => p.id).join('|') === pointsKey ? prev : points.map((p) => ({ ...p })),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey])

  const commit = (next: MeasuredCrossPoint[]) => {
    setRows(next)
    onChange(next)
  }
  /** 行 の id の 頭 で 出所 が 分かる (sr-=実測記録 / mp-=地図 / dxf-=トレース / tin-=LandXML) */
  const sourceOf = (id: string): string =>
    id.startsWith('sr-') ? '実測記録'
      : id.startsWith('tin-') ? 'LandXML'
      : id.startsWith('dxf-') ? 'DXF'
      : id.startsWith('mp-') ? '地図'
      : '手入力'
  const newId = () => `mp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  /** 空白行 から の 追加。 離れ 順 に 入れて おく */
  /**
   * 点 を 足す。 並べ 替え は しない。
   * 断面 は オーバーハング (外 へ 出て から 内 へ 戻る) が ある ので、
   * 離れ 順 に 直して しまう と 形 が 潰れる。 並び は 入力順 が 正。
   */
  const addPoint = (p: { offset: number; elevation: number; note?: string }) =>
    commit([...rows, { id: newId(), ...p }])
  const removeRow = (id: string) => commit(rows.filter((p) => p.id !== id))
  const updateRow = (id: string, patch: Partial<MeasuredCrossPoint>) =>
    commit(rows.map((p) => (p.id === id ? { ...p, ...patch } : p)))

  // 中心 / 左 / 右。 左右 は 中心 に 近い 順 (|離れ| の 小さい 順)
  // 左右 に 分ける とき も 中 の 並び は 入力順 の まま。 |離れ| 順 に 直すと
  // オーバーハング が 潰れる ので、揃えたい ときは 「離れ順」 を 押して もらう。
  const center = rows.filter((r) => r.offset === 0)
  const leftRows = rows.filter((r) => r.offset < 0)
  const rightRows = rows.filter((r) => r.offset > 0)
  // 左 の 表 は 中心 に 近い 点 を 上 に 出す (右 の 表 と 読み方 を 揃える)。
  // |離れ| で 並べ 替える と オーバーハング の 前後 が 崩れる ので、
  // 入力順 を そのまま 逆 に する だけ に する。 表示 だけ で データ は 触らない。
  const leftRowsView = [...leftRows].reverse()
  /**
   * 表 の 見た目 の 1 つ 上 / 下 と 入れ替える。 表 は 左右 とも 中心 に 近い
   * 順 で 出して いる ので、普段 は 触る 必要 が ない。 オーバーハング だけ は
   * 離れ で 順序 が 決まら ない ので これ で 直す。
   * 並び 替え は その 側 の 行 の 中 だけ。 中心 や 反対側 の 位置 は 動かさない。
   */
  const moveWithinSide = (sideKey: 'left' | 'right', id: string, dir: -1 | 1) => {
    const belongs = (r: MeasuredCrossPoint) => (sideKey === 'left' ? r.offset < 0 : r.offset > 0)
    const dataOrder = rows.filter(belongs)
    // 左 は データ (外→内) と 表示 (内→外) が 逆
    const view = sideKey === 'left' ? [...dataOrder].reverse() : dataOrder
    const i = view.findIndex((r) => r.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= view.length) return
    const nextView = [...view]
    const tmp = nextView[i]
    nextView[i] = nextView[j]
    nextView[j] = tmp
    const nextSide = sideKey === 'left' ? [...nextView].reverse() : nextView
    let k = 0
    commit(rows.map((r) => (belongs(r) ? nextSide[k++] : r)))
  }

  /** 計算 ダイアログ を 開いて いる 行。 計画 の とき だけ 使う */
  const [calcRowId, setCalcRowId] = useState<string | null>(null)
  /** その 行 が 左右 どちら の 表 の もの か */
  const sideOfRow = (id: string): 'left' | 'right' | null =>
    leftRows.some((r) => r.id === id)
      ? 'left'
      : rightRows.some((r) => r.id === id)
        ? 'right'
        : null
  /**
   * 計算 の 基準 に する 「前 の 点」。 表 は 中心 に 近い 順 な ので
   * 表示 上 1 つ 上 の 行。 一番 内側 の 行 は 中心 を 基準 に する
   * (中心 の 行 が あれば その 標高、 無ければ 中心設計高)。
   */
  const prevPointOf = (id: string): { offset: number; elevation: number } | null => {
    const sideKey = sideOfRow(id)
    if (!sideKey) return null
    const view = sideKey === 'left' ? leftRowsView : rightRows
    const i = view.findIndex((r) => r.id === id)
    if (i < 0) return null
    if (i > 0) return { offset: view[i - 1].offset, elevation: view[i - 1].elevation }
    if (center.length > 0) return { offset: 0, elevation: center[0].elevation }
    if (centerHeight == null) return null
    return { offset: 0, elevation: centerHeight }
  }
  const calcSide = calcRowId ? sideOfRow(calcRowId) : null
  const calcPrev = calcRowId ? prevPointOf(calcRowId) : null
  const calcRow = calcRowId ? (rows.find((r) => r.id === calcRowId) ?? null) : null
  const r3 = (v: number) => Math.round(v * 1000) / 1000
  /** 中心 (離れ 0) の 点。 無ければ null */
  const centerRow = center[0] ?? null
  /** 中心 の 高さ の 呼び名 は 編集対象 に 合わせる */
  const centerLabel =
    target === 'current' ? '現況高' : target === 'asbuilt' ? '出来形高' : '計画高'
  /**
   * 中心 の 高さ を 入れる。 中心 の 点 が 無ければ その場 で 作る。
   * 並び は 折れ線 の 順 な ので、 左 (負) と 右 (正) の 境目 に 差し込む。
   * 全体 を 並べ 替える と オーバーハング の 前後 が 崩れる。
   */
  const setCenterElevation = (v: number | null) => {
    if (v == null) return
    if (centerRow) {
      commit(rows.map((p) => (p.id === centerRow.id ? { ...p, elevation: v } : p)))
      return
    }
    const point: MeasuredCrossPoint = { id: newId(), offset: 0, elevation: v }
    const k = rows.findIndex((p) => p.offset > 0)
    commit(k < 0 ? [...rows, point] : [...rows.slice(0, k), point, ...rows.slice(k)])
  }
  /** 同じ 側 の 表 の 並び (中心 に 近い 順) で 1 つ 前 / 次 の 行 */
  const neighborRowId = (id: string, dir: -1 | 1): string | null => {
    const sideKey = sideOfRow(id)
    if (!sideKey) return null
    const view = sideKey === 'left' ? leftRowsView : rightRows
    const k = view.findIndex((r) => r.id === id)
    const n = k + dir
    return k < 0 || n < 0 || n >= view.length ? null : view[n].id
  }
  /** その 行 より 外側 に 残って いる 行 (表示 順 で 下) */
  const outerRowsOf = (id: string): MeasuredCrossPoint[] => {
    const sideKey = sideOfRow(id)
    if (!sideKey) return []
    const view = sideKey === 'left' ? leftRowsView : rightRows
    const k = view.findIndex((r) => r.id === id)
    return k < 0 ? [] : view.slice(k + 1)
  }
  /**
   * 計算 結果 を 入れる。 slide なら 外側 の 点 も 同じ 量 だけ ずらして
   * 形 を 保つ。 保持 なら その 点 だけ 動かす。
   */
  const applyCalc = (
    id: string,
    next: { offset: number; elevation: number },
    slideOuter: boolean,
  ) => {
    const cur = rows.find((r) => r.id === id)
    if (!cur) return
    const dOff = next.offset - cur.offset
    const dElev = next.elevation - cur.elevation
    const outer = new Set(slideOuter ? outerRowsOf(id).map((r) => r.id) : [])
    commit(
      rows.map((r) => {
        if (r.id === id) return { ...r, offset: next.offset, elevation: next.elevation }
        if (outer.has(r.id))
          return { ...r, offset: r3(r.offset + dOff), elevation: r3(r.elevation + dElev) }
        return r
      }),
    )
  }

  return (
    /* 表題 (現況断面 / 測点名) は 上 の バー と 重なる ので 出さない。
       取込 と 全消去 は 表 の 上 の ボタン列 に まとめて ある。
       点数 は 左右 それぞれ の 表 の 見出し に 出る。 */
    <div className="h-full flex flex-col gap-1.5">
      {/* 中心 から 左 / 右 に 分けて 出す。 どちら も 中心 に 近い 順。
          並び を 変えたい とき (オーバーハング) は 各行 の ↑↓ で。 */}
      <div className="flex-1 min-h-0 overflow-auto space-y-1.5">
        {/* 中心 (離れ 0) は 表 に しない。 離れ は 常に 0、 点名 も 要ら ない ので
            高さ だけ 出す。 中心 の 点 が 無い 断面 でも 常に 出し、 入れたら
            その場 で 点 を 作る (以前 は 点 が ある ときしか 触れ なかった)。 */}
        <div className="shrink-0 flex items-center gap-2 border rounded px-2 py-1.5 bg-slate-50">
          <span className="text-[11px] font-semibold text-slate-600 shrink-0">
            {centerLabel} (m)
          </span>
          <ElevationField
            value={centerRow ? centerRow.elevation : centerHeight}
            onCommit={setCenterElevation}
            placeholder="中心 の 高さ"
            className="w-28 px-1 py-0.5 border rounded text-right tabular-nums bg-white text-xs"
          />
          {/* 計画 の 中心高 は 縦断線形 から 決まる ので、 その 値 を 入れる ボタン。
              現況 / 出来形 は 実測 な ので 出さない。 */}
          {target === 'planned' && (
            <button
              onClick={() =>
                profileCenterHeight != null && setCenterElevation(r3(profileCenterHeight))
              }
              disabled={profileCenterHeight == null}
              className="shrink-0 px-2 py-0.5 text-[11px] border rounded bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50 disabled:opacity-40 disabled:cursor-not-allowed"
              title={
                profileCenterHeight == null
                  ? 'この 測点 は 縦断線形 の 範囲 外 です'
                  : '縦断線形 を この 測点 の 位置 で 内挿 した 高さ を 入れる'
              }
            >
              縦断から計算
              {profileCenterHeight != null && (
                <span className="ml-1 font-mono text-slate-500">
                  {profileCenterHeight.toFixed(3)}
                </span>
              )}
            </button>
          )}
          {!centerRow && (
            <span className="text-[10px] text-slate-400">
              中心 の 点 は まだ ありません (左右 から の 補間値)
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <SectionRowTable
            title="左 (L)"
            selectedPointId={selectedPointId}
            onSelectPoint={onSelectPoint}
            side="left"
            rows={leftRowsView}
            sourceOf={sourceOf}
            onUpdate={updateRow}
            onRemove={removeRow}
            onAdd={addPoint}
            onMove={(id, dir) => moveWithinSide('left', id, dir)}
            onCalc={target === 'planned' ? (id) => setCalcRowId(id) : undefined}
          />
          <SectionRowTable
            title="右 (R)"
            selectedPointId={selectedPointId}
            onSelectPoint={onSelectPoint}
            side="right"
            rows={rightRows}
            sourceOf={sourceOf}
            onUpdate={updateRow}
            onRemove={removeRow}
            onAdd={addPoint}
            onMove={(id, dir) => moveWithinSide('right', id, dir)}
            onCalc={target === 'planned' ? (id) => setCalcRowId(id) : undefined}
          />
        </div>
        {rows.length === 0 && (
          <div className="px-2 py-4 text-center text-slate-400 text-[11px] border rounded">
            まだ 点が ありません。 左 / 右 の 空白行 に 打つ か、上 の 取込 から 始めて ください。
          </div>
        )}
      </div>
      {/* 計画 の 点 を 前 の 点 から の 勾配 / 幅 / 直高 で 置き直す */}
      {calcRowId && calcSide && calcPrev && calcRow && (
        <PlanPointCalcModal
          // 別 の 点 へ 移ったら 入力 を 作り直す
          key={calcRowId}
          prev={calcPrev}
          side={calcSide}
          original={{ offset: calcRow.offset, elevation: calcRow.elevation }}
          outerCount={outerRowsOf(calcRowId).length}
          ground={groundPoints ?? null}
          hasPrev={neighborRowId(calcRowId, -1) != null}
          hasNext={neighborRowId(calcRowId, 1) != null}
          onNavigate={(dir) => {
            const nid = neighborRowId(calcRowId, dir)
            if (nid) setCalcRowId(nid)
          }}
          onPreview={(to, slideOuter) => {
            // 確定 したら こう なる、 という 形 を 図 に 出す。
            // スライド なら 外側 の 点 も 同じ 量 だけ ずらして 見せる。
            const outerRows = outerRowsOf(calcRowId)
            const dOff = to ? to.offset - calcRow.offset : 0
            const dElev = to ? to.elevation - calcRow.elevation : 0
            onCalcPreviewChange?.({
              from: calcPrev,
              original: { offset: calcRow.offset, elevation: calcRow.elevation },
              to,
              outer: outerRows.map((r) =>
                slideOuter && to
                  ? { offset: r3(r.offset + dOff), elevation: r3(r.elevation + dElev) }
                  : { offset: r.offset, elevation: r.elevation },
              ),
            })
          }}
          // 確定 しても 閉じない。 続けて 前後 の 点 を 計算 できる ように する
          onApply={(next, slideOuter) => applyCalc(calcRowId, next, slideOuter)}
          onClose={() => {
            onCalcPreviewChange?.(null)
            setCalcRowId(null)
          }}
        />
      )}
    </div>
  )
}

/** 親 (横断図 の 表題行) から 呼ぶ 操作 */
export interface CrossSectionViewHandle {
  /** 表示 (パン / ズーム) を 初期 の 自動フィット に 戻す */
  resetView: () => void
}

const CrossSectionView = forwardRef<CrossSectionViewHandle, {
  cs: StandardCrossSection
  centerHeight?: number
  /** 現況高 (中心線上の 地盤高) [m]。undefined / null は 未入力扱い。
   *  横線 + ラベルで 上書き表示し、計画高との 差分 (切/盛) も 併記 */
  currentGroundHeight?: number | null
  /** 現況断面 の 測定点列 (offset, elevation)。ある場合 は 折れ線 + マーカーで 描画。 */
  currentSection?: MeasuredCrossPoint[] | null
  /** 出来形 断面 の 測定点列。ある場合 は 別 色 で 折れ線 + マーカー描画。 */
  asbuiltSection?: MeasuredCrossPoint[] | null
  /**
   * どの レイヤ を 出す か。 線 が 重なる と 読め ない ので、現況 / 計画 /
   * 出来形 と、寸法 (勾配・幅) / 点名 の 文字 を それぞれ 消せる ように する。
   */
  show?: {
    planned?: boolean
    current?: boolean
    asbuilt?: boolean
    dimText?: boolean
    pointText?: boolean
  }
  /**
   * いま 編集 して いる 対象 の 点列。 図 の 上 で 選べる よう に する ため、
   * 表 と 同じ 並び で 受け取る (計画 なら plannedSectionRaw)。
   */
  editPoints?: MeasuredCrossPoint[] | null
  /**
   * 計画 の とき は true。 計画 の 線 は 要素 (幅 + 勾配) から 組み直した もの な ので、
   * 点列 の 標高 を そのまま 置く と 中心高 の 取り方 の 差 で 線 から ずれる。
   * 図 に 出て いる 折れ線 の 折点 に そのまま 重ねる。
   */
  editOnPath?: boolean
  /**
   * 計算 中 の 線分。 基準点 → いま の 位置 を 太線、 基準点 → 仮 の 位置 を
   * 破線 で 重ねる。 どこ を 動かして いる か 図 で 分かる ように する。
   */
  calcPreview?: CalcPreview | null
  /**
   * 断面図 に 出す トンボ (丁張 の 目印)。
   * 現地 の 形 (横板 + 縦杭) が 分かる ように 描く。
   */
  tombos?: {
    id: string
    offset: number
    elevation: number
    label: string
    /** 基準点 から の ずらし。 図 に 「W+0.5 H+1.0」 と 添える */
    dw: number
    dh: number
    /** 杭 の 位置 の 現況地盤高 [m]。 杭 は ここ まで 伸ばす */
    groundElevation: number | null
  }[]
  /**
   * 断面図 に 出す 丁張。 杭 の 位置 に 横板 を 掛けた 形 で 描き、
   * 法肩 まで の 法面線 を 点線 で 伸ばして 対象 の 法面 を 示す。
   */
  chohari?: {
    id: string
    offset: number
    elevation: number
    label: string
    slopeLength: number
    /** 法長 の 相手端 (基準点 の 反対) */
    crestOffset: number
    crestElevation: number
    /** 基準点 (W を 測る 起点)。 点線 は こちら 側 へ 伸ばす */
    baseOffset: number
    baseElevation: number
    /**
     * 杭 の 位置 の 現況地盤高 [m]。 親杭 は ここ まで 伸ばす。
     * 現況 が 無い / 範囲 外 なら null (その ときは 既定 の 長さ で 止める)。
     */
    groundElevation: number | null
    /**
     * 法面線 が 現況地盤 と ぶつかる 点 (断面 座標)。
     * 斜め の 杭 は ここ を 境 に、 下 は 点線、 上 は 実材 に する。
     * 交わら なければ null。
     */
    groundHit: { offset: number; elevation: number } | null
  }[]
  /**
   * 計画線 の 線分 を 押せる ように する (丁張 の 対象 法面 を 図 で 選ぶ)。
   * 押した 線分 の 両端 の 点 id を 返す。
   */
  onSelectSegment?: (fromId: string, toId: string) => void
  /** 線分 の 選択 待ち。 押せる 線分 を 目立たせる */
  segmentPick?: boolean
  /**
   * 図 を 押した 位置 の 離れ を 返す (丁張 の 杭 の 位置 を 図 で 決める)。
   * 押せる のは offsetPick が 立って いる 間 だけ。
   */
  onPickOffset?: (offset: number) => void
  offsetPick?: boolean
  /** 基準点 の 選択 待ち の とき、 押せる 点 を これ に 限る */
  pointPickIds?: string[] | null
  /** 図 と 表 で 共有 する 選択 */
  selectedPointId?: string | null
  onSelectPoint?: (id: string | null) => void
}>(function CrossSectionView(
  {
    cs,
    centerHeight,
    currentGroundHeight,
    currentSection,
    asbuiltSection,
    show,
    editPoints,
    editOnPath,
    calcPreview,
    tombos,
    chohari,
    onSelectSegment,
    segmentPick,
    onPickOffset,
    offsetPick,
    pointPickIds,
    selectedPointId,
    onSelectPoint,
  },
  ref,
) {
  const showPlanned = show?.planned !== false
  const showCurrent = show?.current !== false
  const showAsbuilt = show?.asbuilt !== false
  const showDimText = show?.dimText !== false
  const showPointText = show?.pointText !== false
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

  // 編集中 の 点 は 計画 の 折点 と 同じ 位置 に 出る (editOnPath)。
  // 両方 描く と 白丸 が 二重 に なり 読め ない ので、折点 側 を 省く 判定。
  const editOverlapsPlannedVertices =
    !!editOnPath &&
    centerHeight !== undefined &&
    !!editPoints &&
    editPoints.length > 0 &&
    editPoints.length === points.length

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
  /**
   * トンボ / 丁張 の 画面 座標。
   * 木 の 絵 は 計画線 の 後ろ、 文字 は 前 に 出す ので、 座標 は 先 に
   * 出して おいて 2 つ の 層 で 使い回す。
   */
  const TOMBO_BOARD = 14
  const STAKE_FALLBACK = 26
  /** 丁張 の 斜め 材 の 長さ [m]。 現場 で 使う 垂木 の 定尺 */
  const CHOHARI_BOARD_M = 1.8
  const tomboDraw = (tombos ?? []).flatMap((tb) => {
    if (centerHeight === undefined) return []
    const x = vx(tb.offset)
    const y = vy(tb.elevation - centerHeight)
    return [
      {
        tb,
        x,
        y,
        yGround:
          tb.groundElevation != null
            ? vy(tb.groundElevation - centerHeight)
            : y + STAKE_FALLBACK,
      },
    ]
  })
  const chohariDraw = (chohari ?? []).flatMap((ch) => {
    if (centerHeight === undefined) return []
    const x = vx(ch.offset)
    const y = vy(ch.elevation - centerHeight)
    return [
      {
        ch,
        x,
        y,
        cx: vx(ch.crestOffset),
        cy: vy(ch.crestElevation - centerHeight),
        bx: vx(ch.baseOffset),
        by: vy(ch.baseElevation - centerHeight),
        hit: ch.groundHit
          ? {
              x: vx(ch.groundHit.offset),
              y: vy(ch.groundHit.elevation - centerHeight),
              // 交点 から 斜面 に 沿って 上 へ CHOHARI_BOARD_M 進んだ 先。
              // 普通 は 法肩 の 向き が 上 だが、 念 の ため 高い 方 に 揃える。
              ...(() => {
                let dOff = ch.crestOffset - ch.groundHit.offset
                let dElv = ch.crestElevation - ch.groundHit.elevation
                if (dElv < 0) {
                  dOff = -dOff
                  dElv = -dElv
                }
                const len = Math.hypot(dOff, dElv) || 1
                const k = CHOHARI_BOARD_M / len
                return {
                  tx: vx(ch.groundHit.offset + dOff * k),
                  ty: vy(ch.groundHit.elevation + dElv * k - centerHeight),
                }
              })(),
            }
          : null,
        yGround:
          ch.groundElevation != null
            ? vy(ch.groundElevation - centerHeight)
            : y + STAKE_FALLBACK,
      },
    ]
  })

  /** 表示 リセット: パン (0,0) / ズーム 1.0 に 戻す (自動フィット 状態)。
   *  ボタン は 横断図 の 表題行 に ある ので ref 経由 で 呼ばれる */
  useImperativeHandle(ref, () => ({
    resetView: () => {
      setViewPan({ x: 0, y: 0 })
      setViewZoom(1)
    },
  }))
  return (
    <div className="flex flex-col gap-2 h-full">
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
          onClick={(e) => {
            // 杭 の 位置 を 図 で 決める モード。 ドラッグ (パン) と は 区別 する
            if (!offsetPick || !onPickOffset || wasDraggingRef.current) return
            const rect = e.currentTarget.getBoundingClientRect()
            const px = e.clientX - rect.left
            // vx の 逆算: px = viewPan.x + viewZoom * (offsetX + x * scale)
            const x = ((px - viewPan.x) / viewZoom - offsetX) / scale
            onPickOffset(Math.round(x * 1000) / 1000)
          }}
          style={{
            cursor: offsetPick
              ? 'crosshair'
              : wasDraggingRef.current
                ? 'grabbing'
                : 'grab',
          }}
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
          {/* 中心線 の 目印。 線 と 同じ vx(0) に 乗せる ので パン/ズーム に 追従 する */}
          <text
            x={vx(0)}
            y={24}
            fontSize={14}
            fontWeight={700}
            fill="#94a3b8"
            textAnchor="middle"
          >
            CL
          </text>

          {/* トンボ / 丁張 の 「木」 は 計画線 の 後ろ に 回す。
              文字 だけ は 読めない と 困る ので 線 の 前 (下 の 別 の 層) に 出す。
              座標 は vx/vy な ので どちら の 層 に 置いて も 位置 は 同じ。 */}
          {chohariDraw.map(({ ch, x, y, cx, cy, bx, by, yGround, hit }) => (
            <g key={'cho-' + ch.id} pointerEvents="none">
              {/* 斜め の 杭 (法貫)。
                  現況 と ぶつかる 点 を 境 に、 そこ から 上 は 実際 に 掛ける 材 を
                  CHOHARI_BOARD_M だけ 描く。 反対 側 は 点線 の 参考線 に し、
                  法長 を 測る 相手端 (法肩) まで 伸ばす (杭 の 点 も 通る)。
                  板 の 上面 を 斜面 に 合わせる ため、 線 の 中心 は 法面 の
                  直角 方向 に 板厚 の 半分 だけ 下 へ ずらす。 */}
              {(() => {
                // 交点 が 取れ ない ときは 従来 どおり 法肩 まで 実材 で 描く
                const aX = x
                const aY = y
                const bX = hit ? hit.tx : cx
                const bY = hit ? hit.ty : cy
                const ddx = bX - aX
                const ddy = bY - aY
                const len = Math.hypot(ddx, ddy) || 1
                let nx = -ddy / len
                let ny = ddx / len
                if (ny < 0) {
                  nx = -nx
                  ny = -ny
                }
                const off = 4.5
                const sx = hit ? hit.x : aX
                const sy = hit ? hit.y : aY
                return (
                  <>
                    {/* 実材 より 先 は 点線 の 参考線。 法面 の 延長 は 基準点 の 側 に
                        出す ので、 交点 から 「杭 の 点」 と 「基準点」 の うち
                        遠い 方 まで 引く (どちら も 線上 に ある)。 */}
                    {hit &&
                      (() => {
                        const dStake = Math.hypot(x - sx, y - sy)
                        const dBase = Math.hypot(bx - sx, by - sy)
                        const ex = dStake >= dBase ? x : bx
                        const ey = dStake >= dBase ? y : by
                        return (
                          <line
                            x1={ex + nx * off}
                            y1={ey + ny * off}
                            x2={sx + nx * off}
                            y2={sy + ny * off}
                            stroke="#8a5a2b"
                            strokeWidth={2}
                            strokeDasharray="5,4"
                            opacity={0.8}
                          />
                        )
                      })()}
                    {/* 地盤 から 上 は 実材 */}
                    <line x1={sx + nx * off} y1={sy + ny * off} x2={bX + nx * off} y2={bY + ny * off} stroke="#8a5a2b" strokeWidth={9} strokeLinecap="butt" />
                    <line x1={sx + nx * off} y1={sy + ny * off} x2={bX + nx * off} y2={bY + ny * off} stroke="#c89b6a" strokeWidth={6} strokeLinecap="butt" />
                  </>
                )
              })()}
              {/* 親杭 は 中心 の 1 本 だけ。 適当 に 切らず 現況地盤 まで 伸ばす */}
              <line x1={x} y1={y} x2={x} y2={yGround} stroke="#8a5a2b" strokeWidth={7} strokeLinecap="butt" />
              <line x1={x} y1={y} x2={x} y2={yGround} stroke="#c89b6a" strokeWidth={4.5} strokeLinecap="butt" />
              <circle cx={x} cy={y} r={2.5} fill="#fff" stroke="#e11d48" strokeWidth={1.5} />
            </g>
          ))}

          {tomboDraw.map(({ tb, x, y, yGround }) => (
            <g key={'tb-' + tb.id} pointerEvents="none">
              {/* 杭 (垂木)。 二重線 で 木 の 厚み を 出す */}
              <line x1={x} y1={y} x2={x} y2={yGround} stroke="#8a5a2b" strokeWidth={7} strokeLinecap="butt" />
              <line x1={x} y1={y} x2={x} y2={yGround} stroke="#c89b6a" strokeWidth={4.5} strokeLinecap="butt" />
              {/* 横板。 板 の 上面 を 計画高 に 合わせる ので 中心 は 板厚 の 半分 下 */}
              <line x1={x - TOMBO_BOARD} y1={y + 3.5} x2={x + TOMBO_BOARD} y2={y + 3.5} stroke="#8a5a2b" strokeWidth={7} strokeLinecap="butt" />
              <line x1={x - TOMBO_BOARD} y1={y + 3.5} x2={x + TOMBO_BOARD} y2={y + 3.5} stroke="#c89b6a" strokeWidth={4.5} strokeLinecap="butt" />
              <circle cx={x} cy={y} r={2.5} fill="#fff" stroke="#6d28d9" strokeWidth={1.5} />
            </g>
          ))}

          {/* 世界レイヤ: パン/ズームで 変形。断面 本体・折点・寸法ラベル・プレビュー等 */}
          <g transform={`translate(${viewPan.x} ${viewPan.y}) scale(${viewZoom})`}>

          {/* 現在 の 断面 (計画) */}
          {showPlanned && points.length >= 2 && (
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

          {/* 各 折点。 編集点 マーカー が 同じ 位置 に 重なる ときは そちら に 任せる
              (重ねる と 白丸 が 二重 に 見える) */}
          {showPlanned && !editOverlapsPlannedVertices && points.map((p, i) => (
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
          {showDimText && (() => {
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
          {showCurrent && currentSection && currentSection.length > 0 && centerHeight !== undefined && (() => {
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
                {/* 点名 (note) を 点 の 上 に 添える。 重なって 読めなく なる のを
                    避ける ため、隣 と 近い 点 は 一段 上げて 互い違い に する。 */}
                {showPointText && currentSection.map((p, i) => {
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
          {showAsbuilt && asbuiltSection && asbuiltSection.length > 0 && centerHeight !== undefined && (() => {
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
                        x: vx(p.offset),
                        y: vy(p.elevation - centerHeight),
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
                {showPointText && asbuiltSection.map((p, i) => {
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

          {/* 左右 の 目印 (パン/ズームに 影響されない UI 表示)。
              中心 の CL と 同じ 高さ に 揃える。 */}
          <text x={padding.left} y={24} fontSize={16} fontWeight={700} fill="#64748b">
            L
          </text>
          <text
            x={size.w - padding.right}
            y={24}
            fontSize={16}
            fontWeight={700}
            fill="#64748b"
            textAnchor="end"
          >
            R
          </text>

          {/* 編集中 の 点。 図 の 上 で 押して 選べる ように、他 の 線 より 上 に 置く。
              選んで いる 点 は 色 と 大きさ を 変えて 表 の 行 と 対 に する。
              世界レイヤ (g transform) の 外 な ので 座標 は vx/vy (パン/ズーム 込み)。
              tx/ty だと 線 だけ 動いて マーカー が 取り残される。
              大きさ は ズーム しても 一定 に なり 掴み やすい。 */}
          {editPoints && editPoints.length > 0 && centerHeight !== undefined && (
            <g>
              {editPoints.map((p, i) => {
                const on = selectedPointId === p.id
                // 計画 は 図 に 出て いる 折れ線 の 折点 に 重ねる (数 が 合う とき)
                const onPath =
                  editOnPath && points.length === editPoints.length ? points[i] : null
                // 基準点 の 選択 待ち の とき は 選べる 点 だけ を 目立たせる
                const pickable =
                  pointPickIds != null && p.id != null && pointPickIds.includes(p.id)
                return (
                  <circle
                    key={`ep-${p.id ?? i}`}
                    cx={vx(onPath ? onPath.x : p.offset)}
                    cy={vy(onPath ? onPath.y : p.elevation - centerHeight)}
                    // 基準点 の 選択 中 は 線分 の 両端 以外 を 受け付け ない
                    pointerEvents={pointPickIds != null && !pickable ? 'none' : undefined}
                    r={pickable ? 7 : on ? 6 : 4}
                    fill={pickable ? '#f43f5e' : on ? '#db2777' : '#fff'}
                    stroke={pickable ? '#be123c' : on ? '#db2777' : '#64748b'}
                    strokeWidth={pickable ? 2.5 : on ? 2 : 1.2}
                    style={{ cursor: 'pointer' }}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectPoint?.(on ? null : (p.id ?? null))
                    }}
                  />
                )
              })}
            </g>
          )}

          {/* 線分 の 選択。 編集点 と 同じ 座標 の 取り方 で 当たり判定 を 重ねる。
              待機 中 だけ 出す ので、 普段 の 操作 の 邪魔 に なら ない。 */}
          {segmentPick && onSelectSegment && editPoints && editPoints.length >= 2 &&
            centerHeight !== undefined &&
            (() => {
              const at = (i: number) => {
                const p = editPoints[i]
                const onPath =
                  editOnPath && points.length === editPoints.length ? points[i] : null
                return {
                  x: vx(onPath ? onPath.x : p.offset),
                  y: vy(onPath ? onPath.y : p.elevation - centerHeight),
                }
              }
              return (
                <g>
                  {editPoints.slice(0, -1).map((p, i) => {
                    const a = at(i)
                    const b = at(i + 1)
                    const q = editPoints[i + 1]
                    return (
                      <g key={'seg-' + (p.id ?? i)}>
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke="#f43f5e"
                          strokeWidth={3}
                          opacity={0.35}
                        />
                        {/* 当たり判定 は 太く 透明 に する (細い 線 は 押し づらい) */}
                        <line
                          x1={a.x}
                          y1={a.y}
                          x2={b.x}
                          y2={b.y}
                          stroke="transparent"
                          strokeWidth={14}
                          style={{ cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (p.id && q.id) onSelectSegment(p.id, q.id)
                          }}
                        />
                      </g>
                    )
                  })}
                </g>
              )
            })()}

          {/* トンボ / 丁張 の 文字。 木 の 絵 は 計画線 の 後ろ だが、
              文字 は 隠れる と 読め ない ので ここ (線 の 前) に 出す。
              杭 の 長さ は 杭 の 下、 地盤線 の 下 に 置く。 */}
          {chohariDraw.map(({ ch, x, y, yGround }) => (
            <g key={'chot-' + ch.id} pointerEvents="none">
              <text x={x} y={y - 52} fontSize={13} textAnchor="middle" fill="#be123c" fontWeight={600} style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>
                {ch.label} 法長 {ch.slopeLength.toFixed(3)}{' '}
                {slopeIText(ch.crestOffset - ch.offset, ch.crestElevation - ch.elevation)}
              </text>
              <text x={x} y={y - 36} fontSize={13} textAnchor="middle" fill="#be123c" fontWeight={600} style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>
                FH={ch.elevation.toFixed(3)}
              </text>
              {ch.groundElevation != null && (
                <text x={x} y={yGround + 15} fontSize={12} textAnchor="middle" fill="#8a5a2b" fontWeight={600} style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>
                  {roughMeters(Math.abs(ch.elevation - ch.groundElevation))}
                </text>
              )}
            </g>
          ))}

          {tomboDraw.map(({ tb, x, y, yGround }) => (
            <g key={'tbt-' + tb.id} pointerEvents="none">
              <text x={x} y={y - 28} fontSize={13} textAnchor="middle" fill="#6d28d9" fontWeight={600} style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>
                {tb.label} {shiftText(tb.offset)} FH{signed(tb.dh)}
              </text>
              <text x={x} y={y - 12} fontSize={13} textAnchor="middle" fill="#6d28d9" fontWeight={600} style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>
                FH={tb.elevation.toFixed(3)}
              </text>
              {tb.groundElevation != null && (
                <text x={x} y={yGround + 15} fontSize={12} textAnchor="middle" fill="#8a5a2b" fontWeight={600} style={{ paintOrder: 'stroke', stroke: '#fff', strokeWidth: 3 }}>
                  {roughMeters(Math.abs(tb.elevation - tb.groundElevation))}
                </text>
              )}
            </g>
          ))}

          {/* 計算 中 の 線分。 世界レイヤ の 外 な ので vx/vy (パン/ズーム 込み)。
              他 の 線 より 上 に 出して 狙い を 見せる。 */}
          {calcPreview && centerHeight !== undefined && (() => {
            const fx = vx(calcPreview.from.offset)
            const fy = vy(calcPreview.from.elevation - centerHeight)
            const ox = vx(calcPreview.original.offset)
            const oy = vy(calcPreview.original.elevation - centerHeight)
            const to = calcPreview.to
            return (
              <g pointerEvents="none">
                {/* いま の 線分 (計算 対象) */}
                <line x1={fx} y1={fy} x2={ox} y2={oy} stroke="#f59e0b" strokeWidth={3} opacity={0.8} />
                <circle cx={fx} cy={fy} r={5} fill="#f59e0b" stroke="#fff" strokeWidth={1.5} />
                <circle cx={ox} cy={oy} r={5} fill="none" stroke="#f59e0b" strokeWidth={2} />
                {to &&
                  (() => {
                    // 仮 の 断面: 基準点 → 仮 の 位置 → その 外側 の 点 まで 繋ぐ。
                    // 保持 / スライド の どちら を 選んで いる か が 形 で 分かる。
                    const outer = calcPreview.outer ?? []
                    const pts = [
                      { x: fx, y: fy },
                      { x: vx(to.offset), y: vy(to.elevation - centerHeight) },
                      ...outer.map((p) => ({
                        x: vx(p.offset),
                        y: vy(p.elevation - centerHeight),
                      })),
                    ]
                    const d = pts
                      .map((p, k) => (k === 0 ? 'M ' : 'L ') + p.x + ' ' + p.y)
                      .join(' ')
                    return (
                      <>
                        <path
                          d={d}
                          fill="none"
                          stroke="#db2777"
                          strokeWidth={2}
                          strokeDasharray="5,3"
                        />
                        {outer.map((p, k) => (
                          <circle
                            key={k}
                            cx={vx(p.offset)}
                            cy={vy(p.elevation - centerHeight)}
                            r={3.5}
                            fill="#fff"
                            stroke="#db2777"
                            strokeWidth={1.5}
                          />
                        ))}
                        <circle
                          cx={vx(to.offset)}
                          cy={vy(to.elevation - centerHeight)}
                          r={6}
                          fill="#db2777"
                          stroke="#fff"
                          strokeWidth={2}
                        />
                      </>
                    )
                  })()}
              </g>
            )
          })()}

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
})


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
  /**
   * トレース する 側。 断面 は 中心 から 左右 に 分かれて いる ので、
   * 「中心 から 左 へ」 「中心 から 右 へ」 と 別々 に なぞる。
   *   right … 拾う たび に 列 の 末尾 (右 の 外側) へ
   *   left  … 拾う たび に 列 の 先頭 (左 の 外側) へ
   * 結果 と して 列 は 左外 → 中心 → 右外 の 断面 の 並び に なる。
   * null は 従来 どおり 「追加位置」 の キャレット に 従う。
   */
  const [traceSide, setTraceSide] = useState<'left' | 'right' | null>(null)
  // station or 対象 が 変わった時 に 該当 断面の 点列を 再読込
  useEffect(() => {
    const initial = (station[stationSectionKey] as MeasuredCrossPoint[] | null | undefined) ?? []
    setLocalPoints(initial.map((p) => ({ ...p })))
    setInsertIndex(null)
    setTraceSide(null)
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
        // 側 を 選んで いる 間 は その 側 の 外側 に 伸ばす
        if (traceSide === 'right') return [...pts, pt]
        if (traceSide === 'left') return [pt, ...pts]
        const at = insertIndex == null ? pts.length : Math.min(insertIndex, pts.length)
        return [...pts.slice(0, at), pt, ...pts.slice(at)]
      })
      // 割り込み 中 は キャレット も 1 つ 進めて、続けて 拾って も 順 が 崩れない。
      // 左 を なぞって いる 間 は 先頭 に 積む ので キャレット も 1 つ 後ろ へ。
      setInsertIndex((i) => (i == null ? null : i + 1))
      return
    }
  }
  const clearLocalPoints = () => {
    setLocalPoints([])
    setInsertIndex(null)
  }
  /**
   * 直前 の 1 点 を 取消。 側 を 選んで いる 間 は その 側 の 外端 (右 なら 末尾、
   * 左 なら 先頭)、それ 以外 は キャレット の 直前。
   */
  const undoLastPoint = () => {
    setLocalPoints((pts) => {
      if (pts.length === 0) return pts
      if (traceSide === 'right') return pts.slice(0, -1)
      if (traceSide === 'left') return pts.slice(1)
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
    // 側 を 選んで いる 間 は その 側 の 端 から 引く
    const p =
      traceSide === 'right'
        ? localPoints[localPoints.length - 1]
        : traceSide === 'left'
          ? localPoints[0]
          : null
    if (p) {
      return {
        x: parsedCalib.centerX + (p.offset * 1000) / parsedCalib.hScale,
        y:
          parsedCalib.dlY +
          ((p.elevation - parsedCalib.dlElevation) * 1000) / parsedCalib.vScale,
      }
    }
    const at = insertIndex == null ? localPoints.length : Math.min(localPoints.length, insertIndex)
    if (at === 0) return null
    const q = localPoints[at - 1]
    return {
      x: parsedCalib.centerX + (q.offset * 1000) / parsedCalib.hScale,
      y: parsedCalib.dlY + ((q.elevation - parsedCalib.dlElevation) * 1000) / parsedCalib.vScale,
    }
  }, [parsedCalib, localPoints, insertIndex, traceSide])

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
                  {/* 断面 は 中心 から 左右 に 分かれる ので、側 を 決めて から なぞる。
                      左 は 拾う たび に 列 の 先頭、右 は 末尾 に 積む ので、
                      でき上がる 列 は 左外 → 中心 → 右外 の 並び に なる。 */}
                  <div className="flex gap-1">
                    {([
                      { side: 'left' as const, label: '← 左をトレース' },
                      { side: 'right' as const, label: '右をトレース →' },
                    ]).map((b) => {
                      const on = pickMode === 'trace' && traceSide === b.side
                      return (
                        <button
                          key={b.side}
                          onClick={() => {
                            if (on) {
                              setPickMode(null)
                              setTraceSide(null)
                              return
                            }
                            setTraceSide(b.side)
                            setInsertIndex(null)
                            setPickMode('trace')
                          }}
                          className={`flex-1 px-1.5 py-1 border rounded ${
                            on ? 'text-white' : 'bg-white hover:bg-slate-50'
                          }`}
                          style={on ? { backgroundColor: meta.color, borderColor: meta.color } : {}}
                        >
                          {b.label}
                        </button>
                      )
                    })}
                  </div>
                  <button
                    onClick={() => {
                      if (pickMode === 'trace' && traceSide == null) {
                        setPickMode(null)
                        return
                      }
                      setTraceSide(null)
                      setPickMode('trace')
                    }}
                    className={`px-2 py-1 border rounded text-left ${
                      pickMode === 'trace' && traceSide == null
                        ? 'text-white'
                        : 'bg-white hover:bg-slate-50'
                    }`}
                    style={
                      pickMode === 'trace' && traceSide == null
                        ? { backgroundColor: meta.color, borderColor: meta.color }
                        : {}
                    }
                    title="側 を 決めず に、下 の 「追加位置」 の 場所 へ 足す"
                  >
                    {pickMode === 'trace' && traceSide == null
                      ? 'トレース 中 (クリックで 追加)'
                      : `${meta.label}を 位置指定 で トレース`}
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
                    中心 から 外 へ 向かって なぞる。 1 クリック = 1 点 追加、
                    BS で 直前 1 点 取消。 ピック ON 時は 端点 (青) / 交点 (橙×) に 吸い付く。
                  </div>
                  <div className="flex items-center gap-1 text-[11px] pt-1 border-t">
                    <span className="text-slate-500">
                      拾い済 {localPoints.length} 点
                      <span className="ml-1 text-slate-400">
                        (左 {localPoints.filter((p) => p.offset < 0).length} / 中心{' '}
                        {localPoints.filter((p) => p.offset === 0).length} / 右{' '}
                        {localPoints.filter((p) => p.offset > 0).length})
                      </span>
                    </span>
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
                              {/* 中心 から どちら 側 の 点 か */}
                              <span
                                className={`w-4 text-center ${
                                  p.offset < 0
                                    ? 'text-amber-700'
                                    : p.offset > 0
                                      ? 'text-emerald-700'
                                      : 'text-slate-400'
                                }`}
                              >
                                {p.offset < 0 ? 'L' : p.offset > 0 ? 'R' : 'C'}
                              </span>
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
                    {traceSide != null && (
                      <div className="mt-1 text-[11px] text-slate-500">
                        {traceSide === 'left' ? '左' : '右'} を なぞって います。 拾った 点 は
                        {traceSide === 'left' ? ' 列 の 先頭' : ' 列 の 末尾'} に 積まれ、
                        列 全体 は 左外 → 中心 → 右外 の 並び に なり ます。
                      </div>
                    )}
                    {traceSide == null && insertIndex != null && (
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

/**
 * 路線線形 の 画面。 線形物 (kind='channel') と 整地 (kind='grading') で 共用 する。
 * 整地 は 線形 が BP と EP の 直線 だけ で、 平行 縦断 の 格子 を 持つ。
 */
export function OpenChannelAlignmentPage({ kind = 'channel' }: { kind?: ChannelKind } = {}) {
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const { coordinates, fetchCoordinates, addCoordinatesBulk, updateCoordinatesBulk } =
    useCoordinateStore()
  const {
    channels: allChannels,
    fetchChannels,
    addChannel,
    updateChannel,
    deleteChannel,
  } = useOpenChannelStore()
  // 追加 / 保存 の 失敗 は ストア に しか 残ら ない ので、 ここ で 拾って 出す。
  // マイグレーション 未適用 (kind 列 が 無い) など は これ で 気付ける
  const channelStoreError = useOpenChannelStore((st) => st.error)
  // この 画面 は 1 種別 だけ を 扱う。 サイドバー も 同じ 分け方
  const channels = useMemo(() => allChannels.filter((c) => c.kind === kind), [allChannels, kind])
  const isGrading = kind === 'grading'
  const basePath = isGrading ? '/grading/alignment' : '/open-channel/alignment'

  const farmId = currentFarm?.id
  /** 整地 の 路線 を 二重 に 作ら ない ため の 錠 */
  const gradingCreatingRef = useRef(false)
  useEffect(() => {
    if (!farmId) return
    fetchCoordinates(farmId)
    void (async () => {
      await fetchChannels(farmId)
      // 整地 は 1 工区 に 1 路線 だけ。 追加 ボタン は 出さ ず、 無ければ ここ で 作る
      if (!isGrading || gradingCreatingRef.current) return
      const exists = useOpenChannelStore
        .getState()
        .channels.some((c) => c.farmId === farmId && c.kind === 'grading')
      if (exists) return
      gradingCreatingRef.current = true
      try {
        await addChannel(farmId, '整地路線', 'grading')
      } finally {
        gradingCreatingRef.current = false
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, isGrading, fetchCoordinates, fetchChannels])

  // 整地 の 工事区域。 グリッド の 範囲 は これ から 決める
  const fetchWorkAreas = useWorkAreaStore((st) => st.fetchWorkAreas)
  const gradingAreas = useWorkAreaStore((st) => st.workAreas.grading)
  useEffect(() => {
    if (!isGrading || !farmId) return
    void fetchWorkAreas(farmId)
  }, [isGrading, farmId, fetchWorkAreas])

  // 座標系
  const zone = useMemo(() => {
    if (!currentFarm) return 13
    return projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // どの 線形 を 開く か は URL (/open-channel/alignment/:channelId)。
  // サイドバー の サブメニュー が 線形 そのもの な ので、画面 内 の プルダウン は 廃止。
  const navigate = useNavigate()
  const { channelId } = useParams<{ channelId?: string }>()
  const selectedId = channelId ?? null
  /** 線形 を 切り替える (新規追加 の 直後 など に 使う) */
  const gotoChannel = (id: string | null) =>
    navigate(id ? `${basePath}/${id}` : basePath, { replace: true })
  // URL が 無い / 消えた 線形 を 指して いる ときは 先頭 に 寄せる
  useEffect(() => {
    if (channels.length === 0) return
    if (!selectedId || !channels.find((c) => c.id === selectedId)) {
      gotoChannel(channels[0].id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // 整地 は 直線 だけ。 BP と EP が 揃って いたら それ 以上 は 足さ ない
    if (isGrading && selected.alignmentPoints.length >= 2) {
      window.alert('整地 の 路線 は BP と EP の 2 点 だけ です。 変える ときは 既存 の 点 を 消して ください。')
      return
    }
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

    // 幅杭 の 逆計算: 選んだ 座標 を 中心線 に 逆投影 して 一覧 に 溜める。
    // 登録 は モーダル 下 の 一括ボタン で まとめて 行う。
    if (widthStakePick) {
      const coord = coordinates.find((c) => c.id === coordId)
      if (!coord) return
      if (segments.length === 0) {
        window.alert('線形 が まだ 計算 されて いません')
        return
      }
      if (reverseRows.some((r) => r.id === coord.id)) return // 同じ 点 は 1 回 だけ
      const r = projectPointToAlignment(segments, { x: coord.x, y: coord.y })
      if (!r) {
        window.alert('中心線 に 投影 できません でした')
        return
      }
      // offset は 'forward' (起点→終点 視点) で 右 が 正。 河川 慣習 は 反転
      const sign = selected.sideOrientation === 'reverse' ? -1 : 1
      const off = Math.round(r.offset * sign * 1000) / 1000
      const sp = Math.round((r.distance + (selected.spOffset ?? 0)) * 1000) / 1000
      setReverseRows((prev) => [
        ...prev,
        {
          id: coord.id,
          sourceName: coord.pointNumber ?? '(名前なし)',
          x: coord.x,
          y: coord.y,
          z: coord.z,
          sp,
          offset: off,
          gap: Math.round(r.gap * 1000) / 1000,
          name: defaultStakeName(sp, off),
          sourceType: coord.type,
          // 点種 は 直前 に 選んだ 行 に ならう。 続けて 拾う とき に
          // 毎回 選び 直さ なくて 済む。 1 点目 だけ 既定 の 幅杭。
          type: prev.length > 0 ? prev[prev.length - 1].type : 'width_stake',
          stakeType: '',
          // メモ は 自動 で は 入れない (要る とき だけ 手 で 入れる)
          notes: '',
        },
      ])
      return
    }

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
    // 整地 は BP と EP の 直線 だけ
    if (isGrading && selected.alignmentPoints.length >= 2) return
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

  /**
   * いま 編集 して いる 縦断。 null = 主縦断 (中心線)。
   * 主縦断 だけ が 測点 の 中心設計高 / 杭打ち / エクスポート に 効く。
   * 追加 の 縦断 は 縦断図 に 重ねて 管理 する ため だけ の もの。
   */
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null)
  // 参照 が 毎 レンダー 変わる と 下 の useEffect / useMemo が 回り 続ける
  const extraProfiles = useMemo(() => selected?.extraProfiles ?? [], [selected])
  // 路線 を 変えたり 縦断 を 消したり した とき は 主縦断 に 戻す
  useEffect(() => {
    if (activeProfileId != null && !extraProfiles.some((p) => p.id === activeProfileId)) {
      setActiveProfileId(null)
    }
  }, [activeProfileId, extraProfiles])
  const activeProfile = extraProfiles.find((p) => p.id === activeProfileId) ?? null
  const activeProfileName = activeProfile ? activeProfile.name : '中心 (主縦断)'
  const activeProfilePoints = useMemo<ProfilePoint[]>(
    () => (activeProfile ? activeProfile.points : (selected?.profilePoints ?? [])),
    [activeProfile, selected],
  )

  /** いま 編集 して いる 縦断 の 変化点列 を 書き戻す */
  const writeActiveProfile = (next: ProfilePoint[]) => {
    if (!selected) return
    if (activeProfileId == null) {
      updateChannel(selected.id, { profilePoints: next })
      return
    }
    updateChannel(selected.id, {
      extraProfiles: extraProfiles.map((p) =>
        p.id === activeProfileId ? { ...p, points: next } : p,
      ),
    })
  }

  const handleAddExtraProfile = () => {
    if (!selected) return
    const name = window.prompt('縦断 の 名前 (例: 道路高 / 側溝高 / 左築堤高)', '')
    if (name == null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    const id = `pf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    updateChannel(selected.id, {
      extraProfiles: [...extraProfiles, { id, name: trimmed, points: [] }],
    })
    setActiveProfileId(id)
  }
  const handleRenameExtraProfile = () => {
    if (!selected || !activeProfile) return
    const name = window.prompt('縦断 の 名前', activeProfile.name)
    if (name == null) return
    const trimmed = name.trim()
    if (trimmed === '') return
    updateChannel(selected.id, {
      extraProfiles: extraProfiles.map((p) =>
        p.id === activeProfile.id ? { ...p, name: trimmed } : p,
      ),
    })
  }
  const handleRemoveExtraProfile = () => {
    if (!selected || !activeProfile) return
    if (
      !window.confirm(
        `縦断 「${activeProfile.name}」 を 変化点 ${activeProfile.points.length} 点 ごと 消します。よろしいですか？`,
      )
    )
      return
    updateChannel(selected.id, {
      extraProfiles: extraProfiles.filter((p) => p.id !== activeProfile.id),
    })
    setActiveProfileId(null)
  }

  const commitNewProfile = () => {
    if (!selected) return
    // 入力欄 は SP 値 (中間点計算 と 同じ)。内部保存は 距離 = SP - spOffset
    const sp = parseFloat(newProfileDistText)
    const h = parseFloat(newProfileHText)
    if (!Number.isFinite(sp) || !Number.isFinite(h)) return
    const d = sp - (selected.spOffset ?? 0)
    const next: ProfilePoint[] = [...activeProfilePoints, { distance: d, floorHeight: h }]
    next.sort((a, b) => a.distance - b.distance)
    writeActiveProfile(next)
    setNewProfileDistText('')
    setNewProfileHText('')
  }

  const sortedProfile = useMemo<ProfilePoint[]>(
    () => [...activeProfilePoints].sort((a, b) => a.distance - b.distance),
    [activeProfilePoints],
  )

  // 縦断曲線 (VCL > 0 の 中間 変化点) を PVI インデックス で 引ける Map
  const profileCurvesByPviIndex = useMemo(() => {
    const map = new Map<number, VerticalCurve>()
    for (const c of computeVerticalCurves(sortedProfile)) map.set(c.pviIndex, c)
    return map
  }, [sortedProfile])

  const handleRemoveProfile = (idx: number) => {
    writeActiveProfile(activeProfilePoints.filter((_, i) => i !== idx))
  }
  const handleChangeProfile = (idx: number, patch: Partial<ProfilePoint>) => {
    const arr = activeProfilePoints.map((p, i) => (i === idx ? { ...p, ...patch } : p))
    arr.sort((a, b) => a.distance - b.distance)
    writeActiveProfile(arr)
  }

  /**
   * 幅杭 の 逆計算 の 待機。 地図 の 座標 を 押す と、 その 点 を 中心線 に
   * 逆投影 して SP と オフセット を 出し、 幅杭 と して 足す。
   */
  const [widthStakePick, setWidthStakePick] = useState(false)
  // 点種 は プロジェクト 単位 で 足せる ので、 その 一覧 を 引いて おく
  const pointTypesByProject = useCoordinatePointTypeStore((st) => st.byProject)
  const fetchPointTypes = useCoordinatePointTypeStore((st) => st.fetchForProject)
  const addPointType = useCoordinatePointTypeStore((st) => st.addType)
  const projectId = currentFarm?.project_id ?? null
  useEffect(() => {
    if (projectId) void fetchPointTypes(projectId)
  }, [projectId, fetchPointTypes])
  const coordTypeOptions = useMemo(
    () => getCoordinateTypeOptions(projectId, pointTypesByProject),
    [projectId, pointTypesByProject],
  )

  /** 逆計算 で 拾った 点。 まとめて 座標登録 する まで ここ に 溜める */
  const [reverseRows, setReverseRows] = useState<ReverseStakeRow[]>([])
  /** 座標登録 と 一緒 に 幅杭計算 の 表 にも 入れる か */
  const [reverseAlsoWidthStake, setReverseAlsoWidthStake] = useState(true)

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

  /**
   * 逆計算 の 結果 を 座標管理 に 反映 する。
   *
   * 選んで いる の は 既に 登録 済み の 座標 な ので、 新しく 作る と 二重 に
   * なる。 名前 / 点種 / 杭種 / メモ を その 座標 に 上書き する。
   * 「幅杭計算 の 表 にも 追加」 が 入って いれば 幅杭 に も 入れる。
   */
  const handleRegisterReverseStakes = async (rows: ReverseStakeRow[]): Promise<number> => {
    if (!selected || rows.length === 0) return 0
    const n = await updateCoordinatesBulk(
      rows.map((r) => ({
        id: r.id,
        pointNumber: r.name.trim() || defaultStakeName(r.sp, r.offset),
        // 「元 の まま」 は ここ で 元 の 座標 の 種別 に 戻す
        type: r.type === KEEP_SOURCE_TYPE ? r.sourceType : r.type,
        stakeType: r.stakeType.trim() || null,
        notes: r.notes.trim() || null,
      })),
    )
    if (n === 0) return 0
    if (reverseAlsoWidthStake) {
      const stakes: WidthStake[] = rows.map((r) => ({
        id: newWidthStakeId(),
        distance: Math.round((r.sp - (selected.spOffset ?? 0)) * 1000) / 1000,
        offset: r.offset,
        note: r.name.trim() || undefined,
      }))
      const next = [...selected.widthStakes, ...stakes].sort((a, b) => a.distance - b.distance)
      updateChannel(selected.id, { widthStakes: next })
    }
    setReverseRows([])
    return n
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
  const measuredPointsOnStation = (
    st: StationRow,
    opts?: {
      /** 中心線 沿い の 帯 の 厚さ [m]。 既定 は 画面 の 横断幅 */
      bandM?: number
      /** 中心 から 左右 の 上限 [m]。 null / 未指定 は 制限 なし */
      halfWidthM?: number | null
    },
  ): MeasuredCrossPoint[] => {
    if (!farmId) return []
    const bandM = opts?.bandM != null && opts.bandM > 0 ? opts.bandM : crossBandM
    const halfWidthM = opts?.halfWidthM ?? null
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
      // 中心線 沿い の ずれが 帯 の 厚さ に 収まる もの だけ
      if (Math.abs(dx * tangent.x + dy * tangent.y) > bandM) continue
      const offset = Math.round((dx * perpX + dy * perpY) * 1000) / 1000
      // 左右 の 幅 を 指定 して いる とき は その 外 を 捨てる
      if (halfWidthM != null && Math.abs(offset) > halfWidthM) continue
      out.push({
        id: `sr-${r.id}`,
        offset,
        elevation: Math.round(z * 1000) / 1000,
        note: r.targetName ?? undefined,
      })
    }
    out.sort((a, b) => a.offset - b.offset)
    return out
  }

  /**
   * 整地 の 横断図 を 描く 基準 高。
   *
   * 横断図 は 中心設計高 を 基準 に 組み立てる ので、 これ が 決まら ない と
   * 現況線 まで 出 なく なる。 整地 は 縦断 を 持た ない ので 中心 の 計画高 →
   * 現況 の 中心 → 断面 に ある 点、 の 順 に 代わり を 探す。
   * 線形物 は 従来 どおり 縦断 が 無ければ 描か ない (計画高 の 取り違え を 防ぐ)。
   */
  const stationDrawDatum = (st: StationRow): number | undefined => {
    const at0 = (pts: MeasuredCrossPoint[] | null | undefined) =>
      pointNearOffset(pts ?? [], 0, 0.5)?.elevation
    const planned = at0(st.plannedSectionRaw)
    if (planned != null) return planned
    if (st.currentGroundHeight != null) return st.currentGroundHeight
    const ground = st.currentSection?.length ? st.currentSection : measuredPointsOnStation(st)
    const cur = at0(ground)
    if (cur != null) return cur
    const asb = at0(st.asbuiltSection)
    if (asb != null) return asb
    // 中心 に 点 が 無い 断面 (片側 だけ 測った など) は 平均 を 基準 に して 出す
    if (ground.length > 0) {
      return ground.reduce((acc, p) => acc + p.elevation, 0) / ground.length
    }
    return undefined
  }

  const autoCurrentSection = useMemo<MeasuredCrossPoint[]>(() => {
    if (!selectedStation) return []
    return measuredPointsOnStation(selectedStation)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStation, farmId, segments, selected?.sideOrientation, stakingRecords, surveySlide, surveySets, crossBandM])

  /**
   * 表 の 上 の 取込 ボタン列。 「測点から追加」 は 一括 / 測点指定 に 分岐 し、
   * 一括 と LandXML は 条件 の 入力 欄 を 開いて から 確定 する。
   */
  const [sectionImportPanel, setSectionImportPanel] = useState<'records' | 'landxml' | null>(null)
  const [recordAddMenuOpen, setRecordAddMenuOpen] = useState(false)
  /** 一括 の 条件。 厚さ = 中心線 沿い の 帯、 幅 = 左右 の 上限 (空 は 制限なし) */
  const [bulkBandText, setBulkBandText] = useState<string>(() => String(crossBandM))
  const [bulkHalfWidthText, setBulkHalfWidthText] = useState<string>('')
  const bulkBandM = parseFloat(bulkBandText)
  const bulkHalfWidthM = bulkHalfWidthText.trim() === '' ? null : parseFloat(bulkHalfWidthText)
  const bulkCondOk =
    Number.isFinite(bulkBandM) &&
    bulkBandM > 0 &&
    (bulkHalfWidthM == null || (Number.isFinite(bulkHalfWidthM) && bulkHalfWidthM > 0))
  /** 条件 に 当たる 実測記録 (取込 前 の 件数 表示 用)。 測点 を 選んで いる とき だけ */
  const bulkCandidates = useMemo<MeasuredCrossPoint[]>(() => {
    if (!selectedStation || sectionImportPanel !== 'records' || !bulkCondOk) return []
    return measuredPointsOnStation(selectedStation, {
      bandM: bulkBandM,
      halfWidthM: bulkHalfWidthM,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStation, sectionImportPanel, bulkBandM, bulkHalfWidthM, bulkCondOk, stakingRecords, segments, crossBandM])

  /**
   * 条件 に 当たる 実測記録 を いま 開いて いる 断面 に まとめて 足す。
   * 既に 同じ 記録 が 入って いる 分 は 足さない。 並び は 中心 に 近い 順 に
   * 直す (オーバーハング を 手 で 直して いた 場合 は その 並び も 戻る)。
   */
  const handleBulkAddFromRecords = () => {
    if (!selectedStation || !bulkCondOk) return
    const t = sectionTargetOfEditTarget(editTarget)
    const cur = (selectedStation[sectionKeyOf(t)] as MeasuredCrossPoint[] | null) ?? []
    const have = new Set(cur.map((p) => p.id))
    const add = bulkCandidates.filter((p) => !have.has(p.id))
    if (add.length === 0) {
      window.alert('条件 に 当たる 実測記録 は ありません (既に 入って いる 分 は 除いて います)')
      return
    }
    const next = [...cur, ...add].sort((a, b) => a.offset - b.offset)
    handleReplaceStationSection(selectedStation.id, t, next)
    setSectionImportPanel(null)
  }

  /**
   * 断面 上 の 離れ → 実座標。
   * computeStationVertices と 同じ 式 (中心 + 離れ × 中心線 の 直角方向)。
   */
  const sectionOffsetToWorld = (
    st: StationRow,
    offset: number,
  ): { x: number; y: number } | null => {
    const center = pointAtDistance(segments, st.distance)
    const tangent = tangentAtDistance(segments, st.distance)
    if (!center || !tangent) return null
    const sign = selected?.sideOrientation === 'reverse' ? -1 : 1
    const perp = { x: -tangent.y * sign, y: tangent.x * sign }
    return { x: center.x + offset * perp.x, y: center.y + offset * perp.y }
  }

  /**
   * トンボ を 解く。 基準 の 変化点 から 横 (dw) と 高さ (dh) だけ ずらす。
   * dw は 中心 から 遠ざかる 向き が 正 な ので、 基準点 が 左 なら 左 へ 伸びる。
   * 計画断面 を 取り込み 直す と 点 の id は 変わる ので、 見つから なければ
   * 定義 した ときの 離れ に 一番 近い 点 に 寄せる。
   */
  const resolveTomboFor = (st: StationRow, t: TomboPoint): ResolvedTombo | null => {
    const pts = st.plannedSectionRaw ?? []
    let base = pts.find((p) => p.id === t.basePointId) ?? null
    if (!base && pts.length > 0) {
      base = pts.reduce(
        (best, p) =>
          Math.abs(p.offset - t.baseOffset) < Math.abs(best.offset - t.baseOffset) ? p : best,
        pts[0],
      )
    }
    if (!base) return null
    const dir = base.offset >= 0 ? 1 : -1
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const offset = r3(base.offset + dir * t.dw)
    const elevation = r3(base.elevation + t.dh)
    return { base, offset, elevation, world: sectionOffsetToWorld(st, offset) }
  }

  /**
   * 丁張 を 解く。
   * 法尻 (基準点) から 外 へ W だけ 離した ところ に 杭 を 立て、 法尻 と 法肩 を
   * 結ぶ 法面線 を その 位置 まで 延ばした 高さ が 丁張高。 そこ から 法肩 まで の
   * 斜め の 長さ が 法長 に なる。
   */
  const resolveChohariFor = (st: StationRow, c: ChohariPoint): ResolvedChohari | null => {
    const pts = st.plannedSectionRaw ?? []
    const pick = (id: string, off: number) => {
      const exact = pts.find((p) => p.id === id)
      if (exact) return exact
      if (pts.length === 0) return null
      return pts.reduce(
        (best, p) => (Math.abs(p.offset - off) < Math.abs(best.offset - off) ? p : best),
        pts[0],
      )
    }
    const base = pick(c.basePointId, c.baseOffset)
    const crest = pick(c.crestPointId, c.crestOffset)
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    // W は 法面 の 反対 (もう 一方 の 端 から 遠ざかる 向き) が 正
    const dir = base && crest ? Math.sign(base.offset - crest.offset) || 1 : 1
    const offset = base ? r3(base.offset + dir * c.w) : 0
    const world = base ? sectionOffsetToWorld(st, offset) : null
    if (!base || !crest) {
      return { base, crest, offset, elevation: 0, slopeLength: 0, factor: null, world, error: '法尻 / 法肩 の 点 が 見つかりません' }
    }
    const dx = crest.offset - base.offset
    if (Math.abs(dx) < 1e-9) {
      return { base, crest, offset, elevation: 0, slopeLength: 0, factor: null, world, error: '法尻 と 法肩 の 離れ が 同じ です (直立 の 面 は 丁張 を 掛けられません)' }
    }
    // 法面線 の 傾き。 外 向き 1m あたり の 上がり に 直す
    const m = (crest.elevation - base.elevation) / dx
    const factor = m * dir
    // 杭 の 位置 まで 法面線 を 延ばした 高さ
    const elevation = r3(base.elevation + m * (offset - base.offset))
    // 杭 の 位置 の 点 から 法肩 まで の 斜長
    const slopeLength = r3(Math.hypot(crest.offset - offset, crest.elevation - elevation))
    return { base, crest, offset, elevation, slopeLength, factor, world }
  }

  /** 丁張 を 座標管理 へ */
  const handleRegisterChohari = async (
    stationId: string,
    items: { cho: ChohariPoint; resolved: ResolvedChohari }[],
  ) => {
    const st = stations.find((x) => x.id === stationId)
    if (!st || items.length === 0) return
    const rows = items.map(({ cho, resolved }) => ({
      pointNumber:
        cho.name?.trim() ||
        `${st.label}-${resolved.base ? labelOfPoint(resolved.base) : 'C'}-丁張`,
      x: resolved.world?.x ?? 0,
      y: resolved.world?.y ?? 0,
      z: resolved.elevation,
      type: 'chohari' as const,
      stakeType: '丁張',
      notes: `${selected?.name ?? ''} ${st.label} W${cho.w >= 0 ? '+' : ''}${cho.w} 法長 ${resolved.slopeLength.toFixed(3)}`,
    }))
    const added = await addCoordinatesBulk(rows)
    if (added.length !== items.length) return
    const idOf = new Map(items.map((it, i) => [it.cho.id, added[i].id]))
    setStations(
      stations.map((x) =>
        x.id === stationId
          ? {
              ...x,
              chohari: (x.chohari ?? []).map((t) =>
                idOf.has(t.id) ? { ...t, coordinateId: idOf.get(t.id) as string } : t,
              ),
            }
          : x,
      ),
    )
  }

  /** トンボ を 座標管理 へ。 登録 できた 座標 id は トンボ に 書き戻す */
  const handleRegisterTombos = async (
    stationId: string,
    items: { tombo: TomboPoint; resolved: ResolvedTombo }[],
  ) => {
    const st = stations.find((x) => x.id === stationId)
    if (!st || items.length === 0) return
    const sign = (v: number) => (v >= 0 ? '+' : '')
    const rows = items.map(({ tombo, resolved }) => ({
      pointNumber:
        tombo.name?.trim() ||
        `${st.label}-${resolved.base ? labelOfPoint(resolved.base) : 'T'}-トンボ`,
      x: resolved.world?.x ?? 0,
      y: resolved.world?.y ?? 0,
      z: resolved.elevation,
      type: 'tombo' as const,
      stakeType: 'トンボ',
      notes: `${selected?.name ?? ''} ${st.label} W${sign(tombo.dw)}${tombo.dw} H${sign(tombo.dh)}${tombo.dh}`,
    }))
    const added = await addCoordinatesBulk(rows)
    if (added.length !== items.length) return
    const idOf = new Map(items.map((it, i) => [it.tombo.id, added[i].id]))
    setStations(
      stations.map((x) =>
        x.id === stationId
          ? {
              ...x,
              tombos: (x.tombos ?? []).map((t) =>
                idOf.has(t.id) ? { ...t, coordinateId: idOf.get(t.id) as string } : t,
              ),
            }
          : x,
      ),
    )
  }

  /**
   * 断面図 の 点 を 押した とき。 トンボ の 基準点 を 図 で 選んで いる 最中 なら
   * その 点 を 基準 に して 待機 を 解く。 そう で なければ 従来 どおり 選択 だけ。
   */
  /**
   * 丁張 の 対象 法面 を 図 の 線分 で 選んだ とき。
   * 杭 は 土工 の 外 に 立てる ので、 線分 の うち 中心 から 遠い 方 の 端 を
   * 基準 (W を 測る 起点) に し、 近い 方 を 法長 の 終端 に する。
   */
  const handleSelectSectionSegment = (fromId: string, toId: string) => {
    const st = tomboStationId ? stations.find((x) => x.id === tomboStationId) : null
    if (!st || !pickTarget || pickTarget.kind !== 'choSegment') return
    const pts = st.plannedSectionRaw ?? []
    const a = pts.find((p) => p.id === fromId)
    const b = pts.find((p) => p.id === toId)
    if (!a || !b) return
    const outer = Math.abs(a.offset) >= Math.abs(b.offset) ? a : b
    const inner = outer === a ? b : a
    const rowId = pickTarget.rowId
    setStations(
      stations.map((x) =>
        x.id === st.id
          ? {
              ...x,
              chohari: (x.chohari ?? []).map((c) =>
                c.id === rowId
                  ? {
                      ...c,
                      basePointId: outer.id,
                      baseOffset: outer.offset,
                      crestPointId: inner.id,
                      crestOffset: inner.offset,
                    }
                  : c,
              ),
            }
          : x,
      ),
    )
    // 次 は 基準点 (W を 測る 起点) を 選んで もらう
    setPickTarget({ kind: 'choBase', rowId })
  }

  /** 丁張 の 杭 の 位置 を 図 で 決めた とき。 基準点 から の W に 直す */
  const handlePickChohariOffset = (offset: number) => {
    const st = tomboStationId ? stations.find((x) => x.id === tomboStationId) : null
    if (!st || !pickTarget || pickTarget.kind !== 'choPos') return
    const rowId = pickTarget.rowId
    const cur = (st.chohari ?? []).find((c) => c.id === rowId)
    if (!cur) return
    const r = resolveChohariFor(st, cur)
    if (!r || !r.base || !r.crest) return
    // W は 法面 の 反対 へ 向かう 向き が 正
    const dir = Math.sign(r.base.offset - r.crest.offset) || 1
    const w = Math.round((offset - r.base.offset) * dir * 1000) / 1000
    setStations(
      stations.map((x) =>
        x.id === st.id
          ? {
              ...x,
              chohari: (x.chohari ?? []).map((c) => (c.id === rowId ? { ...c, w } : c)),
            }
          : x,
      ),
    )
    setPickTarget(null)
  }

  const handleSelectSectionPoint = (id: string | null) => {
    const st = tomboStationId ? stations.find((x) => x.id === tomboStationId) : null
    const p = st && id ? (st.plannedSectionRaw ?? []).find((x) => x.id === id) : null
    if (pickTarget && p && st) {
      const target = pickTarget
      setStations(
        stations.map((x) => {
          if (x.id !== st.id) return x
          if (target.kind === 'tombo') {
            return {
              ...x,
              tombos: (x.tombos ?? []).map((t) =>
                t.id === target.rowId
                  ? { ...t, basePointId: p.id, baseOffset: p.offset }
                  : t,
              ),
            }
          }
          if (target.kind === 'choBase') {
            return {
              ...x,
              chohari: (x.chohari ?? []).map((c) => {
                if (c.id !== target.rowId) return c
                // 反対 の 端 を 押したら 基準 と 相手端 を 入れ替える
                if (p.id === c.crestPointId) {
                  return {
                    ...c,
                    basePointId: c.crestPointId,
                    baseOffset: c.crestOffset,
                    crestPointId: c.basePointId,
                    crestOffset: c.baseOffset,
                  }
                }
                return c
              }),
            }
          }
          return x
        }),
      )
      if (target.kind === 'tombo') setPickTarget(null)
      // 基準点 を 決めたら 次 は 杭 の 位置 (W)。
      // 線分 の 端 以外 を 押した ときは 何も せず 待機 の まま に する。
      if (target.kind === 'choBase') {
        const c = (st.chohari ?? []).find((y) => y.id === target.rowId)
        if (c && (p.id === c.basePointId || p.id === c.crestPointId)) {
          setPickTarget({ kind: 'choPos', rowId: target.rowId })
        }
      }
    }
    setSelectedPointId(id)
  }

  /** 横断図 の 表示リセット を 表題行 の ボタン から 呼ぶ */
  const crossViewRef = useRef<CrossSectionViewHandle | null>(null)
  /**
   * 横断図 に 出す レイヤ。 線 が 重なる と 読め ない ので、現況 / 計画 /
   * 出来形 と 文字 を それぞれ 消せる ように する。 端末 に 憶える。
   */
  const [crossLayers, setCrossLayers] = useState<{
    planned: boolean
    current: boolean
    asbuilt: boolean
    dimText: boolean
    pointText: boolean
  }>(() => {
    const def = { planned: true, current: true, asbuilt: true, dimText: true, pointText: true }
    try {
      const raw = localStorage.getItem('oc:crossLayers')
      return raw ? { ...def, ...(JSON.parse(raw) as Record<string, boolean>) } : def
    } catch {
      return def
    }
  })
  /**
   * 格子 点 の 高さ を 測点 の 横断 に 書く。
   * その 離れ に 点 が あれば 標高 を 差し替え、 無ければ 足す。 null なら 消す。
   * 中心 (離れ 0) の 現況 / 計画 は replaceSectionIn が 中心高 も 同期 して くれる。
   */
  const setGridHeight = (
    stationId: string,
    target: SectionTarget,
    offset: number,
    elevation: number | null,
  ) => {
    const st = stations.find((x) => x.id === stationId)
    if (!st) return
    const key = sectionKeyOf(target)
    const cur = ((st[key] as MeasuredCrossPoint[] | null | undefined) ??
      (target === 'current' ? measuredPointsOnStation(st) : [])).map((p) => ({ ...p }))
    const hit = pointNearOffset(cur, offset, 0.5)
    let next: MeasuredCrossPoint[]
    if (elevation == null) {
      next = hit ? cur.filter((p) => p !== hit) : cur
    } else if (hit) {
      next = cur.map((p) => (p === hit ? { ...p, offset, elevation } : p))
    } else {
      next = [...cur, { id: `grid-${stationId}-${offset}`, offset, elevation }]
      // 折れ線 の 並び を 保つ ため 離れ 順 に 入れ 直す (格子 は 単調 な 断面)
      next.sort((a, b) => a.offset - b.offset)
    }
    handleReplaceStationSection(stationId, target, next)
  }

  /**
   * 表計算 から の 貼り付け を まとめて 入れる。
   *
   * 1 点 ずつ 保存 する と 測点 の 数 だけ 書き込み が 走る ので、
   * 測点 ごと に 点列 を 組み直して から 1 回 で 保存 する。
   * 中心高 の 同期 は replaceSectionIn が 見て くれる。
   */
  const applyGridPaste = (
    cells: { stationId: string; idx: number; value: number | null }[],
    target: SectionTarget,
  ) => {
    if (!selected || cells.length === 0) return
    const cfg = selected.gridLines
    const key = sectionKeyOf(target)
    /** 測点 ごと に (離れ, 値) を まとめる */
    const byStation = new Map<string, { offset: number; value: number | null }[]>()
    for (const c of cells) {
      const list = byStation.get(c.stationId) ?? []
      list.push({ offset: gridLineOffset(cfg, c.idx), value: c.value })
      byStation.set(c.stationId, list)
    }
    let next = stations
    for (const [id, items] of byStation) {
      const st = next.find((x) => x.id === id)
      if (!st) continue
      let pts = (
        (st[key] as MeasuredCrossPoint[] | null | undefined) ??
        (target === 'current' ? measuredPointsOnStation(st) : [])
      ).map((p) => ({ ...p }))
      for (const it of items) {
        const hit = pointNearOffset(pts, it.offset, 0.5)
        if (it.value == null) {
          if (hit) pts = pts.filter((p) => p !== hit)
        } else if (hit) {
          hit.offset = it.offset
          hit.elevation = it.value
        } else {
          pts.push({ id: `grid-${id}-${it.offset}`, offset: it.offset, elevation: it.value })
        }
      }
      pts.sort((a, b) => a.offset - b.offset)
      next = replaceSectionIn(next, id, target, pts)
    }
    void updateChannel(selected.id, { stations: next })
  }

  /** トンボ の 計算 パネル を 開いて いる 測点 */
  const [tomboStationId, setTomboStationId] = useState<string | null>(null)
  /** 断面図 の クリック で どの 欄 を 決めよう と して いるか */
  const [pickTarget, setPickTarget] = useState<PickTarget | null>(null)
  /** 標準断面 の 選択 パネル を 開いて いる 測点 */
  const [standardSectionPicker, setStandardSectionPicker] = useState<{
    stationId: string
  } | null>(null)
  /** 計算 ダイアログ で いま 狙って いる 線分 (断面図 に 重ねる) */
  const [calcPreview, setCalcPreview] = useState<CalcPreview | null>(null)
  /** 図 と 表 で 共有 する 断面点 の 選択 */
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  // 測点 / 対象 を 変えたら 選択 は 外す
  useEffect(() => {
    setSelectedPointId(null)
  }, [selectedStationId, editTarget])
  const toggleCrossLayer = (k: keyof typeof crossLayers) => {
    setCrossLayers((prev) => {
      const next = { ...prev, [k]: !prev[k] }
      try {
        localStorage.setItem('oc:crossLayers', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }

  // ---- 計算書 (PDF) の 出力
  const [reportBusy, setReportBusy] = useState<AlignmentReportKind | null>(null)
  const handleExportReport = async (kind: AlignmentReportKind) => {
    if (!selected) return
    setReportBusy(kind)
    try {
      const { buildAlignmentReportPages, REPORT_SHEET, REPORT_LABEL } = await import(
        './alignmentReport'
      )
      const { renderToCanvas, canvasesToPdf, safeFileName, saveBlob } = await import(
        '@/features/boundary-survey/floorPlanExport'
      )
      const pages = buildAlignmentReportPages(kind, {
        siteName: currentFarm?.name ?? '',
        routeName: selected.name,
        spOffset,
        vertices: alignmentXY,
        vertexNames: selected.alignmentPoints.map(
          (p) => coordinates.find((c) => c.id === p.coordId)?.pointNumber ?? '',
        ),
        segments,
        stations: stations.map((st) => ({ label: st.label, distance: st.distance })),
        widthStakes: selected.widthStakes.map((w) => ({
          distance: w.distance,
          offset: w.offset,
          note: w.note,
        })),
      })
      // A4 横 は 200dpi で 2339 × 1654 px。 罫線 と 数字 が つぶれない 最低限
      const cvs = pages.map((items) => renderToCanvas(items, 200, REPORT_SHEET))
      const blob = await canvasesToPdf(cvs, REPORT_SHEET)
      saveBlob(blob, `${safeFileName(selected.name)}_${REPORT_LABEL[kind]}.pdf`)
    } catch (e) {
      console.error('[alignment report]', e)
      window.alert(e instanceof Error ? e.message : '計算書の出力に失敗しました')
    } finally {
      setReportBusy(null)
    }
  }
  /** 各セクション の 右上 に 置く 出力ボタン */
  /**
   * 横断 の 書き出し。 整地 は 横断 セクション を 出さ ない ので
   * グリッド計算 の 側 に 同じ もの を 置く。
   */
  const crossExportButtons = () => (
    <>
                  <button
                    type="button"
                    onClick={() => setDxfModalOpen(true)}
                    disabled={stations.length === 0}
                    className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                    title="横断図 を DXF で 出力 (用紙 / 縮尺 / DL / 中心位置 を 指定)"
                  >
                    DXF出力
                  </button>
                  <button
                    type="button"
                    onClick={handleExportLandXml}
                    disabled={!stationTin || stationTin.triangles.length === 0}
                    className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                    title="計画断面 を つないだ TIN を LandXML で 出力 (隣り合う 測点 の 同じ 要素 同士 を 結ぶ)"
                  >
                    LandXML
                  </button>
    </>
  )

  const reportButton = (kind: AlignmentReportKind, label: string) => (
    <button
      type="button"
      onClick={() => void handleExportReport(kind)}
      disabled={!selected || reportBusy != null}
      className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-40"
      title={`${label} を PDF (A4 横) で 出力`}
    >
      {reportBusy === kind ? '出力中…' : label}
    </button>
  )

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

  /** 地図 に 格子 を 重ねる か */
  const [showGridOnMap, setShowGridOnMap] = useState(true)
  /** グリッド表 で 選んで いる セル。 地図 に その 格子点 を 出す */
  const [gridCell, setGridCell] = useState<GridCellRef | null>(null)
  /** グリッド表 で 選んで いる 列。 下 の 縦断図 に その 線 を 出す */
  const [gridLineIdx, setGridLineIdx] = useState<number | null>(null)

  /**
   * 整地: 格子点 の 平面位置。 各 測点 の 中心 から 接線 に 直角 に 離れ だけ 進めた 点。
   * 幅杭 と 同じ 向き の 決め方 (sideOrientation='reverse' なら 左右 反転)。
   * 高さ が 入って いる か も 一緒 に 持たせて、 地図 上 で 調査 の 進み 具合 が 分かる ように する。
   */
  const gridMapRows = useMemo(() => {
    if (!isGrading || !selected || segments.length === 0) return []
    const cfg = selected.gridLines
    const sign = selected.sideOrientation === 'reverse' ? -1 : 1
    const sorted = [...stations].sort((a, b) => a.distance - b.distance)
    return gridLineIndices(cfg).map((idx) => {
      const offset = gridLineOffset(cfg, idx)
      const pts = sorted.flatMap((st) => {
        const c = pointAtDistance(segments, st.distance)
        const t = tangentAtDistance(segments, st.distance)
        if (!c || !t) return []
        // (x=北, y=東) 系 で 進行方向 の CCW 90° が 右
        const perpX = -t.y * sign
        const perpY = t.x * sign
        const ll = converter.toLatLng(c.x + offset * perpX, c.y + offset * perpY)
        const cur = st.currentSection?.length ? st.currentSection : measuredPointsOnStation(st)
        return [
          {
            stationId: st.id,
            label: st.label,
            distance: st.distance,
            lat: ll.lat,
            lng: ll.lng,
            current: pointNearOffset(cur, offset, 0.5)?.elevation ?? null,
            planned: pointNearOffset(st.plannedSectionRaw ?? [], offset, 0.5)?.elevation ?? null,
          },
        ]
      })
      return { idx, name: gridLineName(cfg, idx), offset, pts }
    })
    // measuredPointsOnStation は 毎 レンダ 作り直される ので 依存 に 入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGrading, selected, segments, stations, converter])

  /**
   * 整地: 選んだ 列 の 縦断。 計画 は 格子点 の 計画高、 現況 は 実測 から。
   * 中心 (idx=0) も 同じ 作り 方 に する。 主縦断 (profilePoints) と は 別物 で、
   * こちら は 横断 に 入って いる 高さ を 縦 に 読んだ もの。
   */
  const gridProfile = useMemo(() => {
    if (!isGrading || !selected || gridLineIdx == null) return null
    const cfg = selected.gridLines
    const off = gridLineOffset(cfg, gridLineIdx)
    const sorted = [...stations].sort((a, b) => a.distance - b.distance)
    const planned: ProfilePoint[] = sorted.flatMap((st) => {
      const p = pointNearOffset(st.plannedSectionRaw ?? [], off, 0.5)
      return p ? [{ distance: st.distance, floorHeight: p.elevation }] : []
    })
    const current = sorted.flatMap((st) => {
      const src = st.currentSection?.length ? st.currentSection : measuredPointsOnStation(st)
      const p = pointNearOffset(src, off, 0.5)
      return p ? [{ distance: st.distance, z: p.elevation }] : []
    })
    return { name: gridLineName(cfg, gridLineIdx), offset: off, planned, current }
    // measuredPointsOnStation は 毎 レンダ 作り直される ので 依存 に 入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGrading, selected, gridLineIdx, stations])

  /** 列 を 選ぶ: 下 の パネル を 縦断図 に 切り替えて 開く */
  const handleSelectGridLine = (idx: number) => {
    setGridLineIdx(idx)
    setBottomTab('profile')
    setProfileChartExpanded(true)
  }

  /** 選んだ セル に あたる 格子点 (地図 の 強調 と 寄せ に 使う) */
  const gridCellPoint = useMemo(() => {
    if (!gridCell) return null
    const row = gridMapRows.find((r) => r.idx === gridCell.idx)
    const p = row?.pts.find((x) => x.stationId === gridCell.stationId)
    return p && row ? { ...p, name: row.name, offset: row.offset } : null
  }, [gridCell, gridMapRows])

  /** 同じ 測点 の 格子点 を 横 に 結ぶ 線 (横断 方向) */
  const gridCrossLines = useMemo(() => {
    if (gridMapRows.length < 2) return []
    const count = gridMapRows[0].pts.length
    const out: [number, number][][] = []
    for (let j = 0; j < count; j++) {
      const line = gridMapRows
        .map((r) => r.pts[j])
        .filter((p) => p != null)
        .map((p) => [p.lat, p.lng] as [number, number])
      if (line.length >= 2) out.push(line)
    }
    return out
  }, [gridMapRows])

  /** グリッド間隔 の 下書き。 空 なら 保存済み の 値 を 使う */
  const [gridSpacingDraft, setGridSpacingDraft] = useState('')
  const gridSpacing = (() => {
    const v = parseFloat(gridSpacingDraft)
    if (Number.isFinite(v) && v > 0) return v
    return selected?.gridLines.spacing ?? 20
  })()

  /**
   * 整地 の 工事区域 を 中心線 に 投影 した 広がり。
   * 投影 は 線形 の 中 に 丸められる ので、 SP 方向 の 「1 つ 外」 は
   * 線形 が 区域 より 長い 分 だけ 出る。
   */
  const gradingAreaExtent = useMemo<GridExtent | null>(() => {
    if (!isGrading || segments.length === 0) return null
    const sign = selected?.sideOrientation === 'reverse' ? -1 : 1
    let dMin = Infinity
    let dMax = -Infinity
    let oMin = Infinity
    let oMax = -Infinity
    for (const area of gradingAreas ?? []) {
      for (const p of area.points) {
        const r = projectPointToAlignment(segments, { x: p.x, y: p.y })
        if (!r) continue
        const off = r.offset * sign
        if (r.distance < dMin) dMin = r.distance
        if (r.distance > dMax) dMax = r.distance
        if (off < oMin) oMin = off
        if (off > oMax) oMax = off
      }
    }
    if (!Number.isFinite(dMin) || !Number.isFinite(oMin)) return null
    return { dMin, dMax, oMin, oMax }
  }, [isGrading, segments, selected?.sideOrientation, gradingAreas])

  /**
   * グリッド計算。 間隔 を 決める と 中間点 (横断) と 平行 縦断 の 本数 が 決まる。
   * 範囲 は 工事区域 の 1 つ 外 の 格子 まで。 区域 が 無ければ 線形 の 全長。
   * 既に ある 測点 は 同じ SP なら 中身 ごと 引き継ぐ。
   */
  const handleGridCompute = () => {
    if (!selected || segments.length === 0) return
    if (!(gridSpacing > 0)) return
    const ext = gradingAreaExtent ?? { dMin: 0, dMax: totalLen, oMin: 0, oMax: 0 }
    const plan = gridPlanFromExtent(ext, gridSpacing, totalLen)
    if (plan.distances.length === 0) {
      window.alert('グリッド点 が 1 つ も できません でした。 間隔 と 工事区域 を 確かめて ください。')
      return
    }
    const byLabel = new Map(stations.map((st) => [st.label, st]))
    const rows: StationRow[] = plan.distances.map((d) => {
      const label = formatSp(d)
      const ex = byLabel.get(label)
      return ex ? { ...ex, distance: d } : { id: newStationId(), label, distance: d, crossSection: null }
    })
    setGridSpacingDraft('')
    void updateChannel(selected.id, {
      stations: rows,
      gridLines: {
        ...selected.gridLines,
        spacing: gridSpacing,
        leftCount: plan.leftCount,
        rightCount: plan.rightCount,
      },
    })
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
      // 整地 は 平行 縦断 と 同じ 間隔 で 切る (格子 に する ため)
      const pitch = isGrading ? (selected?.gridLines.spacing ?? stationPitch) : stationPitch
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
  /**
   * 測点 の 個別断面 を 差し替える。
   * 「現況まで」 の 区間 が 解け なかった 場合 は その 手前 で 打ち切り、
   * 打ち切った か どう か を 返す (呼び出し 側 で 知らせる ため)。
   */
  const handleUpdateStationCrossSection = (
    id: string,
    crossSection: StandardCrossSection | null,
  ): { truncated: boolean; reasons: string[]; groundCount: number } => {
    const target = stations.find((s) => s.id === id)
    if (!target) return { truncated: false, reasons: [], groundCount: 0 }
    const centerZ =
      target.plannedCenterHeight ??
      interpolateProfileZOrNull(selected?.profilePoints ?? [], target.distance) ??
      0
    // 「現況まで」 の 区間 は その 測点 の 現況断面 と の 交点 で 決まる。
    // 保存済み が 無い 測点 で も 図 に は 実測記録 から の 現況線 が 出て いる ので、
    // 取込 でも 同じ もの を 使う (図 と 食い違わ せない)。
    const groundForResolve = target.currentSection?.length
      ? target.currentSection
      : measuredPointsOnStation(target)
    const resolved =
      crossSection == null
        ? null
        : standardCsToMeasuredPoints(crossSection, centerZ, groundForResolve)
    const nextPoints = resolved?.points ?? null
    setStations(
      stations.map((s) =>
        s.id === id
          ? { ...s, crossSection, plannedSectionRaw: nextPoints }
          : s,
      ),
    )
    return {
      truncated: resolved?.truncated ?? false,
      reasons: resolved?.reasons ?? [],
      groundCount: groundForResolve.length,
    }
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

  /** 横断図 DXF の ダイアログ */
  const [dxfModalOpen, setDxfModalOpen] = useState(false)
  /**
   * DXF に 出せる 断面 (全測点)。 どれ を 出す か は ダイアログ で 選ぶ。
   * 計画 は 計画断面 の 変化点 (個別断面 が あれば それ)、
   * 現況 / 出来形 は 測点 に 入れた 点列。
   */
  const dxfSections = useMemo(() => {
    const vertexByStation = new Map(stationVertexLists.map((v) => [v.station.id, v.vertices]))
    return stations.map((s) => ({
      id: s.id,
      title: s.label,
      isControl: s.isControlStation === true,
      planned: (vertexByStation.get(s.id) ?? []).map((v) => ({ offset: v.offset, z: v.z })),
      current: (s.currentSection ?? []).map((p) => ({ offset: p.offset, z: p.elevation })),
      asbuilt: (s.asbuiltSection ?? []).map((p) => ({ offset: p.offset, z: p.elevation })),
    }))
  }, [stations, stationVertexLists])

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
            actions={reportButton('route', '計算書')}
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
                  {/* 線形 の 切替 は 左メニュー の サブメニュー。 ここ は 今 開いて
                      いる 線形 の 名前 と、名前 の 変更 / 追加 / 削除 だけ。 */}
                  <span className="flex-1 min-w-0 truncate text-sm font-semibold text-slate-800">
                    {selected?.name ?? '（線形なし）'}
                  </span>
                  <button
                    onClick={handleStartEditName}
                    disabled={!selected}
                    title="名前を編集"
                    className="shrink-0 p-1 border rounded hover:bg-slate-50 disabled:opacity-30"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {/* 整地 は 1 工区 に 1 路線 な ので 追加 も 削除 も 出さ ない */}
                  {!isGrading && (
                    <>
                      <button
                        onClick={async () => {
                          if (!farmId) return
                          const row = await addChannel(farmId, undefined, kind)
                          if (row) gotoChannel(row.id)
                        }}
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
                </>
              )}
            </div>

            {channelStoreError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-2 py-1 break-words">
                保存 に 失敗 しました: {channelStoreError}
                {/kind|grid_lines/i.test(channelStoreError) && (
                  <div className="mt-1 text-red-600">
                    DB に kind / grid_lines 列 が ありません。
                    migrations/20260924_open_channel_kind_grid.sql を 当てて ください。
                  </div>
                )}
              </div>
            )}
            {!selected && channels.length === 0 && (
              <div className="text-xs text-slate-500 border rounded bg-slate-50 px-2 py-2">
                {isGrading ? '整地 の 路線' : '線形物'} が まだ ありません。
                上 の ＋ で 追加 する と、 線形点 / 中間点 / 縦断 / 横断
                {isGrading ? ' / 平行縦断' : ''} の 各 セクション が 出ます。
              </div>
            )}

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
                    className={
                      (isGrading ? 'col-span-10' : 'col-span-8') +
                      ' px-2 py-1 border rounded text-sm'
                    }
                  >
                    <option value="">座標を選択…</option>
                    {(coordinates as CoordinateRow[]).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.pointNumber}
                      </option>
                    ))}
                  </select>
                  {/* 整地 は IP を 持た ない ので 半径 の 入力 は 出さ ない */}
                  {!isGrading && (
                    <input
                      type="number"
                      step={0.5}
                      value={addRadius}
                      onChange={(e) => setAddRadius(parseFloat(e.target.value) || 0)}
                      placeholder="R (IP用)"
                      title="IP になった 場合の 曲線半径 R (0=角折れ)"
                      className="col-span-2 px-2 py-1 border rounded text-sm text-right"
                    />
                  )}
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
              <CollapsibleSection
                title={isGrading ? 'グリッド計算' : '中間点計算'}
                storageKey="oc:section:stations"
                actions={
                  isGrading ? (
                    <span className="flex items-center gap-1">
                      {crossExportButtons()}
                      {reportButton('station', '計算書')}
                    </span>
                  ) : (
                    reportButton('station', '計算書')
                  )
                }
              >
                {isGrading ? (
                  <>
                    <div className="grid grid-cols-12 gap-2 items-end">
                      <label className="col-span-5 flex flex-col gap-0.5 text-xs">
                        <span className="text-slate-500">グリッド間隔 (m)</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={gridSpacingDraft || String(selected.gridLines.spacing)}
                          onChange={(e) => setGridSpacingDraft(e.target.value)}
                          className="px-2 py-1 border rounded text-right text-sm"
                        />
                      </label>
                      <button
                        onClick={handleGridCompute}
                        disabled={segments.length === 0 || !(gridSpacing > 0)}
                        className="col-span-7 flex items-center justify-center gap-1 px-2 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                        title="中間点 と 平行縦断 を まとめて 作り直す"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        グリッドを計算
                      </button>
                    </div>

                    <div className="text-[11px] text-slate-500">
                      {gradingAreaExtent ? (
                        <>
                          工事区域:{' '}
                          <span className="font-mono">
                            SP{(gradingAreaExtent.dMin + spOffset).toFixed(2)} 〜 SP
                            {(gradingAreaExtent.dMax + spOffset).toFixed(2)}
                          </span>
                          {' / 離れ '}
                          <span className="font-mono">
                            {gradingAreaExtent.oMin < 0
                              ? `L${Math.abs(gradingAreaExtent.oMin).toFixed(2)}`
                              : `R${gradingAreaExtent.oMin.toFixed(2)}`}
                            {' 〜 '}
                            {gradingAreaExtent.oMax < 0
                              ? `L${Math.abs(gradingAreaExtent.oMax).toFixed(2)}`
                              : `R${gradingAreaExtent.oMax.toFixed(2)}`}
                          </span>
                          {' → 平行縦断 '}
                          <span className="font-mono">
                            左 {gridPlanFromExtent(gradingAreaExtent, gridSpacing, totalLen).leftCount} 本
                            / 右 {gridPlanFromExtent(gradingAreaExtent, gridSpacing, totalLen).rightCount} 本
                          </span>
                        </>
                      ) : (
                        <span className="text-amber-700">
                          工事区域 が まだ ありません。 この まま 計算 する と 線形 の 全長 を
                          中心 の 前後 1 本 分 だけ 対象 に します。
                        </span>
                      )}
                    </div>

                    <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer w-fit">
                      <input
                        type="checkbox"
                        checked={showGridOnMap}
                        onChange={(e) => setShowGridOnMap(e.target.checked)}
                      />
                      地図 に 格子 を 表示 する
                      <span className="text-slate-400">
                        (現況 が 入った 点 は 塗りつぶし)
                      </span>
                    </label>
                  </>
                ) : (
                  <>
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

                  </>
                )}

                {/* 整地: 測点 の 一覧 は そのまま 格子。 座標 と 距離 は 出さ ない */}
                {isGrading && (
                  <GridTable
                    cfg={selected.gridLines}
                    stations={[...stations].sort((a, b) => a.distance - b.distance)}
                    spOffset={spOffset}
                    onChangeCfg={(next) => updateChannel(selected.id, { gridLines: next })}
                    resolveCurrent={(st) =>
                      st.currentSection?.length ? st.currentSection : measuredPointsOnStation(st)
                    }
                    onSetHeight={setGridHeight}
                    selectedCell={gridCell}
                    onSelectCell={setGridCell}
                    selectedStationId={selectedStationId}
                    onSelectStation={setSelectedStationId}
                    selectedLineIdx={gridLineIdx}
                    onSelectLine={handleSelectGridLine}
                    onPasteCells={applyGridPaste}
                  />
                )}

                {!isGrading && stations.length > 0 && (
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
                      {stationTin && (
                        <span className="text-[10px] text-slate-400 ml-auto">
                          計画 TIN {stationTin.points.length} 点 / {stationTin.triangles.length} 三角形
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
              {/* 幅杭計算 / 幅杭逆計算 / 縦断 は 整地 で は 使わ ない。
                  整地 の 高さ は グリッド表 の 列 が そのまま 平行 縦断 に なる。 */}
              {!isGrading && (
                <>
              <CollapsibleSection
                title="幅杭計算"
                storageKey="oc:section:width-stakes"
                actions={reportButton('widthStake', '計算書')}
              >
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

              {/* 測点 の 幅杭逆計算。
                  幅杭計算 が 「距離 + オフセット → 座標」 な の に 対し、
                  こちら は その 逆 で 「既設 の 座標 → 距離 + オフセット」。
                  用途 が 違う ので メニュー を 分けて ある。 */}
              <CollapsibleSection
                title="測点の幅杭逆計算"
                storageKey="oc:section:width-stake-reverse"
              >
                <ReverseStakePanel
                  rows={reverseRows}
                  picking={widthStakePick}
                  canPick={segments.length > 0}
                  typeOptions={coordTypeOptions}
                  onAddType={
                    projectId
                      ? async (code, label) => {
                          await addPointType(projectId, code, label)
                        }
                      : undefined
                  }
                  alsoAddWidthStake={!isGrading && reverseAlsoWidthStake}
                  showAlsoAdd={!isGrading}
                  onTogglePick={setWidthStakePick}
                  onChangeRows={setReverseRows}
                  onChangeAlsoAdd={setReverseAlsoWidthStake}
                  onApply={handleRegisterReverseStakes}
                />
              </CollapsibleSection>

              {/* 縦断 (幅杭 と 横断 の 間 に 配置)。
                  縦断図 の プロット は 地図の 下に 残す。ここでは 変化点 の
                  追加 / 編集 / 削除 のみ。追加 は テーブル 末尾 の 空行 に
                  直接 入力 (Enter or + ボタン で 確定)。 */}
              <CollapsibleSection title="縦断" storageKey="oc:section:profile">
                {/* 1 路線 に 複数 の 縦断。 主縦断 (中心線) だけ が 測点 の
                    中心設計高 / 杭打ち / エクスポート に 効く。 追加 の 縦断 は
                    道路高 / 側溝高 / 左右 の 築堤高 など を 並べて 管理 する 用。 */}
                <div className="flex items-center gap-1 flex-wrap">
                  <button
                    onClick={() => setActiveProfileId(null)}
                    className={
                      'px-2 py-0.5 text-[11px] border rounded ' +
                      (activeProfileId == null
                        ? 'bg-sky-600 text-white border-sky-600'
                        : 'bg-white hover:bg-slate-50 text-slate-700')
                    }
                    title="中心線 の 縦断。 測点 の 計画高 は これ で 決まる"
                  >
                    中心 (主)
                  </button>
                  {extraProfiles.map((p, i) => (
                    <button
                      key={p.id}
                      onClick={() => setActiveProfileId(p.id)}
                      className={
                        'px-2 py-0.5 text-[11px] border rounded flex items-center gap-1 ' +
                        (activeProfileId === p.id
                          ? 'bg-slate-700 text-white border-slate-700'
                          : 'bg-white hover:bg-slate-50 text-slate-700')
                      }
                    >
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm"
                        style={{
                          backgroundColor:
                            p.color ?? EXTRA_PROFILE_COLORS[i % EXTRA_PROFILE_COLORS.length],
                        }}
                      />
                      {p.name}
                      <span className="text-[10px] opacity-70">{p.points.length}</span>
                    </button>
                  ))}
                  <button
                    onClick={handleAddExtraProfile}
                    disabled={!selected}
                    className="px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 text-slate-600 disabled:opacity-40"
                    title="縦断 を 追加 (道路高 / 側溝高 など)"
                  >
                    ＋ 縦断
                  </button>
                  {activeProfile && (
                    <span className="ml-auto flex items-center gap-1">
                      <button
                        onClick={handleRenameExtraProfile}
                        className="px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 text-slate-600"
                      >
                        名前
                      </button>
                      <button
                        onClick={handleRemoveExtraProfile}
                        className="px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-red-50 text-red-600"
                      >
                        削除
                      </button>
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500">
                  編集中: <span className="font-semibold text-slate-700">{activeProfileName}</span>
                  {activeProfile
                    ? ' — 管理 / 表示 用。 測点 の 計画高 や 杭打ち に は 使われません。'
                    : ' — 測点 の 計画高・中心設計高・杭打ち は この 縦断 で 決まります。'}
                </div>
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
                        const realIdx = activeProfilePoints.indexOf(p)
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
                </>
              )}

              {/* 横断 (現況・計画・出来形)。 中間点 の 表 に 並んで いた
                  現況 / 計画 / 出来形 の ボタン と 計画高 / 現況高 を ここ に 移した。
                  タブ は 右下 の 横断図 パネル の 編集対象 と 同じ state を 見る ので、
                  ここ で 切り替える と 下 の エディタ も 一緒 に 切り替わる。 */}
              {/* 横断 は 整地 で は グリッド計算 に 統合。 表 の 測点 を 押す と
                  右下 の 横断図 に その 断面 が 出る。 */}
              {!isGrading && (
              <CollapsibleSection
                title="横断 (現況・計画・出来形)"
                storageKey="oc:section:cross"
                actions={
                  <span className="flex items-center gap-1">
                  {crossExportButtons()}
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
                  </span>
                }
              >
                <div className="flex items-center gap-1 flex-wrap">
                  {/* 編集対象 (現況 / 計画 / 出来形) の 切替 は 右下 横断図 の
                      上 の バー に 一本化 した。 ここ に は 出さない。 */}
                  {/* 取込 で 拾う 範囲。 右下 横断図 の 「横断幅」 と 同じ 値 */}
                  {(
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
                          ? '行 を 選ぶ と 右下 の 横断図 で 現況 の 編集 に 入り ます。 点 の 取込 (実測記録 / 地図 / DXF / LandXML) は 下 の 断面入力欄 の 上 から。'
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
                            {/* 3 つ の 中心高 を 常時 並べる。 状態 (個別設定 等) は
                                出さない。 どの 断面 が 入って いる か は 高さ を 見れば 分かる。 */}
                            <th
                              className="px-2 py-1 w-24 text-right whitespace-nowrap"
                              title="現況地盤高 を 直接入力"
                            >
                              現況高 (m)
                            </th>
                            <th
                              className="px-2 py-1 w-24 text-right whitespace-nowrap"
                              title="縦断線形から 自動取込 (トレース/入力 が あれば 優先)"
                            >
                              計画高 (m)
                            </th>
                            <th
                              className="px-2 py-1 w-24 text-right whitespace-nowrap"
                              title="出来形断面 の 中心 (離れ 0) の 標高。 断面 から 補間"
                            >
                              出来形高 (m)
                            </th>
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
                                {/* 現況高: 直接 入力。 空 なら 未計測扱い */}
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
                                {/* 計画高: plannedCenterHeight (トレース由来 or 手入力) を 最優先、
                                    無ければ 縦断線形から 内挿 (範囲外は null)。 どちらも 無ければ "-"。 */}
                                {(() => {
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
                                {/* 出来形高: 専用 の フィールド は 無い ので、 出来形断面 の
                                    中心 (離れ 0) を 補間 して 出す。 表示 だけ。 */}
                                {(() => {
                                  const v = interpolateSectionAtCenter(s.asbuiltSection ?? [])
                                  return (
                                    <td
                                      className="px-2 py-1 text-right tabular-nums text-teal-700 whitespace-nowrap"
                                      title={
                                        v != null
                                          ? '出来形断面 の 中心 を 補間'
                                          : '出来形断面 が 無い か 中心 を 挟んで いません'
                                      }
                                    >
                                      {v != null ? v.toFixed(3) : '-'}
                                    </td>
                                  )
                                })()}
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
                  </>
                )}
              </CollapsibleSection>
              )}

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
            {widthStakePick && (
              <div className="absolute top-2 left-1/2 -translate-x-1/2 z-[1200] flex items-center gap-2 px-3 py-1.5 rounded bg-pink-600 text-white text-xs shadow-lg">
                <span>幅杭 の 逆計算: 座標 を 選ぶ と SP と オフセット を 出します</span>
                <button
                  type="button"
                  onClick={() => setWidthStakePick(false)}
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
              {/* グリッド表 で 選んだ セル。 選んだ 側 が 動く ので こちら を 優先 */}
              <StationFocus
                latLng={gridCellPoint ? [gridCellPoint.lat, gridCellPoint.lng] : null}
              />


              {sampledLatLng.length >= 2 && (
                <Polyline positions={sampledLatLng} pathOptions={{ color: '#0ea5e9', weight: 5 }} />
              )}

              {/* 整地: 格子。 平行 縦断 (縦) と 横断 (横) を 細線 で 結び、
                  交点 に 格子点 を 打つ。 中心線 は 上 で 太線 を 引いて いる ので
                  ここ の 中心 の 列 は 少し 濃い 破線 に する。 */}
              {isGrading && showGridOnMap && (
                <>
                  {gridCrossLines.map((line, j) => (
                    <Polyline
                      key={`gridcross-${j}`}
                      positions={line}
                      interactive={false}
                      pathOptions={{ color: '#10b981', weight: 1, opacity: 0.5 }}
                    />
                  ))}
                  {gridMapRows.map((row) => {
                    const line = row.pts.map((p) => [p.lat, p.lng] as [number, number])
                    const lineColor = row.idx === 0 ? '#0284c7' : '#047857'
                    return (
                    <div key={`gridrow-${row.idx}`}>
                      {line.length >= 2 && (
                        <Polyline
                          positions={line}
                          interactive={false}
                          pathOptions={{
                            color: row.idx === 0 ? '#0284c7' : '#10b981',
                            weight: 1,
                            opacity: row.idx === 0 ? 0.8 : 0.5,
                            dashArray: '4,4',
                          }}
                        />
                      )}
                      {row.pts.map((p, j) => (
                        <CircleMarker
                          key={`gridpt-${row.idx}-${p.stationId}`}
                          center={[p.lat, p.lng]}
                          radius={3}
                          // 断面点 を 拾って いる 間 は 座標 の マーカー を 邪魔 しない
                          interactive={mapCaptureTarget == null}
                          pathOptions={{
                            color: '#fff',
                            weight: 1,
                            fillColor: p.current != null ? '#10b981' : '#94a3b8',
                            fillOpacity: p.current != null ? 0.95 : 0.45,
                          }}
                        >
                          {/* 列 の 名前 は 線 の 両端 に 常時 出す (背景 の 箱 は 出さ ない) */}
                          {(j === 0 || j === row.pts.length - 1) && (
                            <Tooltip
                              permanent
                              direction={j === 0 ? 'top' : 'bottom'}
                              offset={j === 0 ? [0, -4] : [0, 4]}
                              className="map-plain-label"
                            >
                              <span
                                style={{
                                  color: lineColor,
                                  fontWeight: 700,
                                  fontSize: '13px',
                                  textShadow:
                                    '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                                }}
                              >
                                {row.name}
                              </span>
                            </Tooltip>
                          )}
                        </CircleMarker>
                      ))}
                    </div>
                    )
                  })}
                </>
              )}

              {/* グリッド表 で 選んだ 格子点。 格子 を 消して いて も 出す */}
              {isGrading && gridCellPoint && (
                <CircleMarker
                  center={[gridCellPoint.lat, gridCellPoint.lng]}
                  radius={8}
                  interactive={false}
                  pathOptions={{
                    color: '#f97316',
                    weight: 3,
                    fillColor: '#fb923c',
                    fillOpacity: 0.5,
                  }}
                >
                  <Tooltip permanent direction="right" offset={[8, 0]} className="map-plain-label">
                    <span
                      style={{
                        color: '#c2410c',
                        fontWeight: 700,
                        fontSize: '13px',
                        textShadow:
                          '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                      }}
                    >
                      {gridPointName(gridCellPoint.name, gridCellPoint.distance + spOffset)}
                      {gridCellPoint.current != null
                        ? ` 現況 ${gridCellPoint.current.toFixed(3)}`
                        : ''}
                      {gridCellPoint.planned != null
                        ? ` 計画 ${gridCellPoint.planned.toFixed(3)}`
                        : ''}
                    </span>
                  </Tooltip>
                </CircleMarker>
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
          <div className="px-3 py-2 flex items-center gap-2.5 shrink-0 border-b bg-slate-50">
            <button
              type="button"
              onClick={toggleProfileChart}
              className="p-0.5 hover:bg-slate-100 rounded"
              title={profileChartExpanded ? '折りたたむ' : '展開'}
            >
              {profileChartExpanded ? (
                <ChevronDown className="h-5 w-5 text-slate-500" />
              ) : (
                <ChevronRight className="h-5 w-5 text-slate-500" />
              )}
            </button>
            <div className="flex gap-0.5">
              <button
                type="button"
                onClick={() => {
                  setBottomTab('profile')
                  if (!profileChartExpanded) toggleProfileChart()
                }}
                className={`px-3 py-1 text-sm rounded ${
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
                className={`px-3 py-1 text-sm rounded ${
                  bottomTab === 'crossSection'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border hover:bg-slate-100 text-slate-700'
                }`}
              >
                横断図
              </button>
            </div>
            {/* 断面図 の 上 に あった 表題行 は ここ に たたんだ。
                測点 の 切替 と 編集対象 だけ 残し、図 の 高さ を 1 行 分 稼ぐ。 */}
            {bottomTab === 'profile' ? (
              gridProfile ? (
                <span className="text-sm text-slate-600 truncate">
                  <span className="font-mono text-lg font-bold text-sky-800">
                    {gridProfile.name}
                  </span>
                  <span className="ml-2 text-slate-500">
                    {gridProfile.offset === 0
                      ? '中心線'
                      : `離れ ${gridProfile.offset < 0 ? 'L' : 'R'}${Math.abs(gridProfile.offset).toFixed(1)}m`}
                    {' — 高さ の 編集 は グリッド計算 の 表 から'}
                  </span>
                </span>
              ) : (
                <span className="text-sm text-slate-500 truncate">
                  変化点 の 追加 / 編集 は 左サイドバー 「縦断」から
                </span>
              )
            ) : selectedStation ? (
              <>
                <span className="font-mono text-xl font-bold text-slate-800 tracking-tight">
                  {selectedStation.label}
                </span>
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
                        className="px-2.5 py-1 text-sm border rounded bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={prev ? `前 の 断面 (${prev.label})` : '前 の 断面 は ありません'}
                      >
                        ◀ 前断面
                      </button>
                      <button
                        onClick={() => next && setSelectedStationId(next.id)}
                        disabled={!next}
                        className="px-2.5 py-1 text-sm border rounded bg-white hover:bg-slate-100 text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
                        title={next ? `次 の 断面 (${next.label})` : '次 の 断面 は ありません'}
                      >
                        次断面 ▶
                      </button>
                    </span>
                  )
                })()}
                {/* 編集対象 の 切替。 左メニュー 「横断」 の タブ と 同じ state */}
                <div className="flex items-center gap-0.5 border-l pl-2">
                  <span className="text-xs text-slate-500 mr-0.5">編集</span>
                  {EDIT_TARGET_TABS.map((b) => (
                    <button
                      key={b.key}
                      onClick={() => {
                        setEditTarget(b.key)
                        // 対象を 切り替えたら 地図ピック モードは 解除
                        setMapCaptureTarget(null)
                      }}
                      className={`px-3 py-1 text-sm border rounded ${
                        editTarget === b.key ? b.act : b.idle
                      }`}
                    >
                      {b.label}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <span className="text-sm text-slate-500 truncate">
                横断計画 (標準断面) — 中間点 で 計画 を 押すと 個別 に 編集 できます
              </span>
            )}
            {/* 断面図 の パン / ズーム を 戻す。 図 の 中 に 置く と 線 に 被る */}
            {bottomTab === 'crossSection' && (
              <button
                onClick={() => crossViewRef.current?.resetView()}
                className="ml-auto px-2.5 py-1 text-sm border rounded bg-white text-slate-600 hover:bg-slate-100"
                title="断面図 の 表示 (パン / ズーム) を リセット"
              >
                表示リセット
              </button>
            )}
          </div>
          {/* 展開中 は 図 の 左 に 断面点 の 表 を 固定 する。 測点 を 選べば
              その 断面 の 中身 が そのまま 出る ので、別 の 呼び出し は 要らない。
              縦断図 / 横断図 の どちら の タブ でも 出し続ける。 */}
          {profileChartExpanded && (
          <div className="flex-1 min-h-0 flex">
            <aside className="w-[624px] shrink-0 border-r p-2 overflow-hidden flex flex-col gap-1.5">
              {/* 取込 の 入口 は 1 行 の ボタン列 に まとめる。
                  - 測点から追加: 実測記録 を 一括 (条件 で 絞る) / 測点指定 (地図 で 1 点 ずつ)
                  - DXFから取込 : 既存 の 横断 DXF を トレース
                  - LandXML取込 : TIN を サンプリング (押して から 条件 を 入れて 確定)
                  条件 の 入力 欄 は 押す まで 出さ ない。 常時 出す と 幅 を 食う。 */}
              {stations.length > 0 && (() => {
                const t = sectionTargetOfEditTarget(editTarget)
                const isMapMode = editTarget === 'current' || editTarget === 'asbuilt'
                /** 地図 で 1 点 ずつ 拾う モード に 入る */
                const startMapCapture = () => {
                  if (!selectedStation) return
                  // 現況 で まだ 何も 保存 して いない ときは、いま 断面図 に 出て いる
                  // 実測点 を そのまま 土台 に する。 これ を しない と 1 点 拾った
                  // 途端 に 実測点 が 消えて 「反映 されない」 ように 見える。
                  if (
                    t === 'current' &&
                    !selectedStation.currentSection?.length &&
                    autoCurrentSection.length > 0
                  ) {
                    handleReplaceStationSection(selectedStation.id, 'current', autoCurrentSection)
                  }
                  setMapCaptureTarget(t)
                }
                return (
                  <div className="shrink-0 space-y-1">
                    <div className="flex items-center gap-1 flex-wrap">
                      {selectedStation && isMapMode && (
                        <div className="relative">
                          <button
                            onClick={() => setRecordAddMenuOpen((v) => !v)}
                            className={`px-2 py-0.5 text-[11px] border rounded ${
                              recordAddMenuOpen || sectionImportPanel === 'records'
                                ? 'bg-cyan-600 text-white border-cyan-600'
                                : 'bg-cyan-50 text-cyan-800 border-cyan-300 hover:bg-cyan-100'
                            }`}
                            title="実測記録 から 断面 の 点 を 拾う"
                          >
                            測点から追加
                            <ChevronDown className="inline h-3 w-3 ml-0.5 -mt-0.5" />
                          </button>
                          {recordAddMenuOpen && (
                            <div className="absolute top-full mt-1 left-0 z-[1400] bg-white border rounded shadow-lg py-1 min-w-[14rem]">
                              <button
                                onClick={() => {
                                  setRecordAddMenuOpen(false)
                                  setMapCaptureTarget(null)
                                  setSectionImportPanel('records')
                                }}
                                className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-50"
                              >
                                <div className="font-semibold text-slate-700">一括</div>
                                <div className="text-slate-500">厚さ と 左右 の 幅 で 絞って まとめて 取込</div>
                              </button>
                              <button
                                onClick={() => {
                                  setRecordAddMenuOpen(false)
                                  setSectionImportPanel(null)
                                  startMapCapture()
                                }}
                                className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-slate-50"
                              >
                                <div className="font-semibold text-slate-700">測点指定</div>
                                <div className="text-slate-500">地図 で 測点 を 1 点 ずつ 選ぶ</div>
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                      {/* DXF が 未登録 でも 出す。 トレース モーダル 側 で
                          登録 できる ので、ここ が 入口 に なる。 */}
                      {selectedStation && (
                        <button
                          onClick={() =>
                            setDxfTraceContext({ stationId: selectedStation.id, target: t })
                          }
                          className="px-2 py-0.5 text-[11px] border rounded bg-white text-slate-700 border-slate-300 hover:bg-slate-50"
                          title="既存 DXF 横断図 から トレースして 点を 拾う (DXF の 登録 も ここ から)"
                        >
                          DXFから取込
                        </button>
                      )}
                      {/* 計画 だけ。 路線 の 標準断面 を この 測点 の 計画断面 に 落とす。
                          以前 は 横断図 の 表題行 に あった 「個別設定 (標準を取込)」。
                          取込 の 入口 を 1 行 に まとめた ので ここ に 置く。 */}
                      {selectedStation && t === 'planned' && (
                        <button
                          onClick={() =>
                            setStandardSectionPicker({ stationId: selectedStation.id })
                          }
                          className="px-2 py-0.5 text-[11px] border rounded bg-white text-blue-700 border-blue-300 hover:bg-blue-50"
                          title="標準断面 を 選んで この 測点 の 計画断面 に する (新規作成 / ファイル読込 も ここ から)"
                        >
                          標準断面取込
                        </button>
                      )}
                      <button
                        onClick={() =>
                          setSectionImportPanel((p) => (p === 'landxml' ? null : 'landxml'))
                        }
                        className={`px-2 py-0.5 text-[11px] border rounded ${
                          sectionImportPanel === 'landxml'
                            ? 'bg-emerald-600 text-white border-emerald-600'
                            : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
                        }`}
                        title="LandXML の TIN から 全測点 の 断面 を 作成 (幅 と 刻み を 入れて 確定)"
                      >
                        LandXML取込
                      </button>
                      {/* トンボ (丁張 の 目印)。 計画 の とき だけ */}
                      {selectedStation && t === 'planned' && (
                        <button
                          onClick={() => setTomboStationId(selectedStation.id)}
                          className="px-2 py-0.5 text-[11px] border rounded bg-white text-violet-700 border-violet-300 hover:bg-violet-50"
                          title="計画横断 の 変化点 から 横 と 高さ を ずらして トンボ を 計算 する"
                        >
                          トンボ・丁張計算
                        </button>
                      )}
                      {mapCaptureTarget === t && (
                        <span className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-purple-600 text-white">
                          地図取得: 選択中
                          <button
                            onClick={() => setMapCaptureTarget(null)}
                            className="underline decoration-dotted"
                          >
                            やめる
                          </button>
                        </span>
                      )}
                      {/* 表 の 全消去 も 取込 と 同じ 行 に。 右端 に 寄せる */}
                      {selectedStation && (() => {
                        const cur =
                          (selectedStation[sectionKeyOf(t)] as MeasuredCrossPoint[] | null) ?? []
                        return (
                          <button
                            onClick={() => {
                              if (cur.length === 0) return
                              if (
                                !window.confirm(
                                  `${cur.length} 点 すべて を 消します。よろしいですか？`,
                                )
                              )
                                return
                              handleReplaceStationSection(selectedStation.id, t, [])
                            }}
                            disabled={cur.length === 0}
                            className="ml-auto px-2 py-0.5 text-[11px] border rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                          >
                            全消去
                          </button>
                        )
                      })()}
                    </div>

                    {/* 一括 の 条件。 厚さ = 中心線 沿い の 帯、 幅 = 中心 から 左右 の 上限 */}
                    {selectedStation && sectionImportPanel === 'records' && (
                      <div className="border rounded bg-slate-50 p-2 space-y-1 text-[11px]">
                        <div className="flex items-center gap-2 flex-wrap">
                          <label className="flex items-center gap-1 text-slate-600">
                            <span>厚さ(m)</span>
                            <input
                              type="number"
                              step={0.1}
                              min={0.05}
                              value={bulkBandText}
                              onChange={(e) => setBulkBandText(e.target.value)}
                              className="w-16 px-1 py-0.5 border rounded font-mono text-right"
                              title="中心線 に 沿った 前後 の 帯。 この 中 に 入る 実測記録 を その 断面 の 点 と して 拾う"
                            />
                          </label>
                          <label className="flex items-center gap-1 text-slate-600">
                            <span>左右の幅(m)</span>
                            <input
                              type="number"
                              step={0.5}
                              min={0}
                              value={bulkHalfWidthText}
                              onChange={(e) => setBulkHalfWidthText(e.target.value)}
                              placeholder="制限なし"
                              className="w-20 px-1 py-0.5 border rounded font-mono text-right"
                              title="中心 から 左右 それぞれ の 上限。 空 に すると 制限 しない"
                            />
                          </label>
                          <span className={bulkCondOk ? 'text-slate-500' : 'text-red-600'}>
                            {bulkCondOk ? `該当 ${bulkCandidates.length} 点` : '数値 を 入れて ください'}
                          </span>
                          <button
                            onClick={handleBulkAddFromRecords}
                            disabled={!bulkCondOk || bulkCandidates.length === 0}
                            className="ml-auto px-2 py-0.5 border rounded bg-cyan-600 text-white border-cyan-600 hover:bg-cyan-700 disabled:opacity-40"
                          >
                            取込
                          </button>
                          <button
                            onClick={() => setSectionImportPanel(null)}
                            className="px-2 py-0.5 border rounded bg-white hover:bg-slate-100 text-slate-600"
                          >
                            閉じる
                          </button>
                        </div>
                        <div className="text-slate-500">
                          既に 入って いる 記録 は 足しません。 取込 後 は 中心 に 近い 順 に
                          並べ 直します。
                        </div>
                      </div>
                    )}

                    {/* LandXML は 押して から 幅 (半分) と 刻み を 入れて 確定 */}
                    {sectionImportPanel === 'landxml' && (
                      <LandxmlSectionImport
                        farmId={farmId ?? null}
                        channelName={selected?.name ?? null}
                        target={t}
                        stations={stations}
                        segments={segments}
                        sideOrientation={selected?.sideOrientation ?? 'forward'}
                        onImported={(rows) => {
                          handleReplaceStationSectionsBulk(t, rows)
                          setSectionImportPanel(null)
                        }}
                      />
                    )}
                  </div>
                )
              })()}
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
                      points={pts}
                      // 一番 内側 の 点 を 計算 する とき の 基準 (中心設計高)
                      centerHeight={
                        selectedStation.plannedCenterHeight ??
                        interpolateProfileZOrNull(
                          selected.profilePoints,
                          selectedStation.distance,
                        ) ??
                        (isGrading ? stationDrawDatum(selectedStation) : undefined)
                      }
                      // 「縦断から計算」 用。 こちら は 縦断線形 だけ を 見る
                      profileCenterHeight={
                        interpolateProfileZOrNull(
                          selected.profilePoints,
                          selectedStation.distance,
                        ) ?? undefined
                      }
                      // 「勾配 ～ 現況まで」 用。 未保存 の 間 は 図 と 同じ 実測点 を 使う
                      groundPoints={
                        selectedStation.currentSection?.length
                          ? selectedStation.currentSection
                          : autoCurrentSection
                      }
                      onCalcPreviewChange={setCalcPreview}
                      onChange={(next) =>
                        handleReplaceStationSection(selectedStation.id, t, next)
                      }
                      selectedPointId={selectedPointId}
                      onSelectPoint={setSelectedPointId}
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
                points={gridProfile ? gridProfile.planned : selected.profilePoints}
                extraProfiles={gridProfile ? undefined : selected.extraProfiles}
                totalLen={totalLen}
                spOffset={spOffset}
                currentGroundPoints={
                  gridProfile
                    ? gridProfile.current
                    : stations
                        .filter((s) => s.currentGroundHeight != null)
                        .map((s) => ({ distance: s.distance, z: s.currentGroundHeight as number }))
                }
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
                      (isGrading ? stationDrawDatum(selectedStation) : undefined))
                  : undefined
                // 編集対象 = 選択測点 の 個別断面 (element or 点列 の いずれか) / なければ 標準断面。
                //   crossSection と plannedSectionRaw は handleUpdateStationCrossSection /
                //   handleReplaceStationSection('planned') で 常に 同期される 想定 だが、
                //   旧データ (片方 のみ) との 互換 の ため plannedSectionRaw を 逆変換 で フォールバック。
                /**
                 * 図 に 出す 断面 (要素列)。
                 *
                 * 「現況まで」 (toGround) を 含む 断面 は 要素 だけ で は 形 が
                 * 決まら ない。 その 区間 は 幅 0 で 保存 されて いる ので、
                 * そのまま 描く と 長さ ゼロ に なって 見え なく なる。
                 * 取込 の とき に 現況 と の 交点 で 解決 した 点列
                 * (plannedSectionRaw) が ある ので、 そちら から 組み直す。
                 */
                const csHasToGround = (cs0: StandardCrossSection) =>
                  cs0.left.some((e) => e.toGround) || cs0.right.some((e) => e.toGround)
                const stationCs: StandardCrossSection | null = selectedStation
                  ? selectedStation.crossSection
                    ? csHasToGround(selectedStation.crossSection) &&
                      (selectedStation.plannedSectionRaw?.length ?? 0) > 0
                      ? measuredPointsToStandardCs(
                          selectedStation.plannedSectionRaw as MeasuredCrossPoint[],
                          centerZ ?? 0,
                        )
                      : selectedStation.crossSection
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
                    {/* 断面図。 測点 の 切替 と 編集対象 は 上 の タブ バー、
                        表示要素 と 表示リセット は 図 の 中 に 重ねた。
                        入力 は 左 の 断面入力欄 (表) で。 */}
                    <div className="flex-1 min-h-0 relative">
                      <CrossSectionView
                        ref={crossViewRef}
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
                        show={crossLayers}
                        editPoints={(() => {
                          if (!selectedStation) return null
                          const t = sectionTargetOfEditTarget(editTarget)
                          const saved =
                            (selectedStation[sectionKeyOf(t)] as MeasuredCrossPoint[] | null) ??
                            null
                          // 現況 は 未保存 の 間 図 に 実測点 が 出て いる ので、
                          // マーク も その 点列 に 合わせる (線 と 食い違わ せない)
                          if (t === 'current' && !saved?.length && autoCurrentSection.length > 0) {
                            return autoCurrentSection
                          }
                          return saved
                        })()}
                        editOnPath={editTarget === 'plan'}
                        calcPreview={calcPreview}
                        chohari={
                          selectedStation
                            ? (selectedStation.chohari ?? []).flatMap((c) => {
                                const r = resolveChohariFor(selectedStation, c)
                                return r && !r.error
                                  ? [
                                      {
                                        id: c.id,
                                        offset: r.offset,
                                        elevation: r.elevation,
                                        label: c.name?.trim() || '丁張',
                                        slopeLength: r.slopeLength,
                                        crestOffset: r.crest?.offset ?? r.offset,
                                        crestElevation: r.crest?.elevation ?? r.elevation,
                                        baseOffset: r.base?.offset ?? r.offset,
                                        baseElevation: r.base?.elevation ?? r.elevation,
                                        // 図 に 出て いる 現況線 と 同じ もの を 使う
                                        groundElevation: groundElevationAt(
                                          selectedStation.currentSection?.length
                                            ? selectedStation.currentSection
                                            : autoCurrentSection,
                                          r.offset,
                                        ),
                                        // 法面線 が 現況 と ぶつかる 点。
                                        //
                                        // 盛土 なら 法面線 は 現況 より 上 に あり、 法肩 と は
                                        // 逆 (下り) の 側 で 地盤 と 交わる。 切土 なら その 逆。
                                        // どちら か は 断面 次第 な ので 両 向き を 探し、
                                        // 杭 に 近い 方 を 採る。 線上 の 交点 な ので
                                        // どちら から 探しても 同じ 点 に 行き着く。
                                        groundHit: (() => {
                                          const g = selectedStation.currentSection?.length
                                            ? selectedStation.currentSection
                                            : autoCurrentSection
                                          const co = r.crest?.offset ?? r.offset
                                          const ce = r.crest?.elevation ?? r.elevation
                                          const dxAbs = Math.abs(co - r.offset)
                                          if (dxAbs < 1e-9 || g.length < 2) return null
                                          // 法肩 へ 向かう 向き と、 その 1m あたり の 上がり
                                          const toCrest: 1 | -1 = co >= r.offset ? 1 : -1
                                          const f = (ce - r.elevation) / dxAbs
                                          const from = { offset: r.offset, elevation: r.elevation }
                                          const opts = { extendEnds: true }
                                          const up = intersectGround(from, toCrest, f, g, opts)
                                          const down = intersectGround(
                                            from,
                                            (toCrest * -1) as 1 | -1,
                                            -f,
                                            g,
                                            opts,
                                          )
                                          const pick =
                                            up && down
                                              ? up.t <= down.t
                                                ? { t: up.t, dir: toCrest, fr: f }
                                                : { t: down.t, dir: (toCrest * -1) as 1 | -1, fr: -f }
                                              : up
                                                ? { t: up.t, dir: toCrest, fr: f }
                                                : down
                                                  ? { t: down.t, dir: (toCrest * -1) as 1 | -1, fr: -f }
                                                  : null
                                          return pick
                                            ? {
                                                offset: r.offset + pick.dir * pick.t,
                                                elevation: r.elevation + pick.fr * pick.t,
                                              }
                                            : null
                                        })(),
                                      },
                                    ]
                                  : []
                              })
                            : []
                        }
                        tombos={
                          selectedStation
                            ? (selectedStation.tombos ?? []).flatMap((t) => {
                                const r = resolveTomboFor(selectedStation, t)
                                return r
                                  ? [
                                      {
                                        id: t.id,
                                        offset: r.offset,
                                        elevation: r.elevation,
                                        label: t.name?.trim() || 'トンボ',
                                        dw: t.dw,
                                        dh: t.dh,
                                        // 図 に 出て いる 現況線 と 同じ もの を 使う
                                        groundElevation: groundElevationAt(
                                          selectedStation.currentSection?.length
                                            ? selectedStation.currentSection
                                            : autoCurrentSection,
                                          r.offset,
                                        ),
                                      },
                                    ]
                                  : []
                              })
                            : []
                        }
                        selectedPointId={selectedPointId}
                        onSelectPoint={handleSelectSectionPoint}
                        onSelectSegment={handleSelectSectionSegment}
                        segmentPick={pickTarget?.kind === 'choSegment'}
                        offsetPick={pickTarget?.kind === 'choPos'}
                        onPickOffset={handlePickChohariOffset}
                        pointPickIds={
                          pickTarget?.kind === 'choBase' && selectedStation
                            ? (() => {
                                const c = (selectedStation.chohari ?? []).find(
                                  (x) => x.id === pickTarget.rowId,
                                )
                                return c ? [c.basePointId, c.crestPointId] : null
                              })()
                            : null
                        }
                      />
                      {/* 凡例 兼 表示切替。 図 の 右下 に 常駐 させる。
                          線 の 色 と 破線 は 本体 の 描画 と 同じ 値 を 使う。 */}
                      <div className="absolute bottom-2 right-2 z-[1400] bg-white/90 border rounded shadow-sm py-1 px-1">
                        {(
                          [
                            ['planned', '計画線', '#0ea5e9', ''],
                            ['current', '現況線', '#a16207', '4,3'],
                            ['asbuilt', '出来形線', '#059669', ''],
                            ['dimText', '寸法 の 文字', '', ''],
                            ['pointText', '点名 の 文字', '', ''],
                          ] as const
                        ).map(([k, label, color, dash]) => (
                          <label
                            key={k}
                            className="flex items-center gap-1.5 px-1.5 py-0.5 text-[11px] hover:bg-slate-50 cursor-pointer whitespace-nowrap"
                          >
                            <input
                              type="checkbox"
                              checked={crossLayers[k]}
                              onChange={() => toggleCrossLayer(k)}
                              className="h-3 w-3"
                            />
                            {color ? (
                              <svg width="20" height="8" className="shrink-0">
                                <line
                                  x1={0}
                                  y1={4}
                                  x2={20}
                                  y2={4}
                                  stroke={color}
                                  strokeWidth={2}
                                  strokeDasharray={dash || undefined}
                                />
                              </svg>
                            ) : (
                              <span className="w-5 text-center text-slate-400 shrink-0">字</span>
                            )}
                            <span className="text-slate-700">{label}</span>
                          </label>
                        ))}
                      </div>
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

      {/* トンボ の 計算。 計画横断 の 変化点 から の ずらし で 1 点 を 決める */}
      {tomboStationId &&
        (() => {
          const st = stations.find((x) => x.id === tomboStationId)
          if (!st) return null
          return (
            <StakeoutModal
              stationLabel={st.label}
              planPoints={st.plannedSectionRaw ?? []}
              tombos={st.tombos ?? []}
              chohari={st.chohari ?? []}
              resolveTombo={(t) => resolveTomboFor(st, t)}
              resolveChohari={(c) => resolveChohariFor(st, c)}
              onChangeTombos={(next) =>
                setStations(
                  stations.map((x) => (x.id === st.id ? { ...x, tombos: next } : x)),
                )
              }
              onChangeChohari={(next) =>
                setStations(
                  stations.map((x) => (x.id === st.id ? { ...x, chohari: next } : x)),
                )
              }
              onRegisterTombos={(items) => handleRegisterTombos(st.id, items)}
              onRegisterChohari={(items) => handleRegisterChohari(st.id, items)}
              picking={pickTarget}
              onPick={setPickTarget}
              onClose={() => {
                setPickTarget(null)
                setTomboStationId(null)
              }}
            />
          )
        })()}

      {/* 標準断面 の 選択 / 作成。 取込 は 開いて いる 測点 の 計画断面 に 入れる */}
      {standardSectionPicker && selected && (
        <StandardSectionPickerModal
          sections={selected.standardSections}
          legacyCross={selected.standardCrossSection}
          onChangeSections={(next) =>
            updateChannel(selected.id, { standardSections: next })
          }
          onImport={(cross) => {
            const st = stations.find((x) => x.id === standardSectionPicker.stationId)
            if (!st) return
            // 追加 で は なく 置き換え な ので、 既に 点 が ある ときは 確認 する
            const nowCount = st.plannedSectionRaw?.length ?? 0
            if (
              nowCount > 0 &&
              !window.confirm(
                `${st.label} の 計画断面 (${nowCount} 点) を 標準断面 で 置き換えます。よろしいですか？`,
              )
            )
              return
            const res = handleUpdateStationCrossSection(st.id, cloneCrossSection(cross))
            if (res.truncated) {
              // 何 が 起きた の か を そのまま 出す。 現況 の 点数 も 添えて、
              // 「現況 が 空」 なのか 「交わら ない」 のか を 区別 できる ように する。
              window.alert(
                [
                  `${st.label}: 「現況まで」 の 区間 を 解け なかった ので その 手前 で 打ち切りました。`,
                  ...res.reasons,
                  `(この 測点 の 現況断面: ${res.groundCount} 点)`,
                ].join('\n\n'),
              )
            }
            setStandardSectionPicker(null)
          }}
          onClose={() => setStandardSectionPicker(null)}
        />
      )}

      {/* 横断図 の DXF 出力 */}
      {dxfModalOpen && selected && (
        <CrossSectionDxfModal
          channelName={selected.name}
          sections={dxfSections}
          initialSelected={
            selectedStationId ? [selectedStationId] : dxfSections.map((x) => x.id)
          }
          onClose={() => setDxfModalOpen(false)}
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
