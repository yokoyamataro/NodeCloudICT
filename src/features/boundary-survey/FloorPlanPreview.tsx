// 建物図面・各階平面図 の 下絵。
//
// 画面 の 中 だけ の 確認用。 最終成果 (p21 / tif / pdf) は 別 の 出力 に する。
// 座標 は x=東 / y=北 の メートル な ので、SVG に 出す ときに y を 反転 する。

import { useMemo } from 'react'
import {
  figureOutline,
  moveLength,
  placeOutline,
  type FloorFigure,
  type Move,
  type Pt,
} from './floorPlanTypes'

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function bumpBox(b: Box | null, x: number, y: number): Box {
  if (!b) return { minX: x, minY: y, maxX: x, maxY: y }
  return {
    minX: Math.min(b.minX, x),
    minY: Math.min(b.minY, y),
    maxX: Math.max(b.maxX, x),
    maxY: Math.max(b.maxY, y),
  }
}

/** 余白 を 付けた viewBox。 y 反転 済み の 座標系 に 合わせる */
function viewBoxOf(box: Box | null, pad: number): string {
  if (!box) return '-5 -5 10 10'
  const w = Math.max(box.maxX - box.minX, 0.001)
  const h = Math.max(box.maxY - box.minY, 0.001)
  const m = Math.max(w, h) * pad
  return `${box.minX - m} ${-(box.maxY + m)} ${w + m * 2} ${h + m * 2}`
}

/** 線 の 太さ を 図 の 大きさ に 合わせる (viewBox が m 単位 な ので) */
function strokeOf(box: Box | null): number {
  if (!box) return 0.05
  return Math.max(box.maxX - box.minX, box.maxY - box.minY, 0.001) / 260
}

const ptsAttr = (pts: Pt[], dx = 0, dy = 0) =>
  pts.map((p) => `${p.x + dx},${-(p.y + dy)}`).join(' ')

/** 辺 の 寸法。 実物 と 同じ く 辺 に 沿わせて 置く */
function EdgeLabels({ pts, moves, fs }: { pts: Pt[]; moves: Move[]; fs: number }) {
  if (pts.length < 2) return null
  return (
    <>
      {pts.map((a, i) => {
        const b = pts[(i + 1) % pts.length]
        // 辺 は 入力 した 相対距離 を そのまま 出す (丸め で 数字 が 動かない ように)
        const len = moves[i] ? moveLength(moves[i]) : Math.hypot(b.x - a.x, b.y - a.y)
        if (len < 0.001) return null
        const mx = (a.x + b.x) / 2
        const my = (a.y + b.y) / 2
        let deg = (Math.atan2(-(b.y - a.y), b.x - a.x) * 180) / Math.PI
        // 逆さま に ならない ように 反転
        if (deg > 90 || deg < -90) deg += 180
        return (
          <text
            key={i}
            x={mx}
            y={-my}
            fontSize={fs}
            textAnchor="middle"
            fill="#475569"
            transform={`rotate(${deg} ${mx} ${-my})`}
            dy={-fs * 0.35}
          >
            {len.toFixed(3)}
          </text>
        )
      })}
    </>
  )
}

/**
 * 1 つ の 図形。 2 階 以降 は 1 階 (underlay) を 点線 で 下敷き に する。
 * 実物 の 「主である建物2階」 が その 描き方。
 */
export function FigureOutlinePreview({
  figure,
  underlay,
  showEdgeLabels = true,
  className,
}: {
  figure: FloorFigure
  underlay?: FloorFigure | null
  showEdgeLabels?: boolean
  className?: string
}) {
  const pts = useMemo(() => figureOutline(figure), [figure])
  const under = useMemo(() => (underlay ? figureOutline(underlay) : []), [underlay])

  const box = useMemo(() => {
    let b: Box | null = null
    for (const p of pts) b = bumpBox(b, p.x + figure.offset.x, p.y + figure.offset.y)
    for (const p of under) b = bumpBox(b, p.x, p.y)
    return b
  }, [pts, under, figure.offset])

  const sw = strokeOf(box)
  const fs = sw * 9

  if (!box) {
    return (
      <div className={`flex items-center justify-center text-xs text-slate-400 ${className ?? ''}`}>
        形状を入力すると図が表示されます
      </div>
    )
  }

  return (
    <svg className={className} viewBox={viewBoxOf(box, 0.16)} preserveAspectRatio="xMidYMid meet">
      {under.length >= 3 && (
        <polygon
          points={ptsAttr(under)}
          fill="none"
          stroke="#94a3b8"
          strokeWidth={sw * 0.8}
          strokeDasharray={`${sw * 4} ${sw * 3}`}
        />
      )}
      {pts.length >= 3 && (
        <polygon
          points={ptsAttr(pts, figure.offset.x, figure.offset.y)}
          fill="rgba(100,116,139,0.06)"
          stroke="#0f172a"
          strokeWidth={sw}
        />
      )}
      {showEdgeLabels && (
        <g transform={`translate(${figure.offset.x} ${-figure.offset.y})`}>
          <EdgeLabels pts={pts} moves={figure.moves} fs={fs} />
        </g>
      )}
      {/* 下敷き から の ずれ */}
      {under.length > 0 && (figure.offset.x !== 0 || figure.offset.y !== 0) && (
        <g stroke="#2563eb" strokeWidth={sw * 0.7} fill="#2563eb">
          <line x1={0} y1={0} x2={figure.offset.x} y2={0} />
          <line x1={figure.offset.x} y1={0} x2={figure.offset.x} y2={-figure.offset.y} />
        </g>
      )}
    </svg>
  )
}

/** 平面直角座標 の 点 (X=北 / Y=東) */
export interface SitePoint {
  id: string
  pointNumber: string
  x: number
  y: number
}

/**
 * 用紙 右半分 の 建物図面。 敷地 の 外形 に 建物 を 載せ、隣地 の 地番 を 添える。
 */
export function SitePlanPreview({
  sitePoints,
  outline,
  offsetE,
  offsetN,
  rotationDeg,
  notes,
  northAngleDeg,
  className,
}: {
  sitePoints: SitePoint[]
  outline: Pt[]
  offsetE: number
  offsetN: number
  rotationDeg: number
  notes: { id: string; label: string; x: number; y: number }[]
  northAngleDeg: number
  className?: string
}) {
  // 敷地: X=北 な ので 画面 の 東 は y、北 は x
  const site = useMemo(
    () => sitePoints.map((p) => ({ e: p.y, n: p.x, label: p.pointNumber })),
    [sitePoints],
  )
  const building = useMemo(
    () => placeOutline(outline, offsetE, offsetN, rotationDeg),
    [outline, offsetE, offsetN, rotationDeg],
  )

  const box = useMemo(() => {
    let b: Box | null = null
    for (const p of site) b = bumpBox(b, p.e, p.n)
    for (const p of building) b = bumpBox(b, p.e, p.n)
    for (const p of notes) b = bumpBox(b, p.x, p.y)
    return b
  }, [site, building, notes])

  const sw = strokeOf(box)
  const fs = sw * 10

  if (!box) {
    return (
      <div className={`flex items-center justify-center text-xs text-slate-400 ${className ?? ''}`}>
        地番と建物の形状を入れると配置が表示されます
      </div>
    )
  }

  return (
    <svg className={className} viewBox={viewBoxOf(box, 0.14)} preserveAspectRatio="xMidYMid meet">
      {site.length >= 3 && (
        <polygon
          points={site.map((p) => `${p.e},${-p.n}`).join(' ')}
          fill="rgba(16,185,129,0.05)"
          stroke="#047857"
          strokeWidth={sw}
        />
      )}
      {building.length >= 3 && (
        <polygon
          points={building.map((p) => `${p.e},${-p.n}`).join(' ')}
          fill="rgba(15,23,42,0.08)"
          stroke="#0f172a"
          strokeWidth={sw * 1.5}
        />
      )}
      {notes.map((n) => (
        <text key={n.id} x={n.x} y={-n.y} fontSize={fs} textAnchor="middle" fill="#334155">
          {n.label}
        </text>
      ))}
      {/* 方位 */}
      <g
        transform={`translate(${box.maxX} ${-box.maxY}) rotate(${-northAngleDeg}) scale(${sw * 3})`}
      >
        <line x1={0} y1={3} x2={0} y2={-3} stroke="#334155" strokeWidth={0.3} />
        <polygon points="0,-4 -0.9,-2 0.9,-2" fill="#334155" />
        <text x={0} y={-4.8} fontSize={1.8} textAnchor="middle" fill="#334155">
          N
        </text>
      </g>
    </svg>
  )
}
