// SXF (.sfc / .p21) の 読み込み 入口。
//
// 同じ 拡張子 でも 中身 が 2 通り ある:
//   * feature_mode … SXF 独自 の line_feature(...) 形式
//   * AP202_mode   … 素 の STEP 図形 (cartesian_point / trimmed_curve …)
// ヘッダ の FILE_DESCRIPTION に 書いて ある が、書き方 が 揺れる ので
// 両方 試して 図形 が 多く 取れた 方 を 採る。

import { parseSxf } from './parseSxf'
import { parseStepAp202 } from './parseStepAp202'
import type { DxfDocument } from '@/lib/dxfRender'

export interface SxfResult extends DxfDocument {
  /** どちら の 読み方 で 取れたか (診断用) */
  mode: 'feature' | 'ap202'
  /** 読めなかった とき の 手がかり */
  tokens: { name: string; count: number }[]
}

export function parseSxfFile(text: string): SxfResult {
  const feature = parseSxf(text)
  if (feature.shapes.length > 0) return { ...feature, mode: 'feature' }
  const ap202 = parseStepAp202(text)
  if (ap202.shapes.length > 0) return { ...ap202, mode: 'ap202' }
  // どちら でも 取れない。 中身 の 手がかり が 多い 方 を 返す
  return ap202.tokens.length >= feature.tokens.length
    ? { ...ap202, mode: 'ap202' }
    : { ...feature, mode: 'feature' }
}
