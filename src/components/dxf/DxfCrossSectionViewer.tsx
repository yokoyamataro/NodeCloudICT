// DXF (既存横断図) を SVG で 表示する ビューア。
// - 元の 色を そのまま (レイヤ色 or エンティティ色) で 描画
// - レイヤ一覧 チェックボックス で 表示切替
// - マウス ホイール ズーム / 左ドラッグ パン (Interactive 断面エディタと 同じ 実装)
// - 「トレース モード」(次コミット で 実装予定) の フックだけ 型に 用意

import { useEffect, useMemo, useRef, useState } from 'react'
import { parseDxf, type DxfDocument, type DxfShape } from '@/lib/dxfRender'

export function DxfCrossSectionViewer({
  dxfText,
  className,
  onCanvasPick,
  pickCursorHint,
  highlightDlY,
  highlightCenterX,
  overlays,
}: {
  dxfText: string
  className?: string
  /**
   * pickCursorHint (=モード) が セット されている 時、SVG が クリックされる ごとに
   * 呼ばれる。 shape は 図形に ヒットした 場合の エンティティ (無ければ null)。
   * DL/中心線 選択は クリック位置 (worldPt) だけで 決めるので shape なしでも OK。
   * トレースは shape に対して 処理する (line/polyline の 頂点 抽出 等)。
   */
  onCanvasPick?: (worldPt: { x: number; y: number }, shape: DxfShape | null) => void
  /** カーソル形状の ヒント (crosshair 系)。 これが セット されて いる 時のみ pick 発火 */
  pickCursorHint?: 'dl' | 'center' | 'trace'
  /** DL 水平線 の DXF Y 座標。指定すると 上に 太い 破線 (紫) を 描いて 可視化 */
  highlightDlY?: number | null
  /** 中心 縦線 の DXF X 座標。指定すると 上に 太い 破線 (紫) を 描いて 可視化 */
  highlightCenterX?: number | null
  /** 追加の 上乗せ 描画 (トレース済み 点 の マーカー等)。世界座標 で 指定。 */
  overlays?: Array<
    | { kind: 'dot'; x: number; y: number; color: string; r?: number; label?: string }
  >
}) {
  const doc: DxfDocument | null = useMemo(() => {
    try {
      return parseDxf(dxfText)
    } catch (e) {
      console.error('[DxfCrossSectionViewer] parse failed', e)
      return null
    }
  }, [dxfText])

  // レイヤ 表示 ON/OFF
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set())
  useEffect(() => {
    // ドキュメント 差替時 は 初期は 全 layer 表示
    setHiddenLayers(new Set())
  }, [doc])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 800, h: 500 })
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

  // 自動フィット (bounds → SVG 座標)
  const padding = 20
  const fit = useMemo(() => {
    if (!doc) return null
    const { minX, minY, maxX, maxY } = doc.bounds
    const dx = Math.max(maxX - minX, 1)
    const dy = Math.max(maxY - minY, 1)
    const innerW = size.w - padding * 2
    const innerH = size.h - padding * 2
    const scale = Math.min(innerW / dx, innerH / dy)
    // 中央寄せ + Y 反転 (DXF は 上が +Y、SVG は 上が -Y)
    const tx = padding + (innerW - dx * scale) / 2 - minX * scale
    const ty = padding + (innerH - dy * scale) / 2 + maxY * scale
    return { scale, tx, ty }
  }, [doc, size])

  // ユーザー による pan / zoom
  const [viewPan, setViewPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [viewZoom, setViewZoom] = useState<number>(1)
  const wasDraggingRef = useRef(false)
  const panStartRef = useRef<{ px: number; py: number; panX: number; panY: number } | null>(null)

  useEffect(() => {
    // ドキュメント 差替時 は パン/ズームリセット
    setViewPan({ x: 0, y: 0 })
    setViewZoom(1)
  }, [doc])

  // ホイール ズーム (passive false 必要 なので 生 addEventListener)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      setViewZoom((z) => {
        const nz = Math.max(0.05, Math.min(50, z * factor))
        const k = nz / z
        setViewPan((p) => ({
          x: px - (px - p.x) * k,
          y: py - (py - p.y) * k,
        }))
        return nz
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  if (!doc) {
    return (
      <div className={`text-sm text-red-600 p-4 ${className ?? ''}`}>
        DXF の 解析に 失敗しました
      </div>
    )
  }
  if (!fit) return null

  // DXF 世界座標 → SVG px (Y は 反転)
  const tx = (x: number) => fit.tx + x * fit.scale
  const ty = (y: number) => fit.ty - y * fit.scale
  // SVG px → DXF 世界座標 (逆変換、ズーム/パン 込み)
  const ix = (px: number) => ((px - viewPan.x) / viewZoom - fit.tx) / fit.scale
  const iy = (py: number) => (fit.ty - (py - viewPan.y) / viewZoom) / fit.scale

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
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
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!panStartRef.current || !(e.buttons & 1)) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
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
  const onMouseUp = () => {
    panStartRef.current = null
  }
  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (wasDraggingRef.current) return
    if (!onCanvasPick || !pickCursorHint) return
    const rect = e.currentTarget.getBoundingClientRect()
    const wp = { x: ix(e.clientX - rect.left), y: iy(e.clientY - rect.top) }
    // 図形に ヒットしたら shape を 添える。 短い線 等で 外れても null で 発火
    // (DL/中心線 選択は 空クリック でも 位置だけで 決められる)
    const target = e.target as SVGElement | null
    const idx = target?.getAttribute?.('data-shape-idx')
    const shape = idx != null ? doc.shapes[Number(idx)] ?? null : null
    onCanvasPick(wp, shape)
  }

  return (
    <div className={`flex flex-col gap-1 h-full min-h-0 ${className ?? ''}`}>
      {/* レイヤ トグル バー */}
      <div className="flex items-center gap-1 flex-wrap text-[11px] shrink-0">
        <span className="text-slate-500">レイヤ:</span>
        <button
          onClick={() => setHiddenLayers(new Set())}
          className="px-1.5 py-0.5 border rounded bg-white hover:bg-slate-50 text-slate-700"
          title="全レイヤ 表示"
        >
          全ON
        </button>
        <button
          onClick={() => setHiddenLayers(new Set(doc.layers.map((l) => l.name)))}
          className="px-1.5 py-0.5 border rounded bg-white hover:bg-slate-50 text-slate-700"
          title="全レイヤ 非表示"
        >
          全OFF
        </button>
        <button
          onClick={() => {
            setViewPan({ x: 0, y: 0 })
            setViewZoom(1)
          }}
          className="px-1.5 py-0.5 border rounded bg-white hover:bg-slate-50 text-slate-700"
        >
          表示リセット
        </button>
        <span className="text-slate-400 ml-1">|</span>
        {doc.layers.map((l) => {
          const on = !hiddenLayers.has(l.name)
          return (
            <button
              key={l.name}
              onClick={() =>
                setHiddenLayers((prev) => {
                  const next = new Set(prev)
                  if (next.has(l.name)) next.delete(l.name)
                  else next.add(l.name)
                  return next
                })
              }
              className={`px-1.5 py-0.5 border rounded ${
                on ? 'text-slate-800' : 'text-slate-300 line-through'
              }`}
              style={{
                borderColor: on ? l.color : '#e2e8f0',
                background: on ? `${l.color}22` : '#f8fafc',
              }}
              title={on ? 'クリックで 非表示' : 'クリックで 表示'}
            >
              {l.name}
            </button>
          )
        })}
      </div>
      <div
        ref={containerRef}
        className="flex-1 min-h-0 border rounded bg-white relative overflow-hidden"
      >
        <svg
          width={size.w}
          height={size.h}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
          onClick={onSvgClick}
          style={{
            cursor: wasDraggingRef.current
              ? 'grabbing'
              : pickCursorHint
                ? 'crosshair'
                : 'grab',
          }}
        >
          <g transform={`translate(${viewPan.x} ${viewPan.y}) scale(${viewZoom})`}>
            {doc.shapes.map((s, i) => {
              if (hiddenLayers.has(s.layer)) return null
              return renderShape(s, i, tx, ty)
            })}
            {/* 校正済み DL 水平線 (紫 太 破線) */}
            {highlightDlY != null && (
              <line
                x1={tx(doc.bounds.minX - 10)} y1={ty(highlightDlY)}
                x2={tx(doc.bounds.maxX + 10)} y2={ty(highlightDlY)}
                stroke="#a855f7" strokeWidth={2}
                strokeDasharray="6,4"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
            {/* 校正済み 中心線 (紫 太 破線) */}
            {highlightCenterX != null && (
              <line
                x1={tx(highlightCenterX)} y1={ty(doc.bounds.minY - 10)}
                x2={tx(highlightCenterX)} y2={ty(doc.bounds.maxY + 10)}
                stroke="#a855f7" strokeWidth={2}
                strokeDasharray="6,4"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            )}
            {/* トレース済み 点マーカー */}
            {overlays?.map((o, i) => {
              if (o.kind !== 'dot') return null
              return (
                <g key={`ov-${i}`} pointerEvents="none">
                  <circle
                    cx={tx(o.x)} cy={ty(o.y)}
                    r={o.r ?? 3.5}
                    fill={o.color}
                    stroke="#fff"
                    strokeWidth={1.5}
                    vectorEffect="non-scaling-stroke"
                  />
                  {o.label && (
                    <text
                      x={tx(o.x) + 6}
                      y={ty(o.y) - 4}
                      fontSize={10}
                      fill={o.color}
                    >
                      {o.label}
                    </text>
                  )}
                </g>
              )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}

function renderShape(
  s: DxfShape,
  i: number,
  tx: (x: number) => number,
  ty: (y: number) => number,
) {
  const commonProps = { 'data-shape-idx': i }
  if (s.kind === 'line') {
    return (
      <line
        key={i}
        x1={tx(s.x1)} y1={ty(s.y1)} x2={tx(s.x2)} y2={ty(s.y2)}
        stroke={s.color} strokeWidth={0.7}
        vectorEffect="non-scaling-stroke"
        {...commonProps}
      />
    )
  }
  if (s.kind === 'polyline') {
    const d = s.pts.map((p, k) => `${k === 0 ? 'M' : 'L'} ${tx(p.x)} ${ty(p.y)}`).join(' ')
      + (s.closed ? ' Z' : '')
    return (
      <path
        key={i}
        d={d}
        fill="none" stroke={s.color} strokeWidth={0.7}
        vectorEffect="non-scaling-stroke"
        {...commonProps}
      />
    )
  }
  if (s.kind === 'circle') {
    return (
      <circle
        key={i}
        cx={tx(s.cx)} cy={ty(s.cy)} r={s.r * Math.abs((tx(1) - tx(0)))}
        fill="none" stroke={s.color} strokeWidth={0.7}
        vectorEffect="non-scaling-stroke"
        {...commonProps}
      />
    )
  }
  if (s.kind === 'arc') {
    // ARC → SVG path。startDeg/endDeg は反時計回り (DXF 慣習)。 SVG の 描画は
    // Y 反転なので 角度も 反転させる。ここでは 単純に 2 点で 近似 (直線分割) しても
    // 良いが、まずは path arc で 描く。 X: cos, Y: -sin (Y 反転)。
    const start = polarToSvg(s.cx, s.cy, s.r, s.startDeg, tx, ty)
    const end = polarToSvg(s.cx, s.cy, s.r, s.endDeg, tx, ty)
    let sweep = s.endDeg - s.startDeg
    while (sweep < 0) sweep += 360
    const largeArc = sweep > 180 ? 1 : 0
    // SVG では Y 反転 で 円弧の 「巻き方向」も 反転する ため sweep-flag=0
    return (
      <path
        key={i}
        d={`M ${start.x} ${start.y} A ${Math.abs(tx(s.r) - tx(0))} ${Math.abs(tx(s.r) - tx(0))} 0 ${largeArc} 0 ${end.x} ${end.y}`}
        fill="none" stroke={s.color} strokeWidth={0.7}
        vectorEffect="non-scaling-stroke"
        {...commonProps}
      />
    )
  }
  if (s.kind === 'text') {
    const anchor = tx(s.x)
    const baseline = ty(s.y)
    return (
      <text
        key={i}
        x={anchor} y={baseline}
        fontSize={s.height}
        fill={s.color}
        transform={s.rotationDeg ? `rotate(${-s.rotationDeg} ${anchor} ${baseline})` : undefined}
        {...commonProps}
      >
        {s.text}
      </text>
    )
  }
  return null
}

function polarToSvg(
  cx: number, cy: number, r: number, deg: number,
  tx: (x: number) => number, ty: (y: number) => number,
) {
  const rad = (deg * Math.PI) / 180
  return { x: tx(cx + r * Math.cos(rad)), y: ty(cy + r * Math.sin(rad)) }
}
