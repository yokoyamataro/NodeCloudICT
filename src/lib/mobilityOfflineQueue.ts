// 位置 ping の送信キュー。ネットワーク不通時に localStorage に貯めて、
// 復旧時に古い順から Supabase に送る。
//
// 使い方:
//   const queue = getOfflineQueue(userId)
//   queue.push({ assignmentId, ...sample })  // 常に enqueue
//   await queue.flush(sender)                // 送れる分だけ送る (順序保持)
//
// - localStorage に保存 (キー: `mobility:offlineQueue:${userId}`)
// - 上限 QUEUE_CAP を超えたら古いものから捨てる (数分ぶんは残る想定)
// - flush は途中で失敗したら残りをキューに戻して return (次回リトライ)

const KEY_PREFIX = 'mobility:offlineQueue:'
const QUEUE_CAP = 120 // 10 秒間隔で 20 分ぶんまで貯められる

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

export type PingSender = (
  assignmentId: string,
  input: {
    lat: number
    lon: number
    accuracy_m: number | null
    speed_kmh: number | null
    heading_deg: number | null
    altitude_m: number | null
    recorded_at: string
  },
) => Promise<{ ok: true } | { ok: false; error: string }>

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`
}

function readQueue(userId: string): QueuedPing[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(keyFor(userId))
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr as QueuedPing[]
  } catch {
    return []
  }
}

function writeQueue(userId: string, queue: QueuedPing[]): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(queue))
  } catch {
    // quota exceeded 等。古い方を落として再挑戦
    try {
      localStorage.setItem(
        keyFor(userId),
        JSON.stringify(queue.slice(-Math.floor(QUEUE_CAP / 2))),
      )
    } catch {
      /* give up */
    }
  }
}

/** 現在のキュー件数を返す (UI 表示用) */
export function getQueueLength(userId: string): number {
  return readQueue(userId).length
}

/** 新しい ping をキューの末尾に追加。上限超過分は古い側を落とす。 */
export function enqueuePing(userId: string, item: QueuedPing): number {
  const queue = readQueue(userId)
  queue.push(item)
  const trimmed = queue.length > QUEUE_CAP ? queue.slice(-QUEUE_CAP) : queue
  writeQueue(userId, trimmed)
  return trimmed.length
}

// ユーザーごとに「進行中の flush の Promise」を保持し、並列呼び出しを 1 本化する。
// GPS callback から throttle 外でも flushQueue が呼ばれる + sendWithQueue 内でも
// flushQueue が呼ばれる、というパスがあるため、これがないと同一キュー項目を
// 複数の Promise が同時に読んで **重複 INSERT** してしまう (実際に発生した)。
const inflightFlush = new Map<
  string,
  Promise<{ sent: number; remaining: number }>
>()

// このキューが古すぎたら再送を諦める閾値。降車済み assignment 宛の ping は
// RLS で永久に弾かれるので、この閾値で保険をかけて破棄する (下記 isTerminalError
// で拾いきれない場合の最終セーフティネット)。
const MAX_PING_AGE_MS = 24 * 60 * 60 * 1000 // 24h

/**
 * この失敗は "永久にリトライしても送れない" 系のエラーか?
 *
 * 具体例:
 *   - RLS INSERT が assignment.ended_at IS NULL を要求 → 降車後は 42501 で拒否
 *   - assignment が削除された/自分の物でない → 参照エラー
 *
 * これらは何度リトライしても通らないので、当該 ping はキューから破棄する。
 * (逆に、ネットワーク切断や 5xx はリトライで通るので破棄しない)
 */
function isTerminalError(err: string | undefined): boolean {
  if (!err) return false
  const lower = err.toLowerCase()
  return (
    lower.includes('row-level security') ||
    lower.includes('row level security') ||
    lower.includes('code=42501') ||
    lower.includes('policy') ||
    lower.includes('violates') ||
    lower.includes('foreign key') ||
    lower.includes('not authorized')
  )
}

/**
 * キューを古い順に flush する。
 *   - success: そのまま次へ
 *   - terminal error: 破棄して次へ (assignment 終了後の ping 等)
 *   - transient error: そこで打ち切り、残りをキューに戻す
 *
 * 並列に呼ばれた場合は同じ Promise を返す (dedupe)。
 */
export function flushQueue(
  userId: string,
  sender: PingSender,
): Promise<{ sent: number; remaining: number }> {
  const existing = inflightFlush.get(userId)
  if (existing) return existing
  const p = (async () => {
    try {
      let queue = readQueue(userId)
      if (queue.length === 0) return { sent: 0, remaining: 0 }

      // 24h 超の古い ping は最初にドロップ (念のためのセーフティネット)
      const nowMs = Date.now()
      const beforeAge = queue.length
      queue = queue.filter((q) => {
        const t = Date.parse(q.recorded_at)
        return Number.isFinite(t) && nowMs - t < MAX_PING_AGE_MS
      })
      if (queue.length !== beforeAge) {
        console.warn(
          `[mobilityOfflineQueue] discarded ${beforeAge - queue.length} old pings (>24h)`,
        )
      }

      // このセッション中に「送れないと判った」assignment_id をキャッシュして
      // 同じ assignment_id の残り ping はまとめてドロップする
      const poisoned = new Set<string>()

      let sent = 0
      let stopIdx = -1
      for (let i = 0; i < queue.length; i++) {
        const item = queue[i]
        if (poisoned.has(item.assignmentId)) continue // ドロップ扱い
        const res = await sender(item.assignmentId, {
          lat: item.lat,
          lon: item.lon,
          accuracy_m: item.accuracy_m,
          speed_kmh: item.speed_kmh,
          heading_deg: item.heading_deg,
          altitude_m: item.altitude_m,
          recorded_at: item.recorded_at,
        })
        if (res.ok) {
          sent++
          continue
        }
        if (isTerminalError(res.error)) {
          console.warn(
            `[mobilityOfflineQueue] dropping ping for closed/invalid assignment ${item.assignmentId}: ${res.error}`,
          )
          poisoned.add(item.assignmentId)
          continue
        }
        // 一時的エラー → ここで停止、残りをキューに書き戻す
        stopIdx = i
        break
      }

      if (stopIdx >= 0) {
        // 停止位置以降のうち、poisoned なものは書き戻さない
        const rest = queue
          .slice(stopIdx)
          .filter((q) => !poisoned.has(q.assignmentId))
        writeQueue(userId, rest)
        return { sent, remaining: rest.length }
      }
      writeQueue(userId, [])
      return { sent, remaining: 0 }
    } finally {
      inflightFlush.delete(userId)
    }
  })()
  inflightFlush.set(userId, p)
  return p
}

/** 現在キューにある ping を全消去する (デバッグ / 手動リセット用) */
export function clearQueue(userId: string): void {
  writeQueue(userId, [])
}
