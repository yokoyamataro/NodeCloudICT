// 全体図の左パネル。表示要素とレイヤをここで一括管理する。
//
// ・表示要素 … 測点 / 地番 / 暗渠配線 / カメラ / メモ / ペイント の表示切替
// ・レイヤ   … ペイントのレイヤ。表示切替 + 並べ替え + 「これから描くレイヤ」の選択
//
// 並び順は そのまま 描画順になる。一覧で 上にあるレイヤほど 地図でも 上に出る。
// 順序と表示状態は 工区ごとに localStorage へ持つ (この端末での見え方の設定)。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, Layers, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { DEFAULT_LAYERS } from '@/stores/mapDrawingStore'

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
}

export function OverviewLayerPanel({
  visibility,
  layers,
  hiddenLayers,
  onMoveLayer,
  onToggleLayer,
  currentLayer,
  onSelectLayer,
}: Props) {
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
        </div>
      </div>
    </div>
  )
}
