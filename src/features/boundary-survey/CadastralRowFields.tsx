// 地籍（境界測量）用: 地番一覧の 1 行ぶんの属性セル群。
// GenericWorkAreaPage の行ヘッダーで通常の 3 列（区域番号 / 点数 / 面積）の
// 代わりに使う。inline 編集で onBlur 時に parcels テーブルへ upsert する。
//
// 編集中の地番だけでなく、行を開いていなくても表内でそのまま編集できる。
// 数値・日付の入力はローカルドラフトに溜め、onBlur で保存。

import { useEffect, useState } from 'react'
import type { WorkAreaRow } from '@/stores/workAreaStore'
import { useParcelStore, type ParcelEditableFields } from '@/stores/parcelStore'
import { LAND_CATEGORIES } from '@/lib/landCategory'

interface Props {
  area: WorkAreaRow
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

export function CadastralRowFields({ area }: Props) {
  const parcel = useParcelStore((s) => s.byWorkAreaId.get(area.id))
  const upsertParcel = useParcelStore((s) => s.upsertParcel)

  // 各セルのローカルドラフト。parcel が変わった（外部更新・初回 fetch）ら同期。
  const [parcelNumber, setParcelNumber] = useState(parcel?.parcel_number ?? '')
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
    setParcelNumber(parcel?.parcel_number ?? '')
    setRegCategory(parcel?.registered_land_category ?? '')
    setRegArea(parcel?.registered_area_sqm == null ? '' : String(parcel.registered_area_sqm))
    setUpdCategory(parcel?.updated_land_category ?? '')
    setUpdArea(parcel?.updated_area_sqm == null ? '' : String(parcel.updated_area_sqm))
    setOwnerName(parcel?.owner_name ?? '')
    setOwnerAddress(parcel?.owner_address ?? '')
    setAttendedAt(toLocalInput(parcel?.attended_at ?? null))
  }, [parcel])

  const save = (patch: Partial<ParcelEditableFields>) => {
    void upsertParcel(area.id, patch)
  }

  // セルが行クリックの展開を発火しないように stopPropagation
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div className="flex-1 overflow-x-auto" onClick={stop}>
      <div className="flex items-center gap-1 text-xs whitespace-nowrap min-w-max">
        <Cell label="地番" width="w-28">
          <input
            type="text"
            value={parcelNumber}
            onChange={(e) => setParcelNumber(e.target.value)}
            onClick={stop}
            onBlur={() => save({ parcel_number: parcelNumber.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
            placeholder="地番"
          />
        </Cell>
        <Cell label="登記地目" width="w-24">
          <LandCategoryCell
            value={regCategory}
            onChange={(v) => {
              setRegCategory(v)
              save({ registered_land_category: v || null })
            }}
            onClick={stop}
          />
        </Cell>
        <Cell label="登記地積(m²)" width="w-24">
          <input
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={regArea}
            onChange={(e) => setRegArea(e.target.value)}
            onClick={stop}
            onBlur={() => save({ registered_area_sqm: num(regArea) })}
            className="w-full px-1.5 py-1 border rounded text-right font-mono text-sm"
          />
        </Cell>
        <Cell label="変更地目" width="w-24">
          <LandCategoryCell
            value={updCategory}
            onChange={(v) => {
              setUpdCategory(v)
              save({ updated_land_category: v || null })
            }}
            onClick={stop}
          />
        </Cell>
        <Cell label="変更地積(m²)" width="w-24">
          <input
            type="number"
            step="0.0001"
            inputMode="decimal"
            value={updArea}
            onChange={(e) => setUpdArea(e.target.value)}
            onClick={stop}
            onBlur={() => save({ updated_area_sqm: num(updArea) })}
            className="w-full px-1.5 py-1 border rounded text-right font-mono text-sm"
          />
        </Cell>
        <Cell label="所有者氏名" width="w-32">
          <input
            type="text"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            onClick={stop}
            onBlur={() => save({ owner_name: ownerName.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        </Cell>
        <Cell label="所有者住所" width="w-48">
          <input
            type="text"
            value={ownerAddress}
            onChange={(e) => setOwnerAddress(e.target.value)}
            onClick={stop}
            onBlur={() => save({ owner_address: ownerAddress.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        </Cell>
        <Cell label="立会日時" width="w-44">
          <input
            type="datetime-local"
            value={attendedAt}
            onChange={(e) => setAttendedAt(e.target.value)}
            onClick={stop}
            onBlur={() => save({ attended_at: fromLocalInput(attendedAt) })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        </Cell>
        <Cell label="点数" width="w-12">
          <div className="px-1.5 py-1 text-center text-slate-600">{area.points.length}</div>
        </Cell>
        <Cell label="面積(ha)" width="w-20">
          <div className="px-1.5 py-1 text-right font-mono text-slate-700">
            {area.areaHa !== null ? area.areaHa.toFixed(4) : '-'}
          </div>
        </Cell>
      </div>
    </div>
  )
}

function Cell({
  label,
  width,
  children,
}: {
  label: string
  width: string
  children: React.ReactNode
}) {
  return (
    <div className={`flex flex-col ${width}`}>
      <span className="text-[10px] text-slate-500 leading-none px-1 pb-0.5">{label}</span>
      {children}
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
