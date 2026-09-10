// 地番 (境界測量の 画地) の 境界の 種類。
//
// 同じ 地番 でも 「地図XML から 起こした 暫定の 形」 と 「立会・確定測量 の 結果」
// は 別物 なので、design_work_areas の 行 を 分けて 両方 持てる ように する。
// どちら かは design_work_areas.boundary_kind で 区別 する。

export type BoundaryKind = 'provisional' | 'confirmed'

export const BOUNDARY_KIND_LABEL: Record<BoundaryKind, string> = {
  provisional: '仮境界',
  confirmed: '確定境界',
}

/** 一覧の バッジ 用 の 配色 */
export const BOUNDARY_KIND_BADGE: Record<BoundaryKind, string> = {
  provisional: 'bg-slate-100 text-slate-600 border-slate-300',
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-400',
}

/** DB の 生値 を 正規化 する。 未設定 / 未知の 値 は 仮境界 扱い */
export function toBoundaryKind(raw: string | null | undefined): BoundaryKind {
  return raw === 'confirmed' ? 'confirmed' : 'provisional'
}
