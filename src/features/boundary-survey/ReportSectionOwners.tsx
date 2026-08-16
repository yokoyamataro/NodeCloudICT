// 03 所有権登記名義人 (立会人ブロック込)
//   * 1 行 = 1 名義人。所有地は 地権者管理 (landowners + parcel_landowners)
//     から自動インポート。02 の parcels には依存しない。
//   * 「地権者から選択して取り込み」で 名義人を選ぶと、その地権者に
//     割り当てられた 全 parcels を snapshot として ownedParcels に populate。
//   * 各所有地は チェックボックスで 出力対象を切替可能。

import { useState } from 'react'
import { Trash2, ListChecks, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { useFarmStore } from '@/stores/farmStore'
import type {
  LandReportBody,
  ReportOwnerRow,
  ReportOwnedParcel,
} from '@/stores/landReportStore'
import { RadioGroup, Field, CheckboxLabel } from './reportSectionUi'
import { LandownerPickerModal, type PickableLandowner } from './LandownerPickerModal'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

const emptyOwner = (): ReportOwnerRow => ({
  ownedParcels: [],
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

interface ParcelRow {
  id: string
  location: string | null
  parcel_number: string | null
  municipality: string | null
  registered_land_category: string | null
  updated_land_category: string | null
  registered_area_sqm: number | null
}

/** 指定 landowner の 所有地を parcel_landowners 経由で fetch → OwnedParcel snapshot に変換 */
async function fetchOwnedParcels(landownerId: string): Promise<ReportOwnedParcel[]> {
  const { data: links } = await supabase
    .from('parcel_landowners')
    .select('parcel_id')
    .eq('landowner_id', landownerId)
  const parcelIds = ((links ?? []) as { parcel_id: string }[]).map((r) => r.parcel_id)
  if (parcelIds.length === 0) return []
  const { data: parcels } = await supabase
    .from('parcels')
    .select(
      'id, location, parcel_number, municipality, registered_land_category, updated_land_category, registered_area_sqm',
    )
    .in('id', parcelIds)
  return ((parcels ?? []) as ParcelRow[]).map((p) => ({
    parcelId: p.id,
    location: [p.municipality, p.location].filter(Boolean).join(''),
    parcelNumber: p.parcel_number ?? '',
    landCategory: p.updated_land_category ?? p.registered_land_category ?? '',
    registeredAreaSqm: p.registered_area_sqm,
    included: true,
  }))
}

export function ReportSectionOwners({ body, onChange }: Props) {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerFor, setPickerFor] = useState<number | null>(null)
  const [loadingFor, setLoadingFor] = useState<number | 'new' | null>(null)

  const owners = body.owners

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

  const patchOwnedParcel = (
    ownerIdx: number,
    parcelIdx: number,
    patch: Partial<ReportOwnedParcel>,
  ) => {
    setOwners(
      owners.map((o, i) => {
        if (i !== ownerIdx) return o
        return {
          ...o,
          ownedParcels: o.ownedParcels.map((p, j) =>
            j === parcelIdx ? { ...p, ...patch } : p,
          ),
        }
      }),
    )
  }

  const removeOwnedParcel = (ownerIdx: number, parcelIdx: number) => {
    setOwners(
      owners.map((o, i) => {
        if (i !== ownerIdx) return o
        return {
          ...o,
          ownedParcels: o.ownedParcels.filter((_, j) => j !== parcelIdx),
        }
      }),
    )
  }

  const removeOwner = (idx: number) => {
    setOwners(owners.filter((_, i) => i !== idx))
  }

  /** 地権者を選択 → 所有地を parcel_landowners から fetch して populate */
  const applyLandowner = async (idx: number | null, lo: PickableLandowner) => {
    setLoadingFor(idx === null ? 'new' : idx)
    let owned: ReportOwnedParcel[] = []
    try {
      owned = await fetchOwnedParcels(lo.id)
    } catch {
      owned = []
    }
    setLoadingFor(null)

    const draft: ReportOwnerRow = {
      ...(idx !== null ? owners[idx] : emptyOwner()),
      ownedParcels: owned,
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
              {/* 左: 所有地 (地権者管理からインポート) */}
              <div className="col-span-4">
                <div className="text-[11px] text-slate-500 mb-1">
                  所有地 (地権者管理より)
                </div>
                {loadingFor === idx ? (
                  <div className="text-xs text-slate-400">読込中…</div>
                ) : o.ownedParcels.length === 0 ? (
                  <div className="text-xs text-slate-400">
                    未取込。「地権者から差し替え」で 選択してください。
                  </div>
                ) : (
                  <div className="border rounded divide-y">
                    {o.ownedParcels.map((p, pi) => (
                      <div
                        key={pi}
                        className={`flex items-start gap-1.5 px-1.5 py-1 text-xs ${
                          p.included ? 'bg-blue-50' : 'bg-white'
                        }`}
                      >
                        <CheckboxLabel
                          checked={p.included}
                          onChange={(v) => patchOwnedParcel(idx, pi, { included: v })}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block truncate">
                              {p.location || '所在未入力'} {p.parcelNumber}
                            </span>
                            <span className="block text-[10px] text-slate-500 truncate">
                              {p.landCategory || '—'}
                              {p.registeredAreaSqm != null &&
                                ` / ${p.registeredAreaSqm.toFixed(2)} ㎡`}
                            </span>
                          </span>
                        </CheckboxLabel>
                        <button
                          type="button"
                          onClick={() => removeOwnedParcel(idx, pi)}
                          className="p-0.5 text-red-500 hover:bg-red-50 rounded"
                          title="削除"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
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
