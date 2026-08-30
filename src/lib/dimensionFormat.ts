// 寸法値 (距離 / 面積) の 書き方。
//
// 現場や 提出先で 表記の作法が 違うので、単位を 出すか / 何桁で 丸めるか /
// 面積を どの単位で 併記するか を 選べるようにする。
// 計測の 表示にも、文字として 残したものにも 同じ設定を 使う。

/** 面積の単位 */
export type AreaUnit = 'm2' | 'ha' | 'tsubo'

export const AREA_UNIT_LABEL: Record<AreaUnit, string> = {
  m2: 'm²',
  ha: 'ha',
  tsubo: '坪',
}

/** 1 坪 = 400/121 m² (= 約 3.3058 m²) */
const M2_PER_TSUBO = 400 / 121

export interface DimensionFormat {
  /** 距離に 単位 (m) を 付けるか */
  showUnit: boolean
  /** 小数点以下の桁数 */
  decimals: 1 | 2 | 3
  /** 面積を どの単位で 出すか。複数選ぶと 併記する */
  areaUnits: AreaUnit[]
  /** 文字として 残すときの 文字サイズ [px] */
  fontSize: number
}

export const DEFAULT_DIMENSION_FORMAT: DimensionFormat = {
  showUnit: true,
  decimals: 3,
  areaUnits: ['m2'],
  fontSize: 14,
}

/** 距離 [m] を 表記にする */
export function formatDistance(value: number, f: DimensionFormat): string {
  const n = value.toFixed(f.decimals)
  return f.showUnit ? `${n} m` : n
}

/** 面積 [m²] を 表記にする。単位を 複数選んでいれば 併記する */
export function formatArea(value: number, f: DimensionFormat): string {
  const units = f.areaUnits.length > 0 ? f.areaUnits : (['m2'] as AreaUnit[])
  const one = (u: AreaUnit): string => {
    const v = u === 'm2' ? value : u === 'ha' ? value / 10000 : value / M2_PER_TSUBO
    // 面積は 単位を 出さないと 何の数字か 分からないので、常に付ける
    return `${v.toFixed(f.decimals)} ${AREA_UNIT_LABEL[u]}`
  }
  const [first, ...rest] = units.map(one)
  return rest.length > 0 ? `${first} (${rest.join(' / ')})` : first
}
