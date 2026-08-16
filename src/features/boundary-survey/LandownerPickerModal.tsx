// 03 所有権登記名義人 で使う 地権者選択モーダル。
// 現 farm 配下の landowners を一覧表示し、1 名を選択して取り込む。
// 対象 parcelId が渡されている場合、その parcel に割り当てられた地権者を上に表示。

import { useEffect, useMemo, useState } from 'react'
import { X, Check, Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { LandownerAttribute, LandownerIdMethod } from '@/types/database'
import {
  LANDOWNER_ATTRIBUTE_LABEL,
  LANDOWNER_ID_METHOD_LABEL,
} from '@/types/database'

export interface PickableLandowner {
  id: string
  fullName: string
  address: string | null
  phone: string | null
  agentName: string | null
  agentAddress: string | null
  agentPhone: string | null
  agentRelation: string | null
  attribute: LandownerAttribute | null
  idMethod: LandownerIdMethod | null
  idMethodOther: string | null
  agentIdMethod: LandownerIdMethod | null
  agentIdMethodOther: string | null
}

interface Props {
  farmId: string
  /** 対象の parcelId (指定時、この地番に割当済みの地権者を先頭に表示) */
  parcelId: string | null
  onCancel: () => void
  onConfirm: (selected: PickableLandowner) => void
}

interface Row {
  id: string
  full_name: string
  address: string | null
  phone: string | null
  agent_name: string | null
  agent_address: string | null
  agent_phone: string | null
  agent_relation: string | null
  attribute: LandownerAttribute | null
  id_method: LandownerIdMethod | null
  id_method_other: string | null
  agent_id_method: LandownerIdMethod | null
  agent_id_method_other: string | null
}

const toLandowner = (r: Row): PickableLandowner => ({
  id: r.id,
  fullName: r.full_name,
  address: r.address,
  phone: r.phone,
  agentName: r.agent_name,
  agentAddress: r.agent_address,
  agentPhone: r.agent_phone,
  agentRelation: r.agent_relation,
  attribute: r.attribute,
  idMethod: r.id_method,
  idMethodOther: r.id_method_other,
  agentIdMethod: r.agent_id_method,
  agentIdMethodOther: r.agent_id_method_other,
})

export function LandownerPickerModal({ farmId, parcelId, onCancel, onConfirm }: Props) {
  const [landowners, setLandowners] = useState<PickableLandowner[]>([])
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError(null)
      const { data, error: err } = await supabase
        .from('landowners')
        .select(
          'id, full_name, address, phone, agent_name, agent_address, agent_phone, agent_relation, attribute, id_method, id_method_other, agent_id_method, agent_id_method_other',
        )
        .eq('farm_id', farmId)
        .order('full_name')
      if (cancelled) return
      if (err) {
        setError(err.message)
        setLoading(false)
        return
      }
      setLandowners(((data ?? []) as Row[]).map(toLandowner))

      if (parcelId) {
        const { data: pls } = await supabase
          .from('parcel_landowners')
          .select('landowner_id')
          .eq('parcel_id', parcelId)
        if (cancelled) return
        setAssignedIds(
          new Set(
            ((pls ?? []) as { landowner_id: string }[]).map((r) => r.landowner_id),
          ),
        )
      }
      setLoading(false)
    })()
    return () => {
      cancelled = true
    }
  }, [farmId, parcelId])

  const sorted = useMemo(() => {
    const withFlag = landowners.map((l) => ({ ...l, assigned: assignedIds.has(l.id) }))
    // 割当済み → 未割当、その中で 氏名昇順
    withFlag.sort((a, b) => {
      if (a.assigned !== b.assigned) return a.assigned ? -1 : 1
      return a.fullName.localeCompare(b.fullName, 'ja')
    })
    return withFlag
  }, [landowners, assignedIds])

  const filtered = useMemo(() => {
    if (!filter.trim()) return sorted
    const q = filter.trim().toLowerCase()
    return sorted.filter(
      (l) =>
        l.fullName.toLowerCase().includes(q) ||
        (l.address ?? '').toLowerCase().includes(q),
    )
  }, [sorted, filter])

  const handleConfirm = () => {
    const chosen = landowners.find((l) => l.id === selectedId)
    if (chosen) onConfirm(chosen)
  }

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h3 className="text-sm font-semibold flex-1">
            地権者を選択
            {parcelId && (
              <span className="ml-2 text-xs font-normal text-slate-500">
                (この地番に割当済みが 上位に表示されます)
              </span>
            )}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 hover:bg-slate-100 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-3 border-b">
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="氏名・住所でフィルタ"
            className="w-full px-2 py-1 text-xs border rounded"
          />
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3">
          {error ? (
            <div className="text-xs text-red-700">{error}</div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" /> 読み込み中…
            </div>
          ) : landowners.length === 0 ? (
            <div className="text-xs text-slate-400">
              この工区には 地権者が登録されていません。
            </div>
          ) : (
            <div className="space-y-1">
              {filtered.map((l) => {
                const isSelected = selectedId === l.id
                return (
                  <label
                    key={l.id}
                    className={`flex items-start gap-2 p-2 border rounded cursor-pointer ${
                      isSelected ? 'bg-blue-50 border-blue-400' : 'hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="landowner-pick"
                      checked={isSelected}
                      onChange={() => setSelectedId(l.id)}
                      className="mt-0.5 h-3.5 w-3.5"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{l.fullName}</span>
                        {l.attribute && (
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              l.attribute === 'applicant'
                                ? 'bg-blue-100 text-blue-700'
                                : 'bg-orange-100 text-orange-700'
                            }`}
                          >
                            {LANDOWNER_ATTRIBUTE_LABEL[l.attribute]}
                          </span>
                        )}
                        {l.assigned && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-emerald-100 text-emerald-700 rounded">
                            この地番に割当済み
                          </span>
                        )}
                        {l.idMethod && (
                          <span className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded">
                            本人確認: {LANDOWNER_ID_METHOD_LABEL[l.idMethod]}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-slate-600">
                        {l.address || '住所未登録'}
                      </div>
                      {l.agentName && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          代理人: {l.agentName}
                          {l.agentRelation && ` (${l.agentRelation})`}
                          {l.agentIdMethod && ` / 本人確認: ${LANDOWNER_ID_METHOD_LABEL[l.agentIdMethod]}`}
                        </div>
                      )}
                    </div>
                  </label>
                )
              })}
            </div>
          )}
        </div>

        <div className="border-t px-4 py-3 flex items-center gap-2">
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selectedId}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              <Check className="h-4 w-4" /> 取り込む
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
