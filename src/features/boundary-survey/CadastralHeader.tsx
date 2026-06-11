// 地番一覧（1 つの表）の固定ヘッダー行。CadastralRowFields と列幅・順序・
// 表示制御を共有する。
// 左端の「編集」と所在・地番列は sticky-left で横スクロール時も画面に残す。

import {
  CADASTRAL_COLUMN_KEYS,
  CADASTRAL_COLUMN_LABELS,
  CADASTRAL_COLUMN_WIDTH,
  CADASTRAL_STICKY_COLUMNS,
  cadastralStickyLeftPx,
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
          className={`${leadingWidth} shrink-0 text-center sticky left-3 z-10 bg-slate-100`}
        >
          編集
        </div>
      )}
      {CADASTRAL_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => {
        const isSticky = CADASTRAL_STICKY_COLUMNS.has(key)
        return (
          <div
            key={key}
            className={`${CADASTRAL_COLUMN_WIDTH[key]} shrink-0 px-1 ${
              isSticky ? 'sticky z-10 bg-slate-100' : ''
            }`}
            style={
              isSticky
                ? { left: cadastralStickyLeftPx(key, visibleColumns) + 'px' }
                : undefined
            }
          >
            {CADASTRAL_COLUMN_LABELS[key]}
          </div>
        )
      })}
      <div className={`${actionWidth} shrink-0 text-center`}>操作</div>
    </div>
  )
}
