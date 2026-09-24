import type { GridLinesConfig } from '@/stores/openChannelStore'

/**
 * 整地 の 格子 (平行 縦断) の 並び と 名前。
 *
 * 中心線 を 0 と し、 左 を 負、 右 を 正 の 本数 で 数える。
 * 離れ は 本数 × 間隔。 名前 は 中心 の 文字 から アルファベット を 前後 に
 * たどる (F なら 左 E,D,C,B,A、 その 先 は -A,-B… / 右 G,H,I…、 Z の 先 は +A,+B…)。
 * reverseNames を 立てる と 進む 向き が 逆 に なり、 左 が G,H,I…、 右 が E,D,C… に なる。
 * 個別 に 上書き した 名前 が あれば そちら を 使う。
 */

/** 中心 から の 本数 の 並び (左 から 右 へ) */
export function gridLineIndices(cfg: GridLinesConfig): number[] {
  const out: number[] = []
  for (let i = -cfg.leftCount; i <= cfg.rightCount; i++) out.push(i)
  return out
}

/** 本数 → 離れ [m] (右 が 正) */
export function gridLineOffset(cfg: GridLinesConfig, idx: number): number {
  return Math.round(idx * cfg.spacing * 1000) / 1000
}

/**
 * 自動 の 名前。 中心 の 文字 が 1 文字 の 英字 なら アルファベット を たどり、
 * 端 を 越えたら 「-A」「+A」 の ように 符号 を 付けて 頭 から 数え 直す。
 * 中心 が 英字 で なければ 「F-1」 の ような 番号 付き に する。
 */
export function gridLineAutoName(centerName: string, idx: number): string {
  if (idx === 0) return centerName
  const c = centerName.trim()
  const isLetter = /^[A-Za-z]$/.test(c)
  if (!isLetter) return idx < 0 ? `${c}-${-idx}` : `${c}+${idx}`
  const upper = c.toUpperCase()
  const base = upper.charCodeAt(0) - 65 // A=0 … Z=25
  const pos = base + idx
  if (pos >= 0 && pos <= 25) return String.fromCharCode(65 + pos)
  // 端 を 越えた 分 は 反対 の 端 から 数え 直す (A の 左 は -A, -B…)
  if (pos < 0) return `-${String.fromCharCode(65 + (-pos - 1) % 26)}`
  return `+${String.fromCharCode(65 + (pos - 26) % 26)}`
}

/**
 * 本数 → 表示名 (上書き が あれば それ)。
 * 上書き の キー は 向き に 関係 なく 実際 の 本数 な ので、 向き を 変えて も
 * 個別 に 付けた 名前 は その 線 に 付いた まま に なる。
 */
export function gridLineName(cfg: GridLinesConfig, idx: number): string {
  const override = cfg.names?.[String(idx)]
  if (override && override.trim() !== '') return override
  return gridLineAutoName(cfg.centerName, cfg.reverseNames ? -idx : idx)
}

/**
 * 点列 の 中 から その 離れ に 一番 近い 点 を 引く。
 * 格子 の 点 は 離れ が ぴったり 合う 前提 だ が、 実測 から 拾った 点 は
 * 少し ずれる ので、 許容 幅 の 中 で 一番 近い もの を 採る。
 */
export function pointNearOffset<T extends { offset: number }>(
  points: readonly T[],
  offset: number,
  tolerance: number,
): T | null {
  let best: T | null = null
  let bestD = tolerance
  for (const p of points) {
    const d = Math.abs(p.offset - offset)
    if (d <= bestD) {
      bestD = d
      best = p
    }
  }
  return best
}

/** 工事区域 を 中心線 に 投影 した 広がり */
export interface GridExtent {
  /** 追加距離 の 最小 / 最大 [m] */
  dMin: number
  dMax: number
  /** 離れ の 最小 (左 が 負) / 最大 [m] */
  oMin: number
  oMax: number
}

/** グリッド計算 の 結果 */
export interface GridPlan {
  /** 中間点 に する 追加距離 [m] (BP から) */
  distances: number[]
  leftCount: number
  rightCount: number
}

const GRID_EPS = 1e-9

/**
 * 境界 の 1 つ 外 まで 何 本 要る か。
 * 境界 に ちょうど 重なる 線 は 「外」 と 数え ない ので 常に 1 本 足す。
 */
function stepsOutside(value: number, spacing: number): number {
  return Math.floor(Math.abs(value) / spacing + GRID_EPS) + 1
}

/**
 * 工事区域 の 広がり から 格子 を 決める。
 * 中間点 (横断) も 平行 縦断 も 区域 の 1 つ 外 の 格子 まで 作る。
 * 中間点 は 線形 の 外 に は 置け ない ので BP / EP で 止まる。
 */
export function gridPlanFromExtent(
  ext: GridExtent,
  spacing: number,
  totalLen: number,
): GridPlan {
  if (!(spacing > 0)) return { distances: [], leftCount: 0, rightCount: 0 }
  // BP を 0 と した 格子 番号。 区域 の 外 に 1 つ はみ出す
  const kStart = Math.ceil(ext.dMin / spacing - GRID_EPS) - 1
  const kEnd = Math.floor(ext.dMax / spacing + GRID_EPS) + 1
  const distances: number[] = []
  for (let k = kStart; k <= kEnd; k++) {
    const d = Math.round(k * spacing * 1000) / 1000
    if (d < -GRID_EPS || d > totalLen + GRID_EPS) continue
    distances.push(Math.min(Math.max(d, 0), totalLen))
  }
  return {
    distances,
    leftCount: stepsOutside(Math.min(ext.oMin, 0), spacing),
    rightCount: stepsOutside(Math.max(ext.oMax, 0), spacing),
  }
}

/**
 * 格子点 の 呼び名。 平行縦断 の 線名 と SP を 1 つ に つなぐ (例 H+80、 H+48.50)。
 * SP が 負 なら 「H-20」 の ように 符号 を そのまま 出す。
 * 端数 が 無い ときは 小数 を 付けない (現場 の 書き方 に 合わせる)。
 */
export function gridPointName(lineName: string, sp: number): string {
  const sign = sp < 0 ? '-' : '+'
  const v = Math.abs(sp)
  const txt = Math.abs(v - Math.round(v)) < 5e-3 ? String(Math.round(v)) : v.toFixed(2)
  return `${lineName}${sign}${txt}`
}
