// 杭種（座標点が設置された物理的なマーカーの種類）。
// DB 上は design_coordinates.stake_type に文字列として保存される。
// プリセット以外の自由入力も許容するため、UI ではドロップダウン + datalist で実装する。

export interface StakeTypeOption {
  /** 内部コード兼表示ラベル（DB 保存値）。日本語そのまま使う */
  label: string
}

export const STAKE_TYPE_OPTIONS: StakeTypeOption[] = [
  { label: '木杭' },
  { label: 'コンクリート杭' },
  { label: 'プラスチック杭' },
  { label: '金属鋲' },
  { label: '金属標' },
  { label: '石標' },
  { label: '既設標' },
  { label: 'その他' },
]

/** 表示用：未設定は '-' を返す */
export function formatStakeType(value: string | null | undefined): string {
  if (!value || value.trim() === '') return '-'
  return value
}
