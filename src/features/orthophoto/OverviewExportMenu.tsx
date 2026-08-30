// 全体図の書き出しをまとめたメニュー。
//
// ヘッダを無くして地図を広く使う方針にしたので、書き出し系はここへ集約する。
// 種類が増えても行を足すだけで済むようにしてある。

import { useEffect, useRef, useState } from 'react'
import { BookImage, ChevronDown, Download, FileDown } from 'lucide-react'

export interface ExportItem {
  key: string
  label: string
  /** 補足 (件数など)。無くてもよい */
  hint?: string
  icon: 'dxf' | 'photobook'
  disabled?: boolean
  onSelect: () => void
}

const ICONS = {
  dxf: FileDown,
  photobook: BookImage,
}

export function OverviewExportMenu({ items }: { items: ExportItem[] }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  return (
    <div ref={rootRef} className="relative shrink-0 flex items-stretch">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="書き出し"
        className={`h-8 pl-2 pr-1 flex items-center gap-0.5 rounded border ${
          open
            ? 'bg-slate-100 border-slate-400 text-slate-800'
            : 'border-slate-300 text-slate-600 hover:bg-slate-100'
        }`}
      >
        <Download className="h-4 w-4" />
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-[3000] bg-white border rounded shadow-lg py-1 min-w-[11rem]">
          <div className="px-3 py-1 text-[10px] text-slate-500">書き出し</div>
          {items.map((it) => {
            const Icon = ICONS[it.icon]
            return (
              <button
                key={it.key}
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  it.onSelect()
                  setOpen(false)
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 text-left">{it.label}</span>
                {it.hint && <span className="text-[10px] text-slate-400">{it.hint}</span>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
