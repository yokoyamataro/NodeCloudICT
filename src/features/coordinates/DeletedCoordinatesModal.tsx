// 削除済み 座標の 一覧 + 復元 モーダル。
//
// design_coordinates.deleted_at が 立っている 行を 一覧表示し、
// 「復元」ボタン で deleted_at=NULL に 戻す。
// 30 日 経過した 行は pg_cron で 物理削除されるので、それより 前のみ 復元可能。

import { useEffect, useState } from 'react'
import { X, Loader2, Trash2, RotateCcw, AlertTriangle } from 'lucide-react'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'

interface Props {
  farmId: string
  open: boolean
  onClose: () => void
  /** 復元 完了後の コールバック (親側で 一覧再取得したい場合 等) */
  onRestored?: () => void
}

export function DeletedCoordinatesModal({ farmId, open, onClose, onRestored }: Props) {
  const fetchDeletedCoordinates = useCoordinateStore((s) => s.fetchDeletedCoordinates)
  const restoreCoordinate = useCoordinateStore((s) => s.restoreCoordinate)

  const [loading, setLoading] = useState(false)
  const [items, setItems] = useState<CoordinateRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchDeletedCoordinates(farmId)
      .then((rows) => {
        if (!cancelled) setItems(rows)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error)?.message ?? String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, farmId, fetchDeletedCoordinates])

  const handleRestore = async (row: CoordinateRow) => {
    if (!confirm(`点 ${row.pointNumber} を 復元しますか？`)) return
    setRestoringId(row.id)
    setError(null)
    try {
      await restoreCoordinate(row.id)
      // 一覧から 除去
      setItems((prev) => prev.filter((r) => r.id !== row.id))
      onRestored?.()
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setRestoringId(null)
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white text-slate-800 rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="flex items-center gap-2">
            <Trash2 className="h-4 w-4 text-red-600" />
            <h2 className="text-sm font-bold">削除履歴</h2>
            {!loading && (
              <span className="text-xs text-slate-500">{items.length} 件</span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            aria-label="閉じる"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-2 border-b bg-amber-50 text-[11px] text-amber-800 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            削除から 30 日 経過した 座標は 自動で 完全削除 されます (復元不可)。
            復元が 必要なら 早めに 実行してください。
          </span>
        </div>

        {loading ? (
          <div className="flex-1 flex items-center justify-center py-12 text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : error ? (
          <div className="p-4 text-red-700 text-sm">エラー: {error}</div>
        ) : items.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-12 text-slate-500 text-sm">
            削除された 座標は ありません
          </div>
        ) : (
          <div className="flex-1 overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0 border-b">
                <tr>
                  <th className="text-left font-normal px-3 py-2">点番</th>
                  <th className="text-right font-normal px-3 py-2">X</th>
                  <th className="text-right font-normal px-3 py-2">Y</th>
                  <th className="text-right font-normal px-3 py-2">Z</th>
                  <th className="text-left font-normal px-3 py-2">点種</th>
                  <th className="text-left font-normal px-3 py-2">削除日時</th>
                  <th className="text-right font-normal px-3 py-2">残り日数</th>
                  <th className="text-right font-normal px-3 py-2 sticky right-0 bg-slate-50">操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => {
                  const deletedMs = row.deletedAt ? new Date(row.deletedAt).getTime() : null
                  const remainingDays = deletedMs
                    ? Math.max(0, 30 - Math.floor((Date.now() - deletedMs) / 86_400_000))
                    : null
                  const deletedFmt = row.deletedAt
                    ? new Date(row.deletedAt).toLocaleString('ja-JP', { hour12: false })
                    : '-'
                  return (
                    <tr key={row.id} className="border-b hover:bg-slate-50">
                      <td className="px-3 py-1.5 font-mono">{row.pointNumber}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{row.x.toFixed(3)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{row.y.toFixed(3)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {row.z != null ? row.z.toFixed(3) : '-'}
                      </td>
                      <td className="px-3 py-1.5">{row.type}</td>
                      <td className="px-3 py-1.5 text-slate-600">{deletedFmt}</td>
                      <td
                        className={`px-3 py-1.5 text-right font-mono ${
                          remainingDays != null && remainingDays <= 3
                            ? 'text-red-600 font-bold'
                            : 'text-slate-600'
                        }`}
                      >
                        {remainingDays != null ? `${remainingDays} 日` : '-'}
                      </td>
                      <td className="px-3 py-1.5 text-right sticky right-0 bg-white">
                        <button
                          type="button"
                          onClick={() => handleRestore(row)}
                          disabled={restoringId === row.id}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {restoringId === row.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <RotateCcw className="h-3 w-3" />
                          )}
                          復元
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="px-4 py-2 border-t flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm rounded border border-slate-300 hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
