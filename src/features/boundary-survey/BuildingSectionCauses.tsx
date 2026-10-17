// 04 登記 原因 及び その 日付。 申請番号 ごと に 原因日付 / 原因 / 判断理由。

import { Plus, Trash2 } from 'lucide-react'
import type {
  BuildingCauseRow,
  BuildingReportBody,
} from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

function emptyRow(appNo: number): BuildingCauseRow {
  return { appNo, causeDate: '', cause: '', reason: '' }
}

export function BuildingSectionCauses({ body, onChange }: Props) {
  const rows = body.causes
  const setRows = (next: BuildingCauseRow[]) => onChange({ causes: next })

  const addRow = () => setRows([...rows, emptyRow(rows.length + 1)])
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx))
  const patchRow = (idx: number, patch: Partial<BuildingCauseRow>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  return (
    <div className="p-3 space-y-2">
      <table className="w-full text-xs border-collapse">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-1 py-1 border w-12 text-left">申請</th>
            <th className="px-1 py-1 border w-32 text-left">原因日付</th>
            <th className="px-1 py-1 border w-28 text-left">原因</th>
            <th className="px-1 py-1 border text-left">判断理由</th>
            <th className="px-1 py-1 border w-8" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx}>
              <td className="px-1 py-0.5 border">
                <input
                  type="number"
                  min="1"
                  value={r.appNo}
                  onChange={(e) =>
                    patchRow(idx, { appNo: Math.max(1, Number(e.target.value) || 1) })
                  }
                  className="w-full px-1 py-0.5 text-xs border rounded font-mono text-center"
                />
              </td>
              <td className="px-1 py-0.5 border">
                <input
                  type="date"
                  value={r.causeDate}
                  onChange={(e) => patchRow(idx, { causeDate: e.target.value })}
                  className="w-full px-1 py-0.5 text-xs border rounded"
                />
              </td>
              <td className="px-1 py-0.5 border">
                <input
                  type="text"
                  value={r.cause}
                  onChange={(e) => patchRow(idx, { cause: e.target.value })}
                  placeholder="新築 / 増築 等"
                  className="w-full px-1 py-0.5 text-xs border rounded"
                />
              </td>
              <td className="px-1 py-0.5 border">
                <input
                  type="text"
                  value={r.reason}
                  onChange={(e) => patchRow(idx, { reason: e.target.value })}
                  placeholder="工事完了引渡証明書の記載により判断した。"
                  className="w-full px-1 py-0.5 text-xs border rounded"
                />
              </td>
              <td className="px-1 py-0.5 border text-center">
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
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
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" /> 原因を追加
      </button>
    </div>
  )
}
