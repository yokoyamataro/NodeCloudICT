// 座標一覧 の 上 に 出す 「表示列」 の ボタン と 一覧。
// 選んだ 内容 の 出し入れ は coordinateColumns.ts に 置く。

import { useEffect, useRef, useState } from 'react'
import { Check, Columns3 } from 'lucide-react'
import {
  COORD_COLUMN_KEYS,
  COORD_COLUMN_LABELS,
  DEFAULT_COORD_COLUMNS,
  type CoordColumnKey,
} from './coordinateColumns'

export function CoordinateColumnPicker({
  visible,
  onChange,
  className,
}: {
  visible: Set<CoordColumnKey>
  onChange: (next: Set<CoordColumnKey>) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const toggle = (key: CoordColumnKey) => {
    const next = new Set(visible)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    onChange(next)
  }

  return (
    <div className={`relative ${className ?? ''}`} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50"
        title="表示する列を選ぶ"
      >
        <Columns3 className="h-3.5 w-3.5" />
        表示列
        <span className="text-slate-400">
          {visible.size}/{COORD_COLUMN_KEYS.length}
        </span>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-48 bg-white border rounded shadow-lg z-40">
          <div className="flex items-center gap-1 px-2 py-1 border-b bg-slate-50">
            <button
              type="button"
              onClick={() => onChange(new Set(COORD_COLUMN_KEYS))}
              className="px-2 py-0.5 text-[11px] border rounded hover:bg-white"
            >
              全部
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="px-2 py-0.5 text-[11px] border rounded hover:bg-white"
            >
              点番号のみ
            </button>
            <button
              type="button"
              onClick={() => onChange(new Set(DEFAULT_COORD_COLUMNS))}
              className="ml-auto px-2 py-0.5 text-[11px] border rounded hover:bg-white"
            >
              既定
            </button>
          </div>
          <ul className="max-h-72 overflow-auto py-1">
            <li className="flex items-center gap-2 px-3 py-1 text-xs text-slate-400">
              <Check className="h-3.5 w-3.5" />
              点番号（常に表示）
            </li>
            {COORD_COLUMN_KEYS.map((k) => (
              <li key={k}>
                <button
                  type="button"
                  onClick={() => toggle(k)}
                  className="w-full flex items-center gap-2 px-3 py-1 text-xs hover:bg-slate-50"
                >
                  <Check
                    className={`h-3.5 w-3.5 ${
                      visible.has(k) ? 'text-blue-600' : 'text-transparent'
                    }`}
                  />
                  {COORD_COLUMN_LABELS[k]}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
