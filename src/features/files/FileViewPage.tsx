// 図面 (DXF / SFC / P21) を 1 枚 の 画面 いっぱい に 出す 単独ページ。
//
// ファイル一覧 から 別タブ で 開く 先。 アプリ から は 端末 の ブラウザ が
// ここ を 開く。 画面 を 占有 できる ので 大きい 図面 でも 見やすい。
//
//   /file-view?path=<storage path>&name=<表示名>&kind=<dxf|sfc|p21>

import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { FileText, Loader2 } from 'lucide-react'
import { downloadFarmFileBytes, errorMessage } from '@/lib/farmFiles'
import { decodeDxfBytes } from '@/lib/dxfRender'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import type { SxfResult } from '@/lib/sxf'

export function FileViewPage() {
  const [params] = useSearchParams()
  const path = params.get('path') ?? ''
  const name = params.get('name') ?? '図面'
  const kind = (params.get('kind') ?? 'dxf').toLowerCase()

  const [text, setText] = useState<string | null>(null)
  const [doc, setDoc] = useState<SxfResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = name
  }, [name])

  useEffect(() => {
    if (!path) {
      setError('ファイルが指定されていません')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const buf = await downloadFarmFileBytes(path)
        if (cancelled) return
        // 日本の CAD は Shift-JIS が 多い ので 判定つき デコーダ を 通す
        const t = decodeDxfBytes(buf)
        setText(t)
        if (kind !== 'dxf') {
          const { parseSxfFile } = await import('@/lib/sxf')
          if (!cancelled) setDoc(parseSxfFile(t))
        }
      } catch (e) {
        if (!cancelled) setError(errorMessage(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [path, kind])

  return (
    <div className="h-screen flex flex-col bg-white">
      <div className="px-3 py-2 border-b flex items-center gap-2 shrink-0">
        <FileText className="h-4 w-4 text-slate-500" />
        <span className="text-sm font-semibold truncate">{name}</span>
      </div>
      <div className="flex-1 min-h-0 p-2">
        {error ? (
          <div className="h-full flex items-center justify-center px-6 text-center text-sm text-red-700 whitespace-pre-line">
            {error}
          </div>
        ) : text == null ? (
          <div className="h-full flex items-center justify-center text-sm text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : kind !== 'dxf' && doc == null ? (
          // SXF は 解析 に 一拍 かかる。 先に ビューア を 出す と
          // DXF として 読もう と して 失敗表示 に なる
          <div className="h-full flex items-center justify-center text-sm text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            図面を解析中…
          </div>
        ) : doc && doc.shapes.length === 0 ? (
          <div className="h-full flex items-center justify-center px-6 text-center text-sm text-slate-500">
            表示できる図形が見つかりませんでした。
          </div>
        ) : (
          <DxfCrossSectionViewer dxfText={text} parsedDoc={doc} className="w-full h-full" />
        )}
      </div>
    </div>
  )
}
