// 法務局備付地図作成作業 > 地権者リスト。
//
// project_owners を 一覧 + 詳細編集 する。 立会情報 は 地番ごと (property_owner_shares) に
// 保持 する ため、詳細 パネル に 保有 地番 一覧 と 一次/二次 立会 (日時 + 状況) の
// 編集 フィールド を 並べる。
//
// 既存 の landowners (工区単位・立会名簿) と は 完全 別系統。

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Save, Users2, X } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  loadRegistryOwners,
  updateOwnerShare,
  updateProjectOwner,
  type RegistryOwnerRow,
} from '@/lib/registryCsvSave'

const VISIT_STATUS_OPTIONS = [
  '',
  '立会済',
  '未立会',
  '不在',
  '欠席',
  '拒否',
  '死亡',
  '相続手続中',
  'その他',
] as const

// text[] だが select で 選択 して、'その他' なら 自由入力 に 切替 する UI
function VisitStatusInput({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const preset = (VISIT_STATUS_OPTIONS as readonly string[]).includes(value)
  const [mode, setMode] = useState<'preset' | 'free'>(
    !value || preset ? 'preset' : 'free',
  )
  return (
    <div className="flex items-center gap-1">
      <select
        value={mode === 'preset' ? value : 'その他'}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'その他') {
            setMode('free')
            onChange('')
          } else {
            setMode('preset')
            onChange(v)
          }
        }}
        disabled={disabled}
        className="rounded border px-1 py-0.5 text-xs disabled:opacity-50"
      >
        {VISIT_STATUS_OPTIONS.map((s) => (
          <option key={s} value={s}>
            {s || '（未設定）'}
          </option>
        ))}
      </select>
      {mode === 'free' && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="自由入力"
          disabled={disabled}
          className="w-32 rounded border px-1 py-0.5 text-xs disabled:opacity-50"
        />
      )}
    </div>
  )
}

// timestamptz を <input type="datetime-local"> 用 の 文字列 に。
function tsToLocal(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}
function localToTs(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

export function RegistryOwnersPage() {
  const { currentFarm } = useFarmStore()
  const projectId = currentFarm?.project_id ?? null

  const [owners, setOwners] = useState<RegistryOwnerRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!projectId) return
    setLoading(true)
    setError(null)
    try {
      const rows = await loadRegistryOwners(projectId)
      setOwners(rows)
    } catch (err) {
      console.error(err)
      setError(err instanceof Error ? err.message : '地権者リストの読込に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  const filtered = useMemo(() => {
    const q = query.trim()
    if (!q) return owners
    return owners.filter(
      (o) =>
        o.name.includes(q) ||
        o.address.includes(q) ||
        o.parcels.some((p) => p.parcel_number.includes(q)),
    )
  }, [owners, query])

  const selected = selectedId ? owners.find((o) => o.id === selectedId) ?? null : null

  const handleOwnerPatch = async (
    ownerId: string,
    patch: Partial<RegistryOwnerRow>,
  ) => {
    // フィールド 名 は DB 列名 (snake_case) に 揃える
    const dbPatch: Record<string, string | null> = {}
    if (patch.name !== undefined) dbPatch.name = patch.name
    if (patch.address !== undefined) dbPatch.address = patch.address || null
    if (patch.phone !== undefined) dbPatch.phone = patch.phone || null
    if (patch.agent_name !== undefined) dbPatch.agent_name = patch.agent_name || null
    if (patch.agent_address !== undefined)
      dbPatch.agent_address = patch.agent_address || null
    if (patch.agent_phone !== undefined) dbPatch.agent_phone = patch.agent_phone || null
    if (patch.notes !== undefined) dbPatch.notes = patch.notes || null
    try {
      await updateProjectOwner(ownerId, dbPatch)
      setOwners((prev) =>
        prev.map((o) => (o.id === ownerId ? { ...o, ...patch } : o)),
      )
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : '更新に失敗しました')
    }
  }

  const handleSharePatch = async (
    ownerId: string,
    propertyId: string,
    patch: {
      first_visit_at?: string | null
      first_visit_status?: string
      second_visit_at?: string | null
      second_visit_status?: string
      notes?: string
    },
  ) => {
    // shareId は owners の parcels 側 に 持って いない ので、DB 側 で 再検索。
    // 楽観 で: property_id + owner_id に 対応 する share を UPDATE する 別 関数 を 用意 する か、
    // parcels 配列 に id を 追加 する。 後者 が シンプル。
    const owner = owners.find((o) => o.id === ownerId)
    const parcel = owner?.parcels.find((p) => p.property_id === propertyId)
    if (!parcel) return
    try {
      await updateOwnerShare(parcel.share_id, patch)
      setOwners((prev) =>
        prev.map((o) => {
          if (o.id !== ownerId) return o
          return {
            ...o,
            parcels: o.parcels.map((p) =>
              p.property_id === propertyId ? { ...p, ...patch } : p,
            ),
          }
        }),
      )
    } catch (err) {
      console.error(err)
      alert(err instanceof Error ? err.message : '更新に失敗しました')
    }
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-3 border-b bg-white px-4 py-2">
        <div className="text-sm font-semibold text-slate-700">地権者リスト</div>
        <div className="text-xs text-slate-500">
          (法務局備付地図作成作業 - プロジェクト単位)
        </div>
        <div className="flex-1" />
        <input
          type="search"
          placeholder="氏名 / 住所 / 地番で絞込"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={owners.length === 0}
          className="w-56 rounded border border-slate-300 px-2 py-1 text-xs disabled:opacity-40"
        />
      </div>

      {loading && (
        <div className="flex items-center gap-2 border-b bg-blue-50 px-4 py-1 text-xs text-blue-800">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          読み込み中...
        </div>
      )}
      {error && (
        <div className="border-b bg-red-50 px-4 py-1 text-xs text-red-800">{error}</div>
      )}
      {!loading && owners.length > 0 && (
        <div className="border-b bg-slate-50 px-4 py-1 text-xs text-slate-600">
          全 {owners.length} 名 / 表示 {filtered.length} 名
        </div>
      )}

      {owners.length === 0 && !loading ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-2 text-slate-500 text-sm">
          <Users2 className="h-8 w-8 text-slate-300" />
          <div>地権者はまだ登録されていません</div>
          <div className="text-xs">物件一覧から登記CSVを取り込むと自動で作成されます</div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-100 text-slate-600">
                <tr>
                  <th className="border-b px-2 py-1 text-left w-48">氏名</th>
                  <th className="border-b px-2 py-1 text-left">住所</th>
                  <th className="border-b px-2 py-1 text-left w-32">電話</th>
                  <th className="border-b px-2 py-1 text-left w-24">保有地番</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => {
                  const active = o.id === selectedId
                  return (
                    <tr
                      key={o.id}
                      onClick={() => setSelectedId(o.id)}
                      className={`cursor-pointer border-b hover:bg-blue-50 ${
                        active ? 'bg-blue-100' : ''
                      }`}
                    >
                      <td className="px-2 py-1 font-semibold text-slate-800">
                        {o.name}
                      </td>
                      <td className="px-2 py-1 text-slate-700">
                        {o.address || '—'}
                      </td>
                      <td className="px-2 py-1 font-mono text-slate-700">
                        {o.phone || '—'}
                      </td>
                      <td className="px-2 py-1 text-right font-mono text-slate-500">
                        {o.parcels.length}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {selected && (
            <OwnerDetailPanel
              owner={selected}
              onClose={() => setSelectedId(null)}
              onPatchOwner={(patch) => handleOwnerPatch(selected.id, patch)}
              onPatchShare={(propertyId, patch) =>
                handleSharePatch(selected.id, propertyId, patch)
              }
            />
          )}
        </div>
      )}
    </div>
  )
}

function OwnerDetailPanel({
  owner,
  onClose,
  onPatchOwner,
  onPatchShare,
}: {
  owner: RegistryOwnerRow
  onClose: () => void
  onPatchOwner: (patch: Partial<RegistryOwnerRow>) => void
  onPatchShare: (
    propertyId: string,
    patch: {
      first_visit_at?: string | null
      first_visit_status?: string
      second_visit_at?: string | null
      second_visit_status?: string
      notes?: string
    },
  ) => void
}) {
  return (
    <div className="w-[32rem] border-l bg-slate-50 overflow-auto flex-shrink-0">
      <div className="flex items-center justify-between border-b bg-white px-3 py-2">
        <div className="text-sm font-semibold">{owner.name}</div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-slate-100"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <Section title="基本情報">
        <EditableRow
          label="氏名"
          value={owner.name}
          onCommit={(v) => onPatchOwner({ name: v })}
        />
        <EditableRow
          label="住所"
          value={owner.address}
          onCommit={(v) => onPatchOwner({ address: v })}
        />
        <EditableRow
          label="電話"
          value={owner.phone}
          onCommit={(v) => onPatchOwner({ phone: v })}
        />
      </Section>

      <Section title="代理人">
        <EditableRow
          label="氏名"
          value={owner.agent_name}
          onCommit={(v) => onPatchOwner({ agent_name: v })}
        />
        <EditableRow
          label="住所"
          value={owner.agent_address}
          onCommit={(v) => onPatchOwner({ agent_address: v })}
        />
        <EditableRow
          label="電話"
          value={owner.agent_phone}
          onCommit={(v) => onPatchOwner({ agent_phone: v })}
        />
      </Section>

      <Section title="備考">
        <EditableRow
          label=""
          value={owner.notes}
          onCommit={(v) => onPatchOwner({ notes: v })}
          multiline
        />
      </Section>

      <Section title={`保有地番 (${owner.parcels.length})`}>
        {owner.parcels.map((p) => (
          <li
            key={p.property_id}
            className="border-t px-3 py-2 text-xs first:border-t-0"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-slate-800">
                {p.parcel_number || '（地番なし）'}
              </span>
              {p.location && (
                <span className="text-slate-500">{p.location}</span>
              )}
              {p.share && (
                <span className="text-slate-500">・{p.share}</span>
              )}
            </div>
            <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 items-center">
              <span className="text-slate-500">一次立会 日時</span>
              <input
                type="datetime-local"
                value={tsToLocal(p.first_visit_at)}
                onChange={(e) =>
                  onPatchShare(p.property_id, {
                    first_visit_at: localToTs(e.target.value),
                  })
                }
                className="rounded border px-1 py-0.5 text-xs"
              />
              <span className="text-slate-500">一次立会 状況</span>
              <VisitStatusInput
                value={p.first_visit_status}
                onChange={(v) =>
                  onPatchShare(p.property_id, { first_visit_status: v })
                }
              />
              <span className="text-slate-500">二次立会 日時</span>
              <input
                type="datetime-local"
                value={tsToLocal(p.second_visit_at)}
                onChange={(e) =>
                  onPatchShare(p.property_id, {
                    second_visit_at: localToTs(e.target.value),
                  })
                }
                className="rounded border px-1 py-0.5 text-xs"
              />
              <span className="text-slate-500">二次立会 状況</span>
              <VisitStatusInput
                value={p.second_visit_status}
                onChange={(v) =>
                  onPatchShare(p.property_id, { second_visit_status: v })
                }
              />
              <span className="text-slate-500">メモ</span>
              <EditableRow
                label=""
                value={p.notes}
                onCommit={(v) => onPatchShare(p.property_id, { notes: v })}
                inline
              />
            </div>
          </li>
        ))}
      </Section>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <div className="border-b">
      <div className="bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
        {title}
      </div>
      <ul>{children}</ul>
    </div>
  )
}

function EditableRow({
  label,
  value,
  onCommit,
  multiline,
  inline,
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  multiline?: boolean
  inline?: boolean
}) {
  const [draft, setDraft] = useState(value)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    setDraft(value)
    setDirty(false)
  }, [value])

  const commit = () => {
    if (draft === value) {
      setDirty(false)
      return
    }
    onCommit(draft)
    setDirty(false)
  }

  const InputEl = multiline ? 'textarea' : 'input'
  const input = (
    <InputEl
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        setDirty(true)
      }}
      onBlur={commit}
      className={`w-full rounded border px-1 py-0.5 text-xs ${
        multiline ? 'min-h-[3rem]' : ''
      }`}
    />
  )

  if (inline) return input

  return (
    <li className="flex gap-2 px-3 py-1.5 text-xs items-start">
      {label && (
        <span className="w-16 flex-shrink-0 pt-0.5 text-slate-500">{label}</span>
      )}
      <div className="flex-1">{input}</div>
      {dirty && <Save className="h-3.5 w-3.5 text-blue-500 flex-shrink-0 mt-1" />}
    </li>
  )
}
