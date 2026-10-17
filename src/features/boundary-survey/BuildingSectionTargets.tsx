// 02 調査 した 建物。 申請番号 ごと に 1 行。 所在地番 / 家屋番号 / 種類 / 構造 / 床面積 等。

import { Plus, Trash2 } from 'lucide-react'
import type {
  BuildingTargetRow,
  BuildingReportBody,
} from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

function emptyRow(appNo: number): BuildingTargetRow {
  return {
    appNo,
    location: '',
    houseNumber: '',
    mainSubType: '',
    kind: '',
    structure: '',
    floorArea: null,
    thirdPartyRight: null,
    siteRight: '',
  }
}

export function BuildingSectionTargets({ body, onChange }: Props) {
  const rows = body.targets
  const setRows = (next: BuildingTargetRow[]) => onChange({ targets: next })

  const addRow = () => setRows([...rows, emptyRow(rows.length + 1)])
  const removeRow = (idx: number) =>
    setRows(rows.filter((_, i) => i !== idx).map((r, i) => ({ ...r, appNo: i + 1 })))
  const patchRow = (idx: number, patch: Partial<BuildingTargetRow>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  return (
    <div className="p-3 space-y-2">
      {rows.length === 0 && (
        <div className="text-xs text-slate-500">
          調査した建物を 1 棟ずつ追加してください (表題登記以外は申請前の状況)。
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs border-collapse">
          <thead className="bg-slate-50">
            <tr>
              <th className="px-1 py-1 border w-12 text-left">申請</th>
              <th className="px-1 py-1 border text-left min-w-[12rem]">所在地番</th>
              <th className="px-1 py-1 border w-20 text-left">家屋番号</th>
              <th className="px-1 py-1 border w-24 text-left">主附/符号</th>
              <th className="px-1 py-1 border w-20 text-left">種類</th>
              <th className="px-1 py-1 border text-left min-w-[9rem]">構造</th>
              <th className="px-1 py-1 border w-20 text-right">床面積㎡</th>
              <th className="px-1 py-1 border w-24 text-left">第三者権利</th>
              <th className="px-1 py-1 border text-left min-w-[9rem]">敷地利用権限</th>
              <th className="px-1 py-1 border w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx}>
                <td className="px-1 py-0.5 border font-mono text-center">{r.appNo}</td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.location}
                    onChange={(e) => patchRow(idx, { location: e.target.value })}
                    className="w-full px-1 py-0.5 text-xs border rounded"
                    placeholder="例: 標津郡中標津町東十条南九丁目1番地7"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.houseNumber}
                    onChange={(e) => patchRow(idx, { houseNumber: e.target.value })}
                    className="w-full px-1 py-0.5 text-xs border rounded"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.mainSubType}
                    onChange={(e) => patchRow(idx, { mainSubType: e.target.value })}
                    className="w-full px-1 py-0.5 text-xs border rounded"
                    placeholder="主 / 附 1 等"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.kind}
                    onChange={(e) => patchRow(idx, { kind: e.target.value })}
                    className="w-full px-1 py-0.5 text-xs border rounded"
                    placeholder="居宅"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.structure}
                    onChange={(e) => patchRow(idx, { structure: e.target.value })}
                    className="w-full px-1 py-0.5 text-xs border rounded"
                    placeholder="木造ソーラーパネルふき平家建"
                  />
                </td>
                <td className="px-1 py-0.5 border text-right">
                  <input
                    type="number"
                    step="0.01"
                    value={r.floorArea ?? ''}
                    onChange={(e) =>
                      patchRow(idx, {
                        floorArea: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                    className="w-full px-1 py-0.5 text-xs border rounded text-right font-mono"
                  />
                </td>
                <td className="px-1 py-0.5 border">
                  <select
                    value={
                      r.thirdPartyRight === null ? '' : r.thirdPartyRight ? 'yes' : 'no'
                    }
                    onChange={(e) =>
                      patchRow(idx, {
                        thirdPartyRight:
                          e.target.value === '' ? null : e.target.value === 'yes',
                      })
                    }
                    className="w-full px-1 py-0.5 text-xs border rounded bg-white"
                  >
                    <option value="">—</option>
                    <option value="yes">有</option>
                    <option value="no">無</option>
                  </select>
                </td>
                <td className="px-1 py-0.5 border">
                  <input
                    type="text"
                    value={r.siteRight}
                    onChange={(e) => patchRow(idx, { siteRight: e.target.value })}
                    className="w-full px-1 py-0.5 text-xs border rounded"
                    placeholder="自己所有地 / 借地 等"
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
      </div>
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" /> 建物を追加
      </button>
    </div>
  )
}
