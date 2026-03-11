/**
 * 管路接続判定・自動設定ユーティリティ
 *
 * 落口を起点として、接続関係と上下流方向を自動設定する
 */

import type { PipeVertex } from '@/types/database'
import type { PipeRow } from '@/stores/underdrainStore'

// 接続判定の閾値（メートル）
const CONNECTION_THRESHOLD = 0.1 // 10cm

/**
 * 2点間の距離を計算
 */
function distance(p1: PipeVertex, p2: PipeVertex): number {
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * 点と線分の最短距離を計算
 * @returns 距離と、線分上の最近点の位置（0〜1のパラメータ）
 */
function pointToSegmentDistance(
  point: PipeVertex,
  segStart: PipeVertex,
  segEnd: PipeVertex
): { distance: number; t: number } {
  const dx = segEnd.x - segStart.x
  const dy = segEnd.y - segStart.y
  const lengthSq = dx * dx + dy * dy

  if (lengthSq === 0) {
    // 線分が点の場合
    return { distance: distance(point, segStart), t: 0 }
  }

  // 線分上の最近点のパラメータ t を計算
  let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq
  t = Math.max(0, Math.min(1, t))

  // 最近点の座標
  const nearestX = segStart.x + t * dx
  const nearestY = segStart.y + t * dy

  // 距離を計算
  const distX = point.x - nearestX
  const distY = point.y - nearestY
  const dist = Math.sqrt(distX * distX + distY * distY)

  return { distance: dist, t }
}

/**
 * 点が管路の線上（端点を除く）に接するかチェック
 * @returns 接する場合は線分のインデックス、接しない場合はnull
 */
function isPointOnPipeLine(
  point: PipeVertex,
  pipe: PipeRow,
  threshold: number
): number | null {
  const vertices = pipe.vertices
  if (vertices.length < 2) return null

  for (let i = 0; i < vertices.length - 1; i++) {
    const segStart = vertices[i]
    const segEnd = vertices[i + 1]
    const { distance: dist, t } = pointToSegmentDistance(point, segStart, segEnd)

    // 端点（t=0 または t=1）は除外
    if (dist <= threshold && t > 0.001 && t < 0.999) {
      return i
    }
  }

  return null
}

/**
 * 自動接続結果
 */
export interface AutoConnectionResult {
  pipeId: string
  updates: {
    connectionTo: string | null
    shouldReverse: boolean
  }
}

/**
 * 落口を起点として接続関係と上下流を自動設定
 *
 * @param outletPipe 落口として指定された管路
 * @param outletEndpoint 落口の下流端点（'start' または 'end'）
 * @param allPipes 全管路データ
 * @returns 更新が必要な管路のリスト
 */
export function autoConnectFromOutlet(
  outletPipe: PipeRow,
  outletEndpoint: 'start' | 'end',
  allPipes: PipeRow[]
): AutoConnectionResult[] {
  const results: AutoConnectionResult[] = []
  const processed = new Set<string>()

  // 落口の管路を処理済みに
  processed.add(outletPipe.id)

  // 落口の上下流を設定（下流がoutletEndpoint側）
  if (outletEndpoint === 'start') {
    // 起点が下流なら反転が必要
    results.push({
      pipeId: outletPipe.id,
      updates: {
        connectionTo: null,
        shouldReverse: true,
      },
    })
  }

  // BFSキュー: [管路, その管路の上流端点]
  interface QueueItem {
    pipe: PipeRow
    upstreamVertex: PipeVertex
  }

  const queue: QueueItem[] = []

  // 落口の上流端点を取得
  const outletVertices = outletPipe.vertices
  const outletUpstreamVertex =
    outletEndpoint === 'start'
      ? outletVertices[outletVertices.length - 1]
      : outletVertices[0]

  queue.push({ pipe: outletPipe, upstreamVertex: outletUpstreamVertex })

  while (queue.length > 0) {
    const current = queue.shift()!
    const { pipe: currentPipe, upstreamVertex } = current

    // 現在の管路の全線分を対象に、接続する管を検索
    for (const otherPipe of allPipes) {
      if (processed.has(otherPipe.id)) continue

      const otherVertices = otherPipe.vertices
      if (otherVertices.length < 2) continue

      const otherStart = otherVertices[0]
      const otherEnd = otherVertices[otherVertices.length - 1]

      // 他の管路の端点が、現在の管路の線上にあるかチェック
      let connectionPoint: 'start' | 'end' | null = null

      // 始点が線上にあるかチェック
      if (isPointOnPipeLine(otherStart, currentPipe, CONNECTION_THRESHOLD) !== null) {
        connectionPoint = 'start'
      }
      // 終点が線上にあるかチェック
      else if (isPointOnPipeLine(otherEnd, currentPipe, CONNECTION_THRESHOLD) !== null) {
        connectionPoint = 'end'
      }
      // 始点が現在の管路の上流端点と一致するかチェック
      else if (distance(otherStart, upstreamVertex) <= CONNECTION_THRESHOLD) {
        connectionPoint = 'start'
      }
      // 終点が現在の管路の上流端点と一致するかチェック
      else if (distance(otherEnd, upstreamVertex) <= CONNECTION_THRESHOLD) {
        connectionPoint = 'end'
      }

      if (connectionPoint !== null) {
        processed.add(otherPipe.id)

        // 接続点が下流になる
        // 始点が接続点なら、始点が下流 → 反転が必要
        // 終点が接続点なら、終点が下流 → 反転不要
        const shouldReverse = connectionPoint === 'start'

        results.push({
          pipeId: otherPipe.id,
          updates: {
            connectionTo: currentPipe.id,
            shouldReverse,
          },
        })

        // 次の探索のためにキューに追加
        // 上流端点は反転後の始点（＝元の終点 or 元の始点）
        const nextUpstreamVertex = shouldReverse ? otherEnd : otherStart
        queue.push({ pipe: otherPipe, upstreamVertex: nextUpstreamVertex })
      }
    }
  }

  return results
}

/**
 * 落口の端点を特定（落口座標と一致する端点を探す）
 * 指定された座標に近い端点を下流とする
 */
export function findOutletEndpoint(
  pipe: PipeRow,
  outletCoordinate?: PipeVertex
): 'start' | 'end' {
  if (!outletCoordinate) {
    // 座標が指定されていない場合は終点を下流とする
    return 'end'
  }

  const vertices = pipe.vertices
  if (vertices.length < 2) return 'end'

  const startDist = distance(vertices[0], outletCoordinate)
  const endDist = distance(vertices[vertices.length - 1], outletCoordinate)

  return startDist < endDist ? 'start' : 'end'
}
