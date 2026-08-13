// 03 所有権登記名義人 (立会人ブロック込)
//   * 1 行 = 1 名義人。所有地 (parcels の複数筆) を 左に並べる。
//   * 「地権者から選択して取り込み」で 地権者を選ぶと、
//     その地権者に割当済みの parcels のうち、02 で登録済みのものを 自動で parcelIndexes に反映。
//   * 立会人 (代理人) 情報も 地権者データから 反映。

import { useState } from 'react'
import { Trash2, ListChecks, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from '@/stores/farmStore'
import type { LandReportBody, ReportOwnerRow } from '@/stores/landReportStore'
import { RadioGroup, Field } from './reportSectionUi'
import { LandownerPickerModal, type PickableLandowner } from './LandownerPickerModal'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyOwner = (): ReportOwnerRow => ({
  parcelIndexes: [],
  landownerId: null,
  address: '',
  name: '',
  idMethod: null,
  idMethodOther: '',
  ownership: null,
  ownershipShare: '',
  contact: '',
  attendee: {
    address: '',
    name: '',
    idMethod: null,
    idMethodOther: '',
    relation: null,
    relationDetail: '',
    contact: '',
    remark: '',
  },
})

/** landowner.agent_relation の 自由文を できるだけ enum に寄せる */
const guessRelation = (
  raw: string | null,
): 'family' | 'manager' | 'representative' | 'other' | null => {
  if (!raw) return null
  if (raw.includes('家族') || raw.includes('親族')) return 'family'
  if (raw.includes('管理')) return 'manager'
  if (raw.includes('代理')) return 'representative'
  return 'other'
}

export function ReportSectionOwners({ body, onChange }: Props) {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFor, setPickerFor] = useState<number | null>(null) // 既存行の差替用

  const owners = body.owners
  const parcels = body.parcels

  const setOwners = (next: ReportOwnerRow[]) => {
    onChange({ owners: next })
  }

  const patchOwner = (idx: number, patch: Partial<ReportOwnerRow>) => {
    setOwners(owners.map((o, i) => (i === idx ? { ...o, ...patch } : o)))
  }

  const patchAttendee = (
    idx: number,
    patch: Partial<ReportOwnerRow['attendee']>,
  ) => {
    setOwners(
      owners.map((o, i) =>
        i === idx ? { ...o, attendee: { ...o.attendee, ...patch } } : o,
      ),
    )
  }

  const toggleParcelIndex = (idx: number, parcelIdx: number) => {
    const cur = owners[idx].parcelIndexes
    const next = cur.includes(parcelIdx)
      ? cur.filter((i) => i !== parcelIdx)
      : [...cur, parcelIdx].sort((a, b) => a - b)
    patchOwner(idx, { parcelIndexes: next })
  }

  const removeOwner = (idx: number) => {
    setOwners(owners.filter((_, i) => i !== idx))
  }

  /** 地権者を選択 → その地権者が所有する parcels (02 に登録済み) を parcelIndexes に反映 */
  const applyLandowner = async (idx: number | null, lo: PickableLandowner) => {
    // 該当地権者が どの parcels を所有しているか parcel_landowners から引く
    const { data: pls } = await supabase
      .from('parcel_landowners')
      .select('parcel_id')
      .eq('landowner_id', lo.id)
    const ownedParcelIds = new Set(
      ((pls ?? []) as { parcel_id: string }[]).map((r) => r.parcel_id),
    )

    // 02 に登録済み parcels の どのインデックスが 該当するか
    const idxs: number[] = []
    parcels.forEach((p, i) => {
      if (p.parcelId && ownedParcelIds.has(p.parcelId)) idxs.push(i)
    })

    const draft: ReportOwnerRow = {
      ...(idx !== null ? owners[idx] : emptyOwner()),
      parcelIndexes: idxs,
      landownerId: lo.id,
      address: lo.address ?? '',
      name: lo.fullName,
      contact: lo.phone ?? '',
      attendee: lo.agentName
        ? {
            ...(idx !== null ? owners[idx].attendee : emptyOwner().attendee),
            address: lo.agentAddress ?? '',
            name: lo.agentName,
            contact: lo.agentPhone ?? '',
            relation: guessRelation(lo.agentRelation),
            relationDetail: lo.agentRelation ?? '',
          }
        : idx !== null
        ? owners[idx].attendee
        : emptyOwner().attendee,
    }

    if (idx !== null) {
      setOwners(owners.map((o, i) => (i === idx ? draft : o)))
    } else {
      setOwners([...owners, draft])
    }
    setPickerOpen(false)
    setPickerFor(null)
  }

  return (
    <div className="p-3 space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          disabled={!currentFarm?.id}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          <ListChecks className="h-3 w-3" /> 地権者から選択して取り込み
        </button>
        <button
          type="button"
          onClick={() => setOwners([...owners, emptyOwner()])}
          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
        >
          <Plus className="h-3 w-3" /> 手動で追加
        </button>
      </div>

      {owners.length === 0 ? (
        <div className="text-xs text-slate-400">
          名義人がまだ登録されていません。「地権者から選択して取り込み」または「手動で追加」で 1 名義人分の行を作成してください。
        </div>
      ) : (
        owners.map((o, idx) => (
          <div key={idx} className="border rounded p-2 bg-white">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-semibold text-slate-700">
                名義人 {idx + 1}
                {o.name && <span className="ml-2 text-slate-500">{o.name}</span>}
              </span>
              <button
                type="button"
                onClick={() => setPickerFor(idx)}
                disabled={!currentFarm?.id}
                className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                <ListChecks className="h-3 w-3" /> 地権者から差し替え
              </button>
              <button
                type="button"
                onClick={() => removeOwner(idx)}
                className="p-1 text-red-500 hover:bg-red-50 rounded"
                title="この名義人を削除"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="grid grid-cols-12 gap-3">
              {/* 左: 所有地一覧 */}
              <div className="col-span-4">
                <div className="text-[11px] text-slate-500 mb-1">所有地</div>
                {parcels.length === 0 ? (
                  <div className="text-xs text-slate-400">
                    02 で 地番を登録してください
                  </div>
                ) : (
                  <div className="border rounded divide-y">
                    {parcels.map((p, pi) => {
                      const checked = o.parcelIndexes.includes(pi)
                      return (
                        <label
                          key={pi}
                          className={`flex items-start gap-1.5 px-1.5 py-1 text-xs cursor-pointer ${
                            checked ? 'bg-blue-50' : 'hover:bg-slate-50'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleParcelIndex(idx, pi)}
                            className="mt-0.5 h-3.5 w-3.5"
                          />
                          <div className="flex-1 min-w-0">
                            <div className="truncate">
                              {p.location || '所在未入力'} {p.parcelNumber}
                            </div>
                            <div className="text-[10px] text-slate-500 truncate">
                              {p.landCategory || '—'}
                              {p.areaSqm != null && ` / ${p.areaSqm.toFixed(2)} ㎡`}
                            </div>
                          </div>
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>

              {/* 右: 名義人情報 */}
              <div className="col-span-8 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <Field label="住所">
                    <input
                      type="text"
                      value={o.address}
                      onChange={(e) => patchOwner(idx, { address: e.target.value })}
                      className="w-full px-2 py-1 text-xs border rounded"
                    />
                  </Field>
                  <Field label="氏名">
                    <input
                      type="text"
                      value={o.name}
                      onChange={(e) => patchOwner(idx, { name: e.target.value })}
                      className="w-full px-2 py-1 text-xs border rounded"
                    />
                  </Field>
                  <Field label="連絡先">
                    <input
                      type="text"
                      value={o.contact}
                      onChange={(e) => patchOwner(idx, { contact: e.target.value })}
                      className="w-full px-2 py-1 text-xs border rounded"
                    />
                  </Field>
                  <Field label="所有形態">
                    <div className="flex items-center gap-2">
                      <RadioGroup
                        name={`ownership-${idx}`}
                        value={o.ownership}
                        onChange={(v) => patchOwner(idx, { ownership: v })}
                        options={[
                          { value: 'single', label: '単有' },
                          { value: 'joint', label: '共有' },
                        ]}
                      />
                      {o.ownership === 'joint' && (
                        <input
                          type="text"
                          value={o.ownershipShare}
                          onChange={(e) => patchOwner(idx, { ownershipShare: e.target.value })}
                          placeholder="持分 (例: 1/2)"
                          className="flex-1 px-2 py-1 text-xs border rounded"
                        />
                      )}
                    </div>
                  </Field>
                </div>

                <Field label="本人確認方法">
                  <div className="flex items-center gap-2 flex-wrap">
                    <RadioGroup
                      name={`idMethod-${idx}`}
                      value={o.idMethod}
                      onChange={(v) => patchOwner(idx, { idMethod: v })}
                      options={[
                        { value: 'license', label: '運転免許証' },
                        { value: 'idcard', label: 'マイナンバーカード' },
                        { value: 'meishiki', label: '面識あり' },
                        { value: 'other', label: 'その他' },
                      ]}
                    />
                    {o.idMethod === 'other' && (
                      <input
                        type="text"
                        value={o.idMethodOther}
                        onChange={(e) => patchOwner(idx, { idMethodOther: e.target.value })}
                        placeholder="内容"
                        className="flex-1 px-2 py-1 text-xs border rounded"
                      />
                    )}
                  </div>
                </Field>

                <details className="border-t pt-2">
                  <summary className="text-xs font-semibold text-slate-700 cursor-pointer">
                    立会人 (本人以外が立ち会う場合)
                  </summary>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <Field label="住所">
                      <input
                        type="text"
                        value={o.attendee.address}
                        onChange={(e) => patchAttendee(idx, { address: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      />
                    </Field>
                    <Field label="氏名">
                      <input
                        type="text"
                        value={o.attendee.name}
                        onChange={(e) => patchAttendee(idx, { name: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      />
                    </Field>
                    <Field label="連絡先">
                      <input
                        type="text"
                        value={o.attendee.contact}
                        onChange={(e) => patchAttendee(idx, { contact: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      />
                    </Field>
                    <Field label="続柄">
                      <div className="flex items-center gap-2">
                        <RadioGroup
                          name={`attRel-${idx}`}
                          value={o.attendee.relation}
                          onChange={(v) => patchAttendee(idx, { relation: v })}
                          options={[
                            { value: 'family', label: '家族' },
                            { value: 'manager', label: '管理者' },
                            { value: 'representative', label: '代理人' },
                            { value: 'other', label: 'その他' },
                          ]}
                        />
                        {(o.attendee.relation === 'other' || o.attendee.relation === 'representative') && (
                          <input
                            type="text"
                            value={o.attendee.relationDetail}
                            onChange={(e) => patchAttendee(idx, { relationDetail: e.target.value })}
                            placeholder="内容"
                            className="flex-1 px-2 py-1 text-xs border rounded"
                          />
                        )}
                      </div>
                    </Field>
                    <Field label="本人確認方法" className="col-span-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <RadioGroup
                          name={`attId-${idx}`}
                          value={o.attendee.idMethod}
                          onChange={(v) => patchAttendee(idx, { idMethod: v })}
                          options={[
                            { value: 'license', label: '運転免許証' },
                            { value: 'idcard', label: 'マイナンバーカード' },
                            { value: 'meishiki', label: '面識あり' },
                            { value: 'other', label: 'その他' },
                          ]}
                        />
                        {o.attendee.idMethod === 'other' && (
                          <input
                            type="text"
                            value={o.attendee.idMethodOther}
                            onChange={(e) => patchAttendee(idx, { idMethodOther: e.target.value })}
                            placeholder="内容"
                            className="flex-1 px-2 py-1 text-xs border rounded"
                          />
                        )}
                      </div>
                    </Field>
                    <Field label="備考" className="col-span-2">
                      <input
                        type="text"
                        value={o.attendee.remark}
                        onChange={(e) => patchAttendee(idx, { remark: e.target.value })}
                        className="w-full px-2 py-1 text-xs border rounded"
                      />
                    </Field>
                  </div>
                </details>
              </div>
            </div>
          </div>
        ))
      )}

      {pickerOpen && currentFarm?.id && (
        <LandownerPickerModal
          farmId={currentFarm.id}
          parcelId={null}
          onCancel={() => setPickerOpen(false)}
          onConfirm={(lo) => void applyLandowner(null, lo)}
        />
      )}
      {pickerFor !== null && currentFarm?.id && (
        <LandownerPickerModal
          farmId={currentFarm.id}
          parcelId={null}
          onCancel={() => setPickerFor(null)}
          onConfirm={(lo) => void applyLandowner(pickerFor, lo)}
        />
      )}
    </div>
  )
}
