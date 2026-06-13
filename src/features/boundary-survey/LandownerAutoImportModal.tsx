// 地権者管理: 「地番管理から自動取得」モーダル。
//
// 工区配下の parcels の registered_owner_name / registered_owner_address を
// 集めて、地権者 (landowners) として一括登録する。同名で住所が異なる行が
// あった場合はユーザに resolution を選ばせる:
//   ・別個に登録（同名の他人として複数件作る）
//   ・住所を 1 つだけ選んで「同一人物」として 1 件にまとめる
//
// 既存の landowner（氏名 + 住所が完全一致）は再利用し、新規作成しない。
// 取り込み完了後は parcel_landowners も更新するため、所有地列が即時に反映される。

import { useMemo, useState } from 'react'
import { Loader2, X, AlertTriangle, Check, Wand2 } from 'lucide-react'
import { useLandownerStore } from '@/stores/landownerStore'
import type { Landowner } from '@/types/database'

export interface FarmParcelRow {
  id: string
  parcel_number: string | null
  location: string | null
  registered_owner_name: string | null
  registered_owner_address: string | null
}

interface Props {
  farmId: string
  parcels: FarmParcelRow[]
  existingLandowners: Landowner[]
  onClose: () => void
  /** 反映が成功したときに呼ぶ（親で再 fetch） */
  onApplied: () => Promise<void>
}

interface Variant {
  /** 住所文字列（null/空文字も含めて区別する） */
  address: string | null
  /** この (name, address) に該当する parcels */
  parcels: FarmParcelRow[]
}

type Resolution =
  | { kind: 'separate' } // 別個の地権者として登録
  | { kind: 'merge'; addressIdx: number } // 単一の地権者として登録、住所はこのインデックス

interface NameGroup {
  name: string
  variants: Variant[]
  /** 自動取り込みに含めるか（チェック） */
  enabled: boolean
  /** 複数住所がある場合の解決方法。1 住所のみの場合は変更不要 */
  resolution: Resolution
}

const normalize = (s: string | null | undefined): string =>
  (s ?? '').replace(/[\s　]+/g, '').trim()

export function LandownerAutoImportModal({
  farmId,
  parcels,
  existingLandowners,
  onClose,
  onApplied,
}: Props) {
  const createLandowner = useLandownerStore((s) => s.createLandowner)
  const updateLandowner = useLandownerStore((s) => s.updateLandowner)
  const setParcelAssignment = useLandownerStore((s) => s.setParcelAssignment)
  const landownersByParcelId = useLandownerStore((s) => s.landownersByParcelId)

  // 初期グループ化: 氏名で集約 → 住所バリアントに分解
  const initialGroups = useMemo<NameGroup[]>(() => {
    const byName = new Map<string, NameGroup>()
    for (const p of parcels) {
      const name = normalize(p.registered_owner_name)
      if (!name) continue
      const addr = p.registered_owner_address?.trim() || null
      let g = byName.get(name)
      if (!g) {
        g = {
          name,
          variants: [],
          enabled: true,
          resolution: { kind: 'separate' },
        }
        byName.set(name, g)
      }
      const addrKey = normalize(addr)
      let variant = g.variants.find((v) => normalize(v.address) === addrKey)
      if (!variant) {
        variant = { address: addr, parcels: [] }
        g.variants.push(variant)
      }
      variant.parcels.push(p)
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
  }, [parcels])

  const [groups, setGroups] = useState<NameGroup[]>(initialGroups)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<{ created: number; reused: number; assigned: number } | null>(null)
  const [errors, setErrors] = useState<string[]>([])

  const conflictGroups = groups.filter((g) => g.variants.length > 1)
  const cleanGroups = groups.filter((g) => g.variants.length === 1)

  const updateGroup = (name: string, patch: Partial<NameGroup>) => {
    setGroups((prev) => prev.map((g) => (g.name === name ? { ...g, ...patch } : g)))
  }

  // 既存 landowner を「氏名+住所」で引くインデックス
  const existingByKey = useMemo(() => {
    const m = new Map<string, Landowner>()
    for (const l of existingLandowners) {
      const key = normalize(l.full_name) + '|' + normalize(l.address)
      m.set(key, l)
    }
    return m
  }, [existingLandowners])

  // 既存 landowner ID → 既に割り当て済みの parcel_id 集合
  const existingAssignmentSet = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const [parcelId, ids] of landownersByParcelId) {
      for (const lid of ids) {
        const s = m.get(lid) ?? new Set<string>()
        s.add(parcelId)
        m.set(lid, s)
      }
    }
    return m
  }, [landownersByParcelId])

  const handleApply = async () => {
    setApplying(true)
    setErrors([])
    const errs: string[] = []
    let created = 0
    let reused = 0
    let assigned = 0

    // 計画: ターゲット landowner_id ごとに、新規割り当てる parcel_id の配列を貯める
    // 既存 landowner にも parcel を追加するので、addByLandowner で保持。
    const addByLandowner = new Map<string, Set<string>>()

    for (const g of groups) {
      if (!g.enabled) continue
      try {
        const resolved =
          g.variants.length === 1 ? { kind: 'separate' as const } : g.resolution

        if (resolved.kind === 'merge') {
          // 1 名にまとめる: 採用住所
          const chosen = g.variants[resolved.addressIdx]
          if (!chosen) continue
          const address = chosen.address?.trim() || null
          const key = normalize(g.name) + '|' + normalize(address)
          let landownerId: string | null = null
          const existing = existingByKey.get(key)
          if (existing) {
            landownerId = existing.id
            reused++
          } else {
            const lo = await createLandowner(farmId, {
              full_name: g.name,
              address,
            })
            if (lo) {
              landownerId = lo.id
              created++
            } else {
              errs.push(`「${g.name}」の登録に失敗しました`)
              continue
            }
          }
          // 全 variant の parcels をこの 1 人に紐付け
          const set = addByLandowner.get(landownerId) ?? new Set<string>()
          for (const v of g.variants) {
            for (const p of v.parcels) set.add(p.id)
          }
          addByLandowner.set(landownerId, set)
        } else {
          // 別個に登録: variant ごとに 1 名作る
          for (const v of g.variants) {
            const address = v.address?.trim() || null
            const key = normalize(g.name) + '|' + normalize(address)
            let landownerId: string | null = null
            const existing = existingByKey.get(key)
            if (existing) {
              landownerId = existing.id
              reused++
            } else {
              const lo = await createLandowner(farmId, {
                full_name: g.name,
                address,
              })
              if (lo) {
                landownerId = lo.id
                created++
              } else {
                errs.push(`「${g.name}」（${address ?? '住所なし'}）の登録に失敗しました`)
                continue
              }
            }
            const set = addByLandowner.get(landownerId) ?? new Set<string>()
            for (const p of v.parcels) set.add(p.id)
            addByLandowner.set(landownerId, set)
          }
        }
      } catch (e) {
        errs.push(`「${g.name}」の処理中にエラー: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 各 landowner について、既存割り当てを尊重して新規分のみ追加する
    // parcel 視点: その parcel が現在 [A, B, C] を持っていて、追加で D が必要 → [A, B, C, D] を渡す
    // parcel_id → 追加すべき landowner_id 群
    const addByParcel = new Map<string, Set<string>>()
    for (const [landownerId, parcelSet] of addByLandowner) {
      for (const parcelId of parcelSet) {
        const cur = addByParcel.get(parcelId) ?? new Set<string>()
        cur.add(landownerId)
        addByParcel.set(parcelId, cur)
      }
    }
    for (const [parcelId, addIds] of addByParcel) {
      const currentIds = new Set(landownersByParcelId.get(parcelId) ?? [])
      let changed = false
      for (const id of addIds) {
        if (!currentIds.has(id)) {
          currentIds.add(id)
          changed = true
          assigned++
        }
      }
      if (!changed) continue
      try {
        await setParcelAssignment(parcelId, Array.from(currentIds))
      } catch (e) {
        errs.push(`地番 ${parcelId} への割当て失敗: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // 既存 landowner で address が空欄だった場合、取り込み住所で埋めてあげる
    // （氏名が一致するもののうち、住所空欄のものは確定的に補完できる）
    for (const g of groups) {
      if (!g.enabled) continue
      if (g.variants.length !== 1) continue
      const address = g.variants[0].address?.trim() || null
      if (!address) continue
      const existing = existingByKey.get(normalize(g.name) + '|' + normalize(null))
      if (!existing || existing.address) continue
      try {
        await updateLandowner(existing.id, { address })
      } catch {
        /* ignore */
      }
    }

    setResult({ created, reused, assigned })
    setErrors(errs)
    setApplying(false)
    await onApplied()
  }

  // 既存割り当てチェック表示用
  const existingAssignedSetFor = (landownerId: string) =>
    existingAssignmentSet.get(landownerId) ?? new Set<string>()

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-blue-600" />
          <h3 className="flex-1 text-base font-semibold">地番管理から地権者を自動取得</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-4 py-2 border-b bg-slate-50 text-xs text-slate-600">
          {groups.length === 0 ? (
            <>地番管理に登記所有者の登録がありません。先に「登記PDF取込」などで所有者を入れてください。</>
          ) : (
            <>
              対象: 氏名 {groups.length} 名（うち住所が複数あって要選択 {conflictGroups.length} 名）。
              既存と完全一致する地権者は再利用されます。
            </>
          )}
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {/* 衝突あり: 解決 UI */}
          {conflictGroups.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-amber-700 mb-1 flex items-center gap-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                住所が複数あります（選んでください）
              </h4>
              <div className="space-y-2">
                {conflictGroups.map((g) => (
                  <div key={g.name} className="border rounded p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <input
                        type="checkbox"
                        checked={g.enabled}
                        onChange={() => updateGroup(g.name, { enabled: !g.enabled })}
                      />
                      <span className="font-semibold text-sm">{g.name}</span>
                      <span className="text-xs text-slate-500">
                        {g.variants.reduce((s, v) => s + v.parcels.length, 0)} 地番
                      </span>
                    </div>
                    <div className="ml-6 space-y-1">
                      <label className="flex items-center gap-2 text-xs">
                        <input
                          type="radio"
                          name={`res-${g.name}`}
                          checked={g.resolution.kind === 'separate'}
                          onChange={() =>
                            updateGroup(g.name, { resolution: { kind: 'separate' } })
                          }
                        />
                        <span>別個に登録（同名の他人として {g.variants.length} 名作成）</span>
                      </label>
                      {g.variants.map((v, idx) => (
                        <label key={idx} className="flex items-center gap-2 text-xs">
                          <input
                            type="radio"
                            name={`res-${g.name}`}
                            checked={
                              g.resolution.kind === 'merge' && g.resolution.addressIdx === idx
                            }
                            onChange={() =>
                              updateGroup(g.name, {
                                resolution: { kind: 'merge', addressIdx: idx },
                              })
                            }
                          />
                          <span className="text-slate-700">
                            この住所で 1 名にまとめる:
                          </span>
                          <span className="text-slate-800">{v.address ?? '(住所なし)'}</span>
                          <span className="text-slate-400">
                            ({v.parcels.map((p) => p.parcel_number ?? '?').join(' / ')})
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* 衝突なし: 単純に作る */}
          {cleanGroups.length > 0 && (
            <section>
              <h4 className="text-sm font-semibold text-slate-700 mb-1">そのまま取り込む</h4>
              <div className="border rounded divide-y">
                {cleanGroups.map((g) => {
                  const v = g.variants[0]
                  const key = normalize(g.name) + '|' + normalize(v.address)
                  const existing = existingByKey.get(key)
                  const existingAddressless = existingByKey.get(normalize(g.name) + '|' + normalize(null))
                  const reuseHint = existing
                    ? '（既存と一致 → 再利用）'
                    : existingAddressless && !existingAddressless.address
                    ? '（既存に住所を補完）'
                    : '（新規作成）'
                  // この地権者がすでに持っている parcel との差分
                  const targetParcelIds = new Set(v.parcels.map((p) => p.id))
                  const targetLandownerId = existing?.id ?? existingAddressless?.id ?? null
                  const alreadyAssigned = targetLandownerId
                    ? existingAssignedSetFor(targetLandownerId)
                    : new Set<string>()
                  const newAssigns = Array.from(targetParcelIds).filter((id) => !alreadyAssigned.has(id))
                  return (
                    <div key={g.name} className="p-2 flex items-start gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={g.enabled}
                        onChange={() => updateGroup(g.name, { enabled: !g.enabled })}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div>
                          <span className="font-semibold">{g.name}</span>
                          <span className="ml-2 text-slate-400">{reuseHint}</span>
                        </div>
                        <div className="text-slate-600 truncate">
                          住所: {v.address ?? '(住所なし)'}
                        </div>
                        <div className="text-slate-500">
                          所有地: {v.parcels.map((p) => p.parcel_number ?? '?').join(' / ')}
                          {newAssigns.length === 0 && targetLandownerId && (
                            <span className="ml-1 text-emerald-600">（割当て済み）</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}
        </div>

        {/* 結果 / エラー */}
        {result && (
          <div className="px-4 py-2 border-t bg-emerald-50 text-sm text-emerald-800">
            完了: 新規 {result.created} 名 / 既存再利用 {result.reused} 名 / 新規割当 {result.assigned} 件
          </div>
        )}
        {errors.length > 0 && (
          <div className="px-4 py-2 border-t bg-red-50 text-xs text-red-700 max-h-24 overflow-auto">
            {errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={applying}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            閉じる
          </button>
          <button
            onClick={handleApply}
            disabled={applying || groups.length === 0 || groups.every((g) => !g.enabled)}
            className="flex items-center gap-1 px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {applying ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            取り込む
          </button>
        </div>
      </div>
    </div>
  )
}
