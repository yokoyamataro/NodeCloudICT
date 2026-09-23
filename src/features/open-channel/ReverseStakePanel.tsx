import { useState } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { STAKE_TYPE_OPTIONS } from '@/lib/stakeTypes'
import { KEEP_SOURCE_TYPE, NEW_TYPE_OPTION } from './stakeName'

/**
 * 逆計算 で 拾った 1 点。
 *
 * 地図 で 選んだ 既設 の 座標 を 中心線 に 逆投影 した 結果 と、
 * 直す とき の 中身 (点名 / 点種 / 杭種 / メモ) を まとめて 持つ。
 */
export interface ReverseStakeRow {
  /** 行 の id (元 の 座標 id を そのまま 使う) */
  id: string
  /** 元 の 点名 */
  sourceName: string
  x: number
  y: number
  z: number | null
  /** 線形 上 の SP (内部距離 + spOffset) */
  sp: number
  /** 中心線 から の 垂距。 右 が +、 左 が - */
  offset: number
  /** 中心線 まで の 実距離 (当たり の 良さ) */
  gap: number
  /** 直す とき の 点名。 既定 は SP と 離れ から 作る */
  name: string
  /**
   * 元 の 座標 の 種別 (「元 の まま」 を 選んだ とき に 使う)。
   * プロジェクト ごと の カスタム 点種 は 任意 の コード な ので 文字列 で 持つ。
   */
  sourceType: string
  /** 直す とき の 種別。 KEEP_SOURCE_TYPE なら 元 の まま */
  type: string
  /** 杭種 */
  stakeType: string
  notes: string
}

/**
 * 幅杭 の 逆計算 の 中身。 メニュー の 中 に そのまま 置く。
 *
 * 地図 の 座標 を 選ぶ と ここ に 溜まり、 まとめて 座標 を 直せる。
 * 選んで いる の は 既に 登録 済み の 点 な ので 新しく は 作ら ない。
 */
export function ReverseStakePanel({
  rows,
  picking,
  canPick,
  typeOptions,
  onAddType,
  alsoAddWidthStake,
  onTogglePick,
  onChangeRows,
  onChangeAlsoAdd,
  onApply,
}: {
  rows: ReverseStakeRow[]
  /** 地図 の クリック 待ち か */
  picking: boolean
  /** 線形 が 引けて いる か */
  canPick: boolean
  /** 点種 の 選択肢 (既定 + プロジェクト の カスタム) */
  typeOptions: { code: string; label: string }[]
  /** 新しい 点種 を 足す。 プロジェクト 未選択 なら undefined */
  onAddType?: (code: string, label: string) => Promise<void>
  /** 座標 を 直す のと 一緒 に 幅杭計算 の 表 にも 入れる か */
  alsoAddWidthStake: boolean
  onTogglePick: (v: boolean) => void
  onChangeRows: (next: ReverseStakeRow[]) => void
  onChangeAlsoAdd: (v: boolean) => void
  /** 反映。 成功 したら 何件 直せた か を 返す */
  onApply: (rows: ReverseStakeRow[]) => Promise<number>
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  /** メモ の 一括設定 用 の 入力 */
  const [bulkNote, setBulkNote] = useState('')

  const patch = (id: string, p: Partial<ReverseStakeRow>) =>
    onChangeRows(rows.map((r) => (r.id === id ? { ...r, ...p } : r)))

  const labelOf = (code: string) => typeOptions.find((o) => o.code === code)?.label ?? code

  /**
   * 新しい 点種 を その場 で 足す。 コード は 表示名 から 作る (英数 以外 は _)。
   * 足した 後 は その 行 に 当てる。
   */
  const addNewType = async (rowId: string) => {
    if (!onAddType) return
    const label = window.prompt('新しい 点種 の 名前', '')
    if (label == null) return
    const trimmed = label.trim()
    if (trimmed === '') return
    const base =
      trimmed
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'type'
    let code = base
    let n = 2
    while (typeOptions.some((o) => o.code === code)) code = `${base}_${n++}`
    setBusy(true)
    try {
      await onAddType(code, trimmed)
      patch(rowId, { type: code })
      setMsg(`点種 「${trimmed}」 を 足しました。`)
    } finally {
      setBusy(false)
    }
  }

  const doApply = async () => {
    if (rows.length === 0) return
    setBusy(true)
    setMsg('')
    try {
      const n = await onApply(rows)
      setMsg(
        n > 0
          ? `${n} 点 の 名前 と 点種 を 直しました。` +
              (alsoAddWidthStake ? ' 幅杭計算 にも 追加 しました。' : '')
          : '更新 できません でした。',
      )
    } finally {
      setBusy(false)
    }
  }

  const cell = 'w-full px-1 py-0.5 border rounded text-sm'
  const sideOf = (o: number) => (o > 1e-9 ? 'R' : o < -1e-9 ? 'L' : 'CL')

  return (
    <>
      <div className="text-xs text-slate-500">
        地図 の 座標 を 選ぶ と、 その 点 が 線形 上 の どこ に 当たる か
        (SP と 中心線 から の オフセット) を 出します。
        <br />
        既設 の 杭 や 実測点 を まとめて 選び、 名前 や 点種 を 付け替え られます。
        選んだ 座標 を 直す だけ な ので 点 は 増えません。
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => onTogglePick(!picking)}
          disabled={!canPick}
          className={
            'px-3 py-1 text-xs border rounded disabled:opacity-40 ' +
            (picking
              ? 'bg-pink-600 text-white border-pink-600'
              : 'bg-sky-600 text-white border-sky-600 hover:bg-sky-700')
          }
          title="地図 の 座標 を 選ぶ と、 その 点 の SP と オフセット を 逆算 する"
        >
          {picking ? '地図で選択中…' : '地図から逆計算'}
        </button>
        {!canPick && (
          <span className="text-xs text-amber-600">先 に 線形 を 計算 して ください</span>
        )}
        {rows.length > 0 && (
          <span className="text-xs text-slate-400">選んだ {rows.length} 点</span>
        )}
      </div>

      {picking && (
        <div className="text-xs text-pink-700 bg-pink-50 border rounded px-2 py-1">
          地図 の 座標 を クリック する と 下 の 表 に 溜まります。 続けて 何点 でも 選べます。
        </div>
      )}
      {msg && <div className="text-xs text-emerald-700">{msg}</div>}

      {rows.length > 0 && (
        <>
          <div className="border rounded overflow-auto max-h-72">
            <table className="w-full text-sm min-w-[64rem]">
              <thead className="bg-slate-50 text-slate-600 sticky top-0 text-xs">
                <tr>
                  <th className="px-1 py-1 text-left w-28">元 の 点名</th>
                  <th className="px-1 py-1 text-right w-44">座標 (X / Y)</th>
                  <th className="px-1 py-1 text-right w-24">SP</th>
                  <th className="px-1 py-1 text-right w-24">オフセット</th>
                  <th className="px-1 py-1 text-left w-40">変更点名</th>
                  <th className="px-1 py-1 text-left w-32">点種</th>
                  <th className="px-1 py-1 text-left w-28">杭種</th>
                  <th className="px-1 py-1 text-left">メモ</th>
                  <th className="px-1 py-1 w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t align-top">
                    <td className="px-1 py-1 text-slate-700 truncate">{r.sourceName}</td>
                    <td className="px-1 py-1 text-right tabular-nums text-slate-600">
                      {r.x.toFixed(3)} / {r.y.toFixed(3)}
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums text-slate-800 font-semibold">
                      {r.sp.toFixed(3)}
                    </td>
                    <td
                      className="px-1 py-1 text-right tabular-nums text-slate-800"
                      title={`中心線 まで ${r.gap.toFixed(3)}m`}
                    >
                      {sideOf(r.offset)}
                      {Math.abs(r.offset).toFixed(3)}
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="text"
                        value={r.name}
                        onChange={(e) => patch(r.id, { name: e.target.value })}
                        className={cell}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <select
                        value={r.type}
                        onChange={(e) => {
                          const v = e.target.value
                          if (v === NEW_TYPE_OPTION) {
                            void addNewType(r.id)
                            return
                          }
                          patch(r.id, { type: v })
                        }}
                        className={cell + ' bg-white'}
                      >
                        <option value={KEEP_SOURCE_TYPE}>
                          元 の まま ({labelOf(r.sourceType)})
                        </option>
                        {typeOptions.map((o) => (
                          <option key={o.code} value={o.code}>
                            {o.label}
                          </option>
                        ))}
                        {onAddType && <option value={NEW_TYPE_OPTION}>＋ 新しい 点種…</option>}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="text"
                        list="oc-stake-types"
                        value={r.stakeType}
                        onChange={(e) => patch(r.id, { stakeType: e.target.value })}
                        placeholder="任意"
                        className={cell}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="text"
                        value={r.notes}
                        onChange={(e) => patch(r.id, { notes: e.target.value })}
                        placeholder="任意"
                        className={cell}
                      />
                    </td>
                    <td className="px-1 py-1 text-center">
                      <button
                        onClick={() => onChangeRows(rows.filter((x) => x.id !== r.id))}
                        className="p-0.5 border rounded hover:bg-red-50 text-red-600"
                        title="この 行 を 外す"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="oc-stake-types">
              {STAKE_TYPE_OPTIONS.map((o) => (
                <option key={o.label} value={o.label} />
              ))}
            </datalist>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-slate-600 shrink-0">メモ を 一括設定</span>
            <input
              type="text"
              value={bulkNote}
              onChange={(e) => setBulkNote(e.target.value)}
              placeholder="全行 に 同じ メモ を 入れる"
              className="flex-1 min-w-[12rem] px-2 py-1 border rounded text-sm"
            />
            <button
              onClick={() => onChangeRows(rows.map((r) => ({ ...r, notes: bulkNote })))}
              className="px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600"
              title="いま の 全行 の メモ を 置き換える"
            >
              全行 に 適用
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <label className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={alsoAddWidthStake}
                onChange={(e) => onChangeAlsoAdd(e.target.checked)}
              />
              幅杭計算 の 表 にも 追加 する
            </label>
            <button
              onClick={() => onChangeRows([])}
              disabled={busy}
              className="ml-auto px-2 py-1 text-xs border rounded bg-white hover:bg-slate-50 text-slate-600 disabled:opacity-40"
            >
              全部 外す
            </button>
            <button
              onClick={() => void doApply()}
              disabled={busy}
              className="flex items-center gap-1 px-3 py-1 text-xs border rounded bg-sky-600 text-white border-sky-600 hover:bg-sky-700 disabled:opacity-40"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              {rows.length} 点 を 一括更新
            </button>
          </div>
        </>
      )}
    </>
  )
}
