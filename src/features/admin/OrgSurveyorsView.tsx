// 組織に所属する 土地家屋調査士 (organization_surveyors) の CRUD ビュー。
// AdminOrganizationsPage / OrgAdminUnifiedView の下部タブで使う。
//
// 権限:
//   * SELECT: 組織メンバー全員 (RLS ポリシーで許可)
//   * CRUD  : 組織 admin のみ (RLS ポリシーで許可)

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Trash2, Save } from 'lucide-react'
import { supabase } from '@/lib/supabase'

interface SurveyorRow {
  id: string
  organization_id: string
  name: string
  registration_no: string | null
  office_name: string | null
  phone_no: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

interface Props {
  organizationId: string
  /** true のとき CRUD 可能 (組織 admin)。false のときは 読取専用 */
  editable: boolean
}

// 編集中の行を保持する型 (id が新規行は 'new-...' の一時 ID)
interface EditableRow {
  id: string
  name: string
  registrationNo: string
  officeName: string
  phoneNo: string
  sortOrder: number
  dirty: boolean
  isNew: boolean
}

const toEditable = (r: SurveyorRow): EditableRow => ({
  id: r.id,
  name: r.name,
  registrationNo: r.registration_no ?? '',
  officeName: r.office_name ?? '',
  phoneNo: r.phone_no ?? '',
  sortOrder: r.sort_order,
  dirty: false,
  isNew: false,
})

export function OrgSurveyorsView({ organizationId, editable }: Props) {
  const [rows, setRows] = useState<EditableRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error: err } = await supabase
      .from('organization_surveyors')
      .select('*')
      .eq('organization_id', organizationId)
      .order('sort_order')
      .order('created_at')
    if (err) {
      setError(err.message)
      setLoading(false)
      return
    }
    setRows(((data ?? []) as SurveyorRow[]).map(toEditable))
    setLoading(false)
  }, [organizationId])

  useEffect(() => {
    void reload()
  }, [reload])

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
        name: '',
        registrationNo: '',
        officeName: '',
        phoneNo: '',
        sortOrder: prev.length,
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
      // 未保存の新規行は 単純に UI から削除
      setRows((prev) => prev.filter((r) => r.id !== id))
      return
    }
    if (!confirm(`「${row.name || '(名前未設定)'}」 を削除しますか?`)) return
    const { error: err } = await supabase
      .from('organization_surveyors')
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
        if (!r.name.trim()) {
          throw new Error('調査士名 は 必須です')
        }
        if (r.isNew) {
          const { error: err } = await supabase
            .from('organization_surveyors')
            .insert({
              organization_id: organizationId,
              name: r.name.trim(),
              registration_no: r.registrationNo.trim() || null,
              office_name: r.officeName.trim() || null,
              phone_no: r.phoneNo.trim() || null,
              sort_order: r.sortOrder,
            } as never)
          if (err) throw err
        } else {
          const { error: err } = await supabase
            .from('organization_surveyors')
            .update({
              name: r.name.trim(),
              registration_no: r.registrationNo.trim() || null,
              office_name: r.officeName.trim() || null,
              phone_no: r.phoneNo.trim() || null,
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
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-sm font-semibold text-slate-700">土地家屋調査士</h3>
        <span className="text-xs text-slate-500">
          報告書ヘッダで選択できる調査士セット。氏名を選ぶと 登録番号・所属会・電話番号 が自動で入る。
        </span>
        {editable && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
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

      {error && (
        <div className="mb-2 px-2 py-1 text-xs bg-red-50 text-red-700 border border-red-200 rounded">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-6 text-slate-400 text-xs">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> 読み込み中…
        </div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-slate-400 py-4">
          まだ登録されていません。
          {editable && '「追加」から 土地家屋調査士を登録してください。'}
        </div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-2 py-1.5 text-left border">調査士名</th>
              <th className="px-2 py-1.5 text-left border">登録番号</th>
              <th className="px-2 py-1.5 text-left border">所属調査士会</th>
              <th className="px-2 py-1.5 text-left border">電話番号</th>
              {editable && <th className="w-10 border"></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={r.dirty || r.isNew ? 'bg-amber-50' : ''}>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.name}
                    onChange={(e) => patchRow(r.id, { name: e.target.value })}
                    disabled={!editable}
                    className="w-full px-1.5 py-1 border rounded bg-white disabled:bg-slate-50"
                    placeholder="横山 太郎"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.registrationNo}
                    onChange={(e) => patchRow(r.id, { registrationNo: e.target.value })}
                    disabled={!editable}
                    className="w-full px-1.5 py-1 border rounded bg-white disabled:bg-slate-50"
                    placeholder="342"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.officeName}
                    onChange={(e) => patchRow(r.id, { officeName: e.target.value })}
                    disabled={!editable}
                    className="w-full px-1.5 py-1 border rounded bg-white disabled:bg-slate-50"
                    placeholder="釧路土地家屋調査士会所属"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.phoneNo}
                    onChange={(e) => patchRow(r.id, { phoneNo: e.target.value })}
                    disabled={!editable}
                    className="w-full px-1.5 py-1 border rounded bg-white disabled:bg-slate-50"
                    placeholder="0152-23-1311"
                  />
                </td>
                {editable && (
                  <td className="text-center border">
                    <button
                      type="button"
                      onClick={() => void removeRow(r.id)}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
