// DXF (既存横断図) を SVG で 表示する ビューア。
// - 元の 色を そのまま (レイヤ色 or エンティティ色) で 描画
// - レイヤ一覧 チェックボックス で 表示切替
// - マウス ホイール ズーム / 左ドラッグ パン (Interactive 断面エディタと 同じ 実装)
// - 「トレース モード」(次コミット で 実装予定) の フックだけ 型に 用意

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  parseDxf,
  computeSnapTargets,
  findNearestSnap,
  findNearestOrientedLine,
  type DxfDocument,
  type DxfShape,
  type SnapTarget,
} from '@/lib/dxfRender'

export function DxfCrossSectionViewer({
  dxfText,
  className,
  onCanvasPick,
  pickCursorHint,
  highlightDlY,
  highlightCenterX,
  overlays,
  snapEnabled = false,
  cursorLabelFormatter,
}: {
  dxfText: string
  className?: string
  /**
   * pickCursorHint (=モード) が セット されている 時、SVG が クリックされる ごとに
   * 呼ばれる。 shape は 図形に ヒットした 場合の エンティティ (無ければ null)。
   * DL/中心線 選択は クリック位置 (worldPt) だけで 決めるので shape なしでも OK。
   * トレースは snapEnabled 時 端点/交点 に 吸着 した 位置 が worldPt に 入る。
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
  /**
   * true の 間、カーソル 位置 に 近い 端点/交点 に 吸着する。 マーカーで 表示し、
   * クリック時に snap 位置が worldPt に 渡る。
   */
  snapEnabled?: boolean
  /**
   * カーソル位置 (吸着中は 吸着位置) に 貼り出す 補助ラベル を 生成する 関数。
   * 例: 校正 済み トレース時 に 「H=xxx / d=±x.xx」 を 表示。 null 返却で 非表示。
   */
  cursorLabelFormatter?: (worldPt: { x: number; y: number }) => string[] | null
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

  // スナップ 候補 (端点 + 交点)。 pickCursorHint='trace' + snapEnabled で 有効化
  const snapTargets = useMemo<SnapTarget[]>(
    () => (doc ? computeSnapTargets(doc) : []),
    [doc],
  )
  const snapActive = pickCursorHint === 'trace' && snapEnabled
  // 現在の 吸着候補 (mousemove で 更新)。 null なら 吸着 なし
  const [snap, setSnap] = useState<SnapTarget | null>(null)
  // DL/中心線 選択中の 「近くの 水平/垂直 線」プレビュー。 click で 確定
  const [linePreview, setLinePreview] = useState<{ orientation: 'h' | 'v'; coord: number } | null>(null)
  // カーソル 位置 (世界座標)。 補助ラベル (H / d) 表示 と 逐次確認 用
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null)

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
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    // ドラッグ pan
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
    // 吸着 候補 更新 (trace + snap ON の 時のみ)
    if (snapActive && fit) {
      const wx = ix(px)
      const wy = iy(py)
      // 画面 12 px 以内 に ある 最寄りを 吸着 (世界単位 に 変換)
      const threshold = 12 / (fit.scale * viewZoom)
      const t = findNearestSnap(snapTargets, wx, wy, threshold)
      setSnap(t)
    } else if (snap) {
      setSnap(null)
    }
    // DL / 中心線 選択中の 「近くの 水平/垂直 線」プレビュー
    if ((pickCursorHint === 'dl' || pickCursorHint === 'center') && fit) {
      const wx = ix(px), wy = iy(py)
      // 画面 30 px 相当の 世界半径 で 検索 (DL/中心線 は 少し 広めに)
      const threshold = 30 / (fit.scale * viewZoom)
      const orient: 'h' | 'v' = pickCursorHint === 'dl' ? 'h' : 'v'
      const coord = findNearestOrientedLine(doc.shapes, wx, wy, orient, threshold)
      setLinePreview(coord != null ? { orientation: orient, coord } : null)
    } else if (linePreview) {
      setLinePreview(null)
    }
    // カーソル 世界座標 更新 (ラベル表示 用)
    if (fit && (cursorLabelFormatter || pickCursorHint === 'trace')) {
      setCursorPos({ x: ix(px), y: iy(py) })
    } else if (cursorPos) {
      setCursorPos(null)
    }
  }
  const onMouseUp = () => {
    panStartRef.current = null
  }
  const onSvgLeave = () => {
    panStartRef.current = null
    setCursorPos(null)
    setSnap(null)
    setLinePreview(null)
  }
  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (wasDraggingRef.current) return
    if (!onCanvasPick || !pickCursorHint) return
    const rect = e.currentTarget.getBoundingClientRect()
    const rawWp = { x: ix(e.clientX - rect.left), y: iy(e.clientY - rect.top) }

    // pick モード別に worldPt を 決定
    let wp: { x: number; y: number }
    if (pickCursorHint === 'dl') {
      // DL: 近くの 水平線 が 無ければ 発火 しない (マウス位置は 使わない)
      if (!linePreview || linePreview.orientation !== 'h') return
      wp = { x: rawWp.x, y: linePreview.coord }
    } else if (pickCursorHint === 'center') {
      // 中心線: 近くの 垂直線 が 無ければ 発火 しない
      if (!linePreview || linePreview.orientation !== 'v') return
      wp = { x: linePreview.coord, y: rawWp.y }
    } else if (pickCursorHint === 'trace' && snap) {
      wp = { x: snap.x, y: snap.y }
    } else {
      wp = rawWp
    }

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
          onMouseLeave={onSvgLeave}
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
                      fontSize={11}
                      fill={o.color}
                      style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
                    >
                      {o.label}
                    </text>
                  )}
                </g>
              )
            })}
            {/* DL/中心線 選択中の 「候補線」プレビュー (薄紫 破線)。 click で 確定色 (紫) に */}
            {linePreview && linePreview.orientation === 'h' && (
              <line
                x1={tx(doc.bounds.minX - 10)} y1={ty(linePreview.coord)}
                x2={tx(doc.bounds.maxX + 10)} y2={ty(linePreview.coord)}
                stroke="#c084fc" strokeWidth={3}
                strokeDasharray="8,4"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
                opacity={0.8}
              />
            )}
            {linePreview && linePreview.orientation === 'v' && (
              <line
                x1={tx(linePreview.coord)} y1={ty(doc.bounds.minY - 10)}
                x2={tx(linePreview.coord)} y2={ty(doc.bounds.maxY + 10)}
                stroke="#c084fc" strokeWidth={3}
                strokeDasharray="8,4"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
                opacity={0.8}
              />
            )}
            {/* カーソル位置 (吸着中は 吸着位置) の 補助ラベル。 校正済み トレース時に
                現在 拾おうと している 点の 「H (標高) / d (中心からの離れ)」を 仮表示 */}
            {cursorLabelFormatter && cursorPos && (() => {
              const wp = snap ? { x: snap.x, y: snap.y } : cursorPos
              const lines = cursorLabelFormatter(wp)
              if (!lines || lines.length === 0) return null
              const cx = tx(wp.x), cy = ty(wp.y)
              // 画面 右上に 10px ずらして 描画 (paintOrder で 白フチ)
              return (
                <g pointerEvents="none">
                  {lines.map((s, i) => (
                    <text
                      key={i}
                      x={cx + 10}
                      y={cy - 4 - (lines.length - 1 - i) * 13}
                      fontSize={11}
                      fill="#1e293b"
                      style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 3 }}
                    >
                      {s}
                    </text>
                  ))}
                </g>
              )
            })()}
            {/* 吸着 候補 マーカー (□ + × 交点、〇 + □ 端点/頂点) */}
            {snap && (() => {
              const cx = tx(snap.x), cy = ty(snap.y)
              const size = 7
              const color = snap.kind === 'inter' ? '#ea580c' : '#0ea5e9'
              return (
                <g pointerEvents="none">
                  {/* 四角枠 */}
                  <rect
                    x={cx - size} y={cy - size}
                    width={size * 2} height={size * 2}
                    fill="none" stroke={color}
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                  />
                  {/* 種類マーク: inter=X、それ以外=● */}
                  {snap.kind === 'inter' ? (
                    <>
                      <line x1={cx - size / 2} y1={cy - size / 2} x2={cx + size / 2} y2={cy + size / 2}
                        stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                      <line x1={cx - size / 2} y1={cy + size / 2} x2={cx + size / 2} y2={cy - size / 2}
                        stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
                    </>
                  ) : (
                    <circle cx={cx} cy={cy} r={2.5} fill={color} vectorEffect="non-scaling-stroke" />
                  )}
                </g>
              )
            })()}
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
