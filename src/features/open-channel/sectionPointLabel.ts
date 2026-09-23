import type { MeasuredCrossPoint } from '@/stores/openChannelStore'

/**
 * 断面 の 変化点 の 見出し。
 * 表 と 同じ 「L/R + 中心 から の 距離 (正)」 の 書き方 に 揃える。
 * 点名 (note) が あれば 後ろ に 付ける。
 */
export function labelOfPoint(p: MeasuredCrossPoint): string {
  const side = p.offset > 1e-9 ? 'R' : p.offset < -1e-9 ? 'L' : 'CL'
  if (side === 'CL') return p.note ? `CL ${p.note}` : 'CL'
  return `${side}${Math.abs(p.offset).toFixed(3)}${p.note ? ` ${p.note}` : ''}`
}
