// 地番一覧（1 つの表）の固定ヘッダー行。CadastralRowFields と列幅・順序・
// 表示制御を共有する。

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
}

export function CadastralHeader({ visibleColumns, actionWidth = 'w-16' }: Props) {
  return (
    <div className="flex items-center gap-1 px-3 py-2 bg-slate-100 border-b text-[11px] font-medium text-slate-600 whitespace-nowrap">
      {CADASTRAL_COLUMN_KEYS.filter((k) => visibleColumns.has(k)).map((key) => (
        <div key={key} className={`${CADASTRAL_COLUMN_WIDTH[key]} px-1`}>
          {CADASTRAL_COLUMN_LABELS[key]}
        </div>
      ))}
      <div className={`${actionWidth} text-center`}>操作</div>
    </div>
  )
}
