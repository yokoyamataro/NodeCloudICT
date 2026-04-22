import { useEffect, useMemo, useState } from 'react'
import { PenTool, Download, FileText, Loader2 } from 'lucide-react'
import Encoding from 'encoding-japanese'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useConstructionPlanStore, type PlanGroup, type PlanPoint } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'

// 図面レベル（座標変換用パラメータ）
interface DrawingLevel {
  originX: number
  originY: number
  scaleV: number // 縦縮尺（例: 1000 = 1/1000）
  scaleH: number // 横縮尺（例: 1000 = 1/1000）
  rotation: number // 回転角（ラジアン）
}

const DEFAULT_LEVEL: DrawingLevel = {
  originX: 0,
  originY: 0,
  scaleV: 1000,
  scaleH: 1000,
  rotation: 0,
}

// 実座標 (x, y) を用紙座標へ変換（旧マクロ 用紙座標 関数と完全一致）
// 極座標形式:
//   1. 原点シフト: dx = x - x0, dy = y - y0
//   2. 角度計算: a0 = atan(dy/dx)
//   3. 距離: s1 = sqrt(dx²+dy²)
//   4. 回転: a1 = a0 + 回転角, π で 2 回までの wrap
//   5. 直交座標に戻す: x1 = s1 * cos(a1), y1 = s1 * sin(a1)
// ※ 縮尺は旧マクロでも使用されていない
function toPaperCoords(
  x: number,
  y: number,
  level: DrawingLevel,
): { px: number; py: number } {
  const dx = x - level.originX
  const dy = y - level.originY
  if (dx === 0 && dy === 0) return { px: 0, py: 0 }
  const a0 = Math.atan(dy / dx)
  const s1 = Math.sqrt(dx * dx + dy * dy)
  let a1 = a0 + level.rotation
  if (a1 >= Math.PI) a1 -= Math.PI
  if (a1 >= Math.PI) a1 -= Math.PI
  const px = s1 * Math.cos(a1)
  const py = s1 * Math.sin(a1)
  return { px, py }
}

// 文字要素行（TrendOne アスキー形式）を生成（旧マクロ 文字入力 関数と同じ）
//   mx = Len(text) * moji / 2 * cos(angle)
//   my = Len(text) * moji / 2 * sin(angle)
//   出力: `5,<layer>,100,<color>,0,1,0,<pointType>,0,0,0,0,<x>,<y>,<mx>,<my>,<moji>,0,10,0,5,0,0,0,0,0,1,0.000000,0.000000,ＭＳ ゴシック,<text>`
function buildTextElement(
  layer: number,
  color: number,
  pointType: string,
  x: number,
  y: number,
  angle: number,
  size: number,
  text: string,
): string {
  const halfLen = (text.length * size) / 2
  const mx = halfLen * Math.cos(angle)
  const my = halfLen * Math.sin(angle)
  const fx = x.toFixed(6)
  const fy = y.toFixed(6)
  const fmx = mx.toFixed(6)
  const fmy = my.toFixed(6)
  return `5,${layer},100,${color},0,1,0,${pointType},0,0,0,0,${fx},${fy},${fmx},${fmy},${size},0,10,0,5,0,0,0,0,0,1,0.000000,0.000000,ＭＳ ゴシック,${text}`
}

// 旧マクロ同様のヘッダを生成（Level 行は固定値）
function buildHeader(): string[] {
  return [
    '0,NORDIC SYSTEM,VERSION=3.00,BUILDNO=3014',
    'L , 1',
    'V , 1',
    'T , 0',
    'E , 3',
    'Z , LAYER',
    '2050,吸水測点',
    '2051,吸水地盤高',
    '2052,吸水計画高',
    '2053,吸水切深',
    '2054,吸水勾配',
    '2055,集水測点',
    '2056,集水地盤高',
    '2057,集水計画高',
    '2058,集水切深',
    '2059,集水勾配',
    'Z , Level',
    '100,0.000000,0.000000,1,1,6.0,0,用紙系',
    'Z , LineType',
    'Z , ELEMENT',
  ]
}

function formatHeight(v: number | null | undefined): string {
  if (v === null || v === undefined) return ''
  return v.toFixed(2)
}

// 頂点インデックスから測点名を生成（generatePointName の規則: C / B{n} / A、B は下流起点）
function generatePointName(pipeNumber: string, idx: number, total: number): string {
  if (total <= 0) return pipeNumber
  if (idx === 0) return `${pipeNumber}C`
  if (idx === total - 1) return `${pipeNumber}A`
  const middleIndex = total - 1 - idx
  return `${pipeNumber}B${middleIndex}`
}

// 管ID × 頂点インデックス → PlanPoint のルックアップを構築
// 吸水管は idx 対応、集水管は座標一致で検出
function buildPlanLookup(
  planGroups: PlanGroup[],
  pipes: PipeRow[],
): Map<string, Map<number, PlanPoint>> {
  const map = new Map<string, Map<number, PlanPoint>>()
  const EPS = 1e-4
  for (const group of planGroups) {
    for (const row of group.rows) {
      if (row.absorptionPipeId) {
        const pipe = pipes.find((p) => p.id === row.absorptionPipeId)
        if (pipe) {
          const inner = map.get(row.absorptionPipeId) ?? new Map<number, PlanPoint>()
          const limit = Math.min(row.absorptionPoints.length, pipe.vertices.length)
          for (let i = 0; i < limit; i++) {
            inner.set(i, row.absorptionPoints[i])
          }
          map.set(row.absorptionPipeId, inner)
        }
      }
      if (row.collectorPipeId && row.collectorPoint) {
        const pipe = pipes.find((p) => p.id === row.collectorPipeId)
        if (pipe) {
          const inner = map.get(row.collectorPipeId) ?? new Map<number, PlanPoint>()
          for (let i = 0; i < pipe.vertices.length; i++) {
            const v = pipe.vertices[i]
            if (
              Math.abs(v.x - row.collectorPoint.x) < EPS &&
              Math.abs(v.y - row.collectorPoint.y) < EPS
            ) {
              inner.set(i, row.collectorPoint)
              break
            }
          }
          map.set(row.collectorPipeId, inner)
        }
      }
    }
  }
  return map
}

// 配管単位で全頂点の文字要素行を生成
function buildTextLines(
  pipes: PipeRow[],
  planGroups: PlanGroup[],
  level: DrawingLevel,
  moji: number,
  absorptionStdDepth: number,
  collectorStdDepth: number,
): string[] {
  const lines: string[] = []
  const HALF_PI = Math.PI / 2
  // 各文字を積むオフセット: 旧マクロは x -= moji * sin(a0), y += moji * cos(a0)
  const stepDx = -moji * Math.sin(HALF_PI)
  const stepDy = moji * Math.cos(HALF_PI)

  const planLookup = buildPlanLookup(planGroups, pipes)

  for (const pipe of pipes) {
    if (pipe.vertices.length === 0) continue

    // 吸水管（branch）は 2050 系レイヤ、それ以外（集水・落口等）は 2055 系レイヤ
    const isAbsorption = pipe.pipeType === 'branch'
    const layers = isAbsorption
      ? { point: 2050, ground: 2051, plan: 2052, depth: 2053, slope: 2054, planColor: 1 }
      : { point: 2055, ground: 2056, plan: 2057, depth: 2058, slope: 2059, planColor: 5 }
    const stdDepth = isAbsorption ? absorptionStdDepth : collectorStdDepth
    const initialYOffset = isAbsorption ? 1 : moji * 3.2

    const planForPipe = planLookup.get(pipe.id) ?? null
    const total = pipe.vertices.length

    for (let i = 0; i < total; i++) {
      const v = pipe.vertices[i]
      const pp = planForPipe?.get(i) ?? null
      const { px: x1, py: y1 } = toPaperCoords(v.x, v.y, level)

      // 前頂点方向（勾配ラベルの角度算出用）
      let segAngle = 0
      let midX = x1
      let midY = y1
      if (i > 0) {
        const prev = pipe.vertices[i - 1]
        const prevP = toPaperCoords(prev.x, prev.y, level)
        const dx = prevP.px - x1
        const dy = prevP.py - y1
        segAngle = calcTextAngle(dx, dy)
        midX = (x1 + prevP.px) / 2
        midY = (y1 + prevP.py) / 2
      }

      const pointName = pp?.pointName || generatePointName(pipe.number, i, total)
      const gh = pp?.groundHeight ?? v.z ?? null
      const ph = pp?.plannedHeight ?? null
      const cd =
        pp?.cutDepth ??
        (gh !== null && ph !== null ? gh - ph : null)
      const ghStr = formatHeight(gh)
      const fhStr = formatHeight(ph)
      const chStr = formatHeight(cd)

      // 勾配計算: 計画高データがあれば plannedHeight 差分、なければ頂点 z 差分
      let slopeLabel: string | null = null
      if (i > 0) {
        const prev = pipe.vertices[i - 1]
        const prevPP = planForPipe?.get(i - 1) ?? null
        const prevPh = prevPP?.plannedHeight ?? null
        const dist = Math.sqrt(
          (v.x - prev.x) * (v.x - prev.x) + (v.y - prev.y) * (v.y - prev.y),
        )
        if (ph !== null && prevPh !== null && dist > 0 && prevPh !== ph) {
          slopeLabel = `1/${Math.round(dist / Math.abs(prevPh - ph))}`
        }
      }

      // 書き込み
      let cx = x1
      let cy = y1 + initialYOffset
      lines.push(buildTextElement(layers.point, 0, 'P0', cx, cy, HALF_PI, moji, pointName))
      cx += stepDx
      cy += stepDy
      lines.push(buildTextElement(layers.ground, 0, 'N0', cx, cy, HALF_PI, moji, ghStr))
      cx += stepDx
      cy += stepDy
      lines.push(
        buildTextElement(layers.plan, layers.planColor, 'N0', cx, cy, HALF_PI, moji, fhStr),
      )
      cx += stepDx
      cy += stepDy
      // 切深（標準切深と異なる場合のみ）
      if (cd !== null && Math.abs(cd - stdDepth) > 0.005) {
        lines.push(buildTextElement(layers.depth, 12, 'N0', cx, cy, HALF_PI, moji, ` ${chStr}`))
      }
      // 勾配（前頂点との区間）
      if (slopeLabel) {
        lines.push(
          buildTextElement(layers.slope, 2, 'P0', midX, midY, segAngle, moji, slopeLabel),
        )
      }
    }
  }
  return lines
}

// 逆方向の場合は反転させる旧マクロのロジックを踏襲
function calcTextAngle(dx: number, dy: number): number {
  let _dx = dx
  let _dy = dy
  if (_dx < 0) {
    _dx = -_dx
    _dy = -_dy
  }
  if (_dx === 0) {
    if (_dy > 0) return Math.PI
    if (_dy < 0) return -Math.PI
    return 0
  }
  let a = Math.atan(_dy / _dx)
  if (_dy < 0) a = a + Math.PI
  return a
}

// 文字列を Shift-JIS の Uint8Array に変換
function toShiftJIS(text: string): Uint8Array {
  const unicodeArray = Encoding.stringToCode(text)
  const sjisArray = Encoding.convert(unicodeArray, {
    to: 'SJIS',
    from: 'UNICODE',
  })
  return new Uint8Array(sjisArray)
}

export function CadExportPage() {
  const { currentFarm } = useFarmStore()
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { planGroups, hasData, fetchPlan, loading: planLoading } = useConstructionPlanStore()

  const [level, setLevel] = useState<DrawingLevel>(DEFAULT_LEVEL)
  const [moji, setMoji] = useState<number>(2.0)
  const [absStdDepth, setAbsStdDepth] = useState<number>(0.8)
  const [colStdDepth, setColStdDepth] = useState<number>(0.9)
  const [preview, setPreview] = useState<string>('')

  useEffect(() => {
    if (!currentFarm) return
    fetchPipes(currentFarm.id)
    fetchPlan(currentFarm.id)
  }, [currentFarm, fetchPipes, fetchPlan])

  const previewLineCount = useMemo(() => {
    // 配管ごとに全頂点×4～5要素を出力
    let n = 0
    for (const p of pipes) {
      n += p.vertices.length * 4 // 点名・地盤高・計画高 + 勾配 (頂点数-1)
    }
    return n
  }, [pipes])

  const generateOutput = (): string => {
    const lines = [
      ...buildHeader(),
      ...buildTextLines(pipes, planGroups, level, moji, absStdDepth, colStdDepth),
    ]
    return lines.join('\r\n') + '\r\n'
  }

  const handlePreview = () => {
    if (pipes.length === 0) {
      alert('配管データがありません。CAD解析ページで登録してください。')
      return
    }
    setPreview(generateOutput())
  }

  const handleDownload = () => {
    if (pipes.length === 0) {
      alert('配管データがありません。CAD解析ページで登録してください。')
      return
    }
    const text = generateOutput()
    const sjis = toShiftJIS(text)
    // Uint8Array<ArrayBufferLike> → ArrayBuffer 互換にするため buffer をコピー
    const buf = sjis.slice().buffer
    const blob = new Blob([buf], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentFarm?.name || 'plan'}_cad.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b bg-white">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <PenTool className="h-5 w-5" />
          CAD転記
        </h1>
        <p className="text-sm text-muted-foreground">
          施工計画から TrendOne アスキー形式（Shift-JIS）の文字データを出力します
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 図面レベル設定 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
            <FileText className="h-4 w-4 text-blue-600" />
            図面レベル（座標変換用）
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-sm">
            <LabeledInput
              label="原点X"
              value={level.originX}
              onChange={(v) => setLevel({ ...level, originX: parseFloat(v) || 0 })}
              type="number"
              step="0.001"
            />
            <LabeledInput
              label="原点Y"
              value={level.originY}
              onChange={(v) => setLevel({ ...level, originY: parseFloat(v) || 0 })}
              type="number"
              step="0.001"
            />
            <LabeledInput
              label="縦縮尺"
              value={level.scaleV}
              onChange={(v) => setLevel({ ...level, scaleV: parseFloat(v) || 1000 })}
              type="number"
            />
            <LabeledInput
              label="横縮尺"
              value={level.scaleH}
              onChange={(v) => setLevel({ ...level, scaleH: parseFloat(v) || 1000 })}
              type="number"
            />
            <LabeledInput
              label="回転角 (rad)"
              value={level.rotation}
              onChange={(v) => setLevel({ ...level, rotation: parseFloat(v) || 0 })}
              type="number"
              step="0.0001"
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            これらは座標変換のみに使用します。出力ファイルのレベル行は固定（100,...,用紙系）。
          </p>
        </section>

        {/* 出力設定 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3">出力設定</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <LabeledInput
              label="文字サイズ"
              value={moji}
              onChange={(v) => setMoji(parseFloat(v) || 2.0)}
              type="number"
              step="0.1"
            />
            <LabeledInput
              label="吸水標準切深 (m)"
              value={absStdDepth}
              onChange={(v) => setAbsStdDepth(parseFloat(v) || 0.8)}
              type="number"
              step="0.01"
            />
            <LabeledInput
              label="集水標準切深 (m)"
              value={colStdDepth}
              onChange={(v) => setColStdDepth(parseFloat(v) || 0.9)}
              type="number"
              step="0.01"
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            標準切深と異なる測点のみ切深が出力されます（旧マクロと同仕様）。
          </p>
        </section>

        {/* 操作 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3">操作</h2>
          <div className="text-xs text-slate-600 mb-3 flex items-center gap-2">
            {planLoading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                施工計画を読み込み中...
              </>
            ) : pipes.length === 0 ? (
              <span className="text-red-600">
                配管データがありません。CAD解析ページで登録してください。
              </span>
            ) : (
              <span>
                配管 {pipes.length} 本 / 予想 約 {previewLineCount} 文字要素
                {!hasData && '（施工計画未生成: 地盤高・計画高・切深は空欄）'}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handlePreview}
              disabled={pipes.length === 0 || planLoading}
              className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white rounded hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <FileText className="h-4 w-4" />
              プレビュー
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={pipes.length === 0 || planLoading}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <Download className="h-4 w-4" />
              TrendOne アスキー出力（Shift-JIS）
            </button>
          </div>
        </section>

        {preview && (
          <section className="bg-white border rounded-lg p-4">
            <h2 className="text-sm font-bold mb-3">プレビュー</h2>
            <pre className="text-xs font-mono bg-slate-50 p-3 rounded border max-h-96 overflow-auto whitespace-pre">
              {preview}
            </pre>
          </section>
        )}
      </div>
    </div>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
  step,
}: {
  label: string
  value: string | number
  onChange: (v: string) => void
  type?: string
  step?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-600">{label}</span>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="px-2 py-1.5 border rounded font-mono text-sm"
      />
    </label>
  )
}
