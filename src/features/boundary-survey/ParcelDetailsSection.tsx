// 地番管理 の 右パネル (aside) 「地番情報」 タブ の 中身。
//
// 選ばれた 1 筆 の 主要属性 を inline で 編集 する。
// フィールド:
//   共通: 所在 / 地番 / 所有者
//   登記: 登記地目 / 登記地積 (登記情報 PDF・CSV 由来)
//   確定: 確定地目 / 確定地積 (立会・確定測量 後 の 変更 値)
// blur で parcelStore.upsertParcel を 呼んで 保存。
//
// 完全な 属性列 (登記CSV の 連番・区分・不動産番号 など) は 地番一覧表 の
// CadastralRowFields を 使う。 ここ は 筆 を 触って いる 最中 に すぐ 直したい
// 主要項目 だけ を 出す。

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
  const [regCategory, setRegCategory] = useState(parcel?.registered_land_category ?? '')
  const [regArea, setRegArea] = useState<string>(numStr(parcel?.registered_area_sqm))
  const [updCategory, setUpdCategory] = useState(parcel?.updated_land_category ?? '')
  const [updArea, setUpdArea] = useState<string>(numStr(parcel?.updated_area_sqm))
  const [owner, setOwner] = useState(parcel?.registered_owner_name ?? '')

  // parcel が 差し替わったら state を 再同期
  useEffect(() => {
    setLocation(parcel?.location ?? '')
    setParcelNumber(parcel?.parcel_number ?? '')
    setRegCategory(parcel?.registered_land_category ?? '')
    setRegArea(numStr(parcel?.registered_area_sqm))
    setUpdCategory(parcel?.updated_land_category ?? '')
    setUpdArea(numStr(parcel?.updated_area_sqm))
    setOwner(parcel?.registered_owner_name ?? '')
  }, [
    parcel?.id,
    parcel?.location,
    parcel?.parcel_number,
    parcel?.registered_land_category,
    parcel?.registered_area_sqm,
    parcel?.updated_land_category,
    parcel?.updated_area_sqm,
    parcel?.registered_owner_name,
  ])

  const commit = (patch: Partial<ParcelEditableFields>) => {
    if (readOnly) return
    onPatch(patch)
  }

  const inputCls =
    'px-1.5 py-0.5 border rounded text-xs bg-white disabled:bg-slate-100'
  const numInputCls =
    'flex-1 px-1.5 py-0.5 border rounded text-xs font-mono bg-white disabled:bg-slate-100'

  return (
    <div className="px-3 py-2 bg-slate-50 space-y-2">
      {/* 共通: 所在 / 地番 */}
      <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
        <label className="text-slate-500">所在</label>
        <input
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          onBlur={() => commit({ location: location.trim() || null })}
          disabled={readOnly}
          className={inputCls}
          placeholder="所在"
        />
        <label className="text-slate-500">地番</label>
        <input
          type="text"
          value={parcelNumber}
          onChange={(e) => setParcelNumber(e.target.value)}
          onBlur={() => commit({ parcel_number: parcelNumber.trim() || null })}
          disabled={readOnly}
          className={inputCls}
          placeholder="例: 10-6"
        />
      </div>

      {/* 登記 (登記簿・登記CSV の 値) */}
      <fieldset className="border border-slate-300 rounded p-2 pt-1 bg-white">
        <legend className="px-1 text-[10px] text-slate-500 font-medium uppercase tracking-wide">
          登記
        </legend>
        <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
          <label className="text-slate-500">地目</label>
          <select
            value={regCategory}
            onChange={(e) => {
              setRegCategory(e.target.value)
              commit({ registered_land_category: e.target.value || null })
            }}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(未設定)</option>
            {LAND_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="text-slate-500">地積</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              value={regArea}
              onChange={(e) => setRegArea(e.target.value)}
              onBlur={() => commit({ registered_area_sqm: parseNum(regArea) })}
              disabled={readOnly}
              className={numInputCls}
              placeholder="m²"
            />
            <span className="text-slate-400 text-[10px]">m²</span>
          </div>
        </div>
      </fieldset>

      {/* 確定 (立会・確定測量 後 の 変更 値) */}
      <fieldset className="border border-emerald-300 rounded p-2 pt-1 bg-emerald-50/40">
        <legend className="px-1 text-[10px] text-emerald-700 font-medium uppercase tracking-wide">
          確定
        </legend>
        <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
          <label className="text-slate-500">地目</label>
          <select
            value={updCategory}
            onChange={(e) => {
              setUpdCategory(e.target.value)
              commit({ updated_land_category: e.target.value || null })
            }}
            disabled={readOnly}
            className={inputCls}
          >
            <option value="">(未設定)</option>
            {LAND_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label className="text-slate-500">地積</label>
          <div className="flex items-center gap-1">
            <input
              type="number"
              step="0.01"
              value={updArea}
              onChange={(e) => setUpdArea(e.target.value)}
              onBlur={() => commit({ updated_area_sqm: parseNum(updArea) })}
              disabled={readOnly}
              className={numInputCls}
              placeholder="m²"
            />
            <span className="text-slate-400 text-[10px]">m²</span>
          </div>
        </div>
      </fieldset>

      {/* 所有者 (登記) */}
      <div className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 text-xs items-center">
        <label className="text-slate-500">所有者</label>
        <input
          type="text"
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          onBlur={() => commit({ registered_owner_name: owner.trim() || null })}
          disabled={readOnly}
          className={inputCls}
          placeholder="登記所有者氏名"
        />
      </div>
    </div>
  )
}
