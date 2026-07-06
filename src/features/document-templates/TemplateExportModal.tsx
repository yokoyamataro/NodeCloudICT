// テンプレートを選んで、依頼人 / 隣接者 を差し込んで Word 出力するモーダル。
// 事務所情報はテンプレート本体に直書きする運用にしたため、ここでの入力は撤去。
// 地権者管理から呼ぶ。

import { useEffect, useMemo, useState } from 'react'
import { Check, Download, Loader2, X } from 'lucide-react'
import type { Landowner } from '@/types/database'
import { useAuth } from '@/contexts/AuthContext'
import { useDocumentTemplateStore } from '@/stores/documentTemplateStore'
import { downloadBlob, renderTemplate } from '@/lib/documents/templateRender'

interface Props {
  landowners: Landowner[]
  onClose: () => void
}

export function TemplateExportModal({ landowners, onClose }: Props) {
  const { user } = useAuth()
  const {
    templates,
    loading: templatesLoading,
    fetchAll: fetchTemplates,
    downloadTemplateBlob,
  } = useDocumentTemplateStore()

  const [templateId, setTemplateId] = useState<string | null>(null)
  const [clientId, setClientId] = useState<string | null>(null)
  const [neighborIds, setNeighborIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    void fetchTemplates()
  }, [fetchTemplates])

  const sortedLandowners = useMemo(
    () =>
      [...landowners].sort((a, b) =>
        (a.full_name || '').localeCompare(b.full_name || '', 'ja'),
      ),
    [landowners],
  )
  const template = useMemo(
    () => templates.find((t) => t.id === templateId) ?? null,
    [templates, templateId],
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
    if (!template) {
      setErr('テンプレートを選択してください')
      return
    }
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

    setBusy(true)
    try {
      // テンプレ本体を DL
      const templateBlob = await downloadTemplateBlob(template)
      if (!templateBlob) {
        setErr('テンプレート本体のダウンロードに失敗しました')
        return
      }

      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      const dateStr = `${y}${m}${d}`
      const sanitize = (s: string) => s.replace(/[<>:"/\\|?*]/g, '_')
      const baseName = sanitize(template.name)

      const clientPayload = {
        full_name: client.full_name,
        postal_code: client.postal_code,
        address: client.address,
      }

      // 隣接者未選択: 依頼人のみで 1 枚
      if (neighbors.length === 0) {
        const out = await renderTemplate(templateBlob, {
          client: clientPayload,
          neighbor: null,
        })
        const filename = `${baseName}_${sanitize(client.full_name)}_${dateStr}.docx`
        downloadBlob(out, filename)
        onClose()
        return
      }

      // 隣接者ごとに 1 枚ずつ生成
      const files: Array<{ name: string; blob: Blob }> = []
      for (const n of neighbors) {
        const out = await renderTemplate(templateBlob, {
          client: clientPayload,
          neighbor: {
            full_name: n.full_name,
            postal_code: n.postal_code,
            address: n.address,
          },
        })
        const filename = `${baseName}_${sanitize(n.full_name)}_${dateStr}.docx`
        files.push({ name: filename, blob: out })
      }

      if (files.length === 1) {
        downloadBlob(files[0].blob, files[0].name)
      } else {
        // 複数隣接者 → ZIP でまとめて 1 回のダウンロード
        const { default: JSZip } = await import('jszip')
        const zip = new JSZip()
        for (const f of files) zip.file(f.name, f.blob)
        const zipBlob = await zip.generateAsync({ type: 'blob' })
        downloadBlob(
          zipBlob,
          `${baseName}_${sanitize(client.full_name)}_${dateStr}.zip`,
        )
      }
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : '出力に失敗しました')
    } finally {
      setBusy(false)
    }
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
          <h3 className="text-base font-semibold">テンプレートから書類を作成</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* テンプレート */}
          <section>
            <div className="text-sm font-medium mb-2 flex items-center gap-2">
              1. テンプレート
              {templatesLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-400" />}
            </div>
            {templates.length === 0 ? (
              <div className="text-xs text-slate-400 border rounded p-3 text-center">
                テンプレートが登録されていません。「テンプレート管理」から追加してください。
              </div>
            ) : (
              <select
                value={templateId ?? ''}
                onChange={(e) => setTemplateId(e.target.value || null)}
                className="w-full px-2 py-1.5 border rounded text-sm"
              >
                <option value="">-- 選択してください --</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.description ? ` — ${t.description}` : ''}
                    {t.owner_user_id !== user?.id ? '（共有）' : ''}
                  </option>
                ))}
              </select>
            )}
          </section>

          {/* 依頼人 */}
          <section>
            <div className="text-sm font-medium mb-2">2. 依頼人（1 名）</div>
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
              3. 隣接する土地の所有者（{neighborIds.size} 名選択中）
              <span className="ml-2 text-[10px] text-slate-400 font-normal">
                選択した各人ごとに 1 枚ずつ出力（2 名以上は ZIP でまとめてダウンロード）
              </span>
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
                      {disabled && <span className="text-[10px] text-slate-400">依頼人</span>}
                    </button>
                  )
                })
              )}
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
            disabled={busy}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleExport}
            disabled={busy || !template || !clientId}
            className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Word でダウンロード
          </button>
        </div>
      </div>
    </div>
  )
}
