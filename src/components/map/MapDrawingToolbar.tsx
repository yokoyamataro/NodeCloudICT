// 地図描画モードのツールバー (ペン / 消しゴム / 色 / 線種 / 太さ / 全消し)。
//
// レイアウト方針:
//   ・モバイル (幅狭) でも収まるように flex-wrap + max-width で自動改行
//   ・線種はプルダウン (ボタン + 展開メニュー) にしてスペース節約
//   ・色ピッカーも同様の展開メニュー
//   ・ボタンは 32px 四方に抑える

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  Circle as CircleIcon,
  Eraser,
  MousePointer2,
  Pen,
  Crosshair,
  Dot,
  Pentagon,
  Redo2,
  Ruler,
  Slash,
  StickyNote,
  Type,
  Undo2,
  X,
} from 'lucide-react'
import type { DrawingMode } from './MapDrawingLayer'
import { DEFAULT_LAYERS, type LineStyle } from '@/stores/mapDrawingStore'

/** 形状ボタンで扱う描画モード (ドロップダウンで直線 / 円 / 円弧 / 面 を切替) */
type ShapeMode = 'line' | 'circle' | 'arc' | 'polygon' | 'parallel'
const SHAPE_LABEL: Record<ShapeMode, string> = {
  line: '直線',
  parallel: '平行線',
  circle: '円',
  arc: '円弧',
  polygon: '面',
}
const SHAPE_HELP: Record<ShapeMode, string> = {
  line: 'クリックで頂点 / Backspace で 1 つ戻る / Enter で確定 / Esc で取消',
  parallel: '基準にする線をクリック → 幅を入力するか通過点をクリック → 確定',
  circle: '中心をクリック → 半径を入力するか円周上をクリック → 確定',
  arc: '始点 → 通過点 → 終点の 3 点をクリック',
  polygon: 'クリックで頂点 / 最初の点か Enter で閉じる / Backspace で 1 つ戻る',
}
/** 何を入れる道具かを 先頭に出す (「線入力」「文字入力」…) */
const SHAPE_INPUT: Record<ShapeMode, string> = {
  line: '線入力',
  parallel: '平行線入力',
  circle: '円入力',
  arc: '円弧入力',
  polygon: '面入力',
}

/** 円弧はぴったりの lucide アイコンが無いので四分弧を自前 SVG で描く */
function ArcSvg({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 20 A 16 16 0 0 1 20 4" />
    </svg>
  )
}

/** 平行線: 2 本の斜線で表す (lucide に該当アイコンが無い) */
function ParallelSvg({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 17 L 14 3" />
      <path d="M10 21 L 20 7" />
    </svg>
  )
}

/** 計測ボタンで扱うモード (距離 / 面積 / 垂線) */
type MeasureMode = 'measure-dist' | 'measure-area' | 'measure-perp'
const MEASURE_LABEL: Record<MeasureMode, string> = {
  'measure-dist': '距離',
  'measure-area': '面積',
  'measure-perp': '垂線',
}
const MEASURE_HELP: Record<MeasureMode, string> = {
  'measure-dist': '2 点をタップ',
  'measure-area': '頂点をタップ → 最初の点で閉じる',
  'measure-perp': '基準線の 2 点 → 対象の 1 点',
}

function shapeIcon(shape: ShapeMode): ReactNode {
  if (shape === 'line') return <Slash className="h-4 w-4" />
  if (shape === 'parallel') return <ParallelSvg size={16} />
  if (shape === 'circle') return <CircleIcon className="h-4 w-4" />
  if (shape === 'arc') return <ArcSvg size={16} />
  return <Pentagon className="h-4 w-4" />
}

const COLOR_PRESETS = [
  '#ef4444', // 赤
  '#f97316', // オレンジ
  '#eab308', // 黄
  '#22c55e', // 緑
  '#3b82f6', // 青
  '#a855f7', // 紫
  '#111827', // 黒
  '#ffffff', // 白
]

interface Props {
  mode: DrawingMode
  onChangeMode: (mode: DrawingMode) => void
  color: string
  onChangeColor: (color: string) => void
  widthPx: number
  onChangeWidth: (widthPx: number) => void
  lineStyle: LineStyle
  onChangeLineStyle: (style: LineStyle) => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  /** 付箋メモ (現在位置に従来のメモを残す) を発火。未指定なら非表示。 */
  onMemo?: () => void
  /**
   * 置き方。'floating' は地図に重ねる想定でカード風 (既定)、
   * 'bar' は画面上部の帯に埋め込む想定で余計な枠を出さない
   */
  variant?: 'floating' | 'bar'

  // ---- 作図・計測ツールから引き継いだ設定。未指定ならその操作を出さない ----
  /** ピック (スナップ): 近くの点に吸着させる */
  snapEnabled?: boolean
  onToggleSnap?: () => void
  /** DXF 出力時のレイヤ名 */
  layer?: string
  onChangeLayer?: (layer: string) => void
  /** レイヤ名の入力候補 (既に使われているレイヤ) */
  existingLayers?: string[]
  /** テキストの文字サイズ [px] */
  fontSize?: number
  onChangeFontSize?: (px: number) => void
  /** 点ツールで 座標管理にも 登録するか。未指定なら チェックボックスを出さない */
  registerCoordinate?: boolean
  onToggleRegisterCoordinate?: () => void
}

const LINE_STYLE_LABEL: Record<LineStyle, string> = {
  solid: '実線',
  dashed: '破線',
  dotted: '点線',
}
const LINE_STYLE_DASH: Record<LineStyle, string | undefined> = {
  solid: undefined,
  dashed: '6,3',
  dotted: '0.1,3',
}

/** 線種プレビュー用 SVG */
function LineStyleSvg({ style, width = 30 }: { style: LineStyle; width?: number }) {
  return (
    <svg width={width} height="10" viewBox={`0 0 ${width} 10`}>
      <line
        x1="0"
        y1="5"
        x2={width}
        y2="5"
        stroke="currentColor"
        strokeWidth={2}
        strokeDasharray={LINE_STYLE_DASH[style]}
        strokeLinecap="round"
      />
    </svg>
  )
}

export function MapDrawingToolbar({
  mode,
  onChangeMode,
  color,
  onChangeColor,
  widthPx,
  onChangeWidth,
  lineStyle,
  onChangeLineStyle,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onMemo,
  variant = 'floating',
  snapEnabled,
  onToggleSnap,
  layer,
  onChangeLayer,
  existingLayers,
  fontSize,
  onChangeFontSize,
  registerCoordinate,
  onToggleRegisterCoordinate,
}: Props) {
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  const [linePickerOpen, setLinePickerOpen] = useState(false)
  const [shapePickerOpen, setShapePickerOpen] = useState(false)
  const [measurePickerOpen, setMeasurePickerOpen] = useState(false)
  const [currentMeasure, setCurrentMeasure] = useState<MeasureMode>('measure-dist')
  // 形状ボタンで最後に選ばれた形状 (直線 / 円 / 円弧 / 面)。
  // ボタンをタップした時に「今どの形状に入るか」を決めるために保持する。
  const [currentShape, setCurrentShape] = useState<ShapeMode>('line')
  const rootRef = useRef<HTMLDivElement>(null)

  // mode が形状系に切り替わったら currentShape を追従させる (外部から強制設定された場合)
  useEffect(() => {
    if (mode === 'line' || mode === 'circle' || mode === 'arc' || mode === 'polygon') {
      setCurrentShape(mode)
    }
    if (mode === 'measure-dist' || mode === 'measure-area' || mode === 'measure-perp') {
      setCurrentMeasure(mode)
    }
  }, [mode])

  // 外側クリックでポップアップを閉じる (mobile でも動くよう pointerdown を使用)
  useEffect(() => {
    if (!colorPickerOpen && !linePickerOpen && !shapePickerOpen && !measurePickerOpen) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) {
        setColorPickerOpen(false)
        setLinePickerOpen(false)
        setShapePickerOpen(false)
        setMeasurePickerOpen(false)
      }
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [colorPickerOpen, linePickerOpen, shapePickerOpen, measurePickerOpen])

  const isShapeMode = mode === currentShape
  const isMeasure = mode === currentMeasure

  return (
    <div
      ref={rootRef}
      className={`bg-white flex flex-wrap items-center gap-1 text-xs ${
        variant === 'bar'
          ? 'p-0'
          : 'border rounded-lg shadow-lg p-1.5 max-w-[calc(100vw-1rem)]'
      }`}
    >
      {/* ペン (フリーハンド) */}
      <button
        type="button"
        onClick={() => onChangeMode(mode === 'pen' ? 'off' : 'pen')}
        title="手書き入力 — ドラッグでフリーハンドの線を引く"
        className={`w-8 h-8 flex items-center justify-center rounded shrink-0 ${
          mode === 'pen'
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        <Pen className="h-4 w-4" />
      </button>
      {/* 形状 (直線 / 円 / 円弧 / 面 のドロップダウン) */}
      <div className="relative shrink-0 flex items-stretch">
        <button
          type="button"
          onClick={() => onChangeMode(isShapeMode ? 'off' : currentShape)}
          title={`${SHAPE_INPUT[currentShape]} — ${SHAPE_HELP[currentShape]} (▼ で切替)`}
          className={`h-8 w-8 flex items-center justify-center rounded-l shrink-0 ${
            isShapeMode
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          {shapeIcon(currentShape)}
        </button>
        <button
          type="button"
          onClick={() => {
            setShapePickerOpen((v) => !v)
            setColorPickerOpen(false)
            setLinePickerOpen(false)
          }}
          title="形状を選ぶ"
          className={`h-8 w-4 flex items-center justify-center rounded-r border-l ${
            isShapeMode
              ? 'bg-blue-600 text-white border-blue-500'
              : 'text-slate-600 hover:bg-slate-100 border-slate-300'
          }`}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        {shapePickerOpen && (
          <div className="absolute top-full left-0 mt-1 z-[3000] bg-white border rounded shadow-lg py-1 min-w-[7rem]">
            {(['line', 'parallel', 'circle', 'arc', 'polygon'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setCurrentShape(s)
                  onChangeMode(s)
                  setShapePickerOpen(false)
                }}
                title={`${SHAPE_INPUT[s]} — ${SHAPE_HELP[s]}`}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs ${
                  currentShape === s
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <span className="w-4 h-4 flex items-center justify-center">
                  {shapeIcon(s)}
                </span>
                <span>{SHAPE_LABEL[s]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 計測 (距離 / 面積 / 垂線)。作図とは別扱いで、結果は保存しない */}
      <div className="relative shrink-0 flex items-stretch">
        <button
          type="button"
          onClick={() => onChangeMode(isMeasure ? 'off' : currentMeasure)}
          title={`${MEASURE_LABEL[currentMeasure]}計測 — ${MEASURE_HELP[currentMeasure]}`}
          className={`h-8 w-8 flex items-center justify-center rounded-l shrink-0 ${
            isMeasure ? 'bg-rose-600 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Ruler className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setMeasurePickerOpen((v) => !v)
            setShapePickerOpen(false)
            setColorPickerOpen(false)
            setLinePickerOpen(false)
          }}
          title="計測の種類を選ぶ"
          className={`h-8 w-4 flex items-center justify-center rounded-r border-l ${
            isMeasure
              ? 'bg-rose-600 text-white border-rose-500'
              : 'text-slate-600 hover:bg-slate-100 border-slate-300'
          }`}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        {measurePickerOpen && (
          <div className="absolute top-full left-0 mt-1 z-[3000] bg-white border rounded shadow-lg py-1 min-w-[7rem]">
            {(['measure-dist', 'measure-area', 'measure-perp'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setCurrentMeasure(m)
                  onChangeMode(m)
                  setMeasurePickerOpen(false)
                }}
                title={`${MEASURE_LABEL[m]}計測 — ${MEASURE_HELP[m]}`}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs ${
                  currentMeasure === m
                    ? 'bg-rose-50 text-rose-700'
                    : 'text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Ruler className="h-4 w-4" />
                <span>{MEASURE_LABEL[m]}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* 選択 (ストロークをタップ → 頂点ドラッグ / 長押しで削除 / + タップで追加) */}
      <button
        type="button"
        onClick={() => onChangeMode(mode === 'select' ? 'off' : 'select')}
        title="選択 — タップで図形を選び、属性 (レイヤ / 色 / 線種 / 太さ) を変える。ハンドルのドラッグで頂点移動、辺の + で頂点追加"
        className={`w-8 h-8 flex items-center justify-center rounded shrink-0 ${
          mode === 'select'
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        <MousePointer2 className="h-4 w-4" />
      </button>
      {/* 点。「座標登録」を入れておくと、置いた点を座標管理にも登録する */}
      <div className="relative shrink-0 flex items-stretch">
        <button
          type="button"
          onClick={() => onChangeMode(mode === 'point' ? 'off' : 'point')}
          title={
            registerCoordinate
              ? '点入力 — タップした場所に点を置き、座標管理にも登録する'
              : '点入力 — タップした場所に点を置く'
          }
          className={`w-8 h-8 flex items-center justify-center rounded shrink-0 ${
            mode === 'point'
              ? 'bg-blue-600 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <Dot className="h-6 w-6" strokeWidth={6} />
        </button>
        {mode === 'point' && onToggleRegisterCoordinate && (
          <button
            type="button"
            onClick={onToggleRegisterCoordinate}
            title="置いた点を座標管理にも登録する"
            className={`ml-0.5 h-8 px-1.5 flex items-center gap-1 rounded border text-[10px] ${
              registerCoordinate
                ? 'bg-emerald-600 border-emerald-500 text-white'
                : 'border-slate-300 text-slate-600 hover:bg-slate-100'
            }`}
          >
            <span>{registerCoordinate ? '☑' : '☐'}</span>
            <span>座標登録</span>
          </button>
        )}
      </div>
      {/* テキスト */}
      <button
        type="button"
        onClick={() => onChangeMode(mode === 'text' ? 'off' : 'text')}
        title="文字入力 — タップした場所に文字を置く"
        className={`w-8 h-8 flex items-center justify-center rounded shrink-0 ${
          mode === 'text'
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        <Type className="h-4 w-4" />
      </button>
      {/* 付箋メモ (現在位置に従来型のメモを残す) */}
      {onMemo && (
        <button
          type="button"
          onClick={() => {
            onMemo()
            onChangeMode('off')
          }}
          title="付箋メモ入力 — 現在位置にメモを残す"
          className="w-8 h-8 flex items-center justify-center rounded shrink-0 text-amber-600 hover:bg-amber-50"
        >
          <StickyNote className="h-4 w-4" />
        </button>
      )}
      {/* 消しゴム */}
      <button
        type="button"
        onClick={() => onChangeMode(mode === 'eraser' ? 'off' : 'eraser')}
        title="消しゴム — クリックした図形を消す"
        className={`w-8 h-8 flex items-center justify-center rounded shrink-0 ${
          mode === 'eraser'
            ? 'bg-red-500 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        <Eraser className="h-4 w-4" />
      </button>

      {/* ピック (スナップ) */}
      {onToggleSnap && (
        <button
          type="button"
          onClick={onToggleSnap}
          title={
            snapEnabled
              ? 'ピック ON (近くの点・頂点に吸着)'
              : 'ピック OFF (吸着しない)'
          }
          className={`w-8 h-8 flex items-center justify-center rounded shrink-0 border ${
            snapEnabled
              ? 'bg-amber-100 border-amber-400 text-amber-700'
              : 'border-transparent text-slate-500 hover:bg-slate-100'
          }`}
        >
          <Crosshair className="h-4 w-4" />
        </button>
      )}

      {/* undo / redo */}
      <button
        type="button"
        onClick={onUndo}
        disabled={!canUndo}
        title="元に戻す (この画面での操作のみ)"
        className="w-8 h-8 flex items-center justify-center rounded text-slate-600 hover:bg-slate-100 disabled:opacity-30 shrink-0"
      >
        <Undo2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onRedo}
        disabled={!canRedo}
        title="やり直す"
        className="w-8 h-8 flex items-center justify-center rounded text-slate-600 hover:bg-slate-100 disabled:opacity-30 shrink-0"
      >
        <Redo2 className="h-4 w-4" />
      </button>

      {/* 閉じる (モード解除) */}
      {mode !== 'off' && (
        <button
          type="button"
          onClick={() => onChangeMode('off')}
          title="描画モードを終了"
          className="w-8 h-8 flex items-center justify-center rounded text-slate-500 hover:bg-slate-100 shrink-0"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      {/* 共通属性 (レイヤ / 色 / 線種 / 太さ)。ツールバーの一番右にまとめる。
          ここで決めた値が、これから描くものに付く */}
      <div className="ml-auto flex flex-wrap items-center gap-1 pl-2 border-l">
        {/* レイヤ名 (DXF 出力に反映) */}
        {onChangeLayer && (
          <label className="flex items-center gap-1 shrink-0" title="レイヤ名 (DXF出力に反映)">
            <span className="text-[10px] text-slate-500">レイヤ</span>
            <input
              type="text"
              value={layer ?? '0'}
              onChange={(e) => onChangeLayer(e.target.value)}
              list="map-drawing-layers"
              className="w-16 h-8 px-1 border rounded font-mono text-[11px]"
            />
            <datalist id="map-drawing-layers">
              {Array.from(
                new Set([...DEFAULT_LAYERS, ...(existingLayers ?? []), '0']),
              ).map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </label>
        )}
        {/* 色 (プリセット + カスタム) */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setColorPickerOpen((v) => !v)
              setLinePickerOpen(false)
            }}
            title="ペンの色"
            className="w-8 h-8 flex items-center justify-center rounded hover:bg-slate-100 border shrink-0"
            style={{ backgroundColor: color }}
          >
            <span className="sr-only">色を選ぶ</span>
          </button>
          {colorPickerOpen && (
            <div className="absolute top-full left-0 mt-1 z-[3000] bg-white border rounded shadow-lg p-2 flex flex-col gap-1 min-w-[9rem]">
              <div className="grid grid-cols-4 gap-1">
                {COLOR_PRESETS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => {
                      onChangeColor(c)
                      setColorPickerOpen(false)
                    }}
                    className={`w-7 h-7 rounded border ${
                      c === color ? 'ring-2 ring-blue-500' : ''
                    }`}
                    style={{ backgroundColor: c }}
                    title={c}
                  />
                ))}
              </div>
              <input
                type="color"
                value={color}
                onChange={(e) => onChangeColor(e.target.value)}
                className="w-full h-8 mt-1"
                title="カスタム色"
              />
            </div>
          )}
        </div>
        {/* 線種 (プルダウン) */}
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => {
              setLinePickerOpen((v) => !v)
              setColorPickerOpen(false)
            }}
            title={`線種: ${LINE_STYLE_LABEL[lineStyle]}`}
            className="h-8 px-1.5 flex items-center gap-0.5 rounded border hover:bg-slate-100 text-slate-700"
          >
            <LineStyleSvg style={lineStyle} width={22} />
            <ChevronDown className="h-3 w-3" />
          </button>
          {linePickerOpen && (
            <div className="absolute top-full left-0 mt-1 z-[3000] bg-white border rounded shadow-lg py-1 min-w-[7rem]">
              {(['solid', 'dashed', 'dotted'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    onChangeLineStyle(s)
                    setLinePickerOpen(false)
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs ${
                    lineStyle === s
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <LineStyleSvg style={s} width={34} />
                  <span>{LINE_STYLE_LABEL[s]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {/* 太さスライダ */}
        <div className="flex items-center gap-1 pl-1 shrink-0">
          <input
            type="range"
            min={1}
            max={20}
            step={1}
            value={widthPx}
            onChange={(e) => onChangeWidth(Number(e.target.value))}
            className="w-14"
            title={`太さ: ${widthPx}px`}
          />
          <span className="text-[10px] font-mono text-slate-600 w-6 text-right">
            {widthPx}
          </span>
        </div>
        {/* 文字サイズ (テキストモードのときだけ) */}
        {mode === 'text' && onChangeFontSize && (
          <div className="flex items-center gap-1 pl-1 shrink-0">
            <Type className="h-3.5 w-3.5 text-slate-500" />
            <input
              type="range"
              min={10}
              max={48}
              step={1}
              value={fontSize ?? 14}
              onChange={(e) => onChangeFontSize(Number(e.target.value))}
              className="w-16"
              title={`文字サイズ: ${fontSize ?? 14}px`}
            />
            <span className="text-[10px] font-mono text-slate-600 w-6 text-right">
              {fontSize ?? 14}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
