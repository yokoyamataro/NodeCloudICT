// オフライン保存用の 最小 IndexedDB ラッパ。
//
// ストアは 2 つ:
//   farmSnapshots  … 工区の 事前ダウンロード (keyPath: farmId)
//   mobilityPings  … 位置 ping の 送信待ち行列 (autoIncrement)
//
// localStorage を 使わない 理由:
//   * 容量。工区 1 件の 設計座標は 1 万点を 超えることが あり、素の JSON で
//     数 MB になって 5MB 枠に 収まらない。
//   * 書き込みコスト。localStorage は 配列全体を 毎回 文字列化する ため、
//     ping が 数万件 溜まると 1 件 追加する たびに O(n) の 同期処理が 走り
//     UI が 固まる。IndexedDB なら 1 件 追加は O(1)。
//
// ライブラリは 足さない。使うのは put / get / delete / getAll / cursor だけ。

const DB_NAME = 'nodecloud-offline'
// v1: farmSnapshots のみ / v2: mobilityPings を追加
const DB_VERSION = 2
const STORE_SNAPSHOTS = 'farmSnapshots'
const STORE_PINGS = 'mobilityPings'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('この環境では IndexedDB が使えません'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        db.createObjectStore(STORE_SNAPSHOTS, { keyPath: 'farmId' })
      }
      if (!db.objectStoreNames.contains(STORE_PINGS)) {
        // seq (autoIncrement) が 積んだ順 = 送る順。userId で 絞れるよう index を張る
        const s = db.createObjectStore(STORE_PINGS, { keyPath: 'seq', autoIncrement: true })
        s.createIndex('userId', 'userId', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'))
  })
  return dbPromise
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB の操作に失敗しました'))
      }),
  )
}

// ---- 工区スナップショット ----

export function idbPut<T extends { farmId: string }>(value: T): Promise<IDBValidKey> {
  return tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.put(value))
}

export function idbGet<T>(farmId: string): Promise<T | undefined> {
  return tx<T | undefined>(STORE_SNAPSHOTS, 'readonly', (s) => s.get(farmId) as IDBRequest<T | undefined>)
}

export function idbGetAll<T>(): Promise<T[]> {
  return tx<T[]>(STORE_SNAPSHOTS, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

export function idbDelete(farmId: string): Promise<undefined> {
  return tx(STORE_SNAPSHOTS, 'readwrite', (s) => s.delete(farmId) as IDBRequest<undefined>)
}

// ---- 位置 ping キュー ----

/** 1 件追加して、採番された seq を返す */
export function pingAdd(value: Record<string, unknown>): Promise<number> {
  return tx<IDBValidKey>(STORE_PINGS, 'readwrite', (s) => s.add(value)).then((k) => Number(k))
}

/** userId の 未送信件数 */
export function pingCount(userId: string): Promise<number> {
  return tx<number>(STORE_PINGS, 'readonly', (s) =>
    s.index('userId').count(IDBKeyRange.only(userId)),
  )
}

/** userId の 未送信を 積んだ順 (seq 昇順) に 最大 limit 件 取り出す */
export function pingTake<T>(userId: string, limit: number): Promise<T[]> {
  return openDb().then(
    (db) =>
      new Promise<T[]>((resolve, reject) => {
        const t = db.transaction(STORE_PINGS, 'readonly')
        // index('userId') の cursor は 同一 key 内で primaryKey (=seq) 昇順に 回るので
        // 「積んだ順」が 保たれる
        const req = t.objectStore(STORE_PINGS).index('userId').openCursor(IDBKeyRange.only(userId))
        const out: T[] = []
        req.onsuccess = () => {
          const cur = req.result
          if (!cur || out.length >= limit) {
            resolve(out)
            return
          }
          out.push(cur.value as T)
          cur.continue()
        }
        req.onerror = () => reject(req.error ?? new Error('ping の読み出しに失敗しました'))
      }),
  )
}

/** 送信済み / 破棄する seq をまとめて 削除 */
export function pingDelete(seqs: number[]): Promise<void> {
  if (seqs.length === 0) return Promise.resolve()
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE_PINGS, 'readwrite')
        const store = t.objectStore(STORE_PINGS)
        for (const seq of seqs) store.delete(seq)
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error ?? new Error('ping の削除に失敗しました'))
      }),
  )
}

/** userId の 未送信を 全消去 (デバッグ / 手動リセット用) */
export function pingClear(userId: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const t = db.transaction(STORE_PINGS, 'readwrite')
        const req = t.objectStore(STORE_PINGS).index('userId').openCursor(IDBKeyRange.only(userId))
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          cur.delete()
          cur.continue()
        }
        t.oncomplete = () => resolve()
        t.onerror = () => reject(t.error ?? new Error('ping の消去に失敗しました'))
      }),
  )
}
