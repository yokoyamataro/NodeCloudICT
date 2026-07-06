// 地籍測量: 地権者管理ページ（インライン編集テーブル）。
// /boundary-survey/landowners
//
// ・現工区の地権者を一覧し、各行の中でそのまま編集できる（onBlur で保存）
// ・「地権者を追加」で新規行を即時に作成（氏名は仮で「新規地権者」）
// ・表示する列は CadastralColumnPicker と同じ要領で選択可
// ・地番への割当は地番一覧側の「地権者」列モーダルから行う（このページでは行わない）

import { useEffect, useMemo, useRef, useState } from 'react'
import { Plus, Loader2, Wand2, FileText, ChevronDown } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useLandownerStore } from '@/stores/landownerStore'
import type { Landowner } from '@/types/database'
import {
  LandownerHeader,
  LandownerRowFields,
  NewLandownerRow,
} from './LandownerRowFields'
import {
  LandownerColumnPicker,
  useLandownerVisibleColumns,
} from './LandownerColumnPicker'
import { supabase } from '@/lib/supabase'
import { LandownerAutoImportModal, type FarmParcelRow } from './LandownerAutoImportModal'
import { TemplateManagerModal } from '@/features/document-templates/TemplateManagerModal'
import { TemplateExportModal } from '@/features/document-templates/TemplateExportModal'

export function LandownersPage() {
  const { currentFarm } = useFarmStore()
  const farmId = currentFarm?.id ?? null

  const landowners = useLandownerStore((s) => s.landowners)
  const loading = useLandownerStore((s) => s.loading)
  const fetchByFarm = useLandownerStore((s) => s.fetchByFarm)
  const createLandowner = useLandownerStore((s) => s.createLandowner)
  const deleteLandowner = useLandownerStore((s) => s.deleteLandowner)
  const landownersByParcelId = useLandownerStore((s) => s.landownersByParcelId)
  const error = useLandownerStore((s) => s.error)

  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [visible, setVisible] = useLandownerVisibleColumns()
  // 工区配下の地番一覧（自動取込モーダル / 所有地列の表示に使う）
  const [farmParcels, setFarmParcels] = useState<FarmParcelRow[]>([])
  const [showAutoImport, setShowAutoImport] = useState(false)
  // 書類作成メニュー
  const [docMenuOpen, setDocMenuOpen] = useState(false)
  const [showTemplateExport, setShowTemplateExport] = useState(false)
  const [showTemplateManager, setShowTemplateManager] = useState(false)
  const docMenuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!docMenuOpen) return
    const onClick = (e: MouseEvent) => {
      if (docMenuRef.current && !docMenuRef.current.contains(e.target as Node)) {
        setDocMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [docMenuOpen])

  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

  // 工区配下の parcels を取得（design_work_areas 経由）
  const reloadFarmParcels = async (fid: string) => {
    const { data, error: err } = await supabase
      .from('parcels')
      .select(
        'id, parcel_number, location, registered_owner_name, registered_owner_address, work_area:design_work_areas!inner(farm_id)',
      )
      .eq('work_area.farm_id', fid)
    if (err) {
      console.error('[LandownersPage] parcels load failed', err)
      setFarmParcels([])
      return
    }
    const rows = ((data ?? []) as unknown) as FarmParcelRow[]
    setFarmParcels(rows)
  }
  useEffect(() => {
    if (!farmId) {
      setFarmParcels([])
      return
    }
    void reloadFarmParcels(farmId)
  }, [farmId])

  // landowner_id → 所有地ラベル配列。landownersByParcelId を反転して parcel_number を引く。
  const ownedParcelLabelsByLandownerId = useMemo(() => {
    const labelByParcelId = new Map<string, string>()
    for (const p of farmParcels) {
      const label = (p.parcel_number ?? '').trim() || '(未設定)'
      labelByParcelId.set(p.id, label)
    }
    const out = new Map<string, string[]>()
    for (const [parcelId, landownerIds] of landownersByParcelId) {
      const label = labelByParcelId.get(parcelId)
      if (!label) continue
      for (const lid of landownerIds) {
        const arr = out.get(lid) ?? []
        arr.push(label)
        out.set(lid, arr)
      }
    }
    // 表示は地番のソート順で
    for (const arr of out.values()) arr.sort((a, b) => a.localeCompare(b, 'ja'))
    return out
  }, [farmParcels, landownersByParcelId])

  const filtered = useMemo(() => {
    if (!filter) return landowners
    const lc = filter.toLowerCase()
    return landowners.filter(
      (l) =>
        l.full_name.toLowerCase().includes(lc) ||
        (l.address ?? '').toLowerCase().includes(lc) ||
        (l.agent_name ?? '').toLowerCase().includes(lc),
    )
  }, [landowners, filter])

  const handleAdd = async () => {
    if (!farmId || adding) return
    setAdding(true)
    try {
      await createLandowner(farmId, { full_name: '新規地権者' })
    } finally {
      setAdding(false)
    }
  }

  const handleDelete = async (lo: Landowner) => {
    if (
      !confirm(
        `地権者「${lo.full_name}」を削除しますか？\n紐づいた地番への割当も同時に解除されます。`,
      )
    ) {
      return
    }
    await deleteLandowner(lo.id)
  }

  if (!farmId) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="地権者管理" subtitle="工区を選択してください" />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="地権者管理"
        subtitle="工区に登録した地権者を行から直接編集できます"
        actions={
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="氏名 / 住所 / 代理人で絞り込み"
              className="px-2 py-1 text-sm border rounded w-60"
            />
            <LandownerColumnPicker visible={visible} onChange={setVisible} />
            <div className="relative" ref={docMenuRef}>
              <button
                onClick={() => setDocMenuOpen((o) => !o)}
                disabled={!farmId || landowners.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
                title="書類を作成"
              >
                <FileText className="h-3.5 w-3.5" />
                書類作成
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
              {docMenuOpen && (
                <div className="absolute right-0 mt-1 w-56 bg-white border rounded shadow-lg z-20 py-1">
                  <button
                    onClick={() => {
                      setDocMenuOpen(false)
                      setShowTemplateExport(true)
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50"
                  >
                    テンプレートから作成
                  </button>
                  <div className="my-1 border-t" />
                  <button
                    onClick={() => {
                      setDocMenuOpen(false)
                      setShowTemplateManager(true)
                    }}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-slate-50"
                  >
                    テンプレート管理
                  </button>
                </div>
              )}
            </div>
            <button
              onClick={() => setShowAutoImport(true)}
              disabled={!farmId}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border border-blue-600 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
              title="地番管理に登録された所有者氏名 / 住所を取り込みます"
            >
              <Wand2 className="h-3.5 w-3.5" />
              地番管理から自動取得
            </button>
            <button
              onClick={handleAdd}
              disabled={adding}
              className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {adding ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              地権者を追加
            </button>
          </div>
        }
      />

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {loading && landowners.length === 0 ? (
          <div className="flex items-center justify-center text-slate-500 text-sm">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : (
          <div className="bg-white border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <LandownerHeader visibleColumns={visible} />
              <tbody>
                {filtered.map((lo) => (
                  <LandownerRowFields
                    key={lo.id}
                    landowner={lo}
                    visibleColumns={visible}
                    onDelete={handleDelete}
                    ownedParcelLabels={ownedParcelLabelsByLandownerId.get(lo.id)}
                  />
                ))}
                {/* 最下行は常に空。氏名を入力 → Enter / 別欄に移動で確定 */}
                {!filter && (
                  <NewLandownerRow
                    visibleColumns={visible}
                    onCreate={async (fullName) => {
                      if (!farmId) return
                      await createLandowner(farmId, { full_name: fullName })
                    }}
                  />
                )}
              </tbody>
            </table>
            {filtered.length === 0 && filter && (
              <div className="p-6 text-center text-xs text-slate-400 border-t">
                「{filter}」に該当する地権者はいません
              </div>
            )}
          </div>
        )}
      </div>

      {showAutoImport && farmId && (
        <LandownerAutoImportModal
          farmId={farmId}
          parcels={farmParcels}
          existingLandowners={landowners}
          onClose={() => setShowAutoImport(false)}
          onApplied={async () => {
            // landowners と parcel_landowners を取り直して画面を更新
            useLandownerStore.getState().invalidateCache()
            await fetchByFarm(farmId)
            await reloadFarmParcels(farmId)
          }}
        />
      )}

      {showTemplateExport && (
        <TemplateExportModal
          landowners={landowners}
          farmParcels={farmParcels}
          landownersByParcelId={landownersByParcelId}
          onClose={() => setShowTemplateExport(false)}
        />
      )}
      {showTemplateManager && (
        <TemplateManagerModal onClose={() => setShowTemplateManager(false)} />
      )}
    </div>
  )
}
