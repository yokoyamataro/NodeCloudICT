import { useEffect, useMemo, useState } from 'react'
import { Loader2, Trash2, Download, FileSearch, RefreshCw } from 'lucide-react'
import { useFarmStore } from '@/stores/farmStore'
import { useStakingStore, type SurveyCategory } from '@/stores/stakingStore'
import { supabase } from '@/lib/supabase'

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

  // Z 補正値 (実測値に加算)。工区ごとに DB (design_survey_calibration.dz_offset)
  // に永続化することで PC/スマホ間で共有可能に。localStorage は旧値のフォール
  // バックとしてだけ参照 (初回だけ DB に移行)。
  const zOffsetKey = currentFarm ? `staking:zOffset:${currentFarm.id}` : null
  const [zOffset, setZOffset] = useState<number>(0)
  const [zOffsetInput, setZOffsetInput] = useState<string>('0')
  useEffect(() => {
    if (!currentFarm) {
      setZOffset(0)
      setZOffsetInput('0')
      return
    }
    let cancelled = false
    void (async () => {
      // まず DB から取得
      let dbValue: number | null = null
      try {
        const { data } = await supabase
          .from('design_survey_calibration')
          .select('dz_offset')
          .eq('farm_id', currentFarm.id)
          .maybeSingle()
        const row = data as { dz_offset: number | string } | null
        if (row?.dz_offset != null) {
          const v = Number(row.dz_offset)
          if (Number.isFinite(v)) dbValue = v
        }
      } catch { /* noop: 未マイグレーション環境等 */ }
      if (cancelled) return
      if (dbValue != null) {
        setZOffset(dbValue)
        setZOffsetInput(String(dbValue))
        // ついでに localStorage も更新して他画面 (施工計画) と揃える
        if (zOffsetKey) {
          try { localStorage.setItem(zOffsetKey, String(dbValue)) } catch { /* ignore */ }
        }
        return
      }
      // DB に無い場合 → localStorage フォールバック
      let lsValue = 0
      try {
        const raw = zOffsetKey ? localStorage.getItem(zOffsetKey) : null
        const v = raw != null ? parseFloat(raw) : 0
        lsValue = Number.isFinite(v) ? v : 0
      } catch { lsValue = 0 }
      setZOffset(lsValue)
      setZOffsetInput(String(lsValue))
      // localStorage に値があれば DB にも書いておく (端末→共有への一回きり移行)
      if (lsValue !== 0) {
        try {
          await supabase
            .from('design_survey_calibration')
            .upsert(
              {
                farm_id: currentFarm.id,
                is_enabled: true,
                dz_offset: lsValue,
              } as never,
              { onConflict: 'farm_id' },
            )
        } catch { /* ignore */ }
      }
    })()
    return () => { cancelled = true }
  }, [currentFarm, zOffsetKey])
  const commitZOffset = async (s: string) => {
    const n = parseFloat(s)
    const next = Number.isFinite(n) ? n : 0
    setZOffset(next)
    setZOffsetInput(String(next))
    // localStorage (施工計画がフォールバック参照する) と DB 両方に反映
    if (zOffsetKey) {
      try { localStorage.setItem(zOffsetKey, String(next)) } catch { /* ignore */ }
    }
    if (currentFarm) {
      try {
        const { error } = await supabase
          .from('design_survey_calibration')
          .upsert(
            {
              farm_id: currentFarm.id,
              is_enabled: true,
              dz_offset: next,
            } as never,
            { onConflict: 'farm_id' },
          )
        if (error) {
          console.warn('[staking] Z補正の保存に失敗', error)
        }
      } catch (err) {
        console.warn('[staking] Z補正の保存に失敗', err)
      }
    }
  }

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
      '点名,測量種別,X(実測),Y(実測),Z(実測),Z(補正),X(計画),Y(計画),Z(計画),精度(m),サンプル数,記録日時\n'
    const rows = filtered
      .map((r) =>
        [
          r.targetName ?? '',
          CATEGORY_LABEL[r.surveyCategory],
          r.measuredX.toFixed(3),
          r.measuredY.toFixed(3),
          r.measuredZ != null ? r.measuredZ.toFixed(3) : '',
          r.measuredZ != null ? (r.measuredZ + zOffset).toFixed(3) : '',
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
        工区を選択してください
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
          {/* Z 補正: 実測値に加算する定数オフセット */}
          <label
            className="flex items-center gap-1 text-xs"
            title="実測値 Z にこの値 (m) を加算した「補正 Z」を表示。GPS 系統差を素早く吸収するための簡易補正"
          >
            <span className="text-slate-500">Z補正</span>
            <input
              type="number"
              step={0.001}
              value={zOffsetInput}
              onChange={(e) => setZOffsetInput(e.target.value)}
              onBlur={(e) => void commitZOffset(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
              }}
              className="w-20 px-1.5 py-0.5 border rounded text-right font-mono"
            />
            <span className="text-slate-500">m</span>
          </label>
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
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>種別</th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-slate-50"
                  colSpan={4}
                >
                  設計
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-slate-50"
                  colSpan={4}
                >
                  実測
                </th>
                <th
                  className="px-2 py-1 border-b border-r text-center bg-amber-50"
                  colSpan={1}
                  title={`実測値に Z=${zOffset.toFixed(3)} m を加算した補正後の Z`}
                >
                  補正
                </th>
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>ΔX</th>
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>ΔY</th>
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>水平誤差</th>
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>精度(m)</th>
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>N</th>
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>記録日時</th>
                <th className="px-2 py-2 border-b text-center w-10" rowSpan={2}></th>
              </tr>
              <tr className="text-slate-700">
                <th className="px-2 py-1 border-b border-r text-left">点名</th>
                <th className="px-2 py-1 border-b border-r text-right">X</th>
                <th className="px-2 py-1 border-b border-r text-right">Y</th>
                <th className="px-2 py-1 border-b border-r text-right">Z</th>
                <th className="px-2 py-1 border-b border-r text-left">点名</th>
                <th className="px-2 py-1 border-b border-r text-right">X</th>
                <th className="px-2 py-1 border-b border-r text-right">Y</th>
                <th className="px-2 py-1 border-b border-r text-right">Z</th>
                <th className="px-2 py-1 border-b border-r text-right bg-amber-50">Z</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const dx = r.targetX != null ? r.measuredX - r.targetX : null
                const dy = r.targetY != null ? r.measuredY - r.targetY : null
                const horiz = dx != null && dy != null ? Math.hypot(dx, dy) : null
                // 実測記録の targetName は「G_A1」「G2_A1」形式 (計測順序 prefix)。
                // 設計側の点名はそれを剥がしたもの、実測側は全体をそのまま表示。
                const measuredName = r.targetName ?? '(無題)'
                const designName = measuredName.replace(/^G2?_/, '')
                return (
                  <tr key={r.id} className="hover:bg-slate-50">
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
                    {/* 設計 (点名 + XYZ) */}
                    <td className="px-2 py-1.5 border-b border-r font-medium text-slate-700">
                      {designName}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {r.targetX != null ? r.targetX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {r.targetY != null ? r.targetY.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {r.targetZ != null ? r.targetZ.toFixed(3) : '—'}
                    </td>
                    {/* 実測 (点名 + XYZ) */}
                    <td className="px-2 py-1.5 border-b border-r font-medium">
                      {measuredName}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">{r.measuredX.toFixed(3)}</td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">{r.measuredY.toFixed(3)}</td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {r.measuredZ != null ? r.measuredZ.toFixed(3) : '—'}
                    </td>
                    {/* 補正 Z (measuredZ + zOffset) */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-amber-50 text-amber-900">
                      {r.measuredZ != null ? (r.measuredZ + zOffset).toFixed(3) : '—'}
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
