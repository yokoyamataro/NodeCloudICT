// 地番属性 (parcel_attribute_types) の管理モーダル。
// 組み込み (対象地/隣接地/道路/河川/その他) の label / color は編集可、削除不可。
// ユーザー任意属性の追加 (code + label + color) と削除も可能。
//
// 呼び出し: 地番管理タブヘッダ (BoundarySurveyWorkAreaPage) の「属性管理」ボタン。

import { useEffect, useState } from 'react'
import { Loader2, Plus, Trash2, X } from 'lucide-react'
import { useParcelAttributeTypesStore } from '@/stores/parcelAttributeTypesStore'
import type { ParcelAttributeType } from '@/types/database'

interface Props {
  projectId: string
  onClose: () => void
}

export function ParcelAttributeTypesModal({ projectId, onClose }: Props) {
  const attributes = useParcelAttributeTypesStore(
    (s) => s.byProject.get(projectId) ?? [],
  )
  const fetchForProject = useParcelAttributeTypesStore((s) => s.fetchForProject)
  const createAttribute = useParcelAttributeTypesStore((s) => s.createAttribute)
  const updateAttribute = useParcelAttributeTypesStore((s) => s.updateAttribute)
  const deleteAttribute = useParcelAttributeTypesStore((s) => s.deleteAttribute)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 新規追加フォーム
  const [newCode, setNewCode] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newColor, setNewColor] = useState('#22c55e')

  useEffect(() => {
    void fetchForProject(projectId)
  }, [projectId, fetchForProject])

  const commitEdit = async (
    id: string,
    patch: Partial<Pick<ParcelAttributeType, 'label' | 'color'>>,
  ) => {
    setBusy(true)
    setErr(null)
    try {
      await updateAttribute(id, patch)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleAdd = async () => {
    const code = newCode.trim()
    const label = newLabel.trim()
    if (!code || !label) {
      setErr('コードとラベルは必須です')
      return
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
      setErr('コードは半角英数字 / _ / - のみで指定してください (例: farm_land)')
      return
    }
    setBusy(true)
    setErr(null)
    try {
      const created = await createAttribute(projectId, {
        code,
        label,
        color: newColor,
        sort_order: 100 + attributes.length,
      })
      if (!created) throw new Error('作成に失敗しました (コード重複?)')
      setNewCode('')
      setNewLabel('')
      setNewColor('#22c55e')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (a: ParcelAttributeType) => {
    if (a.is_builtin) return
    if (!confirm(`属性「${a.label}」を削除しますか？\n（この属性を使用中の地番は「未選択」になります）`)) return
    setBusy(true)
    setErr(null)
    try {
      await deleteAttribute(a.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[3200] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="text-sm font-semibold">地番属性の管理</div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-3">
          {err && (
            <div className="p-2 text-xs bg-red-50 text-red-700 border border-red-200 rounded">
              {err}
            </div>
          )}

          <div className="text-[11px] text-slate-500 leading-relaxed">
            組み込み属性 (対象地 / 隣接地 / 道路 / 河川 / その他) はラベルと色を変更できますが削除はできません。
            任意コードで追加した属性は削除可能です。
          </div>

          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-500 border-b">
                <th className="text-left py-1 pl-1">コード</th>
                <th className="text-left py-1">ラベル</th>
                <th className="text-left py-1">色</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {attributes.map((a) => (
                <tr key={a.id} className="border-b">
                  <td className="py-1 pl-1 font-mono text-slate-600">
                    {a.code}
                    {a.is_builtin && (
                      <span className="ml-1 text-[9px] text-slate-400">
                        (組込)
                      </span>
                    )}
                  </td>
                  <td className="py-1">
                    <input
                      type="text"
                      defaultValue={a.label}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (!v || v === a.label) return
                        void commitEdit(a.id, { label: v })
                      }}
                      className="w-full px-1 py-0.5 border rounded"
                    />
                  </td>
                  <td className="py-1">
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        defaultValue={a.color}
                        onBlur={(e) => {
                          const v = e.target.value
                          if (v === a.color) return
                          void commitEdit(a.id, { color: v })
                        }}
                        className="w-8 h-6 p-0 border rounded"
                      />
                      <span className="font-mono text-slate-500">{a.color}</span>
                    </div>
                  </td>
                  <td className="py-1 text-center">
                    {!a.is_builtin && (
                      <button
                        type="button"
                        onClick={() => void handleDelete(a)}
                        disabled={busy}
                        className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-40"
                        title="削除"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 新規追加 */}
          <div className="border-t pt-3 space-y-2">
            <div className="text-xs font-semibold text-slate-700">属性を追加</div>
            <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
              <input
                type="text"
                placeholder="コード (英数)"
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                className="px-2 py-1 text-xs border rounded font-mono"
              />
              <input
                type="text"
                placeholder="ラベル (表示名)"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                className="px-2 py-1 text-xs border rounded"
              />
              <input
                type="color"
                value={newColor}
                onChange={(e) => setNewColor(e.target.value)}
                className="w-8 h-6 p-0 border rounded"
              />
              <button
                type="button"
                onClick={() => void handleAdd()}
                disabled={busy || !newCode.trim() || !newLabel.trim()}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                追加
              </button>
            </div>
          </div>
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-end">
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
