// 境界測量（地籍）: 1 地番ぶんの属性編集パネル。
// design_work_areas（ポリゴン形状）と 1:1 の parcels テーブルへ upsert する。
//
// 使い方: <ParcelAttributesPanel workAreaId={area.id} />
//
// ・編集中はローカルドラフトに溜め、「保存」ボタンで upsert
// ・地目は 23 地目セレクト（src/lib/landCategory.ts）
// ・立会日時は datetime-local（DB 側は timestamptz）

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Save, RotateCcw } from 'lucide-react'
import { useParcelStore, type ParcelEditableFields } from '@/stores/parcelStore'
import { LAND_CATEGORIES } from '@/lib/landCategory'

interface Props {
  workAreaId: string
}

interface Draft {
  parcel_number: string
  registered_land_category: string
  registered_area_sqm: string
  updated_land_category: string
  updated_area_sqm: string
  owner_address: string
  owner_name: string
  attended_at_local: string // datetime-local 用（YYYY-MM-DDTHH:mm）
  notes: string
}

const EMPTY_DRAFT: Draft = {
  parcel_number: '',
  registered_land_category: '',
  registered_area_sqm: '',
  updated_land_category: '',
  updated_area_sqm: '',
  owner_address: '',
  owner_name: '',
  attended_at_local: '',
  notes: '',
}

// timestamptz → datetime-local 文字列 (ローカルタイム表示)
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// datetime-local 文字列 → ISO（タイムゾーン込み）
function fromLocalInput(s: string): string | null {
  if (!s) return null
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

const num = (s: string): number | null => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function ParcelAttributesPanel({ workAreaId }: Props) {
  const parcel = useParcelStore((s) => s.byWorkAreaId.get(workAreaId))
  const upsertParcel = useParcelStore((s) => s.upsertParcel)
  const storeError = useParcelStore((s) => s.error)

  // 初期ドラフト
  const initial = useMemo<Draft>(() => {
    if (!parcel) return EMPTY_DRAFT
    return {
      parcel_number: parcel.parcel_number ?? '',
      registered_land_category: parcel.registered_land_category ?? '',
      registered_area_sqm:
        parcel.registered_area_sqm == null ? '' : String(parcel.registered_area_sqm),
      updated_land_category: parcel.updated_land_category ?? '',
      updated_area_sqm:
        parcel.updated_area_sqm == null ? '' : String(parcel.updated_area_sqm),
      owner_address: parcel.owner_address ?? '',
      owner_name: parcel.owner_name ?? '',
      attended_at_local: toLocalInput(parcel.attended_at),
      notes: parcel.notes ?? '',
    }
  }, [parcel])

  const [draft, setDraft] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  // 別工区へ移動 / 別 area を選んだら ドラフトを取り直す
  useEffect(() => {
    setDraft(initial)
    setLocalError(null)
  }, [initial])

  const dirty = useMemo(() => {
    const k = Object.keys(initial) as (keyof Draft)[]
    return k.some((key) => draft[key] !== initial[key])
  }, [draft, initial])

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
  }

  const handleSave = async () => {
    setLocalError(null)
    // 数値バリデーション
    const reg = draft.registered_area_sqm.trim()
    const upd = draft.updated_area_sqm.trim()
    if (reg && num(reg) == null) {
      setLocalError('登記地積は数値で入力してください')
      return
    }
    if (upd && num(upd) == null) {
      setLocalError('変更地積は数値で入力してください')
      return
    }
    setSaving(true)
    const fields: Partial<ParcelEditableFields> = {
      parcel_number: draft.parcel_number.trim() || null,
      registered_land_category: draft.registered_land_category || null,
      registered_area_sqm: num(reg),
      updated_land_category: draft.updated_land_category || null,
      updated_area_sqm: num(upd),
      owner_address: draft.owner_address.trim() || null,
      owner_name: draft.owner_name.trim() || null,
      attended_at: fromLocalInput(draft.attended_at_local),
      notes: draft.notes.trim() || null,
    }
    const ok = await upsertParcel(workAreaId, fields)
    setSaving(false)
    if (!ok) setLocalError(storeError ?? '保存に失敗しました')
  }

  const handleReset = () => {
    setDraft(initial)
    setLocalError(null)
  }

  return (
    <div className="border-t bg-amber-50/40 px-3 py-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-amber-900">地番属性</div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleReset}
            disabled={!dirty || saving}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-white disabled:opacity-40"
          >
            <RotateCcw className="h-3 w-3" />
            戻す
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className={`flex items-center gap-1 px-3 py-1 text-xs rounded font-medium ${
              dirty
                ? 'bg-amber-600 text-white hover:bg-amber-700'
                : 'bg-slate-200 text-slate-400 cursor-not-allowed'
            } disabled:opacity-60`}
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            保存
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs">
        <Field label="地番">
          <input
            type="text"
            value={draft.parcel_number}
            onChange={(e) => set('parcel_number', e.target.value)}
            className="w-full px-2 py-1 text-sm border rounded bg-white"
          />
        </Field>
        <Field label="立会日時">
          <input
            type="datetime-local"
            value={draft.attended_at_local}
            onChange={(e) => set('attended_at_local', e.target.value)}
            className="w-full px-2 py-1 text-sm border rounded bg-white"
          />
        </Field>

        <Field label="登記地目">
          <LandCategorySelect
            value={draft.registered_land_category}
            onChange={(v) => set('registered_land_category', v)}
          />
        </Field>
        <Field label="登記地積 (m²)">
          <input
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={draft.registered_area_sqm}
            onChange={(e) => set('registered_area_sqm', e.target.value)}
            className="w-full px-2 py-1 text-sm border rounded bg-white text-right font-mono"
          />
        </Field>

        <Field label="変更地目">
          <LandCategorySelect
            value={draft.updated_land_category}
            onChange={(v) => set('updated_land_category', v)}
          />
        </Field>
        <Field label="変更地積 (m²)">
          <input
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={draft.updated_area_sqm}
            onChange={(e) => set('updated_area_sqm', e.target.value)}
            className="w-full px-2 py-1 text-sm border rounded bg-white text-right font-mono"
          />
        </Field>

        <Field label="所有者氏名">
          <input
            type="text"
            value={draft.owner_name}
            onChange={(e) => set('owner_name', e.target.value)}
            className="w-full px-2 py-1 text-sm border rounded bg-white"
          />
        </Field>
        <Field label="所有者住所">
          <input
            type="text"
            value={draft.owner_address}
            onChange={(e) => set('owner_address', e.target.value)}
            className="w-full px-2 py-1 text-sm border rounded bg-white"
          />
        </Field>

        <div className="col-span-2">
          <Field label="メモ">
            <textarea
              value={draft.notes}
              onChange={(e) => set('notes', e.target.value)}
              rows={2}
              className="w-full px-2 py-1 text-sm border rounded bg-white"
            />
          </Field>
        </div>
      </div>

      {localError && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
          {localError}
        </div>
      )}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-slate-600 mb-0.5">{label}</span>
      {children}
    </label>
  )
}

function LandCategorySelect({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-2 py-1 text-sm border rounded bg-white"
    >
      <option value="">（未設定）</option>
      {LAND_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}
