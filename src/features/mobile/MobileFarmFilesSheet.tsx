// スマホ用 の 工区ファイル シート。
//
// PC の ファイル画面 (FarmFilesPage) の 閲覧 だけ を 切り出した もの。
// 現場 で 「図面 を 見たい」 に 応える のが 目的 な ので、
// アップロード / 削除 は PC に 任せ、ここ は 一覧 と 表示 だけ に する。
//
//   DXF / SFC / P21 … 画面内 の 図面ビューア (PC と 同じ 部品)
//   PDF             … 別タブ で 開く (端末 の PDF 表示 に 任せる)
//   その他           … ダウンロード

import { useCallback, useEffect, useState } from 'react'
import { Download, Eye, FileText, Loader2, X } from 'lucide-react'
import {
  FARM_FILE_KIND_LABEL,
  canPreview,
  downloadFarmFileBytes,
  errorMessage,
  getFarmFileUrl,
  listFarmFiles,
  type FarmFileRow,
} from '@/lib/farmFiles'
import { decodeDxfBytes } from '@/lib/dxfRender'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import type { SxfResult } from '@/lib/sxf'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 図面 として 画面内 で 開ける 種別 */
function isDrawing(kind: FarmFileRow['kind']): boolean {
  return kind === 'dxf' || kind === 'sfc' || kind === 'p21'
}

export function MobileFarmFilesSheet({
  farmId,
  farmName,
  onClose,
}: {
  farmId: string
  farmName: string
  onClose: () => void
}) {
  const [rows, setRows] = useState<FarmFileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [viewer, setViewer] = useState<
    { row: FarmFileRow; text: string; doc?: SxfResult | null } | null
  >(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setRows(await listFarmFiles(farmId))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [farmId])

  useEffect(() => {
    void load()
  }, [load])

  const handleOpen = async (row: FarmFileRow, download: boolean) => {
    setError(null)
    setOpening(row.id)
    try {
      if (!download && isDrawing(row.kind)) {
        // 日本の CAD は Shift-JIS が 多い ので 判定つき デコーダ を 通す
        const buf = await downloadFarmFileBytes(row.storagePath)
        const text = decodeDxfBytes(buf)
        if (row.kind === 'dxf') {
          setViewer({ row, text })
        } else {
          const { parseSxfFile } = await import('@/lib/sxf')
          setViewer({ row, text, doc: parseSxfFile(text) })
        }
        return
      }
      const url = await getFarmFileUrl(row.storagePath)
      if (download) {
        const a = document.createElement('a')
        a.href = url
        a.download = row.name
        a.click()
      } else {
        window.open(url, '_blank', 'noopener')
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setOpening(null)
    }
  }

  return (
    <div className="fixed inset-0 z-[3200] bg-black/50 flex items-end">
      <div className="bg-white w-full rounded-t-xl shadow-xl flex flex-col max-h-[85vh]">
        <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
          <FileText className="h-4 w-4 text-slate-500" />
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">ファイル</div>
            <div className="text-[11px] text-slate-500 truncate">{farmName}</div>
          </div>
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded text-slate-400 hover:bg-slate-100"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {error && (
          <div className="px-3 py-2 bg-red-50 border-b border-red-200 text-xs text-red-700 whitespace-pre-line">
            {error}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto p-2">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin mr-2" />
              読み込み中…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">
              ファイルがありません。
              <br />
              <span className="text-xs">追加は PC 表示の「ファイル」から</span>
            </div>
          ) : (
            <ul className="border rounded divide-y">
              {rows.map((row) => (
                <li key={row.id} className="p-2 flex items-center gap-2">
                  <FileText className="h-4 w-4 text-slate-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm truncate">{row.name}</div>
                    <div className="text-[11px] text-slate-500 flex items-center gap-2">
                      <span className="px-1 rounded bg-slate-100 text-slate-600">
                        {FARM_FILE_KIND_LABEL[row.kind]}
                      </span>
                      <span className="font-mono">{formatBytes(row.sizeBytes)}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleOpen(row, false)}
                    disabled={!canPreview(row.kind) || opening === row.id}
                    className="p-2 rounded border text-slate-600 disabled:opacity-30"
                    title={canPreview(row.kind) ? '開く' : 'この形式は表示できません'}
                  >
                    {opening === row.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleOpen(row, true)}
                    className="p-2 rounded border text-slate-600"
                    title="ダウンロード"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* 図面ビューア。 スマホ は 画面 が 狭い ので 全画面 に する */}
      {viewer && (
        <div className="fixed inset-0 z-[3300] bg-white flex flex-col">
          <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
            <FileText className="h-4 w-4 text-slate-500" />
            <span className="text-sm font-semibold truncate">{viewer.row.name}</span>
            <button
              onClick={() => setViewer(null)}
              className="ml-auto p-1 rounded text-slate-400 hover:bg-slate-100"
              aria-label="閉じる"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="flex-1 min-h-0 p-2">
            {viewer.doc && viewer.doc.shapes.length === 0 ? (
              <div className="h-full flex items-center justify-center px-6 text-center text-sm text-slate-500">
                表示できる図形が見つかりませんでした。
                <br />
                PC 表示で開くと詳しい内容が出ます。
              </div>
            ) : (
              <DxfCrossSectionViewer
                dxfText={viewer.text}
                parsedDoc={viewer.doc ?? null}
                className="w-full h-full"
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
