// 測点 (実測記録) の オフライン退避キュー。iOS 専用。
//
// 圏外の 現場で 計測した 測点を localStorage に 貯め、通信が 戻ったら
// 古い順に Supabase へ送る。
//
// 設計上の 決めごと:
// - **写真は 一切扱わない**。オフライン中は 撮影も 表示も させない (呼出側で 抑止)。
// - 1 回の 計測は staking_records と design_coordinates の 2 行を 生むので、
//   2 つで 1 ジョブ として 積む。片方だけ 送られて 地図に 出ない 事故を 防ぐ。
// - id は クライアント生成 (crypto.randomUUID)。送信は upsert(onConflict:'id')
//   なので 「サーバには 届いたが レスポンスが 落ちた」場合でも 二重登録に ならない。
//   オンライン時は 従来どおり サーバ生成 id を 使う (この キューを 通らない)。
// - 上限に 達したら 古い分を 捨てるのではなく **新規計測を 止める**。
//   位置 ping (mobilityOfflineQueue) と 違い、測点は 捨てたら 測り直しになる。
//
// 容量: 1 件 約 672 バイト → 1000 件で 約 656KB (localStorage 5MB の 13%)。

const KEY = 'staking:offlineQueue'

/** 上限。超えたら enqueue が false を返し、呼出側が 計測を 止める */
export const QUEUE_CAP = 1000

/** staking_records に 入れる 1 行 (id / recorded_at は 送信時に 決まる) */
export interface QueuedRecord {
  farmId: string
  surveyCategory: string
  targetType: string
  targetRefId: string | null
  targetVertexIndex: number | null
  targetName: string | null
  targetX: number | null
  targetY: number | null
  targetZ: number | null
  measuredX: number
  measuredY: number
  measuredZ: number | null
  accuracy: number | null
  sampleCount: number | null
  durationSeconds: number | null
  notes: string | null
}

/** design_coordinates に 入れる 1 行 (座標管理への 自動登録分) */
export interface QueuedCoordinate {
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: string
  notes: string | null
}

export interface QueuedMeasurement {
  /** staking_records.id として そのまま 使う クライアント生成 UUID */
  id: string
  farmId: string
  /** 平面直角座標系の 系番号。復帰時に lat/lng を 計算するのに 要る */
  zone: number
  /** 計測時の ログインユーザー id (created_by/updated_by 用) */
  userId: string | null
  queuedAt: string
  record: QueuedRecord
  /** 座標管理にも 登録する場合のみ。不要なら null */
  coordinate: QueuedCoordinate | null
}

function readRaw(): QueuedMeasurement[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr as QueuedMeasurement[]
  } catch {
    return []
  }
}

function writeRaw(queue: QueuedMeasurement[]): boolean {
  if (typeof window === 'undefined') return false
  try {
    localStorage.setItem(KEY, JSON.stringify(queue))
    return true
  } catch {
    // quota 超過。測点は 捨てられないので 何もせず 失敗を 返す
    return false
  }
}

/** 全件を 積んだ順で 返す */
export function readQueue(): QueuedMeasurement[] {
  return readRaw()
}

/** 未送信件数 */
export function queueLength(): number {
  return readRaw().length
}

/** farmId で 絞った 未送信分 */
export function queueForFarm(farmId: string): QueuedMeasurement[] {
  return readRaw().filter((q) => q.farmId === farmId)
}

/** 上限に 達しているか (計測ボタンを 止めるかの 判定用) */
export function isQueueFull(): boolean {
  return readRaw().length >= QUEUE_CAP
}

/**
 * 末尾に 1 件積む。上限超過 or 保存失敗なら false。
 * false のときは 呼出側で「保存できなかった」旨を ユーザーに 出すこと。
 */
export function enqueueMeasurement(item: QueuedMeasurement): boolean {
  const queue = readRaw()
  if (queue.length >= QUEUE_CAP) return false
  queue.push(item)
  return writeRaw(queue)
}

/** 送信済みの id を キューから 落とす */
export function removeFromQueue(ids: string[]): void {
  if (ids.length === 0) return
  const drop = new Set(ids)
  writeRaw(readRaw().filter((q) => !drop.has(q.id)))
}

/** 未送信のまま 破棄する (ユーザーが 明示的に 消す 場合のみ) */
export function clearQueue(): void {
  writeRaw([])
}
