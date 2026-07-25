// 工区 (farm) の設定画面。現状はデータ容量表示のみ。
// 将来: 工区名の変更、削除、メンバー招待などをここに集約する想定。

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, HardDrive, Layers, Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { useFarmStore } from '@/stores/farmStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useWorkAreaStore } from '@/stores/workAreaStore'
import { supabase } from '@/lib/supabase'
import { MAX_COORDS_PER_FARM, MAX_PARCELS_PER_FARM } from '@/lib/farmLimits'

interface StorageUsage {
  photos_bytes: number
  photos_count: number
  registry_pdf_bytes: number
  registry_pdf_count: number
  other_attachment_bytes: number
  other_attachment_count: number
  landxml_bytes: number
  landxml_count: number
  total_bytes: number
  total_count: number
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function FarmSettingsPage() {
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const [usage, setUsage] = useState<StorageUsage | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 工区あたり件数使用量 (座標 / 地番)
  const coordCount = useCoordinateStore((s) => s.coordinates.length)
  const parcelCount = useWorkAreaStore(
    (s) => s.workAreas['boundary_survey']?.length ?? 0,
  )

  const load = useCallback(async () => {
    if (!currentFarm) return
    setLoading(true)
    setError(null)
    try {
      const { data, error: rpcErr } = (await supabase.rpc(
        'get_farm_storage_usage' as never,
        { p_farm_id: currentFarm.id } as never,
      )) as unknown as {
        data: StorageUsage[] | StorageUsage | null
        error: { message: string } | null
      }
      if (rpcErr) throw rpcErr
      const row = Array.isArray(data) ? data[0] : data
      setUsage(row ?? null)
    } catch (err) {
      setError(
        typeof err === 'object' && err && 'message' in err && typeof (err as { message: unknown }).message === 'string'
          ? (err as { message: string }).message
          : String(err),
      )
    } finally {
      setLoading(false)
    }
  }, [currentFarm])

  useEffect(() => {
    void load()
  }, [load])

  if (!currentFarm) {
    return (
      <div className="h-full flex flex-col">
        <PageHeader title="設定" subtitle="工区を選択してください" />
      </div>
    )
  }

  const rows: Array<{ label: string; count: number; bytes: number }> = usage
    ? [
        { label: '写真', count: usage.photos_count, bytes: usage.photos_bytes },
        { label: '登記情報 PDF', count: usage.registry_pdf_count, bytes: usage.registry_pdf_bytes },
        { label: 'LandXML', count: usage.landxml_count, bytes: usage.landxml_bytes },
      ]
    : []

  const coordPercent = (coordCount / MAX_COORDS_PER_FARM) * 100
  const parcelPercent = (parcelCount / MAX_PARCELS_PER_FARM) * 100
  const coordCls =
    coordCount >= MAX_COORDS_PER_FARM
      ? 'text-red-600'
      : coordCount >= MAX_COORDS_PER_FARM * 0.9
      ? 'text-amber-600'
      : 'text-slate-800'
  const parcelCls =
    parcelCount >= MAX_PARCELS_PER_FARM
      ? 'text-red-600'
      : parcelCount >= MAX_PARCELS_PER_FARM * 0.9
      ? 'text-amber-600'
      : 'text-slate-800'
  const coordBarCls =
    coordCount >= MAX_COORDS_PER_FARM
      ? 'bg-red-500'
      : coordCount >= MAX_COORDS_PER_FARM * 0.9
      ? 'bg-amber-500'
      : 'bg-blue-500'
  const parcelBarCls =
    parcelCount >= MAX_PARCELS_PER_FARM
      ? 'bg-red-500'
      : parcelCount >= MAX_PARCELS_PER_FARM * 0.9
      ? 'bg-amber-500'
      : 'bg-blue-500'

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="設定" subtitle={`工区: ${currentFarm.name}`} />
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 座標数 / 地番数 の工区使用量 (旧: 地番管理ページ ヘッダ に表示) */}
        <section className="bg-white border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-5 w-5 text-blue-600" />
            <h2 className="text-base font-semibold">工区使用量</h2>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b">
                <th className="text-left font-medium py-1.5">項目</th>
                <th className="text-right font-medium py-1.5">現在</th>
                <th className="text-right font-medium py-1.5">上限</th>
                <th className="w-40 font-medium py-1.5 pl-3">%</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              <tr>
                <td className="py-2 text-slate-700">座標</td>
                <td className={`py-2 text-right font-mono font-semibold ${coordCls}`}>
                  {coordCount.toLocaleString()}
                </td>
                <td className="py-2 text-right text-slate-500 font-mono">
                  {MAX_COORDS_PER_FARM.toLocaleString()}
                </td>
                <td className="py-2 pl-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
                      <div
                        className={`h-full ${coordBarCls} transition-[width] duration-150`}
                        style={{ width: `${Math.min(100, coordPercent)}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-slate-500 font-mono w-10 text-right">
                      {coordPercent.toFixed(0)}%
                    </span>
                  </div>
                </td>
              </tr>
              <tr>
                <td className="py-2 text-slate-700">地番</td>
                <td className={`py-2 text-right font-mono font-semibold ${parcelCls}`}>
                  {parcelCount.toLocaleString()}
                </td>
                <td className="py-2 text-right text-slate-500 font-mono">
                  {MAX_PARCELS_PER_FARM.toLocaleString()}
                </td>
                <td className="py-2 pl-3">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-2 bg-slate-200 rounded overflow-hidden">
                      <div
                        className={`h-full ${parcelBarCls} transition-[width] duration-150`}
                        style={{ width: `${Math.min(100, parcelPercent)}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-slate-500 font-mono w-10 text-right">
                      {parcelPercent.toFixed(0)}%
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
            ※ 上限に達すると地番SIM / JPGIS.XML 取込がブロックされます。
            9 割を超えたら黄色、上限到達で赤色になります。
          </p>
        </section>

        <section className="bg-white border rounded-lg p-4">
          <div className="flex items-center gap-2 mb-3">
            <HardDrive className="h-5 w-5 text-blue-600" />
            <h2 className="text-base font-semibold">データ容量</h2>
            <button
              onClick={() => void load()}
              disabled={loading}
              className="ml-auto flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50 disabled:opacity-50"
              title="再集計"
            >
              {loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              再集計
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-3">
              <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
              <span className="break-all">{error}</span>
            </div>
          )}

          {loading && !usage ? (
            <div className="flex items-center gap-2 py-6 justify-center text-slate-500 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              集計中…
            </div>
          ) : usage ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-slate-500 border-b">
                    <th className="text-left font-medium py-1.5">種別</th>
                    <th className="text-right font-medium py-1.5">件数</th>
                    <th className="text-right font-medium py-1.5">容量</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <td className="py-1.5 text-slate-700">{r.label}</td>
                      <td className="py-1.5 text-right text-slate-600 font-mono">
                        {r.count.toLocaleString()}
                      </td>
                      <td className="py-1.5 text-right font-mono">
                        {formatBytes(r.bytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-slate-50">
                    <td className="py-2 font-semibold text-slate-800">合計</td>
                    <td className="py-2 text-right font-mono font-semibold">
                      {usage.total_count.toLocaleString()}
                    </td>
                    <td className="py-2 text-right font-mono font-semibold text-blue-700">
                      {formatBytes(usage.total_bytes)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="mt-3 text-[11px] text-slate-500 leading-relaxed">
                ※ オルソタイル (登録済オルソ画像) はここには含まれません。オルソ画像の登録数は
                「全体図 → 登録済一覧」から確認できます。
              </p>
            </>
          ) : null}
        </section>
      </div>
    </div>
  )
}
