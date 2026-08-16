// 各 セクション UI で 共通に使う 小さな部品。
//   * CheckboxLabel: ■/□ をトグルするラベル付きチェックボックス
//   * SnippetPickerButton: 定型文を選んで textarea に挿入するドロップダウン
//   * SectionRowButtons: 行の 追加/削除 ボタン
//   * FieldLabel: ラベル + 入力欄の縦積み用

import { Plus, Trash2, ChevronDown, BookMarked, History } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { supabase } from '@/lib/supabase'
import { useOrganizationSnippets } from './useOrganizationSnippets'
import type { SnippetCategory } from '@/features/admin/OrgReportSnippetsView'
import {
  ReportHistoryPickerModal,
  type ReportHistoryField,
} from './ReportHistoryPickerModal'

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
  /** 定型文 / 履歴を選んだ時の 挿入ハンドラ */
  onInsert: (body: string) => void
  /** 現在の本文 (「定型句として登録」に使う) — 空なら 登録ボタン disabled */
  currentText?: string
  /** 履歴取込対象の フィールド名 (省略なら 履歴ボタン非表示) */
  historyField?: ReportHistoryField
  /** 履歴取込のモーダルタイトル (デフォルト: "報告書履歴") */
  historyTitle?: string
}

export function SnippetPickerButton({
  category,
  onInsert,
  currentText,
  historyField,
  historyTitle,
}: SnippetPickerProps) {
  const { snippets, loading, organizationId } = useOrganizationSnippets(category)
  const [open, setOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveLabel, setSaveLabel] = useState('')
  const [saving, setSaving] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  const trimmedCurrent = (currentText ?? '').trim()

  const handleSaveSnippet = async () => {
    if (!organizationId || !trimmedCurrent || !saveLabel.trim()) return
    setSaving(true)
    try {
      await supabase.from('organization_report_snippets').insert({
        organization_id: organizationId,
        category,
        label: saveLabel.trim(),
        body: trimmedCurrent,
        sort_order: snippets.length,
      } as never)
      setSaveOpen(false)
      setSaveLabel('')
      // ページを再読込せず 状態を更新: 一旦フックの再取得を頼るため、
      // 次回開いた時に反映される。
    } catch {
      // ignore
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="inline-flex items-center gap-1 relative">
      <div className="relative inline-block">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
          disabled={loading}
          title="定型文から挿入"
        >
          定型文から挿入 <ChevronDown className="h-3 w-3" />
        </button>
        {open && (
          <div
            className="absolute z-10 right-0 mt-1 min-w-64 max-w-96 max-h-72 overflow-auto bg-white border rounded shadow-lg"
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

      {/* 定型句として登録 */}
      <button
        type="button"
        onClick={() => {
          setSaveLabel('')
          setSaveOpen(true)
        }}
        disabled={!organizationId || trimmedCurrent === ''}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-40"
        title="現在の内容を 定型句として 組織に登録"
      >
        <BookMarked className="h-3 w-3" /> 定型句として登録
      </button>

      {/* 過去報告書から取り込み */}
      {historyField && (
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
          title="過去の報告書から この項目を 取り込み"
        >
          <History className="h-3 w-3" /> 履歴から取り込み
        </button>
      )}

      {/* 定型句登録モーダル */}
      {saveOpen && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="border-b px-4 py-3 text-sm font-semibold">
              定型句として登録
            </div>
            <div className="p-4 space-y-3">
              <div>
                <div className="text-xs text-slate-500 mb-1">ラベル (一覧表示用)</div>
                <input
                  type="text"
                  value={saveLabel}
                  onChange={(e) => setSaveLabel(e.target.value)}
                  placeholder="例: 標準文言"
                  className="w-full px-2 py-1.5 text-sm border rounded"
                  autoFocus
                />
              </div>
              <div>
                <div className="text-xs text-slate-500 mb-1">本文 (現在の内容)</div>
                <div className="p-2 bg-slate-50 border rounded text-xs whitespace-pre-wrap max-h-40 overflow-auto">
                  {trimmedCurrent}
                </div>
              </div>
            </div>
            <div className="border-t px-4 py-3 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setSaveOpen(false)}
                className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={() => void handleSaveSnippet()}
                disabled={!saveLabel.trim() || saving}
                className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? '登録中…' : '登録'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 履歴取込モーダル */}
      {historyOpen && historyField && (
        <ReportHistoryPickerModal
          field={historyField}
          title={historyTitle ?? '報告書履歴'}
          onCancel={() => setHistoryOpen(false)}
          onConfirm={(body) => {
            onInsert(body)
            setHistoryOpen(false)
          }}
        />
      )}
    </div>
  )
}
