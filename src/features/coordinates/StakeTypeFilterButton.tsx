// 杭種フィルター。プリセット (木杭 / コンクリート杭 / ...) + 既に登録済みの
// カスタム値 + 「未設定」 から多選択する。表ローカルの state なので
// mapViewStore には乗せず、呼び出し側で値を保持する。

import { useEffect, useRef, useState } from 'react'
import { Filter, ChevronDown, Check } from 'lucide-react'

export interface StakeTypeFilterOption {
  /** 内部値: '' は未設定、それ以外は杭種文字列 */
  code: string
  label: string
}

interface Props {
  options: StakeTypeFilterOption[]
  visible: Set<string>
  onChange: (next: Set<string>) => void
  hoverClass?: string
  compact?: boolean
}

export function StakeTypeFilterButton({
  options,
  visible,
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

  const isAllOn = visible.size === options.length

  return (
    <div className="relative inline-block align-middle" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="杭種でフィルタ"
        className={
          compact
            ? `inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] rounded border ${hoverClass} ${
                isAllOn
                  ? 'text-slate-400 border-slate-200'
                  : 'text-blue-700 border-blue-300 bg-blue-50'
              }`
            : `flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${hoverClass}`
        }
      >
        <Filter className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        {compact ? (
          <span className="font-mono">
            {visible.size}/{options.length}
          </span>
        ) : (
          <>
            杭種 ({visible.size}/{options.length})
            <ChevronDown className="h-3 w-3" />
          </>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-white border rounded shadow-lg z-40 p-2">
          <div className="flex items-center justify-between mb-2 pb-2 border-b">
            <span className="text-xs font-medium text-slate-600">表示する杭種</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onChange(new Set(options.map((o) => o.code)))}
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全選択
              </button>
              <button
                type="button"
                onClick={() =>
                  onChange(new Set(options[0] ? [options[0].code] : []))
                }
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全解除
              </button>
            </div>
          </div>
          <div className="space-y-0.5 max-h-72 overflow-auto">
            {options.map((opt) => {
              const on = visible.has(opt.code)
              return (
                <button
                  key={opt.code || '__empty__'}
                  type="button"
                  onClick={() => {
                    const next = new Set(visible)
                    if (next.has(opt.code)) next.delete(opt.code)
                    else next.add(opt.code)
                    if (next.size === 0) return
                    onChange(next)
                  }}
                  className={`w-full flex items-center gap-2 px-2 py-1 text-xs rounded ${
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
                  <span className={opt.code === '' ? 'text-slate-400 italic' : ''}>
                    {opt.label}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
