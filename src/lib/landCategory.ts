// 不動産登記規則 第99条 で定められた 23 地目。
// 順序は規則本文どおり。値そのものを DB（parcels.registered_land_category /
// updated_land_category）に格納する。DB 側の CHECK 制約と必ず一致させること。

export const LAND_CATEGORIES = [
  '田',
  '畑',
  '宅地',
  '学校用地',
  '鉄道用地',
  '塩田',
  '鉱泉地',
  '池沼',
  '山林',
  '牧場',
  '原野',
  '墓地',
  '境内地',
  '運河用地',
  '水道用地',
  '用悪水路',
  'ため池',
  '堤',
  '井溝',
  '保安林',
  '公衆用道路',
  '公園',
  '雑種地',
] as const

export type LandCategory = (typeof LAND_CATEGORIES)[number]

export function isLandCategory(value: unknown): value is LandCategory {
  return typeof value === 'string' && (LAND_CATEGORIES as readonly string[]).includes(value)
}
