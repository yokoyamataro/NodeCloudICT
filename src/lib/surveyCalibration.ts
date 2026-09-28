// 実測値 に かける スライド量 (dx/dy/dz オフセット) は 廃止 しました。
//
// 過去 に 「GPS の 系統差 / 基準点 の ずれ」 を 素早く 吸収する ため の 簡易 補正
// と して 導入 していた が、実運用 で は 混乱 の 元 と なった ので 撤去。
// 既存 の 呼出 と の 互換 を 保つ ため に 「常 に 0 で 恒等 な no-op」 の
// スタブ を 残して あり、 将来 参照 が 消え次第 型 も 削除 する。

export interface SurveySlide {
  dx: number
  dy: number
  dz: number
}

export const NO_SLIDE: SurveySlide = { dx: 0, dy: 0, dz: 0 }

/** 廃止: 常に NO_SLIDE。 引数 の farmId は 使わない。 */
export async function fetchSurveySlide(_farmId: string): Promise<SurveySlide> {
  return NO_SLIDE
}

/** 廃止: 何もしない no-op。 */
export async function saveSurveySlide(
  _farmId: string,
  _slide: SurveySlide,
): Promise<void> {
  /* no-op */
}

/** 廃止: 恒等 (入力 を そのまま 返す)。 */
export function applyReverseSlide(
  p: { x: number; y: number; z: number },
  _slide: SurveySlide,
): { x: number; y: number; z: number } {
  return { x: p.x, y: p.y, z: p.z }
}
