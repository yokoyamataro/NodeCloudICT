// 暗渠 CAD (DXF) を AI 補助で解析して pipe を一括取込するモーダル。
//
// フロー:
//   1. DXF 選択 → parse
//   2. レイヤ振り分け UI (自動推定 + 手動修正)
//   3. 配管前処理 (LINE フィルタ + pipe run 化 + CIRCLE 切断)
//   4. 情報 regex + ニアレスト暫定対応付け
//   5. 「AI で不足を補正」ボタン (needsAi の pipe run だけ Sonnet に投げる)
//   6. プレビュー (各 run の管径・長さ・source・confidence を表示)
//   7. 「一括取込」→ design_pipes に INSERT
//
// 座標系: DXF が平面直角座標 (プロジェクトの zone) 前提。既存の
// entitiesToPipes と同じ swap (x→y, y→x) をここでも行う。

import { useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, Upload, X, Sparkles } from 'lucide-react'
import {
  parseDxf,
  readDxfFile,
  layerStats,
  type DxfParseResult,
  type LayerStats,
} from '@/lib/dxfAnalyze/parse'
import {
  buildPipeRuns,
  type PipeRun,
} from '@/lib/dxfAnalyze/pipePreprocess'
import {
  parseInfoLabels,
  pairRunsWithLabels,
  type PairingResult,
} from '@/lib/dxfAnalyze/infoParse'
import { analyzeUnderdrainCad, type AiExtractedPipe } from '@/lib/dxfAnalyze/aiClient'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import type { PipeVertex } from '@/types/database'

interface Props {
  projectId: string
  farmId?: string | null
  onClose: () => void
  /** 取込成功時に呼ぶ (pipe count) */
  onDone?: (importedCount: number) => void
}

interface AiResultRow {
  runId: string
  diameterMm: number | null
  lengthM: number | null
  source: 'label' | 'computed' | 'ai'
  confidence: number
  warnings: string[]
}

export function CadAiImportModal({ projectId, farmId, onClose, onDone }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [parseResult, setParseResult] = useState<DxfParseResult | null>(null)
  const [stats, setStats] = useState<LayerStats[]>([])
  const [pipeLayers, setPipeLayers] = useState<Set<string>>(new Set())
  const [infoLayers, setInfoLayers] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'parse' | 'ai' | 'import' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pipeRuns, setPipeRuns] = useState<PipeRun[]>([])
  const [pairing, setPairing] = useState<PairingResult[]>([])
  const [aiResults, setAiResults] = useState<Map<string, AiExtractedPipe>>(new Map())
  const [message, setMessage] = useState<string | null>(null)

  const addPipe = useUnderdrainStore((s) => s.addPipe)

  // -------------------- Step 1: DXF 選択 & parse --------------------
  const handleFileChosen = async (f: File) => {
    setFile(f)
    setError(null)
    setBusy('parse')
    try {
      const text = await readDxfFile(f)
      const result = parseDxf(text)
      setParseResult(result)
      const s = layerStats(result)
      setStats(s)
      // 自動推定: pipeScore > 0.7 を配管候補、infoScore > 0.7 を情報候補
      const p = new Set<string>()
      const info = new Set<string>()
      for (const st of s) {
        if (st.pipeScore >= 0.7 && st.lineCount + st.circleCount > 0) p.add(st.name)
        if (st.infoScore >= 0.7 && st.textCount > 0) info.add(st.name)
      }
      setPipeLayers(p)
      setInfoLayers(info)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const toggleLayer = (name: string, target: 'pipe' | 'info') => {
    if (target === 'pipe') {
      const n = new Set(pipeLayers)
      if (n.has(name)) n.delete(name)
      else {
        n.add(name)
        // 排他: info からは外す
        const info = new Set(infoLayers)
        info.delete(name)
        setInfoLayers(info)
      }
      setPipeLayers(n)
    } else {
      const n = new Set(infoLayers)
      if (n.has(name)) n.delete(name)
      else {
        n.add(name)
        const pipe = new Set(pipeLayers)
        pipe.delete(name)
        setPipeLayers(pipe)
      }
      setInfoLayers(n)
    }
  }

  // -------------------- Step 2: pipe run + label 事前対応付け --------------------
  const runPreprocess = () => {
    if (!parseResult) return
    setError(null)
    const pipeLines = parseResult.entities.filter(
      (e) => e.type === 'LINE' && pipeLayers.has(e.layer),
    ) as import('@/lib/dxfAnalyze/parse').DxfLineEntity[]
    const circles = parseResult.entities.filter(
      (e) => e.type === 'CIRCLE' && pipeLayers.has(e.layer),
    ) as import('@/lib/dxfAnalyze/parse').DxfCircleEntity[]
    const texts = parseResult.entities.filter(
      (e) =>
        (e.type === 'TEXT' || e.type === 'MTEXT') && infoLayers.has(e.layer),
    ) as import('@/lib/dxfAnalyze/parse').DxfTextEntity[]

    const { pipeRuns: runs } = buildPipeRuns(pipeLines, circles)
    setPipeRuns(runs)
    const labels = parseInfoLabels(texts)
    const pair = pairRunsWithLabels(
      runs.map((r) => ({
        runId: r.id,
        centerX: r.centerX,
        centerY: r.centerY,
        vertices: r.vertices,
        lengthMm: r.lengthMm,
      })),
      labels,
    )
    setPairing(pair)
    setAiResults(new Map())
    setMessage(
      `配管 ${runs.length} 本を検出、うち ${pair.filter((p) => p.diameterMm != null).length} 本は事前パースで管径確定。残りは AI で補正できます。`,
    )
  }

  // -------------------- Step 3: AI で補正 --------------------
  const runAi = async () => {
    if (!parseResult || pairing.length === 0) return
    setError(null)
    setBusy('ai')
    try {
      const texts = parseResult.entities.filter(
        (e) =>
          (e.type === 'TEXT' || e.type === 'MTEXT') && infoLayers.has(e.layer),
      ) as import('@/lib/dxfAnalyze/parse').DxfTextEntity[]
      const circles = parseResult.entities.filter(
        (e) => e.type === 'CIRCLE' && pipeLayers.has(e.layer),
      ) as import('@/lib/dxfAnalyze/parse').DxfCircleEntity[]
      const labels = parseInfoLabels(texts)
      const tentative = new Map<
        string,
        { diameterMm: number | null; lengthM: number | null; source: 'label' | 'computed' | null }
      >()
      for (const p of pairing) {
        tentative.set(p.runId, {
          diameterMm: p.diameterMm,
          lengthM: p.lengthM,
          source: p.lengthSource,
        })
      }
      const res = await analyzeUnderdrainCad({
        projectId,
        farmId,
        pipeRuns,
        labels,
        splitCircles: circles,
        tentativeByRunId: tentative,
      })
      const map = new Map<string, AiExtractedPipe>()
      for (const p of res.pipes) map.set(p.pipe_id, p)
      setAiResults(map)
      setMessage(
        `AI 解析完了: 全体信頼度 ${(res.confidence * 100).toFixed(0)}%. 未マッチ pipe: ${res.unmatched_pipe_ids.length}, 未マッチラベル: ${res.unmatched_labels.length}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // -------------------- Step 4: 表示用マージ --------------------
  const finalRows = useMemo<AiResultRow[]>(() => {
    return pairing.map((p) => {
      const ai = aiResults.get(p.runId)
      if (ai) {
        return {
          runId: p.runId,
          diameterMm: ai.diameter_mm,
          lengthM: ai.length_m,
          source: 'ai',
          confidence: ai.confidence,
          warnings: ai.warnings,
        }
      }
      return {
        runId: p.runId,
        diameterMm: p.diameterMm,
        lengthM: p.lengthM,
        source: p.lengthSource === 'label' ? 'label' : 'computed',
        confidence: p.diameterMm != null && p.lengthM != null ? 0.9 : 0.5,
        warnings: [],
      }
    })
  }, [pairing, aiResults])

  // -------------------- Step 5: 取込 --------------------
  const runImport = async () => {
    if (finalRows.length === 0) return
    setBusy('import')
    setError(null)
    let ok = 0
    try {
      // DXF (X=東, Y=北) → 平面直角座標 (X=北, Y=東) に swap する
      // 既存の src/lib/dxf-parser.ts と同じ挙動 (呼び出し側で吸収済み)
      for (let i = 0; i < pipeRuns.length; i++) {
        const run = pipeRuns[i]
        const row = finalRows[i]
        if (!row) continue
        // 管径が null の pipe はスキップ (取り込むと使い物にならないため)
        if (row.diameterMm == null) continue
        const vertices: PipeVertex[] = run.vertices.map((v) => ({
          x: v.y,
          y: v.x,
          z: v.z,
        }))
        const number = `P${String(i + 1).padStart(3, '0')}`
        await addPipe({
          number,
          layerName: 'CAD-AI',
          pipeType: null,
          diameter: row.diameterMm,
          designLength: row.lengthM ?? run.lengthMm / 1000,
          measuredLength: null,
          vertices,
          connectionTo: null,
          notes: null,
        })
        ok++
      }
      setMessage(`${ok} 本を取り込みました`)
      onDone?.(ok)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  // -------------------- UI --------------------
  return (
    <div
      className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-600" />
            <span className="text-sm font-semibold">
              暗渠 CAD (DXF) を AI 解析で取込
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4 text-sm">
          {error && (
            <div className="p-2 text-xs bg-red-50 text-red-700 border border-red-200 rounded flex items-start gap-2">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}
          {message && !error && (
            <div className="p-2 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded">
              {message}
            </div>
          )}

          {/* Step 1: ファイル選択 */}
          <section>
            <div className="text-xs font-semibold text-slate-600 mb-1">
              1. DXF ファイル
            </div>
            <label className="inline-flex items-center gap-2 px-3 py-1.5 border rounded cursor-pointer bg-slate-50 hover:bg-slate-100">
              <Upload className="h-3.5 w-3.5" />
              <span className="text-xs">
                {file ? file.name : 'DXF を選択…'}
              </span>
              <input
                type="file"
                accept=".dxf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void handleFileChosen(f)
                }}
              />
            </label>
            {busy === 'parse' && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                解析中…
              </span>
            )}
          </section>

          {/* Step 2: レイヤ振り分け */}
          {stats.length > 0 && (
            <section>
              <div className="text-xs font-semibold text-slate-600 mb-1">
                2. レイヤ振り分け (自動推定済み。必要なら手動修正)
              </div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-500 border-b">
                    <th className="text-left py-1 pl-1">レイヤ</th>
                    <th className="text-right py-1">LINE</th>
                    <th className="text-right py-1">CIRCLE</th>
                    <th className="text-right py-1">TEXT</th>
                    <th className="text-center py-1 w-16">配管</th>
                    <th className="text-center py-1 w-16">情報</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.name} className="border-b">
                      <td className="py-1 pl-1 font-mono">{s.name}</td>
                      <td className="py-1 text-right text-slate-600">
                        {s.lineCount}
                      </td>
                      <td className="py-1 text-right text-slate-600">
                        {s.circleCount}
                      </td>
                      <td className="py-1 text-right text-slate-600">
                        {s.textCount}
                      </td>
                      <td className="py-1 text-center">
                        <input
                          type="checkbox"
                          checked={pipeLayers.has(s.name)}
                          onChange={() => toggleLayer(s.name, 'pipe')}
                        />
                      </td>
                      <td className="py-1 text-center">
                        <input
                          type="checkbox"
                          checked={infoLayers.has(s.name)}
                          onChange={() => toggleLayer(s.name, 'info')}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={runPreprocess}
                  disabled={pipeLayers.size === 0 || infoLayers.size === 0}
                  className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-40"
                >
                  事前パース実行
                </button>
                <span className="text-[10px] text-slate-500">
                  ※ 配管レイヤと情報レイヤを各 1 個以上選択
                </span>
              </div>
            </section>
          )}

          {/* Step 3: pipe run 結果 + AI 呼び出し */}
          {pipeRuns.length > 0 && (
            <section>
              <div className="text-xs font-semibold text-slate-600 mb-1 flex items-center gap-2">
                3. Pipe run: {pipeRuns.length} 本
                <button
                  onClick={runAi}
                  disabled={busy === 'ai'}
                  className="ml-auto flex items-center gap-1 px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700 disabled:opacity-40"
                >
                  {busy === 'ai' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="h-3 w-3" />
                  )}
                  AI で不足を補正 (Sonnet)
                </button>
              </div>
              <div className="max-h-64 overflow-auto border rounded">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-slate-50">
                    <tr className="text-slate-500 border-b">
                      <th className="text-left py-1 pl-1">ID</th>
                      <th className="text-right py-1">頂点</th>
                      <th className="text-right py-1">管径 (mm)</th>
                      <th className="text-right py-1">長さ (m)</th>
                      <th className="text-left py-1 pl-2">由来</th>
                      <th className="text-right py-1">信頼度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {finalRows.map((r) => (
                      <tr key={r.runId} className="border-b">
                        <td className="py-1 pl-1 font-mono text-slate-600">
                          {r.runId}
                        </td>
                        <td className="py-1 text-right text-slate-500">
                          {pipeRuns.find((p) => p.id === r.runId)?.vertices.length ?? 0}
                        </td>
                        <td
                          className={`py-1 text-right font-mono ${
                            r.diameterMm == null ? 'text-red-500' : ''
                          }`}
                        >
                          {r.diameterMm ?? '-'}
                        </td>
                        <td className="py-1 text-right font-mono">
                          {r.lengthM != null ? r.lengthM.toFixed(1) : '-'}
                        </td>
                        <td className="py-1 pl-2 text-slate-500">
                          {r.source === 'label'
                            ? 'ラベル'
                            : r.source === 'computed'
                              ? '座標'
                              : 'AI'}
                        </td>
                        <td
                          className={`py-1 text-right font-mono ${
                            r.confidence < 0.5
                              ? 'text-red-500'
                              : r.confidence < 0.8
                                ? 'text-amber-600'
                                : 'text-slate-600'
                          }`}
                        >
                          {(r.confidence * 100).toFixed(0)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={runImport}
            disabled={
              busy !== null ||
              finalRows.length === 0 ||
              finalRows.every((r) => r.diameterMm == null)
            }
            className="flex items-center gap-1 px-3 py-1 text-xs bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-40"
          >
            {busy === 'import' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            管径確定分を一括取込 ({finalRows.filter((r) => r.diameterMm != null).length} 本)
          </button>
        </div>
      </div>
    </div>
  )
}
