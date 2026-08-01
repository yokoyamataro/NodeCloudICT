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

/**
 * キューを古い順に flush する。1 件でも失敗したらそこで打ち切り、
 * 残りをキューに戻して { sent, remaining } を返す。
 * (offline なら 0 件送って全件残る)
 */
export async function flushQueue(
  userId: string,
  sender: PingSender,
): Promise<{ sent: number; remaining: number }> {
  const queue = readQueue(userId)
  if (queue.length === 0) return { sent: 0, remaining: 0 }
  let sent = 0
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i]
    const res = await sender(item.assignmentId, {
      lat: item.lat,
      lon: item.lon,
      accuracy_m: item.accuracy_m,
      speed_kmh: item.speed_kmh,
      heading_deg: item.heading_deg,
      altitude_m: item.altitude_m,
      recorded_at: item.recorded_at,
    })
    if (!res.ok) {
      // ここで残りを戻して終了
      const remaining = queue.slice(i)
      writeQueue(userId, remaining)
      return { sent, remaining: remaining.length }
    }
    sent++
  }
  writeQueue(userId, [])
  return { sent, remaining: 0 }
}
