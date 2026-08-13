// 03 所有権登記名義人 (立会人ブロック込)
//   * body.owners は body.parcels と同数 (parcelIndex で 02 の行に対応)。
//   * 02 で 地番を追加/削除すると、ここも 同期して 増減させる。
//   * 「地権者から選択して取り込み」で 現 farm の地権者から 1 名を選んで反映。
//     対象の parcelId に割当済みの地権者は 一覧上位に表示される。

import { useEffect, useState } from 'react'
import { ListChecks } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import type { LandReportBody, ReportOwnerRow } from '@/stores/landReportStore'
import { RadioGroup, Field } from './reportSectionUi'
import { LandownerPickerModal, type PickableLandowner } from './LandownerPickerModal'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyOwner = (parcelIndex: number): ReportOwnerRow => ({
  parcelIndex,
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

/** landowner.agent_relation の 自由文を できるだけ enum に合わせる */
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
  const [pickerFor, setPickerFor] = useState<number | null>(null)

  // parcels 数に合わせて owners を伸縮
  useEffect(() => {
    const n = body.parcels.length
    if (body.owners.length === n) return
    const nextOwners: ReportOwnerRow[] = []
    for (let i = 0; i < n; i++) {
      nextOwners.push(body.owners[i] ?? emptyOwner(i))
    }
    onChange({ owners: nextOwners })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body.parcels.length])

  const patchOwner = (idx: number, patch: Partial<ReportOwnerRow>) => {
    onChange({
      owners: body.owners.map((o, i) => (i === idx ? { ...o, ...patch } : o)),
    })
  }

  const patchAttendee = (
    idx: number,
    patch: Partial<ReportOwnerRow['attendee']>,
  ) => {
    onChange({
      owners: body.owners.map((o, i) =>
        i === idx ? { ...o, attendee: { ...o.attendee, ...patch } } : o,
      ),
    })
  }

  const applyLandowner = (idx: number, lo: PickableLandowner) => {
    patchOwner(idx, {
      landownerId: lo.id,
      address: lo.address ?? '',
      name: lo.fullName,
      contact: lo.phone ?? '',
    })
    // 代理人 (立会人) 情報も一緒に反映 (元の入力を上書き)
    if (lo.agentName) {
      patchAttendee(idx, {
        address: lo.agentAddress ?? '',
        name: lo.agentName,
        contact: lo.agentPhone ?? '',
        relation: guessRelation(lo.agentRelation),
        relationDetail: lo.agentRelation ?? '',
      })
    }
    setPickerFor(null)
  }

  return (
    <div className="p-3 space-y-3">
      {body.parcels.length === 0 ? (
        <div className="text-xs text-slate-400">
          02 で 調査した土地を先に登録してください。所有権登記名義人は 地番ごとに 入力します。
        </div>
      ) : (
        body.owners.map((o, idx) => {
          const parcel = body.parcels[idx]
          return (
            <div key={idx} className="border rounded p-2 space-y-2 bg-white">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">
                  地番 {idx + 1}: {parcel?.location} {parcel?.parcelNumber}
                </span>
                <button
                  type="button"
                  onClick={() => setPickerFor(idx)}
                  disabled={!currentFarm?.id}
                  className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
                >
                  <ListChecks className="h-3 w-3" /> 地権者から選択して取り込み
                </button>
              </div>

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
          )
        })
      )}

      {pickerFor !== null && currentFarm?.id && (
        <LandownerPickerModal
          farmId={currentFarm.id}
          parcelId={body.parcels[pickerFor]?.parcelId ?? null}
          onCancel={() => setPickerFor(null)}
          onConfirm={(lo) => applyLandowner(pickerFor, lo)}
        />
      )}
    </div>
  )
}
