// 地番 (境界測量の 画地) の 筆界 の 種類。
//
// 同じ 地番 でも 「地図XML から 起こした 暫定の 形」 (仮筆界) と
// 「立会・確定測量 の 結果」 (確定筆界) は 別物 なので、design_work_areas
// の 1 行 に 別々 の 構成点列 を 持つ。 さらに 分筆 / 合筆 の 予定線 (実務上
// 「◯◯筆界」 と 呼ぶ) も 別 の 構成点列 と して 保持 する。
//   - 仮筆界 (provisional)   … 地図 XML など から 起こした 当初 の 形
//   - 確定筆界 (confirmed)   … 立会・確定測量 の 成果
//   - 分筆筆界 (subdivision) … 筆 を 分ける 予定 の 内側 の 境界
//   - 合筆筆界 (consolidation) … 隣接筆 と 合わせる 予定 の 境界

export type BoundaryKind =
  | 'provisional'
  | 'confirmed'
  | 'subdivision'
  | 'consolidation'

export const BOUNDARY_KIND_LABEL: Record<BoundaryKind, string> = {
  provisional: '仮筆界',
  confirmed: '確定筆界',
  subdivision: '分筆筆界',
  consolidation: '合筆筆界',
}

/** タブ・トグル で 使う 表示順 */
export const BOUNDARY_KIND_ORDER: BoundaryKind[] = [
  'provisional',
  'confirmed',
  'subdivision',
  'consolidation',
]

/** 一覧の バッジ 用 の 配色 */
export const BOUNDARY_KIND_BADGE: Record<BoundaryKind, string> = {
  provisional: 'bg-slate-100 text-slate-600 border-slate-300',
  confirmed: 'bg-emerald-100 text-emerald-800 border-emerald-400',
  subdivision: 'bg-sky-100 text-sky-800 border-sky-300',
  consolidation: 'bg-amber-100 text-amber-800 border-amber-300',
}

/** DB の 生値 を 正規化 する。 未設定 / 未知の 値 は 仮筆界 扱い */
export function toBoundaryKind(raw: string | null | undefined): BoundaryKind {
  switch (raw) {
    case 'confirmed':
      return 'confirmed'
    case 'subdivision':
      return 'subdivision'
    case 'consolidation':
      return 'consolidation'
    default:
      return 'provisional'
  }
}
