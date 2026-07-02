// 立入通知書（境界測量のご連絡及び境界立会のお願い）を Word (docx) 出力する
// モーダル。地権者管理から呼ぶ。
//
// 手順:
//   1. 依頼人（現工区の地権者から 1 名）
//   2. 隣接者（現工区の地権者から複数）
//   3. 事務所情報（初回入力、以降は自動プリフィル）
//   4. Word でダウンロード

import { useEffect, useMemo, useState } from 'react'
import { Check, Download, Loader2, X } from 'lucide-react'
import type { Landowner, DocumentSettings } from '@/types/database'
import { useAuth } from '@/contexts/AuthContext'
import { useDocumentSettingsStore } from '@/stores/documentSettingsStore'
import { buildEntryNoticeDocx, downloadBlob } from '@/lib/documents/entryNotice'

interface Props {
  landowners: Landowner[]
  onClose: () => void
}

type OfficeFields = NonNullable<DocumentSettings['office']>

const OFFICE_LABELS: Array<{ key: keyof OfficeFields; label: string; placeholder?: string }> = [
  { key: 'postal_code', label: '郵便番号', placeholder: '099-4117' },
  { key: 'address', label: '住所', placeholder: '斜里郡斜里町青葉町9番地13' },
  { key: 'name', label: '事務所名', placeholder: '土地家屋調査士 横山太郎事務所' },
  { key: 'title', label: '肩書', placeholder: '土地家屋調査士' },
  { key: 'representative', label: '代表者氏名', placeholder: '横山太郎' },
  { key: 'contact_name', label: '担当者氏名', placeholder: '横山太郎' },
  { key: 'tel', label: 'TEL', placeholder: '0152-23-1311' },
  { key: 'fax', label: 'FAX', placeholder: '0152-23-0626' },
  { key: 'mobile', label: '携帯', placeholder: '090-7883-4246' },
  { key: 'email', label: 'メール', placeholder: 'example@example.com' },
]

export function EntryNoticeModal({ landowners, onClose }: Props) {
  const { user } = useAuth()
  const {
    settings,
    fetch: fetchSettings,
    save: saveSettings,
    loading,
  } = useDocumentSettingsStore()

  // ログイン中ユーザーの document_settings を取得
  useEffect(() => {
    if (user) void fetchSettings(user.id)
  }, [user, fetchSettings])

  const [clientId, setClientId] = useState<string | null>(null)
  const [neighborIds, setNeighborIds] = useState<Set<string>>(new Set())
  const [office, setOffice] = useState<OfficeFields>({})
  const [exporting, setExporting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 取得完了時にフォームにプリフィル
  useEffect(() => {
    if (settings.office) setOffice(settings.office)
  }, [settings.office])

  const sortedLandowners = useMemo(
    () =>
      [...landowners].sort((a, b) =>
        (a.full_name || '').localeCompare(b.full_name || '', 'ja'),
      ),
    [landowners],
  )

  const toggleNeighbor = (id: string) => {
    setNeighborIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleExport = async () => {
    setErr(null)
    if (!clientId) {
      setErr('依頼人を選択してください')
      return
    }
    const client = landowners.find((l) => l.id === clientId)
    if (!client) {
      setErr('依頼人が見つかりません')
      return
    }
    const neighbors = landowners.filter((l) => neighborIds.has(l.id))

    setExporting(true)
    try {
      // 事務所情報を先に保存（次回以降に使い回せるように）
      if (user) {
        try {
          await saveSettings(user.id, { office })
        } catch {
          // 保存失敗しても docx 生成は続行
        }
      }

      const blob = await buildEntryNoticeDocx({
        client: {
          full_name: client.full_name,
          postal_code: client.postal_code,
          address: client.address,
        },
        neighbors: neighbors.map((n) => ({
          full_name: n.full_name,
          postal_code: n.postal_code,
          address: n.address,
        })),
        office,
      })
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const filename = `立入通知書_${client.full_name}_${y}${m}${d}.docx`.replace(
        /[<>:"/\\|?*]/g,
        '_',
      )
      downloadBlob(blob, filename)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '出力に失敗しました')
    } finally {
      setExporting(false)
    }
  }

  const setOfficeField = (key: keyof OfficeFields, value: string) => {
    setOffice((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <h3 className="text-base font-semibold">立入通知書を作成</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* 依頼人 */}
          <section>
            <div className="text-sm font-medium mb-2">1. 依頼人（1 名）</div>
            <select
              value={clientId ?? ''}
              onChange={(e) => setClientId(e.target.value || null)}
              className="w-full px-2 py-1.5 border rounded text-sm"
            >
              <option value="">-- 選択してください --</option>
              {sortedLandowners.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.full_name}
                  {l.address ? ` — ${l.address}` : ''}
                </option>
              ))}
            </select>
          </section>

          {/* 隣接者 */}
          <section>
            <div className="text-sm font-medium mb-2">
              2. 隣接する土地の所有者（複数選択可 / {neighborIds.size} 名選択中）
            </div>
            <div className="max-h-40 overflow-auto border rounded p-1">
              {sortedLandowners.length === 0 ? (
                <div className="p-3 text-center text-xs text-slate-500">
                  地権者がまだ登録されていません。
                </div>
              ) : (
                sortedLandowners.map((l) => {
                  const on = neighborIds.has(l.id)
                  const disabled = l.id === clientId
                  return (
                    <button
                      key={l.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggleNeighbor(l.id)}
                      className={`w-full flex items-center gap-2 px-2 py-1 text-sm rounded ${
                        disabled
                          ? 'opacity-40 cursor-not-allowed'
                          : on
                            ? 'bg-blue-50 text-blue-800'
                            : 'text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <span
                        className={`flex items-center justify-center w-4 h-4 border rounded ${
                          on ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300'
                        }`}
                      >
                        {on && <Check className="h-3 w-3" />}
                      </span>
                      <span className="flex-1 text-left truncate">
                        {l.full_name}
                        {l.address ? (
                          <span className="text-slate-400 text-xs ml-2">{l.address}</span>
                        ) : null}
                      </span>
                      {disabled && (
                        <span className="text-[10px] text-slate-400">依頼人</span>
                      )}
                    </button>
                  )
                })
              )}
            </div>
          </section>

          {/* 事務所情報 */}
          <section>
            <div className="text-sm font-medium mb-2 flex items-center gap-2">
              3. 事務所情報{' '}
              <span className="text-[10px] text-slate-400 font-normal">
                (保存されるので次回以降は自動入力)
              </span>
              {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {OFFICE_LABELS.map(({ key, label, placeholder }) => (
                <label key={key} className="flex flex-col gap-1">
                  <span className="text-[11px] text-slate-500">{label}</span>
                  <input
                    type="text"
                    value={office[key] ?? ''}
                    onChange={(e) => setOfficeField(key, e.target.value)}
                    placeholder={placeholder}
                    className="w-full px-2 py-1 border rounded text-sm"
                  />
                </label>
              ))}
            </div>
          </section>

          {err && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">
              {err}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={exporting}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || !clientId}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Word でダウンロード
          </button>
        </div>
      </div>
    </div>
  )
}
