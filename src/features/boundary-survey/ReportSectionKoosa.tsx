// 09 甲差検証欄
//   * 02 の地番ごとに 登記面積 と 実測面積 を比較
//   * 公差は 08 の精度区分 と 実測面積 から自動計算
//   * 判定: |差| ≤ 公差 なら 「適」、そうでなければ 「不適」
//   * 表示のみ (編集不要)。02 と 08 の入力で自動更新される

import type { LandReportBody } from '@/stores/landReportStore'
import {
  evaluateKoosa,
  ACCURACY_LABEL,
  type AccuracyClass,
} from '@/lib/landReportKoosa'

interface Props {
  body: LandReportBody
  onChange: (patch: Partial<LandReportBody>) => void
}

export function ReportSectionKoosa({ body }: Props) {
  const accuracy = body.regionAccuracy.accuracy as AccuracyClass | null

  if (body.parcels.length === 0) {
    return (
      <div className="p-3 text-xs text-slate-400">
        02 で 地番を登録すると、甲差検証が表示されます。
      </div>
    )
  }

  return (
    <div className="p-3">
      {!accuracy && (
        <div className="mb-2 px-2 py-1 text-xs bg-amber-50 text-amber-800 border border-amber-200 rounded">
          08 で 精度区分を選択すると、公差と判定が自動計算されます。
        </div>
      )}
      {accuracy && (
        <div className="mb-2 text-xs text-slate-600">
          精度区分: <strong>{ACCURACY_LABEL[accuracy]}</strong>
          <span className="text-slate-400">(実測面積 F に対して 公差 = (a + b·F^¼)·F^½)</span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="bg-slate-100">
            <tr>
              <th className="px-2 py-1 border w-8">#</th>
              <th className="px-2 py-1 border text-left">所在・地番</th>
              <th className="px-2 py-1 border text-right w-24">登記面積 (㎡)</th>
              <th className="px-2 py-1 border text-right w-24">実測面積 (㎡)</th>
              <th className="px-2 py-1 border text-right w-20">差 (㎡)</th>
              <th className="px-2 py-1 border text-right w-24">公差 (㎡)</th>
              <th className="px-2 py-1 border text-center w-16">判定</th>
            </tr>
          </thead>
          <tbody>
            {body.parcels.map((p, i) => {
              const { diff, tolerance, verdict } = evaluateKoosa(
                accuracy,
                p.registeredAreaSqm,
                p.areaSqm,
              )
              const verdictLabel = verdict === 'ok' ? '適' : verdict === 'ng' ? '不適' : '—'
              const verdictClass =
                verdict === 'ok'
                  ? 'text-emerald-700 bg-emerald-50'
                  : verdict === 'ng'
                  ? 'text-red-700 bg-red-50'
                  : 'text-slate-400'
              return (
                <tr key={i}>
                  <td className="px-2 py-1 border text-center">{i + 1}</td>
                  <td className="px-2 py-1 border">
                    {p.location} {p.parcelNumber}
                  </td>
                  <td className="px-2 py-1 border text-right">
                    {p.registeredAreaSqm != null ? p.registeredAreaSqm.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-1 border text-right">
                    {p.areaSqm != null ? p.areaSqm.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-1 border text-right">
                    {diff != null ? diff.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-1 border text-right">
                    {tolerance != null ? tolerance.toFixed(2) : '—'}
                  </td>
                  <td className={`px-2 py-1 border text-center font-semibold ${verdictClass}`}>
                    {verdictLabel}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
