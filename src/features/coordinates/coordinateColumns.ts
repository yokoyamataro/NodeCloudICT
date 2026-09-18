// 座標一覧 の 上 に 出す 「表示列」 の ボタン と 一覧。
// 選んだ 内容 は localStorage に 残す ので、開き直して も 同じ 並び に なる。
//
// 点番号 は 行 を 見分ける ため の 列 な ので 外せない。

import { useState } from 'react'

/** 外せる 列。 点番号 は 含めない (いつも 出す) */
export const COORD_COLUMN_KEYS = [
  'x',
  'y',
  'z',
  'type',
  'stakeType',
  'stakeStatus',
  'photo',
  'lat',
  'lng',
  'ellipsoid',
  'updatedBy',
  'updatedAt',
  'notes',
] as const

export type CoordColumnKey = (typeof COORD_COLUMN_KEYS)[number]

export const COORD_COLUMN_LABELS: Record<CoordColumnKey, string> = {
  x: 'X (m)',
  y: 'Y (m)',
  z: 'Z (m)',
  type: '種類',
  stakeType: '杭種',
  stakeStatus: '設置',
  photo: '写真',
  lat: '緯度',
  lng: '経度',
  ellipsoid: '楕円体高',
  updatedBy: '更新者',
  updatedAt: '更新日時',
  notes: '備考',
}

/** 既定 は 楕円体高 以外。 桁 が 多く 横 に 伸びる ので */
export const DEFAULT_COORD_COLUMNS: CoordColumnKey[] = COORD_COLUMN_KEYS.filter(
  (k) => k !== 'ellipsoid',
)

const STORAGE_KEY = 'coordinates:visibleColumns'

function load(): Set<CoordColumnKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Set(DEFAULT_COORD_COLUMNS)
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr)) return new Set(DEFAULT_COORD_COLUMNS)
    const valid = arr.filter((k): k is CoordColumnKey =>
      (COORD_COLUMN_KEYS as readonly string[]).includes(k as string),
    )
    return new Set(valid)
  } catch {
    return new Set(DEFAULT_COORD_COLUMNS)
  }
}

function save(set: Set<CoordColumnKey>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(set)))
  } catch {
    /* ignore */
  }
}

export function useCoordVisibleColumns(): [
  Set<CoordColumnKey>,
  (next: Set<CoordColumnKey>) => void,
] {
  const [visible, setVisible] = useState<Set<CoordColumnKey>>(() => load())
  const update = (next: Set<CoordColumnKey>) => {
    setVisible(next)
    save(next)
  }
  return [visible, update]
}
