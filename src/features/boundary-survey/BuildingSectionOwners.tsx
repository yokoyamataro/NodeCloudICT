// 03 所有権登記名義人等。 申請番号 ごと に N 名、 名義人 の 住所 / 氏名 / 本人確認 /
// 持分 / 連絡先。 地権者 一覧 (landownerStore) から 選んで 自動入力 も できる。

import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type {
  BuildingOwnerRow,
  BuildingReportBody,
} from '@/stores/buildingReportStore'
import { useLandownerStore } from '@/stores/landownerStore'

interface Props {
  body: BuildingReportBody
  onChange: (patch: Partial<BuildingReportBody>) => void
}

function emptyRow(appNo: number): BuildingOwnerRow {
  return {
    appNo,
    address: '',
    name: '',
    idMethod: null,
    idMethodOther: '',
    ownership: null,
    ownershipShare: '',
    contact: '',
    landownerId: null,
  }
}

export function BuildingSectionOwners({ body, onChange }: Props) {
  const rows = body.owners
  const setRows = (next: BuildingOwnerRow[]) => onChange({ owners: next })

  const landowners = useLandownerStore((s) => s.landowners)
  const landownerOptions = useMemo(
    () =>
      landowners
        .map((l) => ({ id: l.id, name: l.full_name, address: l.address ?? '', phone: l.phone ?? '' }))
        .filter((l) => l.name.trim() !== ''),
    [landowners],
  )

  const addRow = () => {
    // appNo は 直前 の 行 と 同じ (同 申請番号 の 共有名義人) を 既定 に
    const prev = rows.length > 0 ? rows[rows.length - 1].appNo : 1
    setRows([...rows, emptyRow(prev)])
  }
  const removeRow = (idx: number) => setRows(rows.filter((_, i) => i !== idx))
  const patchRow = (idx: number, patch: Partial<BuildingOwnerRow>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)))

  const applyLandowner = (idx: number, id: string) => {
    const o = landownerOptions.find((x) => x.id === id)
    if (!o) return
    patchRow(idx, {
      landownerId: o.id,
      name: o.name,
      address: o.address,
      contact: o.phone,
    })
  }

  return (
    <div className="p-3 space-y-2">
      {rows.length === 0 && (
        <div className="text-xs text-slate-500">
          名義人を 1 名ずつ追加してください (共有名義人は同じ申請番号で複数行)。
        </div>
      )}
      {rows.map((r, idx) => (
        <div key={idx} className="border rounded p-2 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-500">申請番号</span>
            <input
              type="number"
              min="1"
              value={r.appNo}
              onChange={(e) => patchRow(idx, { appNo: Math.max(1, Number(e.target.value) || 1) })}
              className="w-14 px-1 py-0.5 text-xs border rounded font-mono text-center"
            />
            {landownerOptions.length > 0 && (
              <>
                <span className="text-xs text-slate-500 ml-2">地権者から</span>
                <select
                  value=""
                  onChange={(e) => {
                    applyLandowner(idx, e.target.value)
                    e.currentTarget.value = ''
                  }}
                  className="px-1 py-0.5 text-xs border rounded bg-white"
                >
                  <option value="">— 選択で自動入力 —</option>
                  {landownerOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </>
            )}
            <button
              type="button"
              onClick={() => removeRow(idx)}
              className="ml-auto p-1 text-red-600 hover:bg-red-50 rounded"
              title="削除"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="block text-[11px] text-slate-500">住所 (登記記録と異なる場合)</span>
              <input
                type="text"
                value={r.address}
                onChange={(e) => patchRow(idx, { address: e.target.value })}
                className="w-full px-1.5 py-1 text-xs border rounded"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-slate-500">氏名</span>
              <input
                type="text"
                value={r.name}
                onChange={(e) => patchRow(idx, { name: e.target.value })}
                className="w-full px-1.5 py-1 text-xs border rounded"
              />
            </label>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] text-slate-500">本人確認方法</span>
            {([
              ['license', '運転免許証'],
              ['idcard', '個人番号カード'],
              ['meishiki', '面識有り'],
              ['other', 'その他'],
            ] as const).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name={`idm-${idx}`}
                  checked={r.idMethod === k}
                  onChange={() => patchRow(idx, { idMethod: k })}
                />
                {label}
              </label>
            ))}
            {r.idMethod === 'other' && (
              <input
                type="text"
                value={r.idMethodOther}
                onChange={(e) => patchRow(idx, { idMethodOther: e.target.value })}
                placeholder="その他の方法"
                className="px-1.5 py-0.5 text-xs border rounded"
              />
            )}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-[11px] text-slate-500">持分</span>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                name={`ow-${idx}`}
                checked={r.ownership === 'single'}
                onChange={() => patchRow(idx, { ownership: 'single' })}
              />
              単有
            </label>
            <label className="flex items-center gap-1 text-xs">
              <input
                type="radio"
                name={`ow-${idx}`}
                checked={r.ownership === 'joint'}
                onChange={() => patchRow(idx, { ownership: 'joint' })}
              />
              共有
            </label>
            {r.ownership === 'joint' && (
              <input
                type="text"
                value={r.ownershipShare}
                onChange={(e) => patchRow(idx, { ownershipShare: e.target.value })}
                placeholder="持分10分の9"
                className="px-1.5 py-0.5 text-xs border rounded"
              />
            )}
          </div>
          <label className="block">
            <span className="block text-[11px] text-slate-500">連絡先 (電話番号等)</span>
            <input
              type="text"
              value={r.contact}
              onChange={(e) => patchRow(idx, { contact: e.target.value })}
              className="w-full px-1.5 py-1 text-xs border rounded"
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
      >
        <Plus className="h-3.5 w-3.5" /> 名義人を追加
      </button>
    </div>
  )
}
