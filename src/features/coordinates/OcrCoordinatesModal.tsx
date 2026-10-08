// 画像 / PDF / クリップボード 貼付 を Claude Vision に 投げて 座標 を 抽出 する モーダル。
//
// フロー:
//   1. ユーザー が ファイル (D&D / ファイル選択) または クリップボード (Ctrl+V) で 入力
//   2. 「読取 実行」 ボタン で /api/ocr-coordinates に POST
//   3. 結果 を 編集可能 な プレビュー 表 に 出す
//   4. 「取込」 で 親 コンポーネント に 渡し、 従来 の importCoordinates に 流し込む
//
// 対応 形式: image/jpeg, image/png, image/webp, image/gif, application/pdf
// 日本 の 平面直角座標 を 前提 と して API 側 の プロンプト で X=北 / Y=東 を 固定。

import { useCallback, useEffect, useRef, useState } from 'react'
import { Clipboard, FileText, Image as ImageIcon, Loader2, Upload, X, AlertTriangle } from 'lucide-react'
import { COORDINATE_TYPE_NAMES, type CoordinateType } from '../../lib/coordinates'

const TYPE_OPTIONS = Object.entries(COORDINATE_TYPE_NAMES) as Array<[CoordinateType, string]>

interface Props {
  open: boolean
  onClose: () => void
  /** 読取 結果 を そのまま 登録 する コールバック (親 側 で importCoordinates を 呼ぶ) */
  onImport: (
    points: Array<{ pointNumber: string; x: number; y: number; z: number | null; type: string | null }>,
  ) => void
  /** 登録 前 に 測地座標変換 を 掛ける コールバック (親 側 で GeodeticTransformModal を 開く) */
  onOpenTransform?: (
    points: Array<{ pointNumber: string; x: number; y: number; z: number | null; type: string | null }>,
  ) => void
  /** 既定 の 点種 (親 側 の 「取り込む 点種」)。 読取結果 の type が null の 時 に 使う */
  defaultType: string
  /** モバイル で カメラ 撮影 直後 に 開く 用途。 open=true の 時 に 1 回 だけ 自動 で 吸い込む */
  initialFile?: File | null
}

interface InputFile {
  key: string
  name: string
  mimeType: string
  sizeBytes: number
  dataBase64: string
  previewUrl: string | null
}

interface OcrPoint {
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: string | null
  confidence: number
}

export function OcrCoordinatesModal({ open, onClose, onImport, onOpenTransform, defaultType, initialFile }: Props) {
  const [files, setFiles] = useState<InputFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [points, setPoints] = useState<OcrPoint[]>([])
  const [dedupedCount, setDedupedCount] = useState(0)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const initialFileConsumedRef = useRef<File | null>(null)

  // モーダル を 閉じる 時 に 状態 リセット
  useEffect(() => {
    if (!open) {
      setFiles([])
      setPoints([])
      setError(null)
      setDedupedCount(0)
      setLoading(false)
      initialFileConsumedRef.current = null
    }
  }, [open])

  // モバイル カメラ 等 から 開いた 時: initialFile を 自動 吸い込み
  useEffect(() => {
    if (!open || !initialFile) return
    if (initialFileConsumedRef.current === initialFile) return
    initialFileConsumedRef.current = initialFile
    void addFile(initialFile)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFile])

  // クリップボード 貼付: モーダル が 開いて いる 時 のみ 画像 を 吸い込む
  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i]
        if (it.kind === 'file') {
          const file = it.getAsFile()
          if (file) {
            void addFile(file)
            e.preventDefault()
          }
        }
      }
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const addFile = useCallback(async (file: File) => {
    const supported =
      file.type.startsWith('image/') || file.type === 'application/pdf'
    if (!supported) {
      setError(`未対応 の 形式: ${file.type || file.name}`)
      return
    }
    // サイズ 上限 (10 MB)。 Claude API も 大きすぎる と 弾く
    if (file.size > 10 * 1024 * 1024) {
      setError(`ファイル が 大きすぎ ます (${(file.size / 1024 / 1024).toFixed(1)} MB)。 10 MB 以下 に して ください`)
      return
    }
    const dataBase64 = await fileToBase64(file)
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    setFiles((prev) => [
      ...prev,
      {
        key: `${file.name}-${Date.now()}-${Math.random()}`,
        name: file.name || (file.type === 'application/pdf' ? '貼付.pdf' : '貼付.png'),
        mimeType: file.type,
        sizeBytes: file.size,
        dataBase64,
        previewUrl,
      },
    ])
    setError(null)
  }, [])

  const removeFile = (key: string) => {
    setFiles((prev) => {
      const t = prev.find((f) => f.key === key)
      if (t?.previewUrl) URL.revokeObjectURL(t.previewUrl)
      return prev.filter((f) => f.key !== key)
    })
  }

  const handleRead = async () => {
    if (files.length === 0) return
    setLoading(true)
    setError(null)
    setPoints([])
    try {
      const res = await fetch('/api/ocr-coordinates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          files: files.map((f) => ({ mimeType: f.mimeType, dataBase64: f.dataBase64 })),
        }),
      })
      // Vercel タイムアウト 等 で body が 空 の 場合 res.json() が
      // 「Unexpected end of JSON input」 を 投げる の で、 先 に text で 受ける
      const bodyText = await res.text()
      if (!bodyText) {
        setError(
          res.status === 504 || res.status === 408
            ? 'タイムアウト しました (Vercel サーバーレス 関数 の 制限)。 PDF の ページ 数 を 減らす か、 画像 で 再 試行 して ください'
            : `サーバー から 空 応答 (HTTP ${res.status})。 Vercel タイムアウト の 可能性`,
        )
        return
      }
      let json: { points?: OcrPoint[]; error?: string; detail?: string }
      try {
        json = JSON.parse(bodyText)
      } catch {
        setError(`応答 が JSON で は ありません でした: ${bodyText.slice(0, 300)}`)
        return
      }
      if (!res.ok) {
        setError(`${json.error ?? '読取 失敗'}${json.detail ? '\n' + json.detail : ''}`)
        return
      }
      const raw = json.points ?? []
      const deduped = dedupeByCoordinate(raw)
      setPoints(deduped)
      setDedupedCount(raw.length - deduped.length)
      if (deduped.length === 0) {
        setError('読み取れる 座標 が ありません でした')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const toImportArray = () =>
    points.map((p) => ({
      pointNumber: p.pointNumber,
      x: p.x,
      y: p.y,
      z: p.z,
      type: p.type ?? defaultType,
    }))

  const handleImport = () => {
    onImport(toImportArray())
    onClose()
  }

  const handleTransform = () => {
    if (!onOpenTransform) return
    onOpenTransform(toImportArray())
  }

  const updatePoint = (idx: number, patch: Partial<OcrPoint>) => {
    setPoints((prev) => prev.map((p, i) => (i === idx ? { ...p, ...patch } : p)))
  }
  const deletePoint = (idx: number) => {
    setPoints((prev) => prev.filter((_, i) => i !== idx))
  }

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[3500] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <div className="font-medium">座標 を AI で 読取</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              画像 / PDF / クリップボード 貼付 → Claude Vision で 座標 を 抽出。 日本 の 平面直角 (X=北, Y=東) を 前提
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-4 space-y-3">
          {/* 入力 エリア */}
          <div
            onDragOver={(e) => {
              e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              const list = Array.from(e.dataTransfer?.files ?? [])
              for (const f of list) void addFile(f)
            }}
            className="border-2 border-dashed border-slate-300 rounded p-6 text-center bg-slate-50"
          >
            <div className="text-sm text-slate-700">
              <ImageIcon className="h-5 w-5 inline mr-1 text-slate-500" />
              <FileText className="h-5 w-5 inline mr-2 text-slate-500" />
              画像 (JPEG/PNG) または PDF を ドロップ、 または
            </div>
            <div className="mt-2 flex items-center justify-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const list = Array.from(e.target.files ?? [])
                  for (const f of list) void addFile(f)
                  if (fileInputRef.current) fileInputRef.current.value = ''
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
              >
                <Upload className="h-3.5 w-3.5" />
                ファイル を 選択
              </button>
              <span className="text-xs text-slate-500">または</span>
              <span className="inline-flex items-center gap-1 text-xs text-slate-700 px-2 py-1 bg-white border rounded">
                <Clipboard className="h-3.5 w-3.5" />
                Ctrl+V で 貼付 (スクショ 可)
              </span>
            </div>
            <div className="mt-1 text-[11px] text-slate-500">
              1 ファイル 10 MB まで、 1 回 で 10 件 まで
            </div>
          </div>

          {/* 入力 ファイル リスト */}
          {files.length > 0 && (
            <div className="border rounded">
              <div className="px-3 py-1.5 bg-slate-50 text-xs font-medium border-b">
                入力 ({files.length})
              </div>
              <ul className="divide-y">
                {files.map((f) => (
                  <li key={f.key} className="px-3 py-2 flex items-center gap-2 text-xs">
                    {f.previewUrl ? (
                      <img
                        src={f.previewUrl}
                        alt=""
                        className="h-10 w-10 object-cover rounded border"
                      />
                    ) : (
                      <FileText className="h-10 w-10 p-2 text-slate-400 bg-slate-50 rounded border" />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-mono">{f.name}</div>
                      <div className="text-[10px] text-slate-500">
                        {f.mimeType} ・ {(f.sizeBytes / 1024).toFixed(0)} KB
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => removeFile(f.key)}
                      className="p-1 rounded hover:bg-red-50 text-red-500"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
              <div className="px-3 py-2 border-t flex justify-end bg-slate-50">
                <button
                  type="button"
                  onClick={handleRead}
                  disabled={loading}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      読取中…
                    </>
                  ) : (
                    '読取 実行'
                  )}
                </button>
              </div>
            </div>
          )}

          {/* エラー 表示 */}
          {error && (
            <div className="flex items-start gap-2 p-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded whitespace-pre-wrap">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}

          {/* プレビュー 表 (読取結果) */}
          {points.length > 0 && (
            <div className="border rounded">
              <div className="px-3 py-1.5 bg-emerald-50 text-xs font-medium border-b flex items-center gap-2 flex-wrap">
                <span>読取結果 ({points.length} 点)</span>
                {dedupedCount > 0 && (
                  <span className="text-[11px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                    同一 座標 {dedupedCount} 件 を 自動 削除
                  </span>
                )}
                <span className="text-[11px] text-slate-500">
                  間違い が ある 行 は 編集 または × で 削除 して ください
                </span>
              </div>
              <div className="max-h-80 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left w-32">点番号</th>
                      <th className="px-2 py-1 text-right w-24">X (m)</th>
                      <th className="px-2 py-1 text-right w-24">Y (m)</th>
                      <th className="px-2 py-1 text-right w-20">Z (m)</th>
                      <th className="px-2 py-1 text-left w-20">種別</th>
                      <th className="px-2 py-1 text-right w-14">信頼</th>
                      <th className="px-2 py-1 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {points.map((p, i) => {
                      const lowConf = p.confidence < 0.5
                      return (
                        <tr
                          key={i}
                          className={lowConf ? 'bg-amber-50/40' : 'hover:bg-slate-50'}
                        >
                          <td className="px-1 py-0.5">
                            <input
                              type="text"
                              value={p.pointNumber}
                              onChange={(e) => updatePoint(i, { pointNumber: e.target.value })}
                              className="w-full px-1 py-0.5 border rounded font-mono"
                            />
                          </td>
                          <td className="px-1 py-0.5">
                            <input
                              type="number"
                              step="0.001"
                              value={String(p.x)}
                              onChange={(e) =>
                                updatePoint(i, { x: parseFloat(e.target.value) || 0 })
                              }
                              className="w-full px-1 py-0.5 border rounded font-mono text-right"
                            />
                          </td>
                          <td className="px-1 py-0.5">
                            <input
                              type="number"
                              step="0.001"
                              value={String(p.y)}
                              onChange={(e) =>
                                updatePoint(i, { y: parseFloat(e.target.value) || 0 })
                              }
                              className="w-full px-1 py-0.5 border rounded font-mono text-right"
                            />
                          </td>
                          <td className="px-1 py-0.5">
                            <input
                              type="number"
                              step="0.001"
                              value={p.z == null ? '' : String(p.z)}
                              onChange={(e) => {
                                const v = e.target.value.trim()
                                if (v === '') updatePoint(i, { z: null })
                                else {
                                  const n = parseFloat(v)
                                  updatePoint(i, { z: Number.isFinite(n) ? n : null })
                                }
                              }}
                              className="w-full px-1 py-0.5 border rounded font-mono text-right"
                            />
                          </td>
                          <td className="px-1 py-0.5">
                            <select
                              value={(p.type ?? defaultType) as string}
                              onChange={(e) => updatePoint(i, { type: e.target.value || null })}
                              className="w-full px-1 py-0.5 border rounded bg-white"
                            >
                              {TYPE_OPTIONS.map(([key, label]) => (
                                <option key={key} value={key}>
                                  {label}
                                </option>
                              ))}
                              {/* AI が 既定 以外 を 返した 場合 の フォールバック */}
                              {p.type &&
                                !TYPE_OPTIONS.some(([k]) => k === p.type) && (
                                  <option value={p.type}>{p.type}</option>
                                )}
                            </select>
                          </td>
                          <td className="px-1 py-0.5 text-right font-mono text-[11px]">
                            <span className={lowConf ? 'text-amber-700' : 'text-slate-500'}>
                              {p.confidence.toFixed(2)}
                            </span>
                          </td>
                          <td className="px-1 py-0.5 text-center">
                            <button
                              type="button"
                              onClick={() => deletePoint(i)}
                              className="p-0.5 rounded hover:bg-red-50 text-red-500"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          {onOpenTransform && (
            <button
              type="button"
              onClick={handleTransform}
              disabled={points.length === 0}
              className="px-3 py-1.5 text-sm bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
              title="登録 前 に 世界測地変換 / 地殻変動補正 を 掛ける"
            >
              座標変換 →
            </button>
          )}
          <button
            type="button"
            onClick={handleImport}
            disabled={points.length === 0}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {points.length > 0 ? `登録 (${points.length} 点)` : '登録'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 同一 座標 (X, Y が 1mm 以内 で 一致) の 行 を 自動 削除。
 * 1 点 を 複数 回 記載 して ある 表 や、 OCR の 誤認識 で 行 が 二重 計上 される
 * ケース を 救う。 点番号 や 種別 が 違って も 座標 が 一致 すれ ば 同一 と 見做す。
 * 先 に 出現 した 方 を 残す。 Z は 片方 が null で 片方 が 値 持ち なら 値 持ち 側 を 残す。
 */
function dedupeByCoordinate(points: OcrPoint[]): OcrPoint[] {
  const TOL = 1e-3 // 1 mm
  const kept: OcrPoint[] = []
  for (const p of points) {
    const dup = kept.find(
      (q) => Math.abs(q.x - p.x) < TOL && Math.abs(q.y - p.y) < TOL,
    )
    if (dup) {
      // Z は 残して ある 行 が null で 新しい 行 に 値 が あれば 引き継ぐ
      if (dup.z == null && p.z != null) dup.z = p.z
      continue
    }
    kept.push({ ...p })
  }
  return kept
}

/** File → base64 (data URL の prefix は 除外) */
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  // ブラウザ で ArrayBuffer を base64 化
  let binary = ''
  const bytes = new Uint8Array(buf)
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
