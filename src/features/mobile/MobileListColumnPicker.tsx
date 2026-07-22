// スマホの 座標 / 地番 一覧パネルで使う「表示列」設定モーダル。
// チェックボックスで各列の表示/非表示を切替。requiredKey は常に ON で固定表示。

import { X, Settings2 } from 'lucide-react'

export interface ColumnDef<K extends string> {
  key: K
  label: string
}

interface Props<K extends string> {
  title: string
  columns: ReadonlyArray<ColumnDef<K>>
  /** 常に表示 (チェック不可、灰色表示) の必須列 */
  requiredKeys: ReadonlyArray<K>
  visible: ReadonlySet<K>
  onChange: (next: ReadonlySet<K>) => void
  onClose: () => void
}

export function MobileListColumnPicker<K extends string>({
  title,
  columns,
  requiredKeys,
  visible,
  onChange,
  onClose,
}: Props<K>) {
  const required = new Set<K>(requiredKeys)
  const toggle = (k: K) => {
    if (required.has(k)) return
    const next = new Set(visible)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    onChange(next)
  }
  const allOn = () => {
    onChange(new Set(columns.map((c) => c.key)))
  }
  const onlyRequired = () => {
    onChange(new Set(requiredKeys))
  }
  return (
    <div
      className="fixed inset-0 z-[3200] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-xs max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Settings2 className="h-4 w-4 text-slate-500" />
            {title}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>
        <div className="flex-1 overflow-auto py-1">
          {columns.map((c) => {
            const isRequired = required.has(c.key)
            const isOn = isRequired || visible.has(c.key)
            return (
              <label
                key={c.key}
                className={`flex items-center gap-2 px-4 py-2 text-sm border-b ${
                  isRequired
                    ? 'text-slate-400 cursor-not-allowed'
                    : 'text-slate-700 cursor-pointer hover:bg-slate-50'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  disabled={isRequired}
                  onChange={() => toggle(c.key)}
                />
                <span className="flex-1">{c.label}</span>
                {isRequired && (
                  <span className="text-[10px] text-slate-400">(必須)</span>
                )}
              </label>
            )
          })}
        </div>
        <div className="px-4 py-2 border-t flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onlyRequired}
            className="text-xs px-2 py-1 border rounded hover:bg-slate-50"
          >
            必須のみ
          </button>
          <button
            type="button"
            onClick={allOn}
            className="text-xs px-2 py-1 border rounded hover:bg-slate-50"
          >
            全表示
          </button>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            OK
          </button>
        </div>
      </div>
    </div>
  )
}
