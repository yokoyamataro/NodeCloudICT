// 測地座標変換 モーダル。
//
// 選択 中 の チェック済 点 に 対して 以下 を 適用:
//   - 世界測地変換 (TKY2JGD): 日本測地系 (Bessel) → 世界測地系 (JGD2000, GRS80)
//   - 地殻変動補正 (PATCHJGD): JGD2000 → JGD2011 等 (地震毎 の グリッド)
//
// 結果 は 上書き (元 の 行 の X, Y を そのまま 置き換え)。
// プレビュー 表 で 差分 を 確認 して から 「上書き 実行」 を 押す 流れ。

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Loader2, X } from 'lucide-react'
import { convertPoint, type Grid } from '@/lib/geodetic/converter'
import { loadPatchGrid, loadTkyGrid, PATCH_CATALOG } from '@/lib/geodetic/gridLoader'

export interface GeodeticTargetPoint {
  id: string
  pointNumber: string
  x: number
  y: number
}

interface Props {
  open: boolean
  onClose: () => void
  /** チェック済 の 点 (親 側 で 絞る) */
  points: GeodeticTargetPoint[]
  /** 系番号 (project.coordinate_zone) */
  systemNo: number
  /** 上書き 実行。 { id, x, y } の 配列 を 親 に 渡す */
  onApply: (updates: Array<{ id: string; x: number; y: number }>) => Promise<void> | void
}

interface Row extends GeodeticTargetPoint {
  newX: number | null
  newY: number | null
  ok: boolean
  reason?: string
}

export function GeodeticTransformModal({ open, onClose, points, systemNo, onApply }: Props) {
  const [applyTky, setApplyTky] = useState(true)
  const [applyPatch, setApplyPatch] = useState(false)
  const [patchPath, setPatchPath] = useState<string>(PATCH_CATALOG[0]?.path ?? '')

  const [tkyGrid, setTkyGrid] = useState<Grid | null>(null)
  const [patchGrid, setPatchGrid] = useState<Grid | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const [rows, setRows] = useState<Row[]>([])

  useEffect(() => {
    if (!open) {
      setRows([])
      setError(null)
      setApplying(false)
      setLoading(false)
    }
  }, [open])

  const needTky = applyTky
  const needPatch = applyPatch

  const handleCompute = async () => {
    if (!needTky && !needPatch) {
      setError('世界測地変換 と 地殻変動補正 の 少なくとも 片方 を 選んで ください')
      return
    }
    setLoading(true)
    setError(null)
    try {
      let tky: Grid | null = tkyGrid
      let patch: Grid | null = patchGrid
      if (needTky && !tky) {
        tky = await loadTkyGrid()
        setTkyGrid(tky)
      }
      if (needPatch) {
        // 選択 の patch が 違えば ロード し直し
        if (!patch || patch.name !== patchPath.split('/').pop()) {
          patch = await loadPatchGrid(patchPath)
          setPatchGrid(patch)
        }
      }
      const next: Row[] = points.map((p) => {
        const r = convertPoint(p.x, p.y, systemNo, {
          tkyGrid: needTky ? tky ?? undefined : undefined,
          patchGrid: needPatch ? patch ?? undefined : undefined,
        })
        return {
          ...p,
          newX: r.ok ? r.X : null,
          newY: r.ok ? r.Y : null,
          ok: r.ok,
          reason: r.reason,
        }
      })
      setRows(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const okCount = useMemo(() => rows.filter((r) => r.ok).length, [rows])
  const ngCount = rows.length - okCount

  const handleApply = async () => {
    if (okCount === 0) return
    if (!window.confirm(`${okCount} 点 を 上書き します。 よろしい ですか?`)) return
    setApplying(true)
    try {
      const updates = rows
        .filter((r) => r.ok && r.newX != null && r.newY != null)
        .map((r) => ({ id: r.id, x: r.newX as number, y: r.newY as number }))
      await onApply(updates)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setApplying(false)
    }
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
            <div className="font-medium">測地座標変換 (世界測地変換 / 地殻変動補正)</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              チェック 済 の {points.length} 点 に TKY2JGD / PATCHJGD を 適用 し、 上書き します。 系番号 第{systemNo}系
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
          {/* 変換 条件 */}
          <div className="border rounded">
            <div className="px-3 py-1.5 bg-slate-50 text-xs font-medium border-b">変換 条件</div>
            <div className="p-3 space-y-2">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={applyTky}
                  onChange={(e) => setApplyTky(e.target.checked)}
                  className="mt-0.5"
                />
                <div>
                  <div>世界測地変換 (TKY2JGD)</div>
                  <div className="text-[11px] text-slate-500">
                    日本測地系 (Bessel) → 世界測地系 (JGD2000)。 入力 が 旧 測地系 の 時 のみ ON。
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={applyPatch}
                  onChange={(e) => setApplyPatch(e.target.checked)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div>地殻変動補正 (PATCHJGD)</div>
                  <div className="text-[11px] text-slate-500 mb-1">
                    地震 等 で ズレ た 成果 を 最新 の 地殻 状態 に 揃える。 補正量 は 地震 毎 の グリッド で 変わる。
                  </div>
                  {applyPatch && (
                    <select
                      value={patchPath}
                      onChange={(e) => {
                        setPatchPath(e.target.value)
                        setPatchGrid(null)
                      }}
                      className="w-full px-2 py-1 text-sm border rounded bg-white"
                    >
                      {PATCH_CATALOG.slice()
                        .sort((a, b) => b.year - a.year)
                        .map((p) => (
                          <option key={p.path} value={p.path}>
                            {p.label}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
              </label>
            </div>
            <div className="px-3 py-2 border-t bg-slate-50 flex justify-end">
              <button
                type="button"
                onClick={handleCompute}
                disabled={loading || points.length === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    グリッド 読込 + 計算中…
                  </>
                ) : (
                  '変換 プレビュー'
                )}
              </button>
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 p-2 text-xs bg-red-50 border border-red-200 text-red-700 rounded whitespace-pre-wrap">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}

          {/* プレビュー 表 */}
          {rows.length > 0 && (
            <div className="border rounded">
              <div className="px-3 py-1.5 bg-emerald-50 text-xs font-medium border-b flex items-center gap-2 flex-wrap">
                <span>変換 結果 ({rows.length} 点)</span>
                <span className="text-[11px] text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">
                  成功 {okCount}
                </span>
                {ngCount > 0 && (
                  <span className="text-[11px] text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">
                    範囲外 / 失敗 {ngCount}
                  </span>
                )}
                <span className="text-[11px] text-slate-500">
                  成功 行 のみ 上書き されます
                </span>
              </div>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left w-24">点番号</th>
                      <th className="px-2 py-1 text-right w-24">元 X (m)</th>
                      <th className="px-2 py-1 text-right w-24">元 Y (m)</th>
                      <th className="px-2 py-1 text-right w-24">新 X (m)</th>
                      <th className="px-2 py-1 text-right w-24">新 Y (m)</th>
                      <th className="px-2 py-1 text-right w-20">ΔX (m)</th>
                      <th className="px-2 py-1 text-right w-20">ΔY (m)</th>
                      <th className="px-2 py-1 text-left w-32">備考</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((r) => (
                      <tr key={r.id} className={r.ok ? 'hover:bg-slate-50' : 'bg-amber-50/60'}>
                        <td className="px-2 py-0.5 font-mono">{r.pointNumber}</td>
                        <td className="px-2 py-0.5 text-right font-mono">{r.x.toFixed(3)}</td>
                        <td className="px-2 py-0.5 text-right font-mono">{r.y.toFixed(3)}</td>
                        <td className="px-2 py-0.5 text-right font-mono">
                          {r.newX != null ? r.newX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-0.5 text-right font-mono">
                          {r.newY != null ? r.newY.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-0.5 text-right font-mono">
                          {r.ok && r.newX != null ? (r.newX - r.x).toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-0.5 text-right font-mono">
                          {r.ok && r.newY != null ? (r.newY - r.y).toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-0.5 text-[11px] text-amber-700">
                          {r.ok ? '' : r.reason ?? '失敗'}
                        </td>
                      </tr>
                    ))}
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
          <button
            type="button"
            onClick={handleApply}
            disabled={okCount === 0 || applying}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {applying ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                上書き 中…
              </>
            ) : (
              `上書き 実行 (${okCount} 点)`
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
