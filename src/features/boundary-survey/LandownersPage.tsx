// 地籍測量: 地権者管理ページ（インライン編集テーブル）。
// /boundary-survey/landowners
//
// ・現工区の地権者を一覧し、各行の中でそのまま編集できる（onBlur で保存）
// ・「地権者を追加」で新規行を即時に作成（氏名は仮で「新規地権者」）
// ・表示する列は CadastralColumnPicker と同じ要領で選択可
// ・地番への割当は地番一覧側の「地権者」列モーダルから行う（このページでは行わない）

import { useEffect, useMemo, useState } from 'react'
import { Plus, Loader2 } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useLandownerStore } from '@/stores/landownerStore'
import type { Landowner } from '@/types/database'
import { LandownerHeader, LandownerRowFields } from './LandownerRowFields'
import {
  LandownerColumnPicker,
  useLandownerVisibleColumns,
} from './LandownerColumnPicker'

export function LandownersPage() {
  const { currentFarm } = useFarmStore()
  const farmId = currentFarm?.id ?? null

  const landowners = useLandownerStore((s) => s.landowners)
  const loading = useLandownerStore((s) => s.loading)
  const fetchByFarm = useLandownerStore((s) => s.fetchByFarm)
  const createLandowner = useLandownerStore((s) => s.createLandowner)
  const deleteLandowner = useLandownerStore((s) => s.deleteLandowner)
  const error = useLandownerStore((s) => s.error)

  const [filter, setFilter] = useState('')
  const [adding, setAdding] = useState(false)
  const [visible, setVisible] = useLandownerVisibleColumns()

  useEffect(() => {
    if (farmId) void fetchByFarm(farmId)
  }, [farmId, fetchByFarm])

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
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {landowners.length === 0
              ? '地権者がまだ登録されていません。「地権者を追加」から登録してください。'
              : '該当する地権者がいません'}
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
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
