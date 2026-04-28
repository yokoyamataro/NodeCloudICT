import { useEffect, useMemo, useState } from 'react'
import { Layers } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'

// 帯置計画パラメータ
interface StripPlanParams {
  thicknessB: number // 客土厚 (m)
  dumpCapacityV: number // ダンプ1台の積載量 (m³)
  crossWA: number // 帯断面・上底 (m)
  crossWB: number // 帯断面・下底 (m)
  crossH: number // 帯断面・厚さ (m)
}

const DEFAULT_PARAMS: StripPlanParams = {
  thicknessB: 0.10,
  dumpCapacityV: 7.1,
  crossWA: 1.0,
  crossWB: 2.0,
  crossH: 0.30,
}

// 数値入力（フォーカス中はフォーマットしない）
function NumberField({
  label,
  unit,
  value,
  onChange,
  decimals = 2,
  step = 0.01,
}: {
  label: string
  unit: string
  value: number
  onChange: (v: number) => void
  decimals?: number
  step?: number
}) {
  const [local, setLocal] = useState(value.toFixed(decimals))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setLocal(value.toFixed(decimals))
  }, [value, focused, decimals])

  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          step={step}
          value={local}
          onFocus={() => {
            setFocused(true)
            setLocal(String(value))
          }}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={() => {
            setFocused(false)
            const n = parseFloat(local)
            if (!isNaN(n) && n >= 0) onChange(n)
            else setLocal(value.toFixed(decimals))
          }}
          className="w-full px-2 py-1.5 border rounded text-right"
        />
        <span className="text-xs text-slate-500 whitespace-nowrap">{unit}</span>
      </div>
    </label>
  )
}

// 計算結果カード
function ResultCard({ label, value, unit, hint }: { label: string; value: string; unit: string; hint?: string }) {
  return (
    <div className="bg-white border rounded-lg p-4 shadow-sm">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-bold text-slate-800">{value}</span>
        <span className="text-sm text-slate-500">{unit}</span>
      </div>
      {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
    </div>
  )
}

export function SoilImportStripPlanPage() {
  const { currentFarm } = useFarmStore()
  const { fetchWorkAreas, getWorkAreasByType } = useWorkAreaStore()
  const farmId = currentFarm?.id

  useEffect(() => {
    if (farmId) fetchWorkAreas(farmId)
  }, [farmId, fetchWorkAreas])

  const areas = getWorkAreasByType('soil_import')
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  const [params, setParams] = useState<StripPlanParams>(DEFAULT_PARAMS)

  // 工事区域が読み込まれたら最初の区域を自動選択
  useEffect(() => {
    if (!selectedAreaId && areas.length > 0) {
      setSelectedAreaId(areas[0].id)
    }
  }, [areas, selectedAreaId])

  const selectedArea = areas.find((a) => a.id === selectedAreaId) ?? null

  // 計算
  const calc = useMemo(() => {
    const areaHa = selectedArea?.areaHa ?? 0
    const areaSqm = selectedArea?.areaSqm ?? areaHa * 10000
    const A_ha = areaHa
    const V = areaSqm * params.thicknessB // m³
    const v = params.dumpCapacityV
    const n = v > 0 ? Math.ceil(V / v) : 0
    const CA = ((params.crossWA + params.crossWB) * params.crossH) / 2 // m²
    const L = CA > 0 ? V / CA : 0
    const lengthPerTruck = CA > 0 ? v / CA : 0 // 1台分の延長 (m)
    return { A_ha, areaSqm, V, v, n, CA, L, lengthPerTruck }
  }, [selectedArea, params])

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="帯置計画作成" subtitle="客土工事 / 帯置計画" />
        <div className="flex-1 flex items-center justify-center text-slate-500">
          圃場を選択してください
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="帯置計画作成" subtitle="客土工事 / 帯置計画" />

      <div className="flex-1 overflow-auto p-6 bg-slate-50">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* 工事区域選択 */}
          <section className="bg-white rounded-lg border p-4">
            <div className="flex items-center gap-2 mb-3">
              <Layers className="h-4 w-4 text-slate-600" />
              <h2 className="font-semibold text-slate-800">対象の工事区域</h2>
            </div>
            {areas.length === 0 ? (
              <div className="text-sm text-slate-500">
                客土工事の工事区域がありません。先に「工事区域」で区域を作成してください。
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-700">区域</span>
                  <select
                    value={selectedAreaId ?? ''}
                    onChange={(e) => setSelectedAreaId(e.target.value || null)}
                    className="px-2 py-1.5 border rounded"
                  >
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.zoneNumber} {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex flex-col gap-1 text-sm">
                  <span className="text-slate-700">区域面積 A</span>
                  <div className="px-2 py-1.5 border rounded bg-slate-50 text-right">
                    {selectedArea?.areaHa != null
                      ? `${selectedArea.areaHa.toFixed(2)} ha（${(selectedArea.areaSqm ?? 0).toFixed(0)} m²）`
                      : '未計算'}
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* 入力パラメータ */}
          <section className="bg-white rounded-lg border p-4">
            <h2 className="font-semibold text-slate-800 mb-3">入力パラメータ</h2>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <NumberField
                label="客土厚 B"
                unit="m"
                value={params.thicknessB}
                onChange={(v) => setParams((p) => ({ ...p, thicknessB: v }))}
                decimals={2}
                step={0.01}
              />
              <NumberField
                label="ダンプ1台積載量 v"
                unit="m³"
                value={params.dumpCapacityV}
                onChange={(v) => setParams((p) => ({ ...p, dumpCapacityV: v }))}
                decimals={2}
                step={0.1}
              />
              <div />
              <NumberField
                label="帯断面 上底 WA"
                unit="m"
                value={params.crossWA}
                onChange={(v) => setParams((p) => ({ ...p, crossWA: v }))}
                decimals={2}
                step={0.1}
              />
              <NumberField
                label="帯断面 下底 WB"
                unit="m"
                value={params.crossWB}
                onChange={(v) => setParams((p) => ({ ...p, crossWB: v }))}
                decimals={2}
                step={0.1}
              />
              <NumberField
                label="帯断面 厚さ H"
                unit="m"
                value={params.crossH}
                onChange={(v) => setParams((p) => ({ ...p, crossH: v }))}
                decimals={2}
                step={0.05}
              />
            </div>
          </section>

          {/* 計算結果 */}
          <section className="space-y-3">
            <h2 className="font-semibold text-slate-800">計算結果</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <ResultCard
                label="客土量 V = A×B"
                value={calc.V.toFixed(1)}
                unit="m³"
                hint={`= ${calc.areaSqm.toFixed(0)} m² × ${params.thicknessB} m`}
              />
              <ResultCard
                label="総搬入台数 n = ⌈V/v⌉"
                value={calc.n.toString()}
                unit="台"
                hint={`V / v = ${calc.v > 0 ? (calc.V / calc.v).toFixed(2) : '-'}`}
              />
              <ResultCard
                label="帯断面積 CA"
                value={calc.CA.toFixed(3)}
                unit="m²"
                hint={`(${params.crossWA}+${params.crossWB})×${params.crossH}/2`}
              />
              <ResultCard
                label="必要総延長 L = V/CA"
                value={calc.L.toFixed(1)}
                unit="m"
                hint={`1台当たり延長 v/CA = ${calc.lengthPerTruck.toFixed(2)} m`}
              />
            </div>
          </section>

          {/* 次フェーズの案内 */}
          <section className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-slate-700">
            <div className="font-medium mb-1">次のステップ（実装予定）</div>
            <ul className="list-disc list-inside space-y-0.5 text-slate-600">
              <li>地図上で基線2点を指定 → 区域内に帯線を配置（格子状 / 枝状）</li>
              <li>帯線長を v/CA の整数倍に丸める</li>
              <li>計画の保存・CAD/SIMA 出力</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  )
}
