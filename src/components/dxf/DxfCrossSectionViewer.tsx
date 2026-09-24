// DXF (既存横断図) を SVG で 表示する ビューア。
// - 元の 色を そのまま (レイヤ色 or エンティティ色) で 描画
// - レイヤ一覧 チェックボックス で 表示切替
// - マウス ホイール ズーム / 左ドラッグ パン (Interactive 断面エディタと 同じ 実装)
// - 「トレース モード」(次コミット で 実装予定) の フックだけ 型に 用意

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  parsedDoc,
  className,
  onCanvasPick,
  pickCursorHint,
  highlightDlY,
  highlightCenterX,
  overlays,
  snapEnabled = false,
  cursorLabelFormatter,
  traceRubberBandFrom,
}: {
  dxfText: string
  /**
   * 解析済み の 図面。 SXF (SFC / P21) の ように DXF 以外 から 作った 場合 に
   * 渡す。 指定 すると dxfText は 見ない。
   */
  parsedDoc?: DxfDocument | null
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
  /** 追加の 上乗せ 描画 (トレース済み 点 の マーカー / トレース線 等)。世界座標 で 指定。
   *  label は 文字列 or 複数行 (string[])。 複数行は 2 段 3 段 で 縦積み 表示。 */
  overlays?: Array<
    | { kind: 'dot'; x: number; y: number; color: string; r?: number; label?: string | string[] }
    | { kind: 'line'; pts: { x: number; y: number }[]; color: string; dashed?: boolean }
  >
  /**
   * トレース中に カーソル位置 (吸着時は 吸着位置) に 向けて 引く 仮線 (rubber-band) の
   * 出発点。 通常は 「直前 に 拾った 点」の DXF 位置 を 渡す。 pickCursorHint='trace' で
   * かつ cursorPos が ある 時のみ 描画。
   */
  traceRubberBandFrom?: { x: number; y: number } | null
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
    // 解析済み を 渡された場合 (SXF など DXF 以外 の 出所) は そのまま 使う
    if (parsedDoc) return parsedDoc
    try {
      return parseDxf(dxfText)
    } catch (e) {
      console.error('[DxfCrossSectionViewer] parse failed', e)
      return null
    }
  }, [dxfText, parsedDoc])

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
  // SVG 自身 の 参照。 wheel イベント は 枠 (container) の border 分 の ズレ を
  // 避ける ため、SVG から rect を 取る。 マウス系 ハンドラ と 同じ 基準 で 揃える。
  const svgRef = useRef<SVGSVGElement | null>(null)
  /**
   * 枠 が 後から 現れる ことが ある (解析前 は 別 の 表示 を 返す ため)。
   * ref だけ だと 監視 を 張り直せず、
   *   ・大きさ が 既定 の まま で 倍率 が 画面 と 合わない
   *   ・指 操作 が 効かない
   * に なる。 枠 が 付いた こと を 状態 に して 張り直す。
   */
  const [containerReady, setContainerReady] = useState(0)
  const setContainerNode = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el
    if (el) setContainerReady((n) => n + 1)
  }, [])
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
    // 初回 は 実測 して おく (observe 前 の 既定値 を 引きずらない)
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      setSize({ w: Math.max(320, Math.floor(r.width)), h: Math.max(200, Math.floor(r.height)) })
    }
    return () => ro.disconnect()
  }, [containerReady])

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
  /**
   * 範囲拡大。 外側 に ゴミ が ある 図面 は 全体表示 の 縮尺 が 極端に 小さく なり、
   * ホイール だけ では 目的 の 場所 まで 寄れない。 左上 → 右下 を 囲って 一気に 寄せる。
   */
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)
  // 文字 拡大率。 SFC / P21 で 文字高 が 図面 に 対して 小さい ときに 手動 で 効かせる
  const [textScale, setTextScale] = useState<number>(1)
  const [rectMode, setRectMode] = useState(false)
  const [rectStart, setRectStart] = useState<{ x: number; y: number } | null>(null)
  const [rectNow, setRectNow] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    // ドキュメント 差替時 は パン/ズームリセット
    setViewPan({ x: 0, y: 0 })
    setViewZoom(1)
    setRectMode(false)
    setRectStart(null)
    setRectNow(null)
  }, [doc])

  // 今 の pan / zoom を タッチ処理 から 読む ため の 控え
  //(native listener は 張り直したく ない ので state を 直接 見ない)
  const viewRef = useRef({ pan: { x: 0, y: 0 }, zoom: 1 })
  useEffect(() => {
    viewRef.current = { pan: viewPan, zoom: viewZoom }
  }, [viewPan, viewZoom])
  const rectModeRef = useRef(false)
  const applyRectZoomRef = useRef<() => void>(() => {})

  /**
   * 指 操作。 1 本 = 移動、2 本 = つまんで 伸縮。
   * React の onTouchMove は passive で 付く ことが あり preventDefault が
   * 効かない (ページ が スクロール して しまう) ので 生 listener で 張る。
   */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let mode: 'none' | 'pan' | 'pinch' | 'rect' = 'none'
    let startPan = { x: 0, y: 0 }
    let startZoom = 1
    let startPt = { x: 0, y: 0 }
    let startDist = 0
    let startMid = { x: 0, y: 0 }

    const local = (t: Touch) => {
      const r = el.getBoundingClientRect()
      return { x: t.clientX - r.left, y: t.clientY - r.top }
    }
    const onStart = (e: TouchEvent) => {
      startPan = { ...viewRef.current.pan }
      startZoom = viewRef.current.zoom
      if (e.touches.length === 1) {
        startPt = local(e.touches[0])
        if (rectModeRef.current) {
          mode = 'rect'
          setRectStart(startPt)
          setRectNow(null)
        } else {
          mode = 'pan'
        }
        return
      }
      if (e.touches.length >= 2) {
        const a = local(e.touches[0])
        const b = local(e.touches[1])
        startDist = Math.hypot(b.x - a.x, b.y - a.y) || 1
        startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        mode = 'pinch'
      }
    }
    const onMove = (e: TouchEvent) => {
      if (mode === 'none') return
      e.preventDefault()
      if (mode === 'rect' && e.touches.length >= 1) {
        setRectNow(local(e.touches[0]))
        return
      }
      if (mode === 'pan' && e.touches.length === 1) {
        const p = local(e.touches[0])
        setViewPan({
          x: startPan.x + (p.x - startPt.x),
          y: startPan.y + (p.y - startPt.y),
        })
        return
      }
      if (mode === 'pinch' && e.touches.length >= 2) {
        const a = local(e.touches[0])
        const b = local(e.touches[1])
        const dist = Math.hypot(b.x - a.x, b.y - a.y) || 1
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
        const nz = Math.max(0.02, Math.min(5000, startZoom * (dist / startDist)))
        const k = nz / startZoom
        // つまんだ 中心 を 固定 した まま 伸縮 + 2 本指 の 移動 で パン
        setViewZoom(nz)
        setViewPan({
          x: mid.x - (startMid.x - startPan.x) * k,
          y: mid.y - (startMid.y - startPan.y) * k,
        })
      }
    }
    const onEnd = (e: TouchEvent) => {
      if (mode === 'rect' && e.touches.length === 0) {
        // 指を 離した ところ で 矩形 を 確定 (マウス と 同じ 処理 を 呼ぶ)
        applyRectZoomRef.current()
      }
      if (e.touches.length === 0) mode = 'none'
    }
    el.addEventListener('touchstart', onStart, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [containerReady])

  // ホイール ズーム (passive false 必要 なので 生 addEventListener)。
  //
  // 重要: React 18 の StrictMode で は 関数 setter の updater が 純粋性
  // チェック の ため 2 回 呼ばれる。 updater の 中 で 別 の setState を
  // 呼ぶ と 副作用 が 2 回 起き、pan が 2 倍 動いて 拡大 する ほど ズレ が
  // 累積 する バグ に なる。
  // → updater を 使わず、viewRef (最新値) から 直接 読んで 両方 の
  //   setState を トップレベル で 呼ぶ。
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const svg = svgRef.current
      let px: number, py: number
      if (svg) {
        const rect = svg.getBoundingClientRect()
        const attrW = svg.width?.baseVal?.value || rect.width || 1
        const attrH = svg.height?.baseVal?.value || rect.height || 1
        const sx = rect.width / attrW
        const sy = rect.height / attrH
        px = (e.clientX - rect.left) / (sx || 1)
        py = (e.clientY - rect.top) / (sy || 1)
      } else {
        const rect = el.getBoundingClientRect()
        px = e.clientX - rect.left
        py = e.clientY - rect.top
      }
      const factor = e.deltaY > 0 ? 0.9 : 1.1
      const oldZoom = viewRef.current.zoom
      const oldPan = viewRef.current.pan
      const nz = Math.max(0.02, Math.min(5000, oldZoom * factor))
      const k = nz / oldZoom
      setViewZoom(nz)
      setViewPan({
        x: px - (px - oldPan.x) * k,
        y: py - (py - oldPan.y) * k,
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [containerReady])

  /** 囲んだ 矩形 を 画面いっぱい に する (マウス / タッチ 共通) */
  const applyRectZoom = () => {
    if (!rectMode || !rectStart || !rectNow) return
    const x1 = Math.min(rectStart.x, rectNow.x)
    const y1 = Math.min(rectStart.y, rectNow.y)
    const x2 = Math.max(rectStart.x, rectNow.x)
    const y2 = Math.max(rectStart.y, rectNow.y)
    // 小さすぎる 矩形 (誤操作) は 無視
    if (x2 - x1 > 8 && y2 - y1 > 8) {
      // 画面 px → 変換前 の 座標 に 戻して から、その 矩形 が 収まる ように 組み直す
      const b1x = (x1 - viewPan.x) / viewZoom
      const b1y = (y1 - viewPan.y) / viewZoom
      const b2x = (x2 - viewPan.x) / viewZoom
      const b2y = (y2 - viewPan.y) / viewZoom
      const nz = Math.max(
        0.02,
        Math.min(5000, Math.min(size.w / (b2x - b1x), size.h / (b2y - b1y))),
      )
      setViewZoom(nz)
      setViewPan({
        x: (size.w - (b2x - b1x) * nz) / 2 - b1x * nz,
        y: (size.h - (b2y - b1y) * nz) / 2 - b1y * nz,
      })
    }
    setRectMode(false)
    setRectStart(null)
    setRectNow(null)
  }
  // タッチ の native listener から 呼ぶ ため の 入口 (描画後 に 最新 へ 差し替える)
  useEffect(() => {
    applyRectZoomRef.current = applyRectZoom
    rectModeRef.current = rectMode
  })

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
    const rect0 = e.currentTarget.getBoundingClientRect()
    if (rectMode) {
      // 範囲拡大中 は パン せず 矩形 を 引く
      setRectStart({ x: e.clientX - rect0.left, y: e.clientY - rect0.top })
      setRectNow(null)
      return
    }
    const rect = rect0
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
    if (rectMode) {
      if (rectStart) setRectNow({ x: px, y: py })
      return
    }
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
    applyRectZoom()
  }
  const onSvgLeave = () => {
    panStartRef.current = null
    setRectStart(null)
    setRectNow(null)
    setCursorPos(null)
    setSnap(null)
    setLinePreview(null)
  }
  const onSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (wasDraggingRef.current || rectMode) return
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
      {/* 操作バー。 レイヤ は 数 が 多い と 場所 を 食う ので
          常設 せず ボタン → 一覧 に する */}
      <div className="relative flex items-center gap-1 flex-wrap text-[11px] shrink-0">
        <button
          onClick={() => setLayerPanelOpen((v) => !v)}
          className={`px-1.5 py-0.5 border rounded ${
            layerPanelOpen
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'bg-white hover:bg-slate-50 text-slate-700'
          }`}
          title="レイヤの表示を切り替える"
        >
          レイヤ{' '}
          <span className={layerPanelOpen ? 'opacity-80' : 'text-slate-400'}>
            {doc.layers.length - hiddenLayers.size}/{doc.layers.length}
          </span>
        </button>
        <button
          onClick={() => {
            setViewPan({ x: 0, y: 0 })
            setViewZoom(1)
            setRectMode(false)
            setRectStart(null)
            setRectNow(null)
          }}
          className="px-1.5 py-0.5 border rounded bg-white hover:bg-slate-50 text-slate-700"
        >
          全体表示
        </button>
        <button
          onClick={() => {
            setRectMode((v) => !v)
            setRectStart(null)
            setRectNow(null)
          }}
          className={`px-1.5 py-0.5 border rounded ${
            rectMode
              ? 'bg-blue-600 border-blue-600 text-white'
              : 'bg-white hover:bg-slate-50 text-slate-700'
          }`}
          title="見たい 範囲 を 左上 → 右下 に なぞって 囲うと そこまで 寄る"
        >
          範囲拡大
        </button>
        <span className="text-slate-400">{Math.round(viewZoom * 100)}%</span>

        {/* 文字 の 大きさ 倍率。 P21 / SFC は 描画元 の 文字高 が 小さめ に 入って
            いる ことが 多い ので、 手動 で 拡大 できる ように する。 */}
        <span className="flex items-center gap-1 text-slate-500">
          文字
          <input
            type="range"
            min={5}
            max={80}
            step={1}
            value={Math.round(textScale * 10)}
            onChange={(e) => setTextScale(parseInt(e.target.value, 10) / 10)}
            className="w-16"
            title={`文字 拡大率 (${textScale.toFixed(1)}×)`}
          />
          <span className="w-8 text-right tabular-nums text-slate-600">
            {textScale.toFixed(1)}×
          </span>
          {textScale !== 1 && (
            <button
              onClick={() => setTextScale(1)}
              className="px-1 border rounded bg-white hover:bg-slate-50 text-slate-500"
              title="等倍に戻す"
            >
              リセット
            </button>
          )}
        </span>

        {layerPanelOpen && (
          <div className="absolute left-0 top-full mt-1 z-20 w-64 max-h-60 overflow-auto bg-white border rounded shadow-lg p-2">
            <div className="flex items-center gap-1 mb-1">
              <span className="text-slate-500">レイヤ</span>
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
                onClick={() => setLayerPanelOpen(false)}
                className="ml-auto px-1.5 py-0.5 text-slate-400 hover:text-slate-700"
                aria-label="閉じる"
              >
                ×
              </button>
            </div>
            <div className="flex flex-wrap gap-1">
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
                    title={on ? 'タップで 非表示' : 'タップで 表示'}
                  >
                    {l.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>
      <div
        ref={setContainerNode}
        className="flex-1 min-h-0 border rounded bg-white relative overflow-hidden"
        // 指 で 触った ときに ページ が スクロール / 拡大 しない ように する
        // (図面 側 で 移動 と 伸縮 を 受け取る)
        style={{ touchAction: 'none' }}
      >
        <svg
          ref={svgRef}
          width={size.w}
          height={size.h}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onSvgLeave}
          onClick={onSvgClick}
          style={{
            cursor: rectMode
              ? 'crosshair'
              : wasDraggingRef.current
                ? 'grabbing'
                : pickCursorHint
                  ? 'crosshair'
                  : 'grab',
          }}
        >
          <g transform={`translate(${viewPan.x} ${viewPan.y}) scale(${viewZoom})`}>
            {doc.shapes.map((s, i) => {
              if (hiddenLayers.has(s.layer)) return null
              return renderShape(s, i, tx, ty, viewZoom, textScale)
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
            {/* トレース線 (点を つないだ 折れ線)。 マーカーの 下に 描画 */}
            {overlays?.map((o, i) => {
              if (o.kind !== 'line' || o.pts.length < 2) return null
              const d = o.pts.map((p, k) => `${k === 0 ? 'M' : 'L'} ${tx(p.x)} ${ty(p.y)}`).join(' ')
              return (
                <path
                  key={`ovline-${i}`}
                  d={d}
                  fill="none"
                  stroke={o.color}
                  strokeWidth={1.2}
                  strokeDasharray={o.dashed ? '3,2' : undefined}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )
            })}
            {/* トレース済み 点マーカー — 塗りなし の 丸枠、小さめ。 ラベルは 2 段 で 縦積み */}
            {overlays?.map((o, i) => {
              if (o.kind !== 'dot') return null
              const labelLines = Array.isArray(o.label)
                ? o.label
                : o.label
                  ? [o.label]
                  : []
              const cx = tx(o.x), cy = ty(o.y)
              const fs = 0.9
              const dy = fs + 0.15 // 行間
              return (
                <g key={`ov-${i}`} pointerEvents="none">
                  <circle
                    cx={cx} cy={cy}
                    r={o.r ?? 0.7}
                    fill="none"
                    stroke={o.color}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  {labelLines.map((s, k) => (
                    <text
                      key={k}
                      x={cx + 1.2}
                      y={cy - 0.6 + k * dy}
                      fontSize={fs}
                      fill={o.color}
                      style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 0.3 }}
                    >
                      {s}
                    </text>
                  ))}
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
                現在 拾おうと している 点の 「H (標高)」「d (中心からの離れ)」を 2 段 仮表示 */}
            {cursorLabelFormatter && cursorPos && (() => {
              const wp = snap ? { x: snap.x, y: snap.y } : cursorPos
              const lines = cursorLabelFormatter(wp)
              if (!lines || lines.length === 0) return null
              const cx = tx(wp.x), cy = ty(wp.y)
              const fs = 0.9
              const dy = fs + 0.15
              // 縦積み: 最下段 が cy - 0.6、上段は 更に 上へ
              return (
                <g pointerEvents="none">
                  {lines.map((s, i) => (
                    <text
                      key={i}
                      x={cx + 1.2}
                      y={cy - 0.6 - (lines.length - 1 - i) * dy}
                      fontSize={fs}
                      fill="#1e293b"
                      style={{ paintOrder: 'stroke', stroke: '#f8fafc', strokeWidth: 0.3 }}
                    >
                      {s}
                    </text>
                  ))}
                </g>
              )
            })()}
            {/* トレース中の 仮線 (rubber-band): 直前 に 拾った 点から カーソル位置 (吸着時は
                吸着位置) まで 破線で 引く。 次の 1 点を どこに 打つか の 見当を つけやすく */}
            {pickCursorHint === 'trace' && traceRubberBandFrom && cursorPos && (() => {
              const wp = snap ? { x: snap.x, y: snap.y } : cursorPos
              return (
                <line
                  x1={tx(traceRubberBandFrom.x)} y1={ty(traceRubberBandFrom.y)}
                  x2={tx(wp.x)} y2={ty(wp.y)}
                  stroke="#94a3b8"
                  strokeWidth={0.8}
                  strokeDasharray="2,1.5"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )
            })()}
            {/* 吸着 候補 マーカー — 小さな 十字 (+)。 端点/頂点=青、交点=橙 */}
            {snap && (() => {
              const cx = tx(snap.x), cy = ty(snap.y)
              const arm = 1.5 // 十字の 腕 の 長さ (SVG 単位)
              const color = snap.kind === 'inter' ? '#ea580c' : '#0ea5e9'
              return (
                <g pointerEvents="none">
                  <line
                    x1={cx - arm} y1={cy} x2={cx + arm} y2={cy}
                    stroke={color} strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={cx} y1={cy - arm} x2={cx} y2={cy + arm}
                    stroke={color} strokeWidth={1.2}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              )
            })()}
          </g>
          {/* 範囲拡大 の ラバーバンド (画面座標 な ので 変換 の 外) */}
          {rectMode && rectStart && rectNow && (
            <rect
              x={Math.min(rectStart.x, rectNow.x)}
              y={Math.min(rectStart.y, rectNow.y)}
              width={Math.abs(rectNow.x - rectStart.x)}
              height={Math.abs(rectNow.y - rectStart.y)}
              fill="#3b82f6"
              fillOpacity={0.12}
              stroke="#2563eb"
              strokeWidth={1}
              strokeDasharray="4 3"
            />
          )}
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
  /** 画面 の 拡大率。 文字 を 出すか の 判定 に 使う */
  viewZoom = 1,
  /** 文字 高 倍率 (SFC / P21 用 に 手動 で 効かせる) */
  textScale = 1,
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
    const px = tx(s.x)
    const py = ty(s.y)
    // s.height は 図面 の 実寸。 x/y は すでに 画面座標 に 変換 済み なので、
    // 文字高 にも 同じ 倍率 を かけない と 図面 に 対して 極端に 小さく
    // (= 事実上 見えなく) なる
    const scale = Math.abs(tx(1) - tx(0))
    // textScale (ユーザー 調整) を さらに 効かせる。 SFC / P21 は 文字高 が
    // 図面 に 対して 小さめ の こと が 多い ため。
    const fontSize = s.height * scale * textScale
    // 出すか どうか は 「画面上 の 大きさ」 で 決める。
    // 全体表示 の 縮尺 だけ で 判定 すると、図面 が 広い ファイル で
    // 拡大 しても 文字 が 出て こない (以前 は これ で 消えて いた)。
    if (!(fontSize * viewZoom > 0.4)) return null
    return (
      <text
        key={i}
        x={px} y={py}
        fontSize={fontSize}
        fill={s.color}
        textAnchor={s.anchor}
        dominantBaseline={s.baseline}
        transform={s.rotationDeg ? `rotate(${-s.rotationDeg} ${px} ${py})` : undefined}
        style={{ whiteSpace: 'pre' }}
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
