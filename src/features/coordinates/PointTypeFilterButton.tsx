// 点種フィルター ボタン + ドロップダウン。
// 座標管理画面と地番管理画面の両方で共有。状態は mapViewStore に乗るので、
// どちらの画面で操作しても両画面の表に・地図に反映される。

import { useEffect, useRef, useState } from 'react'
import { Filter, ChevronDown, Settings, Check } from 'lucide-react'
import { useMapViewStore } from '@/stores/mapViewStore'

export interface PointTypeOption {
  code: string
  label: string
  builtIn: boolean
}

interface Props {
  /** 表示候補（既定 + プロジェクトのカスタム点種）。typeOptions を呼び出し側で構築 */
  typeOptions: PointTypeOption[]
  /** Settings 歯車押下時。点種管理モーダルを開く。未指定なら歯車を出さない */
  onOpenManageModal?: () => void
  /** ボタンの見た目用 hover クラス（ツールバーの背景と揃える） */
  hoverClass?: string
  /** 表ヘッダ等の狭い場所に収める時のコンパクト表示。フィルタ Icon と件数のみ */
  compact?: boolean
}

export function PointTypeFilterButton({
  typeOptions,
  onOpenManageModal,
  hoverClass = 'hover:bg-slate-50',
  compact = false,
}: Props) {
  const visibleTypes = useMapViewStore((s) => s.visibleTypes)
  const setVisibleTypes = useMapViewStore((s) => s.setVisibleTypes)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 外側クリックで閉じる
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  // 「(空)」= 点種未指定の座標もフィルタ対象に含めるため、選択肢の先頭に
  // 仮想エントリを差し込む。値は空文字列。
  const effectiveOptions: PointTypeOption[] = [
    { code: '', label: '(空)', builtIn: true },
    ...typeOptions,
  ]
  const isAllOn = visibleTypes.size === effectiveOptions.length
  return (
    <div className="relative inline-block align-middle" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="点種でフィルタ（表と地図の両方）"
        className={
          compact
            ? `inline-flex items-center gap-0.5 px-1 py-0.5 text-[10px] rounded border ${hoverClass} ${
                isAllOn ? 'text-slate-400 border-slate-200' : 'text-blue-700 border-blue-300 bg-blue-50'
              }`
            : `flex items-center gap-1 px-3 py-1.5 text-sm border rounded ${hoverClass}`
        }
      >
        <Filter className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        {compact ? (
          <span className="font-mono">{visibleTypes.size}/{effectiveOptions.length}</span>
        ) : (
          <>
            点種フィルター ({visibleTypes.size}/{effectiveOptions.length})
            <ChevronDown className="h-3 w-3" />
          </>
        )}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-64 bg-white border rounded shadow-lg z-40 p-2">
          <div className="flex items-center justify-between mb-2 pb-2 border-b">
            <span className="text-xs font-medium text-slate-600">表示する点種</span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setVisibleTypes(new Set(effectiveOptions.map((o) => o.code)))}
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全選択
              </button>
              <button
                type="button"
                onClick={() =>
                  setVisibleTypes(new Set(effectiveOptions[0] ? [effectiveOptions[0].code] : []))
                }
                className="text-[10px] px-1.5 py-0.5 border rounded hover:bg-slate-50"
              >
                全解除
              </button>
              {onOpenManageModal && (
                <button
                  type="button"
                  onClick={() => {
                    onOpenManageModal()
                    setOpen(false)
                  }}
                  title="点種を管理（追加/編集）"
                  className="ml-1 p-0.5 text-slate-500 hover:text-slate-800 rounded"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="space-y-0.5 max-h-72 overflow-auto">
            {effectiveOptions.map((opt) => {
              const on = visibleTypes.has(opt.code)
              return (
                <button
                  key={opt.code}
                  type="button"
                  onClick={() => {
                    const next = new Set(visibleTypes)
                    if (next.has(opt.code)) next.delete(opt.code)
                    else next.add(opt.code)
                    if (next.size === 0) return
                    setVisibleTypes(next)
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
                  <span>{opt.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
