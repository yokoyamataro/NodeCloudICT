// 地番管理 の 右パネル (aside) 上部 に 出す 「地番詳細」 欄。
//
// 選ばれた 1 筆 の 主要属性 を inline で 編集 する。
// フィールド: 所在 / 地番 / 登記地目 / 登記地積 / 登記所有者氏名。
// blur で parcelStore.upsertParcel を 呼んで 保存。
//
// フィールドの 完全な 列 (属性・所有者連結 など) は 従来 の
// CadastralRowFields (地番一覧表 の 1 行) を 使い分ける。
// ここ は 「筆を 触って いる 最中」 に すぐ 直したい 主要項目 だけ を 出す。

import { useEffect, useState } from 'react'
import type { ParcelEditableFields } from '@/stores/parcelStore'
import type { Parcel } from '@/types/database'
import { LAND_CATEGORIES } from '@/lib/landCategory'

interface Props {
  workAreaId: string
  parcel: Parcel | null
  onPatch: (patch: Partial<ParcelEditableFields>) => void
  readOnly?: boolean
}

// timestamptz / null 対策の 表示⇔編集 変換
const numStr = (n: number | null | undefined): string =>
  n == null ? '' : String(n)
const parseNum = (s: string): number | null => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function ParcelDetailsSection({ workAreaId: _workAreaId, parcel, onPatch, readOnly = false }: Props) {
  const [location, setLocation] = useState(parcel?.location ?? '')
  const [parcelNumber, setParcelNumber] = useState(parcel?.parcel_number ?? '')
  const [category, setCategory] = useState(parcel?.registered_land_category ?? '')
  const [area, setArea] = useState<string>(numStr(parcel?.registered_area_sqm))
  const [owner, setOwner] = useState(parcel?.registered_owner_name ?? '')

  // parcel が 差し替わったら state を 再同期
  useEffect(() => {
    setLocation(parcel?.location ?? '')
    setParcelNumber(parcel?.parcel_number ?? '')
    setCategory(parcel?.registered_land_category ?? '')
    setArea(numStr(parcel?.registered_area_sqm))
    setOwner(parcel?.registered_owner_name ?? '')
  }, [parcel?.id, parcel?.location, parcel?.parcel_number, parcel?.registered_land_category, parcel?.registered_area_sqm, parcel?.registered_owner_name])

  const commit = (patch: Partial<ParcelEditableFields>) => {
    if (readOnly) return
    onPatch(patch)
  }

  return (
    <div className="px-3 py-2 border-b bg-slate-50 shrink-0 space-y-1.5">
      <div className="text-[10px] text-slate-500 font-medium uppercase tracking-wide">
        地番詳細
      </div>
      <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
        <label className="text-slate-500">所在</label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onBlur={() => commit({ location: location.trim() || null })}
          disabled={readOnly}
          className="px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100"
          placeholder="所在"
        />
        <label className="text-slate-500">地番</label>
        <input
          type="text"
          value={parcelNumber}
          onChange={(e) => setParcelNumber(e.target.value)}
          onBlur={() => commit({ parcel_number: parcelNumber.trim() || null })}
          disabled={readOnly}
          className="px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100"
          placeholder="例: 10-6"
        />
        <label className="text-slate-500">地目</label>
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            commit({ registered_land_category: e.target.value || null })
          }}
          disabled={readOnly}
          className="px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100"
        >
          <option value="">(未設定)</option>
          {LAND_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="text-slate-500">登記地積</label>
        <div className="flex items-center gap-1">
          <input
            type="number"
            step="0.01"
            value={area}
            onChange={(e) => setArea(e.target.value)}
            onBlur={() => commit({ registered_area_sqm: parseNum(area) })}
            disabled={readOnly}
            className="flex-1 px-1.5 py-0.5 border rounded text-xs font-mono bg-white disabled:bg-slate-100"
            placeholder="m²"
          />
          <span className="text-slate-400 text-[10px]">m²</span>
        </div>
        <label className="text-slate-500">所有者</label>
        <input
          type="text"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          onBlur={() => commit({ registered_owner_name: owner.trim() || null })}
          disabled={readOnly}
          className="px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100"
          placeholder="登記所有者氏名"
        />
      </div>
    </div>
  )
}
