// マニュアル (/manual/...) の 該当 ページ へ 飛ばす 「?」 アイコン。
//
// 使い方:
//   <HelpLink slug="boundary-survey/parcels" />
//   <HelpLink slug="mobile/staking" label="実測 の 使い方" />
//
// マニュアル 本体 は 別 の Vercel プロジェクト (Astro Starlight)。
// nodecloud.jp/manual/* に vercel.json rewrite で 貼り付けて 配信 する。
// 新規タブ で 開いて 作業中 の 画面 を 失わ ない。

import { HelpCircle } from 'lucide-react'

const MANUAL_BASE = '/manual'

interface Props {
  /** マニュアル の パス (先頭 スラッシュ 不要)。 例: 'boundary-survey/parcels' */
  slug: string
  /** ホバー タイトル / アクセシビリティ ラベル */
  label?: string
  /** アイコン サイズ (px)。 既定 14 */
  size?: number
  /** 追加 クラス */
  className?: string
}

export function HelpLink({ slug, label = 'マニュアルを開く', size = 14, className = '' }: Props) {
  const href = `${MANUAL_BASE}/${slug.replace(/^\/+/, '').replace(/\/*$/, '/')}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center text-slate-400 hover:text-blue-600 ${className}`}
    >
      <HelpCircle style={{ width: size, height: size }} />
    </a>
  )
}
