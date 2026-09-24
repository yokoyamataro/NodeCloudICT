/**
 * 幅杭 の 既定 の 点名。 SP と 左右 の 離れ から 作る (SP3350.12 L4.57)。
 * 現場 の 札 の 書き方 に 合わせ、 距離 は cm まで。
 */
export function defaultStakeName(sp: number, offset: number): string {
  const side = offset > 1e-9 ? 'R' : offset < -1e-9 ? 'L' : 'CL'
  if (side === 'CL') return `SP${sp.toFixed(2)} CL`
  return `SP${sp.toFixed(2)} ${side}${Math.abs(offset).toFixed(2)}`
}

/**
 * 点種 の 「元 の まま」。 選ぶ と 元 の 座標 の 種別 を そのまま 使う。
 * 実際 の 種別 は 反映 の 直前 に sourceType に 置き換える。
 */
export const KEEP_SOURCE_TYPE = '__source__'

/** 点種 の 一覧 の 末尾 に 出す 「＋ 新しい 点種…」 の 値 */
export const NEW_TYPE_OPTION = '__new__'
