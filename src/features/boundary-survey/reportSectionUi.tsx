// 各 セクション UI で 共通に使う 小さな部品。
//   * CheckboxLabel: ■/□ をトグルするラベル付きチェックボックス
//   * SnippetPickerButton: 定型文を選んで textarea に挿入するドロップダウン
//   * SectionRowButtons: 行の 追加/削除 ボタン
//   * FieldLabel: ラベル + 入力欄の縦積み用

import { Plus, Trash2, ChevronDown } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { useOrganizationSnippets } from './useOrganizationSnippets'
import type { SnippetCategory } from '@/features/admin/OrgReportSnippetsView'

interface CheckboxLabelProps {
  checked: boolean
  onChange: (v: boolean) => void
  children: ReactNode
  disabled?: boolean
}

export function CheckboxLabel({ checked, onChange, children, disabled }: CheckboxLabelProps) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs cursor-pointer select-none">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        disabled={disabled}
        className="h-3.5 w-3.5"
      />
      <span>{children}</span>
    </label>
  )
}

interface RadioGroupProps<T extends string> {
  value: T | null
  onChange: (v: T | null) => void
  options: { value: T; label: string }[]
  name: string
  allowNull?: boolean
}

export function RadioGroup<T extends string>({
  value,
  onChange,
  options,
  name,
  allowNull = true,
}: RadioGroupProps<T>) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {options.map((o) => (
        <label key={o.value} className="inline-flex items-center gap-1 text-xs cursor-pointer">
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
            className="h-3.5 w-3.5"
          />
          {o.label}
        </label>
      ))}
      {allowNull && value !== null && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-[10px] text-slate-400 hover:text-slate-600"
        >
          解除
        </button>
      )}
    </div>
  )
}

interface FieldProps {
  label: string
  children: ReactNode
  className?: string
}

export function Field({ label, children, className = '' }: FieldProps) {
  return (
    <div className={className}>
      <div className="text-[11px] text-slate-500 mb-0.5">{label}</div>
      {children}
    </div>
  )
}

interface RowButtonsProps {
  onAdd?: () => void
  onDelete?: () => void
  addLabel?: string
}

export function RowButtons({ onAdd, onDelete, addLabel = '行を追加' }: RowButtonsProps) {
  return (
    <div className="flex items-center gap-2">
      {onAdd && (
        <button
          type="button"
          onClick={onAdd}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        >
          <Plus className="h-3 w-3" /> {addLabel}
        </button>
      )}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-red-500 hover:bg-red-50 rounded"
          title="削除"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

interface SnippetPickerProps {
  category: SnippetCategory
  onInsert: (body: string) => void
}

export function SnippetPickerButton({ category, onInsert }: SnippetPickerProps) {
  const { snippets, loading } = useOrganizationSnippets(category)
  const [open, setOpen] = useState(false)

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        disabled={loading}
      >
        定型文から挿入 <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div
          className="absolute z-10 mt-1 min-w-64 max-w-96 max-h-72 overflow-auto bg-white border rounded shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {snippets.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">
              登録された定型文はありません
            </div>
          ) : (
            snippets.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onInsert(s.body)
                  setOpen(false)
                }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 border-b last:border-b-0"
              >
                <div className="font-medium">{s.label}</div>
                <div className="text-slate-500 text-[10px] whitespace-pre-wrap line-clamp-3">
                  {s.body}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
