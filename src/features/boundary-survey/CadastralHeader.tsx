// 地番一覧（1 つの表）の固定ヘッダー行。CadastralRowFields と列幅・順序・
// 表示制御を共有する。
// 縦スクロール では 見出しを 残す (sticky top)。 横スクロール での
// 列の 貼り付け (sticky left) は しない —— 一部の 列だけ 残ると
// かえって 位置が 分からなく なる ため。

import {
  CADASTRAL_COLUMN_KEYS,
  CADASTRAL_COLUMN_LABELS,
  CADASTRAL_COLUMN_WIDTH,
  type CadastralColumnKey,
} from './CadastralRowFields'

interface Props {
  visibleColumns: ReadonlySet<CadastralColumnKey>
  /** 右端のアクション列の幅クラス（CadastralRowFields の隣の操作ボタン群と揃える） */
  actionWidth?: string
  /** 先頭に「編集」列を出すか（行頭の編集ボタンと揃える）。CSS 幅クラスを渡す */
  leadingWidth?: string
}

export function CadastralHeader({
  visibleColumns,
  actionWidth = 'w-16',
  leadingWidth,
}: Props) {
  return (
    <div className="flex items-center gap-1 px-3 py-2 bg-slate-100 border-b text-[11px] font-medium text-slate-600 whitespace-nowrap sticky top-0 z-20">
      {leadingWidth && (
        <div
          className={`${leadingWidth} shrink-0 text-center`}
        >
          編集
        </div>
      )}
      {CADASTRAL_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => (
        <div key={key} className={`${CADASTRAL_COLUMN_WIDTH[key]} shrink-0 px-1`}>
          {CADASTRAL_COLUMN_LABELS[key]}
        </div>
      ))}
      <div className={`${actionWidth} shrink-0 text-center`}>操作</div>
    </div>
  )
}
