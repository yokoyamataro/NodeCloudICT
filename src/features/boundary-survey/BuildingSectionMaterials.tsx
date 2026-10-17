// 05 調査資料・証言・事実等。
// 登記所資料 / 官公署等資料 / その他 の 事実等 の 3 グループ で チェック。
// 必要 なら 行 の 追加 (「その他」 を 複数) も できる。

import { Plus, Trash2 } from 'lucide-react'
import type {
  BuildingMaterialRow,
  BuildingReportBody,
} from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

const GROUP_LABELS: Record<BuildingMaterialRow['group'], string> = {
  registry: '登記所資料',
  public: '官公署等資料',
  other: 'その他の事実等',
}

export function BuildingSectionMaterials({ body, onChange }: Props) {
  const rows = body.materials
  const setRows = (next: BuildingMaterialRow[]) => onChange({ materials: next })

  const patchRow = (id: string, patch: Partial<BuildingMaterialRow>) =>
    setRows(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const removeRow = (id: string) => setRows(rows.filter((r) => r.id !== id))

  const addRow = (group: BuildingMaterialRow['group']) => {
    const nid = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    setRows([...rows, { id: nid, group, no: '', name: '', checked: false }])
  }

  return (
    <div className="p-3 space-y-3">
      {(['registry', 'public', 'other'] as const).map((g) => (
        <div key={g} className="border rounded">
          <div className="px-2 py-1 bg-slate-50 border-b flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700">{GROUP_LABELS[g]}</span>
            <button
              type="button"
              onClick={() => addRow(g)}
              className="flex items-center gap-0.5 px-1.5 py-0.5 text-[11px] border rounded hover:bg-white"
            >
              <Plus className="h-3 w-3" /> 行追加
            </button>
          </div>
          <table className="w-full text-xs border-collapse">
            <thead className="bg-white">
              <tr>
                <th className="px-1 py-0.5 border w-14 text-left">資料等番号</th>
                <th className="px-1 py-0.5 border text-left">資料等名</th>
                <th className="px-1 py-0.5 border w-10 text-center">チェック</th>
                <th className="px-1 py-0.5 border w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.filter((r) => r.group === g).map((r) => (
                <tr key={r.id}>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.no}
                      onChange={(e) => patchRow(r.id, { no: e.target.value })}
                      className="w-full px-1 py-0.5 text-xs border rounded text-center font-mono"
                    />
                  </td>
                  <td className="px-1 py-0.5 border">
                    <input
                      type="text"
                      value={r.name}
                      onChange={(e) => patchRow(r.id, { name: e.target.value })}
                      className="w-full px-1 py-0.5 text-xs border rounded"
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-center">
                    <input
                      type="checkbox"
                      checked={r.checked}
                      onChange={(e) => patchRow(r.id, { checked: e.target.checked })}
                    />
                  </td>
                  <td className="px-1 py-0.5 border text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(r.id)}
                      className="p-0.5 text-red-600 hover:bg-red-50 rounded"
                      title="削除"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <label className="block">
        <span className="block text-xs text-slate-600 mb-1">原本結果確認 (自由文)</span>
        <textarea
          value={body.originalConfirmNote}
          onChange={(e) => onChange({ originalConfirmNote: e.target.value })}
          rows={2}
          className="w-full px-2 py-1 text-xs border rounded"
        />
      </label>
    </div>
  )
}
