// 情報レイヤの TEXT / MTEXT から 管径 (φ) と 長さ (L=) を regex で抽出する。
//
// 実 DXF (6-3.dxf) 観察サンプル:
//   ・「φ100 L=14」 「φ150 L=132」 → 管径 + 長さ 複合
//   ・「φ60」 「φ80」        → 管径のみ
//   ・「L=6」 「L=84」         → 長さのみ
//   ・「1」 「2」 ... 「60」   → 管番号 (抽出対象外)
//   ・「平均掘削深」 「1:1」    → メタ (抽出対象外)
//
// 半角/全角、Φ/φ、L / L= / l= / エル 等の揺れを吸収する。

import type { DxfTextEntity } from './parse'

export interface InfoLabel {
  /** 元 TEXT entity (デバッグ / 位置参照) */
  entity: DxfTextEntity
  /** 抽出できた管径 (mm)。無ければ null */
  diameterMm: number | null
  /** 抽出できた長さ (m)。無ければ null */
  lengthM: number | null
  /** どの kind として認識したか */
  kind: 'diameter_only' | 'length_only' | 'diameter_and_length' | 'noise'
}

// -----------------------------------------------------------------
// 1 TEXT の content を parse
// -----------------------------------------------------------------
export function parseInfoContent(raw: string): {
  diameterMm: number | null
  lengthM: number | null
} {
  if (!raw) return { diameterMm: null, lengthM: null }
  // 全角→半角、余分な空白除去、Φ / ㍉ 等の記号を統一
  let s = raw
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[ΦφΦ]/g, 'φ')
    .replace(/[=＝]/g, '=')
    .replace(/[\s　]+/g, ' ')
    .trim()

  // 管径: 「φ100」 「Φ150」 「100φ」 「φ 100」 いずれも
  let diameterMm: number | null = null
  const dMatch =
    s.match(/φ\s*(\d{2,4})/) ??
    s.match(/(\d{2,4})\s*φ/)
  if (dMatch) {
    const n = Number(dMatch[1])
    if (n >= 20 && n <= 3000) diameterMm = n
  }

  // 長さ: 「L=15」 「L 15」 「L=15.2」 いずれも許容
  let lengthM: number | null = null
  const lMatch = s.match(/L\s*=?\s*(\d+(?:\.\d+)?)/i)
  if (lMatch) {
    const n = Number(lMatch[1])
    if (n > 0 && n < 5000) lengthM = n
  }

  return { diameterMm, lengthM }
}

// -----------------------------------------------------------------
// 全 TEXT entity をパースして InfoLabel[] を作る
// -----------------------------------------------------------------
export function parseInfoLabels(texts: DxfTextEntity[]): InfoLabel[] {
  const labels: InfoLabel[] = []
  for (const entity of texts) {
    const { diameterMm, lengthM } = parseInfoContent(entity.content)
    let kind: InfoLabel['kind'] = 'noise'
    if (diameterMm != null && lengthM != null) kind = 'diameter_and_length'
    else if (diameterMm != null) kind = 'diameter_only'
    else if (lengthM != null) kind = 'length_only'
    labels.push({ entity, diameterMm, lengthM, kind })
  }
  return labels
}

// -----------------------------------------------------------------
// pipe run と label をニアレストネイバーで暫定対応付けする。
// 完全性は AI で補正。ここは「ざっくり寄せる」ヒューリスティック。
// -----------------------------------------------------------------
export interface PairingInput {
  runId: string
  centerX: number
  centerY: number
  vertices: Array<{ x: number; y: number }>
  lengthMm: number
}

export interface PairingResult {
  runId: string
  /** 割り当てた管径 (mm) */
  diameterMm: number | null
  /** 割り当てた長さ (m) — ラベル or 座標長さ (mm→m 換算) */
  lengthM: number | null
  /** 長さの由来 */
  lengthSource: 'label' | 'computed' | null
  /** 割り当てたラベルの元 TEXT entity 位置 (デバッグ用) */
  matchedLabelEntity: DxfTextEntity | null
  /** 「AI 補正が必要」フラグ (label が近くに無い / 曖昧 / 未マッチ) */
  needsAi: boolean
}

const MAX_MATCH_DISTANCE_MM = 15_000  // 15m 以内のラベルまで許容

export function pairRunsWithLabels(
  runs: PairingInput[],
  labels: InfoLabel[],
): PairingResult[] {
  const results: PairingResult[] = []
  // 使用済みラベルは重複割当を避けるため記録
  const usedLabelIdx = new Set<number>()

  // 距離順に近い pair から割り当てるため、まず全 pair の距離を計算
  interface Candidate {
    runIdx: number
    labelIdx: number
    dist: number
    diameterMm: number | null
    lengthM: number | null
  }
  const candidates: Candidate[] = []
  runs.forEach((run, ri) => {
    labels.forEach((label, li) => {
      if (label.kind === 'noise') return
      const dist = distToPolyline(
        label.entity.x,
        label.entity.y,
        run.vertices,
      )
      if (dist > MAX_MATCH_DISTANCE_MM) return
      candidates.push({
        runIdx: ri,
        labelIdx: li,
        dist,
        diameterMm: label.diameterMm,
        lengthM: label.lengthM,
      })
    })
  })
  candidates.sort((a, b) => a.dist - b.dist)

  // run ごとに { diameter, length } を貯める。近い順に埋めていく。
  const perRun: Array<{
    diameter: number | null
    length: number | null
    lengthSource: 'label' | 'computed' | null
    matched: DxfTextEntity | null
  }> = runs.map(() => ({
    diameter: null,
    length: null,
    lengthSource: null,
    matched: null,
  }))

  for (const c of candidates) {
    if (usedLabelIdx.has(c.labelIdx)) continue
    const slot = perRun[c.runIdx]
    let consumed = false
    if (c.diameterMm != null && slot.diameter == null) {
      slot.diameter = c.diameterMm
      slot.matched = labels[c.labelIdx].entity
      consumed = true
    }
    if (c.lengthM != null && slot.length == null) {
      slot.length = c.lengthM
      slot.lengthSource = 'label'
      slot.matched = slot.matched ?? labels[c.labelIdx].entity
      consumed = true
    }
    if (consumed) usedLabelIdx.add(c.labelIdx)
  }

  // 長さがラベルから取れなかった run は、座標長さ (mm→m) を採用
  runs.forEach((run, ri) => {
    const slot = perRun[ri]
    if (slot.length == null) {
      slot.length = run.lengthMm / 1000
      slot.lengthSource = 'computed'
    }
    // AI が要る条件: 管径が取れていない (最重要)
    const needsAi = slot.diameter == null
    results.push({
      runId: run.runId,
      diameterMm: slot.diameter,
      lengthM: slot.length,
      lengthSource: slot.lengthSource,
      matchedLabelEntity: slot.matched,
      needsAi,
    })
  })

  return results
}

// -----------------------------------------------------------------
// 点から折れ線 (polyline) までの最短距離 (2D、mm 単位)
// -----------------------------------------------------------------
function distToPolyline(
  px: number,
  py: number,
  vertices: Array<{ x: number; y: number }>,
): number {
  if (vertices.length === 0) return Infinity
  if (vertices.length === 1) return Math.hypot(px - vertices[0].x, py - vertices[0].y)
  let min = Infinity
  for (let i = 0; i < vertices.length - 1; i++) {
    const d = distToSegment(px, py, vertices[i], vertices[i + 1])
    if (d < min) min = d
  }
  return min
}

function distToSegment(
  px: number,
  py: number,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y)
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(px - cx, py - cy)
}
