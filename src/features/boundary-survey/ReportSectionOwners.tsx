// 03 所有権登記名義人 (立会人ブロック込)
//   * body.owners は body.parcels と同数 (parcelIndex で 02 の行に対応)。
//   * 02 で 地番を追加/削除すると、ここも 同期して 増減させる。
//   * 「地権者から取り込み」で 現 farm の landowners を候補として表示 (未実装: 手動入力ベース)。

import { useEffect } from 'react'
import { Download } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from '@/stores/farmStore'
import type { LandReportBody, ReportOwnerRow } from '@/stores/landReportStore'
import { RadioGroup, Field } from './reportSectionUi'
import { useState } from 'react'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

interface LandownerLite {
  id: string
  full_name: string
  address: string | null
  phone: string | null
  agent_name: string | null
  agent_address: string | null
  agent_phone: string | null
  agent_relation: string | null
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

export function ReportSectionOwners({ body, onChange }: Props) {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const [landowners, setLandowners] = useState<LandownerLite[]>([])
  const [assign, setAssign] = useState<Map<string, string[]>>(new Map())

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

  // farm の landowners と 地番割当を fetch
  useEffect(() => {
    if (!currentFarm?.id) return
    let cancelled = false
    ;(async () => {
      const { data: lo } = await supabase
        .from('landowners')
        .select(
          'id, full_name, address, phone, agent_name, agent_address, agent_phone, agent_relation',
        )
        .eq('farm_id', currentFarm.id)
      if (cancelled) return
      setLandowners((lo ?? []) as LandownerLite[])
      // parcel_landowners: farm 配下の全 parcel 分
      const { data: pls } = await supabase
        .from('parcel_landowners')
        .select('parcel_id, landowner_id')
      if (cancelled) return
      const m = new Map<string, string[]>()
      for (const row of (pls ?? []) as { parcel_id: string; landowner_id: string }[]) {
        const arr = m.get(row.parcel_id) ?? []
        arr.push(row.landowner_id)
        m.set(row.parcel_id, arr)
      }
      setAssign(m)
    })()
    return () => {
      cancelled = true
    }
  }, [currentFarm?.id])

  const patchOwner = (idx: number, patch: Partial<ReportOwnerRow>) => {
    onChange({
      owners: body.owners.map((o, i) => (i === idx ? { ...o, ...patch } : o)),
    })
  }

  const patchAttendee = (idx: number, patch: Partial<ReportOwnerRow['attendee']>) => {
    onChange({
      owners: body.owners.map((o, i) =>
        i === idx ? { ...o, attendee: { ...o.attendee, ...patch } } : o,
      ),
    })
  }

  const importFromParcel = (idx: number) => {
    const parcel = body.parcels[idx]
    if (!parcel?.parcelId) {
      alert('この行は 02 で 地番から取り込んだ 行ではないので 自動取込できません。')
      return
    }
    const loIds = assign.get(parcel.parcelId) ?? []
    if (loIds.length === 0) {
      alert('この地番に 割り当てられた地権者がいません。')
      return
    }
    // 先頭の 1 名を採用 (複数対応は 後追いで)
    const lo = landowners.find((x) => x.id === loIds[0])
    if (!lo) return
    patchOwner(idx, {
      landownerId: lo.id,
      address: lo.address ?? '',
      name: lo.full_name,
      contact: lo.phone ?? '',
    })
    if (lo.agent_name) {
      patchAttendee(idx, {
        address: lo.agent_address ?? '',
        name: lo.agent_name,
        contact: lo.agent_phone ?? '',
        relation:
          lo.agent_relation === '家族' ? 'family' :
          lo.agent_relation === '管理者' ? 'manager' :
          lo.agent_relation === '代理人' ? 'representative' : 'other',
        relationDetail: lo.agent_relation ?? '',
      })
    }
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
                  onClick={() => importFromParcel(idx)}
                  className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
                >
                  <Download className="h-3 w-3" /> 地権者から取り込み
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
    </div>
  )
}
