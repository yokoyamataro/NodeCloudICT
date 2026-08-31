// 全体図の左パネル。地図に出るものを 1 つの一覧で まとめて 管理する。
//
// 一覧には 2 種類が 混ざる:
//   ・組み込み要素 … 測点 / 地番 / 暗渠配線 / カメラ / メモ
//   ・ペイントのレイヤ … 現況 / 建物 / 道路 / 計画 / 自分で足したもの
// どちらも 目のアイコンで 表示を 切り替え、▲▼ で 並べ替える。
// 並び順が そのまま 描画順になる (上にあるほど 地図でも 手前)。
//
// ペイントのレイヤは 名前を クリックすると「これから描くレイヤ」になる。
//
// 順序と表示状態は 工区ごとに localStorage へ持つ (この端末での見え方の設定)。
// 描画の設定 (色 / 線種 / 線幅) も ここに置く。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronUp, Eye, EyeOff, Layers, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import {
  DEFAULT_LAYERS,
  FRAME_LAYER,
  type ArrowStyle,
  type LineStyle,
} from '@/stores/mapDrawingStore'

/**
 * 端部のスタイル見本。線だけ / 矢印付き を 短い線で 見せる。
 * side は どちらの端かで、矢印の 向きが 変わる。
 */
function EndStyleSvg({
  head,
  side,
  size = 22,
}: {
  head: boolean
  side: 'start' | 'end'
  size?: number
}) {
  // 始点は 左向き、終点は 右向き
  const tip = side === 'start' ? 3 : 21
  const back = side === 'start' ? 9 : 15
  return (
    <svg width={size} height={16} viewBox="0 0 24 16" aria-hidden="true">
      <line x1="3" y1="8" x2="21" y2="8" stroke="currentColor" strokeWidth={1.8} />
      {head && <polygon points={`${tip},8 ${back},4 ${back},12`} fill="currentColor" />}
    </svg>
  )
}

/** 端部の矢印を 始点 / 終点 それぞれの 有無から 組み立てる */
function combineArrow(start: boolean, end: boolean): ArrowStyle {
  if (start && end) return 'both'
  if (start) return 'start'
  if (end) return 'end'
  return 'none'
}

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

/** 組み込み要素 (測点 / 地番 / …) 1 つ分 */
export interface ElementRow {
  key: string
  label: string
  on: boolean
  set: (v: boolean) => void
}

/** 一覧の 1 行。組み込み要素か、ペイントのレイヤか */
type Row =
  | { kind: 'element'; id: string; element: ElementRow }
  | { kind: 'layer'; id: string; layer: string }

/** 組み込み要素は "el:" を付けて レイヤ名と 区別する */
const ELEMENT_PREFIX = 'el:'
export const elementRowId = (key: string) => `${ELEMENT_PREFIX}${key}`

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
 * 一覧の並び順と、レイヤの表示状態。
 *
 * 一覧には 組み込み要素 (el:points …) と ペイントのレイヤ名が 混ざる。
 * 保存済みの順序を 先頭に置き、そこに 無いもの (新しく使われ始めたレイヤ、
 * 追加された組み込み要素) を 後ろに 付ける。
 *
 * 組み込み要素の 表示/非表示は 呼び出し側の state (ElementRow.on) が持つので、
 * ここで 覚えるのは ペイントのレイヤの分だけ。
 */
export function useLayerOrder(
  farmId: string,
  presentLayers: string[],
  elementKeys: string[],
) {
  const [order, setOrder] = useState<string[]>(() => readList(ORDER_KEY(farmId)))
  const [hidden, setHidden] = useState<string[]>(() => readList(HIDDEN_KEY(farmId)))

  // 工区が変わったら読み直す
  useEffect(() => {
    setOrder(readList(ORDER_KEY(farmId)))
    setHidden(readList(HIDDEN_KEY(farmId)))
  }, [farmId])

  /** 一覧に出す ID の並び (組み込み要素は el: 付き) */
  const ids = useMemo(() => {
    const all = new Set<string>([
      ...elementKeys.map(elementRowId),
      ...DEFAULT_LAYERS,
      ...presentLayers,
    ])
    const out = order.filter((l) => all.has(l))
    // 保存済みの並びに 無いものを 後ろへ。図枠は 既定で 一番下 (奥) に置く
    // (並べ替え自体は 他と 同じように できる)
    for (const l of all) if (!out.includes(l) && l !== FRAME_LAYER) out.push(l)
    if (all.has(FRAME_LAYER) && !out.includes(FRAME_LAYER)) out.push(FRAME_LAYER)
    return out
  }, [order, presentLayers, elementKeys])

  /** ペイントのレイヤだけを 上から順に 取り出したもの (描画順に使う) */
  const layerOrder = useMemo(
    () => ids.filter((id) => !id.startsWith(ELEMENT_PREFIX)),
    [ids],
  )

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      const next = [...ids]
      const i = next.indexOf(id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= next.length) return
      ;[next[i], next[j]] = [next[j], next[i]]
      setOrder(next)
      writeList(ORDER_KEY(farmId), next)
    },
    [ids, farmId],
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

  return { ids, layerOrder, hidden, move, toggleHidden }
}

interface Props {
  /** 一覧に出す ID の並び (上ほど手前)。組み込み要素は el: 付き */
  ids: string[]
  /** 組み込み要素の定義。key で引く */
  elements: ElementRow[]
  /** 非表示にしているペイントのレイヤ */
  hiddenLayers: string[]
  onMove: (id: string, dir: -1 | 1) => void
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
  /** 線の端部の矢印 */
  arrow: ArrowStyle
  onChangeArrow: (a: ArrowStyle) => void
  /** 選択中の 作図要素の 数。0 なら「これから描くもの」の設定として働く */
  selectedCount: number
  /** 図枠のように 色 / 線種 / 線幅を 使わない 道具の間は 設定ごと 隠す */
  hideStyleSettings?: boolean
}

export function OverviewLayerPanel({
  ids,
  elements,
  hiddenLayers,
  onMove,
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
  arrow,
  onChangeArrow,
  selectedCount,
  hideStyleSettings = false,
}: Props) {
  const [newLayer, setNewLayer] = useState('')
  const elementByKey = useMemo(
    () => new Map(elements.map((e) => [elementRowId(e.key), e])),
    [elements],
  )
  const rows = useMemo<Row[]>(
    () =>
      ids.map((id) => {
        const el = elementByKey.get(id)
        return el ? { kind: 'element', id, element: el } : { kind: 'layer', id, layer: id }
      }),
    [ids, elementByKey],
  )
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
        {/* 描画の共通設定。ここで決めた値が これから描くものに 付く。
            図枠のように 見た目が 固定の 道具の間は まるごと 隠す */}
        {!hideStyleSettings && (
        <div className="p-2 border-b space-y-2">
          <div className="text-[10px] text-slate-500">
            {selectedCount > 0 ? (
              <span className="text-blue-700 font-semibold">
                選択中の {selectedCount} 個に適用
              </span>
            ) : (
              '描画の設定 (これから描くもの)'
            )}
          </div>

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

          <div>
            <div className="text-[10px] text-slate-500 mb-1">端部</div>
            <div className="flex gap-1">
              {(
                [
                  ['start', '始点', arrow === 'start' || arrow === 'both'],
                  ['end', '終点', arrow === 'end' || arrow === 'both'],
                ] as const
              ).map(([side, label, hasHead]) => (
                <button
                  key={side}
                  type="button"
                  onClick={() => {
                    // 押すたびに その端の 矢印を 入れ替える
                    const s2 = side === 'start' ? !hasHead : arrow === 'start' || arrow === 'both'
                    const e2 = side === 'end' ? !hasHead : arrow === 'end' || arrow === 'both'
                    onChangeArrow(combineArrow(s2, e2))
                  }}
                  title={`${label}: ${hasHead ? '矢印' : '線'} (押すと切替)`}
                  className={`flex-1 h-7 flex items-center justify-center rounded border ${
                    hasHead
                      ? 'bg-blue-50 border-blue-400 text-blue-700'
                      : 'border-slate-300 text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  <EndStyleSvg head={hasHead} side={side} />
                </button>
              ))}
            </div>
          </div>
        </div>
        )}

        {/* 地図に出るものの一覧。組み込み要素と ペイントのレイヤが 混ざる */}
        <div className="p-2">
          <div className="text-[10px] text-slate-500 mb-1">レイヤ (上ほど手前に描画)</div>
          {rows.map((row, i) => {
            const isElement = row.kind === 'element'
            const el = isElement ? row.element : null
            const visible = isElement ? (el?.on ?? true) : !hiddenLayers.includes(row.id)
            const isCurrent = !isElement && row.id === currentLayer
            const label = isElement ? (el?.label ?? row.id) : row.id
            return (
              <div
                key={row.id}
                className={`flex items-center gap-1 px-1 py-1 rounded ${
                  isCurrent ? 'bg-blue-50' : 'hover:bg-slate-50'
                }`}
              >
                <button
                  onClick={() =>
                    isElement ? el?.set(!visible) : onToggleLayer(row.id)
                  }
                  className={`p-0.5 rounded ${visible ? 'text-slate-600' : 'text-slate-300'}`}
                  title={visible ? '隠す' : '表示する'}
                >
                  {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                </button>
                {isElement ? (
                  <span
                    className={`flex-1 text-xs truncate text-slate-500 ${
                      visible ? '' : 'line-through opacity-60'
                    }`}
                    title="地図の組み込み要素"
                  >
                    {label}
                  </span>
                ) : (
                  <button
                    onClick={() => onSelectLayer(row.id)}
                    className={`flex-1 text-left text-xs truncate ${
                      isCurrent ? 'text-blue-700 font-semibold' : 'text-slate-700'
                    } ${visible ? '' : 'line-through opacity-60'}`}
                    title={
                      selectedCount > 0
                        ? `クリックすると、選択中の ${selectedCount} 個をこのレイヤへ移します`
                        : isCurrent
                          ? 'これから描くレイヤ'
                          : 'クリックすると、これから描くレイヤになります'
                    }
                  >
                    {label}
                  </button>
                )}
                <button
                  onClick={() => onMove(row.id, -1)}
                  disabled={i === 0}
                  className="p-0.5 rounded text-slate-500 hover:bg-slate-100 disabled:opacity-25"
                  title="1 つ手前へ"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onMove(row.id, 1)}
                  disabled={i === rows.length - 1}
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
