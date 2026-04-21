import { useEffect, useMemo, useState } from 'react'
import { PenTool, Download, FileText, Loader2 } from 'lucide-react'
import Encoding from 'encoding-japanese'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useConstructionPlanStore, type PlanGroup } from '@/stores/constructionPlanStore'

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

// 実座標 (x, y) を用紙座標へ変換
// 1. 原点シフト
// 2. -回転角 で回転（XY 座標系 → 用紙座標系）
// 3. 縮尺で除算（paper = (real - origin) / scale）
function toPaperCoords(
  x: number,
  y: number,
  level: DrawingLevel,
): { px: number; py: number } {
  const dx = x - level.originX
  const dy = y - level.originY
  const c = Math.cos(-level.rotation)
  const s = Math.sin(-level.rotation)
  const rx = dx * c - dy * s
  const ry = dx * s + dy * c
  const px = rx / (level.scaleH || 1)
  const py = ry / (level.scaleV || 1)
  return { px, py }
}

// 文字要素行（TrendOne アスキー形式）を生成
// `5,<layer>,100,<color>,0,1,0,<pointType>,0,0,0,0,<x>,<y>,<angle>,<size>,2,0,10,0,5,0,0,0,0,0,1,0.000000,0.000000,ＭＳ ゴシック,<text>`
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
  const fx = x.toFixed(6)
  const fy = y.toFixed(6)
  const fa = angle.toFixed(6)
  const fs = size.toFixed(6)
  return `5,${layer},100,${color},0,1,0,${pointType},0,0,0,0,${fx},${fy},${fa},${fs},2,0,10,0,5,0,0,0,0,0,1,0.000000,0.000000,ＭＳ ゴシック,${text}`
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

// 施工計画から文字要素行を生成
function buildTextLines(
  planGroups: PlanGroup[],
  pipeVerticesById: Map<string, { x: number; y: number }[]>,
  level: DrawingLevel,
  moji: number,
  absorptionStdDepth: number,
  collectorStdDepth: number,
): string[] {
  const lines: string[] = []
  const HALF_PI = Math.PI / 2

  for (const group of planGroups) {
    for (const row of group.rows) {
      // 吸水管の測点
      const absVerts = row.absorptionPipeId
        ? pipeVerticesById.get(row.absorptionPipeId) ?? null
        : null
      for (let i = 0; i < row.absorptionPoints.length; i++) {
        const p = row.absorptionPoints[i]
        const v = absVerts?.[i]
        if (!v) continue
        const prevV = i > 0 ? absVerts?.[i - 1] : null
        const { px: x1, py: y1 } = toPaperCoords(v.x, v.y, level)
        let segAngle = 0
        let midX = x1
        let midY = y1
        if (prevV) {
          const prev = toPaperCoords(prevV.x, prevV.y, level)
          const dx = prev.px - x1
          const dy = prev.py - y1
          segAngle = calcTextAngle(dx, dy)
          midX = (x1 + prev.px) / 2
          midY = (y1 + prev.py) / 2
        }

        const gh = formatHeight(p.groundHeight)
        const fh = formatHeight(p.plannedHeight)
        const ch = formatHeight(p.cutDepth)
        const sl = p.segmentSlope

        let cx = x1
        let cy = y1 + moji
        // 点名
        lines.push(buildTextElement(2050, 0, 'P0', cx, cy, HALF_PI, moji, p.pointName))
        cy += moji
        // 地盤高
        lines.push(buildTextElement(2051, 0, 'N0', cx, cy, HALF_PI, moji, gh))
        cy += moji
        // 計画高
        lines.push(buildTextElement(2052, 1, 'N0', cx, cy, HALF_PI, moji, fh))
        cy += moji
        // 切深（標準切深と異なる場合のみ）
        const chNum = typeof p.cutDepth === 'number' ? p.cutDepth : null
        if (chNum !== null && Math.abs(chNum - absorptionStdDepth) > 0.005) {
          lines.push(buildTextElement(2053, 12, 'N0', cx, cy, HALF_PI, moji, ` ${ch}`))
        }
        // 勾配
        if (sl && i > 0 && prevV) {
          const m = /^1\/(\d+(?:\.\d+)?)$/.exec(sl)
          if (m) {
            const slVal = parseFloat(m[1])
            const txt = `1/${Math.round(slVal)}`
            lines.push(buildTextElement(2054, 2, 'P0', midX, midY, segAngle, moji, txt))
          }
        }
      }

      // 集水管の測点
      if (row.collectorPoint && row.collectorPipeId) {
        const cp = row.collectorPoint
        const { px: x1, py: y1 } = toPaperCoords(cp.x, cp.y, level)
        const idx = group.rows.indexOf(row)
        const nextRow = idx >= 0 && idx + 1 < group.rows.length ? group.rows[idx + 1] : null
        let segAngle = 0
        let midX = x1
        let midY = y1
        if (nextRow?.collectorPoint) {
          const next = toPaperCoords(nextRow.collectorPoint.x, nextRow.collectorPoint.y, level)
          const dx = next.px - x1
          const dy = next.py - y1
          segAngle = calcTextAngle(dx, dy)
          midX = (x1 + next.px) / 2
          midY = (y1 + next.py) / 2
        }

        const gh = formatHeight(cp.groundHeight)
        const fh = formatHeight(cp.plannedHeight)
        const ch = formatHeight(cp.cutDepth)
        const sl = (() => {
          if (!nextRow?.collectorPoint) return null
          const a = cp.plannedHeight
          const b = nextRow.collectorPoint.plannedHeight
          const d = cp.segmentDistance
          if (a == null || b == null || !d || d === 0) return null
          const diff = a - b
          if (diff === 0) return null
          return Math.abs(d / diff)
        })()

        let cx = x1
        let cy = y1 + moji * 3.2
        // 点名
        lines.push(buildTextElement(2055, 0, 'P0', cx, cy, HALF_PI, moji, cp.pointName))
        cy += moji
        // 地盤高
        lines.push(buildTextElement(2056, 0, 'N0', cx, cy, HALF_PI, moji, gh))
        cy += moji
        // 計画高
        lines.push(buildTextElement(2057, 5, 'N0', cx, cy, HALF_PI, moji, fh))
        cy += moji
        // 切深（標準切深と異なる場合のみ）
        const chNum = typeof cp.cutDepth === 'number' ? cp.cutDepth : null
        if (chNum !== null && Math.abs(chNum - collectorStdDepth) > 0.005) {
          lines.push(buildTextElement(2058, 12, 'N0', cx, cy, HALF_PI, moji, ` ${ch}`))
        }
        // 勾配
        if (sl !== null && sl !== undefined) {
          lines.push(buildTextElement(2059, 2, 'P0', midX, midY, segAngle, moji, `1/${Math.round(sl)}`))
        }
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

  const pipeVerticesById = useMemo(() => {
    const m = new Map<string, { x: number; y: number }[]>()
    for (const p of pipes) m.set(p.id, p.vertices.map(v => ({ x: v.x, y: v.y })))
    return m
  }, [pipes])

  const previewLineCount = useMemo(() => {
    if (!hasData) return 0
    let n = 0
    for (const g of planGroups) {
      for (const r of g.rows) {
        n += r.absorptionPoints.length * 4
        if (r.collectorPoint) n += 4
      }
    }
    return n
  }, [planGroups, hasData])

  const generateOutput = (): string => {
    const lines = [
      ...buildHeader(),
      ...buildTextLines(planGroups, pipeVerticesById, level, moji, absStdDepth, colStdDepth),
    ]
    return lines.join('\r\n') + '\r\n'
  }

  const handlePreview = () => {
    if (!hasData) {
      alert('施工計画データがありません。施工計画ページで系統を生成してください。')
      return
    }
    setPreview(generateOutput())
  }

  const handleDownload = () => {
    if (!hasData) {
      alert('施工計画データがありません。施工計画ページで系統を生成してください。')
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
            ) : hasData ? (
              <span>施工計画データ: {previewLineCount} 文字要素</span>
            ) : (
              <span className="text-red-600">
                施工計画データがありません。先に「施工計画」ページで『配管系統から系統読込』してください。
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handlePreview}
              disabled={!hasData || planLoading}
              className="flex items-center gap-2 px-4 py-2 bg-slate-600 text-white rounded hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <FileText className="h-4 w-4" />
              プレビュー
            </button>
            <button
              type="button"
              onClick={handleDownload}
              disabled={!hasData || planLoading}
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
