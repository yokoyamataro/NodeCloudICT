import { useEffect, useMemo, useState } from 'react'
import { PenTool, Download, FileText, Loader2, FileSpreadsheet } from 'lucide-react'
import Encoding from 'encoding-japanese'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useConstructionPlanStore, type PlanGroup, type PlanPoint, type PlanRow } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
import { exportAllCrossSectionsDxf } from '@/lib/crossSectionDxfExport'
import { generateSfcPipesContent } from '@/lib/sfcPipeExport'

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
  // TrendOne の用紙座標系に合わせて左右・上下を反転
  const px = -(s1 * Math.cos(a1))
  const py = -(s1 * Math.sin(a1))
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
    '2005,配線番号',
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

// 配線（pipe）の中央（路長の半分の位置）座標を返す。
// 路長ゼロや頂点 1 点しかない場合は最初の頂点を返す。
function pipeMidpoint(pipe: PipeRow): { x: number; y: number } | null {
  const v = pipe.vertices
  if (v.length === 0) return null
  if (v.length === 1) return { x: v[0].x, y: v[0].y }
  // 各セグメント長の合計
  let total = 0
  const segLen: number[] = []
  for (let i = 1; i < v.length; i++) {
    const dx = v[i].x - v[i - 1].x
    const dy = v[i].y - v[i - 1].y
    const d = Math.sqrt(dx * dx + dy * dy)
    segLen.push(d)
    total += d
  }
  if (total === 0) return { x: v[0].x, y: v[0].y }
  const target = total / 2
  let acc = 0
  for (let i = 0; i < segLen.length; i++) {
    if (acc + segLen[i] >= target) {
      const t = (target - acc) / segLen[i]
      return {
        x: v[i].x + t * (v[i + 1].x - v[i].x),
        y: v[i].y + t * (v[i + 1].y - v[i].y),
      }
    }
    acc += segLen[i]
  }
  // フォールバック: 末尾頂点
  return { x: v[v.length - 1].x, y: v[v.length - 1].y }
}

// 配線番号テキスト要素（layer 2005）を生成。
// 例: 5,2005,123,0,0,1,0,P0,0,0,0,0,449.588571,183.237376,0.000000,2.500000,2.500000,0,10,0,5,0,0,0,0,1,1,2.000000,2.000000,ＭＳ ゴシック,O1
function buildPipeNumberElement(
  x: number,
  y: number,
  size: number,
  text: string,
): string {
  const fx = x.toFixed(6)
  const fy = y.toFixed(6)
  const fSize = size.toFixed(6)
  return `5,2005,123,0,0,1,0,P0,0,0,0,0,${fx},${fy},0.000000,${fSize},${fSize},0,10,0,5,0,0,0,0,1,1,2.000000,2.000000,ＭＳ ゴシック,${text}`
}

// 配管単位で全頂点の文字要素行を生成
function buildTextLines(
  pipes: PipeRow[],
  planGroups: PlanGroup[],
  level: DrawingLevel,
  moji: number,
  absorptionStdDepth: number,
  collectorStdDepth: number,
  pipeNumberSize: number,
): string[] {
  const lines: string[] = []
  const HALF_PI = Math.PI / 2
  // 各文字を積むオフセット: 旧マクロは x -= moji * sin(a0), y += moji * cos(a0)
  const stepDx = -moji * Math.sin(HALF_PI)
  const stepDy = moji * Math.cos(HALF_PI)

  const planLookup = buildPlanLookup(planGroups, pipes)

  // 集水管同士で同一座標に頂点がある場合は 1 件にまとめる（例: S26A と S25C が同位置 →
  // S26A.S25C として 1 行出力）。事前に重複位置を検出し、2 件目以降をスキップ + 1 件目の
  // 点名を結合名で上書きするマップを構築する。
  const POS_EPS_MM = 1 // 1mm 以内を同一点とみなす
  const collectorPositionKey = (x: number, y: number) =>
    `${Math.round(x * 1000)}_${Math.round(y * 1000)}`
  const collectorPositions = new Map<
    string,
    Array<{ pipeId: string; vertexIdx: number; pointName: string }>
  >()
  for (const pipe of pipes) {
    if (pipe.pipeType === 'branch') continue
    const planForPipe = planLookup.get(pipe.id)
    for (let i = 0; i < pipe.vertices.length; i++) {
      const v = pipe.vertices[i]
      const pp = planForPipe?.get(i) ?? null
      const pointName =
        pp !== null
          ? pp.pointName
          : generatePointName(pipe.number, i, pipe.vertices.length)
      const key = collectorPositionKey(v.x, v.y)
      const list = collectorPositions.get(key) ?? []
      list.push({ pipeId: pipe.id, vertexIdx: i, pointName })
      collectorPositions.set(key, list)
    }
  }
  void POS_EPS_MM
  const collectorSkipKeys = new Set<string>()
  const collectorMergedName = new Map<string, string>()
  for (const [, list] of collectorPositions) {
    if (list.length <= 1) continue
    // 各点名を "." で分割し、重複なしで順序保持しながら結合
    const seen = new Set<string>()
    const parts: string[] = []
    for (const item of list) {
      const tokens = (item.pointName || '').split('.').filter((s) => s.length > 0)
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t)
          parts.push(t)
        }
      }
    }
    const merged = parts.join('.')
    const first = list[0]
    collectorMergedName.set(`${first.pipeId}|${first.vertexIdx}`, merged)
    for (let i = 1; i < list.length; i++) {
      const skip = list[i]
      collectorSkipKeys.add(`${skip.pipeId}|${skip.vertexIdx}`)
    }
  }

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
      // 集水管同一点の重複は 2 件目以降をスキップ
      if (!isAbsorption && collectorSkipKeys.has(`${pipe.id}|${i}`)) continue

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

      // 施工計画に対応行がある場合は空文字でもそのまま使う（縦断変化点＝A/B/Cラベルなしの吸水合流点）
      const rawPointName = pp !== null ? pp.pointName : generatePointName(pipe.number, i, total)
      // 集水管同一点で結合されている場合は結合名で上書き
      const pointName = !isAbsorption
        ? collectorMergedName.get(`${pipe.id}|${i}`) ?? rawPointName
        : rawPointName
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

    // 配線番号: 配線の中央位置（路長の半分）に配置
    if (pipe.number) {
      const mid = pipeMidpoint(pipe)
      if (mid) {
        const { px, py } = toPaperCoords(mid.x, mid.y, level)
        lines.push(buildPipeNumberElement(px, py, pipeNumberSize, pipe.number))
      }
    }
  }

  // 集水管頂点と一致しない縦断変化点（A/B/Cラベルなしの吸水合流点）を補完出力
  // buildPlanLookup は座標一致した測点のみ拾うため、ここから漏れる
  // 合流点を施工計画行から直接取り出して出力する。
  const EPS = 1e-4
  const initialYOffsetCollector = moji * 3.2
  for (const group of planGroups) {
    if (group.groupType !== 'collector') continue
    for (let r = 0; r < group.rows.length; r++) {
      const row = group.rows[r]
      const cp = row.collectorPoint
      if (!cp || cp.pointName !== '') continue
      const collectorPipe = row.collectorPipeId
        ? pipes.find((p) => p.id === row.collectorPipeId)
        : null
      if (!collectorPipe) continue
      // 集水管頂点と一致する場合は pipe ループで既に出力済みのためスキップ
      const matchesVertex = collectorPipe.vertices.some(
        (v) => Math.abs(v.x - cp.x) < EPS && Math.abs(v.y - cp.y) < EPS,
      )
      if (matchesVertex) continue

      const { px: x1, py: y1 } = toPaperCoords(cp.x, cp.y, level)

      // 勾配用に同一集水管の前行の集水点を参照
      let prevCp: { x: number; y: number; ph: number | null } | null = null
      for (let pi = r - 1; pi >= 0; pi--) {
        const prev = group.rows[pi]
        if (
          prev.collectorPipeId === row.collectorPipeId &&
          prev.collectorPoint
        ) {
          prevCp = {
            x: prev.collectorPoint.x,
            y: prev.collectorPoint.y,
            ph: prev.collectorPoint.plannedHeight,
          }
          break
        }
      }

      let segAngle = 0
      let midX = x1
      let midY = y1
      let slopeLabel: string | null = null
      if (prevCp) {
        const prevPaper = toPaperCoords(prevCp.x, prevCp.y, level)
        const dx = prevPaper.px - x1
        const dy = prevPaper.py - y1
        segAngle = calcTextAngle(dx, dy)
        midX = (x1 + prevPaper.px) / 2
        midY = (y1 + prevPaper.py) / 2
        const dist = Math.sqrt(
          (cp.x - prevCp.x) * (cp.x - prevCp.x) +
            (cp.y - prevCp.y) * (cp.y - prevCp.y),
        )
        if (
          cp.plannedHeight !== null &&
          prevCp.ph !== null &&
          dist > 0 &&
          prevCp.ph !== cp.plannedHeight
        ) {
          slopeLabel = `1/${Math.round(
            dist / Math.abs(prevCp.ph - cp.plannedHeight),
          )}`
        }
      }

      const gh = cp.groundHeight ?? null
      const ph = cp.plannedHeight ?? null
      const cd =
        cp.cutDepth ?? (gh !== null && ph !== null ? gh - ph : null)
      const ghStr = formatHeight(gh)
      const fhStr = formatHeight(ph)
      const chStr = formatHeight(cd)

      let cx = x1
      let cy = y1 + initialYOffsetCollector
      lines.push(buildTextElement(2055, 0, 'P0', cx, cy, HALF_PI, moji, ''))
      cx += stepDx
      cy += stepDy
      lines.push(buildTextElement(2056, 0, 'N0', cx, cy, HALF_PI, moji, ghStr))
      cx += stepDx
      cy += stepDy
      lines.push(buildTextElement(2057, 5, 'N0', cx, cy, HALF_PI, moji, fhStr))
      cx += stepDx
      cy += stepDy
      if (cd !== null && Math.abs(cd - collectorStdDepth) > 0.005) {
        lines.push(
          buildTextElement(2058, 12, 'N0', cx, cy, HALF_PI, moji, ` ${chStr}`),
        )
      }
      if (slopeLabel) {
        lines.push(
          buildTextElement(2059, 2, 'P0', midX, midY, segAngle, moji, slopeLabel),
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
  const [pipeNumberSize, setPipeNumberSize] = useState<number>(2.5)
  const [preview, setPreview] = useState<string>('')
  // 縦断図 DXF 一括出力
  const [dxfVScale, setDxfVScale] = useState<100 | 200 | 500 | 1000>(200)

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
      ...buildTextLines(pipes, planGroups, level, moji, absStdDepth, colStdDepth, pipeNumberSize),
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

  const handleSfcDownload = () => {
    if (pipes.length === 0) {
      alert('配管データがありません。CAD解析ページで登録してください。')
      return
    }
    const fileBase = currentFarm?.name || 'plan'
    const sfcText = generateSfcPipesContent(pipes, { fileBaseName: fileBase, scale: 1000 })
    const sjis = toShiftJIS(sfcText)
    const buf = sjis.slice().buffer
    const blob = new Blob([buf], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase}_pipes.sfc`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 縦断図用の補助マップ
  const pipeNumberById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of pipes) m.set(p.id, p.number)
    return m
  }, [pipes])
  const pipeDiameterById = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of pipes) if (p.diameter != null) m.set(p.id, p.diameter)
    return m
  }, [pipes])

  // 全系統 × 全行のフラットなタブリスト（縦断図 DXF 用）
  const flatTabs = useMemo(() => {
    const tabs: Array<{
      systemRows: PlanRow[]
      systemIndex: number
      endType: 'outlet' | 'merge' | null
      groupName: string
    }> = []
    for (const group of planGroups) {
      const bySys = new Map<number, { rows: PlanRow[]; endType: 'outlet' | 'merge' | null }>()
      for (const r of group.rows) {
        const k = r.systemIndex ?? 1
        const cur = bySys.get(k) ?? { rows: [], endType: null }
        cur.rows.push(r)
        if (r.isSystemEnd && r.systemEndType) cur.endType = r.systemEndType
        bySys.set(k, cur)
      }
      for (const [systemIndex, info] of bySys) {
        tabs.push({
          systemRows: info.rows,
          systemIndex,
          endType: info.endType,
          groupName: group.name,
        })
      }
    }
    return tabs
  }, [planGroups])

  const handleAllDxfExport = () => {
    if (flatTabs.length === 0) {
      alert('施工計画がありません。施工計画ページで生成してください。')
      return
    }
    exportAllCrossSectionsDxf({
      systems: flatTabs,
      verticalScale: dxfVScale,
      pipeNumberById,
      pipeDiameterById,
      allPlanGroups: planGroups,
      farmName: currentFarm?.name,
    })
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
            <DmsInput
              label="回転角 (度.分秒 例: 332.5812)"
              radValue={level.rotation}
              onChangeRad={(rad) => setLevel({ ...level, rotation: rad })}
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            これらは座標変換のみに使用します。度.分秒形式は「dd.mmss」（例: 332度58分12秒 → 332.5812）。
            出力ファイルのレベル行は固定（100,...,用紙系）。
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
            <LabeledInput
              label="配線番号 文字サイズ"
              value={pipeNumberSize}
              onChange={(v) => setPipeNumberSize(parseFloat(v) || 2.5)}
              type="number"
              step="0.1"
            />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            標準切深と異なる測点のみ切深が出力されます（旧マクロと同仕様）。
            配線番号は各配線の中央に layer 2005 で出力します。
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
            <button
              type="button"
              onClick={handleSfcDownload}
              disabled={pipes.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              title="配線 (吸水/集水 …) の形状のみを SFC 形式で出力。管種切替点に 1mm 円を打つ。縮尺 1/1000。"
            >
              <Download className="h-4 w-4" />
              SFC 出力（配線のみ・Shift-JIS）
            </button>
          </div>
        </section>

        {/* 縦断図 DXF 一括出力 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-sky-600" />
            縦断図 DXF 一括出力
          </h2>
          <div className="text-xs text-slate-600 mb-3">
            全系統の集水縦断図を 1 つの DXF ファイルに縦並びで出力します。
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">縦縮尺</span>
              <select
                value={dxfVScale}
                onChange={(e) =>
                  setDxfVScale(parseInt(e.target.value, 10) as 100 | 200 | 500 | 1000)
                }
                className="px-2 py-1 text-sm border rounded bg-white"
              >
                <option value={100}>1/100</option>
                <option value={200}>1/200</option>
                <option value={500}>1/500</option>
                <option value={1000}>1/1000</option>
              </select>
            </label>
            <span className="text-xs text-slate-600">
              {planLoading
                ? '施工計画を読み込み中...'
                : flatTabs.length === 0
                ? '施工計画がありません'
                : `系統 ${flatTabs.length} 件`}
            </span>
            <button
              type="button"
              onClick={handleAllDxfExport}
              disabled={flatTabs.length === 0 || planLoading}
              className="flex items-center gap-2 px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <Download className="h-4 w-4" />
              縦断図 DXF を出力
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

// 度.分秒（dd.mmss）形式 ↔ ラジアンの相互変換
//   332.5812 → 332度58分12秒 → 約 5.8112 rad
function dmsToDecimalDegrees(dms: number): number {
  const sign = dms < 0 ? -1 : 1
  const abs = Math.abs(dms)
  const deg = Math.floor(abs + 1e-12)
  const fracDeg = abs - deg // 0.mmss
  // mm.ss → 整数 mm と小数 0.ss
  const mmFloat = Math.round(fracDeg * 10000) / 100 // 例: 58.12
  const min = Math.floor(mmFloat + 1e-9)
  const sec = Math.round((mmFloat - min) * 100 * 100) / 100 // 例: 12.0
  return sign * (deg + min / 60 + sec / 3600)
}

function decimalDegreesToDMS(deg: number): number {
  const sign = deg < 0 ? -1 : 1
  const abs = Math.abs(deg)
  const d = Math.floor(abs + 1e-9)
  const mFloat = (abs - d) * 60
  let m = Math.floor(mFloat + 1e-9)
  let s = Math.round((mFloat - m) * 60) // 整数秒
  if (s >= 60) { m += 1; s -= 60 }
  let dd = d
  if (m >= 60) { dd += 1; m -= 60 }
  return sign * (dd + m / 100 + s / 10000)
}

function dmsToRad(dms: number): number {
  return dmsToDecimalDegrees(dms) * Math.PI / 180
}

function radToDMS(rad: number): number {
  return decimalDegreesToDMS(rad * 180 / Math.PI)
}

// 度.分秒入力：内部状態でフォーカス中の文字列を保持し、blur 時に rad を更新する。
// rad の外部更新があれば（フォーカス外なら）DMS 表示を再計算する。
function DmsInput({
  label,
  radValue,
  onChangeRad,
}: {
  label: string
  radValue: number
  onChangeRad: (rad: number) => void
}) {
  const formatDms = (rad: number): string => {
    const dms = radToDMS(rad)
    // 4 桁固定で見やすく
    return dms.toFixed(4)
  }
  const [text, setText] = useState<string>(formatDms(radValue))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(formatDms(radValue))
  }, [radValue, focused])

  const commit = () => {
    setFocused(false)
    const v = parseFloat(text)
    if (Number.isFinite(v)) {
      const rad = dmsToRad(v)
      onChangeRad(rad)
      setText(formatDms(rad))
    } else {
      setText(formatDms(radValue))
    }
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-600">{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(formatDms(radValue))
            ;(e.target as HTMLInputElement).blur()
          }
        }}
        className="px-2 py-1.5 border rounded font-mono text-sm"
      />
    </label>
  )
}
