// 地籍（境界測量）用: 地番一覧の 1 行ぶんの属性セル群。
// GenericWorkAreaPage の行ヘッダーで通常の 3 列（区域番号 / 点数 / 面積）の
// 代わりに使う。inline 編集で onBlur 時に parcels テーブルへ upsert する。
//
// 表示する列は visibleColumns で絞れる（地番リスト上部の列選択ボタンと連動）。

import { useEffect, useState } from 'react'
import type { WorkAreaRow } from '@/stores/workAreaStore'
import { useParcelStore, type ParcelEditableFields } from '@/stores/parcelStore'
import { LAND_CATEGORIES } from '@/lib/landCategory'

// 列の正準キー。表示順を兼ねる。
export const CADASTRAL_COLUMN_KEYS = [
  'parcel_number',
  'registered_land_category',
  'registered_area_sqm',
  'updated_land_category',
  'updated_area_sqm',
  'owner_name',
  'owner_address',
  'attended_at',
  'points_count',
  'computed_area_sqm',
] as const

export type CadastralColumnKey = (typeof CADASTRAL_COLUMN_KEYS)[number]

export const CADASTRAL_COLUMN_LABELS: Record<CadastralColumnKey, string> = {
  parcel_number: '地番',
  registered_land_category: '登記地目',
  registered_area_sqm: '登記地積(m²)',
  updated_land_category: '変更地目',
  updated_area_sqm: '変更地積(m²)',
  owner_name: '所有者氏名',
  owner_address: '所有者住所',
  attended_at: '立会日時',
  points_count: '点数',
  computed_area_sqm: '直角座標法面積(m²)',
}

// 既定で全列表示
export const DEFAULT_VISIBLE_COLUMNS: ReadonlySet<CadastralColumnKey> = new Set(
  CADASTRAL_COLUMN_KEYS,
)

interface Props {
  area: WorkAreaRow
  visibleColumns: ReadonlySet<CadastralColumnKey>
}

// timestamptz → datetime-local 文字列
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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

// 各列の幅クラス。CadastralHeader と CadastralRowFields で共有して見出しと行を揃える。
export const CADASTRAL_COLUMN_WIDTH: Record<CadastralColumnKey, string> = {
  parcel_number: 'w-28',
  registered_land_category: 'w-24',
  registered_area_sqm: 'w-24',
  updated_land_category: 'w-24',
  updated_area_sqm: 'w-24',
  owner_name: 'w-32',
  owner_address: 'w-48',
  attended_at: 'w-44',
  points_count: 'w-12',
  computed_area_sqm: 'w-28',
}

// 第 3 位以下切捨 → 小数 2 桁で表示
function truncate2(n: number): string {
  return (Math.floor(n * 100) / 100).toFixed(2)
}

export function CadastralRowFields({ area, visibleColumns }: Props) {
  const parcel = useParcelStore((s) => s.byWorkAreaId.get(area.id))
  const upsertParcel = useParcelStore((s) => s.upsertParcel)

  // 地番名のフォールバック: parcels.parcel_number が空のときは
  // design_work_areas.zoneNumber → name の順に拾う
  // （SIMA インポートで地番ラベルは zoneNumber に入っているため）
  const parcelNumberFallback = area.zoneNumber || area.name || ''

  // 各セルのローカルドラフト。parcel が変わった（外部更新・初回 fetch）ら同期。
  const [parcelNumber, setParcelNumber] = useState(
    parcel?.parcel_number ?? parcelNumberFallback,
  )
  const [regCategory, setRegCategory] = useState(parcel?.registered_land_category ?? '')
  const [regArea, setRegArea] = useState(
    parcel?.registered_area_sqm == null ? '' : String(parcel.registered_area_sqm),
  )
  const [updCategory, setUpdCategory] = useState(parcel?.updated_land_category ?? '')
  const [updArea, setUpdArea] = useState(
    parcel?.updated_area_sqm == null ? '' : String(parcel.updated_area_sqm),
  )
  const [ownerName, setOwnerName] = useState(parcel?.owner_name ?? '')
  const [ownerAddress, setOwnerAddress] = useState(parcel?.owner_address ?? '')
  const [attendedAt, setAttendedAt] = useState(toLocalInput(parcel?.attended_at ?? null))

  useEffect(() => {
    setParcelNumber(parcel?.parcel_number ?? parcelNumberFallback)
    setRegCategory(parcel?.registered_land_category ?? '')
    setRegArea(parcel?.registered_area_sqm == null ? '' : String(parcel.registered_area_sqm))
    setUpdCategory(parcel?.updated_land_category ?? '')
    setUpdArea(parcel?.updated_area_sqm == null ? '' : String(parcel.updated_area_sqm))
    setOwnerName(parcel?.owner_name ?? '')
    setOwnerAddress(parcel?.owner_address ?? '')
    setAttendedAt(toLocalInput(parcel?.attended_at ?? null))
  }, [parcel, parcelNumberFallback])

  const save = (patch: Partial<ParcelEditableFields>) => {
    void upsertParcel(area.id, patch)
  }

  // セルが行クリックの展開を発火しないように stopPropagation
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  const cellFor = (key: CadastralColumnKey): React.ReactNode => {
    switch (key) {
      case 'parcel_number':
        return (
          <input
            type="text"
            value={parcelNumber}
            onChange={(e) => setParcelNumber(e.target.value)}
            onClick={stop}
            onBlur={() => save({ parcel_number: parcelNumber.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
            placeholder="地番"
          />
        )
      case 'registered_land_category':
        return (
          <LandCategoryCell
            value={regCategory}
            onChange={(v) => {
              setRegCategory(v)
              save({ registered_land_category: v || null })
            }}
            onClick={stop}
          />
        )
      case 'registered_area_sqm':
        return (
          <input
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={regArea}
            onChange={(e) => setRegArea(e.target.value)}
            onClick={stop}
            onBlur={() => save({ registered_area_sqm: num(regArea) })}
            // フォーカス中のホイール操作で数値が勝手に増減するのを防ぐ
            onWheel={(e) => e.currentTarget.blur()}
            className="w-full px-1.5 py-1 border rounded text-right font-mono text-sm"
          />
        )
      case 'updated_land_category':
        return (
          <LandCategoryCell
            value={updCategory}
            onChange={(v) => {
              setUpdCategory(v)
              save({ updated_land_category: v || null })
            }}
            onClick={stop}
          />
        )
      case 'updated_area_sqm':
        return (
          <input
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={updArea}
            onChange={(e) => setUpdArea(e.target.value)}
            onClick={stop}
            onBlur={() => save({ updated_area_sqm: num(updArea) })}
            onWheel={(e) => e.currentTarget.blur()}
            className="w-full px-1.5 py-1 border rounded text-right font-mono text-sm"
          />
        )
      case 'owner_name':
        return (
          <input
            type="text"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            onClick={stop}
            onBlur={() => save({ owner_name: ownerName.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        )
      case 'owner_address':
        return (
          <input
            type="text"
            value={ownerAddress}
            onChange={(e) => setOwnerAddress(e.target.value)}
            onClick={stop}
            onBlur={() => save({ owner_address: ownerAddress.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        )
      case 'attended_at':
        return (
          <input
            type="datetime-local"
            value={attendedAt}
            onChange={(e) => setAttendedAt(e.target.value)}
            onClick={stop}
            onBlur={() => save({ attended_at: fromLocalInput(attendedAt) })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        )
      case 'points_count':
        return (
          <div className="px-1.5 py-1 text-center text-slate-600">{area.points.length}</div>
        )
      case 'computed_area_sqm':
        return (
          <div className="px-1.5 py-1 text-right font-mono text-slate-700">
            {area.areaSqm !== null ? truncate2(area.areaSqm) : '-'}
          </div>
        )
    }
  }

  return (
    <div className="flex items-center gap-1 text-xs whitespace-nowrap" onClick={stop}>
      {CADASTRAL_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => (
        <div key={key} className={CADASTRAL_COLUMN_WIDTH[key]}>
          {cellFor(key)}
        </div>
      ))}
    </div>
  )
}

function LandCategoryCell({
  value,
  onChange,
  onClick,
}: {
  value: string
  onChange: (v: string) => void
  onClick: (e: React.SyntheticEvent) => void
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={onClick}
      className="w-full px-1.5 py-1 border rounded text-sm bg-white"
    >
      <option value="">-</option>
      {LAND_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}
