// 地図 左下 に 置く レイヤ 表示 切替 ボタン。 クリック で ポップアップ パネル を 開き、
// 要素 の 表示 / 非表示 を トグル する。
//
// 使い方:
//   <MapLayerControl layers={[
//     { key: 'points.underdrain', label: '暗渠点' },
//     { key: 'pipes', label: '暗渠配線' },
//     { key: 'channels', label: '線形物' },
//   ]} />
//
// 配置: Leaflet 地図 コンテナ の absolute left-2 bottom-16 (法務省地図 ボタン の 上) に 固定。
// z-index は Leaflet コントロール と 競合 し ない よう 1000 以上 に 置く。

import { useEffect, useRef, useState } from 'react'
import { Layers, Eye, EyeOff } from 'lucide-react'
import { useMapLayersStore } from '@/stores/mapLayersStore'

export interface MapLayerDef {
  /** mapLayersStore の キー */
  key: string
  /** 表示名 */
  label: string
  /** インデント (サブ要素 として 階層 表示 したい 場合) */
  indent?: number
}

export interface MapLayerSection {
  /** セクション 見出し (任意) */
  title?: string
  layers: MapLayerDef[]
}

interface Props {
  /** 単純 な レイヤ 配列 (単一 セクション として 表示) */
  layers?: MapLayerDef[]
  /** セクション 分け し たい 場合 */
  sections?: MapLayerSection[]
  /** 既定 の 配置 (left-2 bottom-16) を 上書き したい ページ 用 */
  className?: string
}

export function MapLayerControl({ layers, sections, className }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // 外側 クリック で 閉じる
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const resolvedSections: MapLayerSection[] = sections ?? [
    { layers: layers ?? [] },
  ]

  return (
    <div
      ref={rootRef}
      className={
        className ??
        'absolute left-2 bottom-16 z-[1000] leaflet-layer-control'
      }
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-9 w-9 flex items-center justify-center bg-white border border-slate-300 rounded shadow hover:bg-slate-50"
        title="表示する要素を切り替え"
      >
        <Layers className="h-4 w-4 text-slate-700" />
      </button>
      {open && (
        <div
          className="absolute left-0 bottom-11 min-w-[180px] max-w-[260px] bg-white border border-slate-300 rounded shadow-lg py-1"
          onWheel={(e) => e.stopPropagation()}
        >
          {resolvedSections.map((sec, si) => (
            <div key={si} className={si > 0 ? 'border-t mt-1 pt-1' : ''}>
              {sec.title && (
                <div className="px-2 py-0.5 text-[10px] font-medium text-slate-500 uppercase tracking-wide">
                  {sec.title}
                </div>
              )}
              {sec.layers.map((l) => (
                <LayerRow key={l.key} layer={l} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function LayerRow({ layer }: { layer: MapLayerDef }) {
  const visible = useMapLayersStore((s) => s.visibility[layer.key] !== false)
  const toggle = useMapLayersStore((s) => s.toggle)
  return (
    <button
      type="button"
      onClick={() => toggle(layer.key)}
      className="w-full flex items-center gap-2 px-2 py-1 text-xs hover:bg-slate-50 text-left"
      style={{ paddingLeft: 8 + (layer.indent ?? 0) * 12 }}
    >
      {visible ? (
        <Eye className="h-3.5 w-3.5 text-emerald-600" />
      ) : (
        <EyeOff className="h-3.5 w-3.5 text-slate-400" />
      )}
      <span className={visible ? 'text-slate-800' : 'text-slate-400'}>
        {layer.label}
      </span>
    </button>
  )
}
