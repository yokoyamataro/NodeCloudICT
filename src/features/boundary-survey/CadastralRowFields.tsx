// 地籍（境界測量）用: 地番一覧の 1 行ぶんの属性セル群。
// GenericWorkAreaPage の行ヘッダーで通常の 3 列（区域番号 / 点数 / 面積）の
// 代わりに使う。inline 編集で onBlur 時に parcels テーブルへ upsert する。
//
// 表示する列は visibleColumns で絞れる（地番リスト上部の列選択ボタンと連動）。

import { useEffect, useState } from 'react'
import type { WorkAreaRow } from '@/stores/workAreaStore'
import { useParcelStore, type ParcelEditableFields } from '@/stores/parcelStore'
import { useLandownerStore } from '@/stores/landownerStore'
import { useFarmStore } from '@/stores/farmStore'
import {
  useParcelAttributeTypesStore,
  UNSELECTED_ATTRIBUTE,
  EMPTY_ATTRIBUTES,
} from '@/stores/parcelAttributeTypesStore'
import { LAND_CATEGORIES } from '@/lib/landCategory'

// 列の正準キー。表示順を兼ねる。
export const CADASTRAL_COLUMN_KEYS = [
  'attribute',
  'location',
  'parcel_number',
  'registered_land_category',
  'registered_area_sqm',
  'updated_land_category',
  'updated_area_sqm',
  'registered_owner_name',
  'registered_owner_address',
  'landowners',
  'points_count',
  'computed_area_sqm',
] as const

export type CadastralColumnKey = (typeof CADASTRAL_COLUMN_KEYS)[number]

export const CADASTRAL_COLUMN_LABELS: Record<CadastralColumnKey, string> = {
  attribute: '属性',
  location: '所在',
  parcel_number: '地番',
  registered_land_category: '登記地目',
  registered_area_sqm: '登記地積(m²)',
  updated_land_category: '変更地目',
  updated_area_sqm: '変更地積(m²)',
  registered_owner_name: '登記所有者氏名',
  registered_owner_address: '登記所有者住所',
  landowners: '地権者',
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
const num = (s: string): number | null => {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// 各列の幅クラス。CadastralHeader と CadastralRowFields で共有して見出しと行を揃える。
export const CADASTRAL_COLUMN_WIDTH: Record<CadastralColumnKey, string> = {
  attribute: 'w-24',
  location: 'w-40',
  parcel_number: 'w-28',
  registered_land_category: 'w-24',
  registered_area_sqm: 'w-24',
  updated_land_category: 'w-24',
  updated_area_sqm: 'w-24',
  registered_owner_name: 'w-32',
  registered_owner_address: 'w-48',
  landowners: 'w-44',
  points_count: 'w-12',
  computed_area_sqm: 'w-28',
}

// 同上を px 換算（sticky-left の left 値計算に使う）
const CADASTRAL_COLUMN_WIDTH_PX: Record<CadastralColumnKey, number> = {
  attribute: 96,
  location: 160,
  parcel_number: 112,
  registered_land_category: 96,
  registered_area_sqm: 96,
  updated_land_category: 96,
  updated_area_sqm: 96,
  registered_owner_name: 128,
  registered_owner_address: 192,
  landowners: 176,
  points_count: 48,
  computed_area_sqm: 112,
}
// gap-1 = 4px、行 px-3 padding = 12px、leading（編集 + PDF閲覧）= 80px (w-20)
const CADASTRAL_GAP_PX = 4
const CADASTRAL_ROW_PAD_LEFT_PX = 12
const CADASTRAL_LEADING_WIDTH_PX = 80

/** 指定列の sticky-left オフセットを返す。
 *  leading（編集ボタン）+ それより左にある可視列の幅を合算する。 */
export function cadastralStickyLeftPx(
  key: CadastralColumnKey,
  visibleColumns: ReadonlySet<CadastralColumnKey>,
): number {
  let offset =
    CADASTRAL_ROW_PAD_LEFT_PX +
    CADASTRAL_LEADING_WIDTH_PX +
    CADASTRAL_GAP_PX
  for (const k of CADASTRAL_COLUMN_KEYS) {
    if (k === key) return offset
    if (visibleColumns.has(k)) {
      offset += CADASTRAL_COLUMN_WIDTH_PX[k] + CADASTRAL_GAP_PX
    }
  }
  return offset
}

// sticky-left を適用する列の集合。左端の数列を常に見えるようにする。
// 編集ボタンは行の外側で別途 sticky 化されている。
export const CADASTRAL_STICKY_COLUMNS = new Set<CadastralColumnKey>([
  'location',
  'parcel_number',
])

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
  const [location, setLocation] = useState(parcel?.location ?? '')
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
  const [ownerName, setOwnerName] = useState(parcel?.registered_owner_name ?? '')
  const [ownerAddress, setOwnerAddress] = useState(parcel?.registered_owner_address ?? '')

  useEffect(() => {
    setLocation(parcel?.location ?? '')
    setParcelNumber(parcel?.parcel_number ?? parcelNumberFallback)
    setRegCategory(parcel?.registered_land_category ?? '')
    setRegArea(parcel?.registered_area_sqm == null ? '' : String(parcel.registered_area_sqm))
    setUpdCategory(parcel?.updated_land_category ?? '')
    setUpdArea(parcel?.updated_area_sqm == null ? '' : String(parcel.updated_area_sqm))
    setOwnerName(parcel?.registered_owner_name ?? '')
    setOwnerAddress(parcel?.registered_owner_address ?? '')
  }, [parcel, parcelNumberFallback])

  // 地番属性 (parcel_attribute_types)。プロジェクト単位で fetch 済みを参照。
  const projectId = useFarmStore((s) => s.currentFarm?.project_id ?? null)
  const attributeTypes = useParcelAttributeTypesStore((s) =>
    projectId ? s.byProject.get(projectId) ?? EMPTY_ATTRIBUTES : EMPTY_ATTRIBUTES,
  )
  const currentAttribute = parcel?.attribute_code
    ? attributeTypes.find((t) => t.code === parcel.attribute_code)
    : undefined

  // 地番に割り当てられた地権者（複数可）
  const landownersOfFarm = useLandownerStore((s) => s.landowners)
  const assignmentMap = useLandownerStore((s) => s.landownersByParcelId)
  const setParcelAssignment = useLandownerStore((s) => s.setParcelAssignment)
  const parcelId = parcel?.id ?? null
  const assignedIds = parcelId ? assignmentMap.get(parcelId) ?? [] : []
  const assignedNames = assignedIds
    .map((id) => landownersOfFarm.find((l) => l.id === id)?.full_name ?? '')
    .filter(Boolean)
  const [assignOpen, setAssignOpen] = useState(false)

  const save = (patch: Partial<ParcelEditableFields>) => {
    void upsertParcel(area.id, patch)
  }

  // セルが行クリックの展開を発火しないように stopPropagation
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  const cellFor = (key: CadastralColumnKey): React.ReactNode => {
    switch (key) {
      case 'attribute':
        return (
          <div className="flex items-center border rounded overflow-hidden bg-white">
            <span
              className="w-3 h-6 shrink-0"
              style={{
                backgroundColor:
                  currentAttribute?.color ?? UNSELECTED_ATTRIBUTE.color,
              }}
              title={
                currentAttribute
                  ? currentAttribute.label
                  : UNSELECTED_ATTRIBUTE.label
              }
            />
            <select
              value={parcel?.attribute_code ?? ''}
              onChange={(e) => {
                const v = e.target.value
                save({ attribute_code: v ? v : null })
              }}
              onClick={stop}
              className="w-full px-1 py-1 text-xs outline-none bg-transparent"
            >
              <option value="">未選択</option>
              {attributeTypes.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )
      case 'location':
        // 「郡町村 (municipality)」は import 時 (or 登記取得モーダル) で埋まる。
        // 表示では左側に薄色の prefix として出す。編集対象は字名のみ。
        // 都道府県は touki.or.jp 通信時に使うだけで、行表示には出さない。
        return (
          <div className="flex items-center w-full border rounded overflow-hidden">
            {parcel?.municipality && (
              <span
                className="px-1.5 py-1 text-xs text-slate-500 bg-slate-50 border-r shrink-0 truncate max-w-[120px]"
                title={`郡町村: ${parcel.municipality}${parcel.prefecture ? ` (${parcel.prefecture})` : ''}`}
              >
                {parcel.municipality}
              </span>
            )}
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onClick={stop}
              onBlur={() => save({ location: location.trim() || null })}
              className="w-full px-1.5 py-1 text-sm outline-none"
              placeholder="字名 (例: 青葉町)"
            />
          </div>
        )
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
      case 'registered_owner_name':
        return (
          <input
            type="text"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            onClick={stop}
            onBlur={() => save({ registered_owner_name: ownerName.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        )
      case 'registered_owner_address':
        return (
          <input
            type="text"
            value={ownerAddress}
            onChange={(e) => setOwnerAddress(e.target.value)}
            onClick={stop}
            onBlur={() => save({ registered_owner_address: ownerAddress.trim() || null })}
            className="w-full px-1.5 py-1 border rounded text-sm"
          />
        )
      case 'landowners':
        return (
          <button
            type="button"
            onClick={(e) => {
              stop(e)
              setAssignOpen(true)
            }}
            className="w-full px-1.5 py-1 border rounded text-left text-sm bg-white hover:bg-slate-50 truncate"
            title={assignedNames.join('、') || 'クリックして地権者を割り当て'}
          >
            {assignedNames.length === 0 ? (
              <span className="text-slate-400">割当なし</span>
            ) : (
              assignedNames.join('、')
            )}
          </button>
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
    <>
      <div className="flex items-center gap-1 text-xs whitespace-nowrap" onClick={stop}>
        {CADASTRAL_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => {
          const isSticky = CADASTRAL_STICKY_COLUMNS.has(key)
          return (
            <div
              key={key}
              className={`${CADASTRAL_COLUMN_WIDTH[key]} shrink-0 ${
                isSticky ? 'sticky z-10 bg-white' : ''
              }`}
              style={
                isSticky
                  ? { left: cadastralStickyLeftPx(key, visibleColumns) + 'px' }
                  : undefined
              }
            >
              {cellFor(key)}
            </div>
          )
        })}
      </div>
      {assignOpen && parcelId && (
        <LandownerAssignModal
          parcelLabel={parcel?.parcel_number || area.zoneNumber || area.name || '(無題)'}
          landowners={landownersOfFarm}
          assignedIds={assignedIds}
          onClose={() => setAssignOpen(false)}
          onSave={async (ids) => {
            await setParcelAssignment(parcelId, ids)
            setAssignOpen(false)
          }}
        />
      )}
    </>
  )
}

// 地番に紐づける地権者をチェックボックスで選ぶモーダル
function LandownerAssignModal({
  parcelLabel,
  landowners,
  assignedIds,
  onClose,
  onSave,
}: {
  parcelLabel: string
  landowners: Array<{ id: string; full_name: string }>
  assignedIds: string[]
  onClose: () => void
  onSave: (ids: string[]) => Promise<void> | void
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(assignedIds))
  const [saving, setSaving] = useState(false)
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b">
          <h3 className="text-base font-semibold">地番「{parcelLabel}」の地権者</h3>
          <div className="text-xs text-slate-500 mt-1">
            共有名義の場合は複数選択できます。
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2">
          {landowners.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">
              地権者がまだ登録されていません。地権者管理から追加してください。
            </div>
          ) : (
            <ul className="space-y-1">
              {landowners.map((lo) => {
                const on = selected.has(lo.id)
                return (
                  <li key={lo.id}>
                    <label
                      className={`flex items-center gap-2 px-3 py-2 rounded cursor-pointer text-sm ${
                        on ? 'bg-blue-50 text-blue-800' : 'hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggle(lo.id)}
                        className="h-4 w-4"
                      />
                      <span className="flex-1 truncate">{lo.full_name}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={async () => {
              setSaving(true)
              try {
                await onSave(Array.from(selected))
              } finally {
                setSaving(false)
              }
            }}
            disabled={saving}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
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
