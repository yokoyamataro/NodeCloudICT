import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import type { GradingLineTombo } from '@/stores/openChannelStore'

/** 解いた 結果 (杭 の 位置 と 高さ)。 図 と 表 で 同じ もの を 使う */
export interface ResolvedLineStake {
  stake: GradingLineTombo
  /** BP から の 内部距離 */
  distance: number
  /** 杭 の 天端 の 標高 */
  elevation: number
  /** 基準 の 計画高 (解け なければ null) */
  baseElev: number | null
  /** その 位置 の 現況 (無ければ null) */
  ground: number | null
}

/**
 * 整地 の 縦断 に トンボ / 丁張 を 置く ため の 行。
 *
 * 基準 は その 線 の 計画線 上 の SP。 そこ から SP 方向 に dw、 高さ に dh
 * ずらした 所 が 杭 の 天端 に なる (横断 の トンボ と 同じ 考え 方)。
 * 計画線 が 無い SP を 指した 場合 は 高さ が 解け ない ので 表 で 知らせる。
 */
export function GradingStakeBar({
  lineName,
  spOffset,
  stakes,
  onAdd,
  onEdit,
  onRemove,
  onRegister,
}: {
  lineName: string
  spOffset: number
  stakes: ResolvedLineStake[]
  onAdd: (v: { baseSp: number; dw: number; dh: number; kind: 'tombo' | 'batter'; name?: string }) => void
  onEdit: (id: string, patch: Partial<GradingLineTombo>) => void
  onRemove: (id: string) => void
  /** 座標管理 へ の 登録。 未登録 の もの だけ 渡る */
  onRegister: (items: ResolvedLineStake[]) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [sp, setSp] = useState('')
  const [dw, setDw] = useState('0')
  const [dh, setDh] = useState('1.0')
  const [kind, setKind] = useState<'tombo' | 'batter'>('tombo')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const add = () => {
    const spNum = parseFloat(sp)
    const dwNum = parseFloat(dw)
    const dhNum = parseFloat(dh)
    if (!Number.isFinite(spNum)) return
    onAdd({
      baseSp: Math.round((spNum - spOffset) * 1000) / 1000,
      dw: Number.isFinite(dwNum) ? dwNum : 0,
      dh: Number.isFinite(dhNum) ? dhNum : 0,
      kind,
      name: name.trim() || undefined,
    })
    setSp('')
    setName('')
  }

  const unregistered = stakes.filter((r) => !r.stake.coordId && r.baseElev != null)

  const num = (v: number | null, d = 3) => (v == null ? '−' : v.toFixed(d))

  return (
    <div className="shrink-0 border-t pt-1">
      <div className="flex items-center gap-2 text-[11px]">
        <button
          onClick={() => setOpen((v) => !v)}
          className={
            'px-2 py-0.5 border rounded ' +
            (open ? 'bg-purple-600 text-white border-purple-600' : 'bg-white hover:bg-slate-50')
          }
        >
          トンボ・丁張 {stakes.length > 0 && <span className="opacity-70">{stakes.length}</span>}
        </button>
        <span className="text-slate-400">{lineName} の 縦断 に 立てる</span>
        {msg && <span className="text-emerald-700">{msg}</span>}
      </div>

      {open && (
        <div className="mt-1 space-y-1">
          <div className="flex items-end gap-1 text-[11px] flex-wrap">
            <label className="flex flex-col gap-0.5">
              <span className="text-slate-500">基準 SP</span>
              <input
                type="number"
                step={0.01}
                value={sp}
                onChange={(e) => setSp(e.target.value)}
                className="w-24 px-1 py-0.5 border rounded text-right font-mono"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-slate-500">W (SP方向)</span>
              <input
                type="number"
                step={0.1}
                value={dw}
                onChange={(e) => setDw(e.target.value)}
                title="正 = EP 側 へ ずらす"
                className="w-20 px-1 py-0.5 border rounded text-right font-mono"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-slate-500">H (高さ)</span>
              <input
                type="number"
                step={0.1}
                value={dh}
                onChange={(e) => setDh(e.target.value)}
                title="計画高 から の 上げ 下げ。 正 = 上"
                className="w-20 px-1 py-0.5 border rounded text-right font-mono"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-slate-500">種別</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value === 'batter' ? 'batter' : 'tombo')}
                className="px-1 py-0.5 border rounded"
              >
                <option value="tombo">トンボ</option>
                <option value="batter">丁張</option>
              </select>
            </label>
            <label className="flex flex-col gap-0.5 flex-1 min-w-[6rem]">
              <span className="text-slate-500">点名 (空 で 自動)</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="px-1 py-0.5 border rounded"
              />
            </label>
            <button
              onClick={add}
              disabled={sp.trim() === ''}
              className="flex items-center gap-1 px-2 py-1 border rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              追加
            </button>
          </div>

          {stakes.length > 0 && (
            <div className="border rounded overflow-auto max-h-40">
              <table className="w-full text-[11px]">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="px-1 py-0.5 text-left">種別</th>
                    <th className="px-1 py-0.5 text-right">基準 SP</th>
                    <th className="px-1 py-0.5 text-right">W</th>
                    <th className="px-1 py-0.5 text-right">H</th>
                    <th className="px-1 py-0.5 text-right">杭 SP</th>
                    <th className="px-1 py-0.5 text-right">天端</th>
                    <th className="px-1 py-0.5 text-left">点名</th>
                    <th className="w-6" />
                  </tr>
                </thead>
                <tbody>
                  {stakes.map((r) => (
                    <tr key={r.stake.id} className="border-t">
                      <td className="px-1 py-0.5">
                        <select
                          value={r.stake.kind}
                          onChange={(e) =>
                            onEdit(r.stake.id, {
                              kind: e.target.value === 'batter' ? 'batter' : 'tombo',
                            })
                          }
                          className="px-0.5 py-0 border rounded"
                        >
                          <option value="tombo">トンボ</option>
                          <option value="batter">丁張</option>
                        </select>
                      </td>
                      <td className="px-1 py-0.5 text-right font-mono tabular-nums">
                        {(r.stake.baseSp + spOffset).toFixed(2)}
                      </td>
                      <td className="px-1 py-0.5 text-right">
                        <input
                          type="number"
                          step={0.1}
                          value={r.stake.dw}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (Number.isFinite(v)) onEdit(r.stake.id, { dw: v })
                          }}
                          className="w-14 px-0.5 py-0 border rounded text-right font-mono"
                        />
                      </td>
                      <td className="px-1 py-0.5 text-right">
                        <input
                          type="number"
                          step={0.1}
                          value={r.stake.dh}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            if (Number.isFinite(v)) onEdit(r.stake.id, { dh: v })
                          }}
                          className="w-14 px-0.5 py-0 border rounded text-right font-mono"
                        />
                      </td>
                      <td className="px-1 py-0.5 text-right font-mono tabular-nums text-slate-500">
                        {(r.distance + spOffset).toFixed(2)}
                      </td>
                      <td
                        className={
                          'px-1 py-0.5 text-right font-mono tabular-nums ' +
                          (r.baseElev == null ? 'text-red-600' : 'text-slate-700')
                        }
                        title={r.baseElev == null ? 'その SP に 計画線 が ありません' : undefined}
                      >
                        {r.baseElev == null ? '計画なし' : num(r.elevation)}
                      </td>
                      <td className="px-1 py-0.5 font-mono text-slate-500 truncate max-w-[6rem]">
                        {r.stake.name ?? ''}
                        {r.stake.coordId && <span className="ml-1 text-emerald-600">登録済</span>}
                      </td>
                      <td className="px-1 py-0.5 text-center">
                        <button
                          onClick={() => onRemove(r.stake.id)}
                          className="p-0.5 text-red-600 hover:bg-red-50 rounded"
                          title="消す"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {unregistered.length > 0 && (
            <button
              onClick={async () => {
                setBusy(true)
                setMsg('')
                try {
                  await onRegister(unregistered)
                  setMsg(`${unregistered.length} 点 を 座標管理 に 登録 しました`)
                } finally {
                  setBusy(false)
                }
              }}
              disabled={busy}
              className="px-2 py-1 text-[11px] border rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              未登録 {unregistered.length} 点 を 座標管理 へ
            </button>
          )}
        </div>
      )}
    </div>
  )
}
