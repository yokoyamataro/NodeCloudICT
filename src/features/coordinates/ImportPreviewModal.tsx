// SIMA / CSV / 表 貼付 で 読み込んだ 座標 を 登録 前 に 確認 する 共通 プレビュー。
//
// 2 択:
//   - 「登録」            → そのまま importCoordinates へ 流す
//   - 「座標変換 →」      → 親 側 で GeodeticTransformModal を staging で 開く
//
// AI 読取 (OcrCoordinatesModal) は 独自 の 読取/編集 UI を 持つ ので そちら を 使う。

import { X } from 'lucide-react'
import { COORDINATE_TYPE_NAMES, type CoordinateType } from '@/lib/coordinates'
import type { ImportCoordinateInput } from '@/stores/coordinateStore'

interface Props {
  open: boolean
  onClose: () => void
  /** タイトル (「SIMA 読込 結果」 等) */
  title: string
  points: ImportCoordinateInput[]
  /** そのまま 登録 する */
  onRegister: (points: ImportCoordinateInput[]) => void
  /** 登録 前 に 測地座標変換 を 掛ける (親 が GeodeticTransformModal を 開く) */
  onOpenTransform: (points: ImportCoordinateInput[]) => void
}

export function ImportPreviewModal({ open, onClose, title, points, onRegister, onOpenTransform }: Props) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[3500] bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center justify-between">
          <div>
            <div className="font-medium">{title}</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {points.length} 点 を 取り込み。 「登録」 で そのまま、 「座標変換」 で 変換 を 挟んで から 登録 します
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-slate-100 text-slate-500"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-auto">
          {points.length === 0 ? (
            <div className="p-6 text-sm text-slate-500">
              取り込める 座標 が ありません でした。
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-slate-100 sticky top-0 z-10">
                <tr>
                  <th className="px-2 py-1 text-left w-32">点番号</th>
                  <th className="px-2 py-1 text-right w-28">X (m)</th>
                  <th className="px-2 py-1 text-right w-28">Y (m)</th>
                  <th className="px-2 py-1 text-right w-24">Z (m)</th>
                  <th className="px-2 py-1 text-left w-24">点種</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {points.map((p, i) => (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-2 py-0.5 font-mono">{p.pointNumber}</td>
                    <td className="px-2 py-0.5 text-right font-mono">{p.x.toFixed(3)}</td>
                    <td className="px-2 py-0.5 text-right font-mono">{p.y.toFixed(3)}</td>
                    <td className="px-2 py-0.5 text-right font-mono">
                      {p.z != null && Number.isFinite(p.z) ? p.z.toFixed(3) : ''}
                    </td>
                    <td className="px-2 py-0.5">
                      {(COORDINATE_TYPE_NAMES as Record<string, string>)[p.type as CoordinateType] ?? p.type}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-4 py-3 border-t flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={() => onOpenTransform(points)}
            disabled={points.length === 0}
            className="px-3 py-1.5 text-sm bg-white border border-blue-300 text-blue-700 rounded hover:bg-blue-50 disabled:opacity-50"
            title="登録 前 に 世界測地変換 / 地殻変動補正 を 掛ける"
          >
            座標変換 →
          </button>
          <button
            type="button"
            onClick={() => onRegister(points)}
            disabled={points.length === 0}
            className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            {points.length > 0 ? `登録 (${points.length} 点)` : '登録'}
          </button>
        </div>
      </div>
    </div>
  )
}
