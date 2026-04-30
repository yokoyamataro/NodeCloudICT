// 共通：LandXML（TIN サーフェス）から任意点の標高を計算し、
//        Z 補正量を加えてユーザーが確定するダイアログ。
//
// 使い方：
//   <TinElevationDialog
//     points={[{ id: 'p1', x: 100, y: 200, label: '配線#1 始点' }, ...]}
//     onConfirm={(zMap, surfaceName, offset) => { ... 各点の z を更新 ... }}
//     onClose={() => setShowDialog(false)}
//   />

import { useEffect, useMemo, useRef, useState } from 'react'
import { Upload, X, Check } from 'lucide-react'
import type { ParsedSurface } from '@/lib/landxml/parser'
import { indexTin, queryZ, loadLandXmlFile } from '@/lib/landxml/tinInterpolation'

export interface TinElevationPoint {
  id: string
  x: number // 北方向（平面直角座標）
  y: number // 東方向
  z?: number | null // 既存値（参考表示用）
  label?: string
}

export interface TinElevationDialogProps {
  /** 標高を求めたい点群 */
  points: TinElevationPoint[]
  /** 確定時のコールバック。zMap は id → 補正後 Z（補間できなければ undefined） */
  onConfirm: (zMap: Map<string, number>, opts: {
    surfaceName: string
    offset: number
    sourceFile: string | null
  }) => void
  onClose: () => void
}

export function TinElevationDialog({ points, onConfirm, onClose }: TinElevationDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [surfaces, setSurfaces] = useState<ParsedSurface[]>([])
  const [selectedSurfaceIdx, setSelectedSurfaceIdx] = useState<number>(0)
  const [offset, setOffset] = useState<number>(0)
  const [warnings, setWarnings] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [sourceFile, setSourceFile] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    setError(null)
    setWarnings([])
    try {
      const { surfaces: surfs, warnings: warns } = await loadLandXmlFile(file)
      if (surfs.length === 0) {
        setError('LandXML 内に TIN サーフェスが見つかりません')
        setSurfaces([])
      } else {
        setSurfaces(surfs)
        setSelectedSurfaceIdx(0)
        setSourceFile(file.name)
      }
      setWarnings(warns)
    } catch (err) {
      setError(err instanceof Error ? err.message : '読込エラー')
    } finally {
      setLoading(false)
      e.target.value = ''
    }
  }

  const surface = surfaces[selectedSurfaceIdx] ?? null

  // 各点の補間 Z（補正前）
  const interpolated = useMemo(() => {
    if (!surface) return new Map<string, number | null>()
    const idx = indexTin(surface)
    const map = new Map<string, number | null>()
    for (const p of points) {
      const z = queryZ(idx, p.x, p.y)
      map.set(p.id, z)
    }
    return map
  }, [surface, points])

  // 統計
  const stats = useMemo(() => {
    const total = points.length
    let resolved = 0
    let outside = 0
    for (const p of points) {
      const z = interpolated.get(p.id)
      if (z != null) resolved++
      else outside++
    }
    return { total, resolved, outside }
  }, [points, interpolated])

  const handleConfirm = () => {
    if (!surface) return
    const zMap = new Map<string, number>()
    for (const p of points) {
      const z = interpolated.get(p.id)
      if (z != null) zMap.set(p.id, z + offset)
    }
    onConfirm(zMap, {
      surfaceName: surface.name,
      offset,
      sourceFile,
    })
  }

  // Esc キーでクローズ
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">LandXML から標高を取込</h2>
            <p className="text-xs text-slate-500">TIN サーフェスから各点の Z を補間し、補正量を加えて確定します</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-3 overflow-auto flex-1">
          {/* 1) ファイル選択 */}
          <section className="space-y-2">
            <h3 className="text-sm font-medium text-slate-700">1. LandXML を選択</h3>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xml,.XML,.landxml,.LANDXML"
                onChange={handleFileChange}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                {loading ? '読込中…' : sourceFile ? `再選択（現在: ${sourceFile}）` : 'ファイルを選択'}
              </button>
            </div>
            {error && (
              <div className="text-xs text-red-600 bg-red-50 px-2 py-1 rounded">{error}</div>
            )}
            {warnings.length > 0 && (
              <details className="text-xs text-amber-700">
                <summary>警告 ({warnings.length})</summary>
                <ul className="list-disc list-inside">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}
          </section>

          {/* 2) サーフェス選択 */}
          {surfaces.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-slate-700">2. サーフェスを選択</h3>
              <select
                value={selectedSurfaceIdx}
                onChange={(e) => setSelectedSurfaceIdx(parseInt(e.target.value, 10))}
                className="w-full px-2 py-1.5 border rounded text-sm"
              >
                {surfaces.map((s, i) => (
                  <option key={s.id} value={i}>
                    {s.name}（点 {s.points.length} / 三角形 {s.triangles.length}）
                  </option>
                ))}
              </select>
            </section>
          )}

          {/* 3) 補正量入力 + 統計 */}
          {surface && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-slate-700">3. Z 補正量を指定</h3>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-sm">
                  <span>補正量 ΔZ</span>
                  <input
                    type="number"
                    step={0.01}
                    value={offset}
                    onChange={(e) => setOffset(parseFloat(e.target.value) || 0)}
                    className="w-24 px-2 py-1 border rounded text-right"
                  />
                  <span className="text-xs text-slate-500">m（補間 Z に加算）</span>
                </label>
                <div className="text-xs text-slate-500">
                  補間成功 {stats.resolved} / {stats.total}
                  {stats.outside > 0 && <span className="text-amber-700">（範囲外 {stats.outside}）</span>}
                </div>
              </div>
            </section>
          )}

          {/* 4) プレビュー */}
          {surface && (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-slate-700">4. プレビュー</h3>
              <div className="border rounded overflow-auto max-h-[300px]">
                <table className="w-full text-xs">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">点</th>
                      <th className="px-2 py-1 text-right font-medium">X (北)</th>
                      <th className="px-2 py-1 text-right font-medium">Y (東)</th>
                      <th className="px-2 py-1 text-right font-medium">既存 Z</th>
                      <th className="px-2 py-1 text-right font-medium">補間 Z</th>
                      <th className="px-2 py-1 text-right font-medium">補正後 Z</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {points.map((p) => {
                      const z = interpolated.get(p.id)
                      const final = z != null ? z + offset : null
                      return (
                        <tr key={p.id} className={z == null ? 'text-amber-700' : ''}>
                          <td className="px-2 py-1">{p.label ?? p.id}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{p.x.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{p.y.toFixed(3)}</td>
                          <td className="px-2 py-1 text-right tabular-nums text-slate-400">{p.z != null ? p.z.toFixed(3) : '-'}</td>
                          <td className="px-2 py-1 text-right tabular-nums">{z != null ? z.toFixed(3) : '範囲外'}</td>
                          <td className="px-2 py-1 text-right tabular-nums font-medium">{final != null ? final.toFixed(3) : '-'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded hover:bg-slate-50">
            キャンセル
          </button>
          <button
            onClick={handleConfirm}
            disabled={!surface || stats.resolved === 0}
            className="flex items-center gap-1 px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            確定（{stats.resolved} 点に適用）
          </button>
        </div>
      </div>
    </div>
  )
}
