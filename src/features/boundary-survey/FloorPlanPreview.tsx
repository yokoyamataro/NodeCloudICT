// 各階平面図 の 下絵。
//
// 画面 の 中 だけ の 確認用。 最終成果 (p21 / tif / pdf) は 別 の 出力 に する。
// 座標 は x=東 / y=北 の メートル な ので、SVG に 出す ときに y を 反転 する。

import { useMemo } from 'react'
import { floorExtent, type FloorRect, type FloorSpec } from './floorPlanTypes'

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b
  if (!b) return a
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/** 余白 を 付けた viewBox を 作る。 y は 反転 済み の 前提 */
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
  return Math.max(box.maxX - box.minX, box.maxY - box.minY) / 250
}

function normRect(r: FloorRect) {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  }
}

/**
 * 1 つ の 階 の 形。 矩形 ごと に 縦横 の 寸法 を 添える。
 * selectedRect が あれば その 矩形 だけ 色 を 変える。
 */
export function FloorShapePreview({
  floor,
  selectedRect,
  className,
}: {
  floor: FloorSpec
  selectedRect?: number | null
  className?: string
}) {
  const box = useMemo(() => floorExtent(floor), [floor])
  const sw = strokeOf(box)
  const fs = sw * 9

  if (!box) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-slate-400 ${className ?? ''}`}
      >
        寸法を入力すると形が表示されます
      </div>
    )
  }

  return (
    <svg className={className} viewBox={viewBoxOf(box, 0.18)} preserveAspectRatio="xMidYMid meet">
      {floor.rects.map((raw, i) => {
        const r = normRect(raw)
        const on = selectedRect === i
        return (
          <g key={i}>
            <rect
              x={r.x}
              y={-(r.y + r.h)}
              width={r.w}
              height={r.h}
              fill={on ? 'rgba(59,130,246,0.18)' : 'rgba(100,116,139,0.10)'}
              stroke={on ? '#2563eb' : '#334155'}
              strokeWidth={sw}
            />
            {/* 横 (下辺) */}
            <text
              x={r.x + r.w / 2}
              y={-r.y + fs * 1.2}
              fontSize={fs}
              textAnchor="middle"
              fill="#475569"
            >
              {r.w.toFixed(2)}
            </text>
            {/* 縦 (左辺) */}
            <text
              x={r.x - fs * 0.4}
              y={-(r.y + r.h / 2)}
              fontSize={fs}
              textAnchor="end"
              dominantBaseline="middle"
              fill="#475569"
            >
              {r.h.toFixed(2)}
            </text>
          </g>
        )
      })}
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
 * 地番 の 外形 に 1 階 を 載せた 図。
 * 敷地 は 実座標、建物 は placement で 置いた 位置 に 出す。
 */
export function PlacementPreview({
  sitePoints,
  floor,
  offsetE,
  offsetN,
  rotationDeg,
  className,
}: {
  sitePoints: SitePoint[]
  floor: FloorSpec | null
  offsetE: number
  offsetN: number
  rotationDeg: number
  className?: string
}) {
  // 敷地: X=北 な ので 画面 の 東 は y、北 は x
  const site = useMemo(
    () => sitePoints.map((p) => ({ e: p.y, n: p.x, label: p.pointNumber })),
    [sitePoints],
  )

  // 建物: 回転 させて から 現地 の 位置 へ 移す
  const building = useMemo(() => {
    if (!floor) return []
    const t = (rotationDeg * Math.PI) / 180
    const cos = Math.cos(t)
    const sin = Math.sin(t)
    return floor.rects.map((raw) => {
      const r = normRect(raw)
      const corners: [number, number][] = [
        [r.x, r.y],
        [r.x + r.w, r.y],
        [r.x + r.w, r.y + r.h],
        [r.x, r.y + r.h],
      ]
      return corners.map(([x, y]) => ({
        e: offsetE + x * cos - y * sin,
        n: offsetN + x * sin + y * cos,
      }))
    })
  }, [floor, offsetE, offsetN, rotationDeg])

  const box = useMemo(() => {
    let b: Box | null = null
    const bump = (e: number, n: number) => {
      b = unionBox(b, { minX: e, minY: n, maxX: e, maxY: n })
    }
    for (const p of site) bump(p.e, p.n)
    for (const poly of building) for (const p of poly) bump(p.e, p.n)
    return b
  }, [site, building])

  const sw = strokeOf(box)
  const fs = sw * 9

  if (!box) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-slate-400 ${className ?? ''}`}
      >
        地番と階を選ぶと配置が表示されます
      </div>
    )
  }

  return (
    <svg className={className} viewBox={viewBoxOf(box, 0.12)} preserveAspectRatio="xMidYMid meet">
      {/* 敷地 */}
      {site.length >= 2 && (
        <polygon
          points={site.map((p) => `${p.e},${-p.n}`).join(' ')}
          fill="rgba(16,185,129,0.06)"
          stroke="#059669"
          strokeWidth={sw}
        />
      )}
      {site.map((p, i) => (
        <g key={i}>
          <circle cx={p.e} cy={-p.n} r={sw * 2} fill="#059669" />
          <text x={p.e + sw * 3} y={-p.n - sw * 3} fontSize={fs} fill="#047857">
            {p.label}
          </text>
        </g>
      ))}
      {/* 建物 */}
      {building.map((poly, i) => (
        <polygon
          key={i}
          points={poly.map((p) => `${p.e},${-p.n}`).join(' ')}
          fill="rgba(59,130,246,0.18)"
          stroke="#2563eb"
          strokeWidth={sw * 1.4}
        />
      ))}
    </svg>
  )
}
