// 会社共通の定型文集 (organization_report_snippets) の CRUD ビュー。
// 土地調査報告書 の以下の自由記述欄に挿入する 定型文を管理する:
//   * 06 原本結果確認         (category = 'original_check')
//   * 09 基本三角点等に基づく測量ができない理由 (category = 'no_triangulation_reason')
//   * 10 補足・特記事項        (category = 'remark')

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, Save } from 'lucide-react'
import { supabase } from '@/lib/supabase'

export type SnippetCategory =
  | 'original_check'
  | 'no_triangulation_reason'
  | 'remark'

export const SNIPPET_CATEGORY_LABEL: Record<SnippetCategory, string> = {
  original_check: '原本確認結果',
  no_triangulation_reason: '基本三角点測量ができない理由',
  remark: '補足・特記事項',
}

interface SnippetRow {
  id: string
  organization_id: string
  category: SnippetCategory
  label: string
  body: string
  sort_order: number
  created_at: string
  updated_at: string
}

interface Props {
  organizationId: string
  /** true のとき CRUD 可能 */
  editable: boolean
}

interface EditableRow {
  id: string
  category: SnippetCategory
  label: string
  body: string
  sortOrder: number
  dirty: boolean
  isNew: boolean
}

const toEditable = (r: SnippetRow): EditableRow => ({
  id: r.id,
  category: r.category,
  label: r.label,
  body: r.body,
  sortOrder: r.sort_order,
  dirty: false,
  isNew: false,
})

export function OrgReportSnippetsView({ organizationId, editable }: Props) {
  const [rows, setRows] = useState<EditableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [activeCategory, setActiveCategory] = useState<SnippetCategory>('original_check')

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('organization_report_snippets')
      .select('*')
      .eq('organization_id', organizationId)
      .order('category')
      .order('sort_order')
      .order('created_at')
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    setRows(((data ?? []) as SnippetRow[]).map(toEditable))
    setLoading(false)
  }, [organizationId])

  useEffect(() => {
    void reload()
  }, [reload])

  const filtered = useMemo(
    () => rows.filter((r) => r.category === activeCategory),
    [rows, activeCategory],
  )
  const hasDirty = useMemo(() => rows.some((r) => r.dirty || r.isNew), [rows])

  const patchRow = (id: string, patch: Partial<EditableRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, ...patch, dirty: true } : r)),
    )
  }

  const addRow = () => {
    if (!editable) return
    const tempId = `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setRows((prev) => [
      ...prev,
      {
        id: tempId,
        category: activeCategory,
        label: '',
        body: '',
        sortOrder: filtered.length,
        dirty: true,
        isNew: true,
      },
    ])
  }

  const removeRow = async (id: string) => {
    if (!editable) return
    const row = rows.find((r) => r.id === id)
    if (!row) return
    if (row.isNew) {
      setRows((prev) => prev.filter((r) => r.id !== id))
      return
    }
    if (!confirm(`「${row.label || '(ラベル未設定)'}」 を削除しますか?`)) return
    const { error: err } = await supabase
      .from('organization_report_snippets')
      .delete()
      .eq('id', id)
    if (err) {
      alert(`削除に失敗しました: ${err.message}`)
      return
    }
    setRows((prev) => prev.filter((r) => r.id !== id))
  }

  const saveAll = async () => {
    if (!editable) return
    setSaving(true)
    setError(null)
    try {
      for (const r of rows) {
        if (!r.dirty && !r.isNew) continue
        if (!r.label.trim()) throw new Error('ラベル は 必須です')
        if (!r.body.trim()) throw new Error('本文 は 必須です')
        if (r.isNew) {
          const { error: err } = await supabase
            .from('organization_report_snippets')
            .insert({
              organization_id: organizationId,
              category: r.category,
              label: r.label.trim(),
              body: r.body,
              sort_order: r.sortOrder,
            } as never)
          if (err) throw err
        } else {
          const { error: err } = await supabase
            .from('organization_report_snippets')
            .update({
              label: r.label.trim(),
              body: r.body,
              sort_order: r.sortOrder,
            } as never)
            .eq('id', r.id)
          if (err) throw err
        }
      }
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3">
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <h3 className="text-sm font-semibold text-slate-700">定型文</h3>
        <span className="text-xs text-slate-500">
          土地調査報告書 の自由記述欄で 挿入できる定型文を 会社共通で登録。
        </span>
        {editable && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
              title={`「${SNIPPET_CATEGORY_LABEL[activeCategory]}」 に追加`}
            >
              <Plus className="h-3.5 w-3.5" />
              追加
            </button>
            <button
              type="button"
              onClick={saveAll}
              disabled={!hasDirty || saving}
              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              保存
            </button>
          </div>
        )}
      </div>

      {/* カテゴリタブ */}
      <div className="flex gap-1 border-b mb-2">
        {(Object.keys(SNIPPET_CATEGORY_LABEL) as SnippetCategory[]).map((c) => {
          const active = activeCategory === c
          const count = rows.filter((r) => r.category === c).length
          return (
            <button
              key={c}
              type="button"
              onClick={() => setActiveCategory(c)}
              className={`px-3 py-1.5 text-xs border-b-2 -mb-px whitespace-nowrap ${
                active
                  ? 'border-blue-600 text-blue-700 font-medium'
                  : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              {SNIPPET_CATEGORY_LABEL[c]} ({count})
            </button>
          )
        })}
      </div>

      {error && (
        <div className="mb-2 px-2 py-1 text-xs bg-red-50 text-red-700 border border-red-200 rounded">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-slate-400 text-xs">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> 読み込み中…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-xs text-slate-400 py-4">
          このカテゴリに定型文はまだ登録されていません。
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((r) => (
            <div
              key={r.id}
              className={`border rounded p-2 ${r.dirty || r.isNew ? 'bg-amber-50 border-amber-300' : 'bg-white'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <input
                  type="text"
                  value={r.label}
                  onChange={(e) => patchRow(r.id, { label: e.target.value })}
                  disabled={!editable}
                  className="flex-1 px-2 py-1 text-xs border rounded font-medium disabled:bg-slate-50"
                  placeholder="定型文のラベル (一覧表示用)"
                />
                {editable && (
                  <button
                    type="button"
                    onClick={() => void removeRow(r.id)}
                    className="p-1 text-red-500 hover:bg-red-50 rounded"
                    title="削除"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <textarea
                value={r.body}
                onChange={(e) => patchRow(r.id, { body: e.target.value })}
                disabled={!editable}
                rows={3}
                className="w-full px-2 py-1 text-xs border rounded font-mono disabled:bg-slate-50"
                placeholder="挿入される本文"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
