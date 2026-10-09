// 登記情報 PDF ビューア + AI 解析 モーダル。
//
// 1 筆 (parcel) に 紐付く 登記 PDF (attachments.category = 'registry_pdf') を
// プレビュー し、 「AI 解析」 ボタン で parseRegistryPdfViaAI を 走らせ て
// 現在値 (地目 / 地積 / 所有者) と 土地の沿革 (parcel_display_histories) を 更新 する。
//
// 複数 PDF が ある 場合 は 左 の 一覧 で 切替。

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Sparkles, X, FileText, Download, Trash2 } from 'lucide-react'
import { useAttachmentStore, type Attachment } from '@/stores/attachmentStore'
import { useFarmStore } from '@/stores/farmStore'
import { useParcelStore, type ParcelEditableFields } from '@/stores/parcelStore'
import { useLandHistoryStore } from '@/stores/landHistoryStore'
import { parseRegistryPdfViaAI } from '@/lib/registryPdf'
import { REGISTRY_PDF_CATEGORY } from './RegistryPdfImportModal'

interface Props {
  workAreaId: string
  parcelId: string | null
  parcelNumber: string | null
  location: string | null
  onClose: () => void
}

export function RegistryPdfViewerModal({
  workAreaId,
  parcelId,
  parcelNumber,
  location,
  onClose,
}: Props) {
  const byEntity = useAttachmentStore((s) => s.byEntity)
  const fetchByEntityIds = useAttachmentStore((s) => s.fetchByEntityIds)
  const getSignedUrl = useAttachmentStore((s) => s.getSignedUrl)
  const removeAttachment = useAttachmentStore((s) => s.removeAttachment)
  const upsertParcel = useParcelStore((s) => s.upsertParcel)
  const replaceLandHistory = useLandHistoryStore((s) => s.replaceForParcel)
  const projectId = useFarmStore((s) => s.currentFarm?.project_id ?? null)

  // この 工区 の 添付 を 一度 取得 (まだ なら)
  useEffect(() => {
    void fetchByEntityIds('work_area', [workAreaId])
  }, [workAreaId, fetchByEntityIds])

  const pdfs: Attachment[] = useMemo(() => {
    const key = `work_area:${workAreaId}`
    const all = byEntity.get(key) ?? []
    return all.filter((a) => a.category === REGISTRY_PDF_CATEGORY)
  }, [byEntity, workAreaId])

  const [activeId, setActiveId] = useState<string | null>(null)
  useEffect(() => {
    if (pdfs.length === 0) {
      setActiveId(null)
      return
    }
    if (!activeId || !pdfs.find((p) => p.id === activeId)) {
      setActiveId(pdfs[0].id)
    }
  }, [pdfs, activeId])

  const active = pdfs.find((p) => p.id === activeId) ?? null
  const [signedUrl, setSignedUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSignedUrl(null)
    if (!active) return
    void (async () => {
      const url = await getSignedUrl(active.filePath)
      if (!cancelled) setSignedUrl(url)
    })()
    return () => {
      cancelled = true
    }
  }, [active, getSignedUrl])

  const [analyzing, setAnalyzing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  const handleAnalyze = async () => {
    if (!active || !signedUrl || !parcelId) return
    setAnalyzing(true)
    setMessage(null)
    setIsError(false)
    try {
      // Supabase signed URL から PDF を fetch して File に 変換
      const res = await fetch(signedUrl)
      if (!res.ok) throw new Error(`PDF 取得 失敗 (${res.status})`)
      const blob = await res.blob()
      const file = new File([blob], active.caption ?? 'registry.pdf', {
        type: 'application/pdf',
      })
      const parsed = await parseRegistryPdfViaAI(file, 'full', {
        location,
        parcel_number: parcelNumber,
      })
      // 現在値 を parcel に 反映 (既存 値 が 入って いる 列 は 上書き — 最新 PDF を 信頼)
      const patch: Partial<ParcelEditableFields> = {}
      if (parsed.location) patch.location = parsed.location
      if (parsed.parcelNumber) patch.parcel_number = parsed.parcelNumber
      if (parsed.landCategory) patch.registered_land_category = parsed.landCategory
      if (parsed.areaSqm != null) patch.registered_area_sqm = parsed.areaSqm
      if (parsed.owners.length > 0) {
        patch.registered_owner_name = parsed.owners[0].fullName
        patch.registered_owner_address = parsed.owners[0].address
      }
      if (Object.keys(patch).length > 0) {
        await upsertParcel(workAreaId, patch)
      }
      // 土地の沿革 を 全入替
      if (parsed.displayHistories.length > 0) {
        await replaceLandHistory(parcelId, parsed.displayHistories.map((h) => ({
          order_no: h.orderNo,
          parcel_number: h.parcelNumber,
          land_category: h.landCategory,
          area_text: h.areaText,
          reason: h.reason,
          cause_date: h.causeDate,
        })))
      }
      const histCount = parsed.displayHistories.length
      const extras = parsed.warnings.length > 0
        ? ` / 警告: ${parsed.warnings.join(', ')}`
        : ''
      setMessage(
        `反映 完了 (信頼度 ${(parsed.confidence * 100).toFixed(0)}% / 沿革 ${histCount} 件)${extras}`,
      )
      setIsError(false)
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setIsError(true)
    } finally {
      setAnalyzing(false)
    }
  }

  const handleDelete = async () => {
    if (!active) return
    if (!window.confirm(`「${active.caption ?? '登記PDF'}」 を 削除 しますか?`)) return
    await removeAttachment(active.id)
    setMessage(null)
  }

  if (!projectId) {
    return (
      <div className="fixed inset-0 z-[3000] bg-black/50 flex items-center justify-center p-4">
        <div className="bg-white rounded p-4 text-sm">プロジェクト 未選択</div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-[3000] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-5xl h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <FileText className="h-4 w-4 text-blue-600" />
          <div className="font-semibold text-sm">
            登記情報 PDF {parcelNumber ? `/ ${parcelNumber}` : ''}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleAnalyze()}
              disabled={!active || !signedUrl || !parcelId || analyzing}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              title="AI で 地目 / 地積 / 所有者 / 土地の沿革 を 抽出 して 反映"
            >
              {analyzing ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  解析中…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  AI 解析
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-slate-100 text-slate-500"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {message && (
          <div
            className={`px-4 py-1.5 text-xs ${
              isError ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
            }`}
          >
            {message}
          </div>
        )}

        <div className="flex-1 min-h-0 flex overflow-hidden">
          {/* 左: PDF 一覧 */}
          <div className="w-48 shrink-0 border-r overflow-auto bg-slate-50">
            {pdfs.length === 0 ? (
              <div className="p-3 text-xs text-slate-400 text-center">
                登記 PDF が ありません。 「登記情報取込」 で アップロード して ください
              </div>
            ) : (
              <ul className="divide-y">
                {pdfs.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => setActiveId(p.id)}
                      className={`w-full px-3 py-2 text-left text-xs hover:bg-white ${
                        p.id === activeId ? 'bg-white border-l-4 border-blue-500' : ''
                      }`}
                    >
                      <div className="truncate font-medium">
                        {p.caption ?? p.filePath.split('/').pop()}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {p.byteSize != null && `${Math.round(p.byteSize / 1024)} KB`}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 右: PDF 本体 */}
          <div className="flex-1 min-w-0 relative bg-slate-100">
            {active && signedUrl ? (
              <iframe
                key={active.id}
                src={signedUrl}
                title={active.caption ?? '登記PDF'}
                className="absolute inset-0 w-full h-full border-0"
              />
            ) : active ? (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-500">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                読み込み中…
              </div>
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
                PDF を 選択 して ください
              </div>
            )}
          </div>
        </div>

        {active && (
          <div className="px-4 py-2 border-t flex items-center justify-between text-xs">
            <div className="text-slate-500 truncate">
              {active.caption ?? active.filePath.split('/').pop()}
            </div>
            <div className="flex items-center gap-2">
              {signedUrl && (
                <a
                  href={signedUrl}
                  download={active.caption ?? 'registry.pdf'}
                  className="inline-flex items-center gap-1 px-2 py-1 border rounded text-slate-700 hover:bg-slate-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  ダウンロード
                </a>
              )}
              <button
                type="button"
                onClick={() => void handleDelete()}
                className="inline-flex items-center gap-1 px-2 py-1 border border-red-300 text-red-600 rounded hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                削除
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
