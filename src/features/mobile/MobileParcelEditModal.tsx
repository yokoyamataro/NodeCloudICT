// スマホの「地番」一覧で行タップ → 開く 地番編集モーダル。
// 地番 (parcel_number) / 所在 (location) / 登記地目・地積 / 変更地目・地積 /
// 登記所有者住所・氏名 を編集し、blur (フォーカス外し) で即 upsert する。

import { useState } from 'react'
import { X, Loader2 } from 'lucide-react'
import { useParcelStore } from '@/stores/parcelStore'
import type { Parcel } from '@/types/database'

interface Props {
  workAreaId: string
  parcelNumberFallback: string
  parcel: Parcel | null
  onClose: () => void
}

function parseNum(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

export function MobileParcelEditModal({
  workAreaId,
  parcelNumberFallback,
  parcel,
  onClose,
}: Props) {
  const upsertParcel = useParcelStore((s) => s.upsertParcel)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // 「blur で 1 フィールドだけ upsert」する。値変化があった時だけ発火。
  const commit = async (
    field: keyof Parcel,
    raw: string,
    kind: 'text' | 'num',
  ) => {
    let next: string | number | null
    if (kind === 'num') next = parseNum(raw)
    else next = raw.trim().length > 0 ? raw.trim() : null

    // 変更判定
    const cur = (parcel?.[field] ?? null) as string | number | null
    if (cur === next) return
    // 空 vs null の等価扱い
    if ((cur ?? null) === (next ?? null)) return

    setBusy(String(field))
    setErr(null)
    try {
      const patch: Record<string, unknown> = { [field]: next }
      const saved = await upsertParcel(workAreaId, patch)
      if (!saved) throw new Error('保存に失敗しました')
    } catch (e) {
      setErr(
        `${field} の保存に失敗しました: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setBusy(null)
    }
  }

  const p = parcel

  return (
    <div
      className="fixed inset-0 z-[3300] bg-black/50 flex items-end sm:items-center justify-center p-3"
      onClick={onClose}
    >
      <div
        className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl shadow-xl overflow-hidden flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-xs text-slate-500">地番を編集</div>
            <div className="text-sm font-bold text-slate-800 truncate">
              {p?.parcel_number || parcelNumberFallback || '(未設定)'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1"
            aria-label="閉じる"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-auto flex-1 p-4 space-y-3 text-sm">
          {err && (
            <div className="p-2 text-xs bg-red-50 text-red-700 border border-red-200 rounded">
              {err}
            </div>
          )}

          <div>
            <div className="text-[10px] text-slate-500 mb-0.5">地番</div>
            <input
              type="text"
              defaultValue={p?.parcel_number ?? ''}
              onBlur={(e) => void commit('parcel_number', e.target.value, 'text')}
              className="w-full px-2 py-1 border rounded bg-white"
            />
          </div>
          <div>
            <div className="text-[10px] text-slate-500 mb-0.5">所在</div>
            <input
              type="text"
              defaultValue={p?.location ?? ''}
              onBlur={(e) => void commit('location', e.target.value, 'text')}
              className="w-full px-2 py-1 border rounded bg-white"
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">登記地目</div>
              <input
                type="text"
                defaultValue={p?.registered_land_category ?? ''}
                onBlur={(e) =>
                  void commit('registered_land_category', e.target.value, 'text')
                }
                className="w-full px-2 py-1 border rounded bg-white"
              />
            </div>
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">登記地積(m²)</div>
              <input
                type="number"
                step="0.01"
                defaultValue={p?.registered_area_sqm ?? ''}
                onBlur={(e) =>
                  void commit('registered_area_sqm', e.target.value, 'num')
                }
                className="w-full px-2 py-1 border rounded bg-white font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">変更地目</div>
              <input
                type="text"
                defaultValue={p?.updated_land_category ?? ''}
                onBlur={(e) =>
                  void commit('updated_land_category', e.target.value, 'text')
                }
                className="w-full px-2 py-1 border rounded bg-white"
              />
            </div>
            <div>
              <div className="text-[10px] text-slate-500 mb-0.5">変更地積(m²)</div>
              <input
                type="number"
                step="0.01"
                defaultValue={p?.updated_area_sqm ?? ''}
                onBlur={(e) =>
                  void commit('updated_area_sqm', e.target.value, 'num')
                }
                className="w-full px-2 py-1 border rounded bg-white font-mono"
              />
            </div>
          </div>

          <div>
            <div className="text-[10px] text-slate-500 mb-0.5">登記所有者住所</div>
            <input
              type="text"
              defaultValue={p?.registered_owner_address ?? ''}
              onBlur={(e) =>
                void commit('registered_owner_address', e.target.value, 'text')
              }
              className="w-full px-2 py-1 border rounded bg-white"
            />
          </div>
          <div>
            <div className="text-[10px] text-slate-500 mb-0.5">登記所有者氏名</div>
            <input
              type="text"
              defaultValue={p?.registered_owner_name ?? ''}
              onBlur={(e) =>
                void commit('registered_owner_name', e.target.value, 'text')
              }
              className="w-full px-2 py-1 border rounded bg-white"
            />
          </div>

          <div className="text-[10px] text-slate-400 leading-relaxed pt-2 border-t">
            地権者 (parcel_landowners) の割当は PC 表示から編集してください。
          </div>
        </div>

        <div className="px-4 py-2 border-t flex items-center justify-end gap-2">
          {busy && (
            <span className="text-xs text-slate-500 flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              {busy} を保存中…
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1 border rounded hover:bg-slate-50"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
