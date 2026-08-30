// 全体図の左パネル。表示要素とレイヤをここで一括管理する。
//
// ・表示要素 … 測点 / 地番 / 暗渠配線 / カメラ / メモ / ペイント の表示切替
// ・描画設定 … 色 / 線種 / 線幅。これから描くものに 付く
// ・レイヤ   … ペイントのレイヤ。表示切替 + 並べ替え + 「これから描くレイヤ」の選択 + 追加
//
// 並び順は そのまま 描画順になる。一覧で 上にあるレイヤほど 地図でも 上に出る。
// 順序と表示状態は 工区ごとに localStorage へ持つ (この端末での見え方の設定)。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, Layers, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { DEFAULT_LAYERS, type LineStyle } from '@/stores/mapDrawingStore'

/** 色のプリセット (ツールバーと揃える) */
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

export interface VisibilityRow {
  key: string
  label: string
  on: boolean
  set: (v: boolean) => void
}

const ORDER_KEY = (farmId: string) => `overview:layerOrder:${farmId}`
const HIDDEN_KEY = (farmId: string) => `overview:layerHidden:${farmId}`
const OPEN_KEY = 'overview:layerPanelOpen'

function readList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : []
  } catch {
    return []
  }
}

function writeList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {
    /* 保存できなくても表示には影響しない */
  }
}

/**
 * レイヤの並び順と表示状態。
 * 実際に使われているレイヤと既定レイヤを足し合わせ、保存済みの順序を先頭に、
 * 保存に無いもの (新しく使われ始めたレイヤ) を後ろに付ける。
 */
export function useLayerOrder(farmId: string, presentLayers: string[]) {
  const [order, setOrder] = useState<string[]>(() => readList(ORDER_KEY(farmId)))
  const [hidden, setHidden] = useState<string[]>(() => readList(HIDDEN_KEY(farmId)))

  // 工区が変わったら読み直す
  useEffect(() => {
    setOrder(readList(ORDER_KEY(farmId)))
    setHidden(readList(HIDDEN_KEY(farmId)))
  }, [farmId])

  const layers = useMemo(() => {
    const all = new Set<string>([...DEFAULT_LAYERS, ...presentLayers])
    const out = order.filter((l) => all.has(l))
    for (const l of all) if (!out.includes(l)) out.push(l)
    return out
  }, [order, presentLayers])

  const move = useCallback(
    (layer: string, dir: -1 | 1) => {
      const next = [...layers]
      const i = next.indexOf(layer)
      const j = i + dir
      if (i < 0 || j < 0 || j >= next.length) return
      ;[next[i], next[j]] = [next[j], next[i]]
      setOrder(next)
      writeList(ORDER_KEY(farmId), next)
    },
    [layers, farmId],
  )

  const toggleHidden = useCallback(
    (layer: string) => {
      setHidden((prev) => {
        const next = prev.includes(layer) ? prev.filter((l) => l !== layer) : [...prev, layer]
        writeList(HIDDEN_KEY(farmId), next)
        return next
      })
    },
    [farmId],
  )

  return { layers, hidden, move, toggleHidden }
}

interface Props {
  /** 表示要素 (測点 / 地番 / …) の切替 */
  visibility: VisibilityRow[]
  /** レイヤ一覧 (上にあるものほど 地図でも上に出る) */
  layers: string[]
  hiddenLayers: string[]
  onMoveLayer: (layer: string, dir: -1 | 1) => void
  onToggleLayer: (layer: string) => void
  /** これから描くレイヤ */
  currentLayer: string
  onSelectLayer: (layer: string) => void
  /** 一覧に無い名前を打って レイヤを増やす */
  onAddLayer?: (layer: string) => void

  // ---- これから描くものに付く 共通属性 (元はツールバーの右端にあった) ----
  color: string
  onChangeColor: (c: string) => void
  lineStyle: LineStyle
  onChangeLineStyle: (s: LineStyle) => void
  widthPx: number
  onChangeWidth: (px: number) => void
}

export function OverviewLayerPanel({
  visibility,
  layers,
  hiddenLayers,
  onMoveLayer,
  onToggleLayer,
  currentLayer,
  onSelectLayer,
  onAddLayer,
  color,
  onChangeColor,
  lineStyle,
  onChangeLineStyle,
  widthPx,
  onChangeWidth,
}: Props) {
  const [newLayer, setNewLayer] = useState('')
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== '0'
    } catch {
      return true
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [open])

  if (!open) {
    return (
      <div className="shrink-0 border-r bg-white flex flex-col items-center py-2">
        <button
          onClick={() => setOpen(true)}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
          title="表示・レイヤのパネルを開く"
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
        <Layers className="h-4 w-4 text-slate-400 mt-2" />
      </div>
    )
  }

  return (
    <div className="shrink-0 w-52 border-r bg-white flex flex-col min-h-0">
      <div className="px-2 py-1.5 border-b flex items-center gap-1">
        <Layers className="h-4 w-4 text-slate-500" />
        <span className="text-xs font-semibold text-slate-700">表示とレイヤ</span>
        <button
          onClick={() => setOpen(false)}
          className="ml-auto p-1 rounded hover:bg-slate-100 text-slate-500"
          title="パネルを閉じる"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {/* 表示要素 */}
        <div className="p-2 border-b">
          <div className="text-[10px] text-slate-500 mb-1">表示する要素</div>
          {visibility.map((row) => (
            <label
              key={row.key}
              className="flex items-center gap-2 px-1 py-1 rounded hover:bg-slate-50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={row.on}
                onChange={(e) => row.set(e.target.checked)}
              />
              <span className="text-xs text-slate-700">{row.label}</span>
            </label>
          ))}
        </div>

        {/* 描画の共通設定。ここで決めた値が これから描くものに 付く */}
        <div className="p-2 border-b space-y-2">
          <div className="text-[10px] text-slate-500">描画の設定</div>

          <div>
            <div className="text-[10px] text-slate-500 mb-1">色</div>
            <div className="grid grid-cols-8 gap-1">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onChangeColor(c)}
                  className={`h-5 rounded border ${c === color ? 'ring-2 ring-blue-500' : ''}`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => onChangeColor(e.target.value)}
              className="w-full h-6 mt-1"
              title="カスタム色"
            />
          </div>

          <div>
            <div className="text-[10px] text-slate-500 mb-1">線種</div>
            <div className="flex gap-1">
              {(['solid', 'dashed', 'dotted'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => onChangeLineStyle(st)}
                  title={LINE_STYLE_LABEL[st]}
                  className={`flex-1 h-7 flex items-center justify-center rounded border ${
                    lineStyle === st
                      ? 'bg-blue-50 border-blue-400 text-blue-700'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <svg width="30" height="10" viewBox="0 0 30 10">
                    <line
                      x1="0"
                      y1="5"
                      x2="30"
                      y2="5"
                      stroke="currentColor"
                      strokeWidth={2}
                      strokeDasharray={LINE_STYLE_DASH[st]}
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
              <span>線幅</span>
              <span className="font-mono">{widthPx}px</span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={widthPx}
              onChange={(e) => onChangeWidth(Number(e.target.value))}
              className="w-full"
            />
          </div>
        </div>

        {/* レイヤ */}
        <div className="p-2">
          <div className="text-[10px] text-slate-500 mb-1">
            レイヤ (上ほど手前に描画)
          </div>
          {layers.map((layer, i) => {
            const isHidden = hiddenLayers.includes(layer)
            const isCurrent = layer === currentLayer
            return (
              <div
                key={layer}
                className={`flex items-center gap-1 px-1 py-1 rounded ${
                  isCurrent ? 'bg-blue-50' : 'hover:bg-slate-50'
                }`}
              >
                <button
                  onClick={() => onToggleLayer(layer)}
                  className={`p-0.5 rounded ${isHidden ? 'text-slate-300' : 'text-slate-600'}`}
                  title={isHidden ? '表示する' : '隠す'}
                >
                  {isHidden ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
                <button
                  onClick={() => onSelectLayer(layer)}
                  className={`flex-1 text-left text-xs truncate ${
                    isCurrent ? 'text-blue-700 font-semibold' : 'text-slate-700'
                  } ${isHidden ? 'line-through opacity-60' : ''}`}
                  title={
                    isCurrent
                      ? 'これから描くレイヤ'
                      : 'クリックすると、これから描くレイヤになります'
                  }
                >
                  {layer}
                </button>
                <button
                  onClick={() => onMoveLayer(layer, -1)}
                  disabled={i === 0}
                  className="p-0.5 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-25"
                  title="1 つ手前へ"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onMoveLayer(layer, 1)}
                  disabled={i === layers.length - 1}
                  className="p-0.5 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-25"
                  title="1 つ奥へ"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            )
          })}

          {onAddLayer && (
            <form
              className="flex items-center gap-1 mt-1"
              onSubmit={(e) => {
                e.preventDefault()
                const v = newLayer.trim()
                if (!v) return
                onAddLayer(v)
                setNewLayer('')
              }}
            >
              <input
                type="text"
                value={newLayer}
                onChange={(e) => setNewLayer(e.target.value)}
                placeholder="レイヤを追加"
                className="flex-1 min-w-0 h-7 px-1.5 border rounded text-xs font-mono"
              />
              <button
                type="submit"
                disabled={!newLayer.trim()}
                className="h-7 px-2 rounded border text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-30"
              >
                追加
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
