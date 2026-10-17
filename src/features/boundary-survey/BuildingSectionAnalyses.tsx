// 06 資料・証言・事実等 の 分析。 既定 で 2 行 (敷地 の 権利/形状、 建物 の 権利関係) を 入れる。

import { Plus, Trash2 } from 'lucide-react'
import type {
  BuildingAnalysisRow,
  BuildingReportBody,
} from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

function emptyRow(appNo: number): BuildingAnalysisRow {
  return { appNo, materialRange: '', item: '', result: '' }
}

export function BuildingSectionAnalyses({ body, onChange }: Props) {
  const rows = body.analyses
  const setRows = (next: BuildingAnalysisRow[]) => onChange({ analyses: next })

  const addRow = () => setRows([...rows, emptyRow(1)])
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx))
  const patchRow = (idx: number, patch: Partial<BuildingAnalysisRow>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  const addDefaults = () => {
    setRows([
      ...rows,
      { appNo: 1, materialRange: '1-3', item: '●敷地の権利、形状に関する事項', result: '' },
      { appNo: 1, materialRange: '4-7', item: '●建物の権利関係及び表示に関する事項', result: '' },
    ])
  }

  return (
    <div className="p-3 space-y-2">
      <table className="w-full text-xs border-collapse">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-1 py-1 border w-12 text-left">申請</th>
            <th className="px-1 py-1 border w-20 text-left">資料等番号</th>
            <th className="px-1 py-1 border text-left min-w-[14rem]">調査項目</th>
            <th className="px-1 py-1 border text-left">調査結果及び報告事項</th>
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
                  type="text"
                  value={r.materialRange}
                  onChange={(e) => patchRow(idx, { materialRange: e.target.value })}
                  placeholder="1-3"
                  className="w-full px-1 py-0.5 text-xs border rounded font-mono"
                />
              </td>
              <td className="px-1 py-0.5 border">
                <input
                  type="text"
                  value={r.item}
                  onChange={(e) => patchRow(idx, { item: e.target.value })}
                  className="w-full px-1 py-0.5 text-xs border rounded"
                />
              </td>
              <td className="px-1 py-0.5 border">
                <textarea
                  value={r.result}
                  onChange={(e) => patchRow(idx, { result: e.target.value })}
                  rows={2}
                  className="w-full px-1 py-0.5 text-xs border rounded"
                />
              </td>
              <td className="px-1 py-0.5 border text-center">
                <button
                  type="button"
                  onClick={() => removeRow(idx)}
                  className="p-0.5 text-red-600 hover:bg-red-50 rounded"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        >
          <Plus className="h-3.5 w-3.5" /> 行追加
        </button>
        {rows.length === 0 && (
          <button
            type="button"
            onClick={addDefaults}
            className="px-2 py-1 text-xs border rounded hover:bg-slate-50 text-slate-500"
          >
            既定の 2 項目を入れる
          </button>
        )}
      </div>
    </div>
  )
}
