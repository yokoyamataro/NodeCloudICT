// 走った場所の地図タイルを自動でキャッシュする TileLayer。
//
// 【方針】
// - 保存するのは「現在地の近くを、乗車中に表示したタイル」だけ。
//   単に眺めただけの場所 (日本全体を俯瞰した等) は 1 枚も保存しない。
//   これをやらないと、関係ない場所を見ているうちに容量が膨らむ。
// - 破棄は「最後に使った時刻」が古い順。取得時期ではないので、毎日通る道は
//   何か月前に取ったものでも残り、一度きりの遠征は先に消える。
// - 上限 50MB (約 3,400 枚 ≒ 38km 四方相当)。
//
// ドライバーに一覧管理や範囲指定はさせない。操作は一切不要。

import { useEffect } from 'react'
import { useMap } from 'react-leaflet'
import L from 'leaflet'
import {
  tileEvictTo,
  tileGet,
  tilePut,
  tileTouch,
  type CachedTile,
} from '@/lib/offlineDb'

/** キャッシュ全体の上限 [byte] */
const MAX_BYTES = 50 * 1024 * 1024
/** 現在地からこの距離以内のタイルだけ保存する [m] */
const CACHE_RADIUS_M = 3000
/** この範囲のズームだけ保存する (広域図は不要、拡大しすぎは容量が跳ねる) */
const MIN_Z = 12
const MAX_Z = 15
/** 使用時刻の更新間隔。毎回書くと重いので間引く [ms] */
const TOUCH_INTERVAL_MS = 60 * 60 * 1000
/** 詳細タイルが無いとき、何段まで広域側にさかのぼって代用するか */
const FALLBACK_LEVELS = 4

interface Props {
  /** タイル URL テンプレート ({z}/{x}/{y}) */
  url: string
  attribution: string
  maxNativeZoom?: number
  maxZoom?: number
  /** キャッシュのキーに使う識別子 (背景の種類ごとに分ける) */
  layerId: string
  /** 現在地。null の間は保存しない */
  currentPos: [number, number] | null
  /** 保存を有効にするか (乗車中のみ true にする想定) */
  cacheEnabled: boolean
}

/** タイル座標 (z/x/y) の中心の緯度経度 */
function tileCenter(z: number, x: number, y: number): [number, number] {
  const n = 2 ** z
  const lon = ((x + 0.5) / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / n)))
  return [(latRad * 180) / Math.PI, lon]
}

function distanceM(a: [number, number], b: [number, number]): number {
  const R = 6371000
  const dLat = ((b[0] - a[0]) * Math.PI) / 180
  const dLon = ((b[1] - a[1]) * Math.PI) / 180
  const la1 = (a[0] * Math.PI) / 180
  const la2 = (b[0] * Math.PI) / 180
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

export function CachedTileLayer({
  url,
  attribution,
  maxNativeZoom,
  maxZoom,
  layerId,
  currentPos,
  cacheEnabled,
}: Props) {
  const map = useMap()

  useEffect(() => {
    // 現在地と有効フラグは毎フレーム変わりうるので、レイヤを作り直さずに
    // 参照できるようクロージャの外に置く
    const state = { pos: currentPos, enabled: cacheEnabled }
    stateRef.current = state

    const Layer = L.TileLayer.extend({
      createTile(coords: L.Coords, done: (err?: Error, tile?: HTMLElement) => void) {
        const img = document.createElement('img')
        img.alt = ''
        const key = `${layerId}/${coords.z}/${coords.x}/${coords.y}`
        const src = (this as L.TileLayer).getTileUrl(coords)

        const finish = (objectUrl: string | null) => {
          img.src = objectUrl ?? src
          done(undefined, img)
        }

        void (async () => {
          try {
            const hit = await tileGet(key)
            if (hit) {
              // 使用時刻の更新は間引く (毎回書くと表示のたびに書き込みが走る)
              if (Date.now() - hit.lastUsedAt > TOUCH_INTERVAL_MS) {
                void tileTouch(key)
              }
              finish(URL.createObjectURL(hit.blob))
              return
            }
          } catch {
            /* キャッシュが読めなければ通常取得に落ちる */
          }
          // キャッシュに無い → 通常どおり取得。保存するかは位置とズームで判断
          finish(null)
          void maybeStore(key, src, coords)
          // 圏外などで取得に失敗したら、広域タイルを引き延ばして代用する。
          // 真っ白よりは、ぼやけていても道が見えた方がよい
          img.onerror = () => {
            void stretchFromAncestor(layerId, coords.z, coords.x, coords.y).then((u) => {
              if (u) img.src = u
            })
          }
        })()

        return img
      },
    })

    const layer = new (Layer as unknown as new (u: string, o: L.TileLayerOptions) => L.TileLayer)(
      url,
      { attribution, maxNativeZoom, maxZoom },
    )
    layer.addTo(map)
    return () => {
      layer.remove()
    }
    // url / layerId が変われば作り直す。位置と有効フラグは ref 経由なので依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, url, layerId, attribution, maxNativeZoom, maxZoom])

  // 現在地と有効フラグの最新値をレイヤ側へ渡す
  useEffect(() => {
    stateRef.current = { pos: currentPos, enabled: cacheEnabled }
  }, [currentPos, cacheEnabled])

  return null
}

/** createTile から参照する最新の状態 (レイヤを作り直さずに済ませるため) */
const stateRef: { current: { pos: [number, number] | null; enabled: boolean } } = {
  current: { pos: null, enabled: false },
}

/**
 * 詳細タイルが無いとき、広域タイルの該当部分を切り出して引き延ばす。
 *
 * 圏外で拡大すると真っ白になるのを防ぐ。ぼやけるが、道の形は追える。
 * (Leaflet の maxNativeZoom はレイヤ全体の設定で、タイル単位に効かせられない)
 */
async function stretchFromAncestor(
  layerId: string,
  z: number,
  x: number,
  y: number,
): Promise<string | null> {
  for (let up = 1; up <= FALLBACK_LEVELS; up += 1) {
    const az = z - up
    if (az < MIN_Z) break
    const scale = 2 ** up
    const hit = await tileGet(`${layerId}/${az}/${Math.floor(x / scale)}/${Math.floor(y / scale)}`)
    if (!hit) continue
    try {
      const bmp = await createImageBitmap(hit.blob)
      const size = bmp.width / scale
      const canvas = document.createElement('canvas')
      canvas.width = bmp.width
      canvas.height = bmp.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(
        bmp,
        (x % scale) * size,
        (y % scale) * size,
        size,
        size,
        0,
        0,
        canvas.width,
        canvas.height,
      )
      bmp.close()
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
      if (!blob) return null
      return URL.createObjectURL(blob)
    } catch {
      return null
    }
  }
  return null
}

async function maybeStore(key: string, src: string, coords: L.Coords): Promise<void> {
  const { pos, enabled } = stateRef.current
  if (!enabled || !pos) return
  if (coords.z < MIN_Z || coords.z > MAX_Z) return
  if (distanceM(pos, tileCenter(coords.z, coords.x, coords.y)) > CACHE_RADIUS_M) return
  try {
    const res = await fetch(src)
    if (!res.ok) return
    const blob = await res.blob()
    const value: CachedTile = {
      key,
      blob,
      bytes: blob.size,
      lastUsedAt: Date.now(),
    }
    await tilePut(value)
    // 上限超過分をここで整理する。毎回全件走査すると重いので、
    // ある程度の頻度に間引く
    if (Math.random() < 0.02) void tileEvictTo(MAX_BYTES)
  } catch {
    /* 保存できなくても表示には影響しない */
  }
}
