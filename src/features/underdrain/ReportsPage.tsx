import { useEffect, useState } from 'react'
import { FileText, Download, Loader2 } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { exportMeasurementResult } from '@/lib/measurementResultExport'

export function ReportsPage() {
  const { currentFarm } = useFarmStore()
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { planGroups, hasData, fetchPlan, loading: planLoading } = useConstructionPlanStore()

  const [farmNumber, setFarmNumber] = useState('')
  const [area, setArea] = useState('')
  const [beneficiary, setBeneficiary] = useState('')
  const [exporting, setExporting] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!currentFarm) return
    fetchPipes(currentFarm.id)
    fetchPlan(currentFarm.id)
  }, [currentFarm, fetchPipes, fetchPlan])

  // デフォルト値を圃場名で
  useEffect(() => {
    if (currentFarm && !farmNumber) {
      setFarmNumber(currentFarm.name)
    }
  }, [currentFarm, farmNumber])

  const canExport = pipes.length > 0 && !exporting && !planLoading

  const handleExport = async () => {
    if (!canExport) return
    setExporting(true)
    setErrorMsg(null)
    try {
      await exportMeasurementResult({
        pipes,
        planGroups,
        header: {
          farmNumber,
          area,
          beneficiary,
        },
        farmName: currentFarm?.name,
      })
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '出力に失敗しました')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b bg-white">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <FileText className="h-5 w-5" />
          帳票作成
        </h1>
        <p className="text-sm text-muted-foreground">
          施工計画および配管データから各種帳票を出力します
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 測定結果一覧表 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3">測定結果一覧表</h2>
          <div className="text-xs text-slate-600 mb-3">
            配管（すべての配線）の 上下端（必要に応じて中間）の現況高と切深を様式に転記します。
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm mb-3">
            <LabeledInput
              label="圃場番号"
              value={farmNumber}
              onChange={setFarmNumber}
            />
            <LabeledInput
              label="面積"
              value={area}
              onChange={setArea}
              placeholder="例: 1.23 ha"
            />
            <LabeledInput
              label="受益者名"
              value={beneficiary}
              onChange={setBeneficiary}
            />
          </div>

          <div className="text-xs text-slate-600 mb-2 flex items-center gap-2">
            {planLoading ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                施工計画を読み込み中...
              </>
            ) : pipes.length === 0 ? (
              <span className="text-red-600">
                配管データがありません。CAD解析ページで登録してください。
              </span>
            ) : (
              <span>
                配管 {pipes.length} 本
                {!hasData && '（施工計画未生成: 地盤高・切深は空欄）'}
              </span>
            )}
          </div>

          {errorMsg && (
            <div className="mb-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
              {errorMsg}
            </div>
          )}

          <button
            type="button"
            onClick={handleExport}
            disabled={!canExport}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            測定結果一覧表を出力（Excel）
          </button>
        </section>
      </div>
    </div>
  )
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-slate-600">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="px-2 py-1.5 border rounded text-sm"
      />
    </label>
  )
}
