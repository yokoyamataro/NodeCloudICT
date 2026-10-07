// 国土地理院 の グリッド .par を Supabase Storage から 取得 して メモリ キャッシュ。
//
// Storage レイアウト:
//   geodetic-grid/tky2jgd/TKY2JGD.par
//   geodetic-grid/patchjgd/<id>/<name>.par
//
// 読み込み は 遅延 (ユーザー が モーダル を 開いた 時 に 初めて fetch)。
// 一度 ロード したら セッション 中 は 使い回す。

import { supabase } from '@/lib/supabase'
import { parseGrid, type Grid } from './converter'

const BUCKET = 'geodetic-grid'
const SIGNED_URL_TTL_SEC = 60 * 60

/** 地殻変動補正 (PATCHJGD) の カタログ。 TKY-JGD-PATCH repo の 構造 に 合わせる */
export interface PatchCatalogEntry {
  /** Storage path (bucket 相対): "patchjgd/000184958/kumamoto2016_BL.par" */
  path: string
  /** 画面 表示 用 ラベル */
  label: string
  /** 発生 年 (並び 替え 用) */
  year: number
}

export const PATCH_CATALOG: PatchCatalogEntry[] = [
  { path: 'patchjgd/000184959/touhokutaiheiyouoki2011.par', label: '東北地方太平洋沖地震 (2011)', year: 2011 },
  { path: 'patchjgd/000184966/tokachi2003.par', label: '十勝沖地震 (2003)', year: 2003 },
  { path: 'patchjgd/000184965/tokachi2003b.par', label: '十勝沖地震 余震 (2003)', year: 2003 },
  { path: 'patchjgd/000184964/fukuoka2005.par', label: '福岡県西方沖地震 (2005)', year: 2005 },
  { path: 'patchjgd/000184963/noto2007_BL.par', label: '能登半島地震 (2007)', year: 2007 },
  { path: 'patchjgd/000184962/chuetsuoki2007.par', label: '新潟県中越沖地震 (2007)', year: 2007 },
  { path: 'patchjgd/000184961/iwatemiyagi2008.par', label: '岩手宮城内陸地震 (2008)', year: 2008 },
  { path: 'patchjgd/000184960/miyakojima2008.par', label: '宮古島近海地震 (2008)', year: 2008 },
  { path: 'patchjgd/000184958/kumamoto2016_BL.par', label: '熊本地震 (2016)', year: 2016 },
  { path: 'patchjgd/000255679/noto2024_BL.par', label: '令和6年能登半島地震 (2024)', year: 2024 },
  { path: 'patchjgd/000259855/noto2024_02BL.par', label: '令和6年能登半島地震 第2版 (2024)', year: 2024 },
  { path: 'patchjgd/000262035/hyuganada2024_BL.par', label: '日向灘地震 (2024)', year: 2024 },
  { path: 'patchjgd/000275890/aomori2025_BL.par', label: '青森県沖地震 (2025)', year: 2025 },
]

const TKY_PATH = 'tky2jgd/TKY2JGD.par'

const cache = new Map<string, Grid>()

async function fetchGrid(storagePath: string): Promise<Grid> {
  const cached = cache.get(storagePath)
  if (cached) return cached

  const { data: signed, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SEC)
  if (error) {
    throw new Error(
      `測地 グリッド が 見つかり ません: ${storagePath}\n` +
      `Supabase Storage の bucket "${BUCKET}" に ファイル を アップロード して ください。\n` +
      `詳細: ${error.message}`,
    )
  }
  const res = await fetch(signed.signedUrl)
  if (!res.ok) throw new Error(`グリッド 取得 失敗 (${res.status}): ${storagePath}`)
  const text = await res.text()
  const name = storagePath.split('/').pop() ?? storagePath
  const grid = parseGrid(text, { name })
  if (grid.data.size === 0) {
    throw new Error(`グリッド が 空 です: ${storagePath}`)
  }
  cache.set(storagePath, grid)
  return grid
}

export function loadTkyGrid(): Promise<Grid> {
  return fetchGrid(TKY_PATH)
}

export function loadPatchGrid(catalogPath: string): Promise<Grid> {
  return fetchGrid(catalogPath)
}

/** cache を 捨てる (テスト 用 / リロード ボタン 用) */
export function clearGridCache(): void {
  cache.clear()
}
