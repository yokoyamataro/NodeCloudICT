import { Download, X } from 'lucide-react'
import type { AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'
import { exportAreaCalculationToCSV } from '@/lib/area-calculation'

interface AreaCalculationSheetProps {
  sheet: AreaCalculationSheetType
  onClose: () => void
}

export function AreaCalculationSheet({ sheet, onClose }: AreaCalculationSheetProps) {
  const handleExportCSV = () => {
    const csv = exportAreaCalculationToCSV(sheet)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `面積計算簿_${sheet.zone_number}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col">
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">面積計算簿</h2>
            <p className="text-sm text-muted-foreground">
              直角座標法による面積計算
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              CSV出力
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-lg"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 区域情報 */}
        <div className="p-4 bg-slate-50 border-b">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">区域番号:</span>{' '}
              <span className="font-medium">{sheet.zone_number}</span>
            </div>
            <div>
              <span className="text-muted-foreground">区域名:</span>{' '}
              <span className="font-medium">{sheet.zone_name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">計算日時:</span>{' '}
              <span className="font-medium">
                {new Date(sheet.calculated_at).toLocaleString('ja-JP')}
              </span>
            </div>
          </div>
        </div>

        {/* 計算表 */}
        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left font-medium border">No.</th>
                <th className="px-3 py-2 text-left font-medium border">点番号</th>
                <th className="px-3 py-2 text-right font-medium border">X座標 (m)</th>
                <th className="px-3 py-2 text-right font-medium border">Y座標 (m)</th>
                <th className="px-3 py-2 text-right font-medium border">Xi × Yi+1</th>
                <th className="px-3 py-2 text-right font-medium border">Xi+1 × Yi</th>
                <th className="px-3 py-2 text-right font-medium border">倍面積</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, index) => (
                <tr key={index} className="hover:bg-slate-50">
                  <td className="px-3 py-2 border text-muted-foreground">
                    {index + 1}
                  </td>
                  <td className="px-3 py-2 border font-medium">
                    {row.point_number}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.x.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.y.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.xi_yi1.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.xi1_yi.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.double_area.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-100 font-medium">
              <tr>
                <td colSpan={6} className="px-3 py-2 border text-right">
                  倍面積合計
                </td>
                <td className="px-3 py-2 border text-right font-mono">
                  {sheet.total_double_area.toFixed(3)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 結果サマリー */}
        <div className="p-4 bg-green-50 border-t">
          <h3 className="text-sm font-medium mb-3">計算結果</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                面積 (m²)
              </div>
              <div className="text-lg font-bold font-mono">
                {sheet.area_sqm.toFixed(3)}
              </div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                面積 (ha)
              </div>
              <div className="text-lg font-bold font-mono">
                {sheet.area_ha.toFixed(6)}
              </div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                面積 (a)
              </div>
              <div className="text-lg font-bold font-mono">
                {(sheet.area_sqm / 100).toFixed(4)}
              </div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                周長 (m)
              </div>
              <div className="text-lg font-bold font-mono">
                {sheet.perimeter_m.toFixed(3)}
              </div>
            </div>
          </div>

          {/* 計算式の説明 */}
          <div className="mt-4 p-3 bg-white rounded-lg border text-sm">
            <h4 className="font-medium mb-2">直角座標法（座標法）</h4>
            <div className="text-muted-foreground space-y-1">
              <p>
                <span className="font-mono">2S = Σ(Xi × Yi+1 - Xi+1 × Yi)</span>
              </p>
              <p>
                <span className="font-mono">S = |2S| / 2 = |{sheet.total_double_area.toFixed(3)}| / 2 = {sheet.area_sqm.toFixed(3)} m²</span>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
