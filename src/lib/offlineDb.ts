// オフライン保存用の 最小 IndexedDB ラッパ (key-value 1 ストアのみ)。
//
// localStorage を 使わないのは 容量。工区 1 件の 設計座標は 1 万点を 超えることが
// あり (coordinateStore の ページング処理が 100 万行まで 想定している)、
// 素の JSON で 数 MB になるため localStorage の 5MB 枠に 収まらない。
// 測点キュー (offlineStakingQueue) は 数百 KB なので localStorage のままで良い。
//
// ライブラリは 足さない。使うのは put / get / delete / getAll だけ。

const DB_NAME = 'nodecloud-offline'
const DB_VERSION = 1
const STORE = 'farmSnapshots'

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
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'farmId' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'))
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = run(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB の操作に失敗しました'))
      }),
  )
}

export function idbPut<T extends { farmId: string }>(value: T): Promise<IDBValidKey> {
  return tx('readwrite', (store) => store.put(value))
}

export function idbGet<T>(farmId: string): Promise<T | undefined> {
  return tx<T | undefined>('readonly', (store) => store.get(farmId) as IDBRequest<T | undefined>)
}

export function idbGetAll<T>(): Promise<T[]> {
  return tx<T[]>('readonly', (store) => store.getAll() as IDBRequest<T[]>)
}

export function idbDelete(farmId: string): Promise<undefined> {
  return tx('readwrite', (store) => store.delete(farmId) as IDBRequest<undefined>)
}
