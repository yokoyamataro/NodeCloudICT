import { useEffect, useMemo, useState } from 'react'
import { Loader2, Trash2, Download, FileSearch, RefreshCw } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useStakingStore, type SurveyCategory } from '@/stores/stakingStore'

// 起工測量・出来形測量の実測記録を一覧表示し、SIMA/CSV で出力するページ。
// /underdrain/field-data に紐付け（旧プレースホルダ「現場データ」を置き換え）。

const CATEGORY_LABEL: Record<SurveyCategory | 'all', string> = {
  all: '全て',
  initial: '起工測量',
  asbuilt: '出来形測量',
}

export function StakingRecordsPage() {
  const { currentFarm } = useFarmStore()
  const { records, loading, error, fetchRecords, deleteRecord } = useStakingStore()
  const [filter, setFilter] = useState<'all' | SurveyCategory>('all')

  useEffect(() => {
    if (currentFarm) {
      fetchRecords(currentFarm.id)
    }
  }, [currentFarm, fetchRecords])

  const filtered = useMemo(() => {
    if (filter === 'all') return records
    return records.filter((r) => r.surveyCategory === filter)
  }, [records, filter])

  // 平均誤差・件数の簡易サマリ
  const summary = useMemo(() => {
    let stakeCount = 0
    let freeCount = 0
    let sumDx2 = 0
    let pairs = 0
    for (const r of filtered) {
      if (r.targetType === 'free') freeCount++
      else stakeCount++
      if (r.targetX != null && r.targetY != null) {
        const dx = r.measuredX - r.targetX
        const dy = r.measuredY - r.targetY
        sumDx2 += dx * dx + dy * dy
        pairs++
      }
    }
    const rms = pairs > 0 ? Math.sqrt(sumDx2 / pairs) : null
    return { total: filtered.length, stake: stakeCount, free: freeCount, rms }
  }, [filtered])

  const handleDelete = async (id: string, name: string | null) => {
    if (!confirm(`記録「${name ?? '(無題)'}」を削除しますか？`)) return
    await deleteRecord(id)
  }

  // CSV 出力（実測値ベース）
  const handleExportCSV = () => {
    if (filtered.length === 0) return
    const header =
      '点名,測量種別,X(実測),Y(実測),Z(実測),X(計画),Y(計画),Z(計画),精度(m),サンプル数,記録日時\n'
    const rows = filtered
      .map((r) =>
        [
          r.targetName ?? '',
          CATEGORY_LABEL[r.surveyCategory],
          r.measuredX.toFixed(3),
          r.measuredY.toFixed(3),
          r.measuredZ != null ? r.measuredZ.toFixed(3) : '',
          r.targetX != null ? r.targetX.toFixed(3) : '',
          r.targetY != null ? r.targetY.toFixed(3) : '',
          r.targetZ != null ? r.targetZ.toFixed(3) : '',
          r.accuracy != null ? r.accuracy.toFixed(3) : '',
          r.sampleCount ?? '',
          r.recordedAt,
        ].join(','),
      )
      .join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const farmName = currentFarm?.name ?? 'farm'
    a.href = url
    a.download = `${farmName}_staking_records.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  // SIMA 出力（実測値ベース）
  // フォーマットは PipeCoordinateCalcPage の handleExportSIMA に準拠。
  const handleExportSIMA = () => {
    if (filtered.length === 0) return
    const projectName = currentFarm?.name || 'NoName'
    const lines: string[] = []
    lines.push(`G00,04,${projectName},`)
    lines.push('Z00, /* 起工測量実測座標 */,')
    lines.push('Z01,2,')
    lines.push('A00,')
    filtered.forEach((r, index) => {
      const name = r.targetName ?? `pt-${index + 1}`
      const paddedName = name.padEnd(20, ' ')
      const xStr = r.measuredX.toFixed(3).padStart(10, ' ')
      const yStr = r.measuredY.toFixed(3).padStart(10, ' ')
      const zStr =
        r.measuredZ != null ? r.measuredZ.toFixed(3).padStart(10, ' ') : ''
      const numStr = (index + 1).toString().padStart(5, ' ')
      lines.push(`A01,${numStr},${paddedName},${xStr},${yStr},${zStr},`)
    })
    lines.push('A99,')
    const content = lines.join('\r\n')
    const blob = new Blob([content], { type: 'text/plain;charset=shift_jis' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName}_staking.sim`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        圃場を選択してください
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="px-4 py-3 border-b bg-white flex items-center gap-2 flex-wrap">
        <FileSearch className="h-4 w-4 text-slate-500" />
        <span className="font-medium">起工測量 実測記録</span>
        <span className="text-xs text-slate-500">{currentFarm.name}</span>

        <div className="ml-4 flex items-center gap-1 text-xs">
          {(['all', 'initial', 'asbuilt'] as const).map((c) => (
            <button
              key={c}
              onClick={() => setFilter(c)}
              className={`px-2 py-1 rounded border ${
                filter === c
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'hover:bg-slate-50'
              }`}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => fetchRecords(currentFarm.id)}
            className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-50"
            title="再読み込み"
          >
            <RefreshCw className="h-3 w-3" />
            再読込
          </button>
          <button
            onClick={handleExportCSV}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            CSV
          </button>
          <button
            onClick={handleExportSIMA}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 px-3 py-1 text-xs bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
          >
            <Download className="h-3 w-3" />
            SIMA
          </button>
        </div>
      </div>

      {/* サマリ */}
      <div className="px-4 py-2 border-b bg-slate-50 flex items-center gap-4 text-xs text-slate-600">
        <span>合計 <span className="font-semibold">{summary.total}</span> 件</span>
        <span>測設 <span className="font-semibold">{summary.stake}</span> / フリー <span className="font-semibold">{summary.free}</span></span>
        {summary.rms != null && (
          <span>
            計画値からの RMS: <span className="font-mono font-semibold">{summary.rms.toFixed(3)}</span> m
          </span>
        )}
        {error && <span className="text-red-600">{error}</span>}
      </div>

      {/* テーブル */}
      <div className="flex-1 overflow-auto bg-white">
        {loading ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            記録がありません
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-slate-700">
                <th className="px-2 py-2 border-b border-r text-left">点名</th>
                <th className="px-2 py-2 border-b border-r text-left">種別</th>
                <th className="px-2 py-2 border-b border-r text-right">X 実測</th>
                <th className="px-2 py-2 border-b border-r text-right">Y 実測</th>
                <th className="px-2 py-2 border-b border-r text-right">Z 実測</th>
                <th className="px-2 py-2 border-b border-r text-right">ΔX</th>
                <th className="px-2 py-2 border-b border-r text-right">ΔY</th>
                <th className="px-2 py-2 border-b border-r text-right">水平誤差</th>
                <th className="px-2 py-2 border-b border-r text-right">精度(m)</th>
                <th className="px-2 py-2 border-b border-r text-right">N</th>
                <th className="px-2 py-2 border-b border-r text-left">記録日時</th>
                <th className="px-2 py-2 border-b text-center w-10"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const dx = r.targetX != null ? r.measuredX - r.targetX : null
                const dy = r.targetY != null ? r.measuredY - r.targetY : null
                const horiz = dx != null && dy != null ? Math.hypot(dx, dy) : null
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-2 py-1.5 border-b border-r font-medium">
                      {r.targetName ?? '(無題)'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          r.targetType === 'free'
                            ? 'bg-amber-100 text-amber-800'
                            : r.targetType === 'pipe_vertex'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {r.targetType === 'free'
                          ? 'フリー'
                          : r.targetType === 'pipe_vertex'
                          ? '頂点'
                          : '座標'}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-500">
                        {CATEGORY_LABEL[r.surveyCategory]}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">{r.measuredX.toFixed(3)}</td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">{r.measuredY.toFixed(3)}</td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {r.measuredZ != null ? r.measuredZ.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {dx != null ? dx.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {dy != null ? dy.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {horiz != null ? horiz.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {r.accuracy != null ? r.accuracy.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {r.sampleCount ?? '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r text-slate-600">
                      {new Date(r.recordedAt).toLocaleString('ja-JP', {
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-2 py-1.5 border-b text-center">
                      <button
                        onClick={() => handleDelete(r.id, r.targetName)}
                        className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                        title="削除"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
