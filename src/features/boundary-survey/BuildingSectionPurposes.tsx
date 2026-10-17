// 01 登記 の 目的。 申請番号 ごと に 事件名 (チェック 複数) + 変更/更正。

import { Plus, Trash2 } from 'lucide-react'
import type {
  BuildingPurposeRow,
  BuildingReportBody,
} from '@/stores/buildingReportStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

const EVENT_LABELS: { key: keyof BuildingPurposeRow['events']; label: string }[] = [
  { key: 'title',                   label: '表題' },
  { key: 'loss',                    label: '滅失' },
  { key: 'titleSection',            label: '表題部（所在・種類・構造・床面積・附属建物）' },
  { key: 'split',                   label: '分割' },
  { key: 'merge',                   label: '合併' },
  { key: 'combine',                 label: '合体' },
  { key: 'floorPlanCorrection',     label: '建物図面訂正' },
  { key: 'eachFloorPlanCorrection', label: '各階平面図訂正' },
  { key: 'other',                   label: 'その他' },
]

function emptyRow(appNo: number): BuildingPurposeRow {
  return {
    appNo,
    changeType: { change: false, correction: false },
    events: {
      title: false, loss: false, titleSection: false, split: false,
      merge: false, combine: false, floorPlanCorrection: false,
      eachFloorPlanCorrection: false, other: false, otherText: '',
    },
  }
}

export function BuildingSectionPurposes({ body, onChange }: Props) {
  const rows = body.purposes
  const setRows = (next: BuildingPurposeRow[]) => onChange({ purposes: next })

  const addRow = () => setRows([...rows, emptyRow(rows.length + 1)])
  const removeRow = (idx: number) =>
    setRows(rows.filter((_, i) => i !== idx).map((r, i) => ({ ...r, appNo: i + 1 })))
  const patchRow = (idx: number, patch: Partial<BuildingPurposeRow>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  return (
    <div className="p-3 space-y-2">
      {rows.length === 0 && (
        <div className="text-xs text-slate-500">
          申請ごとに「登記の目的」を 1 行追加してください。
        </div>
      )}
      {rows.map((r, idx) => (
        <div key={idx} className="border rounded p-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">申請番号</span>
            <span className="px-2 py-0.5 bg-slate-100 rounded text-sm font-mono">
              {r.appNo}
            </span>
            <button
              type="button"
              onClick={() => removeRow(idx)}
              className="ml-auto p-1 text-red-600 hover:bg-red-50 rounded"
              title="削除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {EVENT_LABELS.map((e) => (
              <label key={e.key} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={r.events[e.key] as boolean}
                  onChange={(ev) =>
                    patchRow(idx, {
                      events: { ...r.events, [e.key]: ev.target.checked },
                    })
                  }
                />
                <span>{e.label}</span>
              </label>
            ))}
          </div>
          {r.events.other && (
            <input
              type="text"
              value={r.events.otherText}
              onChange={(e) =>
                patchRow(idx, {
                  events: { ...r.events, otherText: e.target.value },
                })
              }
              placeholder="その他の内容"
              className="w-full px-2 py-1 text-xs border rounded"
            />
          )}
          <div className="flex items-center gap-3 pt-1 border-t">
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={r.changeType.change}
                onChange={(ev) =>
                  patchRow(idx, {
                    changeType: { ...r.changeType, change: ev.target.checked },
                  })
                }
              />
              <span>変更</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={r.changeType.correction}
                onChange={(ev) =>
                  patchRow(idx, {
                    changeType: { ...r.changeType, correction: ev.target.checked },
                  })
                }
              />
              <span>更正</span>
            </label>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" /> 申請を追加
      </button>
    </div>
  )
}
