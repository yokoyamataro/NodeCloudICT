// 表示範囲の地図タイルを事前にまとめて保存する。
//
// 走った場所の自動キャッシュ (CachedTileLayer) は「これから初めて行く場所」を
// 埋められない。そこだけ、地図を目的の場所に動かしてボタン 1 つで用意できる
// ようにする。範囲を囲ませたり名前を付けさせたりはしない。
//
// 地理院タイルへの一括取得になるので、同時接続を絞って行儀よく取る。

import { tileEvictTo, tileGet, tilePut, tileUsage } from '@/lib/offlineDb'

/** キャッシュ全体の上限 [byte]。CachedTileLayer と揃える */
export const MAX_CACHE_BYTES = 50 * 1024 * 1024
/** タイル 1 枚の平均サイズ [byte]。見積り表示に使う */
const AVG_TILE_BYTES = 15 * 1024
/** 同時に取りに行く数。相手のサーバに負荷をかけないよう絞る */
const CONCURRENCY = 4

export interface TileRange {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
  minZoom: number
  maxZoom: number
}

function lonToX(lon: number, z: number): number {
  return Math.floor(((lon + 180) / 360) * 2 ** z)
}

function latToY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z,
  )
}

/** 範囲に含まれるタイル座標をすべて列挙する */
export function enumerateTiles(r: TileRange): Array<{ z: number; x: number; y: number }> {
  const out: Array<{ z: number; x: number; y: number }> = []
  for (let z = r.minZoom; z <= r.maxZoom; z += 1) {
    const x0 = lonToX(r.minLon, z)
    const x1 = lonToX(r.maxLon, z)
    // 緯度は北が小さい y になるので max/min が入れ替わる
    const y0 = latToY(r.maxLat, z)
    const y1 = latToY(r.minLat, z)
    for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += 1) {
      for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 1) {
        out.push({ z, x, y })
      }
    }
  }
  return out
}

export interface Estimate {
  count: number
  bytes: number
  /** 保存すると上限を超えるか */
  exceedsCap: boolean
}

export async function estimate(r: TileRange): Promise<Estimate> {
  const count = enumerateTiles(r).length
  const bytes = count * AVG_TILE_BYTES
  let used = 0
  try {
    used = (await tileUsage()).bytes
  } catch {
    /* 取れなければ 0 として扱う */
  }
  return { count, bytes, exceedsCap: used + bytes > MAX_CACHE_BYTES }
}

function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y))
    .replace('{s}', 'a')
}

/**
 * 範囲のタイルを取得して保存する。既にあるものは飛ばす。
 * onProgress は (完了数, 総数) で呼ばれる。
 */
export async function downloadRange(
  template: string,
  layerId: string,
  r: TileRange,
  onProgress: (done: number, total: number) => void,
  shouldStop: () => boolean,
): Promise<{ saved: number; skipped: number; failed: number }> {
  const all = enumerateTiles(r)
  let done = 0
  let saved = 0
  let skipped = 0
  let failed = 0
  let cursor = 0

  const worker = async () => {
    for (;;) {
      if (shouldStop()) return
      const i = cursor
      cursor += 1
      if (i >= all.length) return
      const t = all[i]
      const key = `${layerId}/${t.z}/${t.x}/${t.y}`
      try {
        if (await tileGet(key)) {
          skipped += 1
        } else {
          const res = await fetch(tileUrl(template, t.z, t.x, t.y))
          if (res.ok) {
            const blob = await res.blob()
            await tilePut({ key, blob, bytes: blob.size, lastUsedAt: Date.now() })
            saved += 1
          } else {
            failed += 1
          }
        }
      } catch {
        failed += 1
      }
      done += 1
      onProgress(done, all.length)
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  await tileEvictTo(MAX_CACHE_BYTES)
  return { saved, skipped, failed }
}
