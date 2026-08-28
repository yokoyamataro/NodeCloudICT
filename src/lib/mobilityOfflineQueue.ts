// 位置 ping の送信キュー。ネットワーク不通時に端末へ貯めて、復旧時に古い順から
// Supabase に送る。
//
// 使い方:
//   await enqueuePing(userId, { assignmentId, ...sample })  // 常に enqueue
//   await flushQueue(userId, batchSender)                   // 送れる分だけ送る
//
// 【localStorage から IndexedDB へ移した理由】
// 旧実装は localStorage に配列を丸ごと JSON で置き、上限 120 件を超えたら
// **古い方から破棄** していた。10 秒間隔なので 20 分で溢れる。位置ログは
// 山岳・海上はもちろん、トンネルや谷間を走る建設機械・ダンプでも「後から
// 辿れる唯一の記録」であり、捨ててよいものではない。
// また localStorage は 1 件追加するたびに配列全体を文字列化するため、数万件
// 規模では 10 秒ごとに O(n) の同期処理が走り UI が固まる。
//
// 現在:
//   * IndexedDB に 1 件ずつ append (O(1))
//   * 上限 QUEUE_CAP = 50,000 件 (10 秒間隔で 約 5.8 日ぶん)
//   * 経過時間による破棄はしない (旧実装は 24h で捨てていた。数日圏外になる
//     漁船では成立しない)
//   * flush は assignment ごとにまとめて バッチ INSERT

import { pingAdd, pingClear, pingCount, pingDelete, pingTake } from '@/lib/offlineDb'

/** 上限。超えたら古い方から捨てる (これに達するのは通信が数日死んでいる時) */
export const QUEUE_CAP = 50_000

/** 1 リクエストで送る最大件数。
 *  大きくすると 1 本が失敗した時の巻き戻しが大きく、進捗も動かないため
 *  控えめにする (500 だと「500 件送信中」のまま止まって見える)。 */
const BATCH_SIZE = 200

/** 1 回の flush で読み出す最大件数 (メモリを食い過ぎないため) */
const TAKE_LIMIT = 5_000

export interface QueuedPing {
  assignmentId: string
  lat: number
  lon: number
  accuracy_m: number | null
  speed_kmh: number | null
  heading_deg: number | null
  altitude_m: number | null
  recorded_at: string
}

/** IndexedDB に入る形 (seq は autoIncrement で採番される) */
interface StoredPing extends QueuedPing {
  seq: number
  userId: string
}

export type PingInput = {
  lat: number
  lon: number
  accuracy_m: number | null
  speed_kmh: number | null
  heading_deg: number | null
  altitude_m: number | null
  recorded_at: string
}

/** 同一 assignment の ping をまとめて送る。1 件ずつ送ると復帰時に終わらない */
export type PingBatchSender = (
  assignmentId: string,
  rows: PingInput[],
) => Promise<{ ok: true } | { ok: false; error: string }>

/** 現在のキュー件数を返す (UI 表示用) */
export async function getQueueLength(userId: string): Promise<number> {
  try {
    return await pingCount(userId)
  } catch {
    return 0
  }
}

/** 新しい ping をキューの末尾に追加。追加後の件数を返す。 */
export async function enqueuePing(userId: string, item: QueuedPing): Promise<number> {
  try {
    await pingAdd({ ...item, userId })
    const n = await pingCount(userId)
    if (n > QUEUE_CAP) {
      // 通常ここには来ない。来たら通信が数日死んでいる状態。
      const excess = await pingTake<StoredPing>(userId, n - QUEUE_CAP)
      await pingDelete(excess.map((p) => p.seq))
      console.warn(`[mobilityOfflineQueue] queue full: dropped ${excess.length} oldest pings`)
      return QUEUE_CAP
    }
    return n
  } catch (err) {
    console.warn('[mobilityOfflineQueue] enqueue failed', err)
    return 0
  }
}

// ユーザーごとに「進行中の flush の Promise」を保持し、並列呼び出しを 1 本化する。
// GPS callback から throttle 外でも flushQueue が呼ばれる + sendWithQueue 内でも
// flushQueue が呼ばれる、というパスがあるため、これがないと同一キュー項目を
// 複数の Promise が同時に読んで **重複 INSERT** してしまう (実際に発生した)。
const inflightFlush = new Map<string, Promise<{ sent: number; remaining: number }>>()

/**
 * この失敗は "永久にリトライしても送れない" 系のエラーか?
 *
 * 具体例:
 *   - assignment が削除された/自分の物でない → 外部キーエラー
 *   - RLS の WITH CHECK を満たさない (乗車期間外の recorded_at 等) → 42501
 *
 * 注: 「降車後は送れない」制約は 20260827 のマイグレーションで撤廃済み。
 * 乗車期間内に測った ping であれば、いつ送っても通る。
 *
 * ネットワーク切断や 5xx / CORS は リトライで通る可能性があるので破棄しない。
 * keyword 過剰マッチによる誤破棄を避けるため、DB エラーコードと SQL 特化文言
 * だけを見る。
 */
function isTerminalError(err: string | undefined): boolean {
  if (!err) return false
  const lower = err.toLowerCase()
  return (
    lower.includes('code=42501') ||
    lower.includes('row-level security') ||
    lower.includes('row level security') ||
    lower.includes('code=23503') ||
    lower.includes('foreign key constraint')
  )
}

/**
 * キューを古い順に flush する。assignment ごとに連続する区間をまとめて送る。
 *   - success: 送れた分を削除して次へ
 *   - terminal error: その assignment の分を破棄して次へ
 *     onTerminal コールバックが渡されていれば assignment_id 付きで通知
 *   - transient error: そこで打ち切り、残りはキューに残す (次回リトライ)
 *
 * 並列に呼ばれた場合は同じ Promise を返す (dedupe)。
 */
export function flushQueue(
  userId: string,
  sender: PingBatchSender,
  options?: {
    onTerminal?: (assignmentId: string, error: string) => void
  },
): Promise<{ sent: number; remaining: number }> {
  const existing = inflightFlush.get(userId)
  if (existing) return existing
  const p = (async () => {
    try {
      const queue = await pingTake<StoredPing>(userId, TAKE_LIMIT)
      if (queue.length === 0) return { sent: 0, remaining: 0 }

      // このセッション中に「送れないと判った」assignment_id をキャッシュして
      // 同じ assignment_id の残り ping はまとめてドロップする
      const poisoned = new Set<string>()
      let sent = 0
      let stopped = false
      const doneSeqs: number[] = []

      // 積んだ順を崩さないよう、assignment_id が変わるまでを 1 グループにする
      let i = 0
      while (i < queue.length && !stopped) {
        const assignmentId = queue[i].assignmentId
        const group: StoredPing[] = []
        while (i < queue.length && queue[i].assignmentId === assignmentId && group.length < BATCH_SIZE) {
          group.push(queue[i])
          i += 1
        }
        if (poisoned.has(assignmentId)) {
          doneSeqs.push(...group.map((g) => g.seq)) // 破棄
          continue
        }
        const res = await sender(
          assignmentId,
          group.map((g) => ({
            lat: g.lat,
            lon: g.lon,
            accuracy_m: g.accuracy_m,
            speed_kmh: g.speed_kmh,
            heading_deg: g.heading_deg,
            altitude_m: g.altitude_m,
            recorded_at: g.recorded_at,
          })),
        )
        if (res.ok) {
          sent += group.length
          doneSeqs.push(...group.map((g) => g.seq))
          continue
        }
        if (isTerminalError(res.error)) {
          console.warn(
            `[mobilityOfflineQueue] dropping ${group.length} pings for invalid assignment ${assignmentId}: ${res.error}`,
          )
          poisoned.add(assignmentId)
          doneSeqs.push(...group.map((g) => g.seq))
          try {
            options?.onTerminal?.(assignmentId, res.error ?? '')
          } catch {
            /* noop */
          }
          continue
        }
        // 一時的エラー → ここで停止。残りはキューに残したまま次回リトライ
        stopped = true
      }

      await pingDelete(doneSeqs)
      const remaining = await pingCount(userId)
      return { sent, remaining }
    } finally {
      inflightFlush.delete(userId)
    }
  })()
  inflightFlush.set(userId, p)
  return p
}

/** 現在キューにある ping を全消去する (デバッグ / 手動リセット用) */
export async function clearQueue(userId: string): Promise<void> {
  try {
    await pingClear(userId)
  } catch {
    /* noop */
  }
}
