// 工区の ファイルストレージ。
//
// PDF / SFC / P21 / DXF / LandXML / SIM を 工区に 置いて、現場と 事務所で
// 受け渡す ための 場所。CAD 解析や LandXML の 登録とは 別で、ここは
// 「原本を 置いておく」用途。
//
// 制限は 1 工区 20MB・アップロードから 3 ヶ月。どちらも DB 側でも
// 効かせてあるが、押す前に 分かるよう 画面でも 出す。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Upload, Download, Trash2, Eye, Loader2, FileText } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import {
  FARM_FILE_ACCEPT,
  FARM_FILE_KIND_LABEL,
  FARM_FILE_QUOTA_BYTES,
  canPreview,
  deleteFarmFile,
  getFarmFileUrl,
  kindFromFileName,
  listFarmFiles,
  uploadFarmFile,
  usedBytes,
  type FarmFileRow,
} from '@/lib/farmFiles'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/** 残り日数。期限切れは 一覧に 出ないので 0 未満は 出ない想定 */
function daysLeft(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now()
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)))
}

export function FarmFilesPage() {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const farmId = currentFarm?.id ?? null
  const [rows, setRows] = useState<FarmFileRow[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    if (!farmId) {
      setRows([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      setRows(await listFarmFiles(farmId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [farmId])

  useEffect(() => {
    void load()
  }, [load])

  const used = usedBytes(rows)
  const usedPct = Math.min(100, (used / FARM_FILE_QUOTA_BYTES) * 100)

  const handlePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = '' // 同じ ファイルを 続けて 選べるように
    if (!file || !farmId) return
    setError(null)
    if (!kindFromFileName(file.name)) {
      setError('対応していない形式です (PDF / SFC / P21 / DXF / LandXML / SIM)')
      return
    }
    // 押す前に 分かるよう 画面でも 見る (DB 側でも 弾かれる)
    if (used + file.size > FARM_FILE_QUOTA_BYTES) {
      setError(
        `容量が足りません。使用中 ${formatBytes(used)} / 上限 ${formatBytes(
          FARM_FILE_QUOTA_BYTES,
        )}。不要なファイルを消してください`,
      )
      return
    }
    setBusy(true)
    try {
      await uploadFarmFile({ farmId, file })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const handleOpen = async (row: FarmFileRow, download: boolean) => {
    setError(null)
    try {
      const url = await getFarmFileUrl(row.storagePath)
      if (download) {
        const a = document.createElement('a')
        a.href = url
        a.download = row.name
        a.click()
      } else {
        window.open(url, '_blank', 'noopener')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDelete = async (row: FarmFileRow) => {
    if (!confirm(`「${row.name}」を削除しますか？（元に戻せません）`)) return
    setBusy(true)
    setError(null)
    try {
      await deleteFarmFile(row)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!farmId) {
    return (
      <div className="h-full flex items-center justify-center text-slate-500 text-sm">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="px-4 py-2 border-b bg-white flex items-center gap-3">
        <label className="shrink-0">
          <input
            ref={inputRef}
            type="file"
            accept={FARM_FILE_ACCEPT}
            onChange={handlePick}
            className="hidden"
            disabled={busy}
          />
          <span
            className={`flex items-center gap-1 px-3 py-1.5 rounded border text-sm ${
              busy
                ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed'
                : 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700 cursor-pointer'
            }`}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            アップロード
          </span>
        </label>
        {/* 使用量。上限に 近づいたら 色で 気づけるように する */}
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-40 h-2 bg-slate-200 rounded overflow-hidden shrink-0">
            <div
              className={`h-full ${usedPct >= 90 ? 'bg-red-500' : 'bg-blue-600'}`}
              style={{ width: `${usedPct}%` }}
            />
          </div>
          <span className="text-xs text-slate-600 font-mono shrink-0">
            {formatBytes(used)} / {formatBytes(FARM_FILE_QUOTA_BYTES)}
          </span>
        </div>
        <span className="ml-auto text-[11px] text-slate-500 shrink-0">
          PDF / SFC / P21 / DXF / LandXML / SIM ・ 3 ヶ月で自動失効
        </span>
      </div>

      {error && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center text-slate-500 text-sm py-8">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-sm text-slate-500">
            まだファイルがありません。「アップロード」から追加してください。
          </div>
        ) : (
          <div className="border rounded divide-y bg-white">
            {rows.map((row) => {
              const left = daysLeft(row.expiresAt)
              return (
                <div key={row.id} className="p-2 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate" title={row.name}>
                      {row.name}
                    </div>
                    <div className="text-[11px] text-slate-500 flex items-center gap-2">
                      <span className="px-1 rounded bg-slate-100 text-slate-600">
                        {FARM_FILE_KIND_LABEL[row.kind]}
                      </span>
                      <span className="font-mono">{formatBytes(row.sizeBytes)}</span>
                      <span className={left <= 7 ? 'text-amber-600' : ''}>残り {left} 日</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handleOpen(row, false)}
                      disabled={!canPreview(row.kind)}
                      className="p-1.5 rounded border text-slate-600 hover:bg-slate-50 disabled:opacity-30 disabled:cursor-not-allowed"
                      title={
                        canPreview(row.kind)
                          ? '別タブで開く'
                          : 'SFC / P21 の閲覧は未実装です（ダウンロードは可能）'
                      }
                    >
                      <Eye className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleOpen(row, true)}
                      className="p-1.5 rounded border text-slate-600 hover:bg-slate-50"
                      title="ダウンロード"
                    >
                      <Download className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(row)}
                      disabled={busy}
                      className="p-1.5 rounded border text-red-600 hover:bg-red-50 disabled:opacity-40"
                      title="削除"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
