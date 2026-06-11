// 写真撮影枚数によるフィルタ。3 状態:
//   'all'     : すべての座標を表示
//   'with'    : 写真ありの座標のみ
//   'without' : 写真なしの座標のみ

import { useEffect, useRef, useState } from 'react'
import { Filter, ChevronDown, Check } from 'lucide-react'

export type PhotoCountFilter = 'all' | 'with' | 'without'

const OPTIONS: Array<{ value: PhotoCountFilter; label: string }> = [
  { value: 'all', label: 'すべて表示' },
  { value: 'with', label: '写真ありのみ' },
  { value: 'without', label: '写真なしのみ' },
]

interface Props {
  value: PhotoCountFilter
  onChange: (next: PhotoCountFilter) => void
  hoverClass?: string
  compact?: boolean
}

export function PhotoCountFilterButton({
  value,
  onChange,
  hoverClass = 'hover:bg-slate-50',
  compact = false,
}: Props) {
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

  const isActive = value !== 'all'
  const label = value === 'with' ? '有' : value === 'without' ? '無' : '全'

  return (
    <div className="relative inline-block align-middle" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="写真枚数でフィルタ"
        className={
          compact
            ? `inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] rounded border ${hoverClass} ${
                isActive
                  ? 'text-blue-700 border-blue-300 bg-blue-50'
                  : 'text-slate-400 border-slate-200'
              }`
            : `flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${hoverClass}`
        }
      >
        <Filter className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        {compact ? (
          <span>{label}</span>
        ) : (
          <>
            写真 ({OPTIONS.find((o) => o.value === value)?.label ?? ''})
            <ChevronDown className="h-3 w-3" />
          </>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-40 bg-white border rounded shadow-lg z-30 p-1">
          {OPTIONS.map((opt) => {
            const on = opt.value === value
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  onChange(opt.value)
                  setOpen(false)
                }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 text-xs rounded ${
                  on ? 'bg-blue-50 text-blue-800' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                <span
                  className={`flex items-center justify-center w-4 h-4 border rounded ${
                    on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'
                  }`}
                >
                  {on && <Check className="h-3 w-3" />}
                </span>
                <span>{opt.label}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
