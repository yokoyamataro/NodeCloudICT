// スマホの「地番」一覧パネル。工区配下の地番 (work_areas + parcels + landowners)
// を表示し、列の表示/非表示を切替できる。desktop の CadastralRowFields と
// 同じ列を提供するが、スマホ用にコンパクト表示。

import { useEffect, useMemo, useState } from 'react'
import { Settings2, X } from 'lucide-react'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { useParcelStore } from '@/stores/parcelStore'
import { useLandownerStore } from '@/stores/landownerStore'
import { compareByLocationAndParcel } from '@/lib/parcelSort'
import { MobileListColumnPicker, type ColumnDef } from './MobileListColumnPicker'
import { MobileParcelEditModal } from './MobileParcelEditModal'

export const PARCEL_COLUMN_KEYS = [
  'parcel_number',
  'location',
  'registered_land_category',
  'registered_area_sqm',
  'updated_land_category',
  'updated_area_sqm',
  'registered_owner_address',
  'registered_owner_name',
  'landowners',
] as const
export type ParcelColumnKey = (typeof PARCEL_COLUMN_KEYS)[number]

const PARCEL_COLUMNS: ReadonlyArray<ColumnDef<ParcelColumnKey>> = [
  { key: 'parcel_number', label: '地番' },
  { key: 'location', label: '所在' },
  { key: 'registered_land_category', label: '登記地目' },
  { key: 'registered_area_sqm', label: '登記地積(m²)' },
  { key: 'updated_land_category', label: '変更地目' },
  { key: 'updated_area_sqm', label: '変更地積(m²)' },
  { key: 'registered_owner_address', label: '登記所有者住所' },
  { key: 'registered_owner_name', label: '登記所有者氏名' },
  { key: 'landowners', label: '地権者' },
]

const REQUIRED_KEYS: ReadonlyArray<ParcelColumnKey> = ['parcel_number']

interface Props {
  farmId: string
  visibleColumns: ReadonlySet<ParcelColumnKey>
  onChangeColumns: (next: ReadonlySet<ParcelColumnKey>) => void
  onClose: () => void
}

function fmtArea(n: number | null | undefined): string {
  if (n == null) return '-'
  if (!Number.isFinite(n)) return '-'
  return n.toFixed(2)
}

export function MobileParcelListPanel({
  farmId,
  visibleColumns,
  onChangeColumns,
  onClose,
}: Props) {
  const areas = useWorkAreaStore(
    (s) => s.workAreas['boundary_survey'] ?? [],
  )
  const parcelsByWorkAreaId = useParcelStore((s) => s.byWorkAreaId)
  const landowners = useLandownerStore((s) => s.landowners)
  const landownersByParcelId = useLandownerStore(
    (s) => s.landownersByParcelId,
  )
  const fetchLandowners = useLandownerStore((s) => s.fetchByFarm)
  const fetchAssignments = useLandownerStore((s) => s.fetchAssignmentsByFarm)
  const [showPicker, setShowPicker] = useState(false)
  // タップで開く 地番編集モーダル
  const [editingRow, setEditingRow] = useState<{
    areaId: string
    parcelNumber: string
  } | null>(null)

  useEffect(() => {
    void fetchLandowners(farmId)
    void fetchAssignments(farmId)
  }, [farmId, fetchLandowners, fetchAssignments])

  const landownerNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const l of landowners) m.set(l.id, l.full_name)
    return m
  }, [landowners])

  const rows = useMemo(() => {
    const out = areas
      .map((a) => {
        const p = parcelsByWorkAreaId.get(a.id) ?? null
        const parcelNum = p?.parcel_number || a.zoneNumber || a.name || ''
        const location = p?.location ?? ''
        const landownerNames: string[] = []
        if (p?.id) {
          const ids = landownersByParcelId.get(p.id) ?? []
          for (const lid of ids) {
            const nm = landownerNameById.get(lid)
            if (nm) landownerNames.push(nm)
          }
        }
        return {
          areaId: a.id,
          parcel: p,
          parcelNumber: parcelNum,
          location,
          landownerNames,
        }
      })
      .sort((x, y) =>
        compareByLocationAndParcel(
          { location: x.location, parcel_number: x.parcelNumber },
          { location: y.location, parcel_number: y.parcelNumber },
        ),
      )
    return out
  }, [areas, parcelsByWorkAreaId, landownersByParcelId, landownerNameById])

  const isVisible = (k: ParcelColumnKey) =>
    k === 'parcel_number' || visibleColumns.has(k)

  return (
    <>
      <div className="absolute inset-x-0 bottom-0 z-[1000] bg-white border-t shadow-xl max-h-[65%] flex flex-col">
        <div className="px-3 py-2 border-b flex items-center gap-2 text-sm">
          <span className="font-semibold">地番</span>
          <span className="text-xs text-slate-500">{rows.length} 件</span>
          <button
            type="button"
            onClick={() => setShowPicker(true)}
            className="ml-auto flex items-center gap-1 text-xs px-2 py-0.5 border rounded hover:bg-slate-50"
            title="表示列を設定"
          >
            <Settings2 className="h-3.5 w-3.5" />
            表示列
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-2 py-0.5 border rounded hover:bg-slate-50 flex items-center gap-1"
          >
            <X className="h-3.5 w-3.5" />
            閉じる
          </button>
        </div>
        <div className="flex-1 overflow-auto">
          {rows.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-400">
              地番がありません
            </div>
          ) : (
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-slate-50 z-10">
                <tr className="text-slate-500">
                  {isVisible('parcel_number') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">地番</th>
                  )}
                  {isVisible('location') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">所在</th>
                  )}
                  {isVisible('registered_land_category') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">
                      登記地目
                    </th>
                  )}
                  {isVisible('registered_area_sqm') && (
                    <th className="px-2 py-1 text-right whitespace-nowrap">
                      登記地積
                    </th>
                  )}
                  {isVisible('updated_land_category') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">
                      変更地目
                    </th>
                  )}
                  {isVisible('updated_area_sqm') && (
                    <th className="px-2 py-1 text-right whitespace-nowrap">
                      変更地積
                    </th>
                  )}
                  {isVisible('registered_owner_address') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">
                      登記所有者住所
                    </th>
                  )}
                  {isVisible('registered_owner_name') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">
                      登記所有者氏名
                    </th>
                  )}
                  {isVisible('landowners') && (
                    <th className="px-2 py-1 text-left whitespace-nowrap">地権者</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const p = r.parcel
                  return (
                    <tr
                      key={r.areaId}
                      className="border-t hover:bg-blue-50 cursor-pointer"
                      onClick={() =>
                        setEditingRow({
                          areaId: r.areaId,
                          parcelNumber: r.parcelNumber,
                        })
                      }
                    >
                      {isVisible('parcel_number') && (
                        <td className="px-2 py-1 font-medium text-slate-800 whitespace-nowrap max-w-[6rem] truncate">
                          {r.parcelNumber || '-'}
                        </td>
                      )}
                      {isVisible('location') && (
                        <td className="px-2 py-1 text-slate-600 whitespace-nowrap max-w-[8rem] truncate">
                          {r.location || '-'}
                        </td>
                      )}
                      {isVisible('registered_land_category') && (
                        <td className="px-2 py-1 text-slate-600 whitespace-nowrap">
                          {p?.registered_land_category ?? '-'}
                        </td>
                      )}
                      {isVisible('registered_area_sqm') && (
                        <td className="px-2 py-1 text-right font-mono">
                          {fmtArea(p?.registered_area_sqm ?? null)}
                        </td>
                      )}
                      {isVisible('updated_land_category') && (
                        <td className="px-2 py-1 text-slate-600 whitespace-nowrap">
                          {p?.updated_land_category ?? '-'}
                        </td>
                      )}
                      {isVisible('updated_area_sqm') && (
                        <td className="px-2 py-1 text-right font-mono">
                          {fmtArea(p?.updated_area_sqm ?? null)}
                        </td>
                      )}
                      {isVisible('registered_owner_address') && (
                        <td className="px-2 py-1 text-slate-600 max-w-[10rem] truncate">
                          {p?.registered_owner_address ?? '-'}
                        </td>
                      )}
                      {isVisible('registered_owner_name') && (
                        <td className="px-2 py-1 text-slate-600 whitespace-nowrap max-w-[6rem] truncate">
                          {p?.registered_owner_name ?? '-'}
                        </td>
                      )}
                      {isVisible('landowners') && (
                        <td className="px-2 py-1 text-slate-600 max-w-[8rem] truncate">
                          {r.landownerNames.length === 0
                            ? '-'
                            : r.landownerNames.join(', ')}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {showPicker && (
        <MobileListColumnPicker
          title="地番: 表示列"
          columns={PARCEL_COLUMNS}
          requiredKeys={REQUIRED_KEYS}
          visible={visibleColumns}
          onChange={onChangeColumns}
          onClose={() => setShowPicker(false)}
        />
      )}
      {editingRow && (
        <MobileParcelEditModal
          workAreaId={editingRow.areaId}
          parcelNumberFallback={editingRow.parcelNumber}
          parcel={parcelsByWorkAreaId.get(editingRow.areaId) ?? null}
          onClose={() => setEditingRow(null)}
        />
      )}
    </>
  )
}
